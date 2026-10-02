/**
 * The client half of the phone <-> bridge protocol.
 *
 * Deliberately free of any platform API: pass in a WebSocket constructor and it
 * runs in Node, in a browser, or inside a Capacitor WebView unchanged. That is
 * what lets the end-to-end tests exercise the exact code the phone ships.
 */
import {
  PROTOCOL_VERSION,
  SecureChannel,
  type KeyPair,
  type PairingRequest,
  type PairingResponse,
  deriveSessionKeys,
  fromB64,
  generateIdentity,
  sealJson,
  toB64,
} from './crypto.js'
import { openSealedJson } from './crypto.js'
import type { DeviceSummary, Envelope, HostSummary, PairingPayload, Scope } from './wire.js'

export type ConnectionState = 'idle' | 'connecting' | 'handshaking' | 'ready' | 'disconnected'

/** Minimal structural type so both the DOM and `ws` WebSocket satisfy it. */
export interface SocketLike {
  send(data: string | ArrayBufferView | ArrayBuffer): void
  close(code?: number, reason?: string): void
  binaryType?: string
  readyState: number
  addEventListener?(type: string, listener: (ev: unknown) => void): void
  on?(type: string, listener: (...args: unknown[]) => void): void
}

export type SocketFactory = (url: string) => SocketLike

export interface RemoteClientOptions {
  identity: KeyPair
  deviceId: string
  hostPublicKey: Uint8Array
  /** "host:port" candidates, best first. They are raced. */
  addresses: string[]
  createSocket: SocketFactory
  /** Highest bridge seq already applied, for gap-free resume. */
  lastSeq?: number
  clientVersion?: string
  onEvent?: (event: string, data: unknown, seq: number | undefined, sessionKey?: string) => void
  onState?: (state: ConnectionState, detail?: string) => void
  onReady?: (info: { device: DeviceSummary; host: HostSummary; allowed: string[]; seq: number; gatewayConnected: boolean }) => void
  log?: (msg: string) => void
}

export interface PairResult {
  deviceId: string
  hostId: string
  hostName: string
  scopes: Scope[]
  identity: KeyPair
  hostPublicKey: Uint8Array
  /** The address that answered. */
  address: string
  /** Every candidate from the QR, with the one that answered first. */
  addresses: string[]
}

const CONNECT_TIMEOUT_MS = 6000
const PING_INTERVAL_MS = 20_000

/** Normalise the two WebSocket event styles into one. */
function bind(
  socket: SocketLike,
  handlers: {
    open: () => void
    message: (data: unknown, isBinary: boolean) => void
    close: (code?: number, reason?: string) => void
    error: (err: Error) => void
  },
): void {
  if (typeof socket.addEventListener === 'function') {
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', () => handlers.open())
    socket.addEventListener('message', (ev) => {
      const data = (ev as { data: unknown }).data
      handlers.message(data, data instanceof ArrayBuffer || ArrayBuffer.isView(data))
    })
    socket.addEventListener('close', (ev) => {
      const e = ev as { code?: number; reason?: string }
      handlers.close(e.code, e.reason)
    })
    socket.addEventListener('error', () => handlers.error(new Error('socket error')))
    return
  }
  socket.on?.('open', () => handlers.open())
  socket.on?.('message', (data: unknown, isBinary: unknown) => handlers.message(data, Boolean(isBinary)))
  socket.on?.('close', (code: unknown, reason: unknown) =>
    handlers.close(Number(code), String(reason ?? '')),
  )
  socket.on?.('error', (err: unknown) => handlers.error(err as Error))
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw new Error('expected a binary frame')
}

function toText(data: unknown): string {
  if (typeof data === 'string') return data
  return new TextDecoder().decode(toBytes(data))
}

/**
 * Pair with a host using a scanned QR payload.
 *
 * The request is sealed to the host public key carried in the QR, so the pairing
 * code is never exposed on the network and only the machine that printed the QR
 * can complete the exchange.
 */
export async function pairWithHost(args: {
  payload: PairingPayload
  deviceName: string
  platform: string
  createSocket: SocketFactory
  identity?: KeyPair
}): Promise<PairResult> {
  const identity = args.identity ?? generateIdentity()
  const hostPublicKey = fromB64(null, args.payload.k)

  if (args.payload.e && args.payload.e < Date.now()) {
    throw new Error('That pairing code has expired. Generate a new one on your Mac.')
  }

  let lastError = 'no address responded'
  for (const address of args.payload.a) {
    try {
      return await new Promise<PairResult>((resolve, reject) => {
        const socket = args.createSocket(`ws://${address}/pair`)
        const timer = setTimeout(() => {
          socket.close()
          reject(new Error('timed out'))
        }, CONNECT_TIMEOUT_MS)

        const finish = (err: Error | null, value?: PairResult): void => {
          clearTimeout(timer)
          try {
            socket.close()
          } catch {
            // Already closing.
          }
          if (err) reject(err)
          else resolve(value!)
        }

        bind(socket, {
          open: () => {
            const request: PairingRequest = {
              v: PROTOCOL_VERSION,
              code: args.payload.c,
              devicePublicKey: toB64(null, identity.publicKey),
              deviceName: args.deviceName,
              platform: args.platform,
            }
            socket.send(JSON.stringify({ t: 'pair', v: PROTOCOL_VERSION, sealed: sealJson(null, hostPublicKey, request) }))
          },
          message: (data) => {
            try {
              const frame = JSON.parse(toText(data)) as { t?: string; sealed?: string; message?: string }
              if (frame.t === 'err') {
                finish(new Error(frame.message ?? 'pairing refused'))
                return
              }
              if (frame.t !== 'pair_ok' || !frame.sealed) {
                finish(new Error('unexpected reply from host'))
                return
              }
              const res = openSealedJson<PairingResponse>(null, identity, frame.sealed)
              if (res.hostPublicKey !== args.payload.k) {
                finish(new Error('host key mismatch: do not trust this connection'))
                return
              }
              finish(null, {
                deviceId: res.deviceId,
                hostId: res.hostId,
                hostName: res.hostName,
                scopes: res.scopes as Scope[],
                identity,
                hostPublicKey,
                address,
                // Keep every candidate: the phone will move between WiFi and
                // Tailscale and should re-race them rather than re-pair.
                addresses: [address, ...args.payload.a.filter((a) => a !== address)],
              })
            } catch (err) {
              finish(err as Error)
            }
          },
          close: () => finish(new Error('host closed the connection')),
          error: (err) => finish(err),
        })
      })
    } catch (err) {
      lastError = (err as Error).message
    }
  }
  throw new Error(`Could not reach your Mac (${lastError}). Check it is awake and on the same network or Tailnet.`)
}

/**
 * A live, encrypted connection to a paired host.
 *
 * Reconnects on its own, races every known address so moving between WiFi and
 * Tailscale needs no user action, and resumes from the last applied bridge seq so
 * nothing is missed while the phone was asleep.
 */
export class RemoteClient {
  state: ConnectionState = 'idle'
  host: HostSummary | null = null
  device: DeviceSummary | null = null
  allowed: string[] = []
  gatewayConnected = false
  /** The address that actually worked, so the next connect tries it first. */
  activeAddress: string | null = null
  lastSeq: number

  private socket: SocketLike | null = null
  private channel: SecureChannel | null = null
  private ephemeral: KeyPair | null = null
  private rpcId = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private stopped = false
  private subscriptions = new Set<string>()

  constructor(private readonly opts: RemoteClientOptions) {
    this.lastSeq = opts.lastSeq ?? 0
  }

  private log(msg: string): void {
    this.opts.log?.(msg)
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.state === state) return
    this.state = state
    this.opts.onState?.(state, detail)
  }

  connect(): void {
    this.stopped = false
    this.openNext()
  }

  disconnect(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.stopPing()
    this.failPending(new Error('disconnected'))
    try {
      this.socket?.close()
    } catch {
      // Already closing.
    }
    this.socket = null
    this.channel = null
    this.setState('disconnected')
  }

  private orderedAddresses(): string[] {
    const list = [...this.opts.addresses]
    if (this.activeAddress) {
      const i = list.indexOf(this.activeAddress)
      if (i > 0) list.splice(0, 0, ...list.splice(i, 1))
    }
    return list
  }

  /**
   * Race every candidate address and keep the first that completes a handshake.
   * Racing rather than trying in sequence is what makes a WiFi-to-cellular
   * handover feel instant instead of taking one timeout per dead address.
   */
  private openNext(): void {
    if (this.stopped) return
    this.setState('connecting')
    const addresses = this.orderedAddresses()
    if (addresses.length === 0) {
      this.scheduleReconnect('no addresses configured')
      return
    }

    let settled = false
    const attempts: SocketLike[] = []

    const win = (socket: SocketLike, address: string, channel: SecureChannel, host: HostSummary): void => {
      if (settled) {
        try {
          socket.close()
        } catch {
          // Losers are closed silently.
        }
        return
      }
      settled = true
      for (const other of attempts) {
        if (other !== socket) {
          try {
            other.close()
          } catch {
            // Already closing.
          }
        }
      }
      this.socket = socket
      this.channel = channel
      this.host = host
      this.activeAddress = address
      this.attempt = 0
      this.sendEnvelope({ t: 'auth', lastSeq: this.lastSeq, clientVersion: this.opts.clientVersion })
    }

    const lose = (reason: string): void => {
      if (settled) return
      if (attempts.every((s) => s.readyState === 3 /* CLOSED */)) {
        settled = true
        this.scheduleReconnect(reason)
      }
    }

    for (const address of addresses) {
      let socket: SocketLike
      try {
        socket = this.opts.createSocket(`ws://${address}/connect`)
      } catch (err) {
        this.log(`cannot open ${address}: ${(err as Error).message}`)
        continue
      }
      attempts.push(socket)

      const ephemeral = generateIdentity()
      let channel: SecureChannel | null = null
      const timer = setTimeout(() => {
        try {
          socket.close()
        } catch {
          // Already closing.
        }
      }, CONNECT_TIMEOUT_MS)

      bind(socket, {
        open: () => {
          this.setState('handshaking')
          socket.send(
            JSON.stringify({
              t: 'hello',
              v: PROTOCOL_VERSION,
              deviceId: this.opts.deviceId,
              ephPk: toB64(null, ephemeral.publicKey),
            }),
          )
        },
        message: (data, isBinary) => {
          try {
            if (!isBinary) {
              const frame = JSON.parse(toText(data)) as Record<string, unknown>
              if (frame.t === 'err') {
                clearTimeout(timer)
                this.log(`host refused: ${String(frame.message)}`)
                try {
                  socket.close()
                } catch {
                  // Already closing.
                }
                return
              }
              if (frame.t === 'hello_ack') {
                const keys = deriveSessionKeys(null, 'device', {
                  myEphemeral: ephemeral,
                  theirEphemeralPk: fromB64(null, String(frame.ephPk)),
                  myStatic: this.opts.identity,
                  theirStaticPk: this.opts.hostPublicKey,
                })
                channel = SecureChannel.create(null, keys)
                socket.send(JSON.stringify({ t: 'hdr', hdr: toB64(null, channel.startSend()) }))
                this.ephemeral = ephemeral
                return
              }
              if (frame.t === 'hdr' && channel) {
                clearTimeout(timer)
                channel.startReceive(fromB64(null, String(frame.hdr)))
                win(socket, address, channel, {
                  id: String(frame.hostId ?? ''),
                  name: String(frame.hostName ?? ''),
                  fingerprint: '',
                  version: '',
                })
                return
              }
              return
            }
            if (this.socket !== socket || !this.channel) return
            this.onEnvelope(this.channel.open<Envelope>(toBytes(data)))
          } catch (err) {
            this.log(`frame rejected from ${address}: ${(err as Error).message}`)
            try {
              socket.close()
            } catch {
              // Already closing.
            }
          }
        },
        close: (code, reason) => {
          clearTimeout(timer)
          if (this.socket === socket) {
            this.socket = null
            this.channel = null
            this.stopPing()
            this.failPending(new Error('connection closed'))
            this.setState('disconnected', reason)
            this.scheduleReconnect(reason || `closed ${code ?? ''}`)
            return
          }
          lose(reason || 'unreachable')
        },
        error: () => {
          clearTimeout(timer)
          lose('socket error')
        },
      })
    }
  }

  private onEnvelope(env: Envelope): void {
    switch (env.t) {
      case 'ready': {
        this.device = env.device
        this.host = env.host
        this.allowed = env.allowed
        this.gatewayConnected = env.gatewayConnected
        this.setState('ready')
        this.startPing()
        this.opts.onReady?.(env)
        // Re-assert subscriptions after a reconnect so the stream resumes without
        // the UI having to notice anything happened.
        if (this.subscriptions.size > 0) {
          void this.rpc('sessions.subscribe', { sessionKeys: [...this.subscriptions] }).catch(() => {})
        }
        return
      }
      case 'event': {
        if (typeof env.seq === 'number' && env.seq > this.lastSeq) this.lastSeq = env.seq
        if (env.event === 'remote.scopes_changed' && this.device) {
          this.device = { ...this.device, scopes: (env.data as { scopes: Scope[] }).scopes }
        }
        this.opts.onEvent?.(env.event, env.data, env.seq, env.sessionKey)
        return
      }
      case 'rpc_res': {
        const p = this.pending.get(env.id)
        if (!p) return
        this.pending.delete(env.id)
        clearTimeout(p.timer)
        if (env.error) p.reject(Object.assign(new Error(env.error.message), { code: env.error.code }))
        else p.resolve(env.result)
        return
      }
      case 'pong':
        return
      default:
        return
    }
  }

  private sendEnvelope(env: Envelope): void {
    if (!this.socket || !this.channel) throw new Error('not connected')
    this.socket.send(this.channel.seal(env))
  }

  async rpc<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.state !== 'ready' && method !== 'remote.hello') {
      throw new Error('not connected to your Mac')
    }
    const id = ++this.rpcId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      try {
        this.sendEnvelope({ t: 'rpc', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err as Error)
      }
    })
  }

  async subscribe(sessionKeys: string[]): Promise<void> {
    for (const k of sessionKeys) this.subscriptions.add(k)
    await this.rpc('sessions.subscribe', { sessionKeys })
  }

  async unsubscribe(sessionKeys: string[]): Promise<void> {
    for (const k of sessionKeys) this.subscriptions.delete(k)
    await this.rpc('sessions.unsubscribe', { sessionKeys })
  }

  can(method: string): boolean {
    return this.allowed.some((rule) => (rule.endsWith('.*') ? method.startsWith(rule.slice(0, -1)) : rule === method))
  }

  hasScope(scope: Scope): boolean {
    return this.device?.scopes.includes(scope) ?? false
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      try {
        this.sendEnvelope({ t: 'ping', ts: Date.now() })
      } catch {
        // The close handler will deal with it.
      }
    }, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt, 4), 20_000) + Math.floor(Math.random() * 400)
    this.attempt += 1
    this.log(`reconnecting in ${delay}ms (${reason})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openNext()
    }, delay)
  }
}
