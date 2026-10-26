import { describe, expect, it } from 'vitest'
import { authLevelFor, requireApprovalAuth, verdictAllows } from './approval-auth.js'
import type { AuthResult } from './biometric.js'

const deps = (verdict: AuthResult, native = true) => {
  const calls: string[] = []
  return { calls, deps: { native, fresh: async (r: string) => (calls.push(r), verdict) } }
}

describe('authLevelFor', () => {
  it('routine calls need nothing, risky ones need a fresh prompt', () => {
    expect(authLevelFor('Bash', { command: 'npm test' })).toBe('none')
    expect(authLevelFor('Bash', { command: 'rm -rf x' })).toBe('fresh')
    expect(authLevelFor('Write', { file_path: '/etc/x', content: '' })).toBe('fresh')
  })
  it('fails closed when it cannot judge', () => {
    expect(authLevelFor(undefined, { command: 'ls' })).toBe('fresh')
    expect(authLevelFor('Bash', undefined)).toBe('fresh')
  })
})

describe('verdictAllows', () => {
  it('only ok passes on a device; unavailable passes only without a native prompt (demo / web)', () => {
    expect(verdictAllows('ok', true)).toBe(true)
    for (const v of ['cancelled', 'failed', 'unavailable'] as const) expect(verdictAllows(v, true)).toBe(false)
    expect(verdictAllows('unavailable', false)).toBe(true)
    expect(verdictAllows('cancelled', false)).toBe(false)
  })
})

describe('requireApprovalAuth', () => {
  it('never prompts for a routine approval', async () => {
    const t = deps('cancelled')
    expect(await requireApprovalAuth('Bash', { command: 'ls' }, {}, t.deps)).toBeNull()
    expect(t.calls).toEqual([])
  })
  it('prompts every time for a risky one, regardless of earlier successes', async () => {
    const t = deps('ok')
    expect(await requireApprovalAuth('Bash', { command: 'sudo ls' }, {}, t.deps)).toBeNull()
    expect(await requireApprovalAuth('Bash', { command: 'sudo ls' }, {}, t.deps)).toBeNull()
    expect(t.calls).toHaveLength(2)
  })
  it('blocks when the prompt is cancelled, fails or is unavailable on a device', async () => {
    for (const v of ['cancelled', 'failed', 'unavailable'] as const) {
      expect(await requireApprovalAuth('Bash', { command: 'git push' }, {}, deps(v).deps)).toMatch(/\S/)
    }
  })
})
