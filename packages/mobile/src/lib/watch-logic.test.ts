import { describe, expect, it, vi } from 'vitest'
import type { InboxItem } from './inbox.js'
import {
  buildWatchSnapshot,
  handleWatchRequest,
  NOT_CONNECTED,
  OPEN_ON_PHONE,
  UNLOCK_PHONE,
  WATCH_MAX_ITEMS,
  type WatchDeps,
} from './watch-logic.js'

const approval = (rid: string, toolName: string, input: Record<string, unknown>, at = 1000): InboxItem => ({
  id: `approval:${rid}`,
  kind: 'approval',
  sessionKey: 'telegram:dm:abcdef123456',
  at,
  timedOut: false,
  approval: { requestId: rid, toolName, input, timestamp: at },
})
const question = (rid: string, timedOut = false): InboxItem => ({
  id: `question:${rid}`,
  kind: 'question',
  sessionKey: null,
  at: 1000,
  timedOut,
  question: { requestId: rid, questions: [{ question: 'Which branch?', options: [] }], timestamp: 1000 },
})

const routine = approval('r1', 'Read', { file_path: '/tmp/proj/a.txt' })
const risky = approval('r2', 'Bash', { command: 'rm -rf /' })

describe('app lock', () => {
  it('omits command text from the snapshot while locked', () => {
    const snap = buildWatchSnapshot([routine, risky, question('q1')], 'm', [], 0, true)
    expect(snap.items.map((i) => [i.title, i.summary])).toEqual([['Read', ''], ['Bash', ''], ['Question', '']])
    expect(JSON.stringify(snap)).not.toContain('rm -rf')
    expect(JSON.stringify(snap)).not.toContain('a.txt')
  })

  it('refuses approve and deny while locked, but still answers a refresh', async () => {
    const d = { connected: true, locked: true, items: [routine], approve: vi.fn(async () => {}), deny: vi.fn(async () => {}) }
    expect(await handleWatchRequest({ action: 'approve', rid: 'r1' }, d)).toEqual({ ok: false, message: UNLOCK_PHONE })
    expect(await handleWatchRequest({ action: 'deny', rid: 'r1' }, d)).toEqual({ ok: false, message: UNLOCK_PHONE })
    expect(d.approve).not.toHaveBeenCalled()
    expect(d.deny).not.toHaveBeenCalled()
    expect((await handleWatchRequest({ action: 'refresh' }, d)).ok).toBe(true)
  })
})

describe('buildWatchSnapshot', () => {
  it('shapes approvals and flags risky ones', () => {
    const snap = buildWatchSnapshot([routine, risky], 'My Mac', [], 5)
    expect(snap.at).toBe(5)
    expect(snap.items.map((i) => [i.rid, i.kind, i.risky])).toEqual([
      ['r1', 'approval', false],
      ['r2', 'approval', true],
    ])
    expect(snap.items[0]).toMatchObject({ hostName: 'My Mac', title: 'Read', summary: '/tmp/proj/a.txt' })
    expect(snap.items[1]!.summary).toBe('rm -rf /')
  })

  it('treats an approval with unreadable input as risky', () => {
    const odd = { ...routine, approval: { ...routine.approval!, input: undefined as never } }
    expect(buildWatchSnapshot([odd], 'm', [], 0).items[0]!.risky).toBe(true)
  })

  it('shows questions as non-actionable text and drops expired ones', () => {
    const snap = buildWatchSnapshot([question('q1'), question('q2', true)], 'm', [], 0)
    expect(snap.items).toHaveLength(1)
    expect(snap.items[0]).toMatchObject({ rid: 'q1', kind: 'question', summary: 'Which branch?', risky: false })
  })

  it('caps the list and truncates long text', () => {
    const many = Array.from({ length: 20 }, (_, i) => approval(`r${i}`, 'Bash', { command: 'x'.repeat(500) }))
    const snap = buildWatchSnapshot(many, 'm', [], 0)
    expect(snap.items).toHaveLength(WATCH_MAX_ITEMS)
    expect(snap.items[0]!.summary.length).toBeLessThanOrEqual(140)
  })
})

function deps(over: Partial<WatchDeps> = {}): WatchDeps {
  return { connected: true, items: [routine, risky, question('q1')], approve: vi.fn(async () => {}), deny: vi.fn(async () => {}), ...over }
}

describe('handleWatchRequest', () => {
  it('does nothing when the phone is not connected', async () => {
    const d = deps({ connected: false })
    expect(await handleWatchRequest({ action: 'approve', rid: 'r1' }, d)).toEqual({ ok: false, message: NOT_CONNECTED })
    expect(d.approve).not.toHaveBeenCalled()
  })

  it('approves and denies a routine approval through the inbox actions', async () => {
    const d = deps()
    expect(await handleWatchRequest({ action: 'approve', rid: 'r1' }, d)).toEqual({ ok: true, message: 'Approved' })
    expect(await handleWatchRequest({ action: 'deny', rid: 'r1' }, d)).toEqual({ ok: true, message: 'Denied' })
    expect(d.approve).toHaveBeenCalledWith(routine)
    expect(d.deny).toHaveBeenCalledWith(routine)
  })

  it('refuses risky approvals (and denials) from the watch, whatever it claims', async () => {
    const d = deps()
    expect(await handleWatchRequest({ action: 'approve', rid: 'r2' }, d)).toEqual({ ok: false, message: OPEN_ON_PHONE })
    expect(await handleWatchRequest({ action: 'deny', rid: 'r2' }, d)).toEqual({ ok: false, message: OPEN_ON_PHONE })
    expect(d.approve).not.toHaveBeenCalled()
    expect(d.deny).not.toHaveBeenCalled()
  })

  it('sends questions to the phone', async () => {
    const d = deps()
    expect((await handleWatchRequest({ action: 'approve', rid: 'q1' }, d)).message).toBe('Answer on iPhone')
    expect(d.approve).not.toHaveBeenCalled()
  })

  it('reports unknown requests and bad input without acting', async () => {
    const d = deps()
    expect((await handleWatchRequest({ action: 'approve', rid: 'nope' }, d)).message).toBe('Already handled')
    expect((await handleWatchRequest({ action: 'approve' }, d)).ok).toBe(false)
    expect((await handleWatchRequest({ action: 'launch' as never, rid: 'r1' }, d)).ok).toBe(false)
    expect(d.approve).not.toHaveBeenCalled()
  })

  it('answers a refresh, and turns a failure into a message', async () => {
    expect(await handleWatchRequest({ action: 'refresh' }, deps())).toEqual({ ok: true, message: 'Updated' })
    const d = deps({ approve: vi.fn(async () => { throw new Error('boom') }) })
    const r = await handleWatchRequest({ action: 'approve', rid: 'r1' }, d)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('boom')
  })
})
