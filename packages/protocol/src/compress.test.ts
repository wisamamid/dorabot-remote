import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  COMPRESS_MIN_BYTES,
  MAX_INFLATED_BYTES,
  SecureChannel,
  deriveSessionKeys,
  frameDeflated,
  generateIdentity,
  inflateFrame,
} from './index.js'

function pair(acceptCompressed = true) {
  const dEph = generateIdentity(), hEph = generateIdentity(), dSt = generateIdentity(), hSt = generateIdentity()
  const dk = deriveSessionKeys(null, 'device', { myEphemeral: dEph, theirEphemeralPk: hEph.publicKey, myStatic: dSt, theirStaticPk: hSt.publicKey })
  const hk = deriveSessionKeys(null, 'host', { myEphemeral: hEph, theirEphemeralPk: dEph.publicKey, myStatic: hSt, theirStaticPk: dSt.publicKey })
  const phone = SecureChannel.create(null, dk, { acceptCompressed })
  const host = SecureChannel.create(null, hk) // bridge side never accepts compressed
  phone.startReceive(host.startSend())
  host.startReceive(phone.startSend())
  return { phone, host }
}

const enc = (v: unknown) => Buffer.from(JSON.stringify(v))
const compressed = (v: unknown) => {
  const j = enc(v)
  return frameDeflated(j.length, deflateRawSync(j, { level: 6 }))
}
const big = { t: 'event', event: 'x', data: { text: 'hello world '.repeat(2000) } }

describe('compressed frames', () => {
  it('round-trips a large compressed frame and a small plain one, in order', () => {
    const { phone, host } = pair()
    expect(enc(big).length).toBeGreaterThan(COMPRESS_MIN_BYTES)
    const sealed = host.sealBytes(compressed(big))
    expect(sealed.length).toBeLessThan(enc(big).length / 5)
    expect(phone.open(sealed)).toEqual(big)
    expect(phone.open(host.seal({ t: 'pong', ts: 1 }))).toEqual({ t: 'pong', ts: 1 })
  })

  it('plain JSON still opens (old bridge / small frames)', () => {
    const { phone, host } = pair()
    expect(phone.open(host.seal(big))).toEqual(big)
  })

  it('a compressed frame sent toward the bridge side is rejected', () => {
    const { phone, host } = pair()
    expect(() => host.open(phone.sealBytes(compressed(big)))).toThrow(/compressed/)
  })

  it('a channel not opted in rejects compressed frames', () => {
    const { phone, host } = pair(false)
    expect(() => phone.open(host.sealBytes(compressed(big)))).toThrow()
  })

  it('rejects corrupt deflate data', () => {
    const { phone, host } = pair()
    const good = compressed(big)
    const bad = good.slice()
    for (let i = 10; i < 40; i++) bad[i] = 0xff
    expect(() => phone.open(host.sealBytes(bad))).toThrow()
    expect(() => inflateFrame(new Uint8Array([1, 0, 0, 0, 5]))).toThrow()
  })

  it('rejects a declared size over the 8 MiB cap before inflating', () => {
    const f = frameDeflated(MAX_INFLATED_BYTES + 1, deflateRawSync(Buffer.alloc(16)))
    expect(() => inflateFrame(f)).toThrow(/invalid size/)
  })

  it('rejects a bomb whose real output exceeds its declared size, and one that is short', () => {
    const body = Buffer.alloc(2 * 1024 * 1024, 0x61)
    const d = deflateRawSync(body)
    expect(() => inflateFrame(frameDeflated(1000, d))).toThrow()
    expect(() => inflateFrame(frameDeflated(body.length + 10, d))).toThrow()
    expect(inflateFrame(frameDeflated(body.length, d)).length).toBe(body.length)
  })

  it('rejects an empty-declared frame', () => {
    expect(() => inflateFrame(frameDeflated(0, deflateRawSync(Buffer.alloc(0))))).toThrow()
  })
})
