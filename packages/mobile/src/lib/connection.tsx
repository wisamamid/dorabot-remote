/**
 * The app's single connection to the paired Mac, plus the session state it feeds.
 *
 * Everything stateful lives here so screens can stay dumb: they read from the
 * context and call `rpc`. Reconnects, resume cursors and subscription replay are
 * handled below and never surface in the UI beyond a status dot.
 */
import {
  RemoteClient,
  SessionAggregator,
  emptySessionState,
  fromB64,
  identityFromB64,
  identityToB64,
  toB64,
  sessionMessagesToChatItems,
  mergeHistory,
  type ConnectionState,
  type DeviceSummary,
  type HostSummary,
  type KeyPair,
  type PairResult,
  type RelayInfo,
  type Scope,
  type SessionMessage,
  type SessionState,
  type StoredSession,
} from '@dorabot-remote/protocol'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { applySessionEvent, sortSessions } from './sessions-sync.js'
import { renameSession as renameSessionLogic } from './rename.js'
import { switchModel } from './models.js'
import { connLog, flushConnLog, loadConnLog, setConnMeta } from './connlog.js'
import { haptic, onAppBackground, onAppResume, onNetworkChange, storage } from './platform.js'

const PAIRING_KEY = 'dorabot-remote.pairing.v1'
const CURSOR_KEY = 'dorabot-remote.cursor.v1'

export interface StoredPairing {
  deviceId: string
  hostId: string
  hostName: string
  hostPublicKey: string
  addresses: string[]
  /** Blind relay, persisted so a cold start off the LAN can still reach the Mac. */
  relay?: RelayInfo
  identity: { publicKey: string; privateKey: string }
  scopes: Scope[]
  pairedAt: number
}

export interface Attention {
  kind: 'approval' | 'question' | 'elicitation'
  sessionKey: string
  at: number
}

interface ConnectionValue {
  ready: boolean
  pairing: StoredPairing | null
  state: ConnectionState
  stateDetail?: string
  host: HostSummary | null
  device: DeviceSummary | null
  gatewayConnected: boolean
  scopes: Scope[]
  sessions: StoredSession[]
  sessionsLoading: boolean
  /** Bumped on every state change so consumers re-render. */
  revision: number
  attention: Attention[]

  savePairing: (result: PairResult) => Promise<void>
  forget: () => Promise<void>
  rpc: <T = unknown>(method: string, params?: unknown) => Promise<T>
  can: (method: string) => boolean
  hasScope: (scope: Scope) => boolean
  refreshSessions: () => Promise<void>
  /** Optimistic rename by stored session id; rolls back and throws if the gateway refuses. */
  renameSession: (sessionId: string, name: string) => Promise<void>
  /** Optimistic per-session model switch; rolls back and throws on failure. */
  setSessionModel: (target: { sessionId: string; sessionKey: string; running: boolean }, model: string) => Promise<{ live: boolean }>
  openSession: (sessionKey: string, sessionId?: string) => Promise<void>
  /** Reload one session's transcript from the gateway (pull to refresh). */
  /** Winning transport while connected, for the status banner. */
  transport: 'lan' | 'relay' | null
  reloadHistory: (sessionKey: string, sessionId?: string) => Promise<void>
  getSession: (sessionKey: string) => SessionState
  /** Set when the bridge returned only the newest part of a long history. */
  getHistoryInfo: (sessionKey: string) => { shown: number; total: number } | null
  clearAttention: (sessionKey: string) => void
}

const Ctx = createContext<ConnectionValue | null>(null)

export function useConnection(): ConnectionValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useConnection must be used inside <ConnectionProvider>')
  return v
}

/** Node's `ws` is not here; the WebView provides the DOM WebSocket. */
const createSocket = (url: string) => new WebSocket(url) as never

export function ConnectionProvider({ children }: { children: ReactNode }): ReactNode {
  const [ready, setReady] = useState(false)
  const [pairing, setPairing] = useState<StoredPairing | null>(null)
  const [state, setState] = useState<ConnectionState>('idle')
  const [stateDetail, setStateDetail] = useState<string | undefined>()
  const [host, setHost] = useState<HostSummary | null>(null)
  const [device, setDevice] = useState<DeviceSummary | null>(null)
  const [gatewayConnected, setGatewayConnected] = useState(false)
  const [sessions, setSessions] = useState<StoredSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [transport, setTransport] = useState<'lan' | 'relay' | null>(null)
  const lastOpened = useRef<{ key: string; id?: string } | null>(null)
  const [revision, setRevision] = useState(0)
  const [attention, setAttention] = useState<Attention[]>([])

  const clientRef = useRef<RemoteClient | null>(null)
  const pairingRef = useRef<StoredPairing | null>(null)
  pairingRef.current = pairing
  const netTypeRef = useRef<string>('unknown')
  const aggRef = useRef(new SessionAggregator())
  const loadedHistory = useRef(new Set<string>())
  const historyInfo = useRef(new Map<string, { shown: number; total: number }>())
  const bump = useCallback(() => setRevision((r) => r + 1), [])

  // ---- restore ------------------------------------------------------------

  useEffect(() => {
    void loadConnLog()
    void (async () => {
      try {
        const raw = await storage.get(PAIRING_KEY)
        if (raw) {
          try {
            const p = JSON.parse(raw) as StoredPairing
            setPairing(p)
            connLog('app', `pairing restored: ${p.addresses.length} lan candidate(s), relay ${p.relay ? `${p.relay.u} id=${p.relay.i.slice(0, 6)}` : 'NOT stored'}`)
          } catch {
            await storage.remove(PAIRING_KEY).catch(() => {})
          }
        }
      } catch (err) {
        // Storage failed or hung: fall through to the Pair screen rather than
        // leaving the app on the spinner forever.
        console.error('[dorabot-remote] could not restore pairing', err)
      } finally {
        setReady(true)
      }
    })()
  }, [])

  // ---- connect ------------------------------------------------------------

  useEffect(() => {
    if (!pairing) return

    let cancelled = false
    let client: RemoteClient | null = null

    void (async () => {
      const cursorRaw = await storage.get(CURSOR_KEY).catch(() => null)
      const cursor = cursorRaw ? Number(cursorRaw) : 0
      if (cancelled) return

      const identity: KeyPair = identityFromB64(null, pairing.identity)
      aggRef.current.cursor = cursor

      client = new RemoteClient({
        identity,
        deviceId: pairing.deviceId,
        hostPublicKey: fromB64(null, pairing.hostPublicKey),
        addresses: pairing.addresses,
        relay: pairing.relay ?? null,
        createSocket,
        lastSeq: cursor,
        clientVersion: '0.1.0',
        log: (m) => connLog('client', m),
        onState: (s, detail) => {
          connLog('state', detail ? `${s} (${detail})` : s)
          setState(s)
          setStateDetail(detail)
        },
        onTransport: (t) => {
          connLog('transport', t ?? 'none')
          setConnMeta({ transport: t })
          setTransport(t)
        },
        onRelay: (relay) => {
          // The effect is keyed on identity fields only, so this does not rebuild the client.
          const cur = pairingRef.current
          if (!cur) return
          const next = { ...cur, relay }
          pairingRef.current = next
          setPairing(next)
          setConnMeta({ relayUrl: relay.u, relayId: relay.i.slice(0, 6) })
          void storage.set(PAIRING_KEY, JSON.stringify(next)).catch((e) => connLog('client', `could not persist relay: ${(e as Error).message}`))
        },
        onReady: (info) => {
          setHost(info.host)
          setDevice(info.device)
          setGatewayConnected(info.gatewayConnected)
          void refreshSessionsInternal()
          // Follow every session so an approval on any of them reaches the phone,
          // not just the one currently on screen.
          void client?.subscribe(aggRef.current.keys()).catch(() => {})
          // Whatever was on screen went stale while the link was down.
          const lo = lastOpened.current
          if (lo && loadedHistory.current.has(lo.key)) void openSessionRef.current(lo.key, lo.id, true)
        },
        onEvent: (event, data, seq, sessionKey) => {
          handleEvent(event, data, seq, sessionKey)
        },
      })
      clientRef.current = client
      client.setNetworkType(netTypeRef.current)
      setConnMeta({
        lan: pairing.addresses,
        relayUrl: pairing.relay?.u,
        relayId: pairing.relay?.i.slice(0, 6),
      })
      client.connect()
    })()

    return () => {
      cancelled = true
      client?.disconnect()
      clientRef.current = null
    }
    // Keyed on the paired identity, not the record: scope or relay updates must not rebuild the client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing?.deviceId, pairing?.pairedAt, pairing?.hostPublicKey])

  // Coming back from the background: nudge a resync rather than waiting for the
  // next backoff tick.
  // Going to the background: close cleanly so the Mac knows at once that this phone
  // is not looking (and can push instead). iOS would otherwise suspend the app with
  // the socket still open on the Mac's side.
  const backgrounded = useRef(false)
  useEffect(() => {
    return onAppBackground(() => {
      const c = clientRef.current
      if (!c || c.state === 'revoked') return
      backgrounded.current = true
      connLog('app', 'background: closing connection')
      c.disconnect()
      void flushConnLog()
    })
  }, [])

  // Wi-Fi to cellular (or back): the old socket is bound to a dead interface, so
  // replace it now rather than waiting for the ping timeout.
  useEffect(() => {
    return onNetworkChange(
      () => {
        const c = clientRef.current
        if (!c || c.state === 'revoked') return
        backgrounded.current = false
        connLog('net', 'network changed: forcing reconnect')
        c.forceReconnect()
      },
      (status, prev) => {
        netTypeRef.current = status.connectionType
        clientRef.current?.setNetworkType(status.connectionType)
        setConnMeta({ netType: status.connectionType, netConnected: status.connected })
        connLog('net', `${status.connectionType} ${status.connected ? 'connected' : 'offline'}${prev ? ` (was ${prev.connectionType} ${prev.connected ? 'connected' : 'offline'})` : ''}`)
      },
    )
  }, [])

  useEffect(() => {
    return onAppResume(() => {
      const c = clientRef.current
      connLog('app', `foreground (client ${c ? c.state : 'none'}, net ${netTypeRef.current})`)
      if (!c) return
      if (backgrounded.current) {
        // Intentional disconnect: reconnect straight away, skipping any backoff.
        backgrounded.current = false
        c.connect()
        return
      }
      // Probe the socket: after a long sleep it is usually half-open, and a
      // reconnect is forced at once if nothing answers. Not ready? Skip backoff.
      c.checkAlive(3000)
      if (c.state === 'ready') void refreshSessionsInternal()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sessionsRef = useRef<StoredSession[]>([])
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  // Coalesce bursts of list events into one refetch.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleSessionsRefresh = useCallback(() => {
    if (refreshTimer.current) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      void refreshSessionsInternal()
    }, 400)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current) }, [])

  // The gateway does not announce deletes, so keep the list honest with a slow poll.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden' && clientRef.current?.state === 'ready') void refreshSessionsInternal()
    }, 20000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleEvent = useCallback(
    (event: string, data: unknown, seq: number | undefined, sessionKey?: string) => {
      // Tap for features that keep their own cross-session state (the Inbox).
      // Same pattern as shell.data below: a window event, so they need no hook
      // into this file's internals.
      window.dispatchEvent(new CustomEvent('dorabot:event', { detail: { event, data, seq, sessionKey } }))
      if (event === 'remote.gateway_state') {
        setGatewayConnected((data as { state: string }).state === 'ready')
        return
      }
      if (event === 'remote.scopes_changed') {
        const next = (data as { scopes: Scope[] }).scopes
        setDevice((d) => (d ? { ...d, scopes: next } : d))
        setPairing((p) => (p ? { ...p, scopes: next } : p))
        void haptic('success')
        bump()
        return
      }

      // Terminal bytes bypass the aggregator entirely. The bridge has already
      // confirmed this shell belongs to this device; the Terminal screen picks
      // it up directly so a 60fps byte stream never triggers a React render.
      if (event === 'shell.data') {
        window.dispatchEvent(new CustomEvent('dorabot:shell', { detail: data }))
        return
      }

      // Session list changes made elsewhere (a rename or new session on the desktop).
      if (event === 'session.update' || event === 'sessions.update') {
        const id = event === 'session.update' ? (data as { id?: string })?.id : undefined
        const isNew = Boolean(id) && !sessionsRef.current.some((s) => s.id === id)
        setSessions((prev) => applySessionEvent(prev, event, data) ?? prev)
        // A rename needs the authoritative row; a new session needs it too, and a subscribe.
        if (event === 'sessions.update' || isNew) scheduleSessionsRefresh()
        return
      }

      const touched = aggRef.current.apply(event, data, seq, sessionKey)
      if (typeof seq === 'number') void storage.set(CURSOR_KEY, String(aggRef.current.cursor))

      // Three events mean a human has to do something or a run is stuck.
      if (event === 'agent.tool_approval' || event === 'agent.ask_user' || event === 'agent.elicitation') {
        const key = (sessionKey ?? touched) as string
        if (key) {
          const kind = event === 'agent.tool_approval' ? 'approval' : event === 'agent.ask_user' ? 'question' : 'elicitation'
          setAttention((prev) =>
            prev.some((a) => a.sessionKey === key && a.kind === kind)
              ? prev
              : [...prev, { kind: kind as Attention['kind'], sessionKey: key, at: Date.now() }],
          )
          void haptic(event === 'agent.ask_user' ? 'warning' : 'medium')
        }
      }
      if (event === 'agent.tool_approval_resolved' || event === 'agent.question_state') {
        setAttention((prev) => prev.filter((a) => aggRef.current.get(a.sessionKey).pendingApproval || aggRef.current.get(a.sessionKey).pendingQuestion))
      }
      if (event === 'agent.result' && touched) void haptic('light')

      if (touched) bump()
    },
    [bump, scheduleSessionsRefresh],
  )

  // ---- actions ------------------------------------------------------------

  const rpc = useCallback(async <T,>(method: string, params?: unknown): Promise<T> => {
    const c = clientRef.current
    if (!c) throw new Error('Not paired with a Mac yet.')
    return c.rpc<T>(method, params)
  }, [])

  const refreshSessionsInternal = useCallback(async () => {
    const c = clientRef.current
    if (!c || c.state !== 'ready') return
    setSessionsLoading(true)
    try {
      const list = await c.rpc<StoredSession[]>('sessions.list')
      const sorted = sortSessions(list ?? [])
      setSessions(sorted)
      const keys = sorted
        .map((s) => (s.channel && s.chatType && s.chatId ? `${s.channel}:${s.chatType}:${s.chatId}` : null))
        .filter((k): k is string => Boolean(k))
      if (keys.length) await c.subscribe(keys)
    } catch {
      // Offline. The status dot already says so.
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  /**
   * Open a session: load persisted history once, then let live events apply on
   * top. The bridge's durable log only goes back a week, so history is the cold
   * path and always comes from the gateway's own message store.
   */
  const openSession = useCallback(
    async (sessionKey: string, sessionId?: string, force = false) => {
      const c = clientRef.current
      if (!c) return
      await c.subscribe([sessionKey])
      if (sessionId) lastOpened.current = { key: sessionKey, id: sessionId }
      if (force) loadedHistory.current.delete(sessionKey)
      if (loadedHistory.current.has(sessionKey) || !sessionId) {
        bump()
        return
      }
      loadedHistory.current.add(sessionKey)
      try {
        const res = await c.rpc<
          { messages?: SessionMessage[]; truncated?: boolean; totalMessages?: number; returnedMessages?: number } | SessionMessage[]
        >('sessions.get', { sessionId })
        const messages = Array.isArray(res) ? res : (res?.messages ?? [])
        if (!Array.isArray(res) && res?.truncated) {
          historyInfo.current.set(sessionKey, {
            shown: res.returnedMessages ?? messages.length,
            total: res.totalMessages ?? messages.length,
          })
        } else {
          historyInfo.current.delete(sessionKey)
        }
        const existing = aggRef.current.get(sessionKey).chatItems
        const history = sessionMessagesToChatItems(messages)
        // History is authoritative. Items replayed live after a cold start are
        // already in it, so only live items newer than history are kept.
        aggRef.current.setChatItems(sessionKey, mergeHistory(history, existing))
      } catch {
        loadedHistory.current.delete(sessionKey)
      }
      bump()
    },
    [bump],
  )

  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession

  const savePairing = useCallback(async (result: PairResult) => {
    const record: StoredPairing = {
      deviceId: result.deviceId,
      hostId: result.hostId,
      hostName: result.hostName,
      hostPublicKey: toB64(null, result.hostPublicKey),
      addresses: result.addresses,
      relay: result.relay,
      identity: identityToB64(null, result.identity),
      scopes: result.scopes,
      pairedAt: Date.now(),
    }
    // Throws if the secure store fails or hangs; PairScreen shows that error.
    await storage.set(PAIRING_KEY, JSON.stringify(record))
    await storage.remove(CURSOR_KEY).catch(() => {})
    setPairing(record)
  }, [])

  const forget = useCallback(async () => {
    // Tell the Mac to stop notifying this phone before the key is gone. Best effort:
    // offline, or without the approvals scope, the Mac's token is dropped on revoke
    // or by APNs once the app is deleted.
    const live = clientRef.current
    if (live && live.state === 'ready') {
      await Promise.race([
        live.rpc('remote.unregisterPush').catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ])
    }
    await storage.remove('dorabot-remote.push.sent.v1').catch(() => {})
    clientRef.current?.disconnect()
    clientRef.current = null
    aggRef.current = new SessionAggregator()
    loadedHistory.current.clear()
    historyInfo.current.clear()
    await storage.remove(PAIRING_KEY)
    await storage.remove(CURSOR_KEY)
    setPairing(null)
    setSessions([])
    setHost(null)
    setDevice(null)
    setState('idle')
  }, [])

  const value = useMemo<ConnectionValue>(
    () => ({
      ready,
      pairing,
      state,
      stateDetail,
      host,
      device,
      gatewayConnected,
      scopes: device?.scopes ?? pairing?.scopes ?? [],
      sessions,
      sessionsLoading,
      transport,
      revision,
      attention,
      savePairing,
      forget,
      rpc,
      can: (method) => clientRef.current?.can(method) ?? false,
      hasScope: (scope) => (device?.scopes ?? pairing?.scopes ?? []).includes(scope),
      refreshSessions: refreshSessionsInternal,
      renameSession: (id, name) => renameSessionLogic({ rpc, setSessions }, id, name),
      setSessionModel: (t, m) => switchModel({ rpc, setSessions }, t, m),
      openSession: (k, id) => openSession(k, id),
      reloadHistory: (k, id) => openSession(k, id, true),
      getHistoryInfo: (key) => historyInfo.current.get(key) ?? null,
      getSession: (key) => (aggRef.current.keys().includes(key) ? aggRef.current.get(key) : emptySessionState(key)),
      clearAttention: (key) => setAttention((prev) => prev.filter((a) => a.sessionKey !== key)),
    }),
    [
      ready,
      pairing,
      state,
      stateDetail,
      host,
      device,
      gatewayConnected,
      sessions,
      sessionsLoading,
      transport,
      revision,
      attention,
      savePairing,
      forget,
      rpc,
      refreshSessionsInternal,
      openSession,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** `${channel}:${chatType}:${chatId}` for a stored session, or null. */
export function keyOf(s: StoredSession): string | null {
  if (!s.channel || !s.chatType || !s.chatId) return null
  return `${s.channel}:${s.chatType}:${s.chatId}`
}
