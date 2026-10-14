import type { StoredSession } from '@dorabot-remote/protocol'
import { useState, type ReactNode } from 'react'
import { keyOf, useConnection } from '../lib/connection.js'
import { haptic } from '../lib/platform.js'
import { Button, Card, Dot, Empty, Screen, Spinner, cx, timeAgo } from './ui.js'

/**
 * The home screen: every session dorabot knows about, newest first, with
 * anything that is waiting on you pulled to the top.
 */
export function SessionList({
  onOpen,
  onSettings,
}: {
  onOpen: (session: StoredSession | null, sessionKey: string) => void
  onSettings: () => void
}): ReactNode {
  const conn = useConnection()
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const waiting = new Map(conn.attention.map((a) => [a.sessionKey, a]))

  const rows = conn.sessions
    .map((s) => ({ session: s, key: keyOf(s) }))
    .filter((r): r is { session: StoredSession; key: string } => Boolean(r.key))

  rows.sort((a, b) => {
    const aw = waiting.has(a.key) ? 1 : 0
    const bw = waiting.has(b.key) ? 1 : 0
    if (aw !== bw) return bw - aw
    const ar = a.session.activeRun ? 1 : 0
    const br = b.session.activeRun ? 1 : 0
    if (ar !== br) return br - ar
    return (b.session.updatedAt ?? '').localeCompare(a.session.updatedAt ?? '')
  })

  async function startNew(): Promise<void> {
    const prompt = draft.trim()
    if (!prompt) return
    setSending(true)
    try {
      const res = await conn.rpc<{ sessionKey: string }>('chat.send', { prompt })
      await haptic('light')
      setDraft('')
      setComposing(false)
      await conn.refreshSessions()
      onOpen(null, res.sessionKey)
    } catch {
      setSending(false)
      return
    }
    setSending(false)
  }

  const statusTone =
    conn.state === 'ready' ? (conn.gatewayConnected ? 'good' : 'warn') : conn.state === 'disconnected' ? 'bad' : 'warn'
  const statusLabel =
    conn.state !== 'ready'
      ? conn.state === 'connecting' || conn.state === 'handshaking'
        ? 'connecting…'
        : 'offline'
      : conn.gatewayConnected
        ? conn.host?.name
        : 'dorabot not running'

  return (
    <Screen
      title="dorabot"
      subtitle={
        <span className="flex items-center gap-1.5">
          <Dot tone={statusTone} />
          {statusLabel}
        </span>
      }
      right={
        <button onClick={onSettings} className="-mr-2 flex size-9 items-center justify-center rounded-lg text-ink-300 active:bg-ink-800">
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.63.68 1.1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="scroll min-h-0 flex-1 px-3 py-3">
          {conn.sessionsLoading && rows.length === 0 ? (
            <div className="flex h-40 items-center justify-center">
              <Spinner className="size-6" />
            </div>
          ) : rows.length === 0 ? (
            <Empty
              title={conn.state === 'ready' ? 'No sessions yet' : 'Reconnecting'}
              body={
                conn.state === 'ready'
                  ? 'Start one from here, or from dorabot on your Mac.'
                  : 'Make sure the Mac is awake and the bridge is running.'
              }
              action={
                conn.state === 'ready' ? (
                  <Button variant="primary" onClick={() => setComposing(true)} className="mt-2 px-6">
                    New session
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-1.5">
              {rows.map(({ session, key }) => {
                const attn = waiting.get(key)
                return (
                  <button
                    key={key}
                    onClick={() => {
                      void haptic('light')
                      onOpen(session, key)
                    }}
                    className={cx(
                      'w-full rounded-card border px-3.5 py-3 text-left transition-colors active:bg-ink-800',
                      attn ? 'border-amber-glow/40 bg-amber-dim' : 'border-ink-700 bg-ink-850',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {session.activeRun && <span className="size-1.5 shrink-0 rounded-full bg-mint-500 breathe" />}
                      <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
                        {session.name || session.senderName || labelFor(key)}
                      </span>
                      <span className="shrink-0 text-[12.5px] text-ink-500">{timeAgo(session.updatedAt)}</span>
                    </div>
                    {attn ? (
                      <div className="mt-1 text-[13.5px] font-medium text-amber-glow">
                        {attn.kind === 'approval'
                          ? 'Waiting for your approval'
                          : attn.kind === 'question'
                            ? 'Asking you a question'
                            : 'Needs details'}
                      </div>
                    ) : (
                      session.preview && (
                        <div className="mt-0.5 line-clamp-2 text-[13.5px] leading-snug text-ink-400">
                          {session.preview}
                        </div>
                      )
                    )}
                    <div className="mt-1 flex items-center gap-2 text-[13px] text-ink-500">
                      <span className="font-mono">{session.channel ?? 'desktop'}</span>
                      <span>·</span>
                      <span>{session.messageCount} messages</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="safe-bottom shrink-0 border-t border-ink-700 bg-ink-900 px-3 pt-2.5">
          {composing ? (
            <Card className="space-y-2.5">
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                placeholder="What should dorabot do?"
                className="selectable w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5 leading-snug"
              />
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setComposing(false)} className="flex-1">
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => void startNew()} disabled={!draft.trim() || sending} className="flex-1">
                  {sending ? 'Starting…' : 'Start'}
                </Button>
              </div>
            </Card>
          ) : (
            <Button
              variant="default"
              onClick={() => setComposing(true)}
              disabled={conn.state !== 'ready'}
              className="w-full"
            >
              New session
            </Button>
          )}
        </div>
      </div>
    </Screen>
  )
}

function labelFor(key: string): string {
  const [channel, , chatId] = key.split(':')
  if (channel === 'bg') return 'Background run'
  return `${channel ?? 'session'} ${(chatId ?? '').slice(0, 6)}`
}
