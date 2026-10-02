import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import {
  NEVER_FORWARD_EVENTS,
  PROTOCOL_VERSION,
  SCOPE_DEFAULTS,
  encodePairingPayload,
  fingerprint,
  fromB64,
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
  Scope,
  SessionSnapshot,
  Sodium,
  StatusUpdate,
} from '@dorabot-remote/protocol'
import QRCode from 'qrcode'
import { WebSocketServer, type WebSocket } from 'ws'
import { candidateAddresses } from './addresses.js'
import {
  BRIDGE_VERSION,
  type BridgePaths,
  type BridgeSettings,
  loadIdentity,
  readDorabotVersion,
  readGatewayToken,
} from './config.js'
import { DeviceConnection, type ConnectionHost } from './connection.js'
import { CONTROL_PAGE } from './control-page.js'
import { GatewayClient } from './gateway-client.js'
import { Store, type DeviceRecord } from './store.js'

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
    this.hostSummary = {
      id: this.settings.hostId,
      name: this.settings.hostName,
      fingerprint: fingerprint(this.sodium, this.hostIdentity.publicKey),
      version: BRIDGE_VERSION,
      dorabotVersion: readDorabotVersion(this.paths),
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
    for (const c of this.connections) c.close('bridge shutting down')
    this.gateway?.stop()
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve()
      this.http.close(() => resolve())
      // Sockets held open by idle keep-alive should not delay shutdown.
      this.http.closeAllConnections?.()
    })
    this.store.close()
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

    // `agent.stream_batch` is a wrapper around N stream events and carries no
    // sessionKey of its own. Unwrap it so each inner event is logged and routed
    // under the session it actually belongs to.
    if (name === 'agent.stream_batch') {
      const batch = Array.isArray(data) ? data : ((d.data as unknown[]) ?? [])
      for (const entry of batch as Record<string, unknown>[]) {
        const inner = (entry.data ?? entry) as Record<string, unknown>
        this.onGatewayEvent('agent.stream', inner, undefined)
      }
      return
    }

    let bridgeSeq: number | undefined
    if (sessionKey && this.shouldPersist(name)) {
      bridgeSeq = this.store.appendEvent(name, sessionKey, data)
    }

    for (const c of this.connections) c.forward(name, data, bridgeSeq, sessionKey)
  }

  /**
   * What goes in the durable log. Only session-scoped agent activity: that is what
   * a phone needs to reconstruct a conversation it was away from. Status pings,
   * channel chatter and config updates are live-only.
   */
  private shouldPersist(name: string): boolean {
    return name.startsWith('agent.') && name !== 'agent.status'
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
        return { host: this.hostSummary, device: conn.device ? this.deviceSummary(conn.device) : null }

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
  // Pairing
  // -------------------------------------------------------------------------

  newPairingPayload(scopes: Scope[] = SCOPE_DEFAULTS): { payload: PairingPayload; uri: string; code: string } {
    const { code, expiresAt } = this.store.createPairing(this.settings.pairingTtlMs, scopes)
    const payload: PairingPayload = {
      v: PROTOCOL_VERSION,
      h: this.hostSummary.id,
      n: this.hostSummary.name,
      k: toB64(this.sodium, this.hostIdentity.publicKey),
      c: code,
      a: candidateAddresses(this.settings.port, this.settings.extraAddresses).map((c) => c.address),
      e: expiresAt,
    }
    return { payload, uri: encodePairingPayload(payload), code }
  }

  private onPairSocket(ws: WebSocket, remote: string): void {
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

  private onDeviceSocket(ws: WebSocket, remote: string): void {
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

    void this.handleLocalRequest(url, req, res)
  }

  private async handleLocalRequest(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === '/api/state') {
      json(200, {
        host: this.hostSummary,
        gatewayConnected: this.gatewayConnected(),
        devices: this.store.listDevices().map((d) => this.deviceSummary(d)),
        scopeRequests: this.store.listScopeRequests('pending'),
        addresses: candidateAddresses(this.settings.port, this.settings.extraAddresses),
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
