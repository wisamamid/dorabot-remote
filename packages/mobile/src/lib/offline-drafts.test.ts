import { beforeEach, describe, expect, it } from 'vitest'
import { DRAFT_AUTO_SEND_MS, MAX_DRAFTS, canAutoSend, clearDraftsForHost, getDraftsForSession, removeDraft, saveDraft } from './offline-drafts.js'

describe('offline drafts', () => {
  beforeEach(() => localStorage.clear())

  it('only returns drafts for the same Mac and session', async () => {
    await saveDraft('hostA', 'desktop:dm:1', 'one')
    await saveDraft('hostB', 'desktop:dm:1', 'two')
    expect((await getDraftsForSession('hostA', 'desktop:dm:1')).map((d) => d.content)).toEqual(['one'])
    expect((await getDraftsForSession('hostB', 'desktop:dm:1')).map((d) => d.content)).toEqual(['two'])
    expect(await getDraftsForSession('hostC', 'desktop:dm:1')).toEqual([])
  })

  it('stops auto-sending a stale draft', async () => {
    const d = await saveDraft('h', 's', 'x')
    expect(canAutoSend(d, d.timestamp + DRAFT_AUTO_SEND_MS)).toBe(true)
    expect(canAutoSend(d, d.timestamp + DRAFT_AUTO_SEND_MS + 1)).toBe(false)
    expect(canAutoSend(d, d.timestamp - 1)).toBe(false)
  })

  it('removes, clears per host, caps and ignores junk', async () => {
    const a = await saveDraft('h1', 's', 'a')
    await saveDraft('h2', 's', 'b')
    await removeDraft(a.id)
    expect(await getDraftsForSession('h1', 's')).toEqual([])
    await clearDraftsForHost('h2')
    expect(await getDraftsForSession('h2', 's')).toEqual([])
    for (let i = 0; i < MAX_DRAFTS + 5; i++) await saveDraft('h', 's', String(i))
    expect(await getDraftsForSession('h', 's')).toHaveLength(MAX_DRAFTS)
    localStorage.setItem('offline-drafts.v2', '{"not":"an array"}')
    expect(await getDraftsForSession('h', 's')).toEqual([])
  })
})
