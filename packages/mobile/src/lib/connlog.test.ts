import { beforeEach, describe, expect, it } from 'vitest'
import { CONNLOG_KEY, CONNLOG_MAX, connLog, flushConnLog, formatConnLog, getEntries, loadConnLog, resetConnLogForTests, setConnMeta } from './connlog.js'

beforeEach(() => {
  localStorage.clear()
  resetConnLogForTests()
})

describe('connlog', () => {
  it('keeps only the last CONNLOG_MAX entries', () => {
    for (let i = 0; i < CONNLOG_MAX + 25; i++) connLog('client', `e${i}`)
    const list = getEntries()
    expect(list.length).toBe(CONNLOG_MAX)
    expect(list[0]!.m).toBe('e25')
  })

  it('survives a relaunch', async () => {
    connLog('net', 'cellular')
    await flushConnLog()
    resetConnLogForTests()
    expect(getEntries().length).toBe(0)
    await loadConnLog()
    expect(getEntries().map((e) => e.m)).toEqual(['cellular'])
    expect(localStorage.getItem(CONNLOG_KEY)).toContain('cellular')
  })

  it('formats newest first with a header', () => {
    setConnMeta({ netType: 'cellular', relayUrl: 'wss://r.test', relayId: 'abc123' })
    connLog('client', 'first')
    connLog('client', 'second')
    const text = formatConnLog()
    expect(text).toContain('relay: wss://r.test id=abc123')
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('first'))
  })
})
