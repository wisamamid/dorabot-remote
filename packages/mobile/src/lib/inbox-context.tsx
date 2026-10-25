/**
 * Wires the pure Inbox reducer (lib/inbox.ts) to the live connection.
 *
 * It listens to the `dorabot:event` window event that the connection layer emits
 * for every gateway event, reconciles against `tool.pending` whenever the link
 * comes up or the app returns to the foreground, and exposes the answer actions
 * so a screen never has to know which RPC resolves which kind of item.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { requireApprovalAuth } from './approval-auth.js'
import { useConnection } from './connection.js'
import {
  actionable,
  emptyInbox,
  inboxReducer,
  type InboxItem,
  type InboxState,
} from './inbox.js'
import { haptic, onAppResume } from './platform.js'

interface InboxValue {
  items: InboxItem[]
  /** Items still waiting on a person: the tab badge. */
  count: number
  /** True once the first reconcile after (re)connecting has finished. */
  settled: boolean
  /** Whether this device may answer approvals at all. */
  canApprove: boolean
  reconcile: () => Promise<void>
  approve: (item: InboxItem, modifiedInput?: Record<string, unknown>) => Promise<void>
  deny: (item: InboxItem, reason?: string) => Promise<void>
  answerQuestion: (item: InboxItem, answers: Record<string, string>) => Promise<void>
  answerElicitation: (item: InboxItem, values: Record<string, unknown>) => Promise<void>
  dismissElicitation: (item: InboxItem) => Promise<void>
  dismissLocal: (item: InboxItem) => void
  /** Run an action on many approvals; resolves with how many failed. */
  batch: (items: InboxItem[], action: 'approve' | 'deny') => Promise<number>
}

const Ctx = createContext<InboxValue | null>(null)

export function useInbox(): InboxValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useInbox must be used inside <InboxProvider>')
  return v
}

/** The gateway says this when something else already resolved the item. */
const ALREADY_GONE = /no pending|already (answered|timeout|cancelled)|not found/i

export function InboxProvider({ children }: { children: ReactNode }): ReactNode {
  const conn = useConnection()
  const [state, dispatch] = useReducer(inboxReducer, emptyInbox as InboxState)
  const [settled, setSettled] = useState(false)
  const connRef = useRef(conn)
  connRef.current = conn

  // ---- live events --------------------------------------------------------

  useEffect(() => {
    const onEvent = (e: Event): void => {
      const { event, data } = (e as CustomEvent<{ event: string; data: unknown }>).detail
      dispatch({ type: 'event', event, data, now: Date.now() })
    }
    window.addEventListener('dorabot:event', onEvent)
    return () => window.removeEventListener('dorabot:event', onEvent)
  }, [])

  // ---- reconcile ----------------------------------------------------------

  const reconcile = useCallback(async (): Promise<void> => {
    const c = connRef.current
    if (c.state !== 'ready' || !c.can('tool.pending')) {
      setSettled(true)
      return
    }
    const startedAt = Date.now()
    try {
      const pending = await c.rpc<Array<{ requestId: string; toolName?: string; input?: Record<string, unknown> }>>('tool.pending')
      dispatch({ type: 'reconcile', pending: pending ?? [], startedAt, now: Date.now() })
      // Re-subscribing makes the gateway resend snapshots, which is how the
      // phone learns about questions and elicitations it missed.
      void c.refreshSessions()
    } catch {
      // Offline or the gateway is down; the next reconnect tries again.
    } finally {
      setSettled(true)
    }
  }, [])

  useEffect(() => {
    if (conn.state !== 'ready') {
      setSettled(false)
      return
    }
    void reconcile()
  }, [conn.state, conn.pairing?.hostId, reconcile])

  // The connection layer refreshes sessions on foreground; this is the part it
  // does not do. A second reconcile on the same tick is harmless.
  useEffect(() => onAppResume(() => void reconcile()), [reconcile])

  // Switching Macs must not leave the previous Mac's prompts on screen.
  useEffect(() => {
    dispatch({ type: 'clear' })
  }, [conn.pairing?.hostId, conn.demo])

  // ---- deadlines ----------------------------------------------------------

  const hasLiveQuestion = state.items.some((i) => i.kind === 'question' && !i.timedOut)
  useEffect(() => {
    if (!hasLiveQuestion) return
    const t = setInterval(() => dispatch({ type: 'tick', now: Date.now() }), 1000)
    return () => clearInterval(t)
  }, [hasLiveQuestion])

  // ---- actions ------------------------------------------------------------

  // Resolve, and treat "someone else got there first" as success: the item is
  // gone either way and the user should not see an error for it.
  const settle = useCallback(async (item: InboxItem, call: () => Promise<unknown>): Promise<void> => {
    try {
      await call()
    } catch (err) {
      if (!ALREADY_GONE.test((err as Error).message)) throw err
    }
    dispatch({ type: 'remove', id: item.id })
  }, [])

  const approve = useCallback(
    (item: InboxItem, modifiedInput?: Record<string, unknown>) =>
      settle(item, () =>
        connRef.current.rpc('tool.approve', { requestId: item.approval!.requestId, ...(modifiedInput ? { modifiedInput } : {}) }),
      ),
    [settle],
  )

  const deny = useCallback(
    (item: InboxItem, reason?: string) =>
      settle(item, () => connRef.current.rpc('tool.deny', { requestId: item.approval!.requestId, reason: reason?.trim() || undefined })),
    [settle],
  )

  const answerQuestion = useCallback(
    (item: InboxItem, answers: Record<string, string>) =>
      settle(item, () => connRef.current.rpc('chat.answerQuestion', { requestId: item.question!.requestId, answers })),
    [settle],
  )

  const answerElicitation = useCallback(
    (item: InboxItem, values: Record<string, unknown>) =>
      settle(item, () =>
        connRef.current.rpc('chat.answerElicitation', {
          elicitationId: item.elicitation!.elicitationId,
          values,
          sessionKey: item.sessionKey,
        }),
      ),
    [settle],
  )

  const dismissElicitation = useCallback(
    (item: InboxItem) =>
      settle(item, () =>
        connRef.current.rpc('chat.dismissElicitation', {
          elicitationId: item.elicitation!.elicitationId,
          sessionKey: item.sessionKey,
        }),
      ),
    [settle],
  )

  const dismissLocal = useCallback((item: InboxItem) => dispatch({ type: 'remove', id: item.id }), [])

  const batch = useCallback(
    async (items: InboxItem[], action: 'approve' | 'deny'): Promise<number> => {
      let failed = 0
      // One at a time: the gateway resolves each by request id, and a failure
      // part-way should leave the rest visible rather than half-applied.
      for (const item of items) {
        if (item.kind !== 'approval') continue
        try {
          if (action === 'approve') {
            // Same rule as a single approval: a risky one asks for Face ID on its own, every time.
            const a = item.approval!
            const refused = await requireApprovalAuth(a.toolName, a.input, a.blockedPath ? { blockedPath: a.blockedPath } : {})
            if (refused) throw new Error(refused)
            await approve(item)
          } else await deny(item)
        } catch {
          failed += 1
        }
      }
      await haptic(failed ? 'warning' : 'success')
      return failed
    },
    [approve, deny],
  )

  const value = useMemo<InboxValue>(() => {
    const live = actionable(state)
    return {
      items: state.items,
      count: live.length,
      settled,
      canApprove: conn.can('tool.approve'),
      reconcile,
      approve,
      deny,
      answerQuestion,
      answerElicitation,
      dismissElicitation,
      dismissLocal,
      batch,
    }
    // `conn.can` reads the live client; re-evaluate when scopes or state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, settled, conn.scopes, conn.state, reconcile, approve, deny, answerQuestion, answerElicitation, dismissElicitation, dismissLocal, batch])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
