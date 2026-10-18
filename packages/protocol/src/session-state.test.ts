import { describe, expect, it } from 'vitest'
import type { ChatItem } from './gateway.js'
import { SessionAggregator, mergeHistory } from './session-state.js'

const user = (content: string, timestamp = 1): ChatItem => ({ type: 'user', content, timestamp })
const text = (content: string, timestamp = 1): ChatItem => ({ type: 'text', content, timestamp })

describe('seq de-duplication', () => {
  it('ignores an event whose seq was already applied for that session', () => {
    const agg = new SessionAggregator()
    agg.apply('agent.user_message', { sessionKey: 's', prompt: 'hi' }, 5, 's')
    agg.apply('agent.user_message', { sessionKey: 's', prompt: 'hi' }, 5, 's')
    agg.apply('agent.user_message', { sessionKey: 's', prompt: 'old' }, 3, 's')
    expect(agg.get('s').chatItems).toHaveLength(1)
    expect(agg.cursor).toBe(5)
  })

  it('does not drop a lower seq for a different, newly followed session', () => {
    const agg = new SessionAggregator()
    agg.apply('agent.user_message', { sessionKey: 'a', prompt: 'x' }, 10, 'a')
    agg.apply('agent.user_message', { sessionKey: 'b', prompt: 'y' }, 4, 'b')
    expect(agg.get('b').chatItems).toHaveLength(1)
  })
})

describe('agent.user_message source', () => {
  it('renders each user message once, whatever its source', () => {
    const agg = new SessionAggregator()
    // the phone adds no optimistic item, so its own echo is the only copy
    agg.apply('agent.user_message', { sessionKey: 's', prompt: 'from phone', source: 'remote/mobile' }, 1, 's')
    agg.apply('agent.user_message', { sessionKey: 's', prompt: 'from desktop', source: 'desktop/chat' }, 2, 's')
    // a replayed echo (same seq) must not duplicate
    agg.apply('agent.user_message', { sessionKey: 's', prompt: 'from phone', source: 'remote/mobile' }, 1, 's')
    expect(agg.get('s').chatItems.map((i) => (i as { content: string }).content)).toEqual(['from phone', 'from desktop'])
  })
})

describe('mergeHistory', () => {
  it('does not duplicate live items already contained in history', () => {
    const history = [user('q'), text('a'), user('q2'), text('a2')]
    const live = [user('q2', 99), text('a2', 99)]
    expect(mergeHistory(history, live)).toEqual(history)
  })

  it('appends live items newer than history', () => {
    const history = [user('q'), text('a')]
    const live = [text('a', 9), user('q2', 9), { ...text('partial', 9), streaming: true }]
    expect(mergeHistory(history, live)).toEqual([...history, live[1], live[2]])
  })

  it('works with a truncated, newest-only history', () => {
    const history = [user('q3'), text('a3')]
    const live = [user('q1'), text('a1'), user('q3'), text('a3')]
    expect(mergeHistory(history, live)).toEqual(history)
  })

  it('keeps everything live when history is empty or unrelated', () => {
    expect(mergeHistory([], [user('x')])).toEqual([user('x')])
    expect(mergeHistory([user('h')], [user('x')])).toEqual([user('h'), user('x')])
  })
})
