import { describe, expect, it } from 'vitest'
import { DENY_REASON, buildPushNav, routePushAction, runDecision, staleDelivered } from './push-actions.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { b64ToBytes, bytesToB64, generatePushKey } from './push-crypto.js'
import { pushKeyId } from './push-keys.js'
import { recentlyAuthed } from './biometric.js'
import { APPLOCK_KEY, LOCK_GRACE_MS, shouldLock } from './app-lock.js'
import { SECRET_KEY } from './platform.js'

describe('routePushAction', () => {
  it('approve / deny buttons on an approval become decisions', () => {
    expect(routePushAction({ rid: 'r1', kind: 'approval', actionId: 'APPROVE', sessionKey: 's', hostId: 'h1' })).toEqual({ type: 'decide', decision: 'approve', rid: 'r1', sessionKey: 's', hostId: 'h1' })
    expect(routePushAction({ rid: 'r1', kind: 'approval', actionId: 'DENY', hostId: 'h1' })).toEqual({ type: 'decide', decision: 'deny', rid: 'r1', hostId: 'h1' })
    // No verified Mac: never a decision.
    expect(routePushAction({ rid: 'r1', kind: 'approval', actionId: 'DENY' }).type).toBe('open')
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
          if (m === 'tool.pending') return pending.map((requestId) => ({ requestId, toolName: 'Bash', input: { command: requestId.startsWith('risky') ? 'git push --force' : 'ls' } }))
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
  describe('tiered approvals (risky approve needs its own fresh Face ID)', () => {
    const risky = { type: 'decide', decision: 'approve', rid: 'risky1' } as const
    const withFresh = (verdict: 'ok' | 'cancelled' | 'unavailable' | 'failed', fresh: 'ok' | 'cancelled' | 'unavailable' | 'failed' | null, native = true) => {
      const t = mk(verdict, ['risky1', 'r1'])
      const freshCalls: number[] = []
      return { ...t, freshCalls, deps: { ...t.deps, native, ...(fresh ? { verifyFresh: async () => (freshCalls.push(1), fresh) } : {}) } }
    }
    it('prompts again even though the first verify succeeded, then approves', async () => {
      const t = withFresh('ok', 'ok')
      expect((await runDecision(risky, t.deps)).status).toBe('done')
      expect(t.freshCalls).toHaveLength(1)
      expect(t.calls.map((c) => c[0])).toEqual(['tool.pending', 'tool.approve'])
    })
    it('does not approve when the fresh prompt is cancelled, fails or is unavailable', async () => {
      for (const f of ['cancelled', 'failed', 'unavailable'] as const) {
        const t = withFresh('ok', f)
        expect((await runDecision(risky, t.deps)).status).toBe('cancelled')
        expect(t.calls.map((c) => c[0])).toEqual(['tool.pending'])
      }
    })
    it('fails closed with no fresh verifier, and allows unavailable only without a native prompt', async () => {
      expect((await runDecision(risky, withFresh('ok', null).deps)).status).toBe('cancelled')
      expect((await runDecision(risky, withFresh('ok', 'unavailable', false).deps)).status).toBe('done')
    })
    it('a routine approve and any deny never ask for a fresh prompt', async () => {
      const a = withFresh('ok', 'cancelled')
      expect((await runDecision(route, a.deps)).status).toBe('done')
      const d = withFresh('ok', 'cancelled')
      expect((await runDecision({ ...risky, decision: 'deny' }, d.deps)).status).toBe('done')
      expect(a.freshCalls.length + d.freshCalls.length).toBe(0)
    })
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
    expect(shouldLock(true, 1000, 1000 + 14_000)).toBe(false)
    expect(shouldLock(true, 1000, 1000 + 16_000)).toBe(true)
    expect(LOCK_GRACE_MS).toBe(15_000)
    expect(shouldLock(false, 1000, 1000 + 600_000)).toBe(false)
    expect(shouldLock(true, null, 5)).toBe(false)
  })
  it('keeps the lock flag in the Keychain, not Preferences', () => {
    expect(SECRET_KEY.test(APPLOCK_KEY)).toBe(true)
  })
  it('a very recent success is reused', () => {
    expect(recentlyAuthed(10_000, 5_000)).toBe(true)
    expect(recentlyAuthed(30_000, 5_000)).toBe(false)
    expect(recentlyAuthed(10_000, 0)).toBe(false)
  })
})

describe('buildPushNav (notification actions trust only decrypted content)', () => {
  const seal = (body: object, keyB64: string): string => {
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ct = chacha20poly1305(b64ToBytes(keyB64), nonce).encrypt(new TextEncoder().encode(JSON.stringify(body)))
    const out = new Uint8Array(12 + ct.length)
    out.set(nonce)
    out.set(ct, 12)
    return bytesToB64(out)
  }
  const key = generatePushKey()
  const keys = [{ kid: pushKeyId('h1'), key }]
  const body = { kind: 'approval', rid: 'real', title: 't', body: 'b', hostId: 'h1', sessionKey: 's' }

  it('uses rid / kind / hostId from the decrypted content, not the plaintext userInfo', () => {
    const nav = buildPushNav({ enc: seal(body, key), kid: pushKeyId('h1'), rid: 'forged', k: 'question' }, 'APPROVE', keys)
    expect(nav).toMatchObject({ rid: 'real', kind: 'approval', hostId: 'h1', actionId: 'APPROVE', sessionKey: 's' })
    expect(routePushAction(nav)).toMatchObject({ type: 'decide', rid: 'real', hostId: 'h1' })
  })
  it('opens the Inbox without acting when there is no enc or it will not decrypt', () => {
    for (const data of [{ rid: 'forged', k: 'approval' }, { enc: seal(body, generatePushKey()), rid: 'forged', k: 'approval' }, { enc: 'garbage', rid: 'x', k: 'approval' }]) {
      const nav = buildPushNav(data, 'APPROVE', keys)
      expect(nav).toEqual({ actionId: 'tap' })
      expect(routePushAction(nav)).toEqual({ type: 'open' })
    }
    expect(buildPushNav({ enc: seal(body, key) }, 'APPROVE', [])).toEqual({ actionId: 'tap' })
  })
  it('rejects a hostId that does not belong to the key that decrypted it', () => {
    const nav = buildPushNav({ enc: seal({ ...body, hostId: 'other' }, key) }, 'APPROVE', keys)
    expect(nav.hostId).toBeUndefined()
    expect(routePushAction(nav).type).toBe('open')
  })
  it('never acts on a legacy key or content with no hostId', () => {
    expect(routePushAction(buildPushNav({ enc: seal(body, key) }, 'DENY', [{ kid: '', key }])).type).toBe('open')
    const { hostId: _h, ...noHost } = body
    expect(routePushAction(buildPushNav({ enc: seal(noHost, key) }, 'DENY', keys)).type).toBe('open')
  })
  it('a tap on a verified push opens with the decrypted rid', () => {
    expect(routePushAction(buildPushNav({ enc: seal(body, key) }, 'tap', keys))).toMatchObject({ type: 'open', rid: 'real', hostId: 'h1' })
  })
})
