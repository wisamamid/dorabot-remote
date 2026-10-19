/**
 * One push content key per Mac. The bridge puts an unencrypted short key id
 * (`kid`) next to `enc`; the Notification Service Extension and the app use it
 * to try the right key first, and fall back to every stored key (old pushes, a
 * lost kid). Pure; no plugin access.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { decryptPushEnc, type PushContent } from './push-crypto.js'

/** First 8 hex of sha256(hostId). Must match the bridge's pushKeyId (packages/bridge/src/push-content.ts). */
export function pushKeyId(hostId: string): string {
  const d = sha256(new TextEncoder().encode(hostId))
  let hex = ''
  for (let i = 0; i < 4; i++) hex += d[i]!.toString(16).padStart(2, '0')
  return hex
}

/** The paired Mac a `kid` belongs to, or null (old bridge without a kid, or an unknown Mac). */
export function hostIdForKid(hosts: ReadonlyArray<{ hostId: string }>, kid: string | undefined): string | null {
  if (!kid) return null
  return hosts.find((h) => pushKeyId(h.hostId) === kid)?.hostId ?? null
}

export interface StoredPushKey {
  /** '' is the pre-multi-Mac single key. */
  kid: string
  key: string
}

/** The kid match first, then everything else, each key once. */
export function keyCandidates(kid: string | undefined, keys: readonly StoredPushKey[]): StoredPushKey[] {
  if (!kid) return [...keys]
  return [...keys.filter((k) => k.kid === kid), ...keys.filter((k) => k.kid !== kid)]
}

export function decryptWithKeys(enc: string, kid: string | undefined, keys: readonly StoredPushKey[]): PushContent | null {
  for (const k of keyCandidates(kid, keys)) {
    const c = decryptPushEnc(enc, k.key)
    if (c) return c
  }
  return null
}
