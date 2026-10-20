/**
 * One Room per host. It is a blind switchboard: it authenticates the host, then
 * copies frames between that host's socket and its devices' sockets. It cannot
 * read any of them (they are end-to-end encrypted between phone and bridge) and
 * it never logs a payload.
 *
 * Uses the WebSocket Hibernation API, so an idle room costs nothing. A hibernated
 * object loses its memory, so everything that must survive (role, connId, authed)
 * lives in the socket attachment. Per-device rate buckets stay in memory on
 * purpose: they only reset after a quiet period, which is when it does not matter.
 */
import { DurableObject } from 'cloudflare:workers'
import {
  MuxKind,
  RELAY_CLOSE,
  RELAY_HB_REQUEST,
  RELAY_HB_RESPONSE,
  decodeMux,
  decodeMuxClose,
  encodeMux,
  encodeMuxClose,
  newChallengeNonce,
  relayTokenHash,
  RELAY_HASH_RE,
  RELAY_TOKEN_PROTOCOL_PREFIX,
  RELAY_TOKEN_RE,
  verifyChallenge,
} from '@dorabot-remote/protocol'
import { LIMITS, SlidingWindow, TokenBucket } from './limits.js'
import type { Env } from './index.js'

type HostAtt = { role: 'host'; rid: string; n: string; authed: boolean; t0: number; /** auth time; liveness floor until the first heartbeat. */ seen?: number }
/**
 * `dropped` marks a device the room closed because its host went away; no one needs telling.
 * `auth`: 'pending' = connected, no valid token yet, the host has NOT been told about it;
 * 'tok' / 'ticket' = presented a valid token / single-use ticket; 'legacy' = connected with no
 * token while the host had not enforced yet (decided by its FIRST frame: while the host is not enforcing, a
 * device is held 'pending' until that frame, so one that presents a token is checked before the host hears of it). `h` is the hash it authenticated with (for revocation).
 */
type DevAtt = {
  role: 'dev'
  connId: number
  rid?: string
  t0?: number
  dropped?: boolean
  auth: 'pending' | 'legacy' | 'tok' | 'ticket'
  /** Pending, but allowed to become 'legacy' if its first frame is not an auth frame (host not enforcing at accept time). */
  lg?: boolean
  h?: string
  ip?: string
}
type Att = HostAtt | DevAtt

/** Access state pushed by the authenticated host; persisted so it survives hibernation. */
interface Access {
  tokens: string[]
  /** ticket hash -> expiry (unix ms) */
  tickets: Record<string, number>
  /** ticket hash -> time used; kept so a re-sent set cannot resurrect a consumed ticket */
  used: Record<string, number>
  enforce: boolean
}
const ACCESS_KEY = 'access'

const OPEN = 1
/** A host that has not heartbeat (bridge sends every 15s) for this long is a zombie link. */
export const HOST_STALE_MS = 45_000

/** Close codes outside 1000 and 3000-4999 throw when sent, so clamp whatever a peer asks for. */
function safeCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) || code === 1009 ? code : 1000
}

/** One JSON line per event for Workers Logs. relayId is truncated; never log IPs, payloads or keys. */
function rlog(ev: string, rid: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ev, rid: rid.slice(0, 6), ...extra }))
}

function tryClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(safeCode(code), reason.slice(0, 120))
  } catch {
    // Already closed.
  }
}

/**
 * A close sent in the same tick as the upgrade response can be dropped before the
 * client has a socket to receive it on, so rejections at accept time are deferred.
 */
function rejectSoon(ws: WebSocket, code: number, reason: string): void {
  setTimeout(() => tryClose(ws, code, reason), 25)
}

export class Room extends DurableObject<Env> {
  private buckets = new Map<number, TokenBucket>()
  private pushWindow = new SlidingWindow(LIMITS.pushPerMinute, LIMITS.pushWindowMs)
  private access: Access = { tokens: [], tickets: {}, used: {}, enforce: false }
  private ipHits = new Map<string, number[]>()
  private dedupe = new Map<string, number>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void this.ctx.blockConcurrencyWhile(async () => {
      const a = await this.ctx.storage.get<Access>(ACCESS_KEY)
      if (a) this.access = { tokens: a.tokens ?? [], tickets: a.tickets ?? {}, used: a.used ?? {}, enforce: !!a.enforce }
    })
    // Answered by the runtime without waking a hibernated object; it also stamps
    // getWebSocketAutoResponseTimestamp, which is how host liveness is judged.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_HB_REQUEST, RELAY_HB_RESPONSE))
  }

  private staleMs(): number {
    const v = Number(this.env.HOST_STALE_MS)
    return Number.isFinite(v) && v > 0 ? v : HOST_STALE_MS
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const m = /^\/(h|d|rate|dedupe)\/([A-Za-z0-9_-]{22})$/.exec(url.pathname)
    if (!m) return new Response('not found', { status: 404 })
    const [, route, relayId] = m as unknown as [string, string, string]

    if (route === 'rate') {
      return new Response(null, { status: this.pushWindow.allow() ? 204 : 429 })
    }
    if (route === 'dedupe') {
      // Internal (from the push handler): first sight of a key within the window is 204, a repeat is 409.
      const { k, forget } = (await request.json().catch(() => ({}))) as { k?: string; forget?: boolean }
      if (typeof k !== 'string' || k.length === 0 || k.length > 128) return new Response(null, { status: 400 })
      return new Response(null, { status: this.pushDedupe(k, !!forget) })
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })

    // Cloudflare always sets this; without it (local dev) per-IP limits do not apply.
    const ip = request.headers.get('CF-Connecting-IP') ?? undefined
    if (ip && !this.ipAllow(ip)) {
      rlog('conn_rejected', relayId, { reason: 'ip_rate' })
      return new Response('rate limited', { status: 429 })
    }

    const { 0: client, 1: server } = new WebSocketPair()
    const headers: Record<string, string> = {}
    if (route === 'h') this.acceptHost(server, relayId)
    else {
      // Browsers cannot set headers, so a token may ride in Sec-WebSocket-Protocol; the chosen value must be echoed.
      const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((p) => p.trim())
      const tokProto = offered.find((p) => p.startsWith(RELAY_TOKEN_PROTOCOL_PREFIX))
      if (tokProto) headers['Sec-WebSocket-Protocol'] = tokProto
      this.acceptDevice(server, relayId, ip, tokProto?.slice(RELAY_TOKEN_PROTOCOL_PREFIX.length))
    }
    return new Response(null, { status: 101, webSocket: client, headers })
  }

  private pushDedupe(key: string, forget: boolean): number {
    const now = Date.now()
    if (forget) {
      this.dedupe.delete(key)
      return 204
    }
    for (const [k, exp] of this.dedupe) if (exp <= now) this.dedupe.delete(k)
    if (this.dedupe.has(key)) return 409
    // Over capacity: drop the oldest (Map keeps insertion order) rather than refuse real pushes.
    while (this.dedupe.size >= LIMITS.pushDedupeMax) this.dedupe.delete(this.dedupe.keys().next().value as string)
    this.dedupe.set(key, now + LIMITS.pushDedupeMs)
    return 204
  }

  /** Connections per IP per minute (hosts and devices alike). In memory: it only matters while under attack. */
  private ipAllow(ip: string): boolean {
    const now = Date.now()
    if (this.ipHits.size > 2000) this.ipHits.clear()
    const hits = (this.ipHits.get(ip) ?? []).filter((t) => now - t < LIMITS.ipWindowMs)
    if (hits.length >= LIMITS.ipConnsPerWindow) {
      this.ipHits.set(ip, hits)
      return false
    }
    hits.push(now)
    this.ipHits.set(ip, hits)
    return true
  }

  // -------------------------------------------------------------------------
  // Accepting sockets
  // -------------------------------------------------------------------------

  private acceptHost(ws: WebSocket, relayId: string): void {
    this.ctx.acceptWebSocket(ws, ['host'])
    rlog('host_connect', relayId)
    const pending = this.ctx.getWebSockets('host').filter((w) => w !== ws && !(w.deserializeAttachment() as HostAtt | null)?.authed)
    // Junk sockets must not be able to lock the real host out: when full, the oldest
    // pending one is evicted to make room instead of refusing the newcomer. (A successful
    // auth also evicts every other pending socket, see onHostMessage.)
    if (pending.length >= LIMITS.maxPendingHosts) {
      pending.sort((a, b) => ((a.deserializeAttachment() as HostAtt | null)?.t0 ?? 0) - ((b.deserializeAttachment() as HostAtt | null)?.t0 ?? 0))
      for (const old of pending.slice(0, pending.length - LIMITS.maxPendingHosts + 1)) {
        rlog('host_rejected', relayId, { reason: 'pending_evicted' })
        tryClose(old, RELAY_CLOSE.rateLimited, 'pending_evicted')
      }
    }
    const n = newChallengeNonce()
    ws.serializeAttachment({ role: 'host', rid: relayId, n, authed: false, t0: Date.now() } satisfies HostAtt)
    ws.send(JSON.stringify({ t: 'challenge', n }))
    void this.armAlarm(Date.now() + LIMITS.hostAuthTimeoutMs)
  }

  /** setTimeout would not survive hibernation; an alarm does. Keep the earliest wanted deadline. */
  private async armAlarm(at: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm()
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at)
  }

  private acceptDevice(ws: WebSocket, relayId: string, ip?: string, protoTok?: string): void {
    this.ctx.acceptWebSocket(ws)
    const host = this.authedHost()
    if (!host) {
      rlog('device_rejected', relayId, { reason: 'host_offline' })
      rejectSoon(ws, RELAY_CLOSE.hostOffline, 'host_offline')
      return
    }
    const devices = this.devices()
    const atts = devices.map((d) => d.deserializeAttachment() as DevAtt | null)
    const joined = atts.filter((a) => a && (a.auth !== 'pending' || a.lg)).length
    if (joined >= LIMITS.maxDevices) {
      rlog('device_rejected', relayId, { reason: 'too_many_devices' })
      rejectSoon(ws, RELAY_CLOSE.rateLimited, 'too_many_devices')
      return
    }
    if (atts.length - joined >= LIMITS.maxPendingDevices) {
      rlog('device_rejected', relayId, { reason: 'too_many_pending' })
      rejectSoon(ws, RELAY_CLOSE.rateLimited, 'too_many_pending')
      return
    }
    if (ip && atts.filter((a) => a?.ip === ip).length >= LIMITS.ipMaxDevices) {
      rlog('device_rejected', relayId, { reason: 'ip_devices' })
      rejectSoon(ws, RELAY_CLOSE.rateLimited, 'too_many_from_ip')
      return
    }
    const used = new Set(atts.map((a) => a?.connId))
    let connId = 0
    do {
      connId = crypto.getRandomValues(new Uint32Array(1))[0]!
    } while (connId === 0 || used.has(connId))

    const att: DevAtt = { role: 'dev', connId, rid: relayId, t0: Date.now(), auth: 'pending', ...(ip ? { ip } : {}) }
    if (protoTok !== undefined) {
      const c = this.checkCredential(protoTok)
      if (!c) {
        // Wrong token: refuse whether or not enforcement is on, and never tell the host.
        ws.serializeAttachment(att)
        rlog('device_rejected', relayId, { reason: 'bad_token' })
        rejectSoon(ws, RELAY_CLOSE.unauthorized, 'unauthorized')
        return
      }
      att.auth = c.via
      att.h = c.h
    } else if (!this.access.enforce) {
      // Transition period: a token-less device may come in, but whether this one is token-less is only known
      // from its first frame, so it is not announced to the host until then.
      att.lg = true
    }
    ws.serializeAttachment(att)
    if (att.auth === 'pending') {
      // Not announced to the host: it learns about a device only once the device has authenticated (or, in the
      // transition period, has stayed silent through the grace period or sent a non-auth first frame).
      void this.armAlarm(att.t0! + (att.lg ? LIMITS.legacyGraceMs : LIMITS.deviceAuthTimeoutMs))
      return
    }
    this.admit(ws, att, host)
  }

  /** Tell the host about a device that is allowed in, and start forwarding. */
  private admit(ws: WebSocket, att: DevAtt, host: WebSocket): void {
    rlog('device_accepted', att.rid ?? '', { conn: att.connId, via: att.auth })
    this.buckets.set(att.connId, new TokenBucket(LIMITS.deviceFrames, LIMITS.deviceWindowMs))
    host.send(encodeMux(MuxKind.open, att.connId))
  }

  /**
   * Is this token (or single-use ticket) currently valid? Tickets are consumed here.
   * Matching is on the SHA-256 hash, so the relay never holds a usable token.
   */
  private checkCredential(tok: string): { via: 'tok' | 'ticket'; h: string } | null {
    if (!RELAY_TOKEN_RE.test(tok)) return null
    const h = relayTokenHash(tok)
    if (this.access.tokens.includes(h)) return { via: 'tok', h }
    const exp = this.access.tickets[h]
    if (exp !== undefined && exp > Date.now()) {
      delete this.access.tickets[h]
      this.access.used[h] = Date.now()
      void this.saveAccess()
      return { via: 'ticket', h }
    }
    return null
  }

  private saveAccess(): Promise<void> {
    return this.ctx.storage.put(ACCESS_KEY, this.access)
  }

  /** Apply a `tokens` frame from the authenticated host, then drop every device that lost access. */
  private applyTokens(frame: { set?: unknown; tickets?: unknown; enforce?: unknown }): void {
    const hashes = (v: unknown, cap: number): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && RELAY_HASH_RE.test(x)).slice(0, cap) : []
    const now = Date.now()
    const tickets: Record<string, number> = {}
    for (const h of hashes(frame.tickets, LIMITS.maxTickets)) {
      if (h in this.access.used) continue
      tickets[h] = this.access.tickets[h] ?? now + LIMITS.ticketTtlMs
    }
    for (const [h, t] of Object.entries(this.access.used)) if (now - t > 2 * LIMITS.ticketTtlMs) delete this.access.used[h]
    this.access = { ...this.access, tokens: hashes(frame.set, LIMITS.maxTokens), tickets, enforce: frame.enforce === true }
    void this.saveAccess()
    const live = new Set(this.access.tokens)
    for (const d of this.devices()) {
      const a = d.deserializeAttachment() as DevAtt
      // 'ticket' sockets are single-use pairing connections: they outlive their ticket.
      const revoked = a.auth === 'tok' && !!a.h && !live.has(a.h)
      const unauth = this.access.enforce && a.auth === 'legacy'
      if (revoked || unauth) {
        rlog('device_revoked', a.rid ?? '', { conn: a.connId, why: revoked ? 'token_removed' : 'enforce' })
        // Not `dropped`: the host saw this device open, so it is told it closed.
        tryClose(d, RELAY_CLOSE.unauthorized, revoked ? 'revoked' : 'unauthorized')
      }
    }
  }

  /** Last sign of life from an authed host: its latest heartbeat, or its auth time if it has not sent one yet. */
  private lastAlive(w: WebSocket, att: HostAtt): number {
    const hb = this.ctx.getWebSocketAutoResponseTimestamp(w)?.getTime() ?? 0
    return Math.max(hb, att.seen ?? att.t0)
  }

  /**
   * The host to talk to: OPEN, authed, and demonstrably alive. A socket the runtime
   * still calls OPEN but that has stopped heartbeating is a zombie; sending a device
   * `open` into it is the silent hang this guards against, so it is skipped and
   * closed. With several live hosts the most recently alive wins and the rest are replaced.
   */
  private authedHost(exclude?: WebSocket): WebSocket | null {
    const now = Date.now()
    const limit = this.staleMs()
    let best: { w: WebSocket; alive: number } | null = null
    const live: Array<{ w: WebSocket; alive: number }> = []
    for (const w of this.ctx.getWebSockets('host')) {
      if (w === exclude || w.readyState !== OPEN) continue
      const att = w.deserializeAttachment() as HostAtt | null
      if (!att?.authed) continue
      const alive = this.lastAlive(w, att)
      if (now - alive > limit) {
        rlog('host_stale', att.rid, { silentMs: now - alive })
        tryClose(w, RELAY_CLOSE.hostOffline, 'host_stale')
        continue
      }
      const entry = { w, alive }
      live.push(entry)
      if (!best || alive > best.alive) best = entry
    }
    for (const l of live) {
      if (l !== best) {
        const att = l.w.deserializeAttachment() as HostAtt
        rlog('host_stale', att.rid, { reason: 'superseded' })
        tryClose(l.w, RELAY_CLOSE.replaced, 'replaced')
      }
    }
    return best?.w ?? null
  }

  /** Devices that finished joining, i.e. have a connId. */
  private devices(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => (w.deserializeAttachment() as Att | null)?.role === 'dev')
  }

  private deviceById(connId: number): WebSocket | null {
    for (const w of this.devices()) {
      const a = w.deserializeAttachment() as DevAtt
      if (a.connId === connId && a.auth !== 'pending' && w.readyState === OPEN) return w
    }
    return null
  }

  private closeAllDevices(code: number, reason: string): void {
    for (const d of this.devices()) {
      d.serializeAttachment({ ...(d.deserializeAttachment() as DevAtt), dropped: true } satisfies DevAtt)
      tryClose(d, code, reason)
    }
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Att | null
    if (!att) {
      // Rejected at accept time (offline host, device cap): nothing to route.
      return
    }
    const size = typeof message === 'string' ? new TextEncoder().encode(message).length : message.byteLength
    if (size > LIMITS.maxFrameBytes) {
      rlog(att.role === 'host' ? 'host_rejected' : 'device_rejected', att.role === 'host' ? att.rid : (att.rid ?? ''), { reason: 'too_big', role: att.role, bytes: size })
      tryClose(ws, RELAY_CLOSE.tooBig, 'too_big')
      return
    }
    if (att.role === 'host') this.onHostMessage(ws, att, message)
    else this.onDeviceMessage(ws, att, message)
  }

  private onHostMessage(ws: WebSocket, att: HostAtt, message: string | ArrayBuffer): void {
    if (!att.authed) {
      let frame: { t?: string; pk?: string; sig?: string } | null = null
      if (typeof message === 'string') {
        try {
          frame = JSON.parse(message)
        } catch {
          frame = null
        }
      }
      if (frame?.t !== 'auth' || !frame.pk || !frame.sig || !verifyChallenge(att.rid, att.n, frame.pk, frame.sig)) {
        rlog('host_auth_fail', att.rid)
        tryClose(ws, RELAY_CLOSE.unauthorized, 'unauthorized')
        return
      }
      rlog('host_auth_ok', att.rid)
      // A newer host wins. The old one's devices were multiplexed on state the new
      // host does not have, so they are dropped and reconnect.
      for (const old of this.ctx.getWebSockets('host')) {
        if (old === ws) continue
        if ((old.deserializeAttachment() as HostAtt | null)?.authed) tryClose(old, RELAY_CLOSE.replaced, 'replaced')
      }
      // Junk sockets that opened but never authenticated must not hold slots against the real host.
      for (const other of this.ctx.getWebSockets('host')) {
        if (other !== ws && !(other.deserializeAttachment() as HostAtt | null)?.authed) tryClose(other, RELAY_CLOSE.rateLimited, 'pending_evicted')
      }
      this.closeAllDevices(RELAY_CLOSE.hostOffline, 'host_replaced')
      ws.serializeAttachment({ ...att, authed: true, n: '', seen: Date.now() } satisfies HostAtt)
      ws.send(JSON.stringify({ t: 'ok' }))
      return
    }

    if (typeof message === 'string') {
      if (message.length > 64 * 1024 || !message.startsWith('{"t":"tokens"')) return
      try {
        const f = JSON.parse(message) as { t?: string; set?: unknown; tickets?: unknown; enforce?: unknown }
        if (f.t === 'tokens') this.applyTokens(f)
      } catch {
        // Ignore malformed.
      }
      return
    }
    const frame = decodeMux(new Uint8Array(message))
    if (!frame) return
    const target = this.deviceById(frame.connId)
    switch (frame.kind) {
      case MuxKind.text:
        if (target) target.send(new TextDecoder().decode(frame.payload))
        else ws.send(encodeMuxClose(frame.connId, 1000, 'gone'))
        return
      case MuxKind.binary:
        if (target) target.send(frame.payload.slice().buffer)
        else ws.send(encodeMuxClose(frame.connId, 1000, 'gone'))
        return
      case MuxKind.close: {
        if (!target) return
        const { code, reason } = decodeMuxClose(frame.payload)
        tryClose(target, code, reason)
        return
      }
      default:
        return
    }
  }

  /** The credential in a `{t:'auth',tok}` frame ('' if it has no tok); undefined if it is not an auth frame. */
  private parseAuthFrame(message: string | ArrayBuffer): string | undefined {
    if (typeof message !== 'string' || message.length > 400 || !message.includes('"auth"')) return undefined
    try {
      const f = JSON.parse(message) as { t?: unknown; tok?: unknown }
      if (f.t !== 'auth') return undefined
      return typeof f.tok === 'string' ? f.tok : ''
    } catch {
      return undefined
    }
  }

  private onDeviceMessage(ws: WebSocket, att: DevAtt, message: string | ArrayBuffer): void {
    const host = this.authedHost()
    if (!host) {
      rlog('device_rejected', att.rid ?? '', { reason: 'host_offline', conn: att.connId })
      tryClose(ws, RELAY_CLOSE.hostOffline, 'host_offline')
      return
    }
    if (att.auth === 'pending') {
      // The first frame decides. A valid {t:'auth',tok} is consumed (never forwarded) and admits the device. A
      // bad token is refused without the host ever hearing of the device. Any other first frame is only
      // acceptable from a token-less device while the host is not enforcing (the transition period).
      const cred = this.parseAuthFrame(message)
      if (cred !== undefined) {
        const c = this.checkCredential(cred)
        if (!c) {
          rlog('device_rejected', att.rid ?? '', { reason: 'bad_token', conn: att.connId })
          tryClose(ws, RELAY_CLOSE.unauthorized, 'unauthorized')
          return
        }
        const next: DevAtt = { ...att, auth: c.via, h: c.h }
        delete next.lg
        ws.serializeAttachment(next)
        this.admit(ws, next, host)
        return
      }
      if (!att.lg || this.access.enforce) {
        rlog('device_rejected', att.rid ?? '', { reason: 'no_token', conn: att.connId })
        tryClose(ws, RELAY_CLOSE.unauthorized, 'unauthorized')
        return
      }
      const legacy: DevAtt = { ...att, auth: 'legacy' }
      delete legacy.lg
      ws.serializeAttachment(legacy)
      this.admit(ws, legacy, host)
      att = legacy
    } else if (att.auth === 'legacy') {
      // Legacy devices admitted by an earlier Room version may still present a token; consume it.
      const cred = this.parseAuthFrame(message)
      if (cred !== undefined) {
        const c = this.checkCredential(cred)
        if (!c) {
          rlog('device_rejected', att.rid ?? '', { reason: 'bad_token', conn: att.connId })
          tryClose(ws, RELAY_CLOSE.unauthorized, 'unauthorized')
          return
        }
        ws.serializeAttachment({ ...att, auth: c.via, h: c.h } satisfies DevAtt)
        return
      }
    }
    // After hibernation the bucket is gone; a fresh one is fine, the room was idle.
    let bucket = this.buckets.get(att.connId)
    if (!bucket) {
      bucket = new TokenBucket(LIMITS.deviceFrames, LIMITS.deviceWindowMs)
      this.buckets.set(att.connId, bucket)
    }
    if (!bucket.take()) {
      rlog('device_rejected', att.rid ?? '', { reason: 'rate_limited', conn: att.connId })
      tryClose(ws, RELAY_CLOSE.rateLimited, 'rate_limited')
      return
    }
    if (typeof message === 'string') {
      host.send(encodeMux(MuxKind.text, att.connId, new TextEncoder().encode(message)))
    } else {
      host.send(encodeMux(MuxKind.binary, att.connId, new Uint8Array(message)))
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // No close echo here: the runtime completes the handshake itself, and a second
    // close frame leaves the client's socket hanging.
    this.onGone(ws, code, reason)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    tryClose(ws, 1011, 'error')
    this.onGone(ws, 1011, 'error')
  }

  private onGone(ws: WebSocket, code: number, reason: string): void {
    const att = ws.deserializeAttachment() as Att | null
    if (!att) return
    if (att.role === 'dev') {
      rlog('device_close', att.rid ?? '', { conn: att.connId, code, reason: reason.slice(0, 40), ms: att.t0 ? Date.now() - att.t0 : undefined, dropped: att.dropped || undefined })
      this.buckets.delete(att.connId)
      // A pending device was never announced, so the host has nothing to close.
      if (att.dropped || att.auth === 'pending') return
      this.authedHost(ws)?.send(encodeMuxClose(att.connId, code, reason))
      return
    }
    rlog('host_close', att.rid, { code, reason: reason.slice(0, 40), authed: att.authed })
    // If another authed host already took over, the devices were handled then.
    if (att.authed && !this.authedHost(ws)) this.closeAllDevices(RELAY_CLOSE.hostOffline, 'host_offline')
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    let next: number | null = null
    const consider = (deadline: number): void => {
      next = next === null ? deadline : Math.min(next, deadline)
    }
    for (const w of this.ctx.getWebSockets()) {
      const att = w.deserializeAttachment() as Att | null
      if (!att) continue
      if (att.role === 'host') {
        if (att.authed) continue
        const deadline = att.t0 + LIMITS.hostAuthTimeoutMs
        if (deadline <= now + 50) {
          rlog('host_auth_fail', att.rid, { reason: 'auth_timeout' })
          tryClose(w, RELAY_CLOSE.unauthorized, 'auth_timeout')
        } else consider(deadline)
      } else if (att.auth === 'pending' && att.lg && !this.access.enforce) {
        // Silent through the grace period: a token-less (legacy) device, announced now.
        const deadline = (att.t0 ?? now) + LIMITS.legacyGraceMs
        if (deadline <= now + 50) {
          const host = this.authedHost()
          if (host && w.readyState === OPEN) {
            const legacy: DevAtt = { ...att, auth: 'legacy' }
            delete legacy.lg
            w.serializeAttachment(legacy)
            this.admit(w, legacy, host)
          } else tryClose(w, RELAY_CLOSE.hostOffline, 'host_offline')
        } else consider(deadline)
      } else if (att.auth === 'pending') {
        const deadline = (att.t0 ?? now) + LIMITS.deviceAuthTimeoutMs
        if (deadline <= now + 50) {
          rlog('device_rejected', att.rid ?? '', { reason: 'auth_timeout', conn: att.connId })
          tryClose(w, RELAY_CLOSE.unauthorized, 'auth_timeout')
        } else consider(deadline)
      }
    }
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }
}
