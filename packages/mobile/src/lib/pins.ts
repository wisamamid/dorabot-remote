import type { StoredSession } from '@dorabot-remote/protocol'

/** A pinned session, as the bridge stores it. `id` is the session key (`channel:chatType:chatId`). */
export interface Pin {
  id: string
  pinnedAt: number
}

type Rpc = <T = unknown>(method: string, params?: unknown) => Promise<T>

/** Newest pin first, ties broken by id so the order is stable. Drops junk entries. */
export function normalizePins(raw: unknown): Pin[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Pin[] = []
  for (const p of raw as Array<Partial<Pin> | null>) {
    if (!p || typeof p.id !== 'string' || seen.has(p.id)) continue
    seen.add(p.id)
    out.push({ id: p.id, pinnedAt: typeof p.pinnedAt === 'number' ? p.pinnedAt : 0 })
  }
  return out.sort((a, b) => b.pinnedAt - a.pinnedAt || a.id.localeCompare(b.id))
}

/** Add or remove one pin locally. Re-pinning keeps the existing timestamp. */
export function withPin(pins: Pin[], id: string, pinned: boolean, now = Date.now()): Pin[] {
  const has = pins.some((p) => p.id === id)
  if (pinned === has) return pins
  return pinned ? normalizePins([...pins, { id, pinnedAt: now }]) : pins.filter((p) => p.id !== id)
}

/**
 * Pin or unpin: apply it locally at once, ask the bridge, and put only this one
 * session's state back if the bridge refuses (so a concurrent change to another
 * pin is not clobbered by the rollback).
 */
export async function setPinned(
  deps: { rpc: Rpc; setPins: (update: (prev: Pin[]) => Pin[]) => void },
  id: string,
  pinned: boolean,
): Promise<void> {
  let before: Pin | undefined
  deps.setPins((prev) => {
    before = prev.find((p) => p.id === id)
    return withPin(prev, id, pinned)
  })
  try {
    const res = await deps.rpc<{ pins?: unknown }>('remote.pins.set', { id, pinned })
    if (res && Array.isArray(res.pins)) deps.setPins(() => normalizePins(res.pins))
  } catch (err) {
    deps.setPins((prev) => {
      const without = prev.filter((p) => p.id !== id)
      return before ? normalizePins([...without, before]) : without
    })
    throw err
  }
}

export interface SessionRow {
  session: StoredSession
  key: string
}

/**
 * Split rows into the Pinned section (newest pin first) and everything else.
 * Pins whose session is not in the list are ignored here: the list may be mid
 * load, and the bridge prunes the dead ones.
 */
export function partitionPinned(
  rows: SessionRow[],
  pins: Pin[],
): { pinned: SessionRow[]; rest: SessionRow[] } {
  const order = new Map(pins.map((p, i) => [p.id, i]))
  const pinned = rows.filter((r) => order.has(r.key)).sort((a, b) => order.get(a.key)! - order.get(b.key)!)
  const rest = rows.filter((r) => !order.has(r.key))
  return { pinned, rest }
}
