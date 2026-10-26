import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as prompts from './saved-prompts.js'

const mockStorage = vi.hoisted(() => ({ data: {} as Record<string, string> }))

vi.mock('./platform.js', () => ({
  storage: {
    get: vi.fn((key: string) => Promise.resolve(mockStorage.data[key] ?? null)),
    set: vi.fn((key: string, value: string) => {
      mockStorage.data[key] = value
      return Promise.resolve()
    }),
    remove: vi.fn((key: string) => {
      delete mockStorage.data[key]
      return Promise.resolve()
    }),
  },
  isNative: false,
}))

describe('saved-prompts', () => {
  beforeEach(() => {
    mockStorage.data = {}
  })

  it('should return default prompts when storage is empty', async () => {
    const loaded = await prompts.loadPrompts('test-host')
    expect(loaded).toHaveLength(3)
    expect(loaded[0].title).toBe('Run the tests')
  })

  it('should save and load prompts', async () => {
    const prompt = { title: 'Custom', text: 'Custom text' }
    const added = await prompts.addPrompt('test-host', prompt)
    expect(added.id).toBeDefined()

    const loaded = await prompts.loadPrompts('test-host')
    expect(loaded.length).toBeGreaterThan(3)
    expect(loaded.find((p) => p.id === added.id)).toEqual(added)
  })

  it('should update a prompt', async () => {
    const added = await prompts.addPrompt('test-host', { title: 'Old', text: 'Old text' })
    await prompts.updatePrompt('test-host', added.id, { title: 'New', text: 'New text' })

    const loaded = await prompts.loadPrompts('test-host')
    const updated = loaded.find((p) => p.id === added.id)
    expect(updated?.title).toBe('New')
  })

  it('should remove a prompt', async () => {
    const added = await prompts.addPrompt('test-host', { title: 'Temp', text: 'Temp text' })
    await prompts.removePrompt('test-host', added.id)

    const loaded = await prompts.loadPrompts('test-host')
    expect(loaded.find((p) => p.id === added.id)).toBeUndefined()
  })

  it('should reorder prompts', async () => {
    const p1 = await prompts.addPrompt('test-host', { title: 'A', text: 'A' })
    const p2 = await prompts.addPrompt('test-host', { title: 'B', text: 'B' })

    await prompts.reorderPrompts('test-host', [p2.id, p1.id, '1', '2', '3'])
    const loaded = await prompts.loadPrompts('test-host')

    expect(loaded[0].id).toBe(p2.id)
    expect(loaded[1].id).toBe(p1.id)
  })

  it('prompts are kept per host', async () => {
    await prompts.addPrompt('mac-a', { title: 'Only A', text: 'a' })
    expect((await prompts.loadPrompts('mac-b')).find((p) => p.title === 'Only A')).toBeUndefined()
    expect(await prompts.loadPrompts('mac-b')).toHaveLength(3)
  })

  it('storageKey includes hostId', () => {
    const key = prompts.storageKey('my-mac')
    expect(key).toContain('my-mac')
    expect(key).toContain('v1')
  })
})
