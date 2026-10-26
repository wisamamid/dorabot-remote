import { describe, expect, it } from 'vitest'
import { ASK_TTL_MS, AppLinkQueue, MAX_PROMPT, nextAskStep, parseAppLink, parseShareLink, resolveHost, type AskStepInput } from './applink.js'

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
    q.push(ask('one'), 0)
    q.push(ask('two'), 0)
    expect(q.peek()?.link).toEqual(ask('one'))
    expect(q.shift()?.link).toEqual(ask('one'))
    expect(q.shift()?.link).toEqual(ask('two'))
    expect(q.shift()).toBeNull()
  })
  it('ignores a replay of the same nonce (cold-launch URL delivered twice), even after it ran', () => {
    const q = new AppLinkQueue()
    expect(q.push(ask('x', 'n1'), 0)).toBe(true)
    expect(q.push(ask('x', 'n1'), 0)).toBe(false)
    q.shift()
    expect(q.push(ask('x', 'n1'), 0)).toBe(false)
    expect(q.push(ask('x', 'n2'), 0)).toBe(true)
  })
  it('requests without a nonce are never deduped', () => {
    const q = new AppLinkQueue()
    expect(q.push(ask('x'), 0) && q.push(ask('x'), 0)).toBe(true)
  })
  it('keeps only the newest few so a stuck app cannot pile up prompts', () => {
    const q = new AppLinkQueue(2)
    q.push(ask('a'), 0)
    q.push(ask('b'), 0)
    q.push(ask('c'), 0)
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
    now: 2000,
    ready: true,
    hosts,
    activeHostId: 'a',
    connState: 'ready',
    hasChatScope: true,
    appLocked: false,
    confirmed: false,
  }
  const step = (o: Partial<AskStepInput>) => nextAskStep({ ...base, ...o })

  it('never sends without confirmation: it asks, with the full prompt target Mac', () => {
    expect(step({})).toEqual({ do: 'confirm', hostId: 'a', hostName: 'Studio' })
    expect(step({ host: 'laptop' })).toEqual({ do: 'confirm', hostId: 'b', hostName: 'Laptop' })
    // Not even when connected, scoped and the lock was just cleared.
    expect(step({ connState: 'ready', hasChatScope: true, appLocked: false }).do).toBe('confirm')
  })
  it('sends on the active Mac only once confirmed', () => {
    expect(step({ confirmed: true })).toEqual({ do: 'send', hostId: 'a' })
  })
  it('queues until pairings are restored, the lock is cleared, and the link is up', () => {
    expect(step({ ready: false })).toEqual({ do: 'wait' })
    expect(step({ appLocked: true })).toEqual({ do: 'wait' })
    expect(step({ connState: 'connecting', confirmed: true })).toEqual({ do: 'wait' })
    expect(step({ connState: 'handshaking', confirmed: true })).toEqual({ do: 'wait' })
  })
  it('unlocking is not consent: a locked app waits, and an unlocked one still confirms', () => {
    expect(step({ appLocked: true, confirmed: true }).do).toBe('wait')
    expect(step({ appLocked: false }).do).toBe('confirm')
  })
  it('does not switch Macs before the user confirmed', () => {
    expect(step({ host: 'laptop' }).do).toBe('confirm')
  })
  it('switches to a named Mac first, then sends once it is connected', () => {
    expect(step({ host: 'laptop', confirmed: true })).toEqual({ do: 'switch', hostId: 'b' })
    expect(step({ host: 'laptop', activeHostId: 'b', connState: 'connecting', confirmed: true })).toEqual({ do: 'wait' })
    expect(step({ host: 'laptop', activeHostId: 'b', confirmed: true })).toEqual({ do: 'send', hostId: 'b' })
  })
  it('drops with a message for an unknown Mac, no pairings, a missing scope, or a stale request', () => {
    expect(step({ host: 'nope' })).toMatchObject({ do: 'drop', message: expect.stringContaining('nope') })
    expect(step({ hosts: [] })).toMatchObject({ do: 'drop' })
    expect(step({ hasChatScope: false, confirmed: true })).toMatchObject({ do: 'drop' })
    expect(step({ now: base.at + ASK_TTL_MS + 1 })).toMatchObject({ do: 'drop' })
    // Once the user tapped Send, the TTL no longer applies.
    expect(step({ now: base.at + ASK_TTL_MS + 1, confirmed: true }).do).toBe('send')
  })
  it('falls back to the first Mac when none is active yet', () => {
    expect(step({ activeHostId: null, confirmed: true })).toEqual({ do: 'switch', hostId: 'a' })
  })
})

describe('parseShareLink', () => {
  it('accepts a share id and nothing else', () => {
    expect(parseShareLink('dorabot-remote://share?id=3F2A-11')).toBe('3F2A-11')
    expect(parseShareLink('dorabot-remote://share?id=../x')).toBeNull()
    expect(parseShareLink('dorabot-remote://share')).toBeNull()
    expect(parseShareLink('dorabot-remote://ask?id=abc')).toBeNull()
    expect(parseAppLink('dorabot-remote://share?id=abc')).toBeNull()
  })
})
