import { describe, expect, it } from 'vitest'
import {
  MuxKind,
  decodeMux,
  decodeMuxClose,
  encodeMux,
  encodeMuxClose,
  encodeMuxText,
  generateSigningKey,
  isRelayId,
  newChallengeNonce,
  relayDeviceUrl,
  relayHostUrl,
  relayIdFromPublicKey,
  signBytes,
  signChallenge,
  verifyChallenge,
  verifyForRelayId,
} from './relay.js'
import { fromUtf8 } from './crypto.js'

describe('relay id', () => {
  it('is 22 url-safe chars and stable per key', () => {
    const k = generateSigningKey()
    const id = relayIdFromPublicKey(k.publicKey)
    expect(id).toHaveLength(22)
    expect(isRelayId(id)).toBe(true)
    expect(relayIdFromPublicKey(k.publicKey)).toBe(id)
    expect(relayIdFromPublicKey(generateSigningKey().publicKey)).not.toBe(id)
  })

  it('rejects malformed ids', () => {
    for (const bad of ['', 'short', 'a'.repeat(23), 'a'.repeat(21) + '/', '../'.repeat(8) + 'ab']) {
      expect(isRelayId(bad)).toBe(false)
    }
  })

  it('builds host and device urls without doubled slashes', () => {
    const info = { u: 'wss://r.example.dev/', i: 'x'.repeat(22) }
    expect(relayHostUrl(info)).toBe(`wss://r.example.dev/h/${'x'.repeat(22)}`)
    expect(relayDeviceUrl(info)).toBe(`wss://r.example.dev/d/${'x'.repeat(22)}`)
  })
})

describe('mux framing', () => {
  it('round-trips every kind', () => {
    const payload = new Uint8Array([1, 2, 3, 250])
    const f = decodeMux(encodeMux(MuxKind.binary, 0xdeadbeef, payload))!
    expect(f.kind).toBe(MuxKind.binary)
    expect(f.connId).toBe(0xdeadbeef)
    expect([...f.payload]).toEqual([1, 2, 3, 250])

    const open = decodeMux(encodeMux(MuxKind.open, 7))!
    expect(open.kind).toBe(MuxKind.open)
    expect(open.payload.length).toBe(0)

    const text = decodeMux(encodeMuxText(9, 'héllo'))!
    expect(text.kind).toBe(MuxKind.text)
    expect(fromUtf8(null, text.payload)).toBe('héllo')

    const close = decodeMux(encodeMuxClose(5, 4404, 'host_offline'))!
    expect(close.kind).toBe(MuxKind.close)
    expect(decodeMuxClose(close.payload)).toEqual({ code: 4404, reason: 'host_offline' })
  })

  it('writes connId big-endian', () => {
    const bytes = encodeMux(MuxKind.text, 0x01020304)
    expect([...bytes.subarray(0, 5)]).toEqual([3, 1, 2, 3, 4])
  })

  it('returns null for malformed frames', () => {
    expect(decodeMux(new Uint8Array([1, 0, 0]))).toBeNull()
    expect(decodeMux(new Uint8Array([9, 0, 0, 0, 0]))).toBeNull()
    expect(decodeMux(new Uint8Array([0, 0, 0, 0, 0]))).toBeNull()
  })

  it('works on a subarray view with a non-zero offset', () => {
    const inner = encodeMuxText(42, 'x')
    const padded = new Uint8Array(inner.length + 3)
    padded.set(inner, 3)
    expect(decodeMux(padded.subarray(3))!.connId).toBe(42)
  })
})

describe('challenge signatures', () => {
  it('verifies a correct signature', () => {
    const k = generateSigningKey()
    const id = relayIdFromPublicKey(k.publicKey)
    const nonce = newChallengeNonce()
    const { pk, sig } = signChallenge(k, id, nonce)
    expect(verifyChallenge(id, nonce, pk, sig)).toBe(true)
  })

  it('rejects a signature from the wrong key', () => {
    const k = generateSigningKey()
    const other = generateSigningKey()
    const id = relayIdFromPublicKey(k.publicKey)
    const nonce = newChallengeNonce()
    const forged = signChallenge(other, id, nonce)
    expect(verifyChallenge(id, nonce, forged.pk, forged.sig)).toBe(false)
    // Right key's pk with a signature from the wrong key.
    expect(verifyChallenge(id, nonce, signChallenge(k, id, nonce).pk, forged.sig)).toBe(false)
  })

  it('rejects a valid signature presented for a different relayId', () => {
    const k = generateSigningKey()
    const other = generateSigningKey()
    const nonce = newChallengeNonce()
    const otherId = relayIdFromPublicKey(other.publicKey)
    const { pk, sig } = signChallenge(k, otherId, nonce)
    expect(verifyChallenge(otherId, nonce, pk, sig)).toBe(false)
  })

  it('rejects a different nonce and malformed input', () => {
    const k = generateSigningKey()
    const id = relayIdFromPublicKey(k.publicKey)
    const { pk, sig } = signChallenge(k, id, newChallengeNonce())
    expect(verifyChallenge(id, newChallengeNonce(), pk, sig)).toBe(false)
    expect(verifyChallenge(id, 'n', 'nope', 'nope')).toBe(false)
    expect(verifyChallenge(id, 'n', '', '')).toBe(false)
  })

  it('signs arbitrary bodies for push', () => {
    const k = generateSigningKey()
    const id = relayIdFromPublicKey(k.publicKey)
    const body = new TextEncoder().encode('{"a":1}')
    const { pk, sig } = signBytes(k, body)
    expect(verifyForRelayId(id, pk, sig, body)).toBe(true)
    expect(verifyForRelayId(id, pk, sig, new TextEncoder().encode('{"a":2}'))).toBe(false)
  })
})
