import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteClient, type SocketLike } from './client.js'
import {
  SecureChannel,
  deriveSessionKeys,
  fromB64,
  generateIdentity,
  toB64,
  type KeyPair,
} from './crypto.js'
import type { Envelope } from './wire.js'

type Listener = (ev: unknown) => void

/** In-memory host end of a socket, speaking the real handshake and encryption. */
class FakeSocket implements SocketLike {
  readyState = 0
  binaryType = 'arraybuffer'
  closed = false
  private listeners = new Map<string, Listener[]>()
  private channel: SecureChannel | null = null
  private hostEph = generateIdentity()

  constructor(
    readonly host: FakeHost,
    readonly url: string,
  ) {
    // A hung socket (e.g. a private IP on cellular) never opens and never reports closing.
    if (host.hang(url)) return
    setTimeout(() => {
      if (this.closed) return
      this.readyState = 1
      this.emit('open', {})
    }, 0)
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  private emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }

  /** Host -> client */
  push(env: Envelope): void {
    if (this.closed || !this.channel) return
    const frame = this.channel.seal(env)
    this.emit('message', { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) })
  }
  private pushText(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.host.hang(this.url)) return
    this.readyState = 3
    setTimeout(() => this.emit('close', { code: 1000, reason: '' }), 0)
  }

  /** Client -> host */
  send(data: string | ArrayBufferView | ArrayBuffer): void {
    if (this.closed) return
    if (typeof data === 'string') {
      const f = JSON.parse(data) as { t: string; ephPk?: string; hdr?: string }
      if (f.t === 'hello') {
        if (this.host.refuse) {
          this.pushText({ t: 'err', code: this.host.refuse, message: `refused: ${this.host.refuse}` })
          return
        }
        const keys = deriveSessionKeys(null, 'host', {
          myEphemeral: this.hostEph,
          theirEphemeralPk: fromB64(null, f.ephPk!),
          myStatic: this.host.hostKey,
          theirStaticPk: this.host.deviceKey.publicKey,
        })
        this.channel = SecureChannel.create(null, keys)
        this.pushText({ t: 'hello_ack', ephPk: toB64(null, this.hostEph.publicKey), hostId: 'h', hostName: 'Mac' })
        this.pushText({ t: 'hdr', hdr: toB64(null, this.channel.startSend()) })
      } else if (f.t === 'hdr') {
        this.channel!.startReceive(fromB64(null, f.hdr!))
      }
      return
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength)
    const env = this.channel!.open<Envelope>(bytes)
    if (env.t === 'auth') {
      this.push({
        t: 'ready',
        device: { id: 'd', name: 'phone', scopes: ['chat'] },
        host: { id: 'h', name: 'Mac', ...(this.host.relayInfo ? { relay: this.host.relayInfo } : {}) },
        allowed: [],
        seq: 0,
        gatewayConnected: true,
      } as unknown as Envelope)
    } else if (env.t === 'ping' && !this.host.mute) {
      this.push({ t: 'pong', ts: env.ts })
    }
  }
}

class FakeHost {
  hostKey = generateIdentity()
  deviceKey = generateIdentity()
  sockets: FakeSocket[] = []
  mute = false
  refuse: string | null = null
  hang: (url: string) => boolean = () => false
  relayInfo: { u: string; i: string } | null = null
  factory = (url: string): SocketLike => {
    const s = new FakeSocket(this, url)
    this.sockets.push(s)
    return s
  }
  get open(): FakeSocket[] {
    return this.sockets.filter((s) => !s.closed)
  }
}

function make(host: FakeHost, extra: Partial<ConstructorParameters<typeof RemoteClient>[0]> = {}): RemoteClient {
  const identity: KeyPair = host.deviceKey
  return new RemoteClient({
    identity,
    deviceId: 'd',
    hostPublicKey: host.hostKey.publicKey,
    addresses: ['10.0.0.1:1'],
    createSocket: host.factory,
    ...extra,
  })
}

const settle = (ms = 50) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('half-open detection', () => {
  it('drops a socket that never answers a ping and reconnects', async () => {
    const host = new FakeHost()
    const c = make(host)
    c.connect()
    await settle()
    expect(c.state).toBe('ready')
    host.mute = true
    await settle(10_000 + 5_000 + 50)
    expect(host.sockets[0]!.closed).toBe(true)
    host.mute = false
    await settle(3000)
    expect(host.sockets.length).toBe(2)
    expect(c.state).toBe('ready')
    c.disconnect()
  })

  it('does not drop a healthy socket', async () => {
    const host = new FakeHost()
    const c = make(host)
    c.connect()
    await settle()
    await settle(90_000)
    expect(host.sockets.length).toBe(1)
    expect(c.state).toBe('ready')
    c.disconnect()
  })

  it('checkAlive reconnects immediately when a resume ping goes unanswered', async () => {
    const host = new FakeHost()
    const c = make(host)
    c.connect()
    await settle()
    host.mute = true
    c.checkAlive(3000)
    await settle(3100)
    expect(host.sockets[0]!.closed).toBe(true)
    host.mute = false
    await settle(50)
    expect(host.sockets.length).toBe(2)
    expect(c.state).toBe('ready')
    c.disconnect()
  })

  it('checkAlive while disconnected skips backoff', async () => {
    const host = new FakeHost()
    const c = make(host)
    c.connect()
    await settle()
    host.sockets[0]!.close()
    await settle(10)
    expect(c.state).toBe('disconnected')
    c.checkAlive()
    await settle(50)
    expect(host.sockets.length).toBe(2)
    expect(c.state).toBe('ready')
    c.disconnect()
  })
})

describe('forceReconnect (network change)', () => {
  it('drops a live socket at once and reconnects without backoff', async () => {
    const host = new FakeHost()
    const c = make(host)
    c.connect()
    await settle()
    expect(c.state).toBe('ready')
    c.forceReconnect()
    expect(host.sockets[0]!.closed).toBe(true)
    await settle(50)
    expect(host.sockets.length).toBe(2)
    expect(c.state).toBe('ready')
    c.disconnect()
  })

  it('cancels a pending backoff and reconnects now', async () => {
    const host = new FakeHost()
    const c = make(host)
    c.connect()
    await settle()
    host.refuse = 'nope'
    host.sockets[0]!.close()
    await settle(10)
    expect(c.state).toBe('disconnected')
    host.refuse = null
    c.forceReconnect()
    await settle(50)
    expect(c.state).toBe('ready')
    c.disconnect()
  })

  it('does not resurrect a revoked client', async () => {
    const host = new FakeHost()
    host.refuse = 'revoked'
    const c = make(host)
    c.connect()
    await settle(100)
    expect(c.state).toBe('revoked')
    const n = host.sockets.length
    c.forceReconnect()
    await settle(100)
    expect(host.sockets.length).toBe(n)
  })

  it('detects a dead socket within the 10s ping + 5s pong window', async () => {
    const host = new FakeHost()
    const c = make(host)
    c.connect()
    await settle()
    host.mute = true
    await settle(10_000 + 5_000 + 100)
    expect(host.sockets[0]!.closed).toBe(true)
    c.disconnect()
  })
})

describe('background / foreground cycle', () => {
  it('disconnect on background closes the socket; connect on resume reconnects without error state', async () => {
    const host = new FakeHost()
    const states: string[] = []
    const c = make(host, { onState: (st) => states.push(st) })
    c.connect()
    await settle()
    expect(c.state).toBe('ready')
    c.disconnect() // app backgrounded
    expect(host.sockets[0]!.closed).toBe(true)
    expect(c.state).toBe('disconnected')
    // checkAlive alone would be a no-op after an intentional stop; resume uses connect()
    c.checkAlive()
    expect(host.sockets.length).toBe(1)
    c.connect() // app active
    await settle(50)
    expect(host.sockets.length).toBe(2)
    expect(c.state).toBe('ready')
    expect(states).not.toContain('revoked')
    c.disconnect()
  })
})

describe('connect races', () => {
  it('connect() during a race or when ready is a no-op and cancels pending backoff', async () => {
    const host = new FakeHost()
    const c = make(host, { addresses: ['a:1', 'b:1'] })
    c.connect()
    c.connect()
    expect(host.sockets.length).toBe(2)
    await settle()
    expect(c.state).toBe('ready')
    c.connect()
    await settle()
    expect(host.sockets.length).toBe(2)
    expect(host.open.length).toBe(1)
    c.disconnect()
  })

  it('disconnect() during a race stops any attempt from winning', async () => {
    const host = new FakeHost()
    const c = make(host, { addresses: ['a:1', 'b:1'] })
    c.connect()
    c.disconnect()
    await settle(200)
    expect(c.state).toBe('disconnected')
    expect(host.open.length).toBe(0)
    c.disconnect()
  })
})

describe('terminal host errors', () => {
  it('revoked stops retrying and surfaces a distinct state', async () => {
    const host = new FakeHost()
    host.refuse = 'revoked'
    const states: string[] = []
    const c = make(host, { onState: (s) => states.push(s) })
    c.connect()
    await settle(60_000)
    expect(c.state).toBe('revoked')
    expect(host.sockets.length).toBe(1)
    expect(host.open.length).toBe(0)
    expect(states.at(-1)).toBe('revoked')
  })

  it('other refusals keep retrying', async () => {
    const host = new FakeHost()
    host.refuse = 'bad_handshake'
    const c = make(host)
    c.connect()
    await settle(30_000)
    expect(host.sockets.length).toBeGreaterThan(1)
    c.disconnect()
  })
})

describe('listeners and scopes', () => {
  it('a throwing onEvent does not close the socket', async () => {
    const host = new FakeHost()
    const seen: string[] = []
    const c = make(host, {
      onEvent: (e) => {
        seen.push(e)
        throw new Error('ui bug')
      },
    })
    c.connect()
    await settle()
    host.sockets[0]!.push({ t: 'event', event: 'a', data: {}, seq: 1 } as Envelope)
    host.sockets[0]!.push({ t: 'event', event: 'b', data: {}, seq: 2 } as Envelope)
    await settle(100)
    expect(seen).toEqual(['a', 'b'])
    expect(host.sockets.length).toBe(1)
    expect(host.sockets[0]!.closed).toBe(false)
    expect(c.state).toBe('ready')
    c.disconnect()
  })

  it('recomputes allowed after remote.scopes_changed', async () => {
    const host = new FakeHost()
    const c = make(host)
    c.connect()
    await settle()
    expect(c.can('git.status')).toBe(false)
    host.sockets[0]!.push({ t: 'event', event: 'remote.scopes_changed', data: { scopes: ['chat', 'git'] }, seq: 1 } as Envelope)
    await settle(10)
    expect(c.can('git.status')).toBe(true)
    c.disconnect()
  })
})

const RELAY = { u: 'wss://relay.test', i: 'AAAAAAAAAAAAAAAAAAAAAA' }

describe('relay on cellular', () => {
  it('LAN attempts that hang forever still let the relay win', async () => {
    const host = new FakeHost()
    host.hang = (url) => url.startsWith('ws://')
    const logs: string[] = []
    const c = make(host, { addresses: ['192.168.1.5:1', 'mac.local:1'], relay: RELAY, log: (m) => logs.push(m) })
    c.connect()
    await settle(1300) // relay head start
    await settle(200)
    expect(c.state).toBe('ready')
    expect(c.transport).toBe('relay')
    expect(logs.some((l) => l.includes('attempt lan 192.168.1.5:1 start'))).toBe(true)
    expect(logs.some((l) => l.includes('race won by relay'))).toBe(true)
    c.disconnect()
  })

  it('starts the relay at once when the network is cellular', async () => {
    const host = new FakeHost()
    host.hang = (url) => url.startsWith('ws://')
    const c = make(host, { addresses: ['192.168.1.5:1'], relay: RELAY })
    c.setNetworkType('cellular')
    c.connect()
    await settle(100)
    expect(c.state).toBe('ready')
    expect(c.transport).toBe('relay')
    c.disconnect()
  })

  it('cold start with only stored relay info and no LAN addresses connects via relay', async () => {
    const host = new FakeHost()
    const c = make(host, { addresses: [], relay: RELAY })
    c.connect()
    await settle(100)
    expect(c.state).toBe('ready')
    expect(c.transport).toBe('relay')
    c.disconnect()
  })

  it('a failed full race logs why and retries with backoff', async () => {
    const host = new FakeHost()
    host.hang = () => true
    const logs: string[] = []
    const c = make(host, { addresses: ['10.0.0.9:1'], relay: RELAY, log: (m) => logs.push(m) })
    c.connect()
    await settle(12_000)
    expect(logs.some((l) => l.includes('race failed') && l.includes('lan 10.0.0.9:1: timed out') && l.includes('relay'))).toBe(true)
    expect(logs.some((l) => l.includes('reconnecting in'))).toBe(true)
    const before = host.sockets.length
    await settle(25_000)
    expect(host.sockets.length).toBeGreaterThan(before)
    c.disconnect()
  })

  it('a relay refreshed from hostSummary is reported for persistence, once', async () => {
    const host = new FakeHost()
    host.relayInfo = RELAY
    const seen: unknown[] = []
    const c = make(host, { onRelay: (r) => seen.push(r) })
    c.connect()
    await settle()
    expect(seen).toEqual([RELAY])
    expect(c.relay).toEqual(RELAY)
    c.disconnect()
    c.connect()
    await settle()
    expect(seen.length).toBe(1)
    c.disconnect()
  })
})
