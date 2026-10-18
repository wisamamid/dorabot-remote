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
import { RELAY_HEAD_START_MS, relayDeviceUrl, type RelayInfo } from './relay.js'
import { methodsForScopes } from './policy.js'
import type { DeviceSummary, Envelope, HostSummary, PairingPayload, Scope } from './wire.js'

export type Transport = 'lan' | 'relay'

export type ConnectionState = 'idle' | 'connecting' | 'handshaking' | 'ready' | 'disconnected' | 'revoked'

/** Host error codes that retrying can never fix: the device must pair again. */
const TERMINAL_ERROR_CODES = new Set(['revoked', 'unknown_device'])

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
  /** Blind relay for reaching the host from anywhere. Joins the race after LAN gets a head start. */
  relay?: RelayInfo | null
  /** Fired when the winning transport changes, for a LAN/relay badge. */
  onTransport?: (transport: Transport | null) => void
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
  /** The address that answered (the relay url when paired through the relay). */
  address: string
  /** Every candidate from the QR, with the one that answered first. */
  addresses: string[]
  /** Relay from the QR, to persist so the phone can reach the host off-LAN. */
  relay?: RelayInfo
  transport: Transport
}

const CONNECT_TIMEOUT_MS = 6000
const PING_INTERVAL_MS = 20_000
/** A ping with no inbound frame at all within this long means the socket is half-open. */
const PONG_TIMEOUT_MS = 10_000

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

  const attemptPair = (url: string, address: string, transport: Transport): Promise<PairResult> =>
    new Promise<PairResult>((resolve, reject) => {
      const socket = args.createSocket(url)
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
              addresses: [...(transport === 'lan' ? [address] : []), ...args.payload.a.filter((a) => a !== address)],
              relay: args.payload.r,
              transport,
            })
          } catch (err) {
            finish(err as Error)
          }
        },
        close: () => finish(new Error('host closed the connection')),
        error: (err) => finish(err),
      })
    })

  // LAN candidates are tried in order, as before. The relay joins after a short
  // head start (or at once if every LAN address has already failed), so pairing at
  // home never leaves the LAN and pairing on cellular still works.
  let lastError = 'no address responded'
  // The code is single use, so once either path wins the other must stand down.
  let decided = false
  const lan = (async (): Promise<PairResult> => {
    for (const address of args.payload.a) {
      if (decided) break
      try {
        return await attemptPair(`ws://${address}/pair`, address, 'lan')
      } catch (err) {
        lastError = (err as Error).message
      }
    }
    throw new Error(lastError)
  })()

  const relay = args.payload.r
  if (!relay) {
    try {
      return await lan
    } catch {
      throw new Error(`Could not reach your Mac (${lastError}). Check it is awake and on the same network or Tailnet.`)
    }
  }

  const viaRelay = (async (): Promise<PairResult> => {
    await Promise.race([
      new Promise((r) => setTimeout(r, args.payload.a.length === 0 ? 0 : RELAY_HEAD_START_MS)),
      lan.then(
        () => new Promise(() => {}),
        () => undefined,
      ),
    ])
    if (decided) throw new Error('stood down')
    return attemptPair(relayDeviceUrl(relay), relay.u, 'relay')
  })()

  try {
    const won = await Promise.any([lan, viaRelay])
    decided = true
    return won
  } catch (err) {
    const errors = (err as AggregateError).errors as Error[]
    const msg = errors.map((e) => e.message).find((m) => m && m !== 'timed out' && m !== 'host closed the connection') ?? lastError
    throw new Error(`Could not reach your Mac (${msg}). Check it is awake and online.`)
  }
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
  /** Which path the live connection took. Null while not connected. */
  transport: Transport | null = null
  /** Relay to race against LAN; refreshed from the host on every ready. */
  relay: RelayInfo | null
  lastSeq: number

  private socket: SocketLike | null = null
  private channel: SecureChannel | null = null
  private ephemeral: KeyPair | null = null
  private rpcId = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  /** Bumped whenever a race is cancelled or restarted, so stale attempts can never win. */
  private generation = 0
  private racing = false
  private raceSockets = new Set<SocketLike>()
  /** Counts inbound encrypted frames; a probe is answered if this moved. */
  private rxCount = 0
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private subscriptions = new Set<string>()

  constructor(private readonly opts: RemoteClientOptions) {
    this.lastSeq = opts.lastSeq ?? 0
    this.relay = opts.relay ?? null
  }

  private setTransport(t: Transport | null): void {
    if (this.transport === t) return
    this.transport = t
    this.safe(() => this.opts.onTransport?.(t), 'onTransport')
  }

  private log(msg: string): void {
    this.opts.log?.(msg)
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.state === state) return
    this.state = state
    this.safe(() => this.opts.onState?.(state, detail), 'onState')
  }

  /** A throwing listener is a UI bug; it must never take the connection down. */
  private safe(fn: () => void, what: string): void {
    try {
      fn()
    } catch (err) {
      this.log(`${what} listener threw: ${(err as Error).message}`)
    }
  }

  private closeQuietly(socket: SocketLike | null | undefined): void {
    try {
      socket?.close()
    } catch {
      // Already closing.
    }
  }

  /** Cancel any in-flight race and drop the live socket. Stale attempts can no longer win. */
  private teardown(): void {
    this.generation += 1
    this.racing = false
    for (const s of this.raceSockets) this.closeQuietly(s)
    this.raceSockets.clear()
    this.closeQuietly(this.socket)
    this.socket = null
    this.channel = null
    this.stopPing()
  }

  /**
   * Start connecting now. A no-op while a race is running or the connection is
   * live; otherwise it cancels any pending backoff and races immediately.
   */
  connect(): void {
    this.stopped = false
    if (this.racing || this.socket) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.openNext()
  }

  disconnect(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.teardown()
    this.failPending(new Error('disconnected'))
    this.setTransport(null)
    this.setState('disconnected')
  }

  /** The live socket is gone (closed or presumed dead): clean up and let the caller reconnect. */
  private socketLost(socket: SocketLike, reason?: string): boolean {
    if (this.socket !== socket) return false
    this.socket = null
    this.channel = null
    this.stopPing()
    this.failPending(new Error('connection closed'))
    this.setTransport(null)
    this.setState('disconnected', reason)
    return true
  }

  /**
   * Check the connection is really alive, e.g. on app resume. Sends a ping and, if
   * nothing at all arrives within `timeoutMs`, drops the socket and reconnects
   * at once. If we are not ready, just reconnect now (skipping backoff).
   */
  checkAlive(timeoutMs = 3000): void {
    if (this.stopped || this.state === 'revoked') return
    if (this.state !== 'ready' || !this.socket) {
      this.connect()
      return
    }
    this.probe(timeoutMs, true)
  }

  private probe(timeoutMs: number, immediateReconnect: boolean): void {
    const socket = this.socket
    if (!socket) return
    const seen = this.rxCount
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null
      if (this.socket !== socket || this.rxCount !== seen) return
      this.log('no reply to ping, dropping half-open socket')
      this.closeQuietly(socket)
      if (this.socketLost(socket, 'connection timed out')) {
        if (immediateReconnect) this.connect()
        else this.scheduleReconnect('ping timeout')
      }
    }, timeoutMs)
    try {
      this.sendEnvelope({ t: 'ping', ts: Date.now() })
    } catch {
      // The timer above will notice nothing came back.
    }
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
    // Any previous race or socket is cancelled first: only one race ever lives.
    this.teardown()
    const gen = this.generation
    this.racing = true
    this.setState('connecting')
    const addresses = this.orderedAddresses()
    const relay = this.relay
    if (addresses.length === 0 && !relay) {
      this.racing = false
      this.scheduleReconnect('no addresses configured')
      return
    }

    let settled = false
    const attempts: SocketLike[] = []
    const stale = (): boolean => gen !== this.generation
    // The relay starts late so that LAN wins whenever it is reachable, which keeps
    // traffic off the internet and latency low. If every LAN attempt has already
    // failed there is nothing to wait for, so it starts at once.
    let relayTimer: ReturnType<typeof setTimeout> | null = null
    let startRelay: (() => void) | null = null

    const win = (socket: SocketLike, address: string, transport: Transport, channel: SecureChannel, host: HostSummary): void => {
      if (settled || stale()) {
        this.closeQuietly(socket)
        return
      }
      settled = true
      this.racing = false
      if (relayTimer) clearTimeout(relayTimer)
      relayTimer = null
      startRelay = null
      for (const other of new Set([...attempts, ...this.raceSockets, ...(this.socket ? [this.socket] : [])])) {
        if (other !== socket) this.closeQuietly(other)
      }
      this.raceSockets.clear()
      this.rxCount = 0
      this.socket = socket
      this.channel = channel
      this.host = host
      if (transport === 'lan') this.activeAddress = address
      this.setTransport(transport)
      this.attempt = 0
      this.sendEnvelope({ t: 'auth', lastSeq: this.lastSeq, clientVersion: this.opts.clientVersion })
    }

    const lose = (reason: string): void => {
      if (settled || stale()) return
      if (!attempts.every((s) => s.readyState === 3 /* CLOSED */)) return
      if (startRelay) {
        startRelay()
        return
      }
      settled = true
      this.racing = false
      this.raceSockets.clear()
      this.scheduleReconnect(reason)
    }

    const race = (url: string, address: string, transport: Transport): void => {
      let socket: SocketLike
      try {
        socket = this.opts.createSocket(url)
      } catch (err) {
        this.log(`cannot open ${address}: ${(err as Error).message}`)
        return
      }
      attempts.push(socket)
      this.raceSockets.add(socket)

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
                if (!stale() && typeof frame.code === 'string' && TERMINAL_ERROR_CODES.has(frame.code)) {
                  // Retrying can never fix this; stop and say so.
                  this.stopped = true
                  if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
                  this.reconnectTimer = null
                  this.teardown()
                  this.setState('revoked', String(frame.message ?? frame.code))
                  return
                }
                this.closeQuietly(socket)
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
                win(socket, address, transport, channel, {
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
            const env = this.channel.open<Envelope>(toBytes(data))
            this.rxCount += 1
            // Only a bad frame closes the socket; a throwing listener must not.
            try {
              this.onEnvelope(env)
            } catch (err) {
              this.log(`handler for "${env.t}" threw: ${(err as Error).message}`)
            }
          } catch (err) {
            this.log(`frame rejected from ${address}: ${(err as Error).message}`)
            this.closeQuietly(socket)
          }
        },
        close: (code, reason) => {
          clearTimeout(timer)
          this.raceSockets.delete(socket)
          if (this.socketLost(socket, reason)) {
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

    for (const address of addresses) race(`ws://${address}/connect`, address, 'lan')

    if (relay) {
      const url = relayDeviceUrl(relay)
      startRelay = () => {
        if (relayTimer) clearTimeout(relayTimer)
        relayTimer = null
        startRelay = null
        race(url, relay.u, 'relay')
        // A relay socket that could not even be created leaves nothing to wait on.
        lose('unreachable')
      }
      if (addresses.length === 0) startRelay()
      else relayTimer = setTimeout(() => startRelay?.(), RELAY_HEAD_START_MS)
    }
  }

  private onEnvelope(env: Envelope): void {
    switch (env.t) {
      case 'ready': {
        this.device = env.device
        this.host = env.host
        this.allowed = env.allowed
        this.gatewayConnected = env.gatewayConnected
        // An already-paired phone learns the relay the first time it reaches the
        // host over LAN, with no re-pairing.
        if (env.host.relay) this.relay = env.host.relay
        this.setState('ready')
        this.startPing()
        this.safe(() => this.opts.onReady?.(env), 'onReady')
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
          const scopes = (env.data as { scopes: Scope[] }).scopes
          this.device = { ...this.device, scopes }
          this.allowed = methodsForScopes(scopes)
        }
        this.safe(() => this.opts.onEvent?.(env.event, env.data, env.seq, env.sessionKey), 'onEvent')
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
    this.pingTimer = setInterval(() => this.probe(PONG_TIMEOUT_MS, false), PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = null
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
