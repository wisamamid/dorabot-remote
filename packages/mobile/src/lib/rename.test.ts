import { describe, expect, it, vi } from 'vitest'
import type { StoredSession } from '@dorabot-remote/protocol'
import { MAX_NAME, normalizeName, renameSession } from './rename.js'

const row = (id: string, name?: string): StoredSession => ({
  id,
  name,
  messageCount: 1,
  createdAt: '',
  updatedAt: '',
})

function harness(initial: StoredSession[], rpc: (m: string, p?: unknown) => Promise<unknown>) {
  let list = initial
  const setSessions = (u: (p: StoredSession[]) => StoredSession[]): void => {
    list = u(list)
  }
  return { deps: { rpc: rpc as never, setSessions }, get: () => list }
}

describe('normalizeName', () => {
  it('trims, clamps and rejects empty', () => {
    expect(normalizeName('  hi  ')).toBe('hi')
    expect(normalizeName('   ')).toBeNull()
    expect(normalizeName('x'.repeat(200))).toHaveLength(MAX_NAME)
  })
})

describe('renameSession', () => {
  it('sends sessionId (not the session key) and the trimmed name, applying it optimistically', async () => {
    let seen: string | undefined
    const rpc = vi.fn(async () => {
      seen = h.get()[0].name
      return { renamed: true }
    })
    const h = harness([row('desktop-dm-abc-1', 'Old')], rpc)
    await renameSession(h.deps, 'desktop-dm-abc-1', '  New name ')
    expect(rpc).toHaveBeenCalledWith('sessions.rename', { sessionId: 'desktop-dm-abc-1', name: 'New name' })
    expect(seen).toBe('New name')
    expect(h.get()[0].name).toBe('New name')
  })

  it('rolls back and rethrows when the gateway refuses', async () => {
    const h = harness([row('a', 'Old'), row('b', 'Other')], async () => {
      throw new Error('forbidden')
    })
    await expect(renameSession(h.deps, 'a', 'New')).rejects.toThrow('forbidden')
    expect(h.get().map((s) => s.name)).toEqual(['Old', 'Other'])
  })

  it('rolls back to an unnamed session', async () => {
    const h = harness([row('a')], async () => {
      throw new Error('x')
    })
    await expect(renameSession(h.deps, 'a', 'New')).rejects.toThrow()
    expect(h.get()[0].name).toBeUndefined()
  })

  it('rejects an empty name without calling the gateway', async () => {
    const rpc = vi.fn()
    const h = harness([row('a', 'Old')], rpc)
    await expect(renameSession(h.deps, 'a', '  ')).rejects.toThrow('empty')
    expect(rpc).not.toHaveBeenCalled()
    expect(h.get()[0].name).toBe('Old')
  })
})
