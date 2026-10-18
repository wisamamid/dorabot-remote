/**
 * The Inbox's state, as a pure reducer.
 *
 * Everything on the phone that blocks a run on a human lands here: tool approvals,
 * AskUserQuestion prompts and MCP elicitations, across every session. It is kept
 * apart from React and from the per-session aggregator because the rules for when
 * an item must disappear are the part that is easy to get wrong and expensive to
 * get wrong (an approve button for something another client already answered).
 *
 * Sources of truth, in order of how much they are trusted:
 *
 *  1. Live events. `agent.tool_approval`, `agent.ask_user`, `agent.elicitation` add;
 *     `agent.tool_approval_resolved`, `agent.question_state`,
 *     `agent.question_dismissed`, `agent.elicitation_result` remove, whichever
 *     client caused them.
 *  2. `session.snapshot`, sent by the gateway when a session is subscribed. It
 *     carries the one pending question / elicitation and one pending approval.
 *     It can add an approval but never remove one: a session can have several
 *     approvals in flight and the snapshot only holds the latest.
 *  3. `tool.pending`, which lists every approval the gateway still holds (no
 *     session key, though). It is the only thing that can say "that approval is
 *     gone" after the phone missed the event, so it runs on every reconnect and
 *     every foreground.
 */
import type {
  PendingApproval,
  PendingElicitation,
  PendingQuestion,
  SessionSnapshot,
} from '@dorabot-remote/protocol'

/** The gateway rejects an unanswered question after five minutes. */
export const QUESTION_TIMEOUT_MS = 300_000

/**
 * A question older than this when first seen is history, not a prompt. After a
 * reconnect the bridge replays missed events, including ones that expired while
 * the phone was asleep; those must not come back as zombie "timed out" rows.
 */
const STALE_QUESTION_MS = QUESTION_TIMEOUT_MS + 30_000

export type InboxKind = 'approval' | 'question' | 'elicitation'

export interface InboxItem {
  /** `${kind}:${requestId | elicitationId}` */
  id: string
  kind: InboxKind
  /** Null for an approval learned only from `tool.pending`. */
  sessionKey: string | null
  /** When the phone first learned of it (capped at "now" to tolerate clock skew). */
  at: number
  /** Questions only: the deadline passed, or the gateway said so. */
  timedOut: boolean
  approval?: PendingApproval
  question?: PendingQuestion
  elicitation?: PendingElicitation
}

export interface InboxState {
  /** Newest first. */
  items: InboxItem[]
}

export const emptyInbox: InboxState = { items: [] }

export type InboxAction =
  | { type: 'event'; event: string; data: unknown; now: number }
  | { type: 'reconcile'; pending: Array<{ requestId: string; toolName?: string; input?: Record<string, unknown> }>; startedAt: number; now: number }
  | { type: 'tick'; now: number }
  | { type: 'remove'; id: string }
  | { type: 'clear' }

export const approvalId = (requestId: string): string => `approval:${requestId}`
export const questionId = (requestId: string): string => `question:${requestId}`
export const elicitationId = (id: string): string => `elicitation:${id}`

/** Milliseconds left before the gateway gives up on a question. */
export function questionRemaining(item: InboxItem, now: number): number {
  return Math.max(0, QUESTION_TIMEOUT_MS - (now - item.at))
}

export function isTimedOut(item: InboxItem, now: number): boolean {
  return item.kind === 'question' && (item.timedOut || questionRemaining(item, now) === 0)
}

function sortNewestFirst(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => b.at - a.at)
}

function upsert(state: InboxState, item: InboxItem): InboxState {
  const existing = state.items.find((i) => i.id === item.id)
  if (!existing) return { items: sortNewestFirst([...state.items, item]) }
  // Keep what we already knew (the earlier arrival time, a session key learned
  // from a snapshot) and take whatever the new copy adds.
  const merged: InboxItem = {
    ...existing,
    ...item,
    at: Math.min(existing.at, item.at),
    sessionKey: item.sessionKey ?? existing.sessionKey,
    timedOut: existing.timedOut || item.timedOut,
  }
  return { items: sortNewestFirst(state.items.map((i) => (i.id === item.id ? merged : i))) }
}

function remove(state: InboxState, pred: (i: InboxItem) => boolean): InboxState {
  const items = state.items.filter((i) => !pred(i))
  return items.length === state.items.length ? state : { items }
}

function markTimedOut(state: InboxState, id: string): InboxState {
  let changed = false
  const items = state.items.map((i) => {
    if (i.id !== id || i.timedOut) return i
    changed = true
    return { ...i, timedOut: true }
  })
  return changed ? { items } : state
}

const clampAt = (ts: unknown, now: number): number => (typeof ts === 'number' && ts > 0 ? Math.min(ts, now) : now)

function approvalItem(a: PendingApproval, now: number, sessionKey?: string | null): InboxItem {
  return {
    id: approvalId(a.requestId),
    kind: 'approval',
    sessionKey: a.sessionKey ?? sessionKey ?? null,
    at: clampAt(a.timestamp, now),
    timedOut: false,
    approval: a,
  }
}

function questionItem(q: PendingQuestion, sessionKey: string | null, now: number): InboxItem | null {
  const at = clampAt(q.timestamp, now)
  if (now - at > STALE_QUESTION_MS) return null
  return {
    id: questionId(q.requestId),
    kind: 'question',
    sessionKey: q.sessionKey ?? sessionKey,
    at,
    timedOut: now - at >= QUESTION_TIMEOUT_MS,
    question: q,
  }
}

function elicitationItem(e: PendingElicitation, now: number): InboxItem {
  return {
    id: elicitationId(e.elicitationId),
    kind: 'elicitation',
    sessionKey: e.sessionKey ?? null,
    at: clampAt(e.timestamp, now),
    timedOut: false,
    elicitation: e,
  }
}

function applyEvent(state: InboxState, event: string, data: unknown, now: number): InboxState {
  const d = (data ?? {}) as Record<string, unknown>

  switch (event) {
    case 'agent.tool_approval': {
      const a = d as unknown as PendingApproval
      if (!a.requestId) return state
      return upsert(state, approvalItem(a, now))
    }

    case 'agent.tool_approval_resolved':
      return remove(state, (i) => i.id === approvalId(String(d.requestId)))

    case 'agent.ask_user': {
      const q = d as unknown as PendingQuestion
      if (!q.requestId) return state
      const item = questionItem(q, (d.sessionKey as string) ?? null, now)
      return item ? upsert(state, item) : state
    }

    case 'agent.question_state': {
      const id = questionId(String(d.requestId))
      const status = d.status as string
      if (status === 'pending') return state
      // A timeout stays on screen, clearly labelled, until the user dismisses it:
      // it means a turn just failed and that is worth a person noticing. Anything
      // else (answered, cancelled) means it is resolved and goes away.
      if (status === 'timeout') return markTimedOut(state, id)
      return remove(state, (i) => i.id === id)
    }

    case 'agent.question_dismissed': {
      const id = questionId(String(d.requestId))
      if (d.reason === 'timeout') return markTimedOut(state, id)
      return remove(state, (i) => i.id === id)
    }

    case 'agent.elicitation': {
      const e = d as unknown as PendingElicitation
      if (!e.elicitationId) return state
      return upsert(state, elicitationItem(e, now))
    }

    case 'agent.elicitation_result':
      return remove(state, (i) => i.id === elicitationId(String(d.elicitationId)))

    case 'agent.conversation_reset': {
      // The run those prompts belonged to no longer exists.
      const sk = d.sessionKey as string | undefined
      return sk ? remove(state, (i) => i.sessionKey === sk && i.kind !== 'approval') : state
    }

    case 'session.snapshot': {
      const snap = data as SessionSnapshot
      if (!snap?.sessionKey) return state
      let next = state

      if (snap.pendingApproval) next = upsert(next, approvalItem(snap.pendingApproval, now, snap.sessionKey))

      // A session holds at most one question and one elicitation in its snapshot,
      // and the gateway nulls them the moment they resolve, so absence means gone.
      const keepQuestion = snap.pendingQuestion ? questionId(snap.pendingQuestion.requestId) : null
      const keepElicitation = snap.pendingElicitation ? elicitationId(snap.pendingElicitation.elicitationId) : null
      next = remove(
        next,
        (i) =>
          i.sessionKey === snap.sessionKey &&
          ((i.kind === 'question' && i.id !== keepQuestion && !i.timedOut) ||
            (i.kind === 'elicitation' && i.id !== keepElicitation)),
      )

      if (snap.pendingQuestion) {
        const item = questionItem({ ...snap.pendingQuestion, sessionKey: snap.sessionKey }, snap.sessionKey, now)
        if (item) next = upsert(next, item)
      }
      if (snap.pendingElicitation) next = upsert(next, elicitationItem(snap.pendingElicitation, now))
      return next
    }

    default:
      return state
  }
}

export function inboxReducer(state: InboxState, action: InboxAction): InboxState {
  switch (action.type) {
    case 'event':
      return applyEvent(state, action.event, action.data, action.now)

    case 'reconcile': {
      const live = new Set(action.pending.map((p) => approvalId(p.requestId)))
      // Drop approvals the gateway no longer holds. Anything that arrived after
      // the request was sent is spared: it can legitimately be missing from a
      // list that was computed before it existed.
      let next = remove(state, (i) => i.kind === 'approval' && !live.has(i.id) && i.at < action.startedAt)
      for (const p of action.pending) {
        if (next.items.some((i) => i.id === approvalId(p.requestId))) continue
        next = upsert(
          next,
          approvalItem({ requestId: p.requestId, toolName: p.toolName ?? 'tool', input: p.input ?? {}, timestamp: action.now }, action.now),
        )
      }
      return next
    }

    case 'tick': {
      let changed = false
      const items = state.items.map((i) => {
        if (i.kind !== 'question' || i.timedOut || questionRemaining(i, action.now) > 0) return i
        changed = true
        return { ...i, timedOut: true }
      })
      return changed ? { items } : state
    }

    case 'remove':
      return remove(state, (i) => i.id === action.id)

    case 'clear':
      return state.items.length ? emptyInbox : state
  }
}

/** Items a person can still act on (approve, answer), as opposed to expired ones. */
export function actionable(state: InboxState): InboxItem[] {
  return state.items.filter((i) => !(i.kind === 'question' && i.timedOut))
}
