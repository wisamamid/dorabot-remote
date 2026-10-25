/** Parse a time limit like "1h", "8h", "24h", "90m", "2d" (also "1 hour"). Returns ms, or null if invalid. */
export const MIN_GRANT_MS = 60_000
export const MAX_GRANT_MS = 30 * 24 * 60 * 60 * 1000

const UNITS: Record<string, number> = { m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000, d: 86_400_000, day: 86_400_000, days: 86_400_000 }

export function parseDuration(input: unknown): number | null {
  if (typeof input !== 'string') return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(input)
  if (!m) return null
  const unit = UNITS[m[2]!.toLowerCase()]
  if (!unit) return null
  const ms = Math.round(Number(m[1]) * unit)
  return ms >= MIN_GRANT_MS && ms <= MAX_GRANT_MS ? ms : null
}

/** "52m left", "7h 59m left", "2d left". */
export function formatRemaining(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / 60_000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 48) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}
