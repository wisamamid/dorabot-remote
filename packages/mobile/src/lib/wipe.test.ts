import { describe, expect, it } from 'vitest'
import { LEGACY_PAIRING_KEY, PAIRINGS_KEY, cursorKey } from './hosts.js'
import { LOCK_FAILS_KEY, MAX_LOCK_FAILS, WIPE_NOTICE_KEY, afterAttempt, attemptsLeft, parseFails, selfWipe } from './wipe.js'

describe('afterAttempt', () => {
  it('wipes on the 5th consecutive failure, not before', () => {
    let fails = 0
    for (let i = 1; i < MAX_LOCK_FAILS; i++) {
      const n = afterAttempt(fails, 'failed')
      expect(n.wipe).toBe(false)
      fails = n.fails
    }
    expect(fails).toBe(4)
    expect(afterAttempt(fails, 'failed')).toEqual({ fails: 5, wipe: true })
  })
  it('a success resets the streak', () => {
    expect(afterAttempt(4, 'ok')).toEqual({ fails: 0, wipe: false })
  })
  it('cancel and unavailable neither count nor reset', () => {
    expect(afterAttempt(3, 'cancelled')).toEqual({ fails: 3, wipe: false })
    expect(afterAttempt(3, 'unavailable')).toEqual({ fails: 3, wipe: false })
  })
  it('counts down the attempts left', () => {
    expect(attemptsLeft(0)).toBe(5)
    expect(attemptsLeft(4)).toBe(1)
    expect(attemptsLeft(9)).toBe(0)
  })
  it('parses a stored counter defensively', () => {
    expect(parseFails('3')).toBe(3)
    expect(parseFails(null)).toBe(0)
    expect(parseFails('-1')).toBe(0)
    expect(parseFails('abc')).toBe(0)
  })
})

function fakeIo(initial: Record<string, string>, failing: string[] = []) {
  const m = new Map(Object.entries(initial))
  const calls: string[] = []
  return {
    m,
    calls,
    io: {
      get: async (k: string) => m.get(k) ?? null,
      set: async (k: string, v: string) => {
        calls.push(`set ${k}`)
        m.set(k, v)
      },
      remove: async (k: string) => {
        calls.push(`remove ${k}`)
        if (failing.includes(k)) throw new Error('boom')
        m.delete(k)
      },
      clearAll: async () => {
        calls.push('clearAll')
        m.clear()
      },
    },
  }
}

const pairings = JSON.stringify({
  v: 2,
  activeHostId: 'h1',
  pairings: [
    { deviceId: 'd1', hostId: 'h1', hostName: 'Mac', hostPublicKey: 'pk', addresses: ['1.2.3.4:7788'], identity: { publicKey: 'a', privateKey: 'SECRET' }, scopes: [], pairedAt: 1, addedAt: 1 },
  ],
})

describe('selfWipe', () => {
  it('deletes pairings, cursors, push keys and everything else, leaving only the notice', async () => {
    const f = fakeIo({ [PAIRINGS_KEY]: pairings, [cursorKey('h1')]: '9', [LEGACY_PAIRING_KEY]: 'x', [LOCK_FAILS_KEY]: '5', other: 'cache' })
    let pushCleared = false
    let notified = false
    const out = await selfWipe({ io: f.io, clearAllPushKeys: async () => void (pushCleared = true), clearNotifications: async () => void (notified = true) })
    expect(out).toEqual({ ok: true, errors: [] })
    expect(pushCleared).toBe(true)
    expect(notified).toBe(true)
    expect([...f.m.keys()]).toEqual([WIPE_NOTICE_KEY])
    expect(f.calls).toContain(`remove ${cursorKey('h1')}`)
  })

  it('keeps going when a step fails, and reports it', async () => {
    const f = fakeIo({ [PAIRINGS_KEY]: pairings }, [PAIRINGS_KEY])
    let pushCleared = false
    const out = await selfWipe({ io: f.io, clearAllPushKeys: async () => void (pushCleared = true) })
    expect(out.ok).toBe(false)
    expect(out.errors[0]).toContain('pairings')
    expect(pushCleared).toBe(true)
    // the blanket clear still removed the pairings
    expect(f.m.has(PAIRINGS_KEY)).toBe(false)
    expect(f.m.get(WIPE_NOTICE_KEY)).toBe('1')
  })

  it('survives unreadable pairings', async () => {
    const f = fakeIo({ [PAIRINGS_KEY]: '{not json' })
    const out = await selfWipe({ io: f.io, clearAllPushKeys: async () => {} })
    expect(out.ok).toBe(true)
    expect([...f.m.keys()]).toEqual([WIPE_NOTICE_KEY])
  })
})
