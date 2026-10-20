import { generateSigningKey, relayIdFromPublicKey, signBytes } from '@dorabot-remote/protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildApnsPayload, getApnsJwt, type ApnsCache } from '../src/apns.js'
import { handlePush, parsePushBody, type PushBody, type PushDeps } from '../src/push.js'

let keyP8: string
let publicKey: CryptoKey

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  publicKey = pair.publicKey
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  keyP8 = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`
})

const key = generateSigningKey()
const relayId = relayIdFromPublicKey(key.publicKey)
const TOKEN = 'ab'.repeat(32)
const body = (over: Partial<PushBody> = {}): PushBody => ({ token: TOKEN, platform: 'ios', kind: 'question', rid: 'req-1', ts: Date.now(), ...over })
const signed = (b: unknown): Request => {
  const raw = JSON.stringify(b)
  const { pk, sig } = signBytes(key, new TextEncoder().encode(raw))
  return new Request(`https://relay.test/push/${relayId}`, { method: 'POST', body: raw, headers: { 'x-dr-pk': pk, 'x-dr-sig': sig } })
}

function harness(status = 200, reason?: string, over: Partial<PushDeps> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const apnsCache: ApnsCache = {}
  const deps: PushDeps = {
    serviceAccount: undefined,
    now: () => Date.now(),
    rateLimit: async () => true,
    dedupe: async () => true,
    apns: { keyP8, keyId: 'KEY1234567', teamId: 'TEAM123456' },
    apnsCache,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response(reason ? JSON.stringify({ reason }) : '', { status })
    }) as typeof fetch,
    ...over,
  }
  return { calls, deps }
}
const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, '+').replace(/_/g, '/')))

describe('APNs', () => {
  it('sends a contentless alert with the right url, headers and payload', async () => {
    const { deps, calls } = harness()
    const res = await handlePush(signed(body()), relayId, deps)
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://api.push.apple.com/3/device/${TOKEN}`)
    const h = calls[0]!.init.headers as Record<string, string>
    expect(h['apns-topic']).toBe('com.xische.dorabotremote')
    expect(h['apns-push-type']).toBe('alert')
    expect(h['apns-priority']).toBe('10')
    expect(h['apns-collapse-id']).toBe('req-1')
    expect(Number(h['apns-expiration']) - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(298)
    expect(Number(h['apns-expiration']) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(302)
    expect(h.authorization).toMatch(/^bearer ey/)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      aps: {
        alert: { title: 'dorabot has a question', body: 'Tap to answer' },
        sound: 'default',
        'thread-id': 'question',
        'interruption-level': 'time-sensitive',
      },
      k: 'question',
      rid: 'req-1',
    })
  })

  it('approvals are active and live a day; custom topic honoured', async () => {
    const { deps, calls } = harness(200, undefined, { apns: { keyP8, keyId: 'K', teamId: 'T', topic: 'com.example.x' } })
    await handlePush(signed(body({ kind: 'approval', rid: undefined })), relayId, deps)
    const h = calls[0]!.init.headers as Record<string, string>
    expect(h['apns-topic']).toBe('com.example.x')
    expect(h['apns-collapse-id']).toBeUndefined()
    expect(Number(h['apns-expiration']) - Math.floor(Date.now() / 1000)).toBeGreaterThan(80_000)
    expect(JSON.parse(String(calls[0]!.init.body)).aps['interruption-level']).toBe('active')
  })

  it('routes sandbox tokens to the sandbox host', async () => {
    const { deps, calls } = harness()
    await handlePush(signed(body({ env: 'sandbox' })), relayId, deps)
    expect(calls[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`)
  })

  it('rejects an unknown env', async () => {
    const { deps, calls } = harness()
    expect((await handlePush(signed({ ...body(), env: 'staging' }), relayId, deps)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('mints an ES256 JWT with a verifiable raw r||s signature', async () => {
    const { deps, calls } = harness()
    await handlePush(signed(body()), relayId, deps)
    const jwt = (calls[0]!.init.headers as Record<string, string>).authorization!.slice('bearer '.length)
    const [h, c, s] = jwt.split('.') as [string, string, string]
    expect(dec(h)).toEqual({ alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' })
    const claims = dec(c)
    expect(claims.iss).toBe('TEAM123456')
    expect(Math.abs(claims.iat - Date.now() / 1000)).toBeLessThan(5)
    const std = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
    const sig = Uint8Array.from(atob(std), (ch) => ch.charCodeAt(0))
    expect(sig.length).toBe(64)
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, new TextEncoder().encode(`${h}.${c}`))).toBe(true)
  })

  it('caches the provider token for ~50 minutes, then re-mints', async () => {
    const cfg = { keyP8, keyId: 'K', teamId: 'T', topic: 'x' }
    const cache: ApnsCache = {}
    const t0 = 1_700_000_000_000
    const a = await getApnsJwt(cfg, t0, cache)
    expect(await getApnsJwt(cfg, t0 + 49 * 60_000, cache)).toBe(a)
    const b = await getApnsJwt(cfg, t0 + 51 * 60_000, cache)
    expect(b).not.toBe(a)
  })

  it('maps 410 and 400 BadDeviceToken to unregistered, other failures to 502', async () => {
    let r = await handlePush(signed(body()), relayId, harness(410, 'Unregistered').deps)
    expect(r.status).toBe(410)
    expect(await r.json()).toEqual({ error: 'unregistered' })
    r = await handlePush(signed(body()), relayId, harness(400, 'BadDeviceToken').deps)
    expect(r.status).toBe(410)
    r = await handlePush(signed(body()), relayId, harness(400, 'PayloadEmpty').deps)
    expect(r.status).toBe(502)
    r = await handlePush(signed(body()), relayId, harness(503).deps)
    expect(r.status).toBe(502)
  })

  it('503 when APNs is not configured, 429 when rate limited, 204 for withdraw', async () => {
    expect((await handlePush(signed(body()), relayId, harness(200, undefined, { apns: {} }).deps)).status).toBe(503)
    expect((await handlePush(signed(body()), relayId, harness(200, undefined, { rateLimit: async () => false }).deps)).status).toBe(429)
    const h = harness()
    expect((await handlePush(signed(body({ kind: 'withdraw' })), relayId, h.deps)).status).toBe(204)
    expect(h.calls).toHaveLength(0)
  })

  it('android still goes to FCM, not APNs', async () => {
    const h = harness()
    const r = await handlePush(signed(body({ platform: 'android' })), relayId, h.deps)
    expect(r.status).toBe(503) // no service account in this harness
    expect(h.calls).toHaveLength(0)
  })
})

describe('kid passthrough', () => {
  it('puts kid next to enc in the APNs payload, and only with enc', () => {
    expect(buildApnsPayload('approval', 'r1', 'ZW5j', 'a1b2c3d4')).toMatchObject({ enc: 'ZW5j', kid: 'a1b2c3d4', rid: 'r1' })
    expect(buildApnsPayload('approval', 'r1')).not.toHaveProperty('kid')
    expect(buildApnsPayload('approval', 'r1', undefined, 'a1b2c3d4')).not.toHaveProperty('kid')
  })

  it('parsePushBody accepts a short kid and rejects bad ones', () => {
    const raw = (kid: unknown) => JSON.stringify({ token: TOKEN, platform: 'ios', kind: 'approval', ts: 1, enc: 'ZW5j', kid })
    expect(parsePushBody(raw('a1b2c3d4'))?.kid).toBe('a1b2c3d4')
    expect(parsePushBody(raw('x'.repeat(17)))).toBeNull()
    expect(parsePushBody(raw(''))).toBeNull()
    expect(parsePushBody(raw('bad kid!'))).toBeNull()
    expect(parsePushBody(raw(5))).toBeNull()
  })
})
