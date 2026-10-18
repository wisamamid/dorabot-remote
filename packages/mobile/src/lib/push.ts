/**
 * Native push plumbing. Contentless pushes: the notification only says that
 * dorabot needs you; everything readable is fetched over the E2E channel after
 * the app opens. APNs is used directly (no Firebase SDK).
 *
 * Same rule as platform.ts: a Capacitor plugin proxy is a thenable, so it is
 * never returned from an async function. Every use goes through the plugin
 * module inside the function that needs it.
 */
import { isNative, platformName } from './platform.js'

export type PushPermission = 'prompt' | 'granted' | 'denied' | 'unsupported'

/** TestFlight and App Store builds use production APNs; Xcode debug installs need 'sandbox'. */
export const APNS_ENV: 'production' | 'sandbox' = import.meta.env.VITE_APNS_ENV === 'sandbox' ? 'sandbox' : 'production'

export const pushSupported = isNative && platformName === 'ios'

function mapPermission(p: string): PushPermission {
  if (p === 'granted') return 'granted'
  if (p === 'denied') return 'denied'
  return 'prompt'
}

export async function checkPushPermission(): Promise<PushPermission> {
  if (!pushSupported) return 'unsupported'
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    const r = await PushNotifications.checkPermissions()
    return mapPermission(r.receive)
  } catch {
    return 'unsupported'
  }
}

/** Ask iOS for permission (the system prompt) and, if granted, register with APNs. */
export async function enablePush(): Promise<PushPermission> {
  if (!pushSupported) return 'unsupported'
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    const r = await PushNotifications.requestPermissions()
    const p = mapPermission(r.receive)
    if (p === 'granted') await PushNotifications.register()
    return p
  } catch {
    return 'unsupported'
  }
}

/** Re-register on launch so a rotated token is noticed. Never prompts. */
export async function registerIfGranted(): Promise<PushPermission> {
  const p = await checkPushPermission()
  if (p !== 'granted') return p
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    await PushNotifications.register()
  } catch {
    // Registration failures surface through the registrationError listener.
  }
  return p
}

export interface PushNav {
  rid?: string
  kind?: string
}

let pendingNav: PushNav | null = null
const navListeners = new Set<(nav: PushNav) => void>()

/** A tap that arrives before the UI is listening (cold start) is held and delivered on subscribe. */
export function onPushNavigate(cb: (nav: PushNav) => void): () => void {
  navListeners.add(cb)
  if (pendingNav) {
    const nav = pendingNav
    pendingNav = null
    cb(nav)
  }
  return () => navListeners.delete(cb)
}

function emitNav(nav: PushNav): void {
  if (navListeners.size === 0) pendingNav = nav
  else for (const cb of navListeners) cb(nav)
}

/** Subscribe to APNs registration and notification taps. Returns an unsubscribe. */
export function listenPush(onToken: (token: string) => void, onError?: (msg: string) => void): () => void {
  if (!pushSupported) return () => {}
  let disposed = false
  const subs: Array<() => void> = []
  void (async () => {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    const add = async (fn: () => Promise<{ remove: () => Promise<void> }>): Promise<void> => {
      const h = await fn()
      if (disposed) void h.remove()
      else subs.push(() => void h.remove())
    }
    await add(() => PushNotifications.addListener('registration', (t) => onToken(t.value)))
    await add(() => PushNotifications.addListener('registrationError', (e) => onError?.(e.error)))
    // Foreground arrivals are ignored on purpose: the inbox already shows them live,
    // and Capacitor shows no system banner unless presentationOptions says so.
    await add(() =>
      PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
        const data = (a.notification?.data ?? {}) as { rid?: unknown; k?: unknown }
        emitNav({
          ...(typeof data.rid === 'string' ? { rid: data.rid } : {}),
          ...(typeof data.k === 'string' ? { kind: data.k } : {}),
        })
      }),
    )
  })().catch(() => {})
  return () => {
    disposed = true
    for (const s of subs) s()
  }
}

/** Clear delivered notifications once the user is looking at the inbox. */
export async function clearDeliveredNotifications(): Promise<void> {
  if (!pushSupported) return
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    await PushNotifications.removeAllDeliveredNotifications()
  } catch {
    // cosmetic
  }
}
