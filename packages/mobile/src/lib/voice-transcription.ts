/**
 * On-device voice transcription using @capacitor-community/speech-recognition.
 * Records audio while user holds the microphone button, transcribes on-device.
 *
 * Type declarations for the plugin are minimal since the package is optional
 * and loaded dynamically. TypeScript assumes any for dynamic imports.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionType = any

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin: any = await import('@capacitor-community/speech-recognition')
    const SpeechRecognition: SpeechRecognitionType = plugin.SpeechRecognition
    if (!SpeechRecognition) {
      supported = false
      return false
    }
    const result = await SpeechRecognition.available()
    supported = result?.available === true
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

  // Import plugin dynamically to avoid type errors when not available
  let SpeechRecognition: SpeechRecognitionType
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin: any = await import('@capacitor-community/speech-recognition')
    SpeechRecognition = plugin.SpeechRecognition
  } catch {
    throw new Error('Speech Recognition plugin not available')
  }

  let finished = false
  let finalText = ''

  // Set up the recognizer with options
  try {
    await SpeechRecognition.start({
      language: options.language || 'en-US',
      maxResults: options.maxResults || 5,
      partialResults: options.partialResults !== false,
    })
  } catch (err) {
    options.onError?.((err as Error).message || 'Failed to start recording')
    throw err
  }

  const stop = async (): Promise<string> => {
    if (finished) return finalText

    try {
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
