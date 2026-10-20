import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import {
  NEVER_FORWARD_EVENTS,
  PROTOCOL_VERSION,
  SCOPE_DEFAULTS,
  encodePairingPayload,
  fingerprint,
  fromB64,
  deriveRelayToken,
  isRelayUrlConfigured,
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
const RELAY_DELIVERED_KEY = 'relay.tokensDelivered'
const RELAY_ENFORCE_KEY = 'relay.enforce'
const RELAY_SINCE_KEY = 'relay.accessSince'
/** Enforcement turns on at the latest this long after the first start with tokens, even if an old phone never reconnected. */
export const RELAY_ENFORCE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
import { CONTROL_PAGE } from './control-page.js'
import { GatewayClient } from './gateway-client.js'
import { applyEventToSnapshots } from './snapshot-state.js'
import { Store, type DeviceRecord } from './store.js'

const SESSION_KEY_RE = /^[^:\s]+:[^:\s]+:\S+$/
const MAX_PINS = 200

/** Push treats a device as connected only if it sent a frame this recently. */
export const LIVE_WINDOW_MS = 45_000
/** Connections silent this long are closed. */
export const IDLE_CLOSE_MS = 90_000
const IDLE_SWEEP_MS = 15_000
const GATEWAY_CURSOR_KEY = 'gateway.lastSeqBySession'

export interface BridgeOptions {
  paths: BridgePaths
  settings: BridgeSettings
  log?: (msg: string) => void
}

export class Bridge implements ConnectionHost {
  sodium!: Sodium
  hostIdentity!: KeyPair
  hostSummary!: HostSummary

  readonly store: Store
  readonly settings: BridgeSettings
  private readonly paths: BridgePaths
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
  readonly logLines: string[] = []

  constructor(opts: BridgeOptions) {
    this.paths = opts.paths
    this.settings = opts.settings
    this.store = new Store(opts.paths.db)
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
    this.hostSummary = {
      id: this.settings.hostId,
      name: this.settings.hostName,
      fingerprint: fingerprint(this.sodium, this.hostIdentity.publicKey),
      version: BRIDGE_VERSION,
      dorabotVersion: readDorabotVersion(this.paths),
      ...(this.relayInfo ? { relay: this.relayInfo } : {}),
    }
    this.gatewayCursor = this.store.getMeta<Record<string, number>>(GATEWAY_CURSOR_KEY, {})

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
      this.relay.on('state', (s) => this.broadcastBridgeEvent('remote.relay_state', { state: s }))
      this.syncRelayAccess()
      this.relay.start()
    }

    // The CLI revokes and grants from another process, straight into the DB.
    this.deviceTimer = setInterval(() => {
      for (const c of [...this.connections]) c.recheckDevice()
      // Also picks up CLI revocations, which write straight into the DB.
      this.syncRelayAccess()
    }, 5000)

    this.idleTimer = setInterval(() => this.sweepIdle(), IDLE_SWEEP_MS)

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
    for (const c of this.connections) c.close('bridge shutting down')
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

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => this.onHttpRequest(req, res))
      const wss = new WebSocketServer({ noServer: true })

      http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
        const path = (req.url ?? '/').split('?')[0]
        if (path !== '/connect' && path !== '/pair') {
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const remote = req.socket.remoteAddress ?? 'unknown'
          if (path === '/pair') this.onPairSocket(ws, remote)
          else this.onDeviceSocket(ws, remote)
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
    return this.store.getDevice(id)
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
        const scope = String(params.scope ?? '') as Scope
        const reason = String(params.reason ?? '').slice(0, 200)
        if (!conn.device) throw new Error('not authenticated')
        if (conn.device.scopes.includes(scope)) return { alreadyGranted: true }
        const req = this.store.createScopeRequest(conn.device.id, scope, reason)
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
    this.log(`${approve ? 'granted' : 'denied'} "${resolved.scope}" for ${resolved.device.name}`)
    return true
  }

  // -------------------------------------------------------------------------
  // [SEC-RELAY] Relay access control
  // -------------------------------------------------------------------------

  private relayTokenFor(deviceId: string): string {
    return deriveRelayToken(this.relaySecret!, deviceId)
  }

  /** Records that a device now holds its relay token (it was sent over the E2E channel). */
  private markRelayTokenDelivered(deviceId: string): void {
    const d = this.store.getMeta<string[]>(RELAY_DELIVERED_KEY, [])
    if (d.includes(deviceId)) return
    this.store.setMeta(RELAY_DELIVERED_KEY, [...d, deviceId])
    this.syncRelayAccess()
  }

  hostSummaryFor(device: { id: string }): HostSummary {
    if (!this.relayInfo || !this.relaySecret) return this.hostSummary
    this.markRelayTokenDelivered(device.id)
    return { ...this.hostSummary, relay: { ...this.relayInfo, tok: this.relayTokenFor(device.id) } }
  }

  /**
   * Tell the relay who may open a device socket: the hash of every non-revoked device's token plus the live
   * pairing tickets (revoking a device drops its hash on the next sync, at most 5s later, at once via the
   * control page). Sent in full each time; the relay ignores identical sets.
   *
   * Enforcement rule: the relay lets token-less (legacy) devices in until `enforce` is true. It becomes true,
   * and then stays true (persisted), as soon as EVERY non-revoked device has been sent its token (i.e. has
   * connected once with this bridge version), or 14 days after this feature first ran, whichever is first.
   * A fresh install with no devices enforces at once; new phones get in with the QR's pairing ticket.
   */
  private syncRelayAccess(): void {
    if (!this.relay || !this.relaySecret) return
    const now = Date.now()
    for (const [code, t] of this.relayTickets) if (t.exp <= now) this.relayTickets.delete(code)
    const devices = this.store.listDevices().filter((d) => !d.revoked)
    const delivered = new Set(this.store.getMeta<string[]>(RELAY_DELIVERED_KEY, []))
    let since = this.store.getMeta<number>(RELAY_SINCE_KEY, 0)
    if (!since) {
      since = now
      this.store.setMeta(RELAY_SINCE_KEY, since)
    }
    let enforce = this.store.getMeta<boolean>(RELAY_ENFORCE_KEY, false)
    if (!enforce && (devices.every((d) => delivered.has(d.id)) || now - since >= RELAY_ENFORCE_AFTER_MS)) {
      enforce = true
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

  private onPairSocket(ws: DeviceSocket, remote: string): void {
    const timer = setTimeout(() => ws.close(), 15_000)
    ws.on('message', (raw: Buffer) => {
      clearTimeout(timer)
      try {
        const frame = JSON.parse(raw.toString()) as { t?: string; v?: number; sealed?: string }
        if (frame.t !== 'pair') throw new Error('expected a pair frame')
        if (frame.v !== PROTOCOL_VERSION) throw new Error(`this host speaks protocol v${PROTOCOL_VERSION}`)

        // The request is sealed to the host key printed in the QR, so only this
        // machine can read the pairing code. A listener on the network learns
        // nothing and cannot impersonate the host.
        const req = openSealedJson<PairingRequest>(this.sodium, this.hostIdentity, String(frame.sealed))
        const scopes = this.store.consumePairing(req.code)
        if (!scopes) throw new Error('that pairing code is expired, already used, or wrong')

        const device = this.store.createDevice({
          name: String(req.deviceName ?? 'Phone').slice(0, 64),
          platform: String(req.platform ?? 'unknown').slice(0, 32),
          publicKey: req.devicePublicKey,
          scopes,
        })

        const response: PairingResponse = {
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
          this.markRelayTokenDelivered(device.id)
        }
        const devicePk = fromB64(null, req.devicePublicKey)
        ws.send(JSON.stringify({ t: 'pair_ok', v: PROTOCOL_VERSION, sealed: sealJson(this.sodium, devicePk, response) }))
        this.log(`paired "${device.name}" (${device.platform}) from ${remote}`)
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
      routed = true
      clearTimeout(timer)
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
      if (t === 'pair') this.onPairSocket(sock, remote)
      else this.onDeviceSocket(sock, remote)
      ;(sock as unknown as { emit(e: string, ...a: unknown[]): boolean }).emit('message', raw, isBinary)
    })
  }

  private onDeviceSocket(ws: DeviceSocket, remote: string): void {
    const conn = new DeviceConnection(ws, this, remote)
    this.connections.add(conn)
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

    void this.handleLocalRequest(url, req, res)
  }

  private async handleLocalRequest(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === '/api/state' && req.method !== 'GET') {
      json(405, { error: 'method not allowed' })
      return
    }

    if (url.pathname === '/api/state') {
      json(200, {
        host: this.hostSummary,
        gatewayConnected: this.gatewayConnected(),
        relay: this.relay ? { state: this.relay.state, id: this.relayInfo?.i, url: this.relayInfo?.u } : null,
        devices: this.store.listDevices().map((d) => this.deviceSummary(d)),
        scopeRequests: this.store.listScopeRequests('pending'),
        addresses: candidateAddresses(this.settings.port, this.settings.extraAddresses, this.settings.bind),
        connections: [...this.connections].map((c) => ({ device: c.device?.name ?? null, address: c.remoteAddress })),
        log: this.logLines.slice(-80),
      })
      return
    }

    if (url.pathname === '/api/pair' && req.method === 'POST') {
      const { uri, payload, code } = this.newPairingPayload()
      const qr = await QRCode.toDataURL(uri, { margin: 0, width: 512, errorCorrectionLevel: 'M' })
      json(200, { uri, qr, code, expiresAt: payload.e, addresses: payload.a })
      return
    }

    if (url.pathname === '/api/scope' && req.method === 'POST') {
      const body = await readBody(req)
      const { requestId, approve } = JSON.parse(body) as { requestId: string; approve: boolean }
      json(200, { ok: this.applyScopeDecision(requestId, Boolean(approve)) })
      return
    }

    if (url.pathname === '/api/device' && req.method === 'POST') {
      const body = await readBody(req)
      const { deviceId, action, scopes } = JSON.parse(body) as {
        deviceId: string
        action: 'revoke' | 'restore' | 'delete' | 'scopes'
        scopes?: Scope[]
      }
      let ok = false
      if (action === 'revoke') {
        ok = this.store.setRevoked(deviceId, true)
        for (const c of this.connections) if (c.device?.id === deviceId) c.close('revoked')
      } else if (action === 'restore') {
        ok = this.store.setRevoked(deviceId, false)
      } else if (action === 'delete') {
        ok = this.store.deleteDevice(deviceId)
        for (const c of this.connections) if (c.device?.id === deviceId) c.close('removed')
      } else if (action === 'scopes' && scopes) {
        ok = this.store.setScopes(deviceId, scopes)
        const updated = this.store.getDevice(deviceId)
        for (const c of this.connections) {
          if (c.device?.id === deviceId && updated) {
            c.device = updated
            c.forward('remote.scopes_changed', { scopes: updated.scopes, granted: null }, undefined, null)
          }
        }
      }
      this.syncRelayAccess() // [SEC-RELAY] revoke/restore/delete change who may use the relay
      json(200, { ok })
      return
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(CONTROL_PAGE)
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }
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
