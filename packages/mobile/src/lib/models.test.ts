import { describe, expect, it, vi } from 'vitest'
import type { StoredSession } from '@dorabot-remote/protocol'
import { buildModelGroups, currentModelValue, shortModelName, switchModel } from './models.js'

const row = (id: string, model?: string): StoredSession => ({ id, model, messageCount: 0, createdAt: '', updatedAt: '' })

describe('buildModelGroups', () => {
  it('shows only configured providers and disables the one the Mac is not running', () => {
    const g = buildModelGroups({
      detect: { claude: { hasOAuth: true }, codex: { hasAuth: true } },
      active: 'claude',
      codexModels: [{ id: 'gpt-5.5', displayName: 'GPT-5.5' }, { id: 'x', hidden: true }],
    })
    expect(g.map((x) => [x.provider, x.selectable])).toEqual([['claude', true], ['codex', false]])
    expect(g[1].reason).toMatch(/OpenAI/)
    expect(g[1].models.map((m) => m.value)).toEqual(['gpt-5.5'])
  })
  it('hides an unconfigured provider', () => {
    const g = buildModelGroups({ detect: { claude: { hasApiKey: true }, codex: { hasAuth: false } }, active: 'claude' })
    expect(g.map((x) => x.provider)).toEqual(['claude'])
  })
  it('falls back to the active provider when detect failed', () => {
    expect(buildModelGroups({ detect: null, active: 'claude' }).map((x) => x.provider)).toEqual(['claude'])
  })
})

describe('names', () => {
  it('shortens labels and unknown ids', () => {
    expect(shortModelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(shortModelName('claude-opus-5')).toBe('Opus 5')
    expect(shortModelName('claude-weird-9-20260101')).toBe('weird-9')
  })
  it('defaults to the Mac default when the session has no pick', () => {
    expect(currentModelValue(row('a'))).toBe('claude-opus-5-5')
    expect(currentModelValue(row('a', 'claude-haiku-4-5'))).toBe('claude-haiku-4-5')
  })
})

function harness(initial: StoredSession[], rpc: (m: string, p?: unknown) => Promise<unknown>) {
  let list = initial
  return {
    deps: { rpc: rpc as never, setSessions: (u: (p: StoredSession[]) => StoredSession[]) => void (list = u(list)) },
    get: () => list,
  }
}

describe('switchModel', () => {
  const target = { sessionId: 'desktop-dm-1-2', sessionKey: 'desktop:dm:1', running: false }
  it('sends sessions.setModel with sessionId and applies optimistically', async () => {
    const rpc = vi.fn(async () => ({}))
    const h = harness([row('desktop-dm-1-2', 'claude-sonnet-5')], rpc)
    const r = await switchModel(h.deps, target, 'claude-haiku-4-5')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('sessions.setModel', { sessionId: 'desktop-dm-1-2', model: 'claude-haiku-4-5' })
    expect(h.get()[0].model).toBe('claude-haiku-4-5')
    expect(r.live).toBe(false)
  })
  it('rolls back on failure', async () => {
    const h = harness([row('desktop-dm-1-2', 'claude-sonnet-5')], async () => {
      throw new Error('nope')
    })
    await expect(switchModel(h.deps, target, 'claude-haiku-4-5')).rejects.toThrow('nope')
    expect(h.get()[0].model).toBe('claude-sonnet-5')
  })
  it('also switches the live run when one is active, tolerating its failure', async () => {
    const rpc = vi.fn(async (m: string) => {
      if (m === 'agent.setModel') throw new Error('not supported')
      return {}
    })
    const h = harness([row('desktop-dm-1-2')], rpc)
    const r = await switchModel(h.deps, { ...target, running: true }, 'claude-haiku-4-5')
    expect(rpc).toHaveBeenCalledWith('agent.setModel', { sessionKey: 'desktop:dm:1', model: 'claude-haiku-4-5' })
    expect(r.live).toBe(false)
    expect(h.get()[0].model).toBe('claude-haiku-4-5')
  })
})
