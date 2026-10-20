/**
 * Crypto for the phone <-> bridge channel.
 *
 * Primitives: X25519 for key agreement, BLAKE2b for key derivation,
 * XChaCha20-Poly1305 for authenticated encryption. All from @noble, which is pure
 * JavaScript, so the identical code runs in Node, in a browser and inside a
 * Capacitor WebView with no WASM to load and nothing to go wrong at startup.
 *
 * Two flows:
 *
 *  1. PAIRING. The QR shown on the Mac carries the host's long-term X25519 public
 *     key, so the phone learns it out of band, through the user's eyes. The phone
 *     seals the pairing code and its own public key to that key. Only the real
 *     host can open it, so a machine-in-the-middle on the network never learns
 *     the code and cannot impersonate the host.
 *
 *  2. SESSION. Mutual authentication with no shared secret on the wire:
 *
 *        ss_eph    = X25519(my_ephemeral_sk, their_ephemeral_pk)
 *        ss_static = X25519(my_static_sk,    their_static_pk)
 *        master    = BLAKE2b-64( ss_eph || ss_static || d_eph_pk || h_eph_pk
 *                              || host_static_pk || device_static_pk )
 *
 *     ss_eph gives forward secrecy: compromising a long-term key later does not
 *     decrypt recorded traffic. ss_static gives mutual authentication, since an
 *     attacker holding only public keys cannot compute it. Hashing the full
 *     transcript binds the keys to the identities, defeating key-misbinding.
 *
 * Wire format: handshake frames are JSON text. Every frame after that is one
 * binary AEAD message whose plaintext is UTF-8 JSON.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { randomBytes } from '@noble/hashes/utils.js'

export const PROTOCOL_VERSION = 1

const KEY_BYTES = 32
const NONCE_BYTES = 24
/** Random per-stream prefix; the remaining 8 bytes are a message counter. */
const NONCE_PREFIX_BYTES = 16
export const STREAM_HEADER_BYTES = NONCE_PREFIX_BYTES

export interface KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export interface KeyPairB64 {
  publicKey: string
  privateKey: string
}

/**
 * Kept for API symmetry with the previous libsodium-backed implementation and so
 * callers can stay async-ready. Nothing needs initialising now.
 */
export async function sodiumReady(): Promise<Sodium> {
  return SODIUM
}

// ---------------------------------------------------------------------------
// Encoding. Hand-rolled base64url so the same code works in Node, a browser and
// a WebView without Buffer, atob or any polyfill.
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function toB64(_s: unknown, bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined
    out += B64[b0 >> 2]
    out += B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) break
    out += B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) break
    out += B64[b2 & 0x3f]
  }
  return out
}

export function fromB64(_s: unknown, text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9\-_]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

export function utf8(_s: unknown, text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function fromUtf8(_s: unknown, bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/**
 * A no-op handle kept so call sites read the same as before and so the signature
 * has somewhere to grow if a backend that genuinely needs initialising returns.
 */
export const SODIUM = {
  base64_variants: { URLSAFE_NO_PADDING: 0 },
  to_base64: (b: Uint8Array) => toB64(null, b),
  from_base64: (t: string) => fromB64(null, t),
  from_string: (t: string) => utf8(null, t),
  to_string: (b: Uint8Array) => fromUtf8(null, b),
} as const

export type Sodium = typeof SODIUM

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Long-term identities
// ---------------------------------------------------------------------------

export function generateIdentity(_s?: unknown): KeyPair {
  const privateKey = x25519.utils.randomSecretKey()
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
}

export function identityToB64(_s: unknown, kp: KeyPair): KeyPairB64 {
  return { publicKey: toB64(null, kp.publicKey), privateKey: toB64(null, kp.privateKey) }
}

export function identityFromB64(_s: unknown, kp: KeyPairB64): KeyPair {
  return { publicKey: fromB64(null, kp.publicKey), privateKey: fromB64(null, kp.privateKey) }
}

/**
 * Short human-comparable fingerprint, e.g. "4F2A-91C7-BD03". Shown on the Mac and
 * in the app so the user can confirm they paired with the machine they meant to.
 */
export function fingerprint(_s: unknown, publicKey: Uint8Array): string {
  const h = blake2b(publicKey, { dkLen: 6 })
  const hex = Array.from(h)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`
}

// ---------------------------------------------------------------------------
// Sealed boxes, used for pairing
// ---------------------------------------------------------------------------

export interface PairingRequest {
  v: number
  /** Single-use code from the QR. */
  code: string
  /** The device's long-term public key, base64url. */
  devicePublicKey: string
  deviceName: string
  platform: string
}

export interface PairingResponse {
  v: number
  deviceId: string
  hostId: string
  hostName: string
  scopes: string[]
  /** Echoed so the phone can confirm it reached the key it scanned. */
  hostPublicKey: string
  /** [SEC-RELAY] This device's relay access token, sent E2E so the phone can reconnect through the relay. */
  relayTok?: string
}

const SEAL_CONTEXT = utf8(null, 'dorabot-remote/seal/v1')

/**
 * Anonymous sealed box. An ephemeral key pair is generated per message, so the
 * sender is unauthenticated but the recipient is: only the holder of the matching
 * private key can open it. Output is `ephemeral_public_key || ciphertext`.
 */
export function sealTo(_s: unknown, recipientPublicKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const eph = generateIdentity()
  const shared = x25519.getSharedSecret(eph.privateKey, recipientPublicKey)
  const key = blake2b(concat(shared, eph.publicKey, recipientPublicKey, SEAL_CONTEXT), { dkLen: KEY_BYTES })
  const nonce = blake2b(concat(eph.publicKey, recipientPublicKey), { dkLen: NONCE_BYTES })
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext)
  return concat(eph.publicKey, ct)
}

export function openSealed(_s: unknown, recipient: KeyPair, sealed: Uint8Array): Uint8Array {
  if (sealed.length <= KEY_BYTES) throw new Error('sealed message is truncated')
  const ephPub = sealed.subarray(0, KEY_BYTES)
  const ct = sealed.subarray(KEY_BYTES)
  const shared = x25519.getSharedSecret(recipient.privateKey, ephPub)
  const key = blake2b(concat(shared, ephPub, recipient.publicKey, SEAL_CONTEXT), { dkLen: KEY_BYTES })
  const nonce = blake2b(concat(ephPub, recipient.publicKey), { dkLen: NONCE_BYTES })
  return xchacha20poly1305(key, nonce).decrypt(ct)
}

export function sealJson(_s: unknown, recipientPublicKey: Uint8Array, value: unknown): string {
  return toB64(null, sealTo(null, recipientPublicKey, utf8(null, JSON.stringify(value))))
}

export function openSealedJson<T>(_s: unknown, recipient: KeyPair, b64: string): T {
  return JSON.parse(fromUtf8(null, openSealed(null, recipient, fromB64(null, b64)))) as T
}

// ---------------------------------------------------------------------------
// Session keys
// ---------------------------------------------------------------------------

export interface SessionKeys {
  /** Key this side encrypts with. */
  tx: Uint8Array
  /** Key this side decrypts with. */
  rx: Uint8Array
}

const CTX_DEVICE_TO_HOST = utf8(null, 'dorabot-remote/d2h/v1')
const CTX_HOST_TO_DEVICE = utf8(null, 'dorabot-remote/h2d/v1')

/**
 * Derive both directional keys. `role` only decides the tx/rx orientation; both
 * sides hash identical inputs and so arrive at the identical pair.
 */
export function deriveSessionKeys(
  _s: unknown,
  role: 'device' | 'host',
  args: {
    myEphemeral: KeyPair
    theirEphemeralPk: Uint8Array
    myStatic: KeyPair
    theirStaticPk: Uint8Array
  },
): SessionKeys {
  const ssEph = x25519.getSharedSecret(args.myEphemeral.privateKey, args.theirEphemeralPk)
  const ssStatic = x25519.getSharedSecret(args.myStatic.privateKey, args.theirStaticPk)

  const deviceEphPk = role === 'device' ? args.myEphemeral.publicKey : args.theirEphemeralPk
  const hostEphPk = role === 'host' ? args.myEphemeral.publicKey : args.theirEphemeralPk
  const hostStaticPk = role === 'host' ? args.myStatic.publicKey : args.theirStaticPk
  const deviceStaticPk = role === 'device' ? args.myStatic.publicKey : args.theirStaticPk

  const master = blake2b(concat(ssEph, ssStatic, deviceEphPk, hostEphPk, hostStaticPk, deviceStaticPk), {
    dkLen: 64,
  })

  const d2h = blake2b(CTX_DEVICE_TO_HOST, { dkLen: KEY_BYTES, key: master })
  const h2d = blake2b(CTX_HOST_TO_DEVICE, { dkLen: KEY_BYTES, key: master })

  return role === 'device' ? { tx: d2h, rx: h2d } : { tx: h2d, rx: d2h }
}

/**
 * One bidirectional encrypted channel over an ordered transport.
 *
 * Each direction gets a random 16-byte nonce prefix (the "header", sent once in
 * the clear) plus a 64-bit message counter, so no nonce is ever reused under a
 * key and a frame replayed or reordered by an attacker fails to open. Callers
 * never touch nonces.
 */
export class SecureChannel {
  private txPrefix: Uint8Array | null = null
  private rxPrefix: Uint8Array | null = null
  private txCounter = 0n
  private rxCounter = 0n

  private constructor(private readonly keys: SessionKeys) {}

  static create(_s: unknown, keys: SessionKeys): SecureChannel {
    return new SecureChannel(keys)
  }

  /** Begin our outbound stream. The returned header must be sent to the peer. */
  startSend(): Uint8Array {
    this.txPrefix = randomBytes(NONCE_PREFIX_BYTES)
    this.txCounter = 0n
    return this.txPrefix
  }

  /** Accept the peer's header, opening our inbound stream. */
  startReceive(header: Uint8Array): void {
    if (header.length !== NONCE_PREFIX_BYTES) throw new Error('bad stream header length')
    // One header per connection, ever: a second one would reset the counter and
    // let an attacker replay earlier ciphertext frames.
    if (this.rxPrefix) throw new Error('stream header already received')
    this.rxPrefix = header
    this.rxCounter = 0n
  }

  get established(): boolean {
    return this.txPrefix !== null && this.rxPrefix !== null
  }

  private nonce(prefix: Uint8Array, counter: bigint): Uint8Array {
    const n = new Uint8Array(NONCE_BYTES)
    n.set(prefix, 0)
    const view = new DataView(n.buffer, n.byteOffset + NONCE_PREFIX_BYTES, 8)
    view.setBigUint64(0, counter, false)
    return n
  }

  seal(value: unknown): Uint8Array {
    if (!this.txPrefix) throw new Error('secure channel: send stream not started')
    const nonce = this.nonce(this.txPrefix, this.txCounter)
    this.txCounter += 1n
    return xchacha20poly1305(this.keys.tx, nonce).encrypt(utf8(null, JSON.stringify(value)))
  }

  open<T = unknown>(frame: Uint8Array): T {
    if (!this.rxPrefix) throw new Error('secure channel: receive stream not started')
    const nonce = this.nonce(this.rxPrefix, this.rxCounter)
    const plain = xchacha20poly1305(this.keys.rx, nonce).decrypt(frame)
    this.rxCounter += 1n
    return JSON.parse(fromUtf8(null, plain)) as T
  }
}

export function headerBytes(_s?: unknown): number {
  return STREAM_HEADER_BYTES
}
