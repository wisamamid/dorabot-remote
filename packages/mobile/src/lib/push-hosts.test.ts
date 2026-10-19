import { describe, expect, it } from 'vitest'
import { parseSent, planPushRegistrations, registerWithHost, stampFor } from './push-hosts.js'
import { decryptWithKeys, hostIdForKid, keyCandidates, pushKeyId } from './push-keys.js'
import { bytesToB64, generatePushKey } from './push-crypto.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { b64ToBytes } from './push-crypto.js'
import type { HostPairing } from './hosts.js'

const mk = (hostId: string, scopes: HostPairing['scopes'] = ['sessions', 'approvals']): HostPairing => ({
  deviceId: `dev-${hostId}`,
  hostId,
  hostName: hostId,
  hostPublicKey: 'pk',
  addresses: [],
  identity: { publicKey: 'a', privateKey: 'b' },
  scopes,
  pairedAt: 1,
  addedAt: 1,
})

describe('pushKeyId', () => {
  it('is the first 8 hex of sha256(hostId), identical to the bridge', () => {
    // Same vectors as packages/bridge/src/push-content.test.ts.
    expect(pushKeyId('a')).toBe('ca978112')
    expect(pushKeyId('host-abc')).toBe('dcf4a872')
    expect(pushKeyId('host-abc')).toMatch(/^[0-9a-f]{8}$/)
    expect(pushKeyId('a')).not.toBe(pushKeyId('b'))
  })
})

describe('key selection by kid', () => {
  const keys = [
    { kid: pushKeyId('h1'), key: generatePushKey() },
    { kid: pushKeyId('h2'), key: generatePushKey() },
    { kid: '', key: generatePushKey() },
  ]
  const seal = (obj: unknown, key: string): string => {
    const nonce = new Uint8Array(12).fill(5)
    const ct = chacha20poly1305(b64ToBytes(key), nonce).encrypt(new TextEncoder().encode(JSON.stringify(obj)))
    return bytesToB64(new Uint8Array([...nonce, ...ct]))
  }
  const body = { kind: 'approval', rid: 'r', title: 't', body: 'b', hostId: 'h2', hostName: 'Two' }

  it('puts the kid match first and still keeps every other key as fallback', () => {
    const order = keyCandidates(pushKeyId('h2'), keys).map((k) => k.kid)
    expect(order[0]).toBe(pushKeyId('h2'))
    expect(order).toHaveLength(3)
  })

  it('opens a push with the right Mac key, and reports which Mac it is from', () => {
    const enc = seal(body, keys[1]!.key)
    expect(decryptWithKeys(enc, pushKeyId('h2'), keys)).toMatchObject({ hostId: 'h2', hostName: 'Two' })
  })

  it('falls back to trying every key when the kid is missing or wrong', () => {
    const enc = seal(body, keys[1]!.key)
    expect(decryptWithKeys(enc, undefined, keys)?.rid).toBe('r')
    expect(decryptWithKeys(enc, pushKeyId('h1'), keys)?.rid).toBe('r')
    // the pre-multi-Mac single key (kid '') still opens old pushes
    expect(decryptWithKeys(seal(body, keys[2]!.key), undefined, keys)?.rid).toBe('r')
  })

  it('a key that is not stored opens nothing', () => {
    expect(decryptWithKeys(seal(body, generatePushKey()), pushKeyId('h1'), keys)).toBeNull()
  })

  it('maps a kid back to a paired Mac', () => {
    const hosts = [mk('h1'), mk('h2')]
    expect(hostIdForKid(hosts, pushKeyId('h2'))).toBe('h2')
    expect(hostIdForKid(hosts, 'deadbeef')).toBeNull()
    expect(hostIdForKid(hosts, undefined)).toBeNull()
  })
})

describe('planPushRegistrations: one APNs token, every Mac registered separately', () => {
  const token = 'tok1'
  const env = 'production'
  const hosts = [mk('h1'), mk('h2'), mk('h3', ['sessions'])]
  const base = { pairings: hosts, activeHostId: 'h2', token, env }

  it('plans every Mac with approvals that is not registered, active first; skips Macs without the scope', () => {
    expect(planPushRegistrations({ ...base, sent: {}, keyIds: new Set() })).toEqual(['h2', 'h1'])
  })

  it('skips a Mac already registered with this token and still holding its key', () => {
    const sent = { h1: stampFor(hosts[0]!, env, token) }
    const keyIds = new Set([pushKeyId('h1')])
    expect(planPushRegistrations({ ...base, sent, keyIds })).toEqual(['h2'])
  })

  it('re-registers when the token rotated, the key is gone, or the device was re-paired', () => {
    const sent = { h1: stampFor(hosts[0]!, env, 'old'), h2: stampFor(hosts[1]!, env, token) }
    expect(planPushRegistrations({ ...base, sent, keyIds: new Set([pushKeyId('h1'), pushKeyId('h2')]) })).toEqual(['h1'])
    expect(planPushRegistrations({ ...base, sent: { h2: stampFor(hosts[1]!, env, token) }, keyIds: new Set() })).toEqual(['h2', 'h1'])
    const repaired = [{ ...hosts[0]!, deviceId: 'new' }]
    expect(planPushRegistrations({ ...base, pairings: repaired, sent: { h1: stampFor(hosts[0]!, env, token) }, keyIds: new Set([pushKeyId('h1')]) })).toEqual(['h1'])
  })

  it('parseSent tolerates the old single-stamp format and junk', () => {
    expect(parseSent('dev:production:tok')).toEqual({})
    expect(parseSent(null)).toEqual({})
    expect(parseSent('["x"]')).toEqual({})
    expect(parseSent('{"h1":"s","h2":5}')).toEqual({ h1: 's' })
  })
})

describe('registerWithHost', () => {
  it('sends the token with a fresh per-Mac key, stores that key under that Mac, and returns the stamp', async () => {
    const calls: unknown[] = []
    const stored: Record<string, string> = {}
    const stamp = await registerWithHost(
      { rpc: async (m, p) => void calls.push([m, p]), newKey: () => 'KEY-1', storeKey: async (h, k) => void (stored[h] = k) },
      mk('h1'),
      'tok',
      'production',
    )
    expect(calls).toEqual([['remote.registerPush', { token: 'tok', platform: 'ios', env: 'production', pushKey: 'KEY-1' }]])
    expect(stored).toEqual({ h1: 'KEY-1' })
    expect(stamp).toBe('dev-h1:production:tok')
  })

  it('two Macs get two different keys', async () => {
    const stored: Record<string, string> = {}
    let n = 0
    const deps = { rpc: async () => undefined, newKey: () => `K${++n}`, storeKey: async (h: string, k: string) => void (stored[h] = k) }
    await registerWithHost(deps, mk('h1'), 't', 'production')
    await registerWithHost(deps, mk('h2'), 't', 'production')
    expect(stored).toEqual({ h1: 'K1', h2: 'K2' })
  })

  it('a refused registration stores no key and returns no stamp', async () => {
    const stored: string[] = []
    await expect(
      registerWithHost({ rpc: async () => Promise.reject(new Error('refused')), newKey: () => 'K', storeKey: async (h) => void stored.push(h) }, mk('h1'), 't', 'production'),
    ).rejects.toThrow('refused')
    expect(stored).toEqual([])
  })
})
