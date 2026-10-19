import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { describe, expect, it } from 'vitest'
import { b64ToBytes, bytesToB64, decryptPushEnc, generatePushKey } from './push-crypto.js'

const KEY = bytesToB64(new Uint8Array(32).map((_, i) => i + 1))
// Produced by the bridge (encryptPushContent, nonce = 12 x 0x07), so this pins the wire format end to end.
const BRIDGE_VECTOR =
  'BwcHBwcHBwcHBwcHSsKiR1N7u5ZWCrBaRVYeQy6pe5hp4IK0udzXDMwNBYaH3Wc2Wf4N6t6Id5oRLY1jQXEqJikARBEm6InBZtqe8vQwcqvc35SKFU/hsTbui2qlG/5SnzqVS4XKTio3Ex74Kt0fFhNHecZdhjHM5rLV0FKIZkztcQg='

function seal(obj: unknown, key = KEY): string {
  const nonce = new Uint8Array(12).fill(3)
  const ct = chacha20poly1305(b64ToBytes(key), nonce).encrypt(new TextEncoder().encode(JSON.stringify(obj)))
  return bytesToB64(new Uint8Array([...nonce, ...ct]))
}

describe('decryptPushEnc', () => {
  it('opens a blob produced by the bridge', () => {
    expect(decryptPushEnc(BRIDGE_VECTOR, KEY)).toEqual({
      kind: 'approval',
      rid: 'req-1',
      sessionKey: 'telegram:dm:42',
      title: 'Approve Bash?',
      body: 'ls -la',
    })
  })

  it('reads the Mac the push came from', () => {
    expect(decryptPushEnc(seal({ kind: 'approval', rid: 'r', title: 't', body: 'b', hostId: 'h9', hostName: 'Studio' }), KEY)).toMatchObject({ hostId: 'h9', hostName: 'Studio' })
  })

  it('round-trips and tolerates a missing session key', () => {
    expect(decryptPushEnc(seal({ kind: 'question', rid: 'q', title: 't', body: 'b' }), KEY)).toEqual({ kind: 'question', rid: 'q', title: 't', body: 'b' })
  })

  it('returns null for the wrong key, tampering, truncation and garbage', () => {
    const enc = seal({ kind: 'question', rid: 'q', title: 't', body: 'b' })
    expect(decryptPushEnc(enc, generatePushKey())).toBeNull()
    const raw = b64ToBytes(enc)
    raw[raw.length - 1]! ^= 1
    expect(decryptPushEnc(bytesToB64(raw), KEY)).toBeNull()
    expect(decryptPushEnc(bytesToB64(raw.subarray(0, 20)), KEY)).toBeNull()
    expect(decryptPushEnc('***', KEY)).toBeNull()
    expect(decryptPushEnc(enc, 'AAAA')).toBeNull()
    expect(decryptPushEnc(seal({ kind: 'result', rid: 'x' }), KEY)).toBeNull()
  })

  it('generates 32 random bytes', () => {
    const a = generatePushKey()
    expect(b64ToBytes(a)).toHaveLength(32)
    expect(generatePushKey()).not.toBe(a)
  })
})
