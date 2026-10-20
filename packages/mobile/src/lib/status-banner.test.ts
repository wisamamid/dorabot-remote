import { describe, expect, it } from 'vitest'
import { bannerFor } from './status-banner.js'

const base = { online: true, transport: null, justReconnected: false } as const

describe('bannerFor', () => {
  it('is silent when ready', () => {
    expect(bannerFor({ ...base, state: 'ready' })).toBeNull()
  })
  it('says reconnecting while the link is down but the network is up', () => {
    expect(bannerFor({ ...base, state: 'connecting' })?.text).toBe('Reconnecting…')
    expect(bannerFor({ ...base, state: 'disconnected' })?.text).toBe('Reconnecting…')
  })
  it('says offline with saved data when the network is gone', () => {
    expect(bannerFor({ ...base, online: false, state: 'disconnected' })?.text).toBe('Offline - showing saved data')
  })
  it('announces a relay reconnect briefly', () => {
    expect(bannerFor({ ...base, state: 'ready', transport: 'relay', justReconnected: true })?.text).toBe('Connected via relay')
    expect(bannerFor({ ...base, state: 'ready', transport: 'lan', justReconnected: true })).toBeNull()
  })
  it('leaves pending to its own UI', () => {
    expect(bannerFor({ ...base, state: 'pending' })).toBeNull()
  })
})
