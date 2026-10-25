/**
 * Type declarations for @capacitor-community/speech-recognition
 * This is an optional plugin only used on native iOS.
 */

declare module '@capacitor-community/speech-recognition' {
  export interface SpeechRecognitionOptions {
    language?: string
    maxResults?: number
    partialResults?: boolean
  }

  export interface SpeechRecognitionResult {
    transcript?: string
    isFinal?: boolean
  }

  export interface AvailabilityResult {
    available?: boolean
  }

  export const SpeechRecognition: {
    start(options: SpeechRecognitionOptions): Promise<void>
    stop(): Promise<SpeechRecognitionResult>
    available(): Promise<AvailabilityResult>
  }
}
