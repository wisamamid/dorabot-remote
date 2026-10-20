/**
 * Shared pieces of the blind relay: ids, the host-auth challenge, the mux framing
 * and Ed25519 signing. Pure functions only, so the Worker, the bridge and the
 * phone all run the one implementation.
 *
 * The relay never holds a key that can read traffic. It learns a routing id and
 * forwards ciphertext. The host proves it owns that id with an Ed25519 signature,
 * which is the only thing the relay ever verifies.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { fromB64, toB64, utf8 } from './crypto.js'

/**
 * The one place the hosted relay's address lives. Deployed with `wrangler deploy` from packages/relay.
 */
export const DEFAULT_RELAY_URL = 'wss://dorabot-relay.wisam.workers.dev'

/** False until the real subdomain replaces the placeholder, so dev builds stay quiet. */
export function isRelayUrlConfigured(url: string): boolean {
  return /^wss?:\/\//.test(url) && !url.includes('REPLACE_ME')
}

export interface RelayInfo {
  /** Relay base URL, ws:// or wss://, no trailing slash. */
  u: string
  /** relayId of the host. */
  i: string
  /** This device's relay access token. Sent to the relay as the first frame (see relayAuthFrame). Persist it with the pairing. */
  tok?: string
  /** Single-use pairing ticket, only ever present in the QR payload. Accepted by the relay once, for the pairing connection. */
  tk?: string
}

/** Close codes shared by relay, bridge and phone. */
export const RELAY_CLOSE = {
  replaced: 4000,
  unauthorized: 4401,
  hostOffline: 4404,
  rateLimited: 4429,
  tooBig: 1009,
} as const

export const RELAY_MAX_FRAME_BYTES = 1024 * 1024
/**
 * Application-level heartbeat on the host link. The Room answers it from inside the
 * Durable Object (setWebSocketAutoResponse), which proves the Room-to-bridge path in
 * a way a protocol-level ping, answered by Cloudflare's edge, does not.
 */
export const RELAY_HB_REQUEST = '{"t":"hb"}'
export const RELAY_HB_RESPONSE = '{"t":"hb_ack"}'
export const RELAY_MAX_DEVICES = 32
/** A device socket that has not presented a valid token within this long is closed 4401. */
export const RELAY_DEVICE_AUTH_MS = 5000
/** Prefix of the Sec-WebSocket-Protocol value that carries a token instead of a first frame. */
export const RELAY_TOKEN_PROTOCOL_PREFIX = 'dorabot.tok.'
export const RELAY_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/
export const RELAY_HASH_RE = /^[0-9a-f]{64}$/
export const RELAY_MAX_TOKENS = 200
export const RELAY_MAX_TICKETS = 16
/** The phone gives LAN candidates this long to answer before it also tries the relay. */
export const RELAY_HEAD_START_MS = 1200

const AUTH_CONTEXT = 'dorabot-relay/v1'
export const RELAY_ID_RE = /^[A-Za-z0-9_-]{22}$/

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface SigningKeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export function generateSigningKey(): SigningKeyPair {
  const privateKey = ed25519.utils.randomSecretKey()
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) }
}

/** base64url(blake2b-128(ed25519 public key)): 22 chars, safe in a URL path. */
export function relayIdFromPublicKey(publicKey: Uint8Array): string {
  return toB64(null, blake2b(publicKey, { dkLen: 16 }))
}

export function isRelayId(value: string): boolean {
  return RELAY_ID_RE.test(value)
}

export function relayHostUrl(info: RelayInfo): string {
  return `${info.u.replace(/\/+$/, '')}/h/${info.i}`
}

export function relayDeviceUrl(info: RelayInfo): string {
  return `${info.u.replace(/\/+$/, '')}/d/${info.i}`
}

// ---------------------------------------------------------------------------
// Access tokens. The relay stores only SHA-256 hashes; the bridge tells it the
// current set over the authenticated host link: {t:'tokens', set, tickets, enforce}.
// ---------------------------------------------------------------------------

/** A fresh random 32-byte token, base64url. */
export function newRelayToken(): string {
  return toB64(null, randomBytes(32))
}

/** Deterministic per-device token: HMAC(secret, "dorabot-relay-token/v1|deviceId"), base64url. */
export function deriveRelayToken(secret: Uint8Array, deviceId: string): string {
  return toB64(null, hmac(sha256, secret, utf8(null, `dorabot-relay-token/v1|${deviceId}`)))
}

/** Lowercase hex SHA-256 of the token string; what the relay stores and compares. */
export function relayTokenHash(token: string): string {
  return Array.from(sha256(utf8(null, token)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** First frame a device sends on /d/<relayId>. */
export function relayAuthFrame(token: string): string {
  return JSON.stringify({ t: 'auth', tok: token })
}

/** The Sec-WebSocket-Protocol alternative to relayAuthFrame. */
export function relayTokenProtocol(token: string): string {
  return `${RELAY_TOKEN_PROTOCOL_PREFIX}${token}`
}

/** Host -> relay: replaces the access state. `set` = device/self-test token hashes, `tickets` = single-use pairing tickets. */
export interface RelayTokensFrame {
  t: 'tokens'
  set: string[]
  tickets?: string[]
  /** When true, a device with no valid token is refused. Until then, token-less (legacy) devices still connect. */
  enforce: boolean
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export function newChallengeNonce(): string {
  return toB64(null, randomBytes(32))
}

/** The exact bytes the host signs to answer a challenge. */
export function challengeMessage(relayId: string, nonce: string): Uint8Array {
  return utf8(null, `${AUTH_CONTEXT}|${relayId}|${nonce}`)
}

export function signChallenge(key: SigningKeyPair, relayId: string, nonce: string): { pk: string; sig: string } {
  return {
    pk: toB64(null, key.publicKey),
    sig: toB64(null, ed25519.sign(challengeMessage(relayId, nonce), key.privateKey)),
  }
}

/** True only if `pk` hashes to `relayId` AND `sig` covers this exact challenge. */
export function verifyChallenge(relayId: string, nonce: string, pkB64: string, sigB64: string): boolean {
  return verifyForRelayId(relayId, pkB64, sigB64, challengeMessage(relayId, nonce))
}

export function signBytes(key: SigningKeyPair, message: Uint8Array): { pk: string; sig: string } {
  return { pk: toB64(null, key.publicKey), sig: toB64(null, ed25519.sign(message, key.privateKey)) }
}

/** Shared by the challenge and by push bodies: the key must own the relayId. */
export function verifyForRelayId(relayId: string, pkB64: string, sigB64: string, message: Uint8Array): boolean {
  try {
    const pk = fromB64(null, pkB64)
    const sig = fromB64(null, sigB64)
    if (pk.length !== 32 || sig.length !== 64) return false
    if (relayIdFromPublicKey(pk) !== relayId) return false
    return ed25519.verify(sig, message, pk)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Mux framing on the host socket: [kind u8][connId u32 BE][payload]
// ---------------------------------------------------------------------------

export const MuxKind = { open: 1, close: 2, text: 3, binary: 4 } as const
export type MuxKindValue = (typeof MuxKind)[keyof typeof MuxKind]

export interface MuxFrame {
  kind: MuxKindValue
  connId: number
  payload: Uint8Array
}

export function encodeMux(kind: MuxKindValue, connId: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  out[0] = kind
  new DataView(out.buffer).setUint32(1, connId >>> 0, false)
  out.set(payload, 5)
  return out
}

export function encodeMuxText(connId: number, text: string): Uint8Array {
  return encodeMux(MuxKind.text, connId, utf8(null, text))
}

export function encodeMuxClose(connId: number, code: number, reason = ''): Uint8Array {
  const r = utf8(null, reason).subarray(0, 123)
  const payload = new Uint8Array(2 + r.length)
  new DataView(payload.buffer).setUint16(0, code, false)
  payload.set(r, 2)
  return encodeMux(MuxKind.close, connId, payload)
}

/** Returns null for anything malformed rather than throwing: the peer is untrusted. */
export function decodeMux(bytes: Uint8Array): MuxFrame | null {
  if (bytes.length < 5) return null
  const kind = bytes[0]!
  if (kind < 1 || kind > 4) return null
  const connId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false)
  return { kind: kind as MuxKindValue, connId, payload: bytes.subarray(5) }
}

export function decodeMuxClose(payload: Uint8Array): { code: number; reason: string } {
  if (payload.length < 2) return { code: 1005, reason: '' }
  const code = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0, false)
  return { code, reason: new TextDecoder().decode(payload.subarray(2)) }
}
