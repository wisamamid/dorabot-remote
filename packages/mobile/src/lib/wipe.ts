/**
 * Self-wipe for a lost or stolen phone. After MAX_LOCK_FAILS consecutive failed Face ID / passcode attempts
 * at the app lock, the app deletes everything it holds: the pairings (which contain the device private key),
 * the push content keys in the Keychain, cursors and caches. It then reloads onto the Pair screen, which shows
 * WIPE_MESSAGE once. The Mac still lists the phone until the user revokes it ("Lost" / lockdown on the Mac).
 *
 * Pure of any plugin access: everything native comes in through WipeDeps, so it is unit tested.
 */
import type { AuthResult } from './biometric.js'
import { LEGACY_CURSOR_KEY, LEGACY_PAIRING_KEY, PAIRINGS_KEY, parsePairingsFile, cursorKey, type KeyValueIO } from './hosts.js'

export const MAX_LOCK_FAILS = 5
/** Matches SECRET_KEY (".applock."), so the counter lives in the Keychain and survives killing the app. */
export const LOCK_FAILS_KEY = 'dorabot-remote.applock.fails.v1'
/** Not a secret: a one-shot message for the Pair screen. */
export const WIPE_NOTICE_KEY = 'dorabot-remote.wipenotice.v1'
export const WIPE_MESSAGE = `For your safety, DoraBot Remote erased all pairings and keys after ${MAX_LOCK_FAILS} failed unlock attempts. Pair your Mac again to continue.`

/**
 * Only a real failure counts. Cancelling the prompt is not a failed attempt (it unlocks nothing either),
 * and 'unavailable' means there is nothing to check.
 */
export function afterAttempt(prev: number, result: AuthResult, max = MAX_LOCK_FAILS): { fails: number; wipe: boolean } {
  if (result === 'ok') return { fails: 0, wipe: false }
  if (result !== 'failed') return { fails: prev, wipe: false }
  const fails = prev + 1
  return { fails, wipe: fails >= max }
}

export function attemptsLeft(fails: number, max = MAX_LOCK_FAILS): number {
  return Math.max(0, max - fails)
}

export function parseFails(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n < 1000 ? n : 0
}

export interface WipeDeps {
  io: KeyValueIO & { clearAll(): Promise<void> }
  clearAllPushKeys(): Promise<void>
  clearNotifications?(): Promise<void>
  /** Copies of data outside the app's own storage: widget snapshot, pending shares, Live Activity, the watch's list. */
  clearShared?(): Promise<void>
  log?(msg: string): void
}

/** Runs every step even if one fails (a half wipe is worse than a noisy one). Returns the failures. */
export async function selfWipe(deps: WipeDeps): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = []
  const step = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run()
    } catch (err) {
      errors.push(`${label}: ${(err as Error).message}`)
      deps.log?.(`wipe step failed (${label}): ${(err as Error).message}`)
    }
  }

  // Per-Mac cursors are keyed by hostId, so read the pairings before deleting them.
  let hostIds: string[] = []
  try {
    hostIds = (parsePairingsFile(await deps.io.get(PAIRINGS_KEY))?.pairings ?? []).map((p) => p.hostId)
  } catch {
    // The blanket clear below still covers them.
  }
  await step('pairings', () => deps.io.remove(PAIRINGS_KEY))
  await step('legacy pairing', () => deps.io.remove(LEGACY_PAIRING_KEY))
  await step('legacy cursor', () => deps.io.remove(LEGACY_CURSOR_KEY))
  for (const id of hostIds) await step('cursor', () => deps.io.remove(cursorKey(id)))
  await step('push keys', () => deps.clearAllPushKeys())
  await step('storage', () => deps.io.clearAll())
  await step('lock counter', () => deps.io.remove(LOCK_FAILS_KEY))
  if (deps.clearNotifications) await step('notifications', () => deps.clearNotifications!())
  if (deps.clearShared) await step('shared data', () => deps.clearShared!())
  // Last, after the clear: the one thing that must survive.
  await step('notice', () => deps.io.set(WIPE_NOTICE_KEY, '1'))
  return { ok: errors.length === 0, errors }
}
