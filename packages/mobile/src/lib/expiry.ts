/** Time-limited permissions, phone side. Expiry timestamps are the Mac's epoch ms. */
import type { Scope } from '@dorabot-remote/protocol'

/** "45m", "2h 5m", "3d". Rounds up so "0m" never shows for something still running. */
export function formatLeft(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60_000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 48) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** Scopes that had a time limit, due by now (give or take a minute of clock drift), and are gone from the new list. */
export function lapsedScopes(prev: Record<string, number> | undefined, nextScopes: readonly Scope[], now: number, slackMs = 60_000): Scope[] {
  return Object.entries(prev ?? {})
    .filter(([scope, at]) => !nextScopes.includes(scope as Scope) && at <= now + slackMs)
    .map(([scope]) => scope as Scope)
}

/** The folder (or scope) that ends first, among those still running. */
export function soonest(map: Record<string, number> | undefined, now: number): { key: string; at: number } | null {
  let best: { key: string; at: number } | null = null
  for (const [key, at] of Object.entries(map ?? {})) {
    if (at > now && (!best || at < best.at)) best = { key, at }
  }
  return best
}
