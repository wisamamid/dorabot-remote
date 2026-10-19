/**
 * Face ID / Touch ID with device-passcode fallback. Shared by the app lock and by
 * notification actions (Approve / Deny).
 *
 * Plugin objects are thenables (see platform.ts), so it is only ever used inside
 * this function, never returned.
 */
import { isNative } from './platform.js'

export type AuthResult = 'ok' | 'cancelled' | 'unavailable' | 'failed'

let inflight: Promise<AuthResult> | null = null
let lastOkAt = 0

/** A success this recent satisfies another request (the lock screen and a notification action can race on a cold start). */
export const RECENT_AUTH_MS = 15_000

export function recentlyAuthed(now: number, lastOk: number, windowMs = RECENT_AUTH_MS): boolean {
  return lastOk > 0 && now - lastOk >= 0 && now - lastOk < windowMs
}

async function run(reason: string): Promise<AuthResult> {
  if (!isNative) return 'unavailable'
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth')
    const info = await BiometricAuth.checkBiometry()
    // No biometrics and no passcode: nothing to ask. Callers decide whether that is acceptable.
    if (!info.isAvailable && !info.deviceIsSecure) return 'unavailable'
    await BiometricAuth.authenticate({ reason, allowDeviceCredential: true, cancelTitle: 'Cancel', iosFallbackTitle: 'Use passcode' })
    return 'ok'
  } catch (err) {
    const code = String((err as { code?: unknown })?.code ?? '')
    if (code === 'userCancel' || code === 'appCancel' || code === 'systemCancel') return 'cancelled'
    if (code === 'biometryNotAvailable' || code === 'biometryNotEnrolled' || code === 'passcodeNotSet' || code === 'noDeviceCredential') return 'unavailable'
    return 'failed'
  }
}

/** One prompt at a time; concurrent callers share it. */
export function authenticate(reason: string, now: () => number = Date.now): Promise<AuthResult> {
  if (recentlyAuthed(now(), lastOkAt)) return Promise.resolve('ok')
  inflight ??= run(reason)
    .then((r) => {
      if (r === 'ok') lastOkAt = now()
      return r
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
