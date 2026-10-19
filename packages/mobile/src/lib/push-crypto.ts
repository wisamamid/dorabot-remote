/**
 * Decrypt the `enc` blob the bridge puts in a push (same bytes the iOS
 * Notification Service Extension opens). Format: base64( nonce[12] || ciphertext
 * || tag[16] ), ChaCha20-Poly1305 IETF with a 32-byte key. Plaintext is JSON:
 * {kind, rid, sessionKey?, title, body, hostId?, hostName?}. Pure; no plugin access.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

export interface PushContent {
  kind: 'question' | 'approval'
  rid: string
  sessionKey?: string
  title: string
  body: string
  /** Which Mac sent it (bridge D2+). Older bridges omit these. */
  hostId?: string
  hostName?: string
}

const NONCE_BYTES = 12

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** A fresh random 32-byte push key, base64. */
export function generatePushKey(): string {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(32)))
}

/** Null on any failure (wrong key, truncated, tampered, malformed): the caller falls back to generic behaviour. */
export function decryptPushEnc(enc: string, keyB64: string): PushContent | null {
  try {
    const key = b64ToBytes(keyB64)
    if (key.length !== 32) return null
    const raw = b64ToBytes(enc)
    if (raw.length < NONCE_BYTES + 16) return null
    const plain = chacha20poly1305(key, raw.subarray(0, NONCE_BYTES)).decrypt(raw.subarray(NONCE_BYTES))
    const v = JSON.parse(new TextDecoder().decode(plain)) as Partial<PushContent>
    if (!v || (v.kind !== 'question' && v.kind !== 'approval') || typeof v.rid !== 'string') return null
    return {
      kind: v.kind,
      rid: v.rid,
      ...(typeof v.sessionKey === 'string' && v.sessionKey ? { sessionKey: v.sessionKey } : {}),
      title: String(v.title ?? ''),
      body: String(v.body ?? ''),
      ...(typeof v.hostId === 'string' && v.hostId ? { hostId: v.hostId } : {}),
      ...(typeof v.hostName === 'string' && v.hostName ? { hostName: v.hostName } : {}),
    }
  } catch {
    return null
  }
}
