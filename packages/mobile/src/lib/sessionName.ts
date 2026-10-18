import type { StoredSession } from '@dorabot-remote/protocol'

/** A name a person recognises for a session key, from the stored list when we have it. */
export function sessionLabel(sessions: StoredSession[], key: string | null): string {
  if (!key) return 'Unknown session'
  const s = sessions.find((x) => x.channel && x.chatType && x.chatId && `${x.channel}:${x.chatType}:${x.chatId}` === key)
  if (s?.name || s?.senderName) return (s.name || s.senderName)!
  const [channel, , chatId] = key.split(':')
  if (channel === 'bg') return 'Background run'
  return `${channel ?? 'session'} · ${(chatId ?? '').slice(0, 8)}`
}
