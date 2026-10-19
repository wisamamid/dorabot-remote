/**
 * The push content key lives in the iOS Keychain, in an access group shared with
 * the Notification Service Extension (native plugin `PushKeyStore`, see
 * ios/App/App/PushKeyStorePlugin.swift).
 *
 * Same rule as platform.ts: the plugin proxy is a thenable, so it is a module-level
 * constant used inside these functions and never returned or resolved.
 */
import { registerPlugin } from '@capacitor/core'
import { isNative, platformName } from './platform.js'

const pushSupported = isNative && platformName === 'ios'

interface PushKeyStorePlugin {
  set(opts: { key: string }): Promise<void>
  get(): Promise<{ key?: string }>
  clear(): Promise<void>
}

const Native = registerPlugin<PushKeyStorePlugin>('PushKeyStore')

export async function setPushKey(keyB64: string): Promise<void> {
  if (!pushSupported) return
  await Native.set({ key: keyB64 })
}

export async function getPushKey(): Promise<string | null> {
  if (!pushSupported) return null
  try {
    const r = await Native.get()
    return typeof r?.key === 'string' && r.key ? r.key : null
  } catch {
    return null
  }
}

export async function clearPushKey(): Promise<void> {
  if (!pushSupported) return
  try {
    await Native.clear()
  } catch {
    // best effort
  }
}
