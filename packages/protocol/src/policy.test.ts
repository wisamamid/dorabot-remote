import { describe, expect, it } from 'vitest'
import { isMethodAllowed, isValidScope, methodsForScopes, denialReason } from './policy.js'
import { SCOPES, SCOPE_DEFAULTS, SCOPE_LABELS, SCOPE_DESCRIPTIONS, type Scope } from './wire.js'

const only = (scope: Scope): Scope[] => [scope]
const exact = (scope: Scope): string[] => methodsForScopes(only(scope)).filter((m) => !m.endsWith('.*'))

describe('scope split', () => {
  it('has a label and description for every scope', () => {
    for (const s of SCOPES) {
      expect(SCOPE_LABELS[s]).toBeTruthy()
      expect(SCOPE_DESCRIPTIONS[s]).toBeTruthy()
    }
  })

  it('turns git and file reads on by default, and every write off', () => {
    expect(SCOPE_DEFAULTS).toEqual(['sessions', 'chat', 'approvals', 'work', 'files', 'git'])
    for (const s of ['git_write', 'terminal', 'admin'] as Scope[]) expect(SCOPE_DEFAULTS).not.toContain(s)
  })

  it('never lists an exact method under two scopes', () => {
    const seen = new Map<string, Scope>()
    for (const s of SCOPES) {
      for (const m of exact(s)) {
        // remote.roots is readable with either files or git (to show shared folders).
        if (m === 'remote.roots') continue
        expect(seen.get(m), `${m} is in both ${seen.get(m)} and ${s}`).toBeUndefined()
        seen.set(m, s)
      }
    }
  })

  it('keeps git writes out of the read-only git scope', () => {
    const reads = new Set(exact('git'))
    const writes = exact('git_write')
    expect(writes.length).toBeGreaterThan(0)
    for (const m of writes) expect(reads.has(m), m).toBe(false)
    for (const m of ['git.stageFile', 'git.unstageFile', 'git.stageAll', 'git.unstageAll', 'git.commit', 'git.push', 'git.pull', 'git.fetch', 'git.checkout']) {
      expect(isMethodAllowed(m, ['git', 'files', 'work'])).toBe(false)
      expect(isMethodAllowed(m, ['git_write'])).toBe(true)
    }
  })

  it('lets git read methods through with the git scope alone', () => {
    for (const m of ['git.status', 'git.diff', 'git.log', 'git.branches', 'git.showFile', 'git.detect']) {
      expect(isMethodAllowed(m, ['git'])).toBe(true)
      expect(isMethodAllowed(m, ['git_write'])).toBe(false)
    }
  })

  it('lists models read-only under sessions, and switching the model needs chat', () => {
    for (const m of ['provider.detect', 'provider.get', 'provider.codex.models']) {
      expect(isMethodAllowed(m, ['sessions']), m).toBe(true)
      expect(isMethodAllowed(m, ['chat']), m).toBe(false)
    }
    for (const m of ['sessions.setModel', 'agent.setModel']) {
      expect(isMethodAllowed(m, ['chat']), m).toBe(true)
      expect(isMethodAllowed(m, ['sessions']), m).toBe(false)
    }
    for (const m of ['config.set', 'provider.set', 'provider.auth.apiKey', 'provider.auth.oauth', 'provider.codex.rpc', 'provider.codex.appServerSnapshot']) {
      expect(isMethodAllowed(m, ['sessions', 'chat', 'approvals', 'work', 'files', 'git']), m).toBe(false)
    }
  })

  it('renames sessions under the sessions scope', () => {
    expect(isMethodAllowed('sessions.rename', ['sessions'])).toBe(true)
    expect(isMethodAllowed('sessions.rename', ['chat'])).toBe(false)
  })

  it('keeps files read-only and owns the file search methods', () => {
    expect(exact('files').every((m) => /^(fs\.(list|read|readBinary|stat)|search\.(files|ripgrep)|remote\.roots)$/.test(m))).toBe(true)
    expect(isMethodAllowed('search.files', ['chat'])).toBe(false)
    expect(isMethodAllowed('search.files', ['files'])).toBe(true)
    for (const m of ['fs.write', 'fs.mkdir', 'fs.rename', 'fs.copy', 'fs.delete', 'fs.reveal']) {
      expect(isMethodAllowed(m, ['files', 'git', 'git_write'])).toBe(false)
    }
  })

  it('is deny-by-default for gateway methods that were never mapped', () => {
    for (const m of ['git.discardFile', 'git.worktreeRemove', 'git.nonsense', 'fs.watch.start']) {
      expect(isMethodAllowed(m, ['git', 'git_write', 'files', 'work'])).toBe(false)
    }
  })

  it('names the scope that is missing in a refusal', () => {
    expect(denialReason('git.push', ['git'])).toMatch(/"git_write"/)
    expect(denialReason('git.push', SCOPE_DEFAULTS)).toMatch(/"git_write"/)
  })
})

describe('bridge method gating', () => {
  it('requires the sessions scope for remote.events', async () => {
    const { isMethodAllowed } = await import('./policy.js')
    expect(isMethodAllowed('remote.events', ['chat'])).toBe(false)
    expect(isMethodAllowed('remote.events', ['sessions'])).toBe(true)
    expect(isMethodAllowed('remote.health', [])).toBe(true)
  })
  it('gates remote.pins.* on the sessions scope', async () => {
    const { isMethodAllowed, methodsForScopes } = await import('./policy.js')
    for (const m of ['remote.pins.list', 'remote.pins.set']) {
      expect(isMethodAllowed(m, ['sessions'])).toBe(true)
      expect(isMethodAllowed(m, ['chat', 'work', 'approvals', 'files'])).toBe(false)
      expect(methodsForScopes(['sessions'])).toContain(m)
    }
  })
  it('does not expose unimplemented push methods or admin write fs / security.*', async () => {
    const { isMethodAllowed } = await import('./policy.js')
    expect(isMethodAllowed('bridge.registerPush', ['admin'])).toBe(false)
    expect(isMethodAllowed('fs.write', ['admin'])).toBe(false)
    expect(isMethodAllowed('security.set', ['admin'])).toBe(false)
    expect(isMethodAllowed('fs.read', ['files'])).toBe(true)
  })
})

describe('schedule scope and scope validation', () => {
  it('keeps persistent scheduled runs out of work and off by default', () => {
    for (const m of ['cron.add', 'cron.toggle', 'cron.run', 'cron.remove', 'calendar.add', 'calendar.update', 'calendar.toggle', 'calendar.run', 'calendar.remove']) {
      expect(isMethodAllowed(m, ['work']), m).toBe(false)
      expect(isMethodAllowed(m, ['schedule']), m).toBe(true)
    }
    for (const m of ['cron.list', 'calendar.list', 'calendar.export']) expect(isMethodAllowed(m, ['work']), m).toBe(true)
    expect(SCOPE_DEFAULTS).not.toContain('schedule')
  })

  it('validates scope names', () => {
    expect(isValidScope('schedule')).toBe(true)
    expect(isValidScope('terminal')).toBe(true)
    for (const bad of ['root', '', 'TERMINAL', undefined, null, 5, {}, '__proto__']) expect(isValidScope(bad), String(bad)).toBe(false)
  })

  it('lets remote.roots through with files or git only', () => {
    expect(isMethodAllowed('remote.roots', ['files'])).toBe(true)
    expect(isMethodAllowed('remote.roots', ['git'])).toBe(true)
    expect(isMethodAllowed('remote.roots', ['chat'])).toBe(false)
  })
})
