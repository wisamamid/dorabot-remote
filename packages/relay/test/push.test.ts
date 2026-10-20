import { generateSigningKey, relayIdFromPublicKey, signBytes } from '@dorabot-remote/protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildFcmMessage, handlePush, parsePushBody, type PushBody, type PushDeps, type TokenCache } from '../src/push.js'

let serviceAccount: string
let publicKey: CryptoKey

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  publicKey = pair.publicKey
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`
  serviceAccount = JSON.stringify({
    client_email: 'relay@proj.iam.gserviceaccount.com',
    private_key: pem,
    project_id: 'proj-1',
    token_uri: 'https://oauth.test/token',
  })
})

const key = generateSigningKey()
const relayId = relayIdFromPublicKey(key.publicKey)

const body = (over: Partial<PushBody> = {}): PushBody => ({
  token: 'device-token-1234',
  platform: 'android',
  kind: 'question',
  rid: 'req-1',
  ts: Date.now(),
  ...over,
})

function signed(b: unknown, k = key, id = relayId): { req: Request; id: string } {
  const raw = typeof b === 'string' ? b : JSON.stringify(b)
  const { pk, sig } = signBytes(k, new TextEncoder().encode(raw))
  return { id, req: new Request(`https://relay.test/push/${id}`, { method: 'POST', body: raw, headers: { 'x-dr-pk': pk, 'x-dr-sig': sig } }) }
}

interface Call {
  url: string
  init: RequestInit
}

function harness(over: Partial<PushDeps> = {}, fcmStatus = 200) {
  const calls: Call[] = []
  const cache: TokenCache = {}
  const deps: PushDeps = {
    serviceAccount,
    now: () => Date.now(),
    rateLimit: async () => true,
    dedupe: async () => true,
    cache,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url === 'https://oauth.test/token') return Response.json({ access_token: 'at-1', expires_in: 3600 })
      return new Response('{}', { status: fcmStatus })
    }) as typeof fetch,
    ...over,
  }
  return { calls, deps }
}

describe('handlePush', () => {
  it('returns 503 push_not_configured when the secret is absent', async () => {
    const { deps, calls } = harness({ serviceAccount: undefined })
    const { req, id } = signed(body())
    const res = await handlePush(req, id, deps)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'push_not_configured' })
    expect(calls).toHaveLength(0)
  })

  describe('replay guard', () => {
    const memory = () => {
      const seen = new Set<string>()
      return {
        dedupe: async (k: string) => (seen.has(k) ? false : (seen.add(k), true)),
        forget: async (k: string) => void seen.delete(k),
      }
    }

    it('rejects a replayed signed body with 409 and sends nothing the second time', async () => {
      const { deps, calls } = harness(memory())
      const first = signed(body())
      const raw = await first.req.clone().text()
      expect((await handlePush(first.req, relayId, deps)).status).toBe(200)
      const n = calls.length
      const replay = new Request(first.req.url, { method: 'POST', body: raw, headers: first.req.headers })
      const res = await handlePush(replay, relayId, deps)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'duplicate' })
      expect(calls).toHaveLength(n)
    })

    it('dedupes on (rid, kind, token) even when ts differs, but not across kinds, rids or devices', async () => {
      const { deps } = harness(memory())
      const send = async (o: Partial<PushBody>) => (await handlePush(signed(body(o)).req, relayId, deps)).status
      expect(await send({ ts: Date.now() })).toBe(200)
      expect(await send({ ts: Date.now() + 5 })).toBe(409)
      expect(await send({ kind: 'approval' })).toBe(200)
      expect(await send({ rid: 'req-2' })).toBe(200)
      expect(await send({ token: 'another-device-token' })).toBe(200)
    })

    it('does not burn the key when the send fails, so a retry goes through', async () => {
      const m = memory()
      const failing = harness(m, 500)
      expect((await handlePush(signed(body()).req, relayId, failing.deps)).status).toBe(502)
      const ok = harness(m, 200)
      expect((await handlePush(signed(body()).req, relayId, ok.deps)).status).toBe(200)
    })

    it('a bad signature never reaches the guard', async () => {
      let asked = 0
      const { deps } = harness({ dedupe: async () => (asked++, true) })
      await handlePush(signed(body(), generateSigningKey()).req, relayId, deps)
      expect(asked).toBe(0)
    })
  })

  it('rejects a bad signature, a foreign key, a mismatched relayId and a stale timestamp', async () => {
    const { deps, calls } = harness()
    const tampered = signed(body())
    const raw = await tampered.req.clone().text()
    const forged = new Request(tampered.req.url, {
      method: 'POST',
      body: raw.replace('question', 'approval'),
      headers: tampered.req.headers,
    })
    expect((await handlePush(forged, relayId, deps)).status).toBe(401)
    expect((await handlePush(signed(body(), generateSigningKey()).req, relayId, deps)).status).toBe(401)
    const other = relayIdFromPublicKey(generateSigningKey().publicKey)
    expect((await handlePush(signed(body()).req, other, deps)).status).toBe(401)
    expect((await handlePush(signed(body({ ts: Date.now() - 61_000 })).req, relayId, deps)).status).toBe(400)
    expect((await handlePush(signed(body({ ts: Date.now() + 61_000 })).req, relayId, deps)).status).toBe(400)
    expect((await handlePush(signed({ nope: 1 }).req, relayId, deps)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('exchanges a service-account JWT, then posts to FCM v1 with the bearer token', async () => {
    const { deps, calls } = harness()
    const res = await handlePush(signed(body()).req, relayId, deps)
    expect(res.status).toBe(200)
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth.test/token',
      'https://fcm.googleapis.com/v1/projects/proj-1/messages:send',
    ])

    const form = new URLSearchParams(String(calls[0]!.init.body))
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [h, c, s] = form.get('assertion')!.split('.') as [string, string, string]
    const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, '+').replace(/_/g, '/')))
    expect(dec(h)).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = dec(c)
    expect(claims.iss).toBe('relay@proj.iam.gserviceaccount.com')
    expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging')
    expect(claims.exp - claims.iat).toBe(3600)
    const std = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
    const sigBytes = Uint8Array.from(atob(std), (ch) => ch.charCodeAt(0))
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, sigBytes, new TextEncoder().encode(`${h}.${c}`))).toBe(true)

    const fcm = calls[1]!.init
    expect((fcm.headers as Record<string, string>).authorization).toBe('Bearer at-1')
    expect(JSON.parse(String(fcm.body))).toEqual(buildFcmMessage(body({ ts: 0 }) as PushBody, relayId))
  })

  it('caches the access token across pushes', async () => {
    const { deps, calls } = harness()
    await handlePush(signed(body()).req, relayId, deps)
    await handlePush(signed(body({ rid: 'req-2' })).req, relayId, deps)
    expect(calls.filter((c) => c.url === 'https://oauth.test/token')).toHaveLength(1)
    expect(calls.filter((c) => c.url.includes('messages:send'))).toHaveLength(2)
  })

  it('refreshes the token once it is near expiry', async () => {
    let t = Date.now()
    const { deps, calls } = harness({ now: () => t })
    await handlePush(signed(body({ ts: t })).req, relayId, deps)
    t += 3600_000 - 30_000
    await handlePush(signed(body({ ts: t })).req, relayId, deps)
    expect(calls.filter((c) => c.url === 'https://oauth.test/token')).toHaveLength(2)
  })

  it('maps rate limiting and FCM failures', async () => {
    expect((await handlePush(signed(body()).req, relayId, harness({ rateLimit: async () => false }).deps)).status).toBe(429)
    expect((await handlePush(signed(body()).req, relayId, harness({}, 404).deps)).status).toBe(410)
    expect((await handlePush(signed(body()).req, relayId, harness({}, 500).deps)).status).toBe(502)
  })
})

describe('buildFcmMessage', () => {
  const msg = (b: Partial<PushBody>) => buildFcmMessage(body({ platform: 'ios', ...b }), relayId).message as Record<string, any>

  it('is contentless: only a kind, a routing id and the relayId travel in data', () => {
    const m = msg({ kind: 'approval', rid: 'abc' })
    expect(m.data).toEqual({ t: 'approval', rid: 'abc', h: relayId })
    expect(JSON.stringify(m)).not.toMatch(/sessionKey|toolName|command/)
  })

  it('omits rid when absent', () => {
    expect(msg({ rid: undefined }).data).toEqual({ t: 'question', h: relayId })
  })

  it('question on iOS is time-sensitive, priority 10, category DR_QUESTION', () => {
    const m = msg({ kind: 'question' })
    expect(m.notification).toEqual({ title: 'dorabot has a question', body: 'Tap to answer' })
    expect(m.apns.headers).toMatchObject({ 'apns-priority': '10', 'apns-push-type': 'alert', 'apns-collapse-id': 'req-1' })
    expect(m.apns.payload.aps).toMatchObject({ 'interruption-level': 'time-sensitive', category: 'DR_QUESTION' })
  })

  it('approval on iOS is active, DR_APPROVAL, threaded by rid', () => {
    const m = msg({ kind: 'approval', rid: 'r9' })
    expect(m.notification).toEqual({ title: 'dorabot needs approval', body: 'Tap to review' })
    expect(m.apns.headers['apns-priority']).toBe('10')
    expect(m.apns.payload.aps).toMatchObject({ 'interruption-level': 'active', category: 'DR_APPROVAL', 'thread-id': 'r9' })
  })

  it('result and error on iOS are passive, priority 5', () => {
    for (const [kind, title] of [['result', 'Run finished'], ['error', 'Run failed']] as const) {
      const m = msg({ kind })
      expect(m.notification.title).toBe(title)
      expect(m.apns.headers['apns-priority']).toBe('5')
      expect(m.apns.payload.aps['interruption-level']).toBe('passive')
      expect(m.apns.payload.aps.category).toBeUndefined()
    }
  })

  it('withdraw is a silent background push carrying only t and rid', () => {
    const m = msg({ kind: 'withdraw', rid: 'r1' })
    expect(m.notification).toBeUndefined()
    expect(m.data).toEqual({ t: 'withdraw', rid: 'r1', h: relayId })
    expect(m.apns.headers).toMatchObject({ 'apns-push-type': 'background', 'apns-priority': '5', 'apns-collapse-id': 'r1' })
    expect(m.apns.payload.aps).toEqual({ 'content-available': 1 })
  })

  it('android: high priority and the right channel per kind', () => {
    const q = msg({ platform: 'android', kind: 'question' })
    expect(q.apns).toBeUndefined()
    expect(q.android).toMatchObject({ priority: 'HIGH', collapse_key: 'req-1', notification: { channel_id: 'questions' } })
    expect(msg({ platform: 'android', kind: 'approval' }).android.notification.channel_id).toBe('approvals')
    const r = msg({ platform: 'android', kind: 'result' })
    expect(r.android).toMatchObject({ priority: 'NORMAL', notification: { channel_id: 'activity' } })
    const w = msg({ platform: 'android', kind: 'withdraw' })
    expect(w.android).toEqual({ priority: 'NORMAL', collapse_key: 'req-1' })
  })
})

describe('parsePushBody', () => {
  it('validates shape', () => {
    expect(parsePushBody(JSON.stringify(body()))).not.toBeNull()
    expect(parsePushBody('nope')).toBeNull()
    expect(parsePushBody(JSON.stringify(body({ platform: 'windows' as never })))).toBeNull()
    expect(parsePushBody(JSON.stringify(body({ kind: 'spam' as never })))).toBeNull()
    expect(parsePushBody(JSON.stringify(body({ token: 'x' })))).toBeNull()
    expect(parsePushBody(JSON.stringify(body({ rid: 'r'.repeat(200) })))).toBeNull()
  })
})
