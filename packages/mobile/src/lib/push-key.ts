/**
 * The push content keys live in the iOS Keychain, in an access group shared with
 * the Notification Service Extension (native plugin `PushKeyStore`, see
 * ios/App/App/PushKeyStorePlugin.swift). One key per Mac, stored under that
 * Mac's key id (see push-keys.ts).
 *
 * Same rule as platform.ts: the plugin proxy is a thenable, so it is a module-level
 * constant used inside these functions and never returned or resolved.
 */
import { registerPlugin } from '@capacitor/core'
import { isNative, platformName } from './platform.js'
import { pushKeyId, type StoredPushKey } from './push-keys.js'

const pushSupported = isNative && platformName === 'ios'

interface PushKeyStorePlugin {
  set(opts: { kid: string; key: string }): Promise<void>
  get(opts: { kid: string }): Promise<{ key?: string }>
  list(): Promise<{ keys?: Array<{ kid?: string; key?: string }> }>
  clear(opts: { kid: string }): Promise<void>
  clearAll(): Promise<void>
}

const Native = registerPlugin<PushKeyStorePlugin>('PushKeyStore')

export async function setPushKey(hostId: string, keyB64: string): Promise<void> {
  if (!pushSupported) return
  await Native.set({ kid: pushKeyId(hostId), key: keyB64 })
}

export async function getPushKey(hostId: string): Promise<string | null> {
  if (!pushSupported) return null
  try {
    const r = await Native.get({ kid: pushKeyId(hostId) })
    return typeof r?.key === 'string' && r.key ? r.key : null
  } catch {
    return null
  }
}

/** Every stored key, including the pre-multi-Mac one (kid ''). */
export async function listPushKeys(): Promise<StoredPushKey[]> {
  if (!pushSupported) return []
  try {
    const r = await Native.list()
    return (r?.keys ?? []).filter((k): k is StoredPushKey => typeof k?.key === 'string' && typeof k?.kid === 'string')
  } catch {
    return []
  }
}

/** Key ids (not hostIds) that currently have a key. */
export async function storedKeyIds(): Promise<Set<string>> {
  return new Set((await listPushKeys()).map((k) => k.kid))
}

export async function clearPushKey(hostId: string): Promise<void> {
  if (!pushSupported) return
  try {
    await Native.clear({ kid: pushKeyId(hostId) })
  } catch {
    // best effort
  }
}

export async function clearAllPushKeys(): Promise<void> {
  if (!pushSupported) return
  try {
    await Native.clearAll()
  } catch {
    // best effort
  }
}

/** Move the single pre-multi-Mac key (kid '') under the migrated Mac's key id. Best effort. */
export async function adoptLegacyPushKey(hostId: string): Promise<void> {
  if (!pushSupported) return
  try {
    const legacy = (await listPushKeys()).find((k) => k.kid === '')
    if (!legacy) return
    await Native.set({ kid: pushKeyId(hostId), key: legacy.key })
    await Native.clear({ kid: '' })
  } catch {
    // The Mac just re-registers (new key) on next connect.
  }
}
