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
  decodeMux,
  decodeMuxClose,
  encodeMux,
  encodeMuxClose,
  newChallengeNonce,
  verifyChallenge,
} from '@dorabot-remote/protocol'
import { LIMITS, SlidingWindow, TokenBucket } from './limits.js'
import type { Env } from './index.js'

type HostAtt = { role: 'host'; rid: string; n: string; authed: boolean; t0: number }
/** `dropped` marks a device the room closed because its host went away; no one needs telling. */
type DevAtt = { role: 'dev'; connId: number; dropped?: boolean }
type Att = HostAtt | DevAtt

const OPEN = 1

/** Close codes outside 1000 and 3000-4999 throw when sent, so clamp whatever a peer asks for. */
function safeCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) || code === 1009 ? code : 1000
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const m = /^\/(h|d|rate)\/([A-Za-z0-9_-]{22})$/.exec(url.pathname)
    if (!m) return new Response('not found', { status: 404 })
    const [, route, relayId] = m as unknown as [string, string, string]

    if (route === 'rate') {
      return new Response(null, { status: this.pushWindow.allow() ? 204 : 429 })
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })

    const { 0: client, 1: server } = new WebSocketPair()
    if (route === 'h') this.acceptHost(server, relayId)
    else this.acceptDevice(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  // -------------------------------------------------------------------------
  // Accepting sockets
  // -------------------------------------------------------------------------

  private acceptHost(ws: WebSocket, relayId: string): void {
    this.ctx.acceptWebSocket(ws, ['host'])
    const pending = this.ctx.getWebSockets('host').filter((w) => !(w.deserializeAttachment() as HostAtt | null)?.authed)
    // The fresh socket has no attachment yet, so it is counted as pending above.
    if (pending.length > LIMITS.maxPendingHosts) {
      rejectSoon(ws, RELAY_CLOSE.rateLimited, 'too_many_pending')
      return
    }
    const n = newChallengeNonce()
    ws.serializeAttachment({ role: 'host', rid: relayId, n, authed: false, t0: Date.now() } satisfies HostAtt)
    ws.send(JSON.stringify({ t: 'challenge', n }))
    // setTimeout would not survive hibernation; an alarm does.
    void this.ctx.storage.getAlarm().then((a) => {
      if (a === null) return this.ctx.storage.setAlarm(Date.now() + LIMITS.hostAuthTimeoutMs)
    })
  }

  private acceptDevice(ws: WebSocket): void {
    this.ctx.acceptWebSocket(ws)
    const host = this.authedHost()
    if (!host) {
      rejectSoon(ws, RELAY_CLOSE.hostOffline, 'host_offline')
      return
    }
    const devices = this.devices()
    if (devices.length >= LIMITS.maxDevices) {
      rejectSoon(ws, RELAY_CLOSE.rateLimited, 'too_many_devices')
      return
    }
    const used = new Set(devices.map((d) => (d.deserializeAttachment() as DevAtt | null)?.connId))
    let connId = 0
    do {
      connId = crypto.getRandomValues(new Uint32Array(1))[0]!
    } while (connId === 0 || used.has(connId))
    ws.serializeAttachment({ role: 'dev', connId } satisfies DevAtt)
    this.buckets.set(connId, new TokenBucket(LIMITS.deviceFrames, LIMITS.deviceWindowMs))
    host.send(encodeMux(MuxKind.open, connId))
  }

  private authedHost(exclude?: WebSocket): WebSocket | null {
    for (const w of this.ctx.getWebSockets('host')) {
      if (w === exclude || w.readyState !== OPEN) continue
      if ((w.deserializeAttachment() as HostAtt | null)?.authed) return w
    }
    return null
  }

  /** Devices that finished joining, i.e. have a connId. */
  private devices(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => (w.deserializeAttachment() as Att | null)?.role === 'dev')
  }

  private deviceById(connId: number): WebSocket | null {
    for (const w of this.devices()) {
      if ((w.deserializeAttachment() as DevAtt).connId === connId && w.readyState === OPEN) return w
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
        tryClose(ws, RELAY_CLOSE.unauthorized, 'unauthorized')
        return
      }
      // A newer host wins. The old one's devices were multiplexed on state the new
      // host does not have, so they are dropped and reconnect.
      for (const old of this.ctx.getWebSockets('host')) {
        if (old === ws) continue
        if ((old.deserializeAttachment() as HostAtt | null)?.authed) tryClose(old, RELAY_CLOSE.replaced, 'replaced')
      }
      this.closeAllDevices(RELAY_CLOSE.hostOffline, 'host_replaced')
      ws.serializeAttachment({ ...att, authed: true, n: '' } satisfies HostAtt)
      ws.send(JSON.stringify({ t: 'ok' }))
      return
    }

    if (typeof message === 'string') return
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

  private onDeviceMessage(ws: WebSocket, att: DevAtt, message: string | ArrayBuffer): void {
    const host = this.authedHost()
    if (!host) {
      tryClose(ws, RELAY_CLOSE.hostOffline, 'host_offline')
      return
    }
    // After hibernation the bucket is gone; a fresh one is fine, the room was idle.
    let bucket = this.buckets.get(att.connId)
    if (!bucket) {
      bucket = new TokenBucket(LIMITS.deviceFrames, LIMITS.deviceWindowMs)
      this.buckets.set(att.connId, bucket)
    }
    if (!bucket.take()) {
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
      this.buckets.delete(att.connId)
      if (att.dropped) return
      this.authedHost(ws)?.send(encodeMuxClose(att.connId, code, reason))
      return
    }
    // If another authed host already took over, the devices were handled then.
    if (att.authed && !this.authedHost(ws)) this.closeAllDevices(RELAY_CLOSE.hostOffline, 'host_offline')
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    let next: number | null = null
    for (const w of this.ctx.getWebSockets('host')) {
      const att = w.deserializeAttachment() as HostAtt | null
      if (!att || att.authed) continue
      const deadline = att.t0 + LIMITS.hostAuthTimeoutMs
      if (deadline <= now + 50) tryClose(w, RELAY_CLOSE.unauthorized, 'auth_timeout')
      else next = next === null ? deadline : Math.min(next, deadline)
    }
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }
}
