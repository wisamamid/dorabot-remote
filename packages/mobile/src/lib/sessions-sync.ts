import type { StoredSession } from '@dorabot-remote/protocol'

/** Newest first, the order the Sessions list wants. */
export function sortSessions(list: StoredSession[]): StoredSession[] {
  return [...list].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
}

/**
 * Apply a gateway session-list event to the phone's list.
 *
 * `session.update` (a session was created or its counters moved) carries a full
 * row keyed by `id`; `sessions.update` (a rename or model change from the desktop)
 * carries `{ sessionId, name?, model? }`. Returns the same array when nothing
 * changed, or null when the event is not about the session list.
 */
export function applySessionEvent(list: StoredSession[], event: string, data: unknown): StoredSession[] | null {
  const d = (data ?? {}) as Record<string, unknown>
  if (event === 'session.update') {
    const id = d.id
    if (typeof id !== 'string' || !id) return list
    const patch = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) as unknown as StoredSession
    const idx = list.findIndex((s) => s.id === id)
    if (idx < 0) {
      return sortSessions([{ ...patch, createdAt: patch.createdAt ?? patch.updatedAt ?? '' }, ...list])
    }
    const next = [...list]
    next[idx] = { ...list[idx], ...patch }
    return sortSessions(next)
  }
  if (event === 'sessions.update') {
    const id = d.sessionId
    if (typeof id !== 'string' || !id) return list
    const idx = list.findIndex((s) => s.id === id)
    if (idx < 0) return list
    const cur = list[idx]
    const name = typeof d.name === 'string' ? d.name : cur.name
    const model = 'model' in d ? ((d.model as string | undefined) ?? undefined) : cur.model
    if (name === cur.name && model === cur.model) return list
    const next = [...list]
    next[idx] = { ...cur, name, model }
    return next
  }
  return null
}
