import { describe, expect, it } from 'vitest'
import { formatLeft, lapsedScopes, soonest } from './expiry.js'

describe('formatLeft', () => {
  it('formats minutes, hours and days', () => {
    expect(formatLeft(30_000)).toBe('1m')
    expect(formatLeft(52 * 60_000)).toBe('52m')
    expect(formatLeft(60 * 60_000)).toBe('1h')
    expect(formatLeft(7 * 3_600_000 + 59 * 60_000)).toBe('7h 59m')
    expect(formatLeft(72 * 3_600_000)).toBe('3d')
  })
})

describe('lapsedScopes', () => {
  const now = 1_000_000
  it('reports a limited scope that is due and gone', () => {
    expect(lapsedScopes({ terminal: now - 5 }, ['sessions'], now)).toEqual(['terminal'])
  })
  it('ignores one that is still granted or not yet due', () => {
    expect(lapsedScopes({ terminal: now - 5 }, ['sessions', 'terminal'], now)).toEqual([])
    expect(lapsedScopes({ terminal: now + 3_600_000 }, ['sessions'], now)).toEqual([])
    expect(lapsedScopes(undefined, [], now)).toEqual([])
  })
})

describe('soonest', () => {
  it('picks the nearest running limit', () => {
    expect(soonest({ a: 500, b: 200, c: 50 }, 100)).toEqual({ key: 'b', at: 200 })
    expect(soonest({}, 100)).toBeNull()
  })
})
