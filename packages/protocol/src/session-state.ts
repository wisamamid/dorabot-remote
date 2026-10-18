/**
 * A pure reducer that folds gateway events into per-session view state.
 *
 * The phone app is a thin shell over this: feed it every event the bridge
 * forwards and read the resulting SessionState. Keeping it pure and outside React
 * means it is directly testable against recorded event fixtures, which is how the
 * tricky streaming cases stay fixed once fixed.
 */
import type {
  AgentStatus,
  ChatItem,
  PendingApproval,
  PendingElicitation,
  PendingQuestion,
  SessionSnapshot,
  TaskProgress,
} from './gateway.js'
import {
  appendToolOutputDelta,
  applyStreamEvent,
  applyToolResult,
  cleanToolName,
  finalizeStreaming,
} from './stream.js'

export interface SessionState {
  sessionKey: string
  sessionId?: string
  chatItems: ChatItem[]
  status: AgentStatus
  statusDetail?: string
  pendingApproval: PendingApproval | null
  pendingQuestion: PendingQuestion | null
  pendingElicitation: PendingElicitation | null
  taskProgress: Record<string, TaskProgress>
  activeWorktrees: { path: string; branch: string }[]
  lastCost?: number
  lastError?: string
  updatedAt: number
}

export function emptySessionState(sessionKey: string): SessionState {
  return {
    sessionKey,
    chatItems: [],
    status: 'idle',
    pendingApproval: null,
    pendingQuestion: null,
    pendingElicitation: null,
    taskProgress: {},
    activeWorktrees: [],
    updatedAt: 0,
  }
}

/**
 * Tool results and output deltas can arrive before the tool_use block they belong
 * to, because `agent.tool_use` and the raw stream race. Anything unmatched is
 * parked here and retried after every stream event.
 */
interface Deferred {
  results: Array<{ toolUseId: string; content: string; imageData?: string; isError?: boolean }>
  deltas: Array<{ toolUseId: string; delta: string }>
}

function itemKey(it: ChatItem): string {
  switch (it.type) {
    case 'tool_use':
      return `tool:${it.id}`
    case 'result':
      return `result:${it.cost ?? ''}`
    case 'compacting':
      return 'compacting'
    default:
      return `${it.type}:${it.content}`
  }
}

/**
 * Merge loaded history with items the aggregator already built live (typically
 * from the bridge replaying events after a cold start, which history also holds).
 * History is authoritative: live items it already contains, or that precede
 * something it contains, are dropped; only live items newer than the last
 * overlap are appended. Works when history is a partial, newest-only slice.
 */
export function mergeHistory(history: ChatItem[], live: ChatItem[]): ChatItem[] {
  if (live.length === 0) return history
  const keys = history.map(itemKey)
  let pointer = 0
  let lastMatchedLive = -1
  for (let i = 0; i < live.length; i++) {
    const k = itemKey(live[i]!)
    const at = keys.indexOf(k, pointer)
    if (at !== -1) {
      pointer = at + 1
      lastMatchedLive = i
    }
  }
  return [...history, ...live.slice(lastMatchedLive + 1)]
}

export class SessionAggregator {
  private states = new Map<string, SessionState>()
  private deferred = new Map<string, Deferred>()
  /** Highest bridge seq applied, for gap-free resume after a dropped socket. */
  private lastSeq = 0
  /** Highest seq applied per session, so a replayed or re-sent event is ignored. */
  private seqByKey = new Map<string, number>()

  get cursor(): number {
    return this.lastSeq
  }

  set cursor(value: number) {
    this.lastSeq = value
  }

  get(sessionKey: string): SessionState {
    let s = this.states.get(sessionKey)
    if (!s) {
      s = emptySessionState(sessionKey)
      this.states.set(sessionKey, s)
    }
    return s
  }

  keys(): string[] {
    return [...this.states.keys()]
  }

  /** Replace a session's conversation, e.g. after loading history on cold start. */
  setChatItems(sessionKey: string, items: ChatItem[]): void {
    const s = this.get(sessionKey)
    this.states.set(sessionKey, { ...s, chatItems: items, updatedAt: Date.now() })
  }

  reset(sessionKey: string): void {
    this.states.set(sessionKey, emptySessionState(sessionKey))
    this.deferred.delete(sessionKey)
  }

  private patch(sessionKey: string, fn: (s: SessionState) => SessionState): SessionState {
    const next = { ...fn(this.get(sessionKey)), updatedAt: Date.now() }
    this.states.set(sessionKey, next)
    return next
  }

  private defer(sessionKey: string): Deferred {
    let d = this.deferred.get(sessionKey)
    if (!d) {
      d = { results: [], deltas: [] }
      this.deferred.set(sessionKey, d)
    }
    return d
  }

  /** Retry anything that arrived before the tool_use block it belongs to. */
  private drain(sessionKey: string): void {
    const d = this.deferred.get(sessionKey)
    if (!d || (d.results.length === 0 && d.deltas.length === 0)) return
    this.patch(sessionKey, (s) => {
      let items = s.chatItems
      d.deltas = d.deltas.filter((p) => {
        const r = appendToolOutputDelta(items, p.toolUseId, p.delta)
        items = r.items
        return !r.applied
      })
      d.results = d.results.filter((p) => {
        const r = applyToolResult(items, p)
        items = r.items
        return !r.applied
      })
      return items === s.chatItems ? s : { ...s, chatItems: items }
    })
  }

  /**
   * Apply one gateway event. Returns the session key that changed, or null if the
   * event was global or irrelevant.
   */
  apply(event: string, data: unknown, seq?: number, envelopeSessionKey?: string): string | null {
    if (typeof seq === 'number') {
      if (seq > this.lastSeq) this.lastSeq = seq
      // Per session, not global: a subscribe backfill legitimately delivers lower
      // seqs for a newly followed session than other sessions already reached.
      const key = envelopeSessionKey ?? ((data as { sessionKey?: string } | null)?.sessionKey ?? '')
      if (seq <= (this.seqByKey.get(key) ?? 0)) return null
      this.seqByKey.set(key, seq)
    }
    const d = (data ?? {}) as Record<string, unknown>
    const sk = d.sessionKey as string | undefined

    switch (event) {
      case 'agent.stream_batch': {
        // The gateway coalesces stream deltas on a 16ms timer. One queued event
        // goes out as `agent.stream`; two or more as this batch. Both shapes must
        // be handled or output silently stops under load.
        const batch = Array.isArray(data) ? data : ((d.data as unknown[]) ?? [])
        let touched: string | null = null
        for (const entry of batch as Record<string, unknown>[]) {
          const inner = (entry.data ?? entry) as Record<string, unknown>
          const key = inner.sessionKey as string | undefined
          if (!key) continue
          this.applyRawStream(key, inner.event as Record<string, unknown>)
          touched = key
        }
        return touched
      }

      case 'agent.stream': {
        if (!sk) return null
        this.applyRawStream(sk, d.event as Record<string, unknown>)
        return sk
      }

      case 'agent.user_message': {
        if (!sk) return null
        const prompt = d.prompt as string | undefined
        if (!prompt) return sk
        this.patch(sk, (s) => ({
          ...s,
          chatItems: [
            ...s.chatItems,
            { type: 'user', content: prompt, timestamp: (d.timestamp as number) ?? Date.now() },
          ],
        }))
        return sk
      }

      case 'agent.message': {
        // A complete assistant message. The stream path usually built it already,
        // so only adopt it when nothing is in flight.
        if (!sk) return null
        return sk
      }

      case 'agent.tool_use': {
        if (!sk) return null
        this.drain(sk)
        return sk
      }

      case 'agent.tool_output_delta': {
        if (!sk) return null
        const toolUseId = d.tool_use_id as string
        const delta = (d.delta as string) ?? ''
        const s = this.get(sk)
        const r = appendToolOutputDelta(s.chatItems, toolUseId, delta)
        if (r.applied) this.patch(sk, (cur) => ({ ...cur, chatItems: r.items }))
        else this.defer(sk).deltas.push({ toolUseId, delta })
        return sk
      }

      case 'agent.tool_result': {
        if (!sk) return null
        const payload = {
          toolUseId: d.tool_use_id as string,
          content: (d.content as string) ?? '',
          imageData: d.imageData as string | undefined,
          isError: Boolean(d.is_error),
        }
        const s = this.get(sk)
        const r = applyToolResult(s.chatItems, payload)
        if (r.applied) this.patch(sk, (cur) => ({ ...cur, chatItems: r.items }))
        else this.defer(sk).results.push(payload)
        return sk
      }

      case 'agent.status': {
        if (!sk) return null
        this.patch(sk, (s) => ({
          ...s,
          status: (d.status as AgentStatus) ?? s.status,
          statusDetail: (d.toolDetail as string) ?? (d.toolName ? cleanToolName(d.toolName as string) : undefined),
        }))
        return sk
      }

      case 'agent.result': {
        if (!sk) return null
        this.drain(sk)
        this.patch(sk, (s) => ({
          ...s,
          chatItems: [
            ...finalizeStreaming(s.chatItems),
            {
              type: 'result',
              cost: (d.usage as { total_cost_usd?: number } | undefined)?.total_cost_usd,
              timestamp: (d.timestamp as number) ?? Date.now(),
            },
          ],
          status: 'idle',
          statusDetail: undefined,
          sessionId: (d.sessionId as string) ?? s.sessionId,
        }))
        return sk
      }

      case 'agent.error': {
        if (!sk) return null
        this.patch(sk, (s) => ({
          ...s,
          chatItems: [
            ...finalizeStreaming(s.chatItems),
            { type: 'error', content: String(d.error ?? 'Unknown error'), timestamp: Date.now() },
          ],
          status: 'idle',
          lastError: String(d.error ?? ''),
        }))
        return sk
      }

      case 'agent.compacting': {
        if (!sk) return null
        this.patch(sk, (s) => ({
          ...s,
          chatItems: [...s.chatItems, { type: 'compacting', timestamp: Date.now() }],
        }))
        return sk
      }

      case 'agent.tool_approval': {
        if (!sk) return null
        this.patch(sk, (s) => ({ ...s, pendingApproval: d as unknown as PendingApproval }))
        return sk
      }

      case 'agent.tool_approval_resolved': {
        // Global: no sessionKey. Clear by requestId wherever it is parked.
        const requestId = d.requestId as string
        for (const [key, s] of this.states) {
          if (s.pendingApproval?.requestId === requestId) {
            this.patch(key, (cur) => ({ ...cur, pendingApproval: null }))
            return key
          }
        }
        return null
      }

      case 'agent.ask_user': {
        if (!sk) return null
        this.patch(sk, (s) => ({ ...s, pendingQuestion: d as unknown as PendingQuestion }))
        return sk
      }

      case 'agent.question_state': {
        const requestId = d.requestId as string
        const status = d.status as string
        if (status === 'pending') return sk ?? null
        for (const [key, s] of this.states) {
          if (s.pendingQuestion?.requestId === requestId) {
            this.patch(key, (cur) => ({ ...cur, pendingQuestion: null }))
            return key
          }
        }
        return null
      }

      case 'agent.question_dismissed': {
        const requestId = d.requestId as string
        for (const [key, s] of this.states) {
          if (s.pendingQuestion?.requestId === requestId) {
            this.patch(key, (cur) => ({ ...cur, pendingQuestion: null }))
            return key
          }
        }
        return null
      }

      case 'agent.elicitation': {
        if (!sk) return null
        this.patch(sk, (s) => ({ ...s, pendingElicitation: d as unknown as PendingElicitation }))
        return sk
      }

      case 'agent.elicitation_result': {
        if (!sk) return null
        this.patch(sk, (s) => ({ ...s, pendingElicitation: null }))
        return sk
      }

      case 'agent.task_started':
      case 'agent.task_progress':
      case 'agent.task_notification': {
        if (!sk) return null
        const taskId = d.taskId as string
        if (!taskId) return sk
        this.patch(sk, (s) => ({
          ...s,
          taskProgress: {
            ...s.taskProgress,
            [taskId]: { ...(s.taskProgress[taskId] ?? {}), ...(d as object) } as TaskProgress,
          },
        }))
        return sk
      }

      case 'agent.worktree_created': {
        if (!sk) return null
        this.patch(sk, (s) => ({
          ...s,
          activeWorktrees: [...s.activeWorktrees, { path: d.path as string, branch: d.branch as string }],
        }))
        return sk
      }

      case 'agent.worktree_removed': {
        if (!sk) return null
        this.patch(sk, (s) => ({ ...s, activeWorktrees: s.activeWorktrees.filter((w) => w.path !== d.path) }))
        return sk
      }

      case 'agent.conversation_reset': {
        if (!sk) return null
        this.reset(sk)
        return sk
      }

      case 'session.snapshot': {
        const snap = data as SessionSnapshot
        if (!snap?.sessionKey) return null
        this.patch(snap.sessionKey, (s) => ({
          ...s,
          status: snap.status ?? s.status,
          pendingApproval: snap.pendingApproval ?? null,
          pendingQuestion: snap.pendingQuestion
            ? { ...snap.pendingQuestion, sessionKey: snap.sessionKey }
            : null,
          pendingElicitation: snap.pendingElicitation ?? null,
          taskProgress: snap.taskProgress ?? s.taskProgress,
          activeWorktrees: snap.activeWorktrees ?? s.activeWorktrees,
          statusDetail: snap.currentTool ? cleanToolName(snap.currentTool.name) : undefined,
        }))
        return snap.sessionKey
      }

      default:
        return sk ?? null
    }
  }

  private applyRawStream(sessionKey: string, raw: Record<string, unknown> | undefined): void {
    if (!raw) return
    this.patch(sessionKey, (s) => {
      const items = applyStreamEvent(s.chatItems, raw)
      return items === s.chatItems ? s : { ...s, chatItems: items }
    })
    if (raw.type === 'content_block_start') this.drain(sessionKey)
  }
}
