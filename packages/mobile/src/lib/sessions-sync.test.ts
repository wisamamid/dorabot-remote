import { describe, expect, it } from 'vitest'
import type { StoredSession } from '@dorabot-remote/protocol'
import { applySessionEvent } from './sessions-sync.js'

const row = (id: string, extra: Partial<StoredSession> = {}): StoredSession => ({
  id,
  messageCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  channel: 'desktop',
  chatType: 'dm',
  chatId: id,
  ...extra,
})

describe('applySessionEvent', () => {
  it('applies a desktop rename by sessionId', () => {
    const list = [row('a'), row('b')]
    const next = applySessionEvent(list, 'sessions.update', { sessionId: 'b', name: 'Renamed' })!
    expect(next.find((s) => s.id === 'b')?.name).toBe('Renamed')
    expect(next.find((s) => s.id === 'a')?.name).toBeUndefined()
  })

  it('returns the same array when a rename changes nothing', () => {
    const list = [row('a', { name: 'X' })]
    expect(applySessionEvent(list, 'sessions.update', { sessionId: 'a', name: 'X' })).toBe(list)
  })

  it('ignores a rename for an unknown session', () => {
    const list = [row('a')]
    expect(applySessionEvent(list, 'sessions.update', { sessionId: 'zz', name: 'X' })).toBe(list)
  })

  it('adds a new session from session.update and sorts newest first', () => {
    const list = [row('a')]
    const next = applySessionEvent(list, 'session.update', {
      id: 'n', channel: 'desktop', chatId: 'n', chatType: 'dm', messageCount: 1, activeRun: true, updatedAt: '2026-02-01T00:00:00Z',
    })!
    expect(next.map((s) => s.id)).toEqual(['n', 'a'])
    expect(next[0].activeRun).toBe(true)
  })

  it('merges into an existing row without losing its name', () => {
    const list = [row('a', { name: 'Keep' })]
    const next = applySessionEvent(list, 'session.update', { id: 'a', messageCount: 5, activeRun: false, senderName: undefined, updatedAt: '2026-03-01T00:00:00Z' })!
    expect(next[0]).toMatchObject({ name: 'Keep', messageCount: 5 })
  })

  it('returns null for unrelated events', () => {
    expect(applySessionEvent([], 'agent.result', {})).toBeNull()
  })
})
