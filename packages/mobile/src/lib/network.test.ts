import { describe, expect, it } from 'vitest'
import { shouldReconnect } from './network.js'

const n = (connected: boolean, connectionType: string) => ({ connected, connectionType })

describe('shouldReconnect', () => {
  it('reconnects when wifi turns into cellular', () => {
    expect(shouldReconnect(n(true, 'wifi'), n(true, 'cellular'))).toBe(true)
  })
  it('reconnects when the network comes back', () => {
    expect(shouldReconnect(n(false, 'none'), n(true, 'cellular'))).toBe(true)
  })
  it('does nothing when offline or unchanged or first report', () => {
    expect(shouldReconnect(n(true, 'wifi'), n(false, 'none'))).toBe(false)
    expect(shouldReconnect(n(true, 'wifi'), n(true, 'wifi'))).toBe(false)
    expect(shouldReconnect(null, n(true, 'wifi'))).toBe(false)
  })
})
