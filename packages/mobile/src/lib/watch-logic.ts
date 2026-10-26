/**
 * Apple Watch approvals, the pure part: shaping the Inbox into the short list the watch shows and
 * deciding what to do with an approve / deny request that comes back from the watch.
 *
 * The watch is a thin remote. It holds no pairing keys and never talks to the Mac or the relay: the
 * phone sends it this snapshot over WatchConnectivity and executes whatever it asks, through the same
 * `tool.approve` / `tool.deny` path as a tap on the phone. The phone re-checks everything when a request
 * arrives (the watch's word that something is routine is never trusted), and a risky approval is never
 * actionable from the wrist: it needs Face ID on the phone.
 */
import type { StoredSession } from '@dorabot-remote/protocol'
import { authLevelFor } from './approval-auth.js'
import { actionable, type InboxItem } from './inbox.js'
import { sessionLabel } from './sessionName.js'

export type WatchItemKind = 'approval' | 'question'

export interface WatchItem {
  rid: string
  kind: WatchItemKind
  hostName: string
  sessionName: string
  title: string
  summary: string
  /** Approvals only: needs Face ID, so the watch shows "Open on iPhone to approve". */
  risky: boolean
}

export interface WatchSnapshot {
  items: WatchItem[]
  /** Epoch ms the snapshot was built. */
  at: number
}

/** A watch screen is tiny, and the transfer is size limited: keep a handful of short strings. */
export const WATCH_MAX_ITEMS = 8
const TITLE_MAX = 60
const SUMMARY_MAX = 140

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** The most telling field of a tool call, for a line on the wrist. */
export function summarizeInput(input: Record<string, unknown> | undefined | null): string {
  if (!input || typeof input !== 'object') return ''
  for (const k of ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt']) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

export function isRiskyApproval(item: InboxItem): boolean {
  const a = item.approval
  if (!a) return true
  return authLevelFor(a.toolName, a.input, a.blockedPath ? { blockedPath: a.blockedPath } : {}) === 'fresh'
}

/** Which request id a watch row acts on (the id the gateway knows it by). */
export function ridOf(item: InboxItem): string | null {
  return item.approval?.requestId ?? item.question?.requestId ?? item.elicitation?.elicitationId ?? null
}

/**
 * `locked`: the iPhone app lock is on and currently locked. The wrist then shows tool names only, no command,
 * path or question text, so nothing sensitive is readable on a watch while the phone itself is locked.
 */
export function buildWatchSnapshot(items: InboxItem[], hostName: string, sessions: StoredSession[], now: number, locked = false): WatchSnapshot {
  const out: WatchItem[] = []
  // Newest first, as the Inbox is; expired questions are history, not something to answer.
  for (const item of actionable({ items })) {
    const rid = ridOf(item)
    if (!rid) continue
    const sessionName = clip(sessionLabel(sessions, item.sessionKey), 40)
    if (item.kind === 'approval' && item.approval) {
      const a = item.approval
      out.push({
        rid,
        kind: 'approval',
        hostName: clip(hostName, 40),
        sessionName,
        title: clip(locked ? a.toolName : a.title || a.toolName, TITLE_MAX),
        summary: locked ? '' : clip(summarizeInput(a.input), SUMMARY_MAX),
        risky: isRiskyApproval(item),
      })
    } else {
      const text =
        item.question?.questions?.[0]?.question ??
        item.elicitation?.message ??
        'A question is waiting'
      out.push({ rid, kind: 'question', hostName: clip(hostName, 40), sessionName, title: 'Question', summary: locked ? '' : clip(text, SUMMARY_MAX), risky: false })
    }
    if (out.length >= WATCH_MAX_ITEMS) break
  }
  return { items: out, at: now }
}

export type WatchAction = 'approve' | 'deny' | 'refresh'

export interface WatchRequest {
  action: WatchAction
  rid?: string
}

export interface WatchReply {
  ok: boolean
  message: string
}

export interface WatchDeps {
  /** Linked to the Mac and the gateway is up: only then can anything be done. */
  connected: boolean
  /** The iPhone app lock is on and locked: the watch may not execute anything. */
  locked?: boolean
  items: InboxItem[]
  approve: (item: InboxItem) => Promise<void>
  deny: (item: InboxItem) => Promise<void>
}

export const NOT_CONNECTED = 'Phone not connected'
export const UNLOCK_PHONE = 'Unlock DoraBot on iPhone'
export const OPEN_ON_PHONE = 'Open on iPhone to approve'
export const DENY_REASON = 'Denied from Apple Watch'

/** Decide and carry out one request from the watch. Never throws: the watch always gets an answer. */
export async function handleWatchRequest(req: WatchRequest, deps: WatchDeps): Promise<WatchReply> {
  if (!deps.connected) return { ok: false, message: NOT_CONNECTED }
  if (req.action === 'refresh') return { ok: true, message: 'Updated' }
  if (req.action !== 'approve' && req.action !== 'deny') return { ok: false, message: 'Unsupported' }
  if (deps.locked) return { ok: false, message: UNLOCK_PHONE }
  if (typeof req.rid !== 'string' || !req.rid) return { ok: false, message: 'Unsupported' }

  const item = deps.items.find((i) => ridOf(i) === req.rid)
  if (!item) return { ok: false, message: 'Already handled' }
  if (item.kind === 'question' || item.kind === 'elicitation') return { ok: false, message: 'Answer on iPhone' }
  // Re-derived here, from the live item: risky means Face ID on the phone, for approve and deny alike.
  if (isRiskyApproval(item)) return { ok: false, message: OPEN_ON_PHONE }

  try {
    if (req.action === 'approve') await deps.approve(item)
    else await deps.deny(item)
    return { ok: true, message: req.action === 'approve' ? 'Approved' : 'Denied' }
  } catch (err) {
    return { ok: false, message: `Could not ${req.action}: ${(err as Error).message || 'unknown error'}`.slice(0, 120) }
  }
}
