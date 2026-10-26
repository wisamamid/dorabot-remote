/**
 * App Group hand-offs with the Share Extension and the Widgets extension (native plugin
 * `AppGroup`, ios/App/App/AppGroupPlugin.swift): picking up what the user shared into the app,
 * feeding the home-screen widget, and the Live Activity for an active run. Everything is a no-op
 * off iOS (web, demo, tests).
 *
 * Same rule as platform.ts: the plugin proxy is a thenable, so it is a module-level constant
 * used inside these functions and never returned or resolved.
 */
import { registerPlugin } from '@capacitor/core'
import type { ImageAttachment } from '@dorabot-remote/protocol'
import { isNative, platformName } from './platform.js'

const supported = isNative && platformName === 'ios'
/** Android has no Share Extension; its plugin (android/.../AppGroupPlugin.java) only implements takeShare for SEND intents. */
const shareSupported = isNative && (platformName === 'ios' || platformName === 'android')

interface AppGroupPlugin {
  takeShare(opts: { id?: string }): Promise<{ found: boolean; id?: string; text?: string; images?: ImageAttachment[] }>
  writeSnapshot(opts: { hostName: string; pending: number }): Promise<void>
  reloadWidgets(): Promise<void>
  startRun(opts: { sessionName: string; status: string; startedAt: number }): Promise<{ started: boolean }>
  updateRun(opts: { status: string }): Promise<void>
  endRun(): Promise<void>
  wipe(opts: { shares: boolean }): Promise<void>
}

const Native = registerPlugin<AppGroupPlugin>('AppGroup')

export interface SharedContent {
  id: string
  text: string
  images: ImageAttachment[]
}

/** Read and delete a share left by the Share Extension (the newest one when `id` is omitted). */
export async function takeShare(id?: string): Promise<SharedContent | null> {
  if (!shareSupported) return null
  try {
    const r = await Native.takeShare(id ? { id } : {})
    if (!r?.found || !r.id) return null
    const images = (r.images ?? []).filter((i) => typeof i?.data === 'string' && i.mediaType === 'image/jpeg')
    const text = typeof r.text === 'string' ? r.text : ''
    return text || images.length ? { id: r.id, text, images } : null
  } catch {
    return null
  }
}

let lastSnapshot = ''

/** Tell the widget how many things wait on the user, and on which Mac. Skips unchanged values. */
export async function publishWidgetSnapshot(hostName: string, pending: number): Promise<void> {
  if (!supported) return
  const key = `${hostName}\n${pending}`
  if (key === lastSnapshot) return
  lastSnapshot = key
  try {
    await Native.writeSnapshot({ hostName, pending })
    await Native.reloadWidgets()
  } catch {
    lastSnapshot = ''
  }
}

export async function startRunActivity(sessionName: string, status: string, startedAt: number): Promise<void> {
  if (!supported) return
  try {
    await Native.startRun({ sessionName, status, startedAt })
  } catch {
    // Live Activities are a nicety; never surface a failure.
  }
}

export async function updateRunActivity(status: string): Promise<void> {
  if (!supported) return
  try {
    await Native.updateRun({ status })
  } catch {
    // ignore
  }
}

export async function endRunActivity(): Promise<void> {
  if (!supported) return
  try {
    await Native.endRun()
  } catch {
    // ignore
  }
}

/** Unpair / self-wipe: remove the widget snapshot and any Live Activity (and, for a self-wipe, pending shares), and refresh the widget. */
export async function wipeAppGroup(opts: { shares?: boolean } = {}): Promise<void> {
  lastSnapshot = ''
  if (!supported) return
  try {
    await Native.wipe({ shares: opts.shares === true })
  } catch {
    // best effort
  }
}
