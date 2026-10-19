import { describe, expect, it } from 'vitest'
import { ASK_TTL_MS, AppLinkQueue, MAX_PROMPT, nextAskStep, parseAppLink, resolveHost, type AskStepInput } from './applink.js'

describe('parseAppLink', () => {
  it('parses an ask with prompt, host and nonce (percent-encoding, plus, ampersand)', () => {
    expect(parseAppLink('dorabot-remote://ask?prompt=fix%20the%20build%20%26%20c%2B%2B&host=Studio%20Mac&n=AB-12')).toEqual({
      type: 'ask',
      prompt: 'fix the build & c++',
      host: 'Studio Mac',
      nonce: 'AB-12',
    })
  })
  it('host and nonce are optional; the prompt is trimmed', () => {
    expect(parseAppLink('dorabot-remote://ask?prompt=%20%20hi%20%20')).toEqual({ type: 'ask', prompt: 'hi' })
  })
  it('rejects an empty or missing prompt, an oversized prompt or host, and strips control characters', () => {
    expect(parseAppLink('dorabot-remote://ask')).toBeNull()
    expect(parseAppLink('dorabot-remote://ask?prompt=%20%20')).toBeNull()
    expect(parseAppLink(`dorabot-remote://ask?prompt=${'a'.repeat(MAX_PROMPT + 1)}`)).toBeNull()
    expect(parseAppLink(`dorabot-remote://ask?prompt=x&host=${'h'.repeat(81)}`)).toBeNull()
    expect(parseAppLink('dorabot-remote://ask?prompt=a%00b%07c')).toEqual({ type: 'ask', prompt: 'abc' })
    expect(parseAppLink('dorabot-remote://ask?prompt=a%0Ab')).toEqual({ type: 'ask', prompt: 'a\nb' })
  })
  it('ignores a malformed nonce rather than trusting it', () => {
    expect(parseAppLink('dorabot-remote://ask?prompt=x&n=../etc')).toEqual({ type: 'ask', prompt: 'x' })
  })
  it('parses inbox, and rejects pair links, other schemes and junk', () => {
    expect(parseAppLink('dorabot-remote://inbox?n=1')).toEqual({ type: 'inbox', nonce: '1' })
    expect(parseAppLink('dorabot-remote://inbox')).toEqual({ type: 'inbox' })
    expect(parseAppLink('dorabot-remote://pair#abc')).toBeNull()
    expect(parseAppLink('https://example.com/ask?prompt=x')).toBeNull()
    expect(parseAppLink('dorabot-remote://delete?prompt=x')).toBeNull()
    expect(parseAppLink('not a url')).toBeNull()
  })
})

describe('AppLinkQueue', () => {
  const ask = (prompt: string, nonce?: string) => ({ type: 'ask' as const, prompt, ...(nonce ? { nonce } : {}) })

  it('is FIFO and holds requests until taken', () => {
    const q = new AppLinkQueue()
    q.push(ask('one'), 0, false)
    q.push(ask('two'), 0, false)
    expect(q.peek()?.link).toEqual(ask('one'))
    expect(q.shift()?.link).toEqual(ask('one'))
    expect(q.shift()?.link).toEqual(ask('two'))
    expect(q.shift()).toBeNull()
  })
  it('ignores a replay of the same nonce (cold-launch URL delivered twice), even after it ran', () => {
    const q = new AppLinkQueue()
    expect(q.push(ask('x', 'n1'), 0, false)).toBe(true)
    expect(q.push(ask('x', 'n1'), 0, false)).toBe(false)
    q.shift()
    expect(q.push(ask('x', 'n1'), 0, false)).toBe(false)
    expect(q.push(ask('x', 'n2'), 0, false)).toBe(true)
  })
  it('requests without a nonce are never deduped', () => {
    const q = new AppLinkQueue()
    expect(q.push(ask('x'), 0, false) && q.push(ask('x'), 0, false)).toBe(true)
  })
  it('keeps only the newest few so a stuck app cannot pile up prompts', () => {
    const q = new AppLinkQueue(2)
    q.push(ask('a'), 0, false)
    q.push(ask('b'), 0, false)
    q.push(ask('c'), 0, false)
    expect(q.size).toBe(2)
    expect(q.peek()?.link).toEqual(ask('b'))
  })
})

describe('resolveHost', () => {
  const hosts = [
    { hostId: 'a', hostName: 'Studio Mac', alias: 'Studio' },
    { hostId: 'b', hostName: 'Laptop' },
    { hostId: 'c', hostName: 'Studio Mini' },
  ]
  it('matches nickname or Mac name exactly, case-insensitively', () => {
    expect(resolveHost(hosts, 'studio')?.hostId).toBe('a')
    expect(resolveHost(hosts, 'STUDIO MAC')?.hostId).toBe('a')
    expect(resolveHost(hosts, 'laptop')?.hostId).toBe('b')
  })
  it('accepts a unique partial match and refuses an ambiguous or unknown one', () => {
    expect(resolveHost(hosts, 'lap')?.hostId).toBe('b')
    expect(resolveHost(hosts, 'studio m')).toBeNull() // Studio Mac vs Studio Mini
    expect(resolveHost(hosts, 'nope')).toBeNull()
    expect(resolveHost(hosts, '  ')).toBeNull()
  })
})

describe('nextAskStep', () => {
  const hosts = [
    { hostId: 'a', hostName: 'Studio' },
    { hostId: 'b', hostName: 'Laptop' },
  ]
  const base: AskStepInput = {
    prompt: 'do it',
    at: 1000,
    arrivedLocked: false,
    now: 2000,
    ready: true,
    hosts,
    activeHostId: 'a',
    connState: 'ready',
    hasChatScope: true,
    appLocked: false,
    lockEnabled: false,
    verified: false,
  }
  const step = (o: Partial<AskStepInput>) => nextAskStep({ ...base, ...o })

  it('sends on the active Mac when everything is ready', () => {
    expect(step({})).toEqual({ do: 'send', hostId: 'a' })
  })
  it('queues until pairings are restored, the lock is cleared, and the link is up', () => {
    expect(step({ ready: false })).toEqual({ do: 'wait' })
    expect(step({ appLocked: true, lockEnabled: true })).toEqual({ do: 'wait' })
    expect(step({ connState: 'connecting' })).toEqual({ do: 'wait' })
    expect(step({ connState: 'handshaking' })).toEqual({ do: 'wait' })
  })
  it('requires Face ID first when the lock is on, unless it was just done at the lock screen', () => {
    expect(step({ lockEnabled: true })).toEqual({ do: 'verify' })
    expect(step({ lockEnabled: true, verified: true })).toEqual({ do: 'send', hostId: 'a' })
    expect(step({ lockEnabled: true, arrivedLocked: true })).toEqual({ do: 'send', hostId: 'a' })
    expect(step({ lockEnabled: false })).toEqual({ do: 'send', hostId: 'a' })
  })
  it('never verifies or sends before Face ID on a locked app', () => {
    expect(step({ lockEnabled: true, appLocked: true, connState: 'ready' }).do).toBe('wait')
  })
  it('switches to a named Mac first, then sends once it is connected', () => {
    expect(step({ host: 'laptop' })).toEqual({ do: 'switch', hostId: 'b' })
    expect(step({ host: 'laptop', activeHostId: 'b', connState: 'connecting' })).toEqual({ do: 'wait' })
    expect(step({ host: 'laptop', activeHostId: 'b' })).toEqual({ do: 'send', hostId: 'b' })
  })
  it('drops with a message for an unknown Mac, no pairings, a missing scope, or a stale request', () => {
    expect(step({ host: 'nope' })).toMatchObject({ do: 'drop', message: expect.stringContaining('nope') })
    expect(step({ hosts: [] })).toMatchObject({ do: 'drop' })
    expect(step({ hasChatScope: false })).toMatchObject({ do: 'drop' })
    expect(step({ now: base.at + ASK_TTL_MS + 1 })).toMatchObject({ do: 'drop' })
  })
  it('falls back to the first Mac when none is active yet', () => {
    expect(step({ activeHostId: null })).toEqual({ do: 'switch', hostId: 'a' })
  })
})
