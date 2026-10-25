import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionAggregator, sessionMessagesToChatItems, type StoredSession } from '@dorabot-remote/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEMO_KEYS, createDemoClient, type ClientLike } from './demo.js'
import { assessRisk } from '@dorabot-remote/protocol'
import { actionable, emptyInbox, inboxReducer, type InboxState } from './inbox.js'

let inbox: InboxState
let agg: SessionAggregator
let client: ClientLike
let ready: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  inbox = emptyInbox
  agg = new SessionAggregator()
  ready = vi.fn()
  client = createDemoClient({
    onState: () => {},
    onReady: (i) => ready(i),
    onEvent: (event, data, seq, sk) => {
      inbox = inboxReducer(inbox, { type: 'event', event, data, now: Date.now() })
      agg.apply(event, data, seq, sk)
    },
  })
  client.connect()
  vi.advanceTimersByTime(10)
})
afterEach(() => {
  client.disconnect()
  vi.useRealTimers()
})

describe('demo host', () => {
  it('becomes ready as a fake Mac with chat and approval scopes', () => {
    expect(client.state).toBe('ready')
    const info = ready.mock.calls[0]![0]
    expect(info.host.name).toBe('Demo Mac')
    expect(info.device.scopes).toEqual(['sessions', 'chat', 'approvals'])
    expect(client.can('tool.approve')).toBe(true)
    expect(client.can('shell.spawn')).toBe(false)
  })

  it('lists three sessions', async () => {
    const list = await client.rpc<StoredSession[]>('sessions.list')
    expect(list).toHaveLength(3)
    expect(new Set(list.map((s) => s.id)).size).toBe(3)
  })

  it('has realistic transcripts that render as chat items', async () => {
    const list = await client.rpc<StoredSession[]>('sessions.list')
    for (const s of list) {
      const res = await client.rpc<{ messages: never[] }>('sessions.get', { sessionId: s.id })
      const items = sessionMessagesToChatItems(res.messages)
      expect(items.some((i) => i.type === 'user')).toBe(true)
      expect(items.some((i) => i.type === 'text')).toBe(true)
    }
    const checkout = await client.rpc<{ messages: never[] }>('sessions.get', { sessionId: list[0]!.id })
    const tools = sessionMessagesToChatItems(checkout.messages).filter((i) => i.type === 'tool_use')
    expect(tools.length).toBeGreaterThan(1)
    expect(tools.every((t) => t.type === 'tool_use' && t.output)).toBe(true)
  })

  it('puts two approvals (one risky) and one question in the inbox', async () => {
    const live = actionable(inbox)
    expect(live.map((i) => i.kind).sort()).toEqual(['approval', 'approval', 'question'])
    expect(live.find((i) => i.id === 'approval:demo-approval-1')?.approval).toMatchObject({ toolName: 'Bash', input: { command: 'npm test' } })
    expect(assessRisk('Bash', live.find((i) => i.id === 'approval:demo-approval-2')!.approval!.input).risky).toBe(true)
    expect(await client.rpc('tool.pending')).toHaveLength(2)
  })

  it('approving resolves the item and streams a canned reply', async () => {
    await client.rpc('tool.approve', { requestId: 'demo-approval-1' })
    vi.advanceTimersByTime(10_000)
    expect(inbox.items.some((i) => i.id === 'approval:demo-approval-1')).toBe(false)
    const s = agg.get(DEMO_KEYS.checkout)
    expect(s.status).toBe('idle')
    const text = s.chatItems.filter((i) => i.type === 'text').map((i) => (i.type === 'text' ? i.content : '')).join('')
    expect(text).toContain('84 tests pass')
    const bash = s.chatItems.find((i) => i.type === 'tool_use' && i.name === 'Bash')
    expect(bash).toMatchObject({ output: expect.stringContaining('passed') })
    expect(s.chatItems.at(-1)?.type).toBe('result')
    expect(await client.rpc('tool.pending')).toEqual([expect.objectContaining({ requestId: 'demo-approval-2' })])
  })

  it('denying also resolves and replies', async () => {
    await client.rpc('tool.deny', { requestId: 'demo-approval-1' })
    vi.advanceTimersByTime(10_000)
    expect(inbox.items.some((i) => i.id === 'approval:demo-approval-1')).toBe(false)
    expect(agg.get(DEMO_KEYS.checkout).chatItems.some((i) => i.type === 'text')).toBe(true)
  })

  it('answering the question clears it and replies using the answer', async () => {
    await client.rpc('chat.answerQuestion', { requestId: 'demo-question-1', answers: { 'Who are the v2.4 release notes for?': 'Customers' } })
    vi.advanceTimersByTime(10_000)
    expect(inbox.items.some((i) => i.kind === 'question')).toBe(false)
    const text = agg.get(DEMO_KEYS.release).chatItems.map((i) => (i.type === 'text' ? i.content : '')).join('')
    expect(text).toContain('customers')
  })

  it('rejects an unknown or repeated approval', async () => {
    await client.rpc('tool.approve', { requestId: 'demo-approval-1' })
    await expect(client.rpc('tool.approve', { requestId: 'demo-approval-1' })).rejects.toThrow(/No pending/)
  })

  it('chat.send plays back a canned answer', async () => {
    await client.rpc('chat.send', { prompt: 'hello', sessionKey: DEMO_KEYS.digest })
    vi.advanceTimersByTime(10_000)
    const items = agg.get(DEMO_KEYS.digest).chatItems
    expect(items[0]).toMatchObject({ type: 'user', content: 'hello' })
    expect(items.some((i) => i.type === 'text' && i.content.includes('demo'))).toBe(true)
  })

  it('refuses anything it does not simulate', async () => {
    await expect(client.rpc('shell.spawn')).rejects.toThrow(/not available in the demo/)
  })

  it('disconnect stops in-flight streaming', async () => {
    await client.rpc('tool.approve', { requestId: 'demo-approval-1' })
    client.disconnect()
    vi.advanceTimersByTime(10_000)
    expect(agg.get(DEMO_KEYS.checkout).chatItems.some((i) => i.type === 'result')).toBe(false)
  })
})

describe('demo isolation', () => {
  it('imports nothing that can reach storage, the native bridge or the network', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/demo.ts'), 'utf8')
    const imports = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports).toEqual(['@dorabot-remote/protocol'])
    expect(src).not.toMatch(/\b(fetch|WebSocket|localStorage|storage\.)\b/)
  })

  it('opens no socket', () => {
    const ws = vi.fn()
    vi.stubGlobal('WebSocket', ws)
    const c = createDemoClient({ onState: () => {}, onReady: () => {}, onEvent: () => {} })
    c.connect()
    vi.advanceTimersByTime(10)
    c.disconnect()
    vi.unstubAllGlobals()
    expect(ws).not.toHaveBeenCalled()
  })
})
