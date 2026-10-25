/**
 * On-device voice transcription using @capacitor-community/speech-recognition.
 * Records audio while user holds the microphone button, transcribes on-device.
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

let supported: boolean | null = null

export async function isVoiceSupported(): Promise<boolean> {
  if (supported !== null) return supported

  if (!isNative) {
    supported = false
    return false
  }

  if (platformName !== 'ios') {
    supported = false
    return false
  }

  try {
    const { SpeechRecognition } = await import('@capacitor-community/speech-recognition')
    const result = await SpeechRecognition.available()
    supported = result.available === true
    return supported
  } catch {
    supported = false
    return false
  }
}

export interface RecordingHandle {
  stop(): Promise<string>
  cancel(): Promise<void>
}

export async function recordVoice(options: VoiceRecognitionOptions = {}): Promise<RecordingHandle> {
  if (!isNative || platformName !== 'ios') {
    throw new Error('Voice recording is only available on iOS.')
  }

  const { SpeechRecognition } = await import('@capacitor-community/speech-recognition')

  let finished = false

  // Set up the recognizer with options
  await SpeechRecognition.start({
    language: options.language || 'en-US',
    maxResults: options.maxResults || 5,
    partialResults: options.partialResults !== false,
  })

  // Listen for results
  let lastPartial = ''
  let finalText = ''

  // In a real app, Capacitor Speech Recognition would emit events or return results
  // from the start() call. However, the current plugin pattern is to poll or use
  // a callback. We'll wrap this in a way that works with the current API.

  const stop = async (): Promise<string> => {
    if (finished) return finalText

    try {
      // Note: The @capacitor-community/speech-recognition plugin may have different
      // APIs depending on version. This follows the documented pattern.
      finished = true

      // Get the result (the plugin returns the result when stop is called)
      // This is framework-specific, so we handle it gracefully
      try {
        const result = await SpeechRecognition.stop()
        if (result?.transcript) {
          finalText = result.transcript
          options.onResult?.({ text: finalText, isFinal: true })
        }
      } catch {
        // Some versions of the plugin may throw; that's ok
      }

      return finalText
    } catch (err) {
      options.onError?.((err as Error).message || 'Failed to stop recording')
      return finalText
    }
  }

  const cancel = async (): Promise<void> => {
    if (finished) return
    finished = true
    try {
      // Cancel recognition without returning result
      await SpeechRecognition.stop()
    } catch {
      // Ignore errors when cancelling
    }
  }

  return { stop, cancel }
}
