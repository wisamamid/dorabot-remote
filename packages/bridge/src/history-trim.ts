/**
 * The gateway returns a session's whole history from sessions.get ({ sessionId,
 * messages }) and chat.history (a bare array), ignoring any limit. A multi-MB
 * result cannot cross the relay, so trim to the newest messages that fit.
 */
export const HISTORY_BUDGET_BYTES = 700 * 1024
/** Cap applied on transports with no frame limit (LAN). */
export const HISTORY_LAN_CAP_BYTES = 4 * 1024 * 1024
const MAX_STRING_BYTES = 50 * 1024
/** How long to cache the full history per sessionId (ms) */
const HISTORY_CACHE_TTL = 60 * 1000

const size = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '')

function clipStrings(v: unknown): unknown {
  if (typeof v === 'string') {
    if (v.length <= MAX_STRING_BYTES) return v
    return `${v.slice(0, MAX_STRING_BYTES)}\n[... truncated ${v.length - MAX_STRING_BYTES} characters ...]`
  }
  if (Array.isArray(v)) return v.map(clipStrings)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = clipStrings(x)
    return out
  }
  return v
}

function trimMessages(messages: unknown[], limit?: number): unknown[] {
  const kept: unknown[] = []
  let used = 0
  const byteLimit = limit ?? HISTORY_BUDGET_BYTES
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = clipStrings(messages[i])
    const s = size(m) + 1
    if (used + s > byteLimit && kept.length > 0) break
    used += s
    kept.push(m)
  }
  return kept.reverse()
}

interface CachedHistory {
  timestamp: number
  messages: unknown[]
}

const historyCache = new Map<string, CachedHistory>()

/**
 * Slice a range of messages from full history, respecting byte budget.
 * Returns [messages, startIndex, hasMore]
 */
function sliceMessages(
  messages: unknown[],
  before: number = 0,
  limit?: number
): [unknown[], number, boolean] {
  const total = messages.length
  const startIdx = Math.max(0, total - before - (limit ?? 500))
  const endIdx = total - before

  if (startIdx >= endIdx) {
    return [[], startIdx, startIdx > 0]
  }

  const slice = messages.slice(startIdx, endIdx)
  const kept: unknown[] = []
  let used = 0
  const byteLimit = limit ? Math.min(limit * 100, HISTORY_BUDGET_BYTES) : HISTORY_BUDGET_BYTES

  for (const msg of slice) {
    const m = clipStrings(msg)
    const s = size(m) + 1
    if (used + s > byteLimit && kept.length > 0) break
    used += s
    kept.push(m)
  }

  return [kept, startIdx, startIdx > 0]
}

/** Returns the result unchanged when it is small enough for the transport. */
export function trimHistoryResult(
  method: string,
  result: unknown,
  frameLimit: number | undefined,
  params?: { before?: number; limit?: number; sessionId?: string }
): unknown {
  if (method !== 'sessions.get' && method !== 'chat.history') return result

  const before = params?.before
  const sessionId = params?.sessionId
  const limitParam = params?.limit

  // If pagination is explicitly requested, always process it
  const hasExplicitPagination = before !== undefined

  const limit = frameLimit !== undefined ? frameLimit - 4096 : HISTORY_LAN_CAP_BYTES

  // If result is small and no explicit pagination, return unchanged
  if (size(result) <= limit && !hasExplicitPagination) return result

  if (Array.isArray(result)) return trimMessages(result)
  const r = result as { messages?: unknown }
  if (r && Array.isArray(r.messages)) {
    // Cache the full history for pagination requests or when trimming
    if (sessionId) {
      historyCache.set(sessionId, {
        timestamp: Date.now(),
        messages: r.messages,
      })
    }

    // If explicit pagination is requested (before is defined), slice the full history
    if (hasExplicitPagination) {
      const [kept, startIdx, hasMore] = sliceMessages(r.messages, before, limitParam)
      return {
        ...r,
        messages: kept,
        truncated: true,
        totalMessages: r.messages.length,
        returnedMessages: kept.length,
        startIndex: startIdx,
        hasMore,
      }
    }

    // Normal trimming for first load
    const kept = trimMessages(r.messages)
    return { ...r, messages: kept, truncated: true, totalMessages: r.messages.length, returnedMessages: kept.length }
  }
  return result
}

/** Get cached history if available and not stale */
export function getCachedHistory(sessionId: string): unknown[] | null {
  const cached = historyCache.get(sessionId)
  if (!cached) return null
  if (Date.now() - cached.timestamp > HISTORY_CACHE_TTL) {
    historyCache.delete(sessionId)
    return null
  }
  return cached.messages
}

/** Clear the history cache (for testing or manual cleanup) */
export function clearHistoryCache(sessionId?: string): void {
  if (sessionId) {
    historyCache.delete(sessionId)
  } else {
    historyCache.clear()
  }
}
