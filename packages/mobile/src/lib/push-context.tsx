/**
 * Push state for the UI: permission, the APNs token, and keeping the Mac's copy
 * of the token current. The system permission prompt is never shown at launch;
 * the explainer card calls `enable()` when the user opts in.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useConnection } from './connection.js'
import { APNS_ENV, PUSH_PLATFORM, enablePush, listenPush, pushSupported, registerIfGranted, type PushPermission } from './push.js'
import { generatePushKey } from './push-crypto.js'
import { setPushKey, storedKeyIds } from './push-key.js'
import { markSent, planPushRegistrations, readSent, registerWithHost, withTempClient } from './push-hosts.js'
import { storage } from './platform.js'

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
  const chain = useRef<Promise<void>>(Promise.resolve())

  const paired = conn.pairings.length > 0
  // Any Mac that allows approvals gets this phone registered, not just the active one.
  const canPush = conn.pairings.some((p) => p.scopes.includes('approvals'))
  const activeCanPush = conn.hasScope('approvals')
  const connRef = useRef(conn)
  connRef.current = conn

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

  // The phone has one APNs token; each Mac keeps its own record of it plus its own content
  // key. Register with every Mac that is missing one (new token, newly paired, key lost): the
  // active Mac over the live link, the others over a short-lived connection. Runs are chained
  // so two never register the same Mac at once.
  useEffect(() => {
    if (!token || !canPush) return
    let alive = true
    chain.current = chain.current.then(async () => {
      if (!alive) return
      const c = connRef.current
      const [sent, keyIds] = await Promise.all([readSent(), storedKeyIds()])
      const plan = planPushRegistrations({ pairings: c.pairings, activeHostId: c.activeHostId, token, env: APNS_ENV, sent, keyIds })
      for (const hostId of plan) {
        if (!alive) return
        const p = c.pairings.find((x) => x.hostId === hostId)
        if (!p) continue
        const isActive = hostId === connRef.current.activeHostId
        // The active Mac is registered once its link is up; the others do not need it.
        if (isActive && connRef.current.state !== 'ready') continue
        try {
          const mk = (rpc: (m: string, params: unknown) => Promise<unknown>) => ({ rpc, newKey: generatePushKey, storeKey: setPushKey })
          const stamp = isActive
            ? await registerWithHost(mk((m, params) => connRef.current.rpcOn(hostId, m, params)), p, token, APNS_ENV, PUSH_PLATFORM)
            : await withTempClient(p, (rpc) => registerWithHost(mk(rpc), p, token, APNS_ENV, PUSH_PLATFORM))
          await markSent(hostId, stamp)
          if (isActive && alive) setRegistered(true)
        } catch {
          // Offline or refused: the next change (or launch) retries this Mac.
        }
      }
    })
    return () => {
      alive = false
    }
  }, [token, canPush, conn.state, conn.pairings, conn.activeHostId])

  // Reflect the bridge's per-device prefs in Settings.
  useEffect(() => {
    if (!activeCanPush || conn.state !== 'ready' || !pushSupported) return
    void conn
      .rpc<{ registered: boolean; notifyOnResult: boolean }>('remote.pushPrefs')
      .then((r) => {
        setNotify(Boolean(r?.notifyOnResult))
        setRegistered(Boolean(r?.registered))
      })
      .catch(() => {})
  }, [activeCanPush, conn.state, conn.activeHostId, conn.rpc])

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
