/**
 * Hold-to-talk dictation using the on-device iOS speech recognizer
 * (@capacitor-community/speech-recognition). The transcript only ever lands in the
 * composer draft; it is never sent automatically.
 *
 * Like every plugin in this app it is loaded lazily, behind an isNative guard, and
 * the plugin object is only passed around inside a `{ plugin }` wrapper (see the note
 * in platform.ts about Capacitor plugin proxies and `then`). On web and in demo mode
 * isVoiceSupported() is false, so the microphone button is never shown.
 */
import { isNative, platformName } from './platform.js'

export interface VoiceResult {
  text: string
  isFinal: boolean
}

export interface VoiceRecognitionOptions {
  language?: string
  maxResults?: number
  partialResults?: boolean
  onResult?: (result: VoiceResult) => void
  onError?: (error: string) => void
}

export interface RecordingHandle {
  stop(): Promise<string>
  cancel(): Promise<void>
}

type SpeechPlugin = (typeof import('@capacitor-community/speech-recognition'))['SpeechRecognition']

async function speech(): Promise<{ plugin: SpeechPlugin }> {
  const { SpeechRecognition } = await import('@capacitor-community/speech-recognition')
  return { plugin: SpeechRecognition }
}

let supported: boolean | null = null

export async function isVoiceSupported(): Promise<boolean> {
  if (supported !== null) return supported
  if (!isNative || platformName !== 'ios') {
    supported = false
    return false
  }
  try {
    const { plugin } = await speech()
    supported = (await plugin.available()).available === true
  } catch {
    supported = false
  }
  return supported
}

/** How long to wait after stop() for the recognizer's last partial result. */
const SETTLE_MS = 450

export async function recordVoice(options: VoiceRecognitionOptions = {}): Promise<RecordingHandle> {
  if (!isNative || platformName !== 'ios') throw new Error('Voice recording is only available on iOS.')
  const { plugin } = await speech()

  let perm = await plugin.checkPermissions()
  if (perm.speechRecognition !== 'granted') perm = await plugin.requestPermissions()
  if (perm.speechRecognition !== 'granted') {
    const msg = 'Allow Speech Recognition and Microphone for DoraBot Remote in Settings to dictate.'
    options.onError?.(msg)
    throw new Error(msg)
  }

  let finished = false
  let text = ''
  const handle = await plugin.addListener('partialResults', (data) => {
    const best = data.matches?.[0]
    if (finished && !best) return
    if (best) {
      text = best
      options.onResult?.({ text, isFinal: finished })
    }
  })
  const cleanup = async (): Promise<void> => {
    try {
      await handle.remove()
    } catch {
      // ignore
    }
  }

  try {
    await plugin.start({
      language: options.language || 'en-US',
      maxResults: options.maxResults || 1,
      partialResults: true,
      popup: false,
    })
  } catch (err) {
    await cleanup()
    const msg = (err as Error).message || 'Failed to start recording'
    options.onError?.(msg)
    throw err
  }

  return {
    async stop() {
      if (finished) return text
      finished = true
      try {
        await plugin.stop()
        await new Promise((r) => setTimeout(r, SETTLE_MS))
      } catch {
        // keep whatever was transcribed so far
      }
      await cleanup()
      return text
    },
    async cancel() {
      if (finished) return
      finished = true
      text = ''
      try {
        await plugin.stop()
      } catch {
        // ignore
      }
      await cleanup()
    },
  }
}
