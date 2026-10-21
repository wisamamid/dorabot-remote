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
import { CAP_DEFLATE } from './compress.js'
import { RELAY_HEAD_START_MS, relayAuthFrame, relayDeviceUrl, relayTokenHash, type RelayInfo } from './relay.js'
import { methodsForScopes } from './policy.js'
import type { DeviceSummary, Envelope, HostSummary, PairingPayload, Scope } from './wire.js'

export type Transport = 'lan' | 'relay'

export type ConnectionState = 'idle' | 'connecting' | 'handshaking' | 'ready' | 'disconnected' | 'pending'

/** While the Mac has not approved this phone yet, hello is retried at this pace (no long backoff). */
export const PENDING_RETRY_MS = 5000

/**
 * Plaintext refusals before the encrypted channel exists are unauthenticated: anyone on
 * the path can forge them. They are therefore only ever a soft failure (long backoff),
 * and the text shown is fixed here, never taken from the frame.
 */
const SOFT_REFUSAL_CODES = new Set(['revoked', 'unknown_device'])
const SOFT_REFUSAL_BACKOFF_MS = 5 * 60_000
export const NOT_RECOGNISED_TEXT = "This Mac doesn't recognise this phone any more. Pair again from Settings."

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
  /** Fired when the host reports a relay that differs from the one we hold, so the caller can persist it. */
  onRelay?: (relay: RelayInfo) => void | Promise<void>
  createSocket: SocketFactory
  /** Highest bridge seq already applied, for gap-free resume. */
  lastSeq?: number
  clientVersion?: string
  onEvent?: (event: string, data: unknown, seq: number | undefined, sessionKey?: string) => void
  onState?: (state: ConnectionState, detail?: string) => void
  /** Known deadline (epoch ms) for the Mac to approve this phone, from the pairing reply. Display only. */
  approvalExpiresAt?: number | null
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
  /** True when the Mac must still approve this phone. Connect anyway: the client waits in state 'pending'. */
  pending?: boolean
  /** Epoch ms when the unapproved pairing expires. */
  approvalExpiresAt?: number
  transport: Transport
}

const CONNECT_TIMEOUT_MS = 6000
/**
 * Per-attempt budgets for the live-connection race. A LAN candidate that is
 * unreachable (private IP or .local name while on cellular, or iOS local-network
 * permission stalls) must not be waited on; the relay needs longer because it
 * crosses the internet and may wake a Durable Object.
 */
export const LAN_ATTEMPT_TIMEOUT_MS = 3000
export const RELAY_ATTEMPT_TIMEOUT_MS = 10_000
/**
 * A relay socket that opens but gets no answer to `hello` this fast is probably wired
 * to a host link that is not delivering. Close it and retry once at once rather than
 * wait out the full attempt budget.
 */
export const RELAY_HANDSHAKE_WATCHDOG_MS = 5000
const PING_INTERVAL_MS = 10_000
/** A ping with no inbound frame at all within this long means the socket is half-open. */
const PONG_TIMEOUT_MS = 5_000

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
          // [SEC-RELAY] Over the relay, the QR's single-use ticket is the first frame.
          if (transport === 'relay' && args.payload.r?.tk) socket.send(relayAuthFrame(args.payload.r.tk))
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
              // [SEC-RELAY] The ticket is spent; keep the long-lived token the host sealed to us.
              relay: args.payload.r ? { u: args.payload.r.u, i: args.payload.r.i, ...(res.relayTok ? { tok: res.relayTok } : {}) } : undefined,
              ...(res.pending ? { pending: true } : {}),
              ...(typeof res.approvalExpiresAt === 'number' ? { approvalExpiresAt: res.approvalExpiresAt } : {}),
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
  /** A plaintext 'revoked' / 'unknown_device' was seen; back off long and show fixed text. */
  private notRecognised = false
  /** The host said 'pending': the Mac has not approved this phone yet. Retry hello every PENDING_RETRY_MS. */
  private pendingApproval = false
  /** The relay token the app has confirmed it persisted (from storage at start, or after onRelay completed). */
  private persistedTok: string | null
  /** While state is 'pending': when the Mac will discard the request (epoch ms), if known. Display only. */
  approvalExpiresAt: number | null
  /** One-shot: the next race starts the relay at once (network just changed, LAN is unlikely). */
  private skipLanHeadStart = false
  /** Phone is on cellular: LAN candidates are unlikely, so the relay never waits for them. */
  private cellular = false
  private subscriptions = new Set<string>()

  constructor(private readonly opts: RemoteClientOptions) {
    this.lastSeq = opts.lastSeq ?? 0
    this.relay = opts.relay ?? null
    // A token handed in at construction came out of the app's storage.
    this.persistedTok = opts.relay?.tok ?? null
    this.approvalExpiresAt = opts.approvalExpiresAt ?? null
  }

  /** Tell the client what kind of network the phone is on. Cellular starts the relay without a LAN head start. */
  setNetworkType(type: string): void {
    this.cellular = type === 'cellular'
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
    // Between pending retries stay in 'pending' rather than flickering through connecting/handshaking.
    if (this.pendingApproval && (state === 'connecting' || state === 'handshaking')) return
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

  private describeTarget(address: string, transport: Transport): string {
    return transport === 'relay' && this.relay ? `${address} id=${this.relay.i.slice(0, 6)}` : address
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

  /**
   * The network changed (Wi-Fi to cellular and so on). The current socket is bound
   * to the old interface and may look open for minutes: drop it and reconnect now,
   * with no backoff, racing the relay straight away.
   */
  forceReconnect(): void {
    this.stopped = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.attempt = 0
    this.activeAddress = null
    this.skipLanHeadStart = true
    this.failPending(new Error('network changed'))
    this.setTransport(null)
    this.openNext()
  }

  disconnect(): void {
    this.stopped = true
    this.pendingApproval = false
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
    if (this.stopped) return
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
    /** Attempts that have not yet failed. Tracked here rather than via readyState so a socket that never reports closing cannot stall the race. */
    const live = new Set<SocketLike>()
    const failures: string[] = []
    const raceStart = Date.now()
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
      this.notRecognised = false
      this.pendingApproval = false
      this.approvalExpiresAt = null
      this.socket = socket
      this.channel = channel
      this.host = host
      if (transport === 'lan') this.activeAddress = address
      this.setTransport(transport)
      this.attempt = 0
      this.log(`race won by ${transport} ${this.describeTarget(address, transport)} after ${Date.now() - raceStart}ms`)
      this.sendEnvelope({ t: 'auth', lastSeq: this.lastSeq, clientVersion: this.opts.clientVersion, caps: [CAP_DEFLATE] })
    }

    const lose = (reason: string): void => {
      if (settled || stale()) return
      if (live.size > 0) return
      if (startRelay) {
        startRelay()
        return
      }
      settled = true
      this.racing = false
      this.raceSockets.clear()
      const why = failures.length > 0 ? failures.join('; ') : reason
      this.log(`race failed after ${Date.now() - raceStart}ms: ${why}`)
      this.scheduleReconnect(why)
    }

    const race = (url: string, address: string, transport: Transport, retried = false): void => {
      const target = this.describeTarget(address, transport)
      const t0 = Date.now()
      let socket: SocketLike
      try {
        socket = this.opts.createSocket(url)
      } catch (err) {
        this.log(`attempt ${transport} ${target} cannot start: ${(err as Error).message}`)
        failures.push(`${transport} ${address}: ${(err as Error).message}`)
        return
      }
      this.log(`attempt ${transport} ${target} start`)
      attempts.push(socket)
      live.add(socket)
      this.raceSockets.add(socket)

      const ephemeral = generateIdentity()
      let channel: SecureChannel | null = null
      let failed = false
      const fail = (why: string): void => {
        if (failed) return
        failed = true
        live.delete(socket)
        // A loser closed by the winner or a cancelled race is not a failure worth recording.
        if (!settled && !stale()) {
          this.log(`attempt ${transport} ${target} failed: ${why} after ${Date.now() - t0}ms`)
          failures.push(`${transport} ${address}: ${why}`)
        }
      }
      let handshakeWatch: ReturnType<typeof setTimeout> | null = null
      const stopWatch = (): void => {
        if (handshakeWatch) clearTimeout(handshakeWatch)
        handshakeWatch = null
      }
      const timer = setTimeout(() => {
        stopWatch()
        fail('timed out')
        this.raceSockets.delete(socket)
        try {
          socket.close()
        } catch {
          // Already closing.
        }
        // A hung socket may never report closing, so settle the race from here.
        lose('timed out')
      }, transport === 'lan' ? LAN_ATTEMPT_TIMEOUT_MS : RELAY_ATTEMPT_TIMEOUT_MS)

      bind(socket, {
        open: () => {
          this.log(`attempt ${transport} ${target} open after ${Date.now() - t0}ms`)
          this.setState('handshaking')
          if (transport === 'relay') {
            handshakeWatch = setTimeout(() => {
              handshakeWatch = null
              if (failed || settled || stale()) return
              this.log(`attempt ${transport} ${target} opened but no handshake response in ${RELAY_HANDSHAKE_WATCHDOG_MS}ms${retried ? '' : ', retrying once'}`)
              clearTimeout(timer)
              fail('no handshake response')
              this.raceSockets.delete(socket)
              try {
                socket.close()
              } catch {
                // Already closing.
              }
              if (!retried) race(url, address, transport, true)
              else lose('no handshake response')
            }, RELAY_HANDSHAKE_WATCHDOG_MS)
          }
          // [SEC-RELAY] The relay wants the device token before it will forward anything.
          if (transport === 'relay' && this.relay?.tok) socket.send(relayAuthFrame(this.relay.tok))
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
              // After the handshake nothing legitimate is plaintext. Anything else could be a
              // forged control frame or a replayed header (which would reset the receive counter).
              if (channel?.established) throw new Error('plaintext frame after handshake')
              const frame = JSON.parse(toText(data)) as Record<string, unknown>
              stopWatch()
              if (frame.t === 'err') {
                clearTimeout(timer)
                this.log(`attempt ${transport} ${target} host refused: ${String(frame.code ?? '')}`)
                if (!stale() && frame.code === 'pending') {
                  // Unauthenticated, so only ever a display hint plus a quick retry; it grants nothing.
                  this.pendingApproval = true
                  this.notRecognised = false
                  if (typeof frame.approvalExpiresAt === 'number' && Number.isFinite(frame.approvalExpiresAt)) this.approvalExpiresAt = frame.approvalExpiresAt
                } else if (!stale() && typeof frame.code === 'string' && SOFT_REFUSAL_CODES.has(frame.code)) {
                  // Approval refused or expired (unknown_device after pending) lands here: the soft path.
                  this.notRecognised = true
                  this.pendingApproval = false
                  this.approvalExpiresAt = null
                }
                this.closeQuietly(socket)
                return
              }
              if (frame.t === 'hello_ack' && !channel) {
                const keys = deriveSessionKeys(null, 'device', {
                  myEphemeral: ephemeral,
                  theirEphemeralPk: fromB64(null, String(frame.ephPk)),
                  myStatic: this.opts.identity,
                  theirStaticPk: this.opts.hostPublicKey,
                })
                channel = SecureChannel.create(null, keys, { acceptCompressed: true })
                socket.send(JSON.stringify({ t: 'hdr', hdr: toB64(null, channel.startSend()) }))
                this.ephemeral = ephemeral
                return
              }
              if (frame.t === 'hdr' && channel) {
                clearTimeout(timer)
                this.log(`attempt ${transport} ${target} handshake ok after ${Date.now() - t0}ms`)
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
          stopWatch()
          this.raceSockets.delete(socket)
          const why = `closed ${code ?? '?'}${reason ? ` ${reason}` : ''}`
          if (this.socketLost(socket, reason)) {
            this.log(`${transport} ${target} connection lost: ${why}`)
            this.scheduleReconnect(reason || why)
            return
          }
          fail(why)
          lose(reason || 'unreachable')
        },
        error: () => {
          clearTimeout(timer)
          stopWatch()
          // A close normally follows; if it never does, the race must still settle.
          fail('socket error')
          lose('socket error')
        },
      })
    }

    this.log(`race start: ${addresses.length} lan candidate(s)${relay ? `, relay ${relay.u} id=${relay.i.slice(0, 6)}` : ', no relay known'}${this.cellular ? ', cellular' : ''}`)
    if (!relay && addresses.length > 0) this.log('warning: no relay info held, only LAN candidates can be tried')

    // The relay is armed before any LAN socket is created so that a synchronous
    // throw from the LAN attempts can never leave it unstarted.
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
    }

    for (const address of addresses) {
      try {
        race(`ws://${address}/connect`, address, 'lan')
      } catch (err) {
        this.log(`attempt lan ${address} threw: ${(err as Error).message}`)
        failures.push(`lan ${address}: ${(err as Error).message}`)
      }
    }

    if (relay) {
      const fast = this.skipLanHeadStart || this.cellular
      this.skipLanHeadStart = false
      if (addresses.length === 0 || fast || live.size === 0) startRelay?.()
      else relayTimer = setTimeout(() => startRelay?.(), RELAY_HEAD_START_MS)
    } else if (live.size === 0) {
      lose('unreachable')
    }
  }

  private onEnvelope(env: Envelope): void {
    switch (env.t) {
      case 'ready': {
        let persisted: Promise<unknown> | undefined
        this.device = env.device
        this.host = env.host
        this.allowed = env.allowed
        this.gatewayConnected = env.gatewayConnected
        // An already-paired phone learns the relay the first time it reaches the
        // host over LAN, with no re-pairing.
        if (env.host.relay) {
          const changed = !this.relay || this.relay.u !== env.host.relay.u || this.relay.i !== env.host.relay.i || this.relay.tok !== env.host.relay.tok // [SEC-RELAY] token changes persist too
          this.relay = env.host.relay
          if (changed) {
            this.log(`relay learned from host: ${env.host.relay.u} id=${env.host.relay.i.slice(0, 6)}`)
            const r = env.host.relay
            this.safe(() => {
              persisted = Promise.resolve(this.opts.onRelay?.(r))
            }, 'onRelay')
          }
        }
        this.setState('ready')
        void this.ackRelayToken(persisted)
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
        this.log(`rpc timeout: ${method} after ${timeoutMs}ms (state ${this.state}, transport ${this.transport ?? 'none'})`)
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

  /**
   * Tell the Mac this phone has PERSISTED its relay token, with the token's hash as proof. Until every
   * device has done so the relay does not start refusing token-less sockets (old builds would be locked out).
   * Only acts on a token the app confirmed it stored: held from storage, or after onRelay completed.
   */
  private async ackRelayToken(persist?: Promise<unknown>): Promise<void> {
    const tok = this.relay?.tok
    if (!tok) return
    if (persist) {
      try {
        await persist
      } catch {
        return
      }
      this.persistedTok = tok
    }
    if (this.persistedTok !== tok) return
    try {
      await this.rpc('remote.relayTokAck', { tokHash: relayTokenHash(tok) })
    } catch {
      // An older bridge does not know the method; it does not enforce either.
    }
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
    let delay = Math.min(1000 * 2 ** Math.min(this.attempt, 4), 20_000) + Math.floor(Math.random() * 400)
    if (this.pendingApproval) {
      delay = PENDING_RETRY_MS
      this.setState('pending')
    } else if (this.notRecognised) {
      delay = SOFT_REFUSAL_BACKOFF_MS
      this.setState('disconnected', NOT_RECOGNISED_TEXT)
    }
    this.attempt += 1
    this.log(`reconnecting in ${delay}ms (${reason})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openNext()
    }, delay)
  }
}
