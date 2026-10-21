/**
 * The bridge's outbound link to the blind relay.
 *
 * The bridge dials `${url}/h/${relayId}`, answers the room's challenge with an
 * Ed25519 signature, and from then on every phone that joins the room appears as a
 * connId multiplexed over this one socket. Each connId is surfaced as a
 * VirtualSocket so DeviceConnection and the pairing handler cannot tell it from a
 * LAN WebSocket.
 */
import { EventEmitter } from 'node:events'
import {
  MuxKind,
  RELAY_CLOSE,
  RELAY_HB_REQUEST,
  RELAY_HB_RESPONSE,
  RELAY_MAX_FRAME_BYTES,
  decodeMux,
  decodeMuxClose,
  encodeMux,
  encodeMuxClose,
  encodeMuxText,
  newRelayToken,
  relayAuthFrame,
  relayDeviceUrl,
  relayHostUrl,
  relayIdFromPublicKey,
  relayTokenHash,
  signChallenge,
} from '@dorabot-remote/protocol'
import type { SigningKeyPair } from '@dorabot-remote/protocol'
import WebSocket from 'ws'
import type { DeviceSocket } from './device-socket.js'

/**
 * What the relay is told about who may open a device socket. Hashes only (see relayTokenHash).
 * `enforce` false = the transition period: token-less (legacy) devices are still let in.
 */
export interface RelayAccess {
  tokens: string[]
  tickets: string[]
  enforce: boolean
}

export type RelayState = 'connecting' | 'online' | 'offline'

/** Mux header is kind(1) + connId(4); the room limits the whole frame. */
export const MUX_HEADER_BYTES = 5
export const MAX_PAYLOAD_BYTES = RELAY_MAX_FRAME_BYTES - MUX_HEADER_BYTES

export const BACKOFF_BASE_MS = 1000
export const BACKOFF_CAP_MS = 30_000
/** A link that dies sooner than this after `ok` does not earn a backoff reset. */
export const STABLE_MS = 5000
export const PING_INTERVAL_MS = 30_000
export const PONG_TIMEOUT_MS = 10_000
export const AUTH_TIMEOUT_MS = 10_000
/** Application heartbeat answered by the Room itself; ws pings are answered by the edge and prove less. */
export const HEARTBEAT_INTERVAL_MS = 15_000
export const HEARTBEAT_TIMEOUT_MS = 10_000
export const HEARTBEAT_MAX_MISSES = 2
/** The bridge dials its own relay URL as a phone would and expects the open to reach the host link. */
export const SELFTEST_INTERVAL_MS = 5 * 60_000
export const SELFTEST_TIMEOUT_MS = 5000

const WS_OPEN = 1
const WS_CLOSED = 3

/** What VirtualSocket needs from the host link. */
interface HostLink {
  readonly open: boolean
  readonly bufferedAmount: number
  sendFrame(frame: Uint8Array): void
  release(connId: number, sock: VirtualSocket): void
}

export class VirtualSocket extends EventEmitter implements DeviceSocket {
  readonly maxFrameBytes = MAX_PAYLOAD_BYTES
  private _state: 1 | 3 = WS_OPEN

  constructor(
    readonly connId: number,
    private readonly link: HostLink,
  ) {
    super()
    // An 'error' with no listener would throw out of EventEmitter.
    this.on('error', () => {})
  }

  get readyState(): number {
    return this._state
  }

  /** The host socket's backlog, so DeviceConnection's pacing sees the real queue. */
  get bufferedAmount(): number {
    return this.link.bufferedAmount
  }

  send(data: string | Buffer): void {
    if (this._state !== WS_OPEN) throw new Error('virtual socket is closed')
    if (!this.link.open) throw new Error('relay link is down')
    const isText = typeof data === 'string'
    const bytes = isText ? Buffer.byteLength(data) : data.length
    if (bytes > MAX_PAYLOAD_BYTES) {
      // The room would close the whole host socket with 1009 and drop every device.
      // Fail only this connection instead.
      this.close(RELAY_CLOSE.tooBig, 'frame too large')
      throw new Error(`frame of ${bytes} bytes exceeds the relay limit of ${MAX_PAYLOAD_BYTES}`)
    }
    this.link.sendFrame(isText ? encodeMuxText(this.connId, data) : encodeMux(MuxKind.binary, this.connId, data))
  }

  close(code = 1000, reason = ''): void {
    if (this._state === WS_CLOSED) return
    this._state = WS_CLOSED
    this.link.release(this.connId, this)
    if (this.link.open) {
      try {
        this.link.sendFrame(encodeMuxClose(this.connId, code, reason))
      } catch {
        // Link died under us; the host disconnect path cleans up.
      }
    }
    this.emit('close', code, reason)
  }

  /** The relay told us the device went away (or the host link dropped). No mux close goes back. */
  remoteClosed(code: number, reason: string): void {
    if (this._state === WS_CLOSED) return
    this._state = WS_CLOSED
    this.emit('close', code, reason)
  }

  deliver(data: Buffer, isBinary: boolean): void {
    if (this._state === WS_OPEN) this.emit('message', data, isBinary)
  }
}

export interface RelayClientOptions {
  url: string
  signingKey: SigningKeyPair
  log: (msg: string) => void
  onDeviceSocket: (sock: VirtualSocket, remoteLabel: string) => void
  /** Test seams. */
  random?: () => number
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  /** False disables the periodic and post-connect self-test. */
  selfTest?: boolean
  selfTestIntervalMs?: number
  selfTestTimeoutMs?: number
  createSocket?: (url: string) => WebSocket
}

export declare interface RelayClient {
  on(event: 'state', listener: (state: RelayState) => void): this
  on(event: 'selftest', listener: (ok: boolean) => void): this
}

export class RelayClient extends EventEmitter {
  state: RelayState = 'offline'
  readonly relayId: string
  private readonly hostUrl: string
  private ws: WebSocket | null = null
  private sockets = new Map<number, VirtualSocket>()
  private attempt = 0
  private stopped = true
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private authTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private hbTimer: NodeJS.Timeout | null = null
  private hbDeadline: NodeJS.Timeout | null = null
  private hbMisses = 0
  private selfTestTimer: NodeJS.Timeout | null = null
  private pendingSelfTest: { n: string; probe: WebSocket | null; timer: NodeJS.Timeout; ws: WebSocket } | null = null
  /** Counters, for tests and diagnostics. */
  selfTestsPassed = 0
  opensReceived = 0
  private authed = false
  /** Random per process; its hash is always in the set sent to the relay so the self-test can get in. */
  private readonly selfTestToken = newRelayToken()
  private access: RelayAccess = { tokens: [], tickets: [], enforce: false }
  private lastSent = ''
  /** Set by a close code that wants a long wait before the next try. */
  private slowRetry = false

  constructor(private readonly opts: RelayClientOptions) {
    super()
    this.relayId = relayIdFromPublicKey(opts.signingKey.publicKey)
    this.hostUrl = relayHostUrl({ u: opts.url, i: this.relayId })
  }

  get connectedDevices(): number {
    return this.sockets.size
  }

  /**
   * Replace the relay's access set (full replacement). Sent now if the link is authenticated, and again after
   * every reconnect. Call whenever devices or pairing tickets change; identical sets are not re-sent.
   */
  setAccess(access: RelayAccess): void {
    this.access = access
    if (this.authed && this.ws) this.sendAccess(this.ws)
  }

  private sendAccess(ws: WebSocket, force = false): void {
    const frame = JSON.stringify({
      t: 'tokens',
      set: [...new Set([relayTokenHash(this.selfTestToken), ...this.access.tokens])],
      tickets: this.access.tickets,
      enforce: this.access.enforce,
    })
    if (!force && frame === this.lastSent) return
    try {
      ws.send(frame)
      this.lastSent = frame
    } catch {
      // The link is dying; the reconnect resends.
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    this.closeAllSockets(1001, 'bridge shutting down')
    if (ws) {
      ws.removeAllListeners()
      ws.on('error', () => {})
      try {
        ws.close(1000, 'bridge stopping')
      } catch {
        ws.terminate()
      }
    }
    this.setState('offline')
  }

  private setState(s: RelayState): void {
    if (this.state === s) return
    this.state = s
    this.emit('state', s)
  }

  private clearTimers(): void {
    for (const t of [this.reconnectTimer, this.pingTimer, this.pongTimer, this.authTimer, this.stableTimer, this.hbTimer, this.hbDeadline, this.selfTestTimer]) {
      if (t) {
        clearTimeout(t)
        clearInterval(t)
      }
    }
    this.reconnectTimer = this.pingTimer = this.pongTimer = this.authTimer = this.stableTimer = null
    this.hbTimer = this.hbDeadline = this.selfTestTimer = null
    this.hbMisses = 0
    this.abortSelfTest()
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return
    this.setState('connecting')
    this.authed = false
    let ws: WebSocket
    try {
      ws = this.opts.createSocket ? this.opts.createSocket(this.hostUrl) : new WebSocket(this.hostUrl, { handshakeTimeout: 10_000, maxPayload: 4 * RELAY_MAX_FRAME_BYTES })
    } catch (err) {
      this.opts.log(`relay: could not open socket: ${(err as Error).message}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    this.authTimer = setTimeout(() => {
      this.opts.log('relay: no auth answer from the relay in time, retrying')
      ws.terminate()
    }, AUTH_TIMEOUT_MS)

    ws.on('message', (raw: Buffer, isBinary: boolean) => this.onMessage(ws, raw, isBinary))
    ws.on('pong', () => {
      if (this.pongTimer) clearTimeout(this.pongTimer)
      this.pongTimer = null
    })
    ws.on('error', (err: Error) => {
      // 'close' follows; only log so a down relay is not silent.
      this.opts.log(`relay: socket error: ${err.message}`)
    })
    ws.on('close', (code: number, reason: Buffer) => this.onClose(ws, code, reason.toString()))
  }

  private onMessage(ws: WebSocket, raw: Buffer, isBinary: boolean): void {
    if (ws !== this.ws) return
    if (!isBinary) {
      let frame: { t?: string; n?: string } | null = null
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (frame?.t === 'hb_ack') {
        // The Room answered from inside the Durable Object: the path to it is alive.
        if (this.hbDeadline) clearTimeout(this.hbDeadline)
        this.hbDeadline = null
        this.hbMisses = 0
        return
      }
      if (frame?.t === 'challenge' && typeof frame.n === 'string' && !this.authed) {
        ws.send(JSON.stringify({ t: 'auth', ...signChallenge(this.opts.signingKey, this.relayId, frame.n) }))
      } else if (frame?.t === 'ok' && !this.authed) {
        this.onAuthed(ws)
      }
      return
    }
    if (!this.authed) return
    const frame = decodeMux(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    if (!frame) {
      this.opts.log('relay: dropped an undecodable mux frame')
      return
    }
    switch (frame.kind) {
      case MuxKind.open: {
        this.opensReceived++
        const stale = this.sockets.get(frame.connId)
        if (stale) {
          this.sockets.delete(frame.connId)
          stale.remoteClosed(1000, 'connId reused')
        }
        const sock = new VirtualSocket(frame.connId, this.link(ws))
        this.sockets.set(frame.connId, sock)
        try {
          this.opts.onDeviceSocket(sock, 'relay')
        } catch (err) {
          this.opts.log(`relay: device handler failed: ${(err as Error).message}`)
          sock.close(1011, 'internal error')
        }
        return
      }
      case MuxKind.text:
      case MuxKind.binary:
        this.sockets
          .get(frame.connId)
          ?.deliver(Buffer.from(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength), frame.kind === MuxKind.binary)
        return
      case MuxKind.close: {
        const sock = this.sockets.get(frame.connId)
        if (!sock) return
        this.sockets.delete(frame.connId)
        const { code, reason } = decodeMuxClose(frame.payload)
        sock.remoteClosed(code, reason)
        return
      }
    }
  }

  private onAuthed(ws: WebSocket): void {
    if (this.authTimer) clearTimeout(this.authTimer)
    this.authTimer = null
    this.authed = true
    this.slowRetry = false
    // Before anything else: a device that arrives during startup must be judged against the current set.
    this.sendAccess(ws, true)
    this.opts.log(`relay: online as ${this.relayId}`)
    this.setState('online')
    // Backoff resets only once the link has proven stable, so a relay that accepts
    // us and then drops us at once cannot turn into a fast retry loop.
    this.stableTimer = setTimeout(() => {
      this.attempt = 0
    }, STABLE_MS)
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WS_OPEN) return
      this.pongTimer ??= setTimeout(() => {
        this.opts.log('relay: no pong, dropping the link')
        ws.terminate()
      }, PONG_TIMEOUT_MS)
      try {
        ws.ping()
      } catch {
        ws.terminate()
      }
    }, PING_INTERVAL_MS)
    this.startHeartbeat(ws)
    if (this.opts.selfTest !== false) {
      // Right after every (re)connect, then periodically.
      this.scheduleSelfTest(ws, 0)
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    const interval = this.opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    const timeout = this.opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
    const beat = (): void => {
      if (ws !== this.ws || ws.readyState !== WS_OPEN) return
      // An unanswered beat is already being timed; do not stack deadlines.
      if (!this.hbDeadline) {
        this.hbDeadline = setTimeout(() => {
          this.hbDeadline = null
          this.hbMisses++
          if (this.hbMisses >= HEARTBEAT_MAX_MISSES) {
            this.opts.log(`relay: heartbeat missed ${this.hbMisses} times, the room is not answering; dropping the link and reconnecting`)
            ws.terminate()
          }
        }, timeout)
      }
      try {
        ws.send(RELAY_HB_REQUEST)
      } catch {
        ws.terminate()
      }
    }
    beat()
    this.hbTimer = setInterval(beat, interval)
  }

  // -------------------------------------------------------------------------
  // Self-test: dial our own device URL and make sure the room's open reaches us
  // -------------------------------------------------------------------------

  private scheduleSelfTest(ws: WebSocket, delay: number): void {
    if (this.selfTestTimer) clearTimeout(this.selfTestTimer)
    this.selfTestTimer = setTimeout(() => {
      this.selfTestTimer = null
      if (ws !== this.ws) return
      this.runSelfTest(ws)
      this.scheduleSelfTest(ws, this.opts.selfTestIntervalMs ?? SELFTEST_INTERVAL_MS)
    }, delay)
  }

  private runSelfTest(ws: WebSocket): void {
    if (this.pendingSelfTest || ws.readyState !== WS_OPEN) return
    const n = Math.random().toString(36).slice(2) + Date.now().toString(36)
    const timeoutMs = this.opts.selfTestTimeoutMs ?? SELFTEST_TIMEOUT_MS
    const started = Date.now()
    let probe: WebSocket | null = null
    const fail = (why: string): void => {
      this.abortSelfTest()
      if (ws !== this.ws) return
      this.opts.log(`relay self-test failed: ${why} (after ${Date.now() - started}ms); reconnecting the host link`)
      ws.terminate()
    }
    const timer = setTimeout(() => fail('the room never delivered our probe to the host link'), timeoutMs)
    this.pendingSelfTest = { n, probe: null, timer, ws }
    try {
      const url = relayDeviceUrl({ u: this.opts.url, i: this.relayId })
      probe = this.opts.createSocket ? this.opts.createSocket(url) : new WebSocket(url, { handshakeTimeout: timeoutMs })
    } catch (err) {
      return fail(`could not open probe: ${(err as Error).message}`)
    }
    this.pendingSelfTest.probe = probe
    probe.on('open', () => {
      try {
        // Present the dedicated self-test token like any phone would, then the probe.
        probe!.send(relayAuthFrame(this.selfTestToken))
        probe!.send(JSON.stringify({ t: 'selftest', n }))
      } catch {
        // The timer reports it.
      }
    })
    probe.on('error', () => {})
    probe.on('close', (code: number, reason: Buffer) => {
      if (this.pendingSelfTest?.n !== n) return
      const why = `probe closed by the relay (${code}${reason.length ? ` ${reason.toString()}` : ''})`
      if (code === RELAY_CLOSE.hostOffline) {
        // The room has no live host link for us: a genuine delivery failure.
        this.abortSelfTest()
        this.emit('selftest', false)
        fail(why)
        return
      }
      // Any other close says nothing about whether the room delivers opens. 4400 is our own routing (the open
      // DID reach us); 4401/4429 are the room's access or rate rules. Reconnecting the host link would not
      // help and would only drop every phone, so note it and let the next interval try again.
      this.abortSelfTest()
      this.opts.log(`relay self-test inconclusive: ${why}; link kept, will retry`)
    })
  }

  private abortSelfTest(): void {
    const p = this.pendingSelfTest
    if (!p) return
    this.pendingSelfTest = null
    clearTimeout(p.timer)
    if (p.probe) {
      p.probe.removeAllListeners('close')
      try {
        p.probe.terminate()
      } catch {
        // Already gone.
      }
    }
  }

  /** The bridge saw a device socket whose first frame is our own probe. True if it was ours. */
  confirmSelfTest(n: unknown): boolean {
    const p = this.pendingSelfTest
    if (!p || typeof n !== 'string' || p.n !== n) return false
    this.selfTestsPassed++
    this.abortSelfTest()
    this.emit('selftest', true)
    return true
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return
    this.ws = null
    this.clearTimers()
    this.closeAllSockets(RELAY_CLOSE.hostOffline, 'relay link lost')
    this.setState('offline')
    if (this.stopped) return

    if (code === RELAY_CLOSE.replaced) {
      this.opts.log(
        'relay: WARNING another bridge is connected to the relay with this same signing key and replaced this one. ' +
          'Is the bridge running twice, or is the key copied to another machine? Backing off.',
      )
      this.slowRetry = true
    } else if (code === RELAY_CLOSE.unauthorized) {
      this.opts.log(`relay: ERROR the relay refused our signature (${reason || 'unauthorized'}). Will keep retrying slowly.`)
      this.slowRetry = true
    } else {
      this.opts.log(`relay: link closed (${code}${reason ? ` ${reason}` : ''})`)
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const rnd = this.opts.random ?? Math.random
    const ceiling = this.slowRetry ? BACKOFF_CAP_MS : Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 16)
    // Half fixed, half random: never a tight loop, never a synchronised herd.
    const delay = Math.round(ceiling * (0.5 + 0.5 * rnd()))
    this.opts.log(`relay: reconnecting in ${(delay / 1000).toFixed(1)}s`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private closeAllSockets(code: number, reason: string): void {
    const all = [...this.sockets.values()]
    this.sockets.clear()
    for (const s of all) s.remoteClosed(code, reason)
  }

  private link(ws: WebSocket): HostLink {
    return {
      get open() {
        return ws.readyState === WS_OPEN
      },
      get bufferedAmount() {
        return ws.bufferedAmount
      },
      sendFrame: (frame) => ws.send(frame),
      release: (connId, sock) => {
        if (this.sockets.get(connId) === sock) this.sockets.delete(connId)
      },
    }
  }
}
