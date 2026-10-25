/**
 * Optional Face ID lock for the whole app. Off by default. When on, the app asks
 * for Face ID (or the device passcode) on a cold start and when it returns from
 * the background after more than 15 seconds. `verify()` is the same helper the
 * notification Approve / Deny actions use.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { authenticate, type AuthResult } from './biometric.js'
import { isNative, onAppBackground, onAppResume, storage } from './platform.js'

/** Matches SECRET_KEY, so the on/off flag lives in the Keychain (old Preferences copies are migrated on first read). */
export const APPLOCK_KEY = 'dorabot-remote.applock.v1'
const KEY = APPLOCK_KEY
export const LOCK_GRACE_MS = 15_000

export function shouldLock(enabled: boolean, hiddenAt: number | null, now: number, graceMs = LOCK_GRACE_MS): boolean {
  return enabled && hiddenAt !== null && now - hiddenAt > graceMs
}

interface AppLockValue {
  /** The lock is available on this platform (native only). */
  supported: boolean
  enabled: boolean
  locked: boolean
  setEnabled: (on: boolean) => Promise<boolean>
  /** Ask for Face ID / passcode; unlocks the app on success. */
  verify: (reason: string, opts?: { fresh?: boolean }) => Promise<AuthResult>
}

const Ctx = createContext<AppLockValue | null>(null)

export function useAppLock(): AppLockValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAppLock must be used inside <AppLockProvider>')
  return v
}

export function AppLockProvider({ children }: { children: ReactNode }): ReactNode {
  // Until the setting is read, a native app is treated as locked so nothing flashes.
  const [loaded, setLoaded] = useState(!isNative)
  const [enabled, setEnabledState] = useState(false)
  const [locked, setLocked] = useState(isNative)
  const hiddenAt = useRef<number | null>(null)
  const enabledRef = useRef(false)
  enabledRef.current = enabled

  useEffect(() => {
    if (!isNative) return
    let alive = true
    void storage
      .get(KEY)
      .catch(() => null)
      .then((v) => {
        if (!alive) return
        const on = v === '1'
        setEnabledState(on)
        setLocked(on)
        setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const offBg = onAppBackground(() => {
      hiddenAt.current ??= Date.now()
    })
    const offFg = onAppResume(() => {
      if (shouldLock(enabledRef.current, hiddenAt.current, Date.now())) setLocked(true)
      hiddenAt.current = null
    })
    return () => {
      offBg()
      offFg()
    }
  }, [])

  const verify = useCallback(async (reason: string, opts?: { fresh?: boolean }): Promise<AuthResult> => {
    const r = await authenticate(reason, { fresh: opts?.fresh })
    // 'unavailable' means no biometrics and no passcode: nothing to check, so do not trap the user.
    if (r === 'ok' || r === 'unavailable') setLocked(false)
    return r
  }, [])

  const setEnabled = useCallback(
    async (on: boolean): Promise<boolean> => {
      if (on) {
        // Prove it works before turning it on, so a phone without a passcode cannot lock itself out.
        const r = await authenticate('Turn on Face ID lock')
        if (r !== 'ok') return false
      }
      setEnabledState(on)
      await storage.set(KEY, on ? '1' : '0').catch(() => {})
      return true
    },
    [],
  )

  const value = useMemo<AppLockValue>(
    () => ({ supported: isNative, enabled, locked: locked && (enabled || !loaded), setEnabled, verify }),
    [enabled, locked, loaded, setEnabled, verify],
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      {value.locked && <LockScreen ready={loaded} onUnlock={() => verify('Unlock DoraBot Remote')} />}
    </Ctx.Provider>
  )
}

function LockScreen({ ready, onUnlock }: { ready: boolean; onUnlock: () => Promise<AuthResult> }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const tried = useRef(false)

  const unlock = useCallback(async () => {
    setBusy(true)
    setNote(null)
    const r = await onUnlock()
    setBusy(false)
    if (r === 'unavailable') setNote('Face ID and a passcode are not set up on this phone.')
    else if (r !== 'ok') setNote('Not unlocked.')
  }, [onUnlock])

  // Ask straight away once, so the common case is one glance.
  useEffect(() => {
    if (!ready || tried.current) return
    tried.current = true
    void unlock()
  }, [ready, unlock])

  return createPortal(
    // Portalled to the body (outside #root) and lifted by --kb like the other overlays.
    <div
      role="dialog"
      aria-label="Locked"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-ink-900 px-8 text-center"
      style={{ paddingBottom: 'var(--kb, 0px)' }}
    >
      <svg viewBox="0 0 24 24" className="size-12 text-ink-300" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      <p className="text-[19px] font-semibold">DoraBot Remote is locked</p>
      {note && <p className="text-[14px] text-ink-400">{note}</p>}
      <button
        onClick={() => void unlock()}
        disabled={busy || !ready}
        className="rounded-xl bg-mint-500 px-6 py-3 text-[16px] font-semibold text-ink-950 active:opacity-80 disabled:opacity-50"
      >
        Unlock
      </button>
    </div>,
    document.body,
  )
}
