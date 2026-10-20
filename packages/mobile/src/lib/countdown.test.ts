import { describe, it, expect } from 'vitest'
import { formatCountdown } from './countdown'

describe('formatCountdown', () => {
  it('formats milliseconds to m:ss format', () => {
    expect(formatCountdown(330_000)).toBe('5:30')
    expect(formatCountdown(45_000)).toBe('0:45')
    expect(formatCountdown(60_000)).toBe('1:00')
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(500)).toBe('0:00')
  })

  it('handles edge cases', () => {
    expect(formatCountdown(-1000)).toBe('0:00')
    expect(formatCountdown(1000)).toBe('0:01')
    expect(formatCountdown(3661_000)).toBe('61:01')
  })
})
