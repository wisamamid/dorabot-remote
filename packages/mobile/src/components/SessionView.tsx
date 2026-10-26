import type { StoredSession } from '@dorabot-remote/protocol'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import {
  MAX_IMAGES,
  buildChatSendParams,
  fitImagesToBudget,
  makeBrowserEncoder,
} from '../lib/attachments.js'
import { haptic, watchKeyboard } from '../lib/platform.js'
import { canAutoSend, getDraftsForSession, removeDraft, saveDraft, type OfflineDraft } from '../lib/offline-drafts.js'
import { endRunActivity, startRunActivity, updateRunActivity } from '../lib/appgroup.js'
import { recordVoice, isVoiceSupported, type RecordingHandle } from '../lib/voice-transcription.js'
import { PullToRefresh } from './PullToRefresh.js'
import { ChatItemList, StatusLine } from './ChatItems.js'
import { ApprovalCard, ElicitationCard, QuestionCard } from './Interrupts.js'
import { ModelPicker } from './ModelPicker.js'
import { usePinner } from './PinActions.js'
import { useRename } from './RenameSheet.js'
import { useSavedPromptsSheet } from './SavedPromptsSheet.js'
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
  /** Omitted in the iPad two-pane layout, where the list is already on screen. */
  onBack?: () => void
}): ReactNode {
  const conn = useConnection()
  const rename = useRename()
  const pinner = usePinner()
  const savedPromptsSheet = useSavedPromptsSheet()
  const state = conn.getSession(sessionKey)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [keyboard, setKeyboard] = useState(0)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [photos, setPhotos] = useState<Array<{ id: number; file: File; url: string }>>([])
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [recording, setRecording] = useState(false)
  const [voiceSupported, setVoiceSupported] = useState(false)
  const [voiceText, setVoiceText] = useState('')
  const [runSummary, setRunSummary] = useState<{ duration: number; cost?: number; toolCount: number } | null>(null)
  const [pendingDrafts, setPendingDrafts] = useState<OfflineDraft[]>([])
  const photoId = useRef(0)
  const photosRef = useRef(photos)
  photosRef.current = photos
  const fileInput = useRef<HTMLInputElement>(null)
  const recordingRef = useRef<RecordingHandle | null>(null)
  const earlierLoadedRef = useRef(0)
  const runStartTimeRef = useRef<number | null>(null)
  const previousStatusRef = useRef<string>('idle')

  useEffect(() => {
    void conn.openSession(sessionKey, session?.id)
    conn.clearAttention(sessionKey)
    setPendingDrafts([])
    if (conn.activeHostId) void getDraftsForSession(conn.activeHostId, sessionKey).then(setPendingDrafts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, session?.id])

  useEffect(() => {
    void isVoiceSupported().then(setVoiceSupported)
  }, [])

  useEffect(() => watchKeyboard(setKeyboard), [])
  // Release the preview blobs when leaving the conversation.
  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), [])

  // Track run start/end for run summary card
  useEffect(() => {
    const isRunning = state.status !== 'idle' && state.status !== 'thinking'
    const wasRunning = previousStatusRef.current !== 'idle' && previousStatusRef.current !== 'thinking'

    if (isRunning && !wasRunning) {
      // Run started
      runStartTimeRef.current = Date.now()
      setRunSummary(null)
    } else if (!isRunning && wasRunning) {
      // Run ended
      if (runStartTimeRef.current) {
        const duration = Date.now() - runStartTimeRef.current
        const toolCount = state.chatItems.filter((item) => (item as Record<string, unknown>).type === 'tool_use').length
        const resultItem = state.chatItems.find((item) => (item as Record<string, unknown>).type === 'result') as Record<string, unknown> | undefined
        const cost = resultItem?.cost as number | undefined
        setRunSummary({ duration, cost, toolCount })
        runStartTimeRef.current = null
      }
    }

    previousStatusRef.current = state.status
  }, [state.status, state.chatItems])

  // Auto-send recent drafts for this Mac when the connection becomes ready. Older ones wait for a tap.
  const sendDraft = useCallback(
    async (draft: OfflineDraft): Promise<void> => {
      if (draft.hostId !== conn.activeHostId) return
      setSending(true)
      try {
        await conn.rpc('chat.send', buildChatSendParams({ prompt: draft.content, images: [], sessionKey: draft.sessionKey, chatId: session?.chatId }))
        await removeDraft(draft.id)
        setPendingDrafts((prev) => prev.filter((d) => d.id !== draft.id))
        await haptic('light')
      } catch {
        // Stays queued; retried on the next connection.
      } finally {
        setSending(false)
      }
    },
    [conn, session?.chatId],
  )

  useEffect(() => {
    if (conn.state !== 'ready' || sending) return
    const next = pendingDrafts.find((d) => canAutoSend(d))
    if (next) void sendDraft(next)
  }, [conn.state, pendingDrafts, sending, sendDraft])

  function addPhotos(e: ChangeEvent<HTMLInputElement>): void {
    const picked = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/') || f.type === '')
    e.target.value = ''
    if (!picked.length) return
    const room = MAX_IMAGES - photos.length
    if (picked.length > room) setError(`You can attach up to ${MAX_IMAGES} photos.`)
    setPhotos((prev) => [
      ...prev,
      ...picked.slice(0, Math.max(0, room)).map((file) => ({ id: ++photoId.current, file, url: URL.createObjectURL(file) })),
    ])
  }

  function removePhoto(id: number): void {
    setPhotos((prev) => {
      const gone = prev.find((p) => p.id === id)
      if (gone) URL.revokeObjectURL(gone.url)
      return prev.filter((p) => p.id !== id)
    })
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [conn.revision, keyboard, photos.length])

  // The transcript shrinks as the keyboard animates in (see initKeyboardInset),
  // so re-pin to the bottom once the animation has settled.
  useEffect(() => {
    const t = setTimeout(() => {
      const el = scrollRef.current
      if (el && stick.current) el.scrollTop = el.scrollHeight
    }, 300)
    return () => clearTimeout(t)
  }, [keyboard])

  function onScroll(): void {
    const el = scrollRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
    // Trigger load earlier when scrolled to the very top
    if (el.scrollTop < 30 && conn.getHistoryInfo(sessionKey)?.shown !== conn.getHistoryInfo(sessionKey)?.total) {
      void loadEarlier()
    }
  }

  const busy = state.status !== 'idle'

  // Live Activity while a run is active in the open session: started when it becomes busy,
  // updated as the status changes, ended when it goes idle or the session is closed.
  const runLabel = state.status === 'tool_use' ? (state.statusDetail ? `Running ${state.statusDetail}` : 'Running a tool') : state.status === 'responding' ? 'Writing' : 'Thinking'
  const activityOn = useRef(false)
  const activityName = session?.name || session?.senderName || prettyKey(sessionKey)
  useEffect(() => {
    if (busy && !activityOn.current) {
      activityOn.current = true
      void startRunActivity(activityName, runLabel, Date.now())
    } else if (busy) {
      void updateRunActivity(runLabel)
    } else if (activityOn.current) {
      activityOn.current = false
      void endRunActivity()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, runLabel])
  useEffect(
    () => () => {
      if (activityOn.current) {
        activityOn.current = false
        void endRunActivity()
      }
    },
    [],
  )
  const blocked = state.pendingApproval ?? state.pendingQuestion ?? state.pendingElicitation

  async function send(): Promise<void> {
    const prompt = draft.trim()
    if ((!prompt && photos.length === 0) || sending) return
    setSending(true)
    setError(null)
    stick.current = true
    const encoder = makeBrowserEncoder(photos.map((p) => p.file))
    try {
      const build = (images: Array<{ data: string; mediaType: string }>) =>
        buildChatSendParams({ prompt, images, sessionKey, chatId: session?.chatId })
      const images = photos.length ? await fitImagesToBudget(photos.length, encoder.encode, build) : []
      const params = build(images)
      await conn.rpc('chat.send', params)
      if (images.length) conn.attachImages(sessionKey, params.prompt as string, images)
      setDraft('')
      photos.forEach((p) => URL.revokeObjectURL(p.url))
      setPhotos([])
      await haptic('light')
    } catch (err) {
      const errMsg = (err as Error).message
      // Queue draft if offline
      if (conn.state !== 'ready') {
        const result = conn.activeHostId && prompt ? await saveDraft(conn.activeHostId, sessionKey, prompt) : null
        if (result) {
          setPendingDrafts((prev) => [...prev, result])
          setDraft('')
          photos.forEach((p) => URL.revokeObjectURL(p.url))
          setPhotos([])
          setError(photos.length ? 'Message queued (photos are not queued) - will send when connected' : 'Message queued - will send when connected')
        } else setError(errMsg)
        await haptic('light')
      } else {
        setError(errMsg)
      }
    } finally {
      encoder.dispose()
      setSending(false)
    }
  }

  async function removePendingDraft(draftId: string): Promise<void> {
    await removeDraft(draftId)
    setPendingDrafts((prev) => prev.filter((d) => d.id !== draftId))
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

  async function startVoiceRecording(): Promise<void> {
    if (recording || !voiceSupported) return
    try {
      setRecording(true)
      setVoiceText('')
      recordingRef.current = await recordVoice({
        language: 'en-US',
        partialResults: true,
        onResult: (result) => {
          setVoiceText(result.text)
        },
        onError: (error) => {
          setError(error)
          setRecording(false)
        },
      })
    } catch (err) {
      setError((err as Error).message)
      setRecording(false)
    }
  }

  async function stopVoiceRecording(): Promise<void> {
    if (!recording || !recordingRef.current) return
    try {
      const text = await recordingRef.current.stop()
      if (text) {
        setDraft((prev) => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + text)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRecording(false)
      setVoiceText('')
      recordingRef.current = null
    }
  }

  const handleVoiceMouseDown = () => {
    void startVoiceRecording()
  }

  const handleVoiceMouseUp = () => {
    void stopVoiceRecording()
  }

  const handleVoiceTouchStart = (e: React.TouchEvent) => {
    e.preventDefault()
    void startVoiceRecording()
  }

  const handleVoiceTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault()
    void stopVoiceRecording()
  }

  async function loadEarlier(): Promise<void> {
    if (loadingEarlier || !session?.id) return
    setLoadingEarlier(true)
    const el = scrollRef.current
    const heightBefore = el?.scrollHeight ?? 0
    try {
      const res = await conn.rpc<{
        messages?: unknown[]
        hasMore?: boolean
        returnedMessages?: number
      }>('sessions.get', {
        sessionId: session.id,
        before: state.chatItems.length,
      })
      if (res && res.messages && res.messages.length > 0) {
        // Prepend messages and dedupe
        const newMessages = res.messages as unknown[]
        const existingIds = new Set(state.chatItems.map((item) => (item as Record<string, unknown>).id))
        const dedupedMessages = newMessages.filter((m) => !existingIds.has((m as Record<string, unknown>).id))

        if (dedupedMessages.length > 0) {
          earlierLoadedRef.current += dedupedMessages.length
          // Restore scroll position after prepending
          if (el) {
            const heightAfter = el.scrollHeight
            const heightDiff = heightAfter - heightBefore
            el.scrollTop += heightDiff
          }
        }
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoadingEarlier(false)
    }
  }

  const title = session?.name || session?.senderName || prettyKey(sessionKey)

  return (
    <Screen
      title={title}
      subtitle={<span className="font-mono text-[12.5px]">{session?.channel ?? sessionKey.split(':')[0]}</span>}
      onBack={onBack}
      onTitleClick={session ? () => rename.open(session) : undefined}
      right={
        <div className="flex items-center gap-2">
          {conn.hasScope('sessions') && (
            <button
              onClick={() => pinner.toggle(sessionKey)}
              aria-label={pinner.isPinned(sessionKey) ? 'Unpin session' : 'Pin session'}
              className={cx(
                'flex size-9 items-center justify-center rounded-lg active:bg-ink-800',
                pinner.isPinned(sessionKey) ? 'text-mint-500' : 'text-ink-400',
              )}
            >
              <svg viewBox="0 0 24 24" className="size-[18px]" fill={pinner.isPinned(sessionKey) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                <path d="M16 3l5 5-2 1-3.5 3.5.5 4.5-1.5 1.5-3.5-3.5L6 20l-1-1 4.5-5-3.5-3.5L7.5 9 12 9.5 15.5 6z" />
              </svg>
            </button>
          )}
          <ModelPicker session={session} sessionKey={sessionKey} running={busy} />
          {busy ? (
            <Button variant="ghost" onClick={() => void interrupt()} className="px-3 text-[14px] text-amber-glow">
              Stop
            </Button>
          ) : (
            <Dot tone={conn.state === 'ready' ? (conn.gatewayConnected ? 'good' : 'warn') : 'bad'} />
          )}
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
        <PullToRefresh
          scrollRef={scrollRef}
          onScroll={onScroll}
          onRefresh={() => conn.reloadHistory(sessionKey, session?.id)}
          className="px-3 py-3"
        >
          {conn.getHistoryInfo(sessionKey) && (
            <div className="mb-3 text-center">
              {conn.getHistoryInfo(sessionKey)!.shown < conn.getHistoryInfo(sessionKey)!.total ? (
                <button
                  onClick={() => void loadEarlier()}
                  disabled={loadingEarlier}
                  className="inline-block rounded-lg bg-ink-800 px-3 py-1.5 text-[12.5px] text-ink-200 hover:bg-ink-700 disabled:opacity-50"
                >
                  {loadingEarlier ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="inline-block size-3 animate-spin rounded-full border-2 border-ink-500 border-t-ink-200" />
                      Loading earlier...
                    </span>
                  ) : (
                    `Load earlier messages (${conn.getHistoryInfo(sessionKey)!.total - conn.getHistoryInfo(sessionKey)!.shown} more)`
                  )}
                </button>
              ) : (
                <span className="text-[12.5px] text-ink-500">Beginning of conversation</span>
              )}
            </div>
          )}
          {state.chatItems.length === 0 ? (
            <div className="flex h-full items-center justify-center px-8 text-center text-[14px] leading-relaxed text-ink-500">
              Nothing here yet. Send a message to start.
            </div>
          ) : (
            <>
              <ChatItemList items={state.chatItems} />
              {runSummary && (
                <div className="mt-4 rounded-lg border border-mint-500/30 bg-mint-dim p-3">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1.5">
                      <p className="text-[13px] font-semibold text-mint-glow">Run complete</p>
                      <div className="flex gap-4 text-[12px] text-ink-400">
                        <span>
                          Duration:{' '}
                          {runSummary.duration < 1000
                            ? `${runSummary.duration}ms`
                            : `${(runSummary.duration / 1000).toFixed(1)}s`}
                        </span>
                        {runSummary.cost !== undefined && <span>Cost: ${runSummary.cost.toFixed(4)}</span>}
                        <span>Tools: {runSummary.toolCount}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setRunSummary(null)
                        const textarea = scrollRef.current?.closest('[data-composer]')?.querySelector('textarea')
                        if (textarea) textarea.focus()
                      }}
                      className="shrink-0 rounded-lg bg-mint-600 px-3 py-1.5 text-[12px] font-medium text-ink-950 active:opacity-80"
                    >
                      Continue
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          <StatusLine status={state.status} detail={state.statusDetail} />
        </PullToRefresh>
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

        {pendingDrafts.length > 0 && (
          <div className="shrink-0 border-t border-ink-700 bg-ink-850 px-3 py-2.5">
            {pendingDrafts.map((draft) => (
              <div key={draft.id} className="mb-1.5 flex items-center justify-between rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 opacity-50 last:mb-0">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-300">
                  {draft.content}
                </span>
                <div className="ml-2 flex shrink-0 items-center gap-2">
                  {canAutoSend(draft) ? (
                    <span className="text-[11px] text-ink-500">Will send when connected</span>
                  ) : (
                    <button onClick={() => void sendDraft(draft)} disabled={conn.state !== 'ready' || sending} className="text-[11px] text-ink-300 underline disabled:opacity-40">
                      Old: send now
                    </button>
                  )}
                  <button
                    onClick={() => void removePendingDraft(draft.id)}
                    aria-label="Remove draft"
                    className="flex size-5 items-center justify-center text-ink-400 hover:text-ink-200"
                  >
                    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div
          className="safe-bottom shrink-0 border-t border-ink-700 bg-ink-900 px-3 pt-2.5"
          data-composer
        >
          {photos.length > 0 && (
            <div className="no-scrollbar mb-2 flex gap-2 overflow-x-auto pt-2">
              {photos.map((p) => (
                <div key={p.id} className="relative shrink-0">
                  <img src={p.url} alt="attachment" className="size-16 rounded-xl object-cover" />
                  <button
                    onClick={() => removePhoto(p.id)}
                    disabled={sending}
                    aria-label="Remove photo"
                    className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full bg-ink-950 text-ink-100 ring-1 ring-ink-600"
                  >
                    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={addPhotos} />
            <button
              onClick={() => fileInput.current?.click()}
              disabled={conn.state !== 'ready' || sending || photos.length >= MAX_IMAGES || !conn.hasScope('chat')}
              aria-label="Attach photos"
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink-800 text-ink-300 active:bg-ink-700 disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <circle cx="9" cy="10" r="1.8" />
                <path d="M21 16l-5-5-8 8" />
              </svg>
            </button>
            <button
              onClick={() => savedPromptsSheet.open((text) => setDraft((prev) => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + text))}
              disabled={conn.state !== 'ready' || sending}
              aria-label="Insert saved prompt"
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink-800 text-ink-300 active:bg-ink-700 disabled:opacity-40"
              title="Saved prompts"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="1" fill="currentColor" />
                <circle cx="19" cy="12" r="1" fill="currentColor" />
                <circle cx="5" cy="12" r="1" fill="currentColor" />
              </svg>
            </button>
            {voiceSupported && (
              <button
                onMouseDown={handleVoiceMouseDown}
                onMouseUp={handleVoiceMouseUp}
                onTouchStart={handleVoiceTouchStart}
                onTouchEnd={handleVoiceTouchEnd}
                disabled={conn.state !== 'ready' || sending}
                aria-label={recording ? 'Recording...' : 'Record voice'}
                className={cx(
                  'flex size-11 shrink-0 items-center justify-center rounded-full active:bg-ink-700 disabled:opacity-40 transition-colors',
                  recording ? 'bg-rose-500 text-ink-950' : 'bg-ink-800 text-ink-300',
                )}
                title={recording ? 'Recording...' : 'Hold to record'}
              >
                <svg viewBox="0 0 24 24" className="size-5" fill={recording ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
                </svg>
              </button>
            )}
            {voiceText && recording && (
              <div className="flex-1 rounded-2xl border border-ink-600 bg-ink-850 px-4 py-2.5 text-[14px] text-ink-200 line-clamp-2">
                {voiceText}
              </div>
            )}
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
              disabled={(!draft.trim() && photos.length === 0) || sending || conn.state !== 'ready'}
              className={cx(
                'flex size-11 shrink-0 items-center justify-center rounded-full transition-colors',
                (draft.trim() || photos.length > 0) && conn.state === 'ready' ? 'bg-mint-500 text-ink-950' : 'bg-ink-700 text-ink-500',
              )}
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      {pinner.toast}
    </Screen>
  )
}

export function prettyKey(sessionKey: string): string {
  const [channel, , chatId] = sessionKey.split(':')
  if (channel === 'bg') return 'Background run'
  return `${channel ?? 'session'} · ${(chatId ?? '').slice(0, 8)}`
}
