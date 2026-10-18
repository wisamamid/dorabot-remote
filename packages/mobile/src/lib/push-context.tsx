/**
 * Push state for the UI: permission, the APNs token, and keeping the Mac's copy
 * of the token current. The system permission prompt is never shown at launch;
 * the explainer card calls `enable()` when the user opts in.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useConnection } from './connection.js'
import { APNS_ENV, enablePush, listenPush, pushSupported, registerIfGranted, type PushPermission } from './push.js'
import { storage } from './platform.js'

const SENT_KEY = 'dorabot-remote.push.sent.v1'
const DISMISS_KEY = 'dorabot-remote.push.dismissed.v1'
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000

interface PushValue {
  supported: boolean
  permission: PushPermission
  /** Show the explainer card: undecided, not dismissed recently, and this device can be notified. */
  shouldPrompt: boolean
  registered: boolean
  notifyOnResult: boolean
  enable: () => Promise<void>
  dismiss: () => void
  setNotifyOnResult: (on: boolean) => Promise<void>
}

const Ctx = createContext<PushValue | null>(null)

export function usePush(): PushValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('usePush must be used inside <PushProvider>')
  return v
}

export function PushProvider({ children }: { children: ReactNode }): ReactNode {
  const conn = useConnection()
  const [permission, setPermission] = useState<PushPermission>(pushSupported ? 'prompt' : 'unsupported')
  const [checked, setChecked] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [registered, setRegistered] = useState(false)
  const [notifyOnResult, setNotify] = useState(false)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const sending = useRef(false)

  const paired = Boolean(conn.pairing)
  const canPush = paired && conn.hasScope('approvals')

  // On every start while paired: learn the permission state, and if already granted
  // re-register silently so a rotated token is noticed.
  useEffect(() => {
    if (!paired || !pushSupported) return
    let alive = true
    void (async () => {
      const p = await registerIfGranted()
      const raw = await storage.get(DISMISS_KEY).catch(() => null)
      if (!alive) return
      setPermission(p)
      setDismissedAt(raw ? Number(raw) : null)
      setChecked(true)
    })()
    return () => {
      alive = false
    }
  }, [paired])

  useEffect(() => {
    if (!paired) return
    return listenPush((t) => setToken(t))
  }, [paired])

  // Send the token once connected; again if it changes, or after re-pairing.
  useEffect(() => {
    if (!token || !canPush || conn.state !== 'ready' || !conn.pairing || sending.current) return
    const stamp = `${conn.pairing.deviceId}:${APNS_ENV}:${token}`
    let alive = true
    sending.current = true
    void (async () => {
      try {
        const last = await storage.get(SENT_KEY).catch(() => null)
        if (last === stamp) {
          setRegistered(true)
          return
        }
        await conn.rpc('remote.registerPush', { token, platform: 'ios', env: APNS_ENV })
        await storage.set(SENT_KEY, stamp).catch(() => {})
        if (alive) setRegistered(true)
      } catch {
        // Offline or refused: the next ready transition retries.
      } finally {
        sending.current = false
      }
    })()
    return () => {
      alive = false
    }
  }, [token, canPush, conn.state, conn.pairing, conn.rpc])

  // Reflect the bridge's per-device prefs in Settings.
  useEffect(() => {
    if (!canPush || conn.state !== 'ready' || !pushSupported) return
    void conn
      .rpc<{ registered: boolean; notifyOnResult: boolean }>('remote.pushPrefs')
      .then((r) => {
        setNotify(Boolean(r?.notifyOnResult))
        setRegistered(Boolean(r?.registered))
      })
      .catch(() => {})
  }, [canPush, conn.state, conn.rpc])

  const enable = useCallback(async () => {
    const p = await enablePush()
    setPermission(p)
  }, [])

  const dismiss = useCallback(() => {
    const now = Date.now()
    setDismissedAt(now)
    void storage.set(DISMISS_KEY, String(now)).catch(() => {})
  }, [])

  const setNotifyOnResult = useCallback(
    async (on: boolean) => {
      setNotify(on)
      try {
        await conn.rpc('remote.setPushPrefs', { notifyOnResult: on })
      } catch (err) {
        setNotify(!on)
        throw err
      }
    },
    [conn.rpc],
  )

  const value = useMemo<PushValue>(
    () => ({
      supported: pushSupported,
      permission,
      shouldPrompt:
        pushSupported && checked && canPush && permission === 'prompt' && (dismissedAt === null || Date.now() - dismissedAt > DISMISS_MS),
      registered,
      notifyOnResult,
      enable,
      dismiss,
      setNotifyOnResult,
    }),
    [permission, checked, canPush, dismissedAt, registered, notifyOnResult, enable, dismiss, setNotifyOnResult],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
