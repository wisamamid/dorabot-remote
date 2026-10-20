import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  SecureChannel,
  deriveSessionKeys,
  fingerprint,
  fromB64,
  generateIdentity,
  openSealedJson,
  sealJson,
  toB64,
} from './crypto.js'
import { decodePairingPayload, encodePairingPayload } from './wire.js'

describe('sealed boxes (pairing)', () => {
  it('round-trips a pairing request to the host key', () => {
    const host = generateIdentity()
    const device = generateIdentity()
    const req = {
      v: PROTOCOL_VERSION,
      code: 'ABCDEFGHJK',
      devicePublicKey: toB64(null, device.publicKey),
      deviceName: "Wisam's iPhone",
      platform: 'ios',
    }
    const sealed = sealJson(null, host.publicKey, req)
    expect(openSealedJson(null, host, sealed)).toEqual(req)
  })

  it('cannot be opened by anyone but the recipient', () => {
    const host = generateIdentity()
    const impostor = generateIdentity()
    const sealed = sealJson(null, host.publicKey, { secret: 'code' })
    expect(() => openSealedJson(null, impostor, sealed)).toThrow()
  })

  it('rejects a tampered ciphertext', () => {
    const host = generateIdentity()
    const sealed = sealJson(null, host.publicKey, { secret: 'code' })
    const bytes = fromB64(null, sealed)
    bytes[bytes.length - 1] ^= 0x01
    expect(() => openSealedJson(null, host, toB64(null, bytes))).toThrow()
  })
})

describe('session handshake', () => {
  function handshake(hostStatic = generateIdentity(), deviceStatic = generateIdentity()) {
    const hostEph = generateIdentity()
    const deviceEph = generateIdentity()

    const deviceKeys = deriveSessionKeys(null, 'device', {
      myEphemeral: deviceEph,
      theirEphemeralPk: hostEph.publicKey,
      myStatic: deviceStatic,
      theirStaticPk: hostStatic.publicKey,
    })
    const hostKeys = deriveSessionKeys(null, 'host', {
      myEphemeral: hostEph,
      theirEphemeralPk: deviceEph.publicKey,
      myStatic: hostStatic,
      theirStaticPk: deviceStatic.publicKey,
    })

    const d = SecureChannel.create(null, deviceKeys)
    const h = SecureChannel.create(null, hostKeys)
    h.startReceive(d.startSend())
    d.startReceive(h.startSend())
    return { d, h, deviceKeys, hostKeys }
  }

  it('agrees on the same directional keys from both sides', () => {
    const { deviceKeys, hostKeys } = handshake()
    expect(toB64(null, deviceKeys.tx)).toBe(toB64(null, hostKeys.rx))
    expect(toB64(null, deviceKeys.rx)).toBe(toB64(null, hostKeys.tx))
  })

  it('carries messages in both directions', () => {
    const { d, h } = handshake()
    expect(h.open(d.seal({ t: 'auth', lastSeq: 7 }))).toEqual({ t: 'auth', lastSeq: 7 })
    expect(d.open(h.seal({ t: 'ready', seq: 12 }))).toEqual({ t: 'ready', seq: 12 })
  })

  it('keeps ordering across many frames', () => {
    const { d, h } = handshake()
    for (let i = 0; i < 500; i++) {
      expect(h.open(d.seal({ i }))).toEqual({ i })
    }
  })

  it('rejects a replayed frame', () => {
    const { d, h } = handshake()
    const frame = d.seal({ i: 1 })
    h.open(frame)
    expect(() => h.open(frame)).toThrow()
  })

  it('refuses a second stream header, so a re-key cannot rewind the counter for replay', () => {
    const { d, h } = handshake()
    const frame = d.seal({ i: 1 })
    h.open(frame)
    expect(() => h.startReceive(new Uint8Array(16))).toThrow(/already/)
    // The original stream is untouched: the replayed frame still fails.
    expect(() => h.open(frame)).toThrow()
    expect(h.open(d.seal({ i: 2 }))).toEqual({ i: 2 })
  })

  it('rejects a reordered frame', () => {
    const { d, h } = handshake()
    const a = d.seal({ i: 1 })
    const b = d.seal({ i: 2 })
    expect(() => h.open(b)).toThrow()
    expect(h.open(a)).toEqual({ i: 1 })
  })

  it('fails when the device presents the wrong long-term key, which is the authentication', () => {
    const hostStatic = generateIdentity()
    const realDevice = generateIdentity()
    const impostor = generateIdentity()

    const hostEph = generateIdentity()
    const deviceEph = generateIdentity()

    // The impostor knows every public key but not the real device's private key.
    const impostorKeys = deriveSessionKeys(null, 'device', {
      myEphemeral: deviceEph,
      theirEphemeralPk: hostEph.publicKey,
      myStatic: impostor,
      theirStaticPk: hostStatic.publicKey,
    })
    // The host derives against the key it has on record for the real device.
    const hostKeys = deriveSessionKeys(null, 'host', {
      myEphemeral: hostEph,
      theirEphemeralPk: deviceEph.publicKey,
      myStatic: hostStatic,
      theirStaticPk: realDevice.publicKey,
    })

    const bad = SecureChannel.create(null, impostorKeys)
    const h = SecureChannel.create(null, hostKeys)
    h.startReceive(bad.startSend())
    expect(() => h.open(bad.seal({ t: 'auth' }))).toThrow()
  })
})

describe('fingerprints', () => {
  it('is stable and human-shaped', () => {
    const kp = generateIdentity()
    const fp = fingerprint(null, kp.publicKey)
    expect(fp).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
    expect(fingerprint(null, kp.publicKey)).toBe(fp)
  })

  it('differs between keys', () => {
    expect(fingerprint(null, generateIdentity().publicKey)).not.toBe(
      fingerprint(null, generateIdentity().publicKey),
    )
  })
})

describe('pairing payload encoding', () => {
  it('round-trips through the QR URI', () => {
    const payload = {
      v: 1,
      h: 'host-id',
      n: 'Wisams-Mac-mini',
      k: toB64(null, generateIdentity().publicKey),
      c: 'ABCDEFGHJK',
      a: ['192.168.1.208:7788', '100.84.1.9:7788', 'Wisams-Mac-mini.local:7788'],
      e: 1790000000000,
    }
    const uri = encodePairingPayload(payload)
    expect(uri.startsWith('dorabot-remote://pair#')).toBe(true)
    expect(decodePairingPayload(uri)).toEqual(payload)
    // A scanner that hands back only the fragment should work too.
    expect(decodePairingPayload(uri.split('#')[1]!)).toEqual(payload)
  })

  it('refuses a payload with no addresses', () => {
    expect(() =>
      decodePairingPayload(encodePairingPayload({ v: 1, h: 'h', n: 'n', k: 'k', c: 'c', a: [], e: 0 })),
    ).toThrow()
  })
})
