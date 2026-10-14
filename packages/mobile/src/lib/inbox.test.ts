import { describe, expect, it } from 'vitest'
import {
  QUESTION_TIMEOUT_MS,
  actionable,
  approvalId,
  elicitationId,
  emptyInbox,
  inboxReducer,
  isTimedOut,
  questionId,
  questionRemaining,
  type InboxAction,
  type InboxState,
} from './inbox.js'

const T0 = 1_700_000_000_000

const run = (actions: InboxAction[], from: InboxState = emptyInbox): InboxState =>
  actions.reduce((s, a) => inboxReducer(s, a), from)

const ev = (event: string, data: unknown, now = T0): InboxAction => ({ type: 'event', event, data, now })

const approval = (requestId: string, sessionKey = 'desktop:dm:a', timestamp = T0) => ({
  requestId,
  toolName: 'Bash',
  input: { command: 'ls' },
  sessionKey,
  timestamp,
})

const question = (requestId: string, sessionKey = 'desktop:dm:a', timestamp = T0) => ({
  requestId,
  sessionKey,
  timestamp,
  questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
})

describe('arrival', () => {
  it('collects approvals, questions and elicitations from every session, newest first', () => {
    const s = run([
      ev('agent.tool_approval', approval('r1', 'desktop:dm:a', T0)),
      ev('agent.ask_user', question('q1', 'desktop:dm:b', T0 + 1000), T0 + 1000),
      ev(
        'agent.elicitation',
        { elicitationId: 'e1', sessionKey: 'desktop:dm:c', message: 'Name?', fields: [], timestamp: T0 + 2000 },
        T0 + 2000,
      ),
    ])
    expect(s.items.map((i) => i.id)).toEqual([elicitationId('e1'), questionId('q1'), approvalId('r1')])
    expect(s.items.map((i) => i.sessionKey)).toEqual(['desktop:dm:c', 'desktop:dm:b', 'desktop:dm:a'])
  })

  it('does not duplicate an item that is delivered twice (live then replayed)', () => {
    const s = run([ev('agent.tool_approval', approval('r1')), ev('agent.tool_approval', approval('r1'))])
    expect(s.items).toHaveLength(1)
  })

  it('caps a future timestamp at now so a fast Mac clock cannot shorten a countdown', () => {
    const s = run([ev('agent.ask_user', question('q1', 'k', T0 + 60_000), T0)])
    expect(s.items[0]!.at).toBe(T0)
  })
})

describe('resolution by anyone', () => {
  it('removes an approval another client approved', () => {
    const s = run([
      ev('agent.tool_approval', approval('r1')),
      ev('agent.tool_approval', approval('r2')),
      ev('agent.tool_approval_resolved', { requestId: 'r1', approved: true }),
    ])
    expect(s.items.map((i) => i.id)).toEqual([approvalId('r2')])
  })

  it('removes a question answered elsewhere, and one cancelled', () => {
    const base = run([ev('agent.ask_user', question('q1')), ev('agent.ask_user', question('q2'))])
    expect(
      inboxReducer(base, ev('agent.question_state', { requestId: 'q1', sessionKey: 'desktop:dm:a', status: 'answered' })).items,
    ).toHaveLength(1)
    expect(inboxReducer(base, ev('agent.question_dismissed', { requestId: 'q2', reason: 'cancelled' })).items).toHaveLength(1)
  })

  it('ignores a question_state that says it is still pending', () => {
    const s = run([ev('agent.ask_user', question('q1')), ev('agent.question_state', { requestId: 'q1', status: 'pending' })])
    expect(s.items).toHaveLength(1)
  })

  it('removes an elicitation on its result, whether submitted or dismissed', () => {
    const s = run([
      ev('agent.elicitation', { elicitationId: 'e1', sessionKey: 'k', message: 'm', fields: [], timestamp: T0 }),
      ev('agent.elicitation_result', { sessionKey: 'k', elicitationId: 'e1', values: null }),
    ])
    expect(s.items).toEqual([])
  })

  it('drops a session\'s questions when its conversation is reset, but keeps its approvals', () => {
    const s = run([
      ev('agent.tool_approval', approval('r1', 'k')),
      ev('agent.ask_user', question('q1', 'k')),
      ev('agent.conversation_reset', { sessionKey: 'k' }),
    ])
    expect(s.items.map((i) => i.id)).toEqual([approvalId('r1')])
  })
})

describe('question timeout', () => {
  it('counts down from arrival', () => {
    const s = run([ev('agent.ask_user', question('q1'))])
    const item = s.items[0]!
    expect(questionRemaining(item, T0)).toBe(QUESTION_TIMEOUT_MS)
    expect(questionRemaining(item, T0 + 100_000)).toBe(200_000)
    expect(questionRemaining(item, T0 + 999_000)).toBe(0)
  })

  it('flips to timed out on tick once the deadline passes, and stops being actionable', () => {
    let s = run([ev('agent.ask_user', question('q1')), ev('agent.tool_approval', approval('r1'))])
    s = inboxReducer(s, { type: 'tick', now: T0 + QUESTION_TIMEOUT_MS - 1 })
    expect(s.items.find((i) => i.kind === 'question')!.timedOut).toBe(false)
    s = inboxReducer(s, { type: 'tick', now: T0 + QUESTION_TIMEOUT_MS })
    const q = s.items.find((i) => i.kind === 'question')!
    expect(q.timedOut).toBe(true)
    expect(isTimedOut(q, T0 + QUESTION_TIMEOUT_MS)).toBe(true)
    expect(actionable(s).map((i) => i.kind)).toEqual(['approval'])
  })

  it('keeps a question the gateway timed out, labelled, until the user removes it', () => {
    let s = run([
      ev('agent.ask_user', question('q1')),
      ev('agent.question_state', { requestId: 'q1', sessionKey: 'desktop:dm:a', status: 'timeout' }),
      ev('agent.question_dismissed', { requestId: 'q1', sessionKey: 'desktop:dm:a', reason: 'timeout' }),
    ])
    expect(s.items).toHaveLength(1)
    expect(s.items[0]!.timedOut).toBe(true)
    s = inboxReducer(s, { type: 'remove', id: questionId('q1') })
    expect(s.items).toEqual([])
  })

  it('does not resurrect a long-expired question replayed after a reconnect', () => {
    const s = run([ev('agent.ask_user', question('q1', 'k', T0), T0 + QUESTION_TIMEOUT_MS + 60_000)])
    expect(s.items).toEqual([])
  })
})

describe('session snapshots', () => {
  const snap = (over: Record<string, unknown> = {}) => ({
    sessionKey: 'desktop:dm:a',
    status: 'idle',
    text: '',
    currentTool: null,
    completedTools: [],
    pendingApproval: null,
    pendingQuestion: null,
    pendingElicitation: null,
    updatedAt: T0,
    ...over,
  })

  it('adds what the phone missed while it was away', () => {
    const s = run([
      ev(
        'session.snapshot',
        snap({
          pendingApproval: { requestId: 'r1', toolName: 'Write', input: {}, timestamp: T0 },
          pendingQuestion: { requestId: 'q1', questions: [], timestamp: T0 },
        }),
      ),
    ])
    expect(s.items.map((i) => i.id).sort()).toEqual([approvalId('r1'), questionId('q1')].sort())
    expect(s.items.every((i) => i.sessionKey === 'desktop:dm:a')).toBe(true)
  })

  it('removes a question and elicitation the snapshot no longer carries', () => {
    const s = run([
      ev('agent.ask_user', question('q1')),
      ev('agent.elicitation', { elicitationId: 'e1', sessionKey: 'desktop:dm:a', message: 'm', fields: [], timestamp: T0 }),
      ev('session.snapshot', snap()),
    ])
    expect(s.items).toEqual([])
  })

  it('never removes an approval: a snapshot only holds the latest of several', () => {
    const s = run([ev('agent.tool_approval', approval('r1')), ev('agent.tool_approval', approval('r2')), ev('session.snapshot', snap())])
    expect(s.items).toHaveLength(2)
  })

  it('does not touch another session', () => {
    const s = run([ev('agent.ask_user', question('q1', 'desktop:dm:b')), ev('session.snapshot', snap())])
    expect(s.items).toHaveLength(1)
  })
})

describe('reconcile with tool.pending', () => {
  const rec = (pending: string[], startedAt = T0 + 10_000, now = T0 + 10_500): InboxAction => ({
    type: 'reconcile',
    pending: pending.map((requestId) => ({ requestId, toolName: 'Bash', input: { command: 'x' } })),
    startedAt,
    now,
  })

  it('drops approvals the gateway no longer holds (resolved while the phone was away)', () => {
    const s = run([ev('agent.tool_approval', approval('r1')), ev('agent.tool_approval', approval('r2')), rec(['r2'])])
    expect(s.items.map((i) => i.id)).toEqual([approvalId('r2')])
  })

  it('adopts an approval the phone never heard about, with no session', () => {
    const s = run([rec(['r9'])])
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ id: approvalId('r9'), kind: 'approval', sessionKey: null })
  })

  it('later learns the session for an adopted approval from a snapshot', () => {
    const s = run([
      rec(['r9']),
      ev('session.snapshot', {
        sessionKey: 'desktop:dm:z',
        status: 'idle',
        text: '',
        currentTool: null,
        completedTools: [],
        pendingApproval: { requestId: 'r9', toolName: 'Bash', input: {}, timestamp: T0 },
        pendingQuestion: null,
        updatedAt: T0,
      }),
    ])
    expect(s.items).toHaveLength(1)
    expect(s.items[0]!.sessionKey).toBe('desktop:dm:z')
  })

  it('spares an approval that arrived after the request was sent', () => {
    const arrived = run([ev('agent.tool_approval', approval('r3', 'k', T0 + 12_000), T0 + 12_000)])
    const s = inboxReducer(arrived, rec([], T0 + 10_000, T0 + 13_000))
    expect(s.items.map((i) => i.id)).toEqual([approvalId('r3')])
  })

  it('leaves questions and elicitations alone: tool.pending knows nothing about them', () => {
    const s = run([ev('agent.ask_user', question('q1')), rec([])])
    expect(s.items).toHaveLength(1)
  })

  it('is idempotent', () => {
    const once = run([ev('agent.tool_approval', approval('r1')), rec(['r1'])])
    expect(inboxReducer(once, rec(['r1']))).toEqual(once)
  })
})

describe('housekeeping', () => {
  it('returns the same state object when nothing changed, so React skips the render', () => {
    const s = run([ev('agent.tool_approval', approval('r1'))])
    expect(inboxReducer(s, { type: 'tick', now: T0 + 1000 })).toBe(s)
    expect(inboxReducer(s, ev('agent.tool_approval_resolved', { requestId: 'nope' }))).toBe(s)
    expect(inboxReducer(emptyInbox, { type: 'clear' })).toBe(emptyInbox)
  })
})
