import type { StoredSession } from '@dorabot-remote/protocol'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic, watchKeyboard } from '../lib/platform.js'
import { ChatItemList, StatusLine } from './ChatItems.js'
import { ApprovalCard, ElicitationCard, QuestionCard } from './Interrupts.js'
import { Button, Dot, Screen, cx } from './ui.js'

/**
 * One conversation: the stream, anything blocking it, and a composer.
 *
 * Scroll behaviour is the fiddly part. We stick to the bottom while the user is
 * already near it, and leave them alone the moment they scroll up to read
 * something, which is constantly the case while a long tool output streams in.
 */
export function SessionView({
  session,
  sessionKey,
  onBack,
}: {
  session: StoredSession | null
  sessionKey: string
  onBack: () => void
}): ReactNode {
  const conn = useConnection()
  const state = conn.getSession(sessionKey)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [keyboard, setKeyboard] = useState(0)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void conn.openSession(sessionKey, session?.id)
    conn.clearAttention(sessionKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, session?.id])

  useEffect(() => watchKeyboard(setKeyboard), [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [conn.revision, keyboard])

  function onScroll(): void {
    const el = scrollRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
  }

  const busy = state.status !== 'idle'
  const blocked = state.pendingApproval ?? state.pendingQuestion ?? state.pendingElicitation

  async function send(): Promise<void> {
    const prompt = draft.trim()
    if (!prompt || sending) return
    setSending(true)
    setError(null)
    stick.current = true
    try {
      await conn.rpc('chat.send', { prompt, sessionKey, chatId: session?.chatId })
      setDraft('')
      await haptic('light')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  async function interrupt(): Promise<void> {
    await haptic('medium')
    try {
      await conn.rpc('agent.interrupt', { sessionKey })
    } catch {
      // Not every provider supports interrupt; abort always works.
      try {
        await conn.rpc('agent.abort', { sessionKey })
      } catch (err) {
        setError((err as Error).message)
      }
    }
  }

  const title = session?.name || session?.senderName || prettyKey(sessionKey)

  return (
    <Screen
      title={title}
      subtitle={<span className="font-mono text-[12.5px]">{session?.channel ?? sessionKey.split(':')[0]}</span>}
      onBack={onBack}
      right={
        busy ? (
          <Button variant="ghost" onClick={() => void interrupt()} className="px-3 text-[14px] text-amber-glow">
            Stop
          </Button>
        ) : (
          <Dot tone={conn.state === 'ready' ? (conn.gatewayConnected ? 'good' : 'warn') : 'bad'} />
        )
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div ref={scrollRef} onScroll={onScroll} className="scroll min-h-0 flex-1 px-3 py-3">
          {state.chatItems.length === 0 ? (
            <div className="flex h-full items-center justify-center px-8 text-center text-[14px] leading-relaxed text-ink-500">
              Nothing here yet. Send a message to start.
            </div>
          ) : (
            <ChatItemList items={state.chatItems} />
          )}
          <StatusLine status={state.status} detail={state.statusDetail} />
        </div>

        {blocked && (
          <div className="shrink-0 border-t border-ink-700 bg-ink-900 px-3 py-3">
            {state.pendingApproval && (
              <ApprovalCard
                approval={state.pendingApproval}
                onApprove={() => conn.rpc('tool.approve', { requestId: state.pendingApproval!.requestId })}
                onDeny={(reason) => conn.rpc('tool.deny', { requestId: state.pendingApproval!.requestId, reason })}
              />
            )}
            {!state.pendingApproval && state.pendingQuestion && (
              <QuestionCard
                question={state.pendingQuestion}
                onAnswer={(answers) =>
                  conn.rpc('chat.answerQuestion', { requestId: state.pendingQuestion!.requestId, answers })
                }
              />
            )}
            {!state.pendingApproval && !state.pendingQuestion && state.pendingElicitation && (
              <ElicitationCard
                elicitation={state.pendingElicitation}
                onSubmit={(values) =>
                  conn.rpc('chat.answerElicitation', {
                    elicitationId: state.pendingElicitation!.elicitationId,
                    values,
                    sessionKey,
                  })
                }
                onDismiss={() =>
                  conn.rpc('chat.dismissElicitation', {
                    elicitationId: state.pendingElicitation!.elicitationId,
                    sessionKey,
                  })
                }
              />
            )}
          </div>
        )}

        {error && (
          <div className="shrink-0 bg-rose-dim px-4 py-2 text-[13px] text-rose-glow" onClick={() => setError(null)}>
            {error}
          </div>
        )}

        <div
          className="safe-bottom shrink-0 border-t border-ink-700 bg-ink-900 px-3 pt-2.5"
          style={{ paddingBottom: keyboard > 0 ? keyboard + 10 : undefined }}
        >
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => {
                stick.current = true
              }}
              rows={1}
              placeholder={conn.state === 'ready' ? 'Message dorabot' : 'Reconnecting…'}
              disabled={conn.state !== 'ready'}
              className="selectable max-h-36 min-h-11 flex-1 rounded-2xl border border-ink-600 bg-ink-850 px-4 py-2.5 leading-snug"
              style={{ height: 'auto' }}
              onInput={(e) => {
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, 144)}px`
              }}
            />
            <button
              onClick={() => void send()}
              disabled={!draft.trim() || sending || conn.state !== 'ready'}
              className={cx(
                'flex size-11 shrink-0 items-center justify-center rounded-full transition-colors',
                draft.trim() && conn.state === 'ready' ? 'bg-mint-500 text-ink-950' : 'bg-ink-700 text-ink-500',
              )}
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </Screen>
  )
}

export function prettyKey(sessionKey: string): string {
  const [channel, , chatId] = sessionKey.split(':')
  if (channel === 'bg') return 'Background run'
  return `${channel ?? 'session'} · ${(chatId ?? '').slice(0, 8)}`
}
