/**
 * The only file that knows whether we are running natively or in a browser.
 *
 * Every Capacitor plugin is loaded lazily and behind a feature check, so the same
 * build runs as a plain web app during development (where you get a text field
 * instead of a camera) and as a native app on a phone.
 */
import { Capacitor } from '@capacitor/core'

export const isNative = Capacitor.isNativePlatform()
export const platformName = Capacitor.getPlatform()

// ---------------------------------------------------------------------------
// Persistence
//
// Native uses Capacitor Preferences, which on iOS is backed by UserDefaults.
// The device private key lives here, so on a real build this should move to the
// Keychain; see the note in README under "Before TestFlight".
// ---------------------------------------------------------------------------

export const storage = {
  async get(key: string): Promise<string | null> {
    if (!isNative) return localStorage.getItem(key)
    const { Preferences } = await import('@capacitor/preferences')
    const { value } = await Preferences.get({ key })
    return value ?? null
  },
  async set(key: string, value: string): Promise<void> {
    if (!isNative) {
      localStorage.setItem(key, value)
      return
    }
    const { Preferences } = await import('@capacitor/preferences')
    await Preferences.set({ key, value })
  },
  async remove(key: string): Promise<void> {
    if (!isNative) {
      localStorage.removeItem(key)
      return
    }
    const { Preferences } = await import('@capacitor/preferences')
    await Preferences.remove({ key })
  },
}

// ---------------------------------------------------------------------------
// Haptics
//
// Used sparingly and only where something happened that the user did not cause
// directly: an approval arriving, a question landing, a run finishing.
// ---------------------------------------------------------------------------

export async function haptic(style: 'light' | 'medium' | 'heavy' | 'success' | 'warning' = 'light'): Promise<void> {
  if (!isNative) return
  try {
    const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics')
    if (style === 'success') await Haptics.notification({ type: NotificationType.Success })
    else if (style === 'warning') await Haptics.notification({ type: NotificationType.Warning })
    else {
      const map = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy }
      await Haptics.impact({ style: map[style] })
    }
  } catch {
    // Haptics are a nicety; never let them break a flow.
  }
}

// ---------------------------------------------------------------------------
// QR scanning
// ---------------------------------------------------------------------------

export interface ScanResult {
  ok: boolean
  value?: string
  error?: string
}

export async function scanQr(): Promise<ScanResult> {
  if (!isNative) {
    return { ok: false, error: 'The camera is only available in the installed app. Paste the code instead.' }
  }
  try {
    const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import('@capacitor/barcode-scanner')
    const result = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: 'Point at the code on your Mac',
      scanText: 'Pair',
    })
    if (!result?.ScanResult) return { ok: false, error: 'No code found.' }
    return { ok: true, value: result.ScanResult }
  } catch (err) {
    const message = (err as Error).message ?? ''
    // The user backing out of the scanner is not an error worth shouting about.
    if (/cancel/i.test(message)) return { ok: false, error: '' }
    return { ok: false, error: message || 'Could not open the camera.' }
  }
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/**
 * Report the on-screen keyboard height so the composer can sit above it.
 * On the web this reads visualViewport, which behaves close enough for dev.
 */
export function watchKeyboard(onChange: (height: number) => void): () => void {
  if (isNative) {
    let cleanup: (() => void) | null = null
    void (async () => {
      const { Keyboard } = await import('@capacitor/keyboard')
      const show = await Keyboard.addListener('keyboardWillShow', (info) => onChange(info.keyboardHeight))
      const hide = await Keyboard.addListener('keyboardWillHide', () => onChange(0))
      cleanup = () => {
        void show.remove()
        void hide.remove()
      }
    })()
    return () => cleanup?.()
  }

  const vv = window.visualViewport
  if (!vv) return () => {}
  const handler = (): void => {
    onChange(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
  }
  vv.addEventListener('resize', handler)
  vv.addEventListener('scroll', handler)
  return () => {
    vv.removeEventListener('resize', handler)
    vv.removeEventListener('scroll', handler)
  }
}

/** Fired when the app returns to the foreground, so we can resync immediately. */
export function onAppResume(handler: () => void): () => void {
  if (!isNative) {
    const vis = (): void => {
      if (document.visibilityState === 'visible') handler()
    }
    document.addEventListener('visibilitychange', vis)
    return () => document.removeEventListener('visibilitychange', vis)
  }
  let cleanup: (() => void) | null = null
  void (async () => {
    const { App } = await import('@capacitor/app')
    const sub = await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) handler()
    })
    cleanup = () => void sub.remove()
  })()
  return () => cleanup?.()
}

/**
 * Pairing links opened from outside the app.
 *
 * The QR encodes a `dorabot-remote://pair#...` URL, so the phone's built-in
 * Camera app recognises it and offers to open this app directly. That removes a
 * step from the one flow every new user has to get through, and it means the
 * in-app scanner is a fallback rather than the only way in.
 */
export function onPairingUrl(handler: (url: string) => void): () => void {
  if (!isNative) {
    // During web development the same link can be passed as ?pair=<url>.
    const fromQuery = new URLSearchParams(location.search).get('pair')
    if (fromQuery) queueMicrotask(() => handler(fromQuery))
    return () => {}
  }
  let cleanup: (() => void) | null = null
  void (async () => {
    const { App } = await import('@capacitor/app')
    const sub = await App.addListener('appUrlOpen', ({ url }) => {
      if (url?.startsWith('dorabot-remote://')) handler(url)
    })
    // A cold launch from a link has already fired the event by the time we listen.
    const launch = await App.getLaunchUrl()
    if (launch?.url?.startsWith('dorabot-remote://')) handler(launch.url)
    cleanup = () => void sub.remove()
  })()
  return () => cleanup?.()
}

export async function setStatusBarDark(): Promise<void> {
  if (!isNative) return
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    await StatusBar.setStyle({ style: Style.Dark })
  } catch {
    // Android without the plugin, or a simulator quirk. Not worth surfacing.
  }
}

/** A device name the user will recognise in the Mac's device list. */
export function suggestDeviceName(): string {
  if (platformName === 'ios') return 'iPhone'
  if (platformName === 'android') return 'Android phone'
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android phone'
  return 'Browser'
}
