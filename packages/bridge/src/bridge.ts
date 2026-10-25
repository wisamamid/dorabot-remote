import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import type { Socket } from 'node:net'
import {
  NEVER_FORWARD_EVENTS,
  PROTOCOL_VERSION,
  SCOPES,
  SCOPE_DEFAULTS,
  encodePairingPayload,
  fingerprint,
  fromB64,
  deriveRelayToken,
  isRelayUrlConfigured,
  isValidScope,
  newRelayToken,
  relayTokenHash,
  relayIdFromPublicKey,
  openSealedJson,
  sealJson,
  sodiumReady,
  toB64,
} from '@dorabot-remote/protocol'
import type {
  DeviceSummary,
  HostSummary,
  KeyPair,
  PairingPayload,
  PairingRequest,
  PairingResponse,
  RelayInfo,
  Scope,
  SessionSnapshot,
  Sodium,
  StatusUpdate,
} from '@dorabot-remote/protocol'
import QRCode from 'qrcode'
import { WebSocketServer } from 'ws'
import { candidateAddresses } from './addresses.js'
import { createRootsStore, rootsFilePath, type RootsStore } from './roots.js'
import {
  BRIDGE_VERSION,
  type BridgePaths,
  type BridgeSettings,
  loadIdentity,
  loadSigningKey,
  readDorabotVersion,
  readGatewayToken,
} from './config.js'
import { DeviceConnection, type ConnectionHost } from './connection.js'
import type { DeviceSocket } from './device-socket.js'
import { PushNotifier, PUSH_TOKEN_RE } from './push.js'
import { parsePushKey } from './push-content.js'
import { RelayClient, type RelayState } from './relay-client.js'

// [SEC-RELAY] Relay access control. See docs on enforcement in syncRelayAccess().
const RELAY_ACKED_KEY = 'relay.tokensAcked'
const RELAY_ENFORCE_KEY = 'relay.enforce'
const RELAY_SINCE_KEY = 'relay.accessSince'
/** Enforcement turns on at the latest this long after the first start with tokens, even if an old phone never reconnected. */
export const RELAY_ENFORCE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
import { CONTROL_PAGE } from './control-page.js'
import { CompatChecker } from './compat-check.js'
import { GatewayClient } from './gateway-client.js'
import { HealthAlerts } from './health-alerts.js'
import { applyEventToSnapshots } from './snapshot-state.js'
import { MAX_RULES, describeRule, findMatchingRule, parseNewRule } from './rules.js'
import { Store, type AuditEntry, type DeviceRecord } from './store.js'
import { isControlAuthorized, loadControlSecret, sessionSetCookie } from './control-auth.js'

const SESSION_KEY_RE = /^[^:\s]+:[^:\s]+:\S+$/
const MAX_PINS = 200

/** Push treats a device as connected only if it sent a frame this recently. */
export const LIVE_WINDOW_MS = 45_000
/** Connections silent this long are closed. */
export const IDLE_CLOSE_MS = 90_000
const IDLE_SWEEP_MS = 15_000
const GATEWAY_CURSOR_KEY = 'gateway.lastSeqBySession'

/** A phone that paired but was not approved on the Mac within this long is dropped. */
export const PENDING_TTL_MS = 10 * 60 * 1000
/** Devices unseen this long are revoked automatically. */
export const DEVICE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000
const PENDING_SWEEP_MS = 30_000
const EXPIRY_SWEEP_MS = 24 * 60 * 60 * 1000

/** Socket limits (M3). */
export const MAX_WS_PAYLOAD = 1024 * 1024
export const PRE_AUTH_MAX_FRAME = 8 * 1024
export const MAX_UNAUTH_TOTAL = 20
export const MAX_UNAUTH_PER_IP = 5
const UNAUTH_SLOT_MS = 16_000
/** The only browser-style Origin a native client may send (Capacitor's WKWebView). */
export const ALLOWED_WS_ORIGIN = 'capacitor://localhost'

const GIT_WRITE_RE = /^git\.(stage|unstage|commit|fetch|pull|push|checkout)/
const AUDITED_METHODS = new Set([
  'tool.approve',
  'tool.deny',
  'chat.answerQuestion',
  'shell.spawn',
  'sessions.rename',
  'sessions.setModel',
  'agent.setModel',
])

function cleanName(raw: unknown, fallback: string): string {
  // The phone chooses this string; it ends up in the approval prompt and a notification.
  const n = String(raw ?? '').replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 64)
  return n || fallback
}

function defaultNotify(title: string, body: string): void {
  if (process.platform !== 'darwin' || process.env.VITEST || process.env.NODE_ENV === 'test') return
  // Arguments, never string interpolation: the body contains a device-chosen name.
  execFile(
    'osascript',
    ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body],
    () => {},
  )
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface BridgeOptions {
  paths: BridgePaths
  settings: BridgeSettings
  log?: (msg: string) => void
  /** Desktop notification hook (pending pairing). Defaults to osascript on macOS. */
  notify?: (title: string, body: string) => void
}

export class Bridge implements ConnectionHost {
  sodium!: Sodium
  hostIdentity!: KeyPair
  hostSummary!: HostSummary

  readonly store: Store
  readonly settings: BridgeSettings
  private readonly paths: BridgePaths
  /** Folders shared with phones (empty until the user adds some). Use for the control page / CLI. */
  readonly roots: RootsStore
  private gateway!: GatewayClient
  private http: HttpServer | null = null
  private wss: WebSocketServer | null = null
  private connections = new Set<DeviceConnection>()
  private snapshots = new Map<string, SessionSnapshot>()
  private sessionKeys = new Set<string>()
  private gatewayCursor: Record<string, number> = {}
  private pruneTimer: NodeJS.Timeout | null = null
  private deviceTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private relay: RelayClient | null = null
  private relayInfo: RelayInfo | null = null
  /** [SEC-RELAY] Secret the per-device relay tokens are derived from (HMAC), itself derived from the host signing key. */
  private relaySecret: Uint8Array | null = null
  /** [SEC-RELAY] Live single-use pairing tickets by pairing code. */
  private relayTickets = new Map<string, { tok: string; exp: number }>()
  private pusher: PushNotifier | null = null
  private healthAlerts: HealthAlerts | null = null
  private compatChecker: CompatChecker | null = null
  readonly logLines: string[] = []
  private controlSecret = ''
  private pendingTimer: NodeJS.Timeout | null = null
  private expiryTimer: NodeJS.Timeout | null = null
  private readonly notify: (title: string, body: string) => void
  private readonly transports = new WeakMap<DeviceConnection, 'relay' | 'direct'>()
  private unauthTotal = 0
  private unauthByIp = new Map<string, number>()

  /** Append-only audit log. connection.ts calls auditRpc; other code may record directly. */
  readonly auditLog = {
    record: (e: AuditEntry): void => {
      try {
        this.store.recordAudit(e)
      } catch (err) {
        this.log(`audit write failed: ${(err as Error).message}`)
      }
    },
  }

  constructor(opts: BridgeOptions) {
    this.notify = opts.notify ?? defaultNotify
    this.paths = opts.paths
    this.settings = opts.settings
    this.store = new Store(opts.paths.db)
    this.roots = createRootsStore(() => rootsFilePath(this.paths.root), { protectedPaths: () => this.protectedPaths() })
    if (opts.log) this.externalLog = opts.log
  }

  private externalLog: ((msg: string) => void) | null = null

  log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`
    this.logLines.push(line)
    if (this.logLines.length > 500) this.logLines.shift()
    if (this.externalLog) this.externalLog(msg)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.controlSecret = loadControlSecret(this.paths.root)
    this.sodium = await sodiumReady()
    this.hostIdentity = loadIdentity(this.sodium, this.paths)
    if (this.settings.relay.enabled && isRelayUrlConfigured(this.settings.relay.url)) {
      const key = loadSigningKey(this.paths)
      this.relayInfo = { u: this.settings.relay.url.replace(/\/+$/, ''), i: relayIdFromPublicKey(key.publicKey) }
      this.relaySecret = new Uint8Array(createHash('sha256').update('dorabot-relay-token-secret/v1').update(key.privateKey).digest())
      this.pusher = new PushNotifier({
        store: this.store,
        relay: { url: this.relayInfo.u, id: this.relayInfo.i },
        signingKey: key,
        host: { id: this.settings.hostId, name: this.settings.hostName },
        isConnected: (id) => this.isDeviceLive(id),
        log: (m) => this.log(m),
      })
      this.relay = new RelayClient({
        url: this.relayInfo.u,
        signingKey: key,
        log: (m) => this.log(m),
        onDeviceSocket: (sock, label) => this.routeRelaySocket(sock, label),
      })
    }
    const dorabotVersion = readDorabotVersion(this.paths)
    this.hostSummary = {
      id: this.settings.hostId,
      name: this.settings.hostName,
      fingerprint: fingerprint(this.sodium, this.hostIdentity.publicKey),
      version: BRIDGE_VERSION,
      dorabotVersion,
      ...(this.relayInfo ? { relay: this.relayInfo } : {}),
    }
    this.gatewayCursor = this.store.getMeta<Record<string, number>>(GATEWAY_CURSOR_KEY, {})

    // Initialize health alerts and compat checker.
    if (this.relay) {
      this.healthAlerts = new HealthAlerts({
        notify: this.notify,
        log: (m) => this.log(m),
        pusher: this.pusher ?? undefined,
      })
    }
    this.compatChecker = new CompatChecker({
      log: (m) => this.log(m),
      notify: this.notify,
    })

    this.gateway = new GatewayClient({
      socketPath: this.paths.gatewaySocket,
      token: readGatewayToken(this.paths),
      log: (m) => this.log(m),
    })
    this.gateway.on('ready', () => void this.onGatewayReady())
    this.gateway.on('state', (s) => this.broadcastBridgeEvent('remote.gateway_state', { state: s }))
    this.gateway.on('event', (name, data, seq) => this.onGatewayEvent(name, data, seq))
    this.gateway.start()

    await this.listen()
    if (this.relay) {
      this.relay.on('state', (s) => {
        this.broadcastBridgeEvent('remote.relay_state', { state: s })
        // Update health alerts on relay state changes.
        if (this.healthAlerts) this.healthAlerts.update({ relayState: s })
      })
      this.relay.on('selftest', (ok) => {
        // Wire self-test results to health alerts (only genuine failures, not inconclusive).
        if (this.healthAlerts) this.healthAlerts.update({ selfTest: ok })
      })
      this.syncRelayAccess()
      this.relay.start()
    }

    // Start health alerts timer.
    if (this.healthAlerts) this.healthAlerts.start()

    // The CLI revokes and grants from another process, straight into the DB.
    this.deviceTimer = setInterval(() => {
      for (const c of [...this.connections]) c.recheckDevice()
      // Also picks up CLI revocations, which write straight into the DB.
      this.syncRelayAccess()
    }, 5000)

    this.idleTimer = setInterval(() => this.sweepIdle(), IDLE_SWEEP_MS)

    this.sweepPending()
    this.sweepExpiredDevices()
    this.pendingTimer = setInterval(() => this.sweepPending(), PENDING_SWEEP_MS)
    this.expiryTimer = setInterval(() => this.sweepExpiredDevices(), EXPIRY_SWEEP_MS)

    this.pruneTimer = setInterval(
      () => {
        this.store.purgeExpiredPairings()
        const removed = this.store.pruneEvents(this.settings.eventRetentionMs)
        if (removed > 0) this.log(`pruned ${removed} stored events`)
      },
      60 * 60 * 1000,
    )
  }

  async stop(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    if (this.deviceTimer) clearInterval(this.deviceTimer)
    if (this.idleTimer) clearInterval(this.idleTimer)
    if (this.pendingTimer) clearInterval(this.pendingTimer)
    if (this.expiryTimer) clearInterval(this.expiryTimer)
    for (const c of this.connections) c.close('bridge shutting down')
    this.healthAlerts?.stop()
    this.relay?.stop()
    this.gateway?.stop()
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve()
      this.http.close(() => resolve())
      // Sockets held open by idle keep-alive should not delay shutdown.
      this.http.closeAllConnections?.()
    })
    this.store.close()
  }

  /**
   * A phone counts as connected only if it has spoken recently. iOS suspends a
   * backgrounded app but its socket often stays open for a long time; the phone
   * pings every 20s while running, so silence means it is not looking.
   */
  isDeviceLive(deviceId: string, now = Date.now()): boolean {
    return [...this.connections].some((c) => c.device?.id === deviceId && c.isAuthed && now - c.lastInboundAt < LIVE_WINDOW_MS)
  }

  /** Drop connections that have been silent too long so dead sockets do not pile up. */
  sweepIdle(now = Date.now()): number {
    let closed = 0
    for (const c of [...this.connections]) {
      if (now - c.lastInboundAt < IDLE_CLOSE_MS) continue
      this.log(`closing idle connection${c.device ? ` for "${c.device.name}"` : ''} (no traffic for ${Math.round((now - c.lastInboundAt) / 1000)}s)`)
      c.close('idle')
      closed++
    }
    return closed
  }

  /** Drop pending pairings nobody approved in time. */
  sweepPending(now = Date.now()): number {
    const gone = this.store.expirePending(PENDING_TTL_MS, now)
    for (const d of gone) {
      this.log(`pairing for "${d.name}" was not approved within ${PENDING_TTL_MS / 60000} minutes; rejected`)
      this.auditLog.record({ deviceId: d.id, deviceName: d.name, action: 'reject', summary: 'auto-rejected: not approved in time', transport: 'mac' })
      for (const c of this.connections) if (c.device?.id === d.id) c.close('removed')
    }
    return gone.length
  }

  /** Revoke devices unseen for 90 days. */
  sweepExpiredDevices(now = Date.now()): number {
    const gone = this.store.expireStaleDevices(DEVICE_EXPIRY_MS, now)
    for (const d of gone) {
      this.log(`device "${d.name}" unseen for ${DEVICE_EXPIRY_MS / 86_400_000} days; revoked automatically`)
      this.auditLog.record({ deviceId: d.id, deviceName: d.name, action: 'revoke', summary: 'expired: unseen for 90 days', transport: 'mac' })
      for (const c of this.connections) if (c.device?.id === d.id) c.close('revoked')
    }
    return gone.length
  }

  private acquireUnauthSlot(ip: string): { release: () => void; readonly done: boolean } | null {
    if (this.unauthTotal >= MAX_UNAUTH_TOTAL || (this.unauthByIp.get(ip) ?? 0) >= MAX_UNAUTH_PER_IP) return null
    this.unauthTotal++
    this.unauthByIp.set(ip, (this.unauthByIp.get(ip) ?? 0) + 1)
    let done = false
    const hard = setTimeout(() => release(), UNAUTH_SLOT_MS)
    hard.unref?.()
    const release = (): void => {
      if (done) return
      done = true
      clearTimeout(hard)
      this.unauthTotal--
      const n = (this.unauthByIp.get(ip) ?? 1) - 1
      if (n <= 0) this.unauthByIp.delete(ip)
      else this.unauthByIp.set(ip, n)
    }
    return {
      release,
      get done() {
        return done
      },
    }
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => this.onHttpRequest(req, res))
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD })

      http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
        const refuse = (code: number, text: string): void => {
          socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
          socket.destroy()
        }
        const path = (req.url ?? '/').split('?')[0]
        if (path !== '/connect' && path !== '/pair') {
          socket.destroy()
          return
        }
        // Native clients and the relay send no Origin. A browser page does, and must
        // never be able to open these sockets (the one exception is Capacitor's webview).
        const origin = req.headers.origin
        if (origin !== undefined && origin !== ALLOWED_WS_ORIGIN) {
          this.log(`refused ${path} upgrade with browser origin`)
          refuse(403, 'Forbidden')
          return
        }
        const remote = req.socket.remoteAddress ?? 'unknown'
        const slot = this.acquireUnauthSlot(remote)
        if (!slot) {
          this.log(`refused ${path} upgrade from ${remote}: too many unauthenticated sockets`)
          refuse(503, 'Service Unavailable')
          return
        }
        socket.on('close', slot.release)
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on('close', slot.release)
          if (path === '/pair') this.onPairSocket(ws, remote, 'direct')
          else {
            const conn = this.onDeviceSocket(ws, remote, 'direct')
            // A device socket stops counting against the cap once it authenticates.
            const poll = setInterval(() => {
              if (slot.done) clearInterval(poll)
              else if (conn.isAuthed) {
                slot.release()
                clearInterval(poll)
              }
            }, 200)
            poll.unref?.()
            ws.on('close', () => clearInterval(poll))
          }
        })
      })

      http.on('error', reject)
      http.listen(this.settings.port, this.settings.bind, () => {
        this.http = http
        this.wss = wss
        this.log(`listening on ${this.settings.bind}:${this.settings.port}`)
        resolve()
      })
    })
  }

  // -------------------------------------------------------------------------
  // Gateway plumbing
  // -------------------------------------------------------------------------

  private async onGatewayReady(): Promise<void> {
    try {
      const status = (await this.gateway.rpc('status')) as StatusUpdate
      this.absorbStatus(status)
      await this.subscribeToAllSessions()
      // Check dorabot compatibility.
      if (this.compatChecker) {
        await this.compatChecker.check({
          dorabotVersion: this.hostSummary.dorabotVersion,
          callGateway: (m, p) => this.gateway.rpc(m, p),
        })
      }
    } catch (err) {
      this.log(`failed to prime gateway state: ${(err as Error).message}`)
    }
  }

  private absorbStatus(status: StatusUpdate | undefined): void {
    for (const s of status?.sessions ?? []) {
      if (s.key) this.sessionKeys.add(s.key)
    }
  }

  /**
   * Subscribe upstream to every session, so the durable log is complete regardless
   * of what any phone happens to be looking at. Devices then subscribe against the
   * bridge rather than the gateway.
   *
   * Two things make this delicate. The gateway's replay loop is synchronous and
   * does not check backpressure, but its live broadcast path does and closes any
   * client over 2 MiB buffered with code 4101. Asking for a large replay therefore
   * gets you disconnected by the very data you asked for. And on a first run there
   * is nothing worth replaying anyway: the bridge's own log starts empty and cold
   * history comes from chat.history, which is paginated and safe.
   *
   * So: subscribe one session at a time, and on first sight of a session start
   * from "now" rather than from the beginning.
   */
  private async subscribeToAllSessions(): Promise<void> {
    const keys = [...this.sessionKeys]
    if (keys.length === 0) return
    let replayed = 0
    for (const key of keys) {
      try {
        replayed += await this.subscribeToSession(key)
      } catch (err) {
        this.log(`could not subscribe to ${key}: ${(err as Error).message}`)
      }
    }
    this.log(`subscribed to ${keys.length} session(s), replayed ${replayed}`)
  }

  private async subscribeToSession(key: string): Promise<number> {
    // The gateway's cursor rule is lastSeqBySession > checkpoint > lastSeq, and it
    // only honours a per-session value when it is finite and > 0. A value past the
    // end of the log therefore means "give me nothing, just subscribe".
    const cursor = this.gatewayCursor[key] ?? Number.MAX_SAFE_INTEGER
    const res = (await this.gateway.rpc('sessions.subscribe', {
      sessionKeys: [key],
      lastSeqBySession: { [key]: cursor },
      lastSeq: 0,
      limit: 500,
    })) as { replayCount?: number }
    // Let the socket drain before asking for the next session's backlog.
    await new Promise((r) => setTimeout(r, 50))
    return res?.replayCount ?? 0
  }

  private onGatewayEvent(name: string, data: unknown, seq?: number): void {
    const d = (data ?? {}) as Record<string, unknown>

    // `agent.stream_batch` wraps N complete frames ({ event, data, seq? }), each
    // with its own seq and session. Unwrap so every inner event is logged,
    // routed and cursor-tracked under what it actually is.
    if (name === 'agent.stream_batch') {
      const batch = Array.isArray(data) ? data : ((d.data as unknown[]) ?? [])
      for (const raw of batch as Record<string, unknown>[]) {
        const hasFrame = typeof raw.event === 'string'
        const innerName = hasFrame ? (raw.event as string) : 'agent.stream'
        const inner = hasFrame ? raw.data : (raw.data ?? raw)
        this.onGatewayEvent(innerName, inner, typeof raw.seq === 'number' ? raw.seq : undefined)
      }
      return
    }
    const sessionKey = typeof d.sessionKey === 'string' ? d.sessionKey : null

    // Terminal output is handled first and never reaches the generic fan-out.
    // The gateway broadcasts it to every authenticated client with no scoping of
    // any kind, so this is the single most important filter in the bridge.
    if (name === 'shell.data') {
      const shellId = typeof d.shellId === 'string' ? d.shellId : null
      if (shellId) {
        for (const c of this.connections) c.forwardShellData(shellId, d)
      }
      return
    }

    if (NEVER_FORWARD_EVENTS.has(name)) return

    if (name === 'agent.tool_approval' && this.tryAutoApprove(d, () => this.onGatewayEvent(name, data, seq))) return

    if (name === 'session.snapshot') {
      const snap = data as SessionSnapshot
      if (snap?.sessionKey) {
        this.snapshots.set(snap.sessionKey, snap)
        this.sessionKeys.add(snap.sessionKey)
      }
    }

    applyEventToSnapshots(this.snapshots, name, d)

    if (name === 'status.update') {
      this.absorbStatus(data as StatusUpdate)
    }

    if (name === 'session.update') {
      // Carries `id`, not `sessionKey`. A new session here means a new upstream
      // subscription is needed so its events reach the log.
      const channel = d.channel as string | undefined
      const chatType = d.chatType as string | undefined
      const chatId = d.chatId as string | undefined
      if (channel && chatType && chatId) {
        const key = `${channel}:${chatType}:${chatId}`
        if (!this.sessionKeys.has(key)) {
          this.sessionKeys.add(key)
          void this.subscribeToSession(key).catch(() => {})
        }
      }
    }

    // Track the upstream cursor so a bridge restart resumes rather than refetches.
    if (typeof seq === 'number' && sessionKey) {
      const prev = this.gatewayCursor[sessionKey] ?? 0
      if (seq > prev) {
        this.gatewayCursor[sessionKey] = seq
        this.store.setMeta(GATEWAY_CURSOR_KEY, this.gatewayCursor)
      }
    }

    let bridgeSeq: number | undefined
    if (sessionKey && this.shouldPersist(name)) {
      bridgeSeq = this.store.appendEvent(name, sessionKey, data)
    }

    for (const c of this.connections) c.forward(name, data, bridgeSeq, sessionKey)
    this.pusher?.onGatewayEvent(name, data)
  }

  /**
   * What goes in the durable log. Only session-scoped agent activity: that is what
   * a phone needs to reconstruct a conversation it was away from. Status pings,
   * channel chatter and config updates are live-only.
   */
  private shouldPersist(name: string): boolean {
    return name.startsWith('agent.') && name !== 'agent.status'
  }

  /** Tell every connected device the pin set changed. Pins are device-independent. */
  private broadcastPins(): void {
    this.broadcastBridgeEvent('remote.pins_changed', { pins: this.store.listPins() })
  }

  /** Best effort: forget pins for sessions the gateway no longer lists. Never prunes on an empty or failed listing. */
  private async prunePins(): Promise<void> {
    if (!this.gatewayConnected() || this.store.listPins().length === 0) return
    try {
      const list = (await this.gateway.rpc('sessions.list')) as Array<{ channel?: string; chatType?: string; chatId?: string }> | undefined
      if (!Array.isArray(list) || list.length === 0) return
      const keep = new Set<string>()
      for (const s of list) if (s.channel && s.chatType && s.chatId) keep.add(`${s.channel}:${s.chatType}:${s.chatId}`)
      if (keep.size > 0 && this.store.prunePins(keep) > 0) this.broadcastPins()
    } catch {
      // gateway hiccup: keep the pins
    }
  }

  private broadcastBridgeEvent(event: string, data: unknown): void {
    for (const c of this.connections) c.forward(event, data, undefined, null)
  }

  // -------------------------------------------------------------------------
  // ConnectionHost
  // -------------------------------------------------------------------------

  getDevice(id: string): DeviceRecord | null {
    const d = this.store.getDevice(id)
    // Defence in depth: whatever consumes a pending device sees no permissions at all.
    return d?.pending ? { ...d, scopes: [] } : d
  }

  /** Request ids whose auto-approve failed once: they are delivered to phones normally, never retried. */
  private readonly autoApproveFailed = new Set<string>()

  /**
   * "Always allow" rules. When the gateway asks for approval and a rule covers it (and the
   * input is not risky), approve it here with only {requestId}, audit it, and keep it off the
   * phones. Returns true when the event was taken; `deliver` re-runs it as a normal event if
   * the gateway refuses the approval.
   */
  private tryAutoApprove(d: Record<string, unknown>, deliver: () => void): boolean {
    const requestId = typeof d.requestId === 'string' ? d.requestId : ''
    if (!requestId || this.autoApproveFailed.has(requestId)) return false
    const rule = findMatchingRule(this.store.listRules(), d.toolName, d.input, typeof d.blockedPath === 'string' ? { blockedPath: d.blockedPath } : {})
    if (!rule) return false
    const tool = String(d.toolName).replace(/[\u0000-\u001f]/g, ' ').slice(0, 60)
    void this.gateway
      .rpc('tool.approve', { requestId })
      .then(() => {
        this.auditLog.record({ action: 'auto_approve', method: 'tool.approve', requestId, summary: `tool=${tool} rule=${rule.id}`, transport: 'rule' })
      })
      .catch((err: Error) => {
        this.log(`auto-approve of ${tool} failed (${err.message}); asking the phone instead`)
        this.autoApproveFailed.add(requestId)
        deliver()
      })
    return true
  }

  private broadcastRules(): void {
    this.broadcastBridgeEvent('remote.rules_changed', { rules: this.store.listRules() })
  }

  /**
   * Hook for connection.ts onRpc: records the security-relevant RPCs a device performs.
   * Never records prompt text or file contents; only method, ids and a short label.
   */
  auditRpc(conn: DeviceConnection, method: string, requestId: string | number | undefined, params: Record<string, unknown>): void {
    const isGitWrite = GIT_WRITE_RE.test(method)
    if (!AUDITED_METHODS.has(method) && !isGitWrite) return
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, 80) : null)
    const parts: string[] = []
    if (method === 'tool.approve' || method === 'tool.deny') {
      const tool = str(params.toolName) ?? str(params.tool)
      if (tool) parts.push(`tool=${tool}`)
      const rid = str(params.requestId)
      if (rid) parts.push(`approval=${rid}`)
    } else if (method === 'chat.answerQuestion') {
      const rid = str(params.requestId)
      if (rid) parts.push(`question=${rid}`)
    } else if (method.endsWith('setModel')) {
      const m = str(params.model)
      if (m) parts.push(`model=${m}`)
    } else if (isGitWrite) {
      const where = str(params.cwd) ?? str(params.path) ?? str(params.repo)
      if (where) parts.push(`repo=${where}`)
    }
    const key = str(params.sessionKey)
    if (key) parts.push(`session=${key}`)
    this.auditLog.record({
      deviceId: conn.device?.id ?? null,
      deviceName: conn.device?.name ?? null,
      action: 'rpc',
      method,
      requestId: requestId === undefined ? null : String(requestId).slice(0, 80),
      summary: parts.join(' ') || null,
      transport: this.transports.get(conn) ?? 'direct',
    })
  }

  pendingExpiresAt(device: DeviceRecord): number | undefined {
    return (device.pendingSince ?? device.createdAt) + PENDING_TTL_MS
  }

  touchDevice(id: string): void {
    this.store.touchDevice(id)
  }

  deviceSummary(device: DeviceRecord): DeviceSummary {
    return this.store.toSummary(device, fingerprint(null, fromB64(null, device.publicKey)))
  }

  currentSeq(): number {
    return this.store.currentSeq()
  }

  eventsSince(afterSeq: number, limit: number, sessionKeys?: string[]) {
    return this.store.eventsSince(afterSeq, limit, sessionKeys)
  }

  snapshotFor(sessionKey: string): unknown | null {
    return this.snapshots.get(sessionKey) ?? null
  }

  allowedRoots(): string[] {
    return this.roots.listRoots()
  }

  protectedPaths(): string[] {
    const p = this.paths
    return [p.root, p.db, p.identity, p.signingKey, p.settings, p.dorabotRoot, p.gatewayToken, p.gatewaySocket]
  }

  knownSessionKeys(): string[] {
    return [...this.sessionKeys]
  }

  gatewayConnected(): boolean {
    return this.gateway?.connected ?? false
  }

  async callGateway(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.gateway.rpc(method, params)
  }

  onClosed(conn: DeviceConnection): void {
    this.connections.delete(conn)
    // Leaving a device's shells alive after it drops would let the next connection
    // inherit them. Kill them instead; the gateway's 60s orphan grace does not
    // apply to us because we never reclaim by id.
    for (const shellId of conn.ownedShells) {
      void this.gateway.rpc('shell.kill', { shellId }).catch(() => {})
    }
    if (conn.device) this.log(`device disconnected: ${conn.device.name}`)
  }

  async handleBridgeMethod(
    conn: DeviceConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'remote.hello':
        return { host: conn.device ? this.hostSummaryFor(conn.device) : this.hostSummary, device: conn.device ? this.deviceSummary(conn.device) : null }

      case 'remote.relayTokAck':
        return { ok: conn.device ? this.relayTokAck(conn.device.id, params.tokHash) : false }

      case 'remote.health':
        return {
          gatewayConnected: this.gatewayConnected(),
          seq: this.currentSeq(),
          sessions: this.knownSessionKeys().length,
          devices: this.store.listDevices().length,
          uptimeMs: Math.round(process.uptime() * 1000),
        }

      case 'remote.devices': {
        this.requireScope(conn, 'admin')
        return this.store.listDevices().map((d) => this.deviceSummary(d))
      }

      case 'remote.revoke': {
        this.requireScope(conn, 'admin')
        const id = String(params.deviceId ?? '')
        const ok = this.store.setRevoked(id, true)
        this.auditLog.record({ deviceId: id, deviceName: this.store.getDevice(id)?.name ?? null, action: 'revoke', summary: `by device "${conn.device?.name}"`, transport: this.transports.get(conn) ?? 'direct' })
        for (const c of this.connections) {
          if (c.device?.id === id) c.close('revoked')
        }
        this.syncRelayAccess() // [SEC-RELAY] drop its relay token hash now
        return { revoked: ok }
      }

      case 'remote.rename': {
        // A device may always rename itself; renaming another needs admin.
        const id = String(params.deviceId ?? conn.device?.id ?? '')
        if (id !== conn.device?.id) this.requireScope(conn, 'admin')
        return { renamed: this.store.renameDevice(id, String(params.name ?? '').slice(0, 64)) }
      }

      case 'remote.requestScope': {
        if (!isValidScope(params.scope)) throw new Error('unknown permission')
        const scope = params.scope
        const reason = String(params.reason ?? '').slice(0, 200)
        if (!conn.device) throw new Error('not authenticated')
        if (conn.device.scopes.includes(scope)) return { alreadyGranted: true }
        const req = this.store.createScopeRequest(conn.device.id, scope, reason)
        this.auditLog.record({ deviceId: conn.device.id, deviceName: conn.device.name, action: 'scope_request', summary: `scope=${scope}`, transport: this.transports.get(conn) ?? 'direct' })
        this.log(
          `"${conn.device.name}" is asking for the "${scope}" permission. ` +
            `Approve at http://127.0.0.1:${this.settings.port}/ or run: dorabot-remote grant ${conn.device.id} ${scope}`,
        )
        return { requested: true, requestId: req.id }
      }

      case 'remote.scopeRequests': {
        this.requireScope(conn, 'admin')
        return this.store.listScopeRequests('pending')
      }

      case 'remote.registerPush': {
        const device = conn.device
        if (!device) throw new Error('not authenticated')
        const token = String(params.token ?? '')
        const platform = params.platform
        const env = params.env === 'sandbox' ? 'sandbox' : 'production'
        if (!PUSH_TOKEN_RE.test(token)) throw new Error('invalid push token')
        if (platform !== 'ios' && platform !== 'android') throw new Error('invalid push platform')
        if (params.env !== undefined && params.env !== 'production' && params.env !== 'sandbox') throw new Error('invalid push env')
        if (params.pushKey !== undefined && params.pushKey !== null && !parsePushKey(params.pushKey)) throw new Error('invalid push key')
        this.store.setPushToken(device.id, token, platform, env, params.pushKey ? String(params.pushKey) : null)
        this.log(`push registered for "${device.name}" (${platform}, ${env}${params.pushKey ? ', e2e content' : ''})`)
        return { registered: true, notifyOnResult: this.store.getDevice(device.id)?.pushOnResult ?? false }
      }

      case 'remote.unregisterPush': {
        const device = conn.device
        if (!device) throw new Error('not authenticated')
        this.store.setPushToken(device.id, null, null)
        this.log(`push unregistered for "${device.name}"`)
        return { unregistered: true }
      }

      case 'remote.setPushPrefs': {
        const device = conn.device
        if (!device) throw new Error('not authenticated')
        if (typeof params.notifyOnResult !== 'boolean') throw new Error('notifyOnResult must be a boolean')
        this.store.setPushOnResult(device.id, params.notifyOnResult)
        return { notifyOnResult: params.notifyOnResult }
      }

      case 'remote.pushPrefs': {
        const device = conn.device ? this.store.getDevice(conn.device.id) : null
        if (!device) throw new Error('not authenticated')
        return { registered: Boolean(device.pushToken), notifyOnResult: Boolean(device.pushOnResult) }
      }

      case 'remote.pins.list': {
        await this.prunePins()
        return this.store.listPins()
      }

      case 'remote.pins.set': {
        const id = String(params.id ?? '')
        if (!SESSION_KEY_RE.test(id) || id.length > 300) throw new Error('invalid session id')
        if (typeof params.pinned !== 'boolean') throw new Error('pinned must be a boolean')
        if (params.pinned && this.store.listPins().length >= MAX_PINS && !this.store.listPins().some((p) => p.id === id)) {
          throw new Error(`you can pin at most ${MAX_PINS} sessions`)
        }
        if (this.store.setPin(id, params.pinned)) this.broadcastPins()
        return { pins: this.store.listPins() }
      }

      case 'remote.rules.list': {
        this.requireScope(conn, 'approvals')
        return this.store.listRules()
      }

      case 'remote.rules.add': {
        this.requireScope(conn, 'approvals')
        // The phone sets this only after a Face ID / passcode prompt for this very action.
        if (params.freshAuth !== true) throw new Error('adding an always-allow rule needs a fresh Face ID confirmation')
        const spec = parseNewRule(params)
        if (this.store.listRules().length >= MAX_RULES) throw new Error(`you can keep at most ${MAX_RULES} rules`)
        const rule = this.store.addRule({ ...spec, createdBy: conn.device?.name ?? null })
        this.auditLog.record({ deviceId: conn.device?.id ?? null, deviceName: conn.device?.name ?? null, action: 'rule_add', summary: `rule=${rule.id} ${describeRule(rule)}`, transport: this.transports.get(conn) ?? 'direct' })
        this.broadcastRules()
        return { rule, rules: this.store.listRules() }
      }

      case 'remote.rules.remove': {
        this.requireScope(conn, 'approvals')
        const removed = this.removeRule(String(params.id ?? ''), conn.device ? { id: conn.device.id, name: conn.device.name } : null, this.transports.get(conn) ?? 'direct')
        return { removed: removed !== null, rules: this.store.listRules() }
      }

      case 'remote.events': {
        const after = Number(params.afterSeq ?? 0)
        const limit = Math.min(Number(params.limit ?? 200), 1000)
        const keys = Array.isArray(params.sessionKeys) ? (params.sessionKeys as string[]) : undefined
        return this.store.eventsSince(after, limit, keys).map((r) => ({
          seq: r.seq,
          event: r.event,
          sessionKey: r.sessionKey,
          data: JSON.parse(r.data),
        }))
      }

      default:
        throw new Error(`unknown bridge method: ${method}`)
    }
  }

  /** Shared by the phone, the control page and (via the DB) the CLI. */
  removeRule(id: string, by: { id: string; name: string } | null, transport: string): ReturnType<Store['removeRule']> {
    const removed = this.store.removeRule(id)
    if (!removed) return null
    this.auditLog.record({ deviceId: by?.id ?? null, deviceName: by?.name ?? null, action: 'rule_remove', summary: `rule=${removed.id} ${describeRule(removed)}`, transport })
    this.broadcastRules()
    return removed
  }

  private requireScope(conn: DeviceConnection, scope: Scope): void {
    if (!conn.device?.scopes.includes(scope)) {
      throw new Error(`this device does not have the "${scope}" permission`)
    }
  }

  /** Called when the Mac approves a pending scope request. Pushes it live. */
  applyScopeDecision(requestId: string, approve: boolean): boolean {
    const resolved = this.store.resolveScopeRequest(requestId, approve)
    if (!resolved) return false
    for (const c of this.connections) {
      if (c.device?.id === resolved.device.id) {
        c.device = resolved.device
        c.forward('remote.scopes_changed', { scopes: resolved.device.scopes, granted: approve ? resolved.scope : null }, undefined, null)
      }
    }
    this.auditLog.record({ deviceId: resolved.device.id, deviceName: resolved.device.name, action: approve ? 'scope_grant' : 'scope_deny', summary: `scope=${resolved.scope}`, transport: 'mac' })
    this.log(`${approve ? 'granted' : 'denied'} "${resolved.scope}" for ${resolved.device.name}`)
    return true
  }

  // -------------------------------------------------------------------------
  // [SEC-RELAY] Relay access control
  // -------------------------------------------------------------------------

  private relayTokenFor(deviceId: string): string {
    return deriveRelayToken(this.relaySecret!, deviceId)
  }

  /**
   * A phone confirms it has PERSISTED its relay token (remote.relayTokAck, over the encrypted channel, carrying
   * the token's hash as proof it holds it). Only this, never merely having been sent the token, makes the
   * device count towards enforcement: old app builds ignore the token and would be locked out.
   */
  private markRelayTokenAcked(deviceId: string): void {
    const d = this.store.getMeta<string[]>(RELAY_ACKED_KEY, [])
    if (d.includes(deviceId)) return
    this.store.setMeta(RELAY_ACKED_KEY, [...d, deviceId])
    this.log(`relay: device ${deviceId.slice(0, 8)} confirmed it stored its relay token`)
    this.syncRelayAccess()
  }

  relayTokAck(deviceId: string, tokHash: unknown): boolean {
    if (!this.relaySecret || typeof tokHash !== 'string') return false
    if (tokHash !== relayTokenHash(this.relayTokenFor(deviceId))) return false
    this.markRelayTokenAcked(deviceId)
    return true
  }

  hostSummaryFor(device: { id: string }): HostSummary {
    if (!this.relayInfo || !this.relaySecret) return this.hostSummary
    return { ...this.hostSummary, relay: { ...this.relayInfo, tok: this.relayTokenFor(device.id) } }
  }

  /**
   * Tell the relay who may open a device socket: the hash of every non-revoked device's token plus the live
   * pairing tickets (revoking a device drops its hash on the next sync, at most 5s later, at once via the
   * control page). Sent in full each time; the relay ignores identical sets.
   *
   * Enforcement rule: the relay lets token-less (legacy) devices in until `enforce` is true. It becomes true,
   * and then stays true (persisted), as soon as EVERY non-revoked device has CONFIRMED it stored its token (remote.relayTokAck), or 14 days after this feature first ran, whichever is first.
   * A fresh install with no devices enforces at once; new phones get in with the QR's pairing ticket.
   */
  private syncRelayAccess(): void {
    if (!this.relay || !this.relaySecret) return
    const now = Date.now()
    for (const [code, t] of this.relayTickets) if (t.exp <= now) this.relayTickets.delete(code)
    const devices = this.store.listDevices().filter((d) => !d.revoked)
    const acked = new Set(this.store.getMeta<string[]>(RELAY_ACKED_KEY, []))
    let since = this.store.getMeta<number>(RELAY_SINCE_KEY, 0)
    if (!since) {
      since = now
      this.store.setMeta(RELAY_SINCE_KEY, since)
    }
    let enforce = this.store.getMeta<boolean>(RELAY_ENFORCE_KEY, false)
    const allAcked = devices.every((d) => acked.has(d.id))
    if (!enforce && (allAcked || now - since >= RELAY_ENFORCE_AFTER_MS)) {
      enforce = true
      if (!allAcked) {
        for (const d of devices.filter((x) => !acked.has(x.id))) {
          this.log(`relay: WARNING enforcing after the ${RELAY_ENFORCE_AFTER_MS / 86_400_000}-day fallback; "${d.name}" never confirmed its relay token and is locked out of the relay until it connects over the LAN once (update the app) or is re-paired`)
        }
      }
      this.store.setMeta(RELAY_ENFORCE_KEY, true)
      this.log('relay: access tokens are now enforced')
    }
    this.relay.setAccess({
      tokens: devices.map((d) => relayTokenHash(this.relayTokenFor(d.id))),
      tickets: [...this.relayTickets.values()].map((t) => relayTokenHash(t.tok)),
      enforce,
    })
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  newPairingPayload(scopes: Scope[] = SCOPE_DEFAULTS): { payload: PairingPayload; uri: string; code: string } {
    const { code, expiresAt } = this.store.createPairing(this.settings.pairingTtlMs, scopes)
    // [SEC-RELAY] A single-use ticket lets this one phone open the relay socket to pair; it lives as long as the code.
    let relay: RelayInfo | null = this.relayInfo
    if (this.relayInfo && this.relaySecret) {
      const tok = newRelayToken()
      this.relayTickets.set(code, { tok, exp: expiresAt })
      relay = { ...this.relayInfo, tk: tok }
      this.syncRelayAccess()
    }
    const payload: PairingPayload = {
      v: PROTOCOL_VERSION,
      h: this.hostSummary.id,
      n: this.hostSummary.name,
      k: toB64(this.sodium, this.hostIdentity.publicKey),
      c: code,
      a: candidateAddresses(this.settings.port, this.settings.extraAddresses, this.settings.bind).map((c) => c.address),
      e: expiresAt,
      ...(relay ? { r: relay } : {}),
    }
    return { payload, uri: encodePairingPayload(payload), code }
  }

  /** Mac-side approval of a pending pairing. Activates the device. */
  approveDevice(id: string, transport = 'mac'): boolean {
    const d = this.store.getDevice(id)
    if (!d || !this.store.approveDevice(id)) return false
    this.auditLog.record({ deviceId: id, deviceName: d.name, action: 'approve', summary: `scopes=${d.scopes.join(',')}`, transport })
    this.log(`approved "${d.name}" on this Mac`)
    return true
  }

  /** Mac-side rejection of a pending pairing. Deletes the device. */
  rejectDevice(id: string, transport = 'mac'): boolean {
    const d = this.store.getDevice(id)
    if (!d || !this.store.rejectDevice(id)) return false
    this.auditLog.record({ deviceId: id, deviceName: d.name, action: 'reject', transport })
    this.log(`rejected "${d.name}"`)
    for (const c of this.connections) if (c.device?.id === id) c.close('removed')
    return true
  }

  private onPairSocket(ws: DeviceSocket, remote: string, transport: 'relay' | 'direct'): void {
    const timer = setTimeout(() => ws.close(), 15_000)
    ws.on('message', (raw: Buffer) => {
      clearTimeout(timer)
      try {
        if (raw.length > PRE_AUTH_MAX_FRAME) throw new Error('pairing frame too large')
        const frame = JSON.parse(raw.toString()) as { t?: string; v?: number; sealed?: string }
        if (frame.t !== 'pair') throw new Error('expected a pair frame')
        if (frame.v !== PROTOCOL_VERSION) throw new Error(`this host speaks protocol v${PROTOCOL_VERSION}`)

        // The request is sealed to the host key printed in the QR, so only this
        // machine can read the pairing code. A listener on the network learns
        // nothing and cannot impersonate the host.
        const req = openSealedJson<PairingRequest>(this.sodium, this.hostIdentity, String(frame.sealed))
        const scopes = this.store.consumePairing(req.code)
        if (!scopes) throw new Error('that pairing code is expired, already used, or wrong')

        // The device is created PENDING: it cannot connect or call anything until
        // the user approves it on the Mac (control page or `dorabot-remote approve`).
        const device = this.store.createDevice({
          name: cleanName(req.deviceName, 'Phone'),
          platform: cleanName(req.platform, 'unknown').slice(0, 32),
          publicKey: req.devicePublicKey,
          scopes,
          pending: true,
        })
        const fp = fingerprint(null, fromB64(null, device.publicKey))

        const response: PairingResponse & { pending: true; approvalExpiresAt: number } = {
          pending: true,
          approvalExpiresAt: (device.pendingSince ?? Date.now()) + PENDING_TTL_MS,
          v: PROTOCOL_VERSION,
          deviceId: device.id,
          hostId: this.hostSummary.id,
          hostName: this.hostSummary.name,
          scopes,
          hostPublicKey: toB64(this.sodium, this.hostIdentity.publicKey),
          ...(this.relaySecret ? { relayTok: this.relayTokenFor(device.id) } : {}), // [SEC-RELAY]
        }
        if (this.relaySecret) {
          this.relayTickets.delete(req.code)
          this.syncRelayAccess() // the new device's token hash must reach the relay before it reconnects
        }
        const devicePk = fromB64(null, req.devicePublicKey)
        ws.send(JSON.stringify({ t: 'pair_ok', v: PROTOCOL_VERSION, sealed: sealJson(this.sodium, devicePk, response) }))
        this.auditLog.record({ deviceId: device.id, deviceName: device.name, action: 'pair', summary: `pending approval; fingerprint=${fp}`, transport })
        this.log(`"${device.name}" (${device.platform}, ${fp}) from ${remote} is waiting for approval on this Mac`)
        this.notify('dorabot remote', `Allow "${device.name}" to control dorabot? Approve it on the control page.`)
        setTimeout(() => ws.close(), 500)
      } catch (err) {
        this.log(`pairing refused from ${remote}: ${(err as Error).message}`)
        try {
          ws.send(JSON.stringify({ t: 'err', code: 'bad_handshake', message: (err as Error).message }))
        } catch {
          // Socket gone.
        }
        ws.close()
      }
    })
    ws.on('error', () => clearTimeout(timer))
  }

  /**
   * The phone uses one relay URL for both pairing and connecting, so the path
   * cannot say which it is. The first frame does: `pair` or `hello`. It is held
   * back, dispatched to the right handler, then re-delivered.
   */
  private routeRelaySocket(sock: DeviceSocket, remote: string): void {
    let routed = false
    let strayAuthSeen = false
    const openedAt = Date.now()
    const timer = setTimeout(() => {
      if (!routed) {
        this.log(`relay: device socket opened but sent no first frame in 15s, closing`)
        sock.close(4400, 'no first frame')
      }
    }, 15_000)
    sock.on('close', (code?: unknown, reason?: unknown) => {
      clearTimeout(timer)
      // A phone that reached the relay but vanished before saying hello.
      if (!routed) this.log(`relay: device socket closed before its first frame after ${Date.now() - openedAt}ms (code ${String(code ?? '?')}${reason ? ` ${String(reason)}` : ''})`)
    })
    sock.on('message', (raw: Buffer, isBinary: boolean) => {
      if (routed) return
      let t: unknown
      let n: unknown
      try {
        if (!isBinary) {
          const f = JSON.parse(raw.toString()) as { t?: unknown; n?: unknown }
          t = f.t
          n = f.n
        }
      } catch {
        // Falls through to the unknown-frame close.
      }
      // The relay consumes a device's {t:'auth'} frame itself. One that reaches us anyway (an older Room
      // still running, or a relay that forwards it) is not the device's first real frame: drop it and wait.
      if (t === 'auth' && !strayAuthSeen) {
        strayAuthSeen = true
        return
      }
      routed = true
      clearTimeout(timer)
      if (t === 'selftest') {
        // Our own probe through the relay: proof that opens reach us. Never routed.
        this.relay?.confirmSelfTest(n)
        sock.close(1000, 'selftest')
        return
      }
      if (t !== 'pair' && t !== 'hello') {
        this.log(`relay: unexpected first frame, closing`)
        sock.close(4400, 'unexpected first frame')
        return
      }
      if (t === 'pair') this.onPairSocket(sock, remote, 'relay')
      else this.onDeviceSocket(sock, remote, 'relay')
      ;(sock as unknown as { emit(e: string, ...a: unknown[]): boolean }).emit('message', raw, isBinary)
    })
  }

  private onDeviceSocket(ws: DeviceSocket, remote: string, transport: 'relay' | 'direct'): DeviceConnection {
    // Registered before the connection's own listener so an oversized pre-auth
    // frame is refused as early as possible.
    let conn: DeviceConnection | null = null
    ws.on('message', (raw: Buffer) => {
      if (raw.length > PRE_AUTH_MAX_FRAME && !conn?.isAuthed) {
        this.log(`closing unauthenticated socket from ${remote}: oversized frame`)
        ws.close(1009, 'frame too large')
        conn?.close('frame too large')
      }
    })
    conn = new DeviceConnection(ws, this, remote)
    this.transports.set(conn, transport)
    this.connections.add(conn)
    return conn
  }

  // -------------------------------------------------------------------------
  // Local control page
  // -------------------------------------------------------------------------

  private isLoopback(req: IncomingMessage): boolean {
    const addr = req.socket.remoteAddress ?? ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  /** Host must be exactly 127.0.0.1/localhost/[::1] on our port; Origin, if sent, must match too. */
  isTrustedLocalRequest(req: IncomingMessage): boolean {
    const port = this.settings.port
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
    const host = String(req.headers.host ?? '').toLowerCase()
    if (!hosts.includes(host)) return false
    const origin = req.headers.origin
    if (origin !== undefined) {
      const ok = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]
      if (typeof origin !== 'string' || !ok.includes(origin.toLowerCase())) return false
    }
    return true
  }

  private onHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, version: BRIDGE_VERSION, gateway: this.gatewayConnected() }))
      return
    }

    // Everything else is a control surface and is reachable from this machine
    // only. The bridge binds to 0.0.0.0 so phones can reach /connect and /pair,
    // which means an open pairing page would be an open door onto the LAN.
    if (!this.isLoopback(req)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }

    // DNS rebinding: a web page can point its own hostname at 127.0.0.1 and
    // drive this API from the user's browser. Only accept our literal loopback
    // Host, and refuse any cross-origin caller.
    if (!this.isTrustedLocalRequest(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('forbidden')
      return
    }

    this.handleLocalRequest(url, req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) this.log(`control request failed: ${(err as Error).message}`)
      if (res.headersSent) {
        res.end()
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof HttpError ? err.message : 'internal error' }))
    })
  }

  private async handleLocalRequest(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const SECURITY_HEADERS = {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    }

    // Exchange a one-time login token (minted by the CLI) for the session cookie.
    if (url.pathname === '/' && url.searchParams.has('login') && req.method === 'GET') {
      if (this.store.consumeLoginToken(url.searchParams.get('login') ?? '')) {
        res.writeHead(303, { location: '/', 'set-cookie': sessionSetCookie(this.controlSecret), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        res.end()
      } else {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS })
        res.end(LOGIN_HELP('That login link has expired or was already used.'))
      }
      return
    }

    const authed = isControlAuthorized(req, this.controlSecret)

    if (url.pathname === '/') {
      if (!authed) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS })
        res.end(LOGIN_HELP('This page needs a login link.'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS })
      res.end(CONTROL_PAGE)
      return
    }

    if (url.pathname.startsWith('/api/')) {
      if (!authed) {
        json(401, { error: 'not logged in; run "dorabot-remote open"' })
        return
      }
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }

    const method = req.method ?? 'GET'
    const body = async (): Promise<Record<string, unknown>> => {
      let raw: string
      try {
        raw = await readBody(req)
      } catch {
        throw new HttpError(413, 'request body too large')
      }
      try {
        const v = JSON.parse(raw) as unknown
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
        return v as Record<string, unknown>
      } catch {
        throw new HttpError(400, 'request body must be a JSON object')
      }
    }

    if (url.pathname === '/api/state') {
      if (method !== 'GET') return json(405, { error: 'method not allowed' })
      const devices = this.store.listDevices().map((d) => this.deviceSummary(d))
      const relayState = this.relay ? { state: this.relay.state, id: this.relayInfo?.i, url: this.relayInfo?.u } : null
      const response: Record<string, unknown> = {
        host: this.hostSummary,
        gatewayConnected: this.gatewayConnected(),
        relay: relayState,
        devices,
        pendingDevices: this.store
          .listPending()
          .map((d) => ({ ...this.deviceSummary(d), expiresAt: (d.pendingSince ?? d.createdAt) + PENDING_TTL_MS })),
        scopeRequests: this.store.listScopeRequests('pending'),
        addresses: candidateAddresses(this.settings.port, this.settings.extraAddresses, this.settings.bind),
        connections: [...this.connections].map((c) => ({ device: c.device?.name ?? null, address: c.remoteAddress })),
        roots: this.roots.listRoots(),
        rules: this.store.listRules().map((r) => ({ ...r, label: describeRule(r) })),
        log: this.logLines.slice(-80),
      }
      if (this.healthAlerts) {
        response.health = { relay: this.healthAlerts.getHealth() }
      }
      if (this.compatChecker) {
        response.compat = this.compatChecker.getStatus()
      }
      json(200, response)
      return
    }

    if (url.pathname === '/api/audit') {
      if (method !== 'GET') return json(405, { error: 'method not allowed' })
      const device = url.searchParams.get('device') || undefined
      const limit = Number(url.searchParams.get('limit') ?? 200)
      json(200, { entries: this.store.listAudit({ deviceId: device, limit: Number.isFinite(limit) ? limit : 200 }) })
      return
    }

    if (url.pathname === '/api/pair' && method === 'POST') {
      const { uri, payload, code } = this.newPairingPayload()
      const qr = await QRCode.toDataURL(uri, { margin: 0, width: 512, errorCorrectionLevel: 'M' })
      this.auditLog.record({ action: 'pair_code', summary: 'pairing code created', transport: 'local' })
      json(200, { uri, qr, code, expiresAt: payload.e, addresses: payload.a })
      return
    }

    if (url.pathname === '/api/scope' && method === 'POST') {
      const { requestId, approve } = await body()
      if (typeof requestId !== 'string' || !requestId) throw new HttpError(400, 'requestId required')
      json(200, { ok: this.applyScopeDecision(requestId, Boolean(approve)) })
      return
    }

    if (url.pathname === '/api/device' && method === 'POST') {
      const { deviceId, action, scopes } = await body()
      if (typeof deviceId !== 'string' || !deviceId) throw new HttpError(400, 'deviceId required')
      const known = this.store.getDevice(deviceId)
      const who = { deviceId, deviceName: known?.name ?? null, transport: 'local' }
      let ok = false
      if (action === 'approve') {
        ok = this.approveDevice(deviceId, 'local')
      } else if (action === 'reject') {
        ok = this.rejectDevice(deviceId, 'local')
      } else if (action === 'revoke') {
        ok = this.store.setRevoked(deviceId, true)
        for (const c of this.connections) if (c.device?.id === deviceId) c.close('revoked')
        if (ok) this.auditLog.record({ ...who, action: 'revoke' })
      } else if (action === 'restore') {
        ok = this.store.setRevoked(deviceId, false)
        // Restart the 90-day clock, or the expiry sweep would undo this at once.
        if (ok) {
          this.store.touchDevice(deviceId)
          this.auditLog.record({ ...who, action: 'restore' })
        }
      } else if (action === 'delete') {
        ok = this.store.deleteDevice(deviceId)
        for (const c of this.connections) if (c.device?.id === deviceId) c.close('removed')
        if (ok) this.auditLog.record({ ...who, action: 'delete' })
      } else if (action === 'scopes') {
        if (!Array.isArray(scopes) || !scopes.every((x): x is Scope => typeof x === 'string' && (SCOPES as readonly string[]).includes(x))) {
          throw new HttpError(400, 'scopes must be an array of valid scope names')
        }
        const next = [...new Set(scopes)]
        const before = known?.scopes ?? []
        ok = this.store.setScopes(deviceId, next)
        const updated = this.store.getDevice(deviceId)
        for (const c of this.connections) {
          if (c.device?.id === deviceId && updated) {
            c.device = updated
            c.forward('remote.scopes_changed', { scopes: updated.scopes, granted: null }, undefined, null)
          }
        }
        if (ok) {
          const added = next.filter((x) => !before.includes(x))
          const removed = before.filter((x) => !next.includes(x))
          this.auditLog.record({ ...who, action: 'scopes', summary: `+[${added.join(',')}] -[${removed.join(',')}]` })
        }
      } else {
        throw new HttpError(400, 'unknown action')
      }
      this.syncRelayAccess() // [SEC-RELAY] revoke/restore/delete change who may use the relay
      json(200, { ok })
      return
    }

    if (url.pathname === '/api/roots') {
      if (method === 'GET') return json(200, { roots: this.roots.listRoots() })
      if (method === 'POST') {
        const { action, path } = await body()
        if (typeof path !== 'string' || !path) throw new HttpError(400, 'path required')
        try {
          let roots: string[]
          if (action === 'add') this.roots.addRoot(path)
          else if (action === 'remove') this.roots.removeRoot(path)
          else throw new HttpError(400, 'unknown action')
          roots = this.roots.listRoots()
          this.auditLog.record({ action: action === 'add' ? 'folder_add' : 'folder_remove', summary: path.slice(0, 150), transport: 'local' })
          return json(200, { ok: true, roots })
        } catch (err) {
          if (err instanceof HttpError) throw err
          return json(400, { ok: false, error: (err as Error).message })
        }
      }
      return json(405, { error: 'method not allowed' })
    }

    if (url.pathname === '/api/rules') {
      if (method === 'GET') return json(200, { rules: this.store.listRules() })
      if (method === 'POST') {
        const { action, id } = await body()
        if (action !== 'remove') throw new HttpError(400, 'unknown action')
        const removed = this.removeRule(String(id ?? ''), null, 'local')
        return json(200, { ok: removed !== null, rules: this.store.listRules() })
      }
      return json(405, { error: 'method not allowed' })
    }

    json(404, { error: 'not found' })
  }
}

function LOGIN_HELP(msg: string): string {
  return `<!doctype html><meta charset="utf-8"><title>dorabot remote</title><body style="font:15px system-ui;background:#0b0c0e;color:#e7e9ec;padding:48px"><h1 style="font-size:18px">dorabot remote</h1><p>${msg}</p><p>Open the control page from a terminal on this Mac:</p><pre>dorabot-remote open</pre></body>`
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 64 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(data || '{}'))
    req.on('error', reject)
  })
}
