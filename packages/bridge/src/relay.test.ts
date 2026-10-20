/**
 * The bridge's relay link: RelayClient on its own against an in-process fake relay,
 * then a real Bridge reached by the shipped phone client entirely through that
 * relay. RELAY_LIVE_URL, when set, repeats pairing + connect + RPC against a real
 * deployed relay.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RemoteClient,
  decodePairingPayload,
  generateSigningKey,
  pairWithHost,
  relayIdFromPublicKey,
  type PairResult,
} from '@dorabot-remote/protocol'
import { WebSocket } from 'ws'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeGateway } from '../test/fake-gateway.js'
import { FakeRelay } from '../test/fake-relay.js'
import { Bridge } from './bridge.js'
import { loadSettings, resolvePaths } from './config.js'
import {
  BACKOFF_CAP_MS,
  MAX_PAYLOAD_BYTES,
  RelayClient,
  VirtualSocket,
  type RelayState,
} from './relay-client.js'

const createSocket = (url: string) => new WebSocket(url) as never
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

// ---------------------------------------------------------------------------
// RelayClient alone
// ---------------------------------------------------------------------------

describe('RelayClient handshake', () => {
  let relay: FakeRelay
  const clients: RelayClient[] = []
  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop()
    await relay?.stop()
  })

  function make(opts: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
    const logs: string[] = []
    const client = new RelayClient({
      url: relay.url,
      signingKey: generateSigningKey(),
      log: (m) => logs.push(m),
      onDeviceSocket: () => {},
      random: () => 0,
      selfTest: false,
      ...opts,
    })
    clients.push(client)
    return { client, logs }
  }

  it('authenticates with a good signature', async () => {
    relay = new FakeRelay()
    await relay.start()
    const { client } = make()
    const states: RelayState[] = []
    client.on('state', (s) => states.push(s))
    client.start()
    await until(() => client.state === 'online')
    expect(states).toEqual(['connecting', 'online'])
    expect(relay.authedHost).toBeTruthy()
  })

  it('is refused on a bad signature (4401), logs loudly, retries slowly', async () => {
    relay = new FakeRelay()
    await relay.start()
    relay.expectRelayId = relayIdFromPublicKey(generateSigningKey().publicKey)
    const { client, logs } = make()
    client.start()
    await until(() => logs.some((l) => l.includes('ERROR')))
    expect(client.state).toBe('offline')
    // random()=0 gives the lower half of the cap: slow, not the 1s first-try delay.
    expect(logs.some((l) => l.includes(`reconnecting in ${(BACKOFF_CAP_MS / 2000).toFixed(1)}s`))).toBe(true)
    expect(relay.hostAttempts).toBe(1)
  })

  it('backs off to the cap and warns when replaced by another bridge', async () => {
    relay = new FakeRelay()
    await relay.start()
    const key = generateSigningKey()
    const a = make({ signingKey: key })
    a.client.start()
    await until(() => a.client.state === 'online')
    const b = make({ signingKey: key })
    b.client.start()
    await until(() => b.client.state === 'online')
    await until(() => a.client.state === 'offline')
    expect(a.logs.some((l) => l.includes('WARNING') && l.includes('same signing key'))).toBe(true)
    expect(a.logs.some((l) => l.includes('reconnecting in 15.0s'))).toBe(true)
  })

  it('never puts an oversize frame on the host socket; closes only that virtual socket', async () => {
    relay = new FakeRelay()
    await relay.start()
    const socks: VirtualSocket[] = []
    const { client } = make({ onDeviceSocket: (s) => socks.push(s) })
    client.start()
    await until(() => client.state === 'online')
    const dev = new WebSocket(`${relay.url}/d/${client.relayId}`)
    await until(() => socks.length === 1)
    const dev2 = new WebSocket(`${relay.url}/d/${client.relayId}`)
    await until(() => socks.length === 2)
    const closed = new Promise<number>((r) => dev.on('close', (code) => r(code)))
    expect(() => socks[0]!.send(Buffer.alloc(MAX_PAYLOAD_BYTES + 1))).toThrow(/relay limit/)
    expect(() => socks[1]!.send('x'.repeat(MAX_PAYLOAD_BYTES + 1))).toThrow(/relay limit/)
    expect(await closed).toBe(1009)
    expect(relay.maxHostFrame).toBeLessThanOrEqual(1024 * 1024)
    expect(relay.hostCloseCodes).not.toContain(1009)
    expect(client.state).toBe('online')
    // A frame exactly at the limit is fine.
    const ok = new VirtualSocket(7, { open: true, bufferedAmount: 0, sendFrame: () => {}, release: () => {} })
    expect(() => ok.send(Buffer.alloc(MAX_PAYLOAD_BYTES))).not.toThrow()
    dev.close()
    dev2.close()
  })
})

// ---------------------------------------------------------------------------
// Backoff, under fake timers with a stubbed socket
// ---------------------------------------------------------------------------

class StubWs extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  sent: unknown[] = []
  send(d: unknown) {
    this.sent.push(d)
  }
  ping() {}
  close(code = 1000) {
    this.terminate(code)
  }
  terminate(code = 1006) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', code, Buffer.from(''))
  }
}

describe('relay liveness', () => {
  let relay: FakeRelay
  const clients: RelayClient[] = []
  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop()
    await relay?.stop()
  })

  async function make(opts: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
    relay = new FakeRelay()
    await relay.start()
    const logs: string[] = []
    // Stand-in for Bridge.routeRelaySocket: confirm probes, ignore the rest.
    const client: RelayClient = new RelayClient({
      url: relay.url,
      signingKey: generateSigningKey(),
      log: (m) => logs.push(m),
      onDeviceSocket: (sock) =>
        sock.once('message', (raw: Buffer) => {
          try {
            const f = JSON.parse(raw.toString()) as { t?: string; n?: string }
            if (f.t === 'selftest') client.confirmSelfTest(f.n)
          } catch {
            // Not a probe.
          }
          sock.close(1000, 'selftest')
        }),
      random: () => 0,
      createSocket,
      ...opts,
    })
    clients.push(client)
    return { client, logs }
  }

  it('sends heartbeats and stays up while the room answers them', async () => {
    const { client, logs } = await make({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 80, selfTest: false })
    client.start()
    await until(() => relay.heartbeats >= 4, 5000, 'heartbeats')
    expect(client.state).toBe('online')
    expect(relay.hostAttempts).toBe(1)
    expect(logs.some((l) => l.includes('heartbeat missed'))).toBe(false)
  })

  it('drops and reconnects after 2 missing heartbeat answers, logging one line', async () => {
    const { client, logs } = await make({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 80, selfTest: false })
    relay.answerHeartbeat = false
    client.start()
    await until(() => relay.hostAttempts >= 2, 5000, 'reconnect')
    expect(logs.filter((l) => l.includes('heartbeat missed')).length).toBeGreaterThanOrEqual(1)
    expect(logs.find((l) => l.includes('heartbeat missed'))).toContain('2 times')
    // Recovers once the room answers again.
    relay.answerHeartbeat = true
    await until(() => client.state === 'online', 8000, 'online again')
  })

  it('self-test passes against a healthy room and uses one short-lived probe', async () => {
    const { client, logs } = await make({ selfTestTimeoutMs: 2000, selfTestIntervalMs: 60_000 })
    client.start()
    await until(() => client.selfTestsPassed === 1, 5000, 'self-test')
    expect(relay.devicesAccepted).toBe(1)
    expect(client.connectedDevices).toBe(0)
    expect(logs.some((l) => l.includes('self-test failed'))).toBe(false)
  })

  it('self-test repeats on its interval', async () => {
    const { client } = await make({ selfTestTimeoutMs: 2000, selfTestIntervalMs: 200 })
    client.start()
    await until(() => client.selfTestsPassed >= 3, 6000, 'repeat self-tests')
    expect(relay.hostAttempts).toBe(1)
  })

  it('BLACK HOLE: the room answers heartbeats and pings but delivers nothing; self-test detects it and reconnects', async () => {
    const { client, logs } = await make({ selfTestTimeoutMs: 400, selfTestIntervalMs: 60_000, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 80 })
    relay.blackHole = true
    client.start()
    await until(() => logs.some((l) => l.includes('relay self-test failed')), 5000, 'self-test failure')
    // Heartbeats alone would never have noticed.
    expect(logs.some((l) => l.includes('heartbeat missed'))).toBe(false)
    await until(() => relay.hostAttempts >= 2, 8000, 'forced reconnect')
    expect(client.selfTestsPassed).toBe(0)
    // The room heals; the next link passes its post-connect self-test.
    relay.blackHole = false
    await until(() => client.selfTestsPassed >= 1, 10_000, 'self-test passes after recovery')
    expect(client.state).toBe('online')
  }, 30_000)
})

describe('reconnect backoff', () => {
  afterEach(() => vi.useRealTimers())

  function run(behave: (ws: StubWs) => void) {
    vi.useFakeTimers()
    let attempts = 0
    const times: number[] = []
    const client = new RelayClient({
      url: 'ws://relay.invalid',
      signingKey: generateSigningKey(),
      log: () => {},
      onDeviceSocket: () => {},
      random: () => 1,
      selfTest: false,
      createSocket: () => {
        attempts++
        times.push(Date.now())
        const ws = new StubWs()
        queueMicrotask(() => behave(ws))
        return ws as never
      },
    })
    return { client, attempts: () => attempts, times }
  }

  it('does not hot-loop against a relay that closes immediately', async () => {
    const t = run((ws) => ws.terminate(1006))
    t.client.start()
    await vi.advanceTimersByTimeAsync(120_000)
    t.client.stop()
    // 1,2,4,8,16,30,30,... over 120s: about 9 tries, never hundreds.
    expect(t.attempts()).toBeGreaterThan(5)
    expect(t.attempts()).toBeLessThanOrEqual(10)
    const gaps = t.times.slice(1).map((x, i) => x - t.times[i]!)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1000)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(BACKOFF_CAP_MS)
  })

  it('does not hot-loop against a relay that accepts then immediately drops us', async () => {
    const t2 = run((ws) => {
      ws.emit('message', Buffer.from(JSON.stringify({ t: 'challenge', n: 'abc' })), false)
      ws.emit('message', Buffer.from(JSON.stringify({ t: 'ok' })), false)
      setTimeout(() => ws.terminate(1011), 300)
    })
    t2.client.start()
    await vi.advanceTimersByTimeAsync(120_000)
    t2.client.stop()
    expect(t2.attempts()).toBeLessThanOrEqual(12)
  })

  it('resets the backoff after a link that stayed up', async () => {
    let n = 0
    const t = run((ws) => {
      n++
      if (n === 3) {
        ws.emit('message', Buffer.from(JSON.stringify({ t: 'ok' })), false)
        setTimeout(() => ws.terminate(1006), 20_000)
      } else ws.terminate(1006)
    })
    t.client.start()
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 100) // attempts 1..3
    await vi.advanceTimersByTimeAsync(20_000 + 1200)
    // After a stable link the next retry is back at ~1s, not 4s.
    expect(t.times.length).toBeGreaterThanOrEqual(4)
    expect(t.times[3]! - t.times[2]! - 20_000).toBeLessThanOrEqual(1100)
    t.client.stop()
  })
})

// ---------------------------------------------------------------------------
// Whole bridge through the relay
// ---------------------------------------------------------------------------

interface Rig {
  bridge: Bridge
  gateway: FakeGateway
  home: string
  pair(): Promise<PairResult>
  connect(p: PairResult, extra?: Partial<ConstructorParameters<typeof RemoteClient>[0]>): Promise<RemoteClient>
  stop(): Promise<void>
}

async function startRig(relayUrl: string, port: number): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), 'dorabot-relay-test-'))
  const socket = join(tmpdir(), `dr-fake-gw-relay-${process.pid}-${port}.sock`)
  const paths = resolvePaths({
    root: home,
    db: join(home, 'bridge.db'),
    identity: join(home, 'host-key.json'),
    signingKey: join(home, 'signing-key.json'),
    settings: join(home, 'settings.json'),
    gatewaySocket: socket,
    gatewayToken: join(home, 'gateway-token'),
  })
  writeFileSync(paths.gatewayToken, 'b'.repeat(64))
  const gateway = new FakeGateway()
  await gateway.start(socket, 'b'.repeat(64))
  const settings = loadSettings(paths)
  settings.port = port
  settings.bind = '127.0.0.1'
  settings.relay = { enabled: true, url: relayUrl }
  const bridge = new Bridge({ paths, settings })
  await bridge.start()
  await sleep(300)

  // Force the relay path: no LAN addresses in the payload.
  const pair = () => {
    const payload = decodePairingPayload(bridge.newPairingPayload().uri)
    payload.a = []
    return pairWithHost({ payload, deviceName: 'Relay Phone', platform: 'ios', createSocket }).then((r) => {
      bridge.approveDevice(r.deviceId)
      return r
    })
  }
  const connect: Rig['connect'] = async (p, extra = {}) => {
    const client = new RemoteClient({
      identity: p.identity,
      deviceId: p.deviceId,
      hostPublicKey: p.hostPublicKey,
      addresses: [],
      relay: p.relay,
      createSocket,
      ...extra,
    })
    client.connect()
    await until(() => client.state === 'ready', 15_000, 'phone ready over relay')
    return client
  }
  return {
    bridge,
    gateway,
    home,
    pair,
    connect,
    async stop() {
      await bridge.stop()
      await gateway.stop()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

describe('bridge through the relay', () => {
  let relay: FakeRelay
  let rig: Rig
  const conns = (): Set<{ close(r: string): void }> =>
    (rig.bridge as unknown as { connections: Set<{ close(r: string): void }> }).connections

  beforeAll(async () => {
    relay = new FakeRelay()
    await relay.start()
    rig = await startRig(relay.url, 7871)
    await until(() => relay.authedHost !== undefined, 8000, 'bridge online at relay')
  }, 30_000)

  afterAll(async () => {
    await rig?.stop()
    await relay?.stop()
  })

  it('advertises the relay in the QR payload and host summary', () => {
    const payload = decodePairingPayload(rig.bridge.newPairingPayload().uri)
    expect(payload.r?.u).toBe(relay.url)
    expect(payload.r?.i).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(rig.bridge.hostSummary.relay).toEqual(payload.r)
  })

  it('pairs over the relay', async () => {
    const pair = await rig.pair()
    expect(pair.deviceId).toBeTruthy()
    expect(pair.relay?.u).toBe(relay.url)
  })

  it('connects over the relay and makes an RPC', async () => {
    const pair = await rig.pair()
    const client = await rig.connect(pair)
    expect(client.transport).toBe('relay')
    expect(await client.rpc('chat.send', { prompt: 'hi' })).toMatchObject({ sessionKey: 'desktop:dm:abc' })
    client.disconnect()
  })

  it('closes the bridge-side connection when the phone leaves', async () => {
    const client = await rig.connect(await rig.pair())
    await until(() => conns().size >= 1)
    client.disconnect()
    await until(() => conns().size === 0, 5000, 'bridge connection cleanup')
  })

  it('closes the phone when the bridge closes the virtual socket', async () => {
    const states: string[] = []
    const client = await rig.connect(await rig.pair(), { onState: (s) => states.push(s) })
    for (const c of conns()) c.close('test')
    await until(() => states.includes('disconnected'), 5000, 'phone to see the close')
    client.disconnect()
  })

  it('replaces an oversize response with an error and keeps the connection', async () => {
    const client = await rig.connect(await rig.pair())
    rig.gateway.overrides.set('sessions.list', 'x'.repeat(2 * 1024 * 1024))
    await expect(client.rpc('sessions.list', {})).rejects.toThrow(/too large/)
    rig.gateway.overrides.delete('sessions.list')
    // Stream is still in sync after the substitution.
    expect(await client.rpc('chat.send', { prompt: 'again' })).toMatchObject({ queued: true })
    expect(relay.maxHostFrame).toBeLessThanOrEqual(1024 * 1024)
    expect(relay.hostCloseCodes).not.toContain(1009)
    client.disconnect()
  })

  it('drops virtual sockets when the relay link dies, reconnects, and the phone follows', async () => {
    const states: string[] = []
    const client = await rig.connect(await rig.pair(), { onState: (s) => states.push(s) })
    const attemptsBefore = relay.hostAttempts
    relay.dropHost()
    await until(() => states.includes('disconnected'), 5000, 'phone to notice the drop')
    await until(() => conns().size === 0, 5000, 'bridge to close virtual sockets')
    await until(() => relay.authedHost !== undefined, 8000, 'bridge back online')
    expect(relay.hostAttempts).toBeGreaterThan(attemptsBefore)
    await until(() => client.state === 'ready', 25_000, 'phone back')
    expect(await client.rpc('chat.send', { prompt: 'after' })).toMatchObject({ queued: true })
    client.disconnect()
  }, 45_000)

  it('closes a virtual socket whose first frame is neither pair nor hello', async () => {
    const id = rig.bridge.hostSummary.relay!.i
    const ws = new WebSocket(`${relay.url}/d/${id}`)
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)))
    ws.send(JSON.stringify({ t: 'nonsense' }))
    expect(await closed).toBe(4400)
  })

  it('answers a selftest probe without routing it and logs nothing odd', async () => {
    const before = relay.devicesAccepted
    const client = (rig.bridge as unknown as { relay: RelayClient }).relay
    const passed = client.selfTestsPassed
    ;(client as unknown as { runSelfTest(ws: unknown): void }).runSelfTest((client as unknown as { ws: unknown }).ws)
    await until(() => client.selfTestsPassed === passed + 1, 5000, 'bridge self-test through routeRelaySocket')
    expect(relay.devicesAccepted).toBe(before + 1)
    expect(conns().size).toBe(0)
  })

  it('paces a 50 MB replay without the host socket buffer passing the high-water mark', async () => {
    const pair = await rig.pair()
    const KEY = 'desktop:dm:abc'
    const big = 'x'.repeat(100 * 1024)
    // lastSeq 0 means a fresh device (no replay); resume from a real cursor.
    rig.bridge.store.appendEvent('agent.message', KEY, { sessionKey: KEY, message: 'marker' })
    const cursor = rig.bridge.store.currentSeq()
    for (let i = 0; i < 500; i++) rig.bridge.store.appendEvent('agent.message', KEY, { sessionKey: KEY, message: big, i })
    const link = () => (rig.bridge as unknown as { relay: { ws: WebSocket | null } }).relay.ws
    let peak = 0
    const sampler = setInterval(() => {
      peak = Math.max(peak, link()?.bufferedAmount ?? 0)
    }, 2)
    let got = 0
    const client = await rig.connect(pair, {
      lastSeq: cursor,
      onEvent: (e, d) => {
        if (e === 'agent.message' && (d as { message?: string }).message === big) got++
      },
    })
    await until(() => got >= 500, 60_000, '500 replayed events')
    clearInterval(sampler)
    client.disconnect()
    // 512 KiB high-water plus the frame that crossed it, with slack for batching.
    expect(peak).toBeLessThan(512 * 1024 + 3 * 110 * 1024)
  }, 90_000)
})

// ---------------------------------------------------------------------------
// Live relay, opt-in
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.RELAY_LIVE_URL)('live relay', () => {
  it('pairs, connects and runs an RPC through the deployed relay', async () => {
    const rig = await startRig(process.env.RELAY_LIVE_URL!, 7872)
    try {
      await sleep(2500) // let the bridge authenticate
      const pair = await rig.pair()
      const client = await rig.connect(pair)
      expect(client.transport).toBe('relay')
      expect(await client.rpc('chat.send', { prompt: 'live' })).toMatchObject({ queued: true })
      client.disconnect()
    } finally {
      await rig.stop()
    }
  }, 60_000)
})
