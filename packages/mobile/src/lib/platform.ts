/**
 * The only file that knows whether we are running natively or in a browser.
 *
 * Every Capacitor plugin is loaded lazily and behind a feature check, so the same
 * build runs as a plain web app during development (where you get a text field
 * instead of a camera) and as a native app on a phone.
 */
import { Capacitor } from '@capacitor/core'
import { shouldReconnect, type NetStatus } from './network.js'

export const isNative = Capacitor.isNativePlatform()
export const platformName = Capacitor.getPlatform()

// ---------------------------------------------------------------------------
// Persistence
//
// Secrets (the device private key lives inside the pairing record) go to
// hardware-backed storage on native: the iOS Keychain, readable after first
// unlock and never synced or backed up off the device, so background push
// handling can read it later; on Android an AES-GCM key held in the Android
// Keystore. Everything else (cursors, UI state) stays in Capacitor Preferences.
//
// On the web / PWA there is no hardware-backed store, so everything stays in
// localStorage. That is a development convenience, not a security boundary.
//
// Callers do not choose: keys matching SECRET_KEY below are routed to the secure
// store automatically, so the public API is the same get/set/remove as before.
// ---------------------------------------------------------------------------

export const SECRET_KEY = /\.(pairings?|secret|applock)\./

// Capacitor plugin objects are Proxies that answer *any* property, including
// `then`. Returning one from an async function (or resolving a promise with it)
// makes the runtime treat it as a thenable and call `plugin.then(...)`, which
// Capacitor forwards to native as an unimplemented method: the promise then never
// settles. That hung app startup on a spinner. Plugins are therefore only ever
// passed around inside a plain wrapper object, never returned bare.
type SecurePlugin = (typeof import('@aparajita/capacitor-secure-storage'))['SecureStorage']
type PrefsPlugin = (typeof import('@capacitor/preferences'))['Preferences']

let secureReady: Promise<{ plugin: SecurePlugin }> | null = null

function secureStorage(): Promise<{ plugin: SecurePlugin }> {
  secureReady ??= (async () => {
    const { SecureStorage, KeychainAccess } = await import('@aparajita/capacitor-secure-storage')
    await SecureStorage.setKeyPrefix('dorabot-remote_')
    await SecureStorage.setSynchronize(false)
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlockThisDeviceOnly)
    return { plugin: SecureStorage }
  })()
  // A failed or hung init must not be cached forever.
  secureReady.catch(() => {
    secureReady = null
  })
  return secureReady
}

async function prefs(): Promise<{ plugin: PrefsPlugin }> {
  const { Preferences } = await import('@capacitor/preferences')
  return { plugin: Preferences }
}

export const NATIVE_STORAGE_TIMEOUT_MS = 3000

/** Rejects if a native storage call has not settled in time, so a hung plugin cannot block the UI. */
function withTimeout<T>(label: string, work: () => Promise<T>, ms = NATIVE_STORAGE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      secureReady = null
      reject(new Error(`Secure storage did not respond (${label}). Restart the app and try again.`))
    }, ms)
    work().then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export const storage = {
  get(key: string): Promise<string | null> {
    if (!isNative) return Promise.resolve(localStorage.getItem(key))
    return withTimeout(`get ${key}`, async () => {
      if (!SECRET_KEY.test(key)) {
        const { value } = await (await prefs()).plugin.get({ key })
        return value ?? null
      }

      const secure = (await secureStorage()).plugin
      const stored = await secure.getItem(key)
      if (stored !== null && stored !== undefined) return stored

      // One-time migration from builds that kept secrets in Preferences
      // (UserDefaults on iOS): copy into secure storage, then delete the old copy.
      const p = (await prefs()).plugin
      const { value } = await p.get({ key })
      if (value == null) return null
      await secure.setItem(key, value)
      await p.remove({ key })
      return value
    })
  },
  set(key: string, value: string): Promise<void> {
    if (!isNative) {
      localStorage.setItem(key, value)
      return Promise.resolve()
    }
    return withTimeout(`set ${key}`, async () => {
      if (!SECRET_KEY.test(key)) {
        await (await prefs()).plugin.set({ key, value })
        return
      }
      await (await secureStorage()).plugin.setItem(key, value)
      // Never leave a stale plaintext copy behind.
      await (await prefs()).plugin.remove({ key })
    })
  },
  remove(key: string): Promise<void> {
    if (!isNative) {
      localStorage.removeItem(key)
      return Promise.resolve()
    }
    return withTimeout(`remove ${key}`, async () => {
      if (SECRET_KEY.test(key)) {
        try {
          await (await secureStorage()).plugin.removeItem(key)
        } catch {
          // Nothing stored under that key.
        }
      }
      await (await prefs()).plugin.remove({ key })
    })
  },
  /** Delete everything this app stored (Keychain items under our prefix, Preferences, localStorage). Self-wipe only. */
  clearAll(): Promise<void> {
    if (!isNative) {
      localStorage.clear()
      return Promise.resolve()
    }
    return withTimeout('clear all', async () => {
      await (await secureStorage()).plugin.clear()
      await (await prefs()).plugin.clear()
    })
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

/**
 * Reserve the keyboard's height on the app shell (#root) through --kb so every
 * screen, including ones with plain text inputs, ends above the keyboard. Also
 * scrolls a focused field into view inside its scroll container, since the
 * webview itself never scrolls.
 */
export function initKeyboardInset(): () => void {
  const root = document.documentElement
  const stop = watchKeyboard((height) => {
    root.style.setProperty('--kb', `${Math.round(height)}px`)
    root.classList.toggle('kb-open', height > 0)
    // iOS can nudge the page itself to reveal a focused field; the shell already made room.
    window.scrollTo(0, 0)
  })
  const onFocus = (e: FocusEvent): void => {
    const el = e.target
    if (!(el instanceof HTMLElement) || !el.matches('input, textarea, [contenteditable="true"]')) return
    setTimeout(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 320)
  }
  document.addEventListener('focusin', onFocus)
  return () => {
    stop()
    document.removeEventListener('focusin', onFocus)
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
 * Fired when the network interface changes or returns (Wi-Fi off, cellular on,
 * and so on). Uses @capacitor/network natively and the `online` event on the web.
 */
export function onNetworkChange(handler: () => void, onStatus?: (status: NetStatus, prev: NetStatus | null) => void): () => void {
  const online = (): void => {
    onStatus?.({ connected: true, connectionType: 'unknown' }, null)
    handler()
  }
  window.addEventListener('online', online)
  if (!isNative) {
    onStatus?.({ connected: navigator.onLine, connectionType: 'unknown' }, null)
    return () => window.removeEventListener('online', online)
  }
  let cleanup: (() => void) | null = null
  let removed = false
  void (async () => {
    const { Network } = await import('@capacitor/network')
    let prev: NetStatus | null = null
    try {
      const s = await Network.getStatus()
      prev = { connected: s.connected, connectionType: s.connectionType }
      onStatus?.(prev, null)
    } catch {
      // The first change event seeds it instead.
    }
    const sub = await Network.addListener('networkStatusChange', (s) => {
      const next = { connected: s.connected, connectionType: s.connectionType }
      const was = prev
      prev = next
      onStatus?.(next, was)
      if (shouldReconnect(was, next)) handler()
    })
    if (removed) void sub.remove()
    else cleanup = () => void sub.remove()
  })()
  return () => {
    removed = true
    window.removeEventListener('online', online)
    cleanup?.()
  }
}

/** Fired when the app goes to the background (iOS then suspends it, freezing its sockets). */
export function onAppBackground(handler: () => void): () => void {
  if (!isNative) {
    const vis = (): void => {
      if (document.visibilityState === 'hidden') handler()
    }
    document.addEventListener('visibilitychange', vis)
    return () => document.removeEventListener('visibilitychange', vis)
  }
  let cleanup: (() => void) | null = null
  void (async () => {
    const { App } = await import('@capacitor/app')
    const sub = await App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) handler()
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
  return onAppUrl((url) => {
    // Only `dorabot-remote://pair...`; ask / inbox links go to onAppUrl's other consumer (lib/applink.ts).
    if (/^dorabot-remote:\/\/pair/i.test(url)) handler(url)
  }, 'pair')
}

/**
 * Every `dorabot-remote://` URL opened from outside the app, including a cold launch
 * from one. `webQueryParam` is the dev-only `?<name>=<url>` fallback in a browser.
 */
export function onAppUrl(handler: (url: string) => void, webQueryParam = 'pair'): () => void {
  if (!isNative) {
    const fromQuery = new URLSearchParams(location.search).get(webQueryParam)
    if (fromQuery) queueMicrotask(() => handler(fromQuery))
    return () => {}
  }
  let cleanup: (() => void) | null = null
  let removed = false
  void (async () => {
    const { App } = await import('@capacitor/app')
    const sub = await App.addListener('appUrlOpen', ({ url }) => {
      if (url?.startsWith('dorabot-remote://')) handler(url)
    })
    if (removed) {
      void sub.remove()
      return
    }
    // A cold launch from a link has already fired the event by the time we listen.
    const launch = await App.getLaunchUrl()
    if (launch?.url?.startsWith('dorabot-remote://')) handler(launch.url)
    cleanup = () => void sub.remove()
  })()
  return () => {
    removed = true
    cleanup?.()
  }
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
  if (platformName === 'ios') return Math.min(screen.width, screen.height) >= 700 ? 'iPad' : 'iPhone'
  if (platformName === 'android') return 'Android phone'
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android phone'
  return 'Browser'
}
