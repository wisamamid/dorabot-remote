import { describe, expect, it } from 'vitest'
import {
  AttachmentTooLargeError,
  COMPRESSION_STEPS,
  DEFAULT_IMAGE_PROMPT,
  MAX_EDGE,
  MAX_IMAGES,
  REQUEST_BUDGET_BYTES,
  buildChatSendParams,
  fitDimensions,
  fitImagesToBudget,
  requestBytes,
} from './attachments.js'

describe('fitDimensions', () => {
  it('scales the longest side down to the cap and keeps the aspect ratio', () => {
    expect(fitDimensions(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 })
    expect(fitDimensions(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 })
  })
  it('never upscales and never returns zero', () => {
    expect(fitDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 })
    expect(fitDimensions(10000, 1, 1600)).toEqual({ width: 1600, height: 1 })
    expect(fitDimensions(0, 0, 1600)).toEqual({ width: 1, height: 1 })
  })
})

describe('buildChatSendParams', () => {
  const img = { data: 'QUJD', mediaType: 'image/jpeg' }
  it('matches the gateway shape: images [{data, mediaType}] with raw base64', () => {
    const p = buildChatSendParams({ prompt: ' hi ', images: [img], sessionKey: 'desktop:dm:abc', chatId: 'abc' })
    expect(p).toEqual({
      prompt: 'hi',
      images: [{ data: 'QUJD', mediaType: 'image/jpeg' }],
      sessionKey: 'desktop:dm:abc',
      chatId: 'abc',
      source: 'remote/mobile',
    })
    expect((p.images as Array<{ data: string }>)[0]!.data.startsWith('data:')).toBe(false)
  })
  it('uses the desktop default prompt for a photo with no text, and omits images when there are none', () => {
    expect(buildChatSendParams({ prompt: '  ', images: [img], sessionKey: 'k' }).prompt).toBe(DEFAULT_IMAGE_PROMPT)
    const text = buildChatSendParams({ prompt: 'x', images: [], sessionKey: 'k' })
    expect('images' in text).toBe(false)
  })
})

describe('fitImagesToBudget', () => {
  const build = (images: Array<{ data: string; mediaType: string }>) =>
    buildChatSendParams({ prompt: 'look', images, sessionKey: 'desktop:dm:abc', chatId: 'abc' })

  it('keeps the best step when it already fits', async () => {
    const calls: Array<[number, number]> = []
    const out = await fitImagesToBudget(2, async (_i, edge, q) => {
      calls.push([edge, q])
      return 'A'.repeat(1000)
    }, build)
    expect(out).toHaveLength(2)
    expect(new Set(calls.map((c) => c.join(':')))).toEqual(new Set([`${MAX_EDGE}:${COMPRESSION_STEPS[0]!.quality}`]))
  })

  it('steps down until the whole request fits the budget', async () => {
    // payload shrinks with each step: 4 photos only fit at the third step
    const sizes = [300_000, 250_000, 150_000, 100_000, 50_000, 20_000]
    const out = await fitImagesToBudget(4, async (_i, edge, q) => {
      const step = COMPRESSION_STEPS.findIndex((s) => s.edge === edge && s.quality === q)
      return 'A'.repeat(sizes[step]!)
    }, build)
    expect(out[0]!.data.length).toBe(150_000)
    expect(requestBytes(build(out))).toBeLessThanOrEqual(REQUEST_BUDGET_BYTES)
  })

  it('refuses with a clear error when nothing fits', async () => {
    await expect(fitImagesToBudget(1, async () => 'A'.repeat(900_000), build)).rejects.toBeInstanceOf(AttachmentTooLargeError)
    await expect(fitImagesToBudget(1, async () => 'A'.repeat(900_000), build)).rejects.toThrow(/too large/)
  })

  it('refuses more than the image cap', async () => {
    await expect(fitImagesToBudget(MAX_IMAGES + 1, async () => 'A', build)).rejects.toThrow(/up to 4/)
  })

  it('keeps the encrypted, re-encoded frame under the relay limit at the budget', () => {
    expect(Math.ceil((REQUEST_BUDGET_BYTES * 4) / 3) + 1024).toBeLessThan(1024 * 1024)
  })
})
