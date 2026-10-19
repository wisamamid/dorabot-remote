import type { ImageAttachment } from '@dorabot-remote/protocol'

/** Most photos one message can carry. */
export const MAX_IMAGES = 4
/** Longest side of a sent photo, in pixels. */
export const MAX_EDGE = 1600
/**
 * Ceiling for the whole serialized `chat.send` request (JSON text, base64 images
 * included). The relay drops frames over 1 MiB, and encryption plus the second
 * base64 pass inflates the payload by about a third, so 700 KB of JSON lands near
 * 935 KB on the wire.
 */
export const REQUEST_BUDGET_BYTES = 700_000
/** What dorabot's desktop composer sends when there is a photo but no words. */
export const DEFAULT_IMAGE_PROMPT = 'What do you see in this image?'

/** Progressively smaller renditions, tried in order until the request fits. */
export const COMPRESSION_STEPS: ReadonlyArray<{ edge: number; quality: number }> = [
  { edge: MAX_EDGE, quality: 0.8 },
  { edge: MAX_EDGE, quality: 0.65 },
  { edge: 1280, quality: 0.6 },
  { edge: 1024, quality: 0.55 },
  { edge: 800, quality: 0.5 },
  { edge: 640, quality: 0.45 },
]

export class AttachmentTooLargeError extends Error {
  constructor() {
    super('These photos are too large to send. Try fewer photos, or smaller ones.')
    this.name = 'AttachmentTooLargeError'
  }
}

/** Scale (w,h) down so the longest side is at most `maxEdge`. Never upscales; never returns 0. */
export function fitDimensions(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (!(longest > 0)) return { width: 1, height: 1 }
  const scale = Math.min(1, maxEdge / longest)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export interface ChatSendInput {
  prompt: string
  images: ImageAttachment[]
  sessionKey: string
  chatId?: string
}

/**
 * The `chat.send` params, in the shape dorabot's gateway reads (`images` is
 * `[{ data: <raw base64, no data: prefix>, mediaType }]`). A photo with no text
 * gets the same default prompt the desktop sends, since the gateway rejects an
 * empty prompt.
 */
export function buildChatSendParams(input: ChatSendInput): Record<string, unknown> {
  const prompt = input.prompt.trim() || (input.images.length ? DEFAULT_IMAGE_PROMPT : '')
  return {
    prompt,
    ...(input.images.length ? { images: input.images.map((i) => ({ data: i.data, mediaType: i.mediaType })) } : {}),
    sessionKey: input.sessionKey,
    chatId: input.chatId,
    source: 'remote/mobile',
  }
}

/** UTF-8 byte size of the request as it will be serialized. */
export function requestBytes(params: unknown): number {
  return new TextEncoder().encode(JSON.stringify(params)).length
}

/**
 * Re-encode `count` photos at ever smaller sizes until the whole request fits the
 * budget. `encode(index, edge, quality)` returns raw base64 JPEG. Throws
 * AttachmentTooLargeError if even the smallest rendition does not fit.
 */
export async function fitImagesToBudget(
  count: number,
  encode: (index: number, edge: number, quality: number) => Promise<string>,
  build: (images: ImageAttachment[]) => Record<string, unknown>,
  budget = REQUEST_BUDGET_BYTES,
): Promise<ImageAttachment[]> {
  if (count > MAX_IMAGES) throw new Error(`You can attach up to ${MAX_IMAGES} photos.`)
  for (const step of COMPRESSION_STEPS) {
    const images: ImageAttachment[] = []
    for (let i = 0; i < count; i++) {
      images.push({ data: await encode(i, step.edge, step.quality), mediaType: 'image/jpeg' })
    }
    if (requestBytes(build(images)) <= budget) return images
  }
  throw new AttachmentTooLargeError()
}

/** Decode a File and re-encode it as JPEG; used by fitImagesToBudget. Bitmaps are decoded once per file. */
export function makeBrowserEncoder(files: File[]): { encode: (index: number, edge: number, quality: number) => Promise<string>; dispose: () => void } {
  const bitmaps = new Map<number, Promise<ImageBitmap>>()
  const load = (i: number): Promise<ImageBitmap> => {
    let p = bitmaps.get(i)
    if (!p) {
      p = createImageBitmap(files[i]!, { imageOrientation: 'from-image' })
      bitmaps.set(i, p)
    }
    return p
  }
  return {
    async encode(index, edge, quality) {
      const bmp = await load(index)
      const { width, height } = fitDimensions(bmp.width, bmp.height, edge)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Could not process the photo.')
      // JPEG has no alpha: flatten transparent PNGs onto white rather than black.
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(bmp, 0, 0, width, height)
      const url = canvas.toDataURL('image/jpeg', quality)
      const comma = url.indexOf(',')
      if (!url.startsWith('data:image/jpeg') || comma < 0) throw new Error('Could not process the photo.')
      return url.slice(comma + 1)
    },
    dispose() {
      for (const p of bitmaps.values()) void p.then((b) => b.close()).catch(() => {})
      bitmaps.clear()
    },
  }
}
