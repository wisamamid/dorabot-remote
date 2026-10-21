/**
 * APNs direct sender. Provider token auth (ES256 JWT) over HTTP/2 via fetch.
 * Payloads are contentless: only the generic per-kind text, a kind tag and an
 * opaque routing id. Never log tokens or payloads.
 */
import type { PushBody } from './push.js'

export interface ApnsConfig {
  /** PKCS8 PEM of the .p8 AuthKey. */
  keyP8: string
  keyId: string
  teamId: string
  topic: string
}

export interface ApnsCache {
  jwt?: string
  /** unix ms when minted */
  mintedAt?: number
  /** identifies the config the jwt was minted for */
  fingerprint?: string
}

const sharedCache: ApnsCache = {}
/** Apple wants a fresh token between 20 and 60 minutes old. */
const JWT_TTL_MS = 50 * 60 * 1000

export const APNS_DEFAULT_TOPIC = 'com.xische.dorabotremote'

const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uText = (s: string): string => b64u(new TextEncoder().encode(s))

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/** WebCrypto already returns raw r||s (IEEE P1363) for ECDSA, which is what JWS ES256 wants. */
export async function mintApnsJwt(cfg: Pick<ApnsConfig, 'keyP8' | 'keyId' | 'teamId'>, nowSec: number): Promise<string> {
  const header = b64uText(JSON.stringify({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }))
  const claims = b64uText(JSON.stringify({ iss: cfg.teamId, iat: nowSec }))
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(cfg.keyP8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${claims}`))
  return `${header}.${claims}.${b64u(new Uint8Array(sig))}`
}

export async function getApnsJwt(cfg: ApnsConfig, now: number, cache: ApnsCache = sharedCache): Promise<string> {
  const fp = `${cfg.keyId}:${cfg.teamId}`
  if (cache.jwt && cache.mintedAt !== undefined && cache.fingerprint === fp && now - cache.mintedAt < JWT_TTL_MS) return cache.jwt
  cache.jwt = await mintApnsJwt(cfg, Math.floor(now / 1000))
  cache.mintedAt = now
  cache.fingerprint = fp
  return cache.jwt
}

const TEXT = {
  question: { title: 'dorabot has a question', body: 'Tap to answer' },
  approval: { title: 'dorabot needs approval', body: 'Tap to review' },
  result: { title: 'Run finished', body: 'Tap to view' },
  error: { title: 'Run failed', body: 'Tap to view' },
} as const

const collapseId = (rid: string): string => rid.slice(0, 64)

const CATEGORY = { question: 'QUESTION', approval: 'APPROVAL', result: 'ACTIVITY', error: 'ACTIVITY' } as const

export function buildApnsPayload(kind: keyof typeof TEXT, rid?: string, enc?: string, kid?: string): Record<string, unknown> {
  const text = TEXT[kind]
  if (enc) {
    // The title/body here are placeholders; the Notification Service Extension swaps
    // in the decrypted text. `enc` is opaque to us. If the NSE cannot decrypt, the
    // generic text is what the user sees.
    return {
      aps: {
        alert: { title: text.title, body: text.body },
        sound: 'default',
        'mutable-content': 1,
        category: CATEGORY[kind],
        'thread-id': kind,
        'interruption-level': kind === 'question' ? 'time-sensitive' : 'active',
      },
      k: kind,
      ...(rid ? { rid } : {}),
      enc,
      ...(kid ? { kid } : {}),
    }
  }
  return {
    aps: {
      alert: { title: text.title, body: text.body },
      sound: 'default',
      'thread-id': kind,
      'interruption-level': kind === 'question' ? 'time-sensitive' : 'active',
    },
    k: kind,
    ...(rid ? { rid } : {}),
  }
}

export function apnsHeaders(kind: keyof typeof TEXT, rid: string | undefined, jwt: string, topic: string, nowSec: number): Record<string, string> {
  const ttl = kind === 'question' ? 300 : 24 * 3600
  return {
    authorization: `bearer ${jwt}`,
    'apns-topic': topic,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': String(nowSec + ttl),
    'content-type': 'application/json',
    ...(rid ? { 'apns-collapse-id': collapseId(rid) } : {}),
  }
}

export type ApnsResult = { status: 200 | 204 | 410 | 502; body: Record<string, unknown> }

export async function sendApns(body: PushBody, cfg: ApnsConfig, fetchFn: typeof fetch, now: number, cache?: ApnsCache): Promise<ApnsResult> {
  // Withdraw is not implemented for iOS yet; acknowledge without sending.
  if (body.kind === 'withdraw') return { status: 204, body: {} }
  const host = body.env === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'
  const jwt = await getApnsJwt(cfg, now, cache)
  // After filtering 'withdraw', kind is one of the TEXT keys
  const kind = body.kind as keyof typeof TEXT
  const res = await fetchFn(`https://${host}/3/device/${encodeURIComponent(body.token)}`, {
    method: 'POST',
    headers: apnsHeaders(kind, body.rid, jwt, cfg.topic, Math.floor(now / 1000)),
    body: JSON.stringify(buildApnsPayload(kind, body.rid, body.enc, body.kid)),
  })
  if (res.ok) return { status: 200, body: { ok: true } }
  let reason = ''
  try {
    reason = String(((await res.json()) as { reason?: unknown }).reason ?? '')
  } catch {
    // no body
  }
  if (res.status === 410 || (res.status === 400 && reason === 'BadDeviceToken')) return { status: 410, body: { error: 'unregistered' } }
  // 403 ExpiredProviderToken: drop the cached jwt so the next call re-mints.
  if (res.status === 403) (cache ?? sharedCache).jwt = undefined
  return { status: 502, body: { error: 'push_failed', status: res.status, ...(reason ? { reason } : {}) } }
}
