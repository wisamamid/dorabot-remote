import { describe, expect, it } from 'vitest'
import { DENY_REASON, routePushAction, runDecision, staleDelivered } from './push-actions.js'
import { recentlyAuthed } from './biometric.js'
import { shouldLock } from './app-lock.js'

describe('routePushAction', () => {
  it('approve / deny buttons on an approval become decisions', () => {
    expect(routePushAction({ rid: 'r1', kind: 'approval', actionId: 'APPROVE', sessionKey: 's' })).toEqual({ type: 'decide', decision: 'approve', rid: 'r1', sessionKey: 's' })
    expect(routePushAction({ rid: 'r1', kind: 'approval', actionId: 'DENY' })).toEqual({ type: 'decide', decision: 'deny', rid: 'r1' })
  })
  it('carries the Mac (hostId from enc, or the kid) through to the route', () => {
    expect(routePushAction({ rid: 'r1', kind: 'approval', actionId: 'APPROVE', hostId: 'h2', kid: 'abcd1234' })).toEqual({ type: 'decide', decision: 'approve', rid: 'r1', hostId: 'h2', kid: 'abcd1234' })
    expect(routePushAction({ rid: 'r1', sessionKey: 's', hostId: 'h2' })).toEqual({ type: 'open', rid: 'r1', sessionKey: 's', hostId: 'h2' })
    expect(routePushAction({ kid: 'abcd1234' })).toEqual({ type: 'open', kid: 'abcd1234' })
  })
  it('taps, Answer, and buttons on other kinds only open', () => {
    expect(routePushAction({ rid: 'r1', kind: 'approval', actionId: 'tap', sessionKey: 's' })).toEqual({ type: 'open', rid: 'r1', sessionKey: 's' })
    expect(routePushAction({ rid: 'q1', kind: 'question', actionId: 'ANSWER' })).toEqual({ type: 'open', rid: 'q1' })
    expect(routePushAction({ rid: 'q1', kind: 'question', actionId: 'APPROVE' }).type).toBe('open')
    expect(routePushAction({ kind: 'approval', actionId: 'APPROVE' }).type).toBe('open')
    expect(routePushAction({})).toEqual({ type: 'open' })
  })
})

describe('runDecision', () => {
  const route = { type: 'decide', decision: 'approve', rid: 'r1' } as const
  const mk = (verdict: 'ok' | 'cancelled' | 'unavailable' | 'failed', pending: string[], fail?: Error) => {
    const calls: Array<[string, unknown]> = []
    return {
      calls,
      deps: {
        verify: async () => verdict,
        rpc: async (m: string, p?: Record<string, unknown>) => {
          calls.push([m, p])
          if (m === 'tool.pending') return pending.map((requestId) => ({ requestId }))
          if (fail) throw fail
          return {}
        },
      },
    }
  }

  it('approves a pending request after Face ID', async () => {
    const t = mk('ok', ['r1'])
    expect(await runDecision(route, t.deps)).toMatchObject({ status: 'done', decision: 'approve' })
    expect(t.calls).toEqual([['tool.pending', undefined], ['tool.approve', { requestId: 'r1' }]])
  })
  it('denies with the notification reason', async () => {
    const t = mk('ok', ['r1'])
    await runDecision({ ...route, decision: 'deny' }, t.deps)
    expect(t.calls[1]).toEqual(['tool.deny', { requestId: 'r1', reason: DENY_REASON }])
  })
  it('does nothing when Face ID is cancelled or fails', async () => {
    for (const v of ['cancelled', 'failed'] as const) {
      const t = mk(v, ['r1'])
      expect((await runDecision(route, t.deps)).status).toBe('cancelled')
      expect(t.calls).toEqual([])
    }
  })
  it('allows a phone with no biometrics or passcode (the OS already required it unlocked)', async () => {
    expect((await runDecision(route, mk('unavailable', ['r1']).deps)).status).toBe('done')
  })
  it('reports an already resolved request without calling approve', async () => {
    const t = mk('ok', ['other'])
    expect((await runDecision(route, t.deps)).status).toBe('already_resolved')
    expect(t.calls.map((c) => c[0])).toEqual(['tool.pending'])
    expect((await runDecision(route, mk('ok', ['r1'], new Error('No pending approval for r1')).deps)).status).toBe('already_resolved')
  })
  it('surfaces other failures', async () => {
    const out = await runDecision(route, mk('ok', ['r1'], new Error('boom')).deps)
    expect(out).toMatchObject({ status: 'failed' })
    expect(out.message).toContain('boom')
  })
})

describe('staleDelivered', () => {
  it('selects only approval/question notifications that are no longer pending', () => {
    const d = [
      { id: '1', data: { k: 'approval', rid: 'live' } },
      { id: '2', data: { k: 'approval', rid: 'gone' } },
      { id: '3', data: { k: 'question', rid: 'gone2' } },
      { id: '4', data: { k: 'result', rid: 'run-x' } },
      { id: '5', data: {} },
    ]
    expect(staleDelivered(d, new Set(['live'])).map((n) => n.id)).toEqual(['2', '3'])
  })
})

describe('app lock and auth windows', () => {
  it('locks only when enabled and away longer than the grace period', () => {
    expect(shouldLock(true, 1000, 1000 + 59_000)).toBe(false)
    expect(shouldLock(true, 1000, 1000 + 61_000)).toBe(true)
    expect(shouldLock(false, 1000, 1000 + 600_000)).toBe(false)
    expect(shouldLock(true, null, 5)).toBe(false)
  })
  it('a very recent success is reused', () => {
    expect(recentlyAuthed(10_000, 5_000)).toBe(true)
    expect(recentlyAuthed(30_000, 5_000)).toBe(false)
    expect(recentlyAuthed(10_000, 0)).toBe(false)
  })
})
