/**
 * Push, server side. The relay is blind, so a push says only *that* something
 * happened (a question, an approval, a result) and carries a routing id the app
 * uses to open the right place. Anything readable is fetched over the E2E channel
 * after the user taps.
 */
import { isRelayId, verifyForRelayId } from '@dorabot-remote/protocol'
import { APNS_DEFAULT_TOPIC, sendApns, type ApnsCache } from './apns.js'
import { LIMITS } from './limits.js'

export const PUSH_KINDS = ['question', 'approval', 'result', 'error', 'alert', 'withdraw'] as const
export type PushKind = (typeof PUSH_KINDS)[number]

export interface PushBody {
  token: string
  platform: 'ios' | 'android'
  kind: PushKind
  rid?: string
  /** iOS only: which APNs environment the token belongs to. Defaults to production. */
  env?: 'production' | 'sandbox'
  /** iOS only: opaque E2E-encrypted content (base64) for the Notification Service Extension. Never decrypted here. */
  enc?: string
  /** iOS only: short key id (which stored push key opens `enc`), so the NSE can pick the right Mac's key. Not secret. */
  kid?: string
  ts: number
}

export const MAX_ENC_CHARS = 3000
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
export const MAX_KID_CHARS = 16
const KID_RE = /^[A-Za-z0-9_-]+$/
export interface ServiceAccount {
  client_email: string
  private_key: string
  project_id: string
  token_uri?: string
}

export function parsePushBody(raw: string): PushBody | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const { token, platform, kind, rid, ts, env, enc, kid } = v
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096) return null
  if (platform !== 'ios' && platform !== 'android') return null
  if (typeof kind !== 'string' || !(PUSH_KINDS as readonly string[]).includes(kind)) return null
  if (rid !== undefined && (typeof rid !== 'string' || rid.length === 0 || rid.length > 128)) return null
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null
  if (env !== undefined && env !== 'production' && env !== 'sandbox') return null
  if (enc !== undefined && (typeof enc !== 'string' || enc.length === 0 || enc.length > MAX_ENC_CHARS || !B64_RE.test(enc))) return null
  if (kid !== undefined && (typeof kid !== 'string' || kid.length === 0 || kid.length > MAX_KID_CHARS || !KID_RE.test(kid))) return null
  return {
    token,
    platform,
    kind: kind as PushKind,
    rid: rid as string | undefined,
    ts,
    ...(env ? { env } : {}),
    ...(enc ? { enc: enc as string } : {}),
    ...(kid ? { kid: kid as string } : {}),
  }
}

// ---------------------------------------------------------------------------
// Message shape
// ---------------------------------------------------------------------------

const TEXT: Record<Exclude<PushKind, 'withdraw'>, { title: string; body: string }> = {
  question: { title: 'dorabot has a question', body: 'Tap to answer' },
  approval: { title: 'dorabot needs approval', body: 'Tap to review' },
  result: { title: 'Run finished', body: 'Tap to view' },
  error: { title: 'Run failed', body: 'Tap to view' },
  alert: { title: 'dorabot remote', body: 'Your Mac lost its connection to the relay' },
}

const CHANNEL: Record<Exclude<PushKind, 'withdraw'>, string> = {
  question: 'questions',
  approval: 'approvals',
  result: 'activity',
  error: 'activity',
  alert: 'activity',
}

const IOS: Record<Exclude<PushKind, 'withdraw'>, { priority: string; level: string; category?: string }> = {
  question: { priority: '10', level: 'time-sensitive', category: 'DR_QUESTION' },
  approval: { priority: '10', level: 'active', category: 'DR_APPROVAL' },
  result: { priority: '5', level: 'passive' },
  error: { priority: '5', level: 'passive' },
  alert: { priority: '10', level: 'active', category: 'ACTIVITY' },
}

/** apns-collapse-id may not exceed 64 bytes. */
const collapseId = (rid: string): string => rid.slice(0, 64)

export function buildFcmMessage(body: PushBody, relayId: string): { message: Record<string, unknown> } {
  const { kind, rid, token } = body
  const data: Record<string, string> = { t: kind, h: relayId }
  if (rid) data.rid = rid
  const message: Record<string, unknown> = { token, data }

  if (kind === 'withdraw') {
    // Data-only so the app can clear the notification without showing anything.
    if (body.platform === 'ios') {
      message.apns = {
        headers: {
          'apns-push-type': 'background',
          'apns-priority': '5',
          ...(rid ? { 'apns-collapse-id': collapseId(rid) } : {}),
        },
        payload: { aps: { 'content-available': 1 } },
      }
    } else {
      message.android = { priority: 'NORMAL', ...(rid ? { collapse_key: collapseId(rid) } : {}) }
    }
    return { message }
  }

  const text = TEXT[kind]
  if (body.platform === 'ios') {
    const i = IOS[kind]
    message.notification = { title: text.title, body: text.body }
    message.apns = {
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': i.priority,
        ...(rid ? { 'apns-collapse-id': collapseId(rid) } : {}),
      },
      payload: {
        aps: {
          sound: 'default',
          'interruption-level': i.level,
          ...(i.category ? { category: i.category } : {}),
          ...(kind === 'approval' && rid ? { 'thread-id': rid } : {}),
        },
      },
    }
  } else {
    message.android = {
      priority: kind === 'question' || kind === 'approval' ? 'HIGH' : 'NORMAL',
      ...(rid ? { collapse_key: collapseId(rid) } : {}),
      notification: { title: text.title, body: text.body, channel_id: CHANNEL[kind] },
    }
  }
  return { message }
}

// ---------------------------------------------------------------------------
// FCM HTTP v1
// ---------------------------------------------------------------------------

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uText = (s: string): string => b64u(new TextEncoder().encode(s))

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

async function mintJwt(sa: ServiceAccount, nowSec: number): Promise<string> {
  const header = b64uText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64uText(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  )
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`))
  return `${header}.${claims}.${b64u(new Uint8Array(sig))}`
}

export interface TokenCache {
  token?: string
  /** unix ms */
  expiresAt?: number
}

/** Module scope survives across requests within an isolate; that is the cache we want. */
const sharedCache: TokenCache = {}

export async function getAccessToken(
  sa: ServiceAccount,
  fetchFn: typeof fetch,
  now: number,
  cache: TokenCache = sharedCache,
): Promise<string> {
  if (cache.token && cache.expiresAt && cache.expiresAt - 60_000 > now) return cache.token
  const res = await fetchFn(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await mintJwt(sa, Math.floor(now / 1000)),
    }),
  })
  if (!res.ok) throw new Error(`oauth ${res.status}`)
  const j = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!j.access_token) throw new Error('oauth: no access_token')
  cache.token = j.access_token
  cache.expiresAt = now + (j.expires_in ?? 3600) * 1000
  return j.access_token
}

export interface PushDeps {
  /** The FCM_SERVICE_ACCOUNT secret, raw JSON. */
  serviceAccount: string | undefined
  fetch: typeof fetch
  now: () => number
  /** True if this relayId is still within its push budget. */
  rateLimit: () => Promise<boolean>
  /**
   * Replay guard: true the first time `key` is seen within the dedupe window (and records it),
   * false for a repeat. `forget` un-records it after a failed send so a retry is not refused.
   */
  dedupe: (key: string) => Promise<boolean>
  forget?: (key: string) => Promise<void>
  cache?: TokenCache
  /** APNs credentials (Worker secrets); absent means iOS push is off. */
  apns?: { keyP8?: string; keyId?: string; teamId?: string; topic?: string }
  apnsCache?: ApnsCache
}

/** (rid, kind, device token) when there is a rid; otherwise the exact body, which carries its own ts. */
async function dedupeKey(body: PushBody, raw: Uint8Array): Promise<string> {
  const material = body.rid ? new TextEncoder().encode(`${body.rid}\n${body.kind}\n${body.platform}\n${body.token}`) : raw
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', material))
  return Array.from(d.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * Order matters: authenticate first so an anonymous caller learns nothing about
 * configuration or rate state, and never log the body, which holds a device token.
 */
export async function handlePush(request: Request, relayId: string, deps: PushDeps): Promise<Response> {
  if (!isRelayId(relayId)) return json(404, { error: 'not_found' })
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > LIMITS.pushMaxBodyBytes) return json(413, { error: 'too_large' })
  const raw = new Uint8Array(await request.arrayBuffer())
  if (raw.length > LIMITS.pushMaxBodyBytes) return json(413, { error: 'too_large' })

  const pk = request.headers.get('x-dr-pk')
  const sig = request.headers.get('x-dr-sig')
  if (!pk || !sig || !verifyForRelayId(relayId, pk, sig, raw)) return json(401, { error: 'bad_signature' })

  const body = parsePushBody(new TextDecoder().decode(raw))
  if (!body) return json(400, { error: 'bad_request' })
  if (Math.abs(deps.now() - body.ts) >= LIMITS.pushMaxAgeMs) return json(400, { error: 'stale_timestamp' })

  // A signed body is valid for 60s, so without this a captured one could be replayed (and re-sent to the
  // phone) for that whole minute. Keyed per device token, so one event fanned out to several phones is fine.
  const key = await dedupeKey(body, raw)
  if (!(await deps.dedupe(key))) return json(409, { error: 'duplicate' })
  const forget = (): Promise<void> => deps.forget?.(key) ?? Promise.resolve()

  if (body.platform === 'ios') {
    const a = deps.apns
    if (!a?.keyP8 || !a.keyId || !a.teamId) {
      await forget()
      return json(503, { error: 'push_not_configured' })
    }
    if (!(await deps.rateLimit())) {
      await forget()
      return json(429, { error: 'rate_limited' })
    }
    try {
      const r = await sendApns(
        body,
        { keyP8: a.keyP8.replace(/\\n/g, '\n'), keyId: a.keyId, teamId: a.teamId, topic: a.topic || APNS_DEFAULT_TOPIC },
        deps.fetch,
        deps.now(),
        deps.apnsCache,
      )
      if (r.status >= 500) await forget()
      return r.status === 204 ? new Response(null, { status: 204 }) : json(r.status, r.body)
    } catch {
      await forget()
      return json(502, { error: 'push_failed' })
    }
  }

  if (!deps.serviceAccount) {

    await forget()

    return json(503, { error: 'push_not_configured' })

  }
  let sa: ServiceAccount
  try {
    sa = JSON.parse(deps.serviceAccount) as ServiceAccount
    if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('incomplete')
  } catch {
    await forget()
    return json(503, { error: 'push_not_configured' })
  }

  if (!(await deps.rateLimit())) {

    await forget()

    return json(429, { error: 'rate_limited' })

  }

  try {
    const accessToken = await getAccessToken(sa, deps.fetch, deps.now(), deps.cache)
    const res = await deps.fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildFcmMessage(body, relayId)),
    })
    if (res.ok) return json(200, { ok: true })
    // 404 (UNREGISTERED) and 400 INVALID_ARGUMENT both mean this token is dead.
    if (res.status === 404 || res.status === 400) return json(410, { error: 'token_invalid' })
    await forget()
    return json(502, { error: 'push_failed', status: res.status })
  } catch {
    await forget()
    return json(502, { error: 'push_failed' })
  }
}
