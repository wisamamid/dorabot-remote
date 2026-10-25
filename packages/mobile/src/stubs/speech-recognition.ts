/**
 * Stub module for @capacitor-community/speech-recognition.
 * The actual plugin is only available at native runtime via Capacitor.
 * This stub allows the bundle to build successfully; the real plugin
 * is loaded via dynamic import inside isNative guards at runtime.
 */

export const SpeechRecognition = {
  available: async () => ({ available: false }),
  start: async () => {},
  stop: async () => ({ transcript: '' }),
}
