import type { StoredSession } from '@dorabot-remote/protocol'

export const MAX_NAME = 80

/** Trim and clamp a typed name; null when nothing usable is left. */
export function normalizeName(raw: string): string | null {
  const name = raw.trim().slice(0, MAX_NAME).trim()
  return name ? name : null
}

type Rpc = <T = unknown>(method: string, params?: unknown) => Promise<T>

/**
 * Rename a session: apply the new name locally at once, ask the gateway, and put
 * the old name back if it refuses. `sessions.rename` takes the stored session id
 * (`desktop-dm-<uuid>-<ts>`), not the `channel:type:chatId` session key.
 */
export async function renameSession(
  deps: {
    rpc: Rpc
    setSessions: (update: (prev: StoredSession[]) => StoredSession[]) => void
  },
  sessionId: string,
  rawName: string,
): Promise<void> {
  const name = normalizeName(rawName)
  if (!name) throw new Error('Name cannot be empty')
  let previous: string | undefined
  let found = false
  const set = (value: string | undefined): void =>
    deps.setSessions((list) => list.map((s) => (s.id === sessionId ? { ...s, name: value } : s)))
  deps.setSessions((list) => {
    const cur = list.find((s) => s.id === sessionId)
    if (cur) {
      found = true
      previous = cur.name
    }
    return list
  })
  set(name)
  try {
    await deps.rpc('sessions.rename', { sessionId, name })
  } catch (err) {
    if (found) set(previous)
    throw err
  }
}
