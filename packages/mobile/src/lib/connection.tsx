/**
 * The app's connection to the active paired Mac, plus the session state it feeds.
 * Several Macs can be paired; exactly one is active (one RemoteClient) and
 * switching tears the client down and connects to the other. Everything cached in
 * memory is namespaced per Mac (see HostCaches in hosts.ts).
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
  type ImageAttachment,
  type KeyPair,
  type PairResult,
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
import { normalizePins, setPinned as setPinnedLogic, type Pin } from './pins.js'
import { switchModel } from './models.js'
import { connLog, flushConnLog, loadConnLog, setConnMeta } from './connlog.js'
import { createDemoClient, type ClientLike } from './demo.js'
import { haptic, onAppBackground, onAppResume, onNetworkChange, storage } from './platform.js'
import { adoptLegacyPushKey, clearAllPushKeys, clearPushKey } from './push-key.js'
import {
  HostCaches,
  PAIRINGS_KEY,
  activePairing,
  cursorKey,
  emptyPairings,
  loadPairings,
  removeLegacyIfMatches,
  removePairing,
  renamePairing,
  setActiveHost,
  updatePairing,
  upsertPairing,
  type HostPairing,
  type PairingsFile,
  type StoredPairing,
} from './hosts.js'
import { forgetSent } from './push-hosts.js'

export type { HostPairing, StoredPairing }

export interface Attention {
  kind: 'approval' | 'question' | 'elicitation'
  sessionKey: string
  at: number
}

interface ConnectionValue {
  ready: boolean
  /** The active Mac's pairing (null when none, or in demo mode). */
  pairing: HostPairing | null
  /** Every paired Mac, oldest first. */
  pairings: HostPairing[]
  activeHostId: string | null
  /** The pair screen is open to add another Mac without forgetting the current ones. */
  adding: boolean
  startAddMac: () => void
  cancelAddMac: () => void
  /** Make another paired Mac the active one: tears down this client and connects to it. */
  switchTo: (hostId: string) => void
  /** Local nickname for a Mac; empty clears it. */
  renameMac: (hostId: string, alias: string) => void
  state: ConnectionState
  stateDetail?: string
  host: HostSummary | null
  device: DeviceSummary | null
  gatewayConnected: boolean
  scopes: Scope[]
  sessions: StoredSession[]
  sessionsLoading: boolean
  /** Pinned sessions, newest pin first. Synced across devices through the bridge. */
  pins: Pin[]
  /** Optimistic pin/unpin by session key; rolls back and throws if the bridge refuses. */
  setPinned: (sessionKey: string, pinned: boolean) => Promise<void>
  /** Bumped on every state change so consumers re-render. */
  revision: number
  attention: Attention[]

  savePairing: (result: PairResult) => Promise<void>
  /** Unpair the active Mac only: unregisters push with it and deletes its keys and caches. */
  forget: () => Promise<void>
  rpc: <T = unknown>(method: string, params?: unknown) => Promise<T>
  /** Like rpc, but rejects at once unless that Mac is the active one (no race with a switch). */
  rpcOn: <T = unknown>(hostId: string, method: string, params?: unknown) => Promise<T>
  can: (method: string) => boolean
  hasScope: (scope: Scope) => boolean
  refreshSessions: () => Promise<void>
  /** Optimistic rename by stored session id; rolls back and throws if the gateway refuses. */
  renameSession: (sessionId: string, name: string) => Promise<void>
  /** Optimistic per-session model switch; rolls back and throws on failure. */
  setSessionModel: (target: { sessionId: string; sessionKey: string; running: boolean }, model: string) => Promise<{ live: boolean }>
  /** Show photos we just sent on the matching user bubble (the gateway echo carries only the text). */
  attachImages: (sessionKey: string, prompt: string, images: ImageAttachment[]) => void
  openSession: (sessionKey: string, sessionId?: string) => Promise<void>
  /** Reload one session's transcript from the gateway (pull to refresh). */
  /** Winning transport while connected, for the status banner. */
  transport: 'lan' | 'relay' | null
  reloadHistory: (sessionKey: string, sessionId?: string) => Promise<void>
  getSession: (sessionKey: string) => SessionState
  /** Set when the bridge returned only the newest part of a long history. */
  getHistoryInfo: (sessionKey: string) => { shown: number; total: number } | null
  clearAttention: (sessionKey: string) => void
  /** Demo mode: a fake Mac inside the app for App Review. Never touches pairing storage. */
  demo: boolean
  enterDemo: () => void
  exitDemo: () => void
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
  const [file, setFile] = useState<PairingsFile>(emptyPairings)
  const [adding, setAdding] = useState(false)
  const pairing = useMemo(() => activePairing(file), [file])
  const [state, setState] = useState<ConnectionState>('idle')
  const [stateDetail, setStateDetail] = useState<string | undefined>()
  const [host, setHost] = useState<HostSummary | null>(null)
  const [device, setDevice] = useState<DeviceSummary | null>(null)
  const [gatewayConnected, setGatewayConnected] = useState(false)
  const [sessions, setSessions] = useState<StoredSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [pins, setPins] = useState<Pin[]>([])
  const [transport, setTransport] = useState<'lan' | 'relay' | null>(null)
  const lastOpened = useRef<{ key: string; id?: string } | null>(null)
  const [revision, setRevision] = useState(0)
  const [attention, setAttention] = useState<Attention[]>([])
  const [demo, setDemo] = useState(false)
  const demoRef = useRef(false)
  demoRef.current = demo

  const clientRef = useRef<ClientLike | null>(null)
  const pairingRef = useRef<HostPairing | null>(null)
  pairingRef.current = pairing
  const fileRef = useRef<PairingsFile>(emptyPairings)
  const writeChain = useRef<Promise<void>>(Promise.resolve())
  const caches = useRef(new HostCaches())
  const netTypeRef = useRef<string>('unknown')
  const aggRef = useRef(new SessionAggregator())
  const loadedHistory = useRef(new Set<string>())
  const historyInfo = useRef(new Map<string, { shown: number; total: number }>())
  const bump = useCallback(() => setRevision((r) => r + 1), [])

  /** Change the pairings in memory at once; persisting (serialised) is optional. */
  const commit = useCallback((next: PairingsFile, persist = true): void => {
    fileRef.current = next
    setFile(next)
    if (!persist) return
    const json = JSON.stringify(next)
    writeChain.current = writeChain.current
      .then(() => storage.set(PAIRINGS_KEY, json))
      .catch((e) => connLog('app', `could not persist pairings: ${(e as Error).message}`))
  }, [])

  // ---- restore ------------------------------------------------------------

  useEffect(() => {
    void loadConnLog()
    void (async () => {
      try {
        const { file: loaded, migrated } = await loadPairings(storage)
        fileRef.current = loaded
        setFile(loaded)
        const p = activePairing(loaded)
        if (migrated && p) {
          connLog('app', 'migrated the single pairing to the multi-Mac list')
          void adoptLegacyPushKey(p.hostId)
        }
        if (p) connLog('app', `pairing restored (${loaded.pairings.length} Mac(s)): ${p.addresses.length} lan candidate(s), relay ${p.relay ? `${p.relay.u} id=${p.relay.i.slice(0, 6)}` : 'NOT stored'}`)
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
    const hostId = pairing.hostId

    // This Mac's own in-memory state; nothing of the previous Mac is shown.
    const cache = caches.current.get(hostId)
    aggRef.current = cache.agg
    loadedHistory.current = cache.loadedHistory
    historyInfo.current = cache.historyInfo
    lastOpened.current = null
    setSessions(cache.sessions)
    setPins(cache.pins)
    setAttention([])
    setHost(null)
    setDevice(null)
    setGatewayConnected(false)
    setTransport(null)
    setState('connecting')
    setStateDetail(undefined)
    bump()

    void (async () => {
      const cursorRaw = await storage.get(cursorKey(hostId)).catch(() => null)
      const cursor = Math.max(cursorRaw ? Number(cursorRaw) || 0 : 0, cache.agg.cursor)
      if (cancelled) return

      const identity: KeyPair = identityFromB64(null, pairing.identity)
      cache.agg.cursor = cursor

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
          if (cancelled) return
          connLog('state', detail ? `${s} (${detail})` : s)
          setState(s)
          setStateDetail(detail)
        },
        onTransport: (t) => {
          if (cancelled) return
          connLog('transport', t ?? 'none')
          setConnMeta({ transport: t })
          setTransport(t)
        },
        onRelay: (relay) => {
          // The effect is keyed on identity fields only, so this does not rebuild the client.
          if (cancelled) return
          commit(updatePairing(fileRef.current, hostId, (p) => ({ ...p, relay })))
          setConnMeta({ relayUrl: relay.u, relayId: relay.i.slice(0, 6) })
        },
        onReady: (info) => {
          if (cancelled) return
          setHost(info.host)
          setDevice(info.device)
          setGatewayConnected(info.gatewayConnected)
          void refreshSessionsInternal()
          void refreshPinsInternal()
          // Follow every session so an approval on any of them reaches the phone,
          // not just the one currently on screen.
          void client?.subscribe(cache.agg.keys()).catch(() => {})
          // Whatever was on screen went stale while the link was down.
          const lo = lastOpened.current
          if (lo && loadedHistory.current.has(lo.key)) void openSessionRef.current(lo.key, lo.id, true)
        },
        onEvent: (event, data, seq, sessionKey) => {
          if (cancelled) return
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
      // Keep what this Mac showed so switching back is instant (and nothing leaks into the next Mac).
      cache.sessions = sessionsRef.current
      cache.pins = pinsRef.current
      client?.disconnect()
      if (clientRef.current === client) clientRef.current = null
    }
    // Keyed on the paired identity, not the record: scope or relay updates must not rebuild the client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing?.hostId, pairing?.deviceId, pairing?.pairedAt, pairing?.hostPublicKey])

  // ---- demo ---------------------------------------------------------------

  // Runs against an in-app fake Mac. Deliberately separate from the effect above:
  // no storage reads or writes, no sockets, no push.
  useEffect(() => {
    if (!demo) return
    aggRef.current = new SessionAggregator()
    const client = createDemoClient({
      onState: (s) => {
        setState(s)
        setStateDetail(undefined)
      },
      onReady: (info) => {
        setHost(info.host)
        setDevice(info.device)
        setGatewayConnected(info.gatewayConnected)
        void refreshSessionsInternal()
        void refreshPinsInternal()
        void client.subscribe([])
      },
      onEvent: (event, data, seq, sessionKey) => handleEvent(event, data, seq, sessionKey),
    })
    clientRef.current = client
    client.connect()
    return () => {
      client.disconnect()
      if (clientRef.current === client) clientRef.current = null
      aggRef.current = new SessionAggregator()
      loadedHistory.current.clear()
      historyInfo.current.clear()
      setSessions([])
      setPins([])
      setAttention([])
      setHost(null)
      setDevice(null)
      setState('idle')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo])

  const enterDemo = useCallback(() => {
    if (fileRef.current.pairings.length === 0) setDemo(true)
  }, [])
  const exitDemo = useCallback(() => setDemo(false), [])

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
  const pinsRef = useRef<Pin[]>([])
  useEffect(() => {
    pinsRef.current = pins
  }, [pins])

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
      if (event === 'remote.pins_changed') {
        setPins(normalizePins((data as { pins?: unknown })?.pins))
        return
      }
      if (event === 'remote.scopes_changed') {
        const next = (data as { scopes: Scope[] }).scopes
        setDevice((d) => (d ? { ...d, scopes: next } : d))
        const cur = pairingRef.current
        if (cur) commit(updatePairing(fileRef.current, cur.hostId, (p) => ({ ...p, scopes: next })))
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
      const hid = pairingRef.current?.hostId
      if (typeof seq === 'number' && hid) void storage.set(cursorKey(hid), String(aggRef.current.cursor))

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
    [bump, commit, scheduleSessionsRefresh],
  )

  // ---- actions ------------------------------------------------------------

  const rpc = useCallback(async <T,>(method: string, params?: unknown): Promise<T> => {
    const c = clientRef.current
    if (!c) throw new Error('Not paired with a Mac yet.')
    return c.rpc<T>(method, params)
  }, [])

  const refreshPinsInternal = useCallback(async () => {
    const c = clientRef.current
    if (!c || c.state !== 'ready') return
    // Without the sessions scope the bridge refuses; the list simply has no pins.
    try {
      const next = normalizePins(await c.rpc('remote.pins.list'))
      // Switched Macs while this was in flight: that answer belongs to the other Mac.
      if (clientRef.current === c) setPins(next)
    } catch {
      // Offline or an older bridge without pins: keep what we have.
    }
  }, [])

  const refreshSessionsInternal = useCallback(async () => {
    const c = clientRef.current
    if (!c || c.state !== 'ready') return
    setSessionsLoading(true)
    try {
      const list = await c.rpc<StoredSession[]>('sessions.list')
      if (clientRef.current !== c) return
      const sorted = sortSessions(list ?? [])
      setSessions(sorted)
      const keys = sorted
        .map((s) => (s.channel && s.chatType && s.chatId ? `${s.channel}:${s.chatType}:${s.chatId}` : null))
        .filter((k): k is string => Boolean(k))
      if (keys.length) await c.subscribe(keys)
    } catch {
      // Offline. The status dot already says so.
    } finally {
      if (clientRef.current === c) setSessionsLoading(false)
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
      // Per-Mac state captured now: a switch mid-flight must not write into the other Mac's cache.
      const loaded = loadedHistory.current
      const info = historyInfo.current
      const agg = aggRef.current
      await c.subscribe([sessionKey])
      if (clientRef.current !== c) return
      if (sessionId) lastOpened.current = { key: sessionKey, id: sessionId }
      if (force) loaded.delete(sessionKey)
      if (loaded.has(sessionKey) || !sessionId) {
        bump()
        return
      }
      loaded.add(sessionKey)
      try {
        const res = await c.rpc<
          { messages?: SessionMessage[]; truncated?: boolean; totalMessages?: number; returnedMessages?: number } | SessionMessage[]
        >('sessions.get', { sessionId })
        if (clientRef.current !== c) {
          loaded.delete(sessionKey)
          return
        }
        const messages = Array.isArray(res) ? res : (res?.messages ?? [])
        if (!Array.isArray(res) && res?.truncated) {
          info.set(sessionKey, {
            shown: res.returnedMessages ?? messages.length,
            total: res.totalMessages ?? messages.length,
          })
        } else {
          info.delete(sessionKey)
        }
        const existing = agg.get(sessionKey).chatItems
        const history = sessionMessagesToChatItems(messages)
        // History is authoritative. Items replayed live after a cold start are
        // already in it, so only live items newer than history are kept.
        agg.setChatItems(sessionKey, mergeHistory(history, existing))
      } catch {
        loaded.delete(sessionKey)
      }
      bump()
    },
    [bump],
  )

  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession

  const savePairing = useCallback(async (result: PairResult) => {
    const now = Date.now()
    const record: HostPairing = {
      deviceId: result.deviceId,
      hostId: result.hostId,
      hostName: result.hostName,
      hostPublicKey: toB64(null, result.hostPublicKey),
      addresses: result.addresses,
      relay: result.relay,
      identity: identityToB64(null, result.identity),
      scopes: result.scopes,
      pairedAt: now,
      addedAt: now,
    }
    const next = upsertPairing(fileRef.current, record)
    // Throws if the secure store fails or hangs; PairScreen shows that error.
    await writeChain.current
    await storage.set(PAIRINGS_KEY, JSON.stringify(next))
    // A fresh pairing (new device identity) starts with no cursor and no cached state for that Mac.
    await storage.remove(cursorKey(record.hostId)).catch(() => {})
    caches.current.drop(record.hostId)
    setAdding(false)
    commit(next, false)
  }, [commit])

  const switchTo = useCallback(
    (hostId: string) => {
      if (demoRef.current) return
      const f = fileRef.current
      setAdding(false)
      if (hostId === f.activeHostId || !f.pairings.some((p) => p.hostId === hostId)) return
      connLog('app', `switching Mac -> ${hostId.slice(0, 6)}`)
      void haptic('light')
      // Same batch as the new active Mac, so nothing sees the old Mac's 'ready' next to the new Mac's id.
      setState('connecting')
      setStateDetail(undefined)
      commit(setActiveHost(f, hostId))
    },
    [commit],
  )

  const renameMac = useCallback(
    (hostId: string, alias: string) => commit(renamePairing(fileRef.current, hostId, alias)),
    [commit],
  )

  const forget = useCallback(async () => {
    // In the demo there is nothing real to forget; never reach the pairing storage below.
    if (demoRef.current) {
      setDemo(false)
      return
    }
    const p = pairingRef.current
    if (!p) return
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
    const next = removePairing(fileRef.current, p.hostId)
    await forgetSent(p.hostId)
    await clearPushKey(p.hostId)
    if (next.pairings.length === 0) void clearAllPushKeys()
    caches.current.drop(p.hostId)
    await removeLegacyIfMatches(storage, p.hostId)
    await storage.remove(cursorKey(p.hostId)).catch(() => {})
    await writeChain.current
    if (next.pairings.length === 0) await storage.remove(PAIRINGS_KEY)
    else await storage.set(PAIRINGS_KEY, JSON.stringify(next))
    if (next.pairings.length === 0) {
      clientRef.current?.disconnect()
      clientRef.current = null
      aggRef.current = new SessionAggregator()
      loadedHistory.current = new Set()
      historyInfo.current = new Map()
      setSessions([])
      setPins([])
      setAttention([])
      setHost(null)
      setDevice(null)
      setState('idle')
    }
    if (next.pairings.length > 0) setState('connecting')
    setAdding(false)
    commit(next, false)
  }, [commit])

  const value = useMemo<ConnectionValue>(
    () => ({
      ready,
      pairing,
      pairings: file.pairings,
      activeHostId: file.activeHostId,
      adding,
      startAddMac: () => {
        if (!demoRef.current) setAdding(true)
      },
      cancelAddMac: () => setAdding(false),
      switchTo,
      renameMac,
      state,
      stateDetail,
      host,
      device,
      gatewayConnected,
      scopes: device?.scopes ?? pairing?.scopes ?? [],
      sessions,
      sessionsLoading,
      pins,
      setPinned: (key, pinned) => setPinnedLogic({ rpc, setPins }, key, pinned),
      transport,
      revision,
      attention,
      savePairing,
      forget,
      rpc,
      rpcOn: (hostId, method, params) =>
        pairingRef.current?.hostId === hostId ? rpc(method, params) : Promise.reject(new Error('That Mac is not the active one.')),
      can: (method) => clientRef.current?.can(method) ?? false,
      hasScope: (scope) => (device?.scopes ?? pairing?.scopes ?? []).includes(scope),
      refreshSessions: refreshSessionsInternal,
      renameSession: (id, name) => renameSessionLogic({ rpc, setSessions }, id, name),
      setSessionModel: (t, m) => switchModel({ rpc, setSessions }, t, m),
      attachImages: (k, prompt, images) => {
        aggRef.current.attachImages(k, prompt, images)
        bump()
      },
      openSession: (k, id) => openSession(k, id),
      reloadHistory: (k, id) => openSession(k, id, true),
      getHistoryInfo: (key) => historyInfo.current.get(key) ?? null,
      getSession: (key) => (aggRef.current.keys().includes(key) ? aggRef.current.get(key) : emptySessionState(key)),
      clearAttention: (key) => setAttention((prev) => prev.filter((a) => a.sessionKey !== key)),
      demo,
      enterDemo,
      exitDemo,
    }),
    [
      ready,
      pairing,
      file,
      adding,
      switchTo,
      renameMac,
      state,
      stateDetail,
      host,
      device,
      gatewayConnected,
      sessions,
      sessionsLoading,
      pins,
      transport,
      revision,
      attention,
      savePairing,
      forget,
      rpc,
      refreshSessionsInternal,
      openSession,
      bump,
      demo,
      enterDemo,
      exitDemo,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** `${channel}:${chatType}:${chatId}` for a stored session, or null. */
export function keyOf(s: StoredSession): string | null {
  if (!s.channel || !s.chatType || !s.chatId) return null
  return `${s.channel}:${s.chatType}:${s.chatId}`
}
