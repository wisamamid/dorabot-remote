import { describe, expect, it } from 'vitest'
import { PULL_THRESHOLD, pullResistance } from './PullToRefresh.js'

describe('pullResistance', () => {
  it('is zero for upward or no drag', () => {
    expect(pullResistance(-20)).toBe(0)
    expect(pullResistance(0)).toBe(0)
  })
  it('resists and is capped', () => {
    expect(pullResistance(50)).toBeLessThan(50)
    expect(pullResistance(1000)).toBeLessThanOrEqual(110)
  })
  it('a deliberate pull crosses the threshold', () => {
    expect(pullResistance(120)).toBeGreaterThanOrEqual(PULL_THRESHOLD)
    expect(pullResistance(40)).toBeLessThan(PULL_THRESHOLD)
  })
})
