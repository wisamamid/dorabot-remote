/**
 * Apple Watch bridge (native plugin `WatchBridge`, ios/App/App/WatchBridgePlugin.swift): pushes the
 * Inbox snapshot to the watch and delivers the watch's approve / deny requests back to JS. A no-op off
 * iOS. Same rule as platform.ts: the plugin proxy is a thenable, so it is a module-level constant
 * used inside these functions and never returned or resolved.
 */
import { registerPlugin } from '@capacitor/core'
import { isNative, platformName } from './platform.js'
import type { WatchReply, WatchRequest, WatchSnapshot } from './watch-logic.js'

const supported = isNative && platformName === 'ios'

interface WatchBridgePlugin {
  sendSnapshot(opts: { json: string }): Promise<void>
  reply(opts: { id: string; ok: boolean; message: string }): Promise<void>
  addListener(
    event: 'watchRequest',
    cb: (e: { id: string; action: string; rid?: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

const Native = registerPlugin<WatchBridgePlugin>('WatchBridge')

let last = ''

/** Send the watch the current list. Skips an unchanged list (the timestamp is not part of the comparison). */
export async function publishWatchSnapshot(snap: WatchSnapshot): Promise<void> {
  if (!supported) return
  const key = JSON.stringify(snap.items)
  if (key === last) return
  last = key
  try {
    await Native.sendSnapshot({ json: JSON.stringify(snap) })
  } catch {
    last = ''
  }
}

/** Listen for requests from the watch. `handler` returns the reply that goes back to the wrist. */
export function onWatchRequest(handler: (req: WatchRequest) => Promise<WatchReply>): () => void {
  if (!supported) return () => {}
  let removed = false
  let sub: { remove: () => Promise<void> } | null = null
  void (async () => {
    const s = await Native.addListener('watchRequest', (e) => {
      void (async () => {
        const reply = await handler({ action: e.action as WatchRequest['action'], ...(e.rid ? { rid: e.rid } : {}) })
        try {
          await Native.reply({ id: e.id, ok: reply.ok, message: reply.message })
        } catch {
          // The native side already answered "timed out".
        }
      })()
    })
    if (removed) void s.remove()
    else sub = s
  })()
  return () => {
    removed = true
    void sub?.remove()
  }
}

/** Empty list for the watch: nothing paired (or wiped), so no command text stays on the wrist. */
export async function clearWatchSnapshot(): Promise<void> {
  last = ''
  if (!supported) return
  try {
    await Native.sendSnapshot({ json: JSON.stringify({ items: [], at: Date.now() }) })
  } catch {
    // best effort
  }
}
