/**
 * Demo mode: a fake Mac that lives entirely inside the app.
 *
 * It stands in for `RemoteClient` at the connection layer, so the rest of the app
 * (sessions, Inbox, transcripts) runs unmodified against it. It opens no socket,
 * has no keys, and imports nothing that touches storage or the native bridge, so
 * it cannot reach real pairing data or the network by construction.
 *
 * It exists so App Review, which has no Mac, can see every screen working.
 */
import type {
  ConnectionState,
  DeviceSummary,
  HostSummary,
  Scope,
  SessionMessage,
  StoredSession,
} from '@dorabot-remote/protocol'

/** The slice of RemoteClient that the connection layer uses. */
export interface ClientLike {
  state: ConnectionState
  connect(): void
  disconnect(): void
  forceReconnect(): void
  checkAlive(timeoutMs?: number): void
  setNetworkType(type: string): void
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>
  subscribe(sessionKeys: string[]): Promise<void>
  can(method: string): boolean
}

export interface DemoHandlers {
  onState: (state: ConnectionState, detail?: string) => void
  onReady: (info: { host: HostSummary; device: DeviceSummary; gatewayConnected: boolean }) => void
  onEvent: (event: string, data: unknown, seq: number | undefined, sessionKey?: string) => void
}

export const DEMO_HOST_NAME = 'Demo Mac'
const DEMO_SCOPES: Scope[] = ['sessions', 'chat', 'approvals']

export const DEMO_KEYS = {
  checkout: 'demo:dm:checkout',
  release: 'demo:dm:release',
  digest: 'demo:dm:digest',
} as const

const ALLOWED = [
  'sessions.list',
  'sessions.get',
  'sessions.rename',
  'sessions.setModel',
  'agent.setModel',
  'agent.abort',
  'agent.interrupt',
  'remote.pins.list',
  'remote.pins.set',
  'chat.send',
  'chat.answerQuestion',
  'tool.approve',
  'tool.deny',
  'tool.pending',
]

const MIN = 60_000

const sid = (key: string): string => `sess-${key.split(':').at(-1)}`

function user(text: string, ts: number): SessionMessage {
  return { type: 'user', timestamp: new Date(ts).toISOString(), content: { message: { content: text } } }
}
function assistant(blocks: Array<Record<string, unknown>>, ts: number): SessionMessage {
  return { type: 'assistant', timestamp: new Date(ts).toISOString(), content: { message: { content: blocks } } }
}
function toolResult(id: string, text: string, ts: number): SessionMessage {
  return {
    type: 'user',
    timestamp: new Date(ts).toISOString(),
    content: { message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } },
  }
}
function result(ts: number): SessionMessage {
  return { type: 'result', timestamp: new Date(ts).toISOString(), content: { total_cost_usd: 0.0412 } }
}

function transcripts(now: number): Record<string, SessionMessage[]> {
  return {
    [DEMO_KEYS.checkout]: [
      user('The checkout tests are failing on CI after the tax refactor. Can you find out why and fix it?', now - 42 * MIN),
      assistant([{ type: 'text', text: "I'll start by looking at the failing test and the code it exercises." }], now - 41 * MIN),
      assistant([{ type: 'tool_use', id: 'tu-1', name: 'Grep', input: { pattern: 'calculateTax', path: 'src' } }], now - 41 * MIN),
      toolResult('tu-1', 'src/checkout/tax.ts:12: export function calculateTax(\nsrc/checkout/cart.test.ts:48: calculateTax(cart, region)', now - 41 * MIN),
      assistant([{ type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: 'src/checkout/tax.ts' } }], now - 40 * MIN),
      toolResult('tu-2', 'export function calculateTax(cart: Cart, region: string) {\n  const rate = RATES[region]\n  return cart.subtotal * rate\n}', now - 40 * MIN),
      assistant(
        [
          {
            type: 'text',
            text: 'Found it. `calculateTax` no longer handles regions missing from `RATES`, so `rate` is `undefined` and the total becomes `NaN`. I will default unknown regions to zero tax and add a test.',
          },
        ],
        now - 39 * MIN,
      ),
      assistant(
        [{ type: 'tool_use', id: 'tu-3', name: 'Edit', input: { file_path: 'src/checkout/tax.ts', old_string: 'RATES[region]', new_string: 'RATES[region] ?? 0' } }],
        now - 38 * MIN,
      ),
      toolResult('tu-3', 'The file src/checkout/tax.ts has been updated.', now - 38 * MIN),
      assistant([{ type: 'text', text: 'Fix applied. I want to run the test suite to confirm.' }], now - 37 * MIN),
    ],
    [DEMO_KEYS.release]: [
      user('Draft release notes for v2.4. Pull from the merged PRs since the last tag.', now - 3 * 60 * MIN),
      assistant([{ type: 'text', text: 'There are 18 merged PRs since v2.3. Most are bug fixes, with three user-facing features: offline mode, CSV export and dark theme.' }], now - 179 * MIN),
      assistant([{ type: 'text', text: 'Before I write this up I need to know who it is for.' }], now - 178 * MIN),
    ],
    [DEMO_KEYS.digest]: [
      user("Summarize last week's pull requests into a short digest for the team channel.", now - 26 * 60 * MIN),
      assistant([{ type: 'tool_use', id: 'tu-9', name: 'Bash', input: { command: 'gh pr list --state merged --limit 30' } }], now - 26 * 60 * MIN + MIN),
      toolResult('tu-9', '#412 Add CSV export\n#409 Fix offline sync crash\n#405 Dark theme tokens\n... 12 more', now - 26 * 60 * MIN + 2 * MIN),
      assistant(
        [
          {
            type: 'text',
            text: "**Last week in review**\n\n- Shipped CSV export (#412) and dark theme tokens (#405)\n- Fixed the offline sync crash (#409)\n- 12 smaller fixes and dependency bumps\n\nNothing is blocked, and v2.4 is on track for Thursday.",
          },
        ],
        now - 26 * 60 * MIN + 3 * MIN,
      ),
      result(now - 26 * 60 * MIN + 3 * MIN),
    ],
  }
}

interface Reply {
  /** Optional tool run shown before the text. */
  tool?: { id: string; name: string; input: Record<string, unknown>; output: string }
  text: string
}

const REPLIES: Record<string, { approved: Reply; denied: Reply; answered?: (answer: string) => Reply }> = {
  [DEMO_KEYS.checkout]: {
    approved: {
      tool: {
        id: 'tu-4',
        name: 'Bash',
        input: { command: 'npm test' },
        output: 'Test Suites: 12 passed, 12 total\nTests:       84 passed, 84 total',
      },
      text: 'All 84 tests pass now, including the new regional tax case. The fix is in `src/checkout/tax.ts`. This is a demo, so nothing was actually run.',
    },
    denied: { text: 'Understood, I will not run the tests. The fix is applied but unverified. Tell me if you want me to try a different check.' },
  },
  [DEMO_KEYS.release]: {
    approved: { text: 'Done.' },
    denied: { text: 'Okay.' },
    answered: (answer) => ({
      text: `Got it, writing for ${answer.toLowerCase()}.\n\n**v2.4**\n\n- Offline mode: keep working without a connection\n- CSV export from any table\n- A new dark theme\n- 15 fixes\n\nThis is a demo reply. On a real Mac this would be written by your dorabot.`,
    }),
  },
}

/** Build the fake Mac. `now` and the timer are injectable so tests are deterministic. */
export function createDemoClient(handlers: DemoHandlers, now: () => number = Date.now): ClientLike {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (ms: number, fn: () => void): void => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
  }
  const clearTimers = (): void => {
    for (const t of timers) clearTimeout(t)
    timers.clear()
  }

  const t0 = now()
  let models: Record<string, string> = {}
  let names: Record<string, string> = {}
  let pins: Array<{ id: string; pinnedAt: number }> = []
  const history = transcripts(t0)
  const sessions: StoredSession[] = [
    {
      id: sid(DEMO_KEYS.checkout),
      name: 'Fix failing checkout tests',
      channel: 'demo',
      chatType: 'dm',
      chatId: 'checkout',
      messageCount: history[DEMO_KEYS.checkout]!.length,
      createdAt: new Date(t0 - 42 * MIN).toISOString(),
      updatedAt: new Date(t0 - 37 * MIN).toISOString(),
      preview: 'Fix applied. I want to run the test suite to confirm.',
      activeRun: true,
      model: 'sonnet',
    },
    {
      id: sid(DEMO_KEYS.release),
      name: 'Draft v2.4 release notes',
      channel: 'demo',
      chatType: 'dm',
      chatId: 'release',
      messageCount: history[DEMO_KEYS.release]!.length,
      createdAt: new Date(t0 - 3 * 60 * MIN).toISOString(),
      updatedAt: new Date(t0 - 178 * MIN).toISOString(),
      preview: 'Before I write this up I need to know who it is for.',
      activeRun: true,
      model: 'sonnet',
    },
    {
      id: sid(DEMO_KEYS.digest),
      name: 'Weekly PR digest',
      channel: 'demo',
      chatType: 'dm',
      chatId: 'digest',
      messageCount: history[DEMO_KEYS.digest]!.length,
      createdAt: new Date(t0 - 26 * 60 * MIN).toISOString(),
      updatedAt: new Date(t0 - 26 * 60 * MIN + 3 * MIN).toISOString(),
      preview: 'Nothing is blocked, and v2.4 is on track for Thursday.',
      model: 'sonnet',
    },
  ]

  const approval = {
    requestId: 'demo-approval-1',
    toolName: 'Bash',
    input: { command: 'npm test', description: 'Run the test suite' },
    sessionKey: DEMO_KEYS.checkout,
    timestamp: t0 - 2 * MIN,
    title: 'Approve Bash: npm test?',
  }
  const question = {
    requestId: 'demo-question-1',
    sessionKey: DEMO_KEYS.release,
    timestamp: t0 - MIN,
    questions: [
      {
        header: 'Audience',
        question: 'Who are the v2.4 release notes for?',
        options: [
          { label: 'Customers', description: 'Plain language, benefits first' },
          { label: 'Engineers', description: 'Technical detail and PR links' },
          { label: 'Both', description: 'A short summary, then a changelog' },
        ],
      },
    ],
  }
  let approvalOpen = true
  let questionOpen = true

  let state: ConnectionState = 'idle'
  const setState = (s: ConnectionState): void => {
    state = s
    client.state = s
    handlers.onState(s)
  }

  const emit = (event: string, data: Record<string, unknown>): void => {
    handlers.onEvent(event, data, undefined, data.sessionKey as string | undefined)
  }

  /** A canned assistant turn, streamed the way the gateway does it. */
  function streamReply(sessionKey: string, reply: Reply): void {
    let at = 250
    const step = (ms: number, fn: () => void): void => {
      at += ms
      later(at, fn)
    }
    step(0, () => emit('agent.status', { sessionKey, status: 'thinking' }))
    if (reply.tool) {
      const tool = reply.tool
      step(500, () => {
        emit('agent.status', { sessionKey, status: 'tool_use', toolName: tool.name })
        emit('agent.stream', {
          sessionKey,
          event: { type: 'content_block_start', content_block: { type: 'tool_use', id: tool.id, name: tool.name } },
        })
        emit('agent.stream', {
          sessionKey,
          event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } },
        })
      })
      step(700, () => emit('agent.tool_result', { sessionKey, tool_use_id: tool.id, content: tool.output }))
    }
    step(400, () => {
      emit('agent.status', { sessionKey, status: 'responding' })
      emit('agent.stream', { sessionKey, event: { type: 'content_block_start', content_block: { type: 'text' } } })
    })
    const words = reply.text.split(/(?<=\s)/)
    for (let i = 0; i < words.length; i += 3) {
      const chunk = words.slice(i, i + 3).join('')
      step(60, () => emit('agent.stream', { sessionKey, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } }))
    }
    step(150, () => emit('agent.result', { sessionKey, sessionId: sid(sessionKey), usage: { total_cost_usd: 0.0187 }, timestamp: now() }))
  }

  const bySessionKey = (key: string): StoredSession | undefined =>
    sessions.find((s) => `${s.channel}:${s.chatType}:${s.chatId}` === key)

  async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'sessions.list':
        return sessions.map((s) => ({ ...s, name: names[s.id] ?? s.name, model: models[s.id] ?? s.model }))
      case 'sessions.get': {
        const s = sessions.find((x) => x.id === params.sessionId)
        const key = s ? `${s.channel}:${s.chatType}:${s.chatId}` : ''
        return { messages: history[key] ?? [] }
      }
      case 'remote.pins.list':
        return pins
      case 'remote.pins.set': {
        const id = String(params.id ?? '')
        const has = pins.some((p) => p.id === id)
        if (params.pinned && !has) pins = [{ id, pinnedAt: now() }, ...pins]
        else if (!params.pinned) pins = pins.filter((p) => p.id !== id)
        return { pins }
      }
      case 'sessions.rename':
        names = { ...names, [String(params.sessionId)]: String(params.name ?? '') }
        return { ok: true }
      case 'sessions.setModel':
      case 'agent.setModel': {
        const id = String(params.sessionId ?? (params.sessionKey ? bySessionKey(String(params.sessionKey))?.id : '') ?? '')
        if (id && params.model) models = { ...models, [id]: String(params.model) }
        return { ok: true, live: false }
      }
      case 'agent.abort':
      case 'agent.interrupt':
        return { ok: true }
      case 'tool.pending':
        return approvalOpen ? [{ requestId: approval.requestId, toolName: approval.toolName, input: approval.input }] : []
      case 'tool.approve':
      case 'tool.deny': {
        if (!approvalOpen || params.requestId !== approval.requestId) throw new Error('No pending approval for that request')
        approvalOpen = false
        const approved = method === 'tool.approve'
        emit('agent.tool_approval_resolved', { requestId: approval.requestId })
        const r = REPLIES[DEMO_KEYS.checkout]!
        streamReply(DEMO_KEYS.checkout, approved ? r.approved : r.denied)
        return { ok: true }
      }
      case 'chat.answerQuestion': {
        if (!questionOpen || params.requestId !== question.requestId) throw new Error('No pending question for that request')
        questionOpen = false
        const answers = (params.answers ?? {}) as Record<string, string>
        const answer = Object.values(answers)[0] ?? 'the team'
        emit('agent.question_state', { requestId: question.requestId, sessionKey: DEMO_KEYS.release, status: 'answered' })
        streamReply(DEMO_KEYS.release, REPLIES[DEMO_KEYS.release]!.answered!(answer))
        return { ok: true }
      }
      case 'chat.send': {
        const key = String(params.sessionKey ?? '')
        if (!bySessionKey(key)) throw new Error('Unknown session')
        emit('agent.user_message', { sessionKey: key, prompt: String(params.prompt ?? ''), timestamp: now() })
        streamReply(key, {
          text: 'This is the demo, so I can only play back canned replies. Pair with your Mac to talk to your real dorabot.',
        })
        return { ok: true }
      }
      default:
        throw new Error(`"${method}" is not available in the demo.`)
    }
  }

  const client: ClientLike = {
    state,
    connect() {
      if (state === 'ready') return
      setState('connecting')
      later(0, () => {
        setState('ready')
        const device: DeviceSummary = {
          id: 'demo-device',
          name: 'This phone (demo)',
          platform: 'ios',
          scopes: DEMO_SCOPES,
          createdAt: t0,
          lastSeenAt: t0,
          revoked: false,
          fingerprint: 'demo',
        }
        const host: HostSummary = { id: 'demo-host', name: DEMO_HOST_NAME, fingerprint: 'demo', version: 'demo' }
        handlers.onReady({ host, device, gatewayConnected: true })
        // What a real subscribe delivers: the live approval and question.
        later(0, () => {
          if (approvalOpen) emit('agent.tool_approval', approval)
          if (questionOpen) emit('agent.ask_user', question)
        })
      })
    },
    disconnect() {
      clearTimers()
      if (state !== 'idle') setState('idle')
    },
    forceReconnect() {
      client.disconnect()
      client.connect()
    },
    checkAlive() {},
    setNetworkType() {},
    async rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
      if (state !== 'ready') throw new Error('Not connected.')
      return (await handle(method, (params ?? {}) as Record<string, unknown>)) as T
    },
    async subscribe() {},
    can: (method) => ALLOWED.includes(method),
  }
  return client
}
