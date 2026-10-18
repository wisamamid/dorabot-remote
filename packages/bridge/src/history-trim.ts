/**
 * The gateway returns a session's whole history from sessions.get ({ sessionId,
 * messages }) and chat.history (a bare array), ignoring any limit. A multi-MB
 * result cannot cross the relay, so trim to the newest messages that fit.
 */
export const HISTORY_BUDGET_BYTES = 700 * 1024
/** Cap applied on transports with no frame limit (LAN). */
export const HISTORY_LAN_CAP_BYTES = 4 * 1024 * 1024
const MAX_STRING_BYTES = 50 * 1024

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

function trimMessages(messages: unknown[]): unknown[] {
  const kept: unknown[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = clipStrings(messages[i])
    const s = size(m) + 1
    if (used + s > HISTORY_BUDGET_BYTES && kept.length > 0) break
    used += s
    kept.push(m)
  }
  return kept.reverse()
}

/** Returns the result unchanged when it is small enough for the transport. */
export function trimHistoryResult(method: string, result: unknown, frameLimit: number | undefined): unknown {
  if (method !== 'sessions.get' && method !== 'chat.history') return result
  const limit = frameLimit !== undefined ? frameLimit - 4096 : HISTORY_LAN_CAP_BYTES
  if (size(result) <= limit) return result

  if (Array.isArray(result)) return trimMessages(result)
  const r = result as { messages?: unknown }
  if (r && Array.isArray(r.messages)) {
    const kept = trimMessages(r.messages)
    return { ...r, messages: kept, truncated: true, totalMessages: r.messages.length, returnedMessages: kept.length }
  }
  return result
}
