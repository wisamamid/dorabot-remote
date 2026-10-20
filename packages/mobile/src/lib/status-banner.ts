import type { ConnectionState } from '@dorabot-remote/protocol'

export type Banner = { tone: 'warn' | 'bad' | 'good'; text: string } | null

/**
 * What the top-of-screen banner says. Stale data must never be silent: anything
 * other than a live link says so. A fresh relay connection is announced briefly.
 */
export function bannerFor(input: {
  state: ConnectionState
  online: boolean
  transport: 'lan' | 'relay' | null
  justReconnected: boolean
}): Banner {
  const { state, online, transport, justReconnected } = input
  if (state === 'pending' || state === 'idle') return null
  if (state === 'ready') {
    return justReconnected && transport === 'relay' ? { tone: 'good', text: 'Connected via relay' } : null
  }
  if (!online) return { tone: 'bad', text: 'Offline - showing saved data' }
  return { tone: 'warn', text: 'Reconnecting…' }
}
