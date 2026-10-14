import type { StoredSession } from '@dorabot-remote/protocol'
import { useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { useInbox } from '../lib/inbox-context.js'
import { actionable } from '../lib/inbox.js'
import type { InboxItem } from '../lib/inbox.js'
import { sessionLabel } from '../lib/sessionName.js'
import { ApprovalCard, ElicitationCard, QuestionCard, looksDestructive } from './Interrupts.js'
import { ScopeGate } from './ScopeGate.js'
import { Button, Card, Empty, IconButton, Screen, Spinner } from './ui.js'

/**
 * Everything blocked on you, across every session, in one list.
 *
 * Newest first. Each card names its session and links to it, so the question
 * "what is this for?" is never answered by guessing from a tool name.
 */
export function InboxScreen({
  onOpenSession,
}: {
  onOpenSession: (session: StoredSession | null, sessionKey: string) => void
}): ReactNode {
  const conn = useConnection()
  const inbox = useInbox()
  const [confirm, setConfirm] = useState<'approve' | 'deny' | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchNote, setBatchNote] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const approvals = actionable({ items: inbox.items }).filter((i) => i.kind === 'approval')
  const risky = approvals.filter((i) => i.approval && looksDestructive(i.approval)).length

  async function runBatch(action: 'approve' | 'deny'): Promise<void> {
    setBatchBusy(true)
    setBatchNote(null)
    const failed = await inbox.batch(approvals, action)
    setBatchBusy(false)
    setConfirm(null)
    if (failed) setBatchNote(`${failed} could not be ${action === 'approve' ? 'approved' : 'denied'}. They are still listed.`)
  }

  async function refresh(): Promise<void> {
    setRefreshing(true)
    await inbox.reconcile()
    setRefreshing(false)
  }

  function open(item: InboxItem): void {
    if (!item.sessionKey) return
    const s = conn.sessions.find((x) => x.channel && x.chatType && x.chatId && `${x.channel}:${x.chatType}:${x.chatId}` === item.sessionKey)
    onOpenSession(s ?? null, item.sessionKey)
  }

  return (
    <Screen
      title="Inbox"
      subtitle={inbox.count ? `${inbox.count} waiting on you` : conn.state === 'ready' ? 'Nothing waiting' : 'Offline'}
      right={
        <IconButton label="Refresh" onClick={() => void refresh()} disabled={conn.state !== 'ready' || refreshing}>
          {refreshing ? (
            <Spinner className="size-5" />
          ) : (
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </IconButton>
      }
    >
      <ScopeGate scope="approvals" title="Approvals">
        <div className="scroll h-full space-y-3 px-3 py-3">
          {approvals.length >= 2 && (
            <Card className="space-y-3">
              {confirm ? (
                <>
                  <div className="text-[15px] leading-snug">
                    {confirm === 'approve' ? 'Approve' : 'Deny'} all {approvals.length} pending tool calls?
                    {confirm === 'approve' && risky > 0 && (
                      <span className="mt-1 block font-medium text-rose-glow">
                        {risky} of them look destructive. Check them first.
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={() => setConfirm(null)} disabled={batchBusy} className="flex-1">
                      Cancel
                    </Button>
                    <Button
                      variant={confirm === 'approve' ? 'primary' : 'danger'}
                      onClick={() => void runBatch(confirm)}
                      disabled={batchBusy}
                      className="flex-1"
                    >
                      {batchBusy ? 'Working…' : confirm === 'approve' ? 'Approve all' : 'Deny all'}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex gap-2">
                  <Button variant="default" onClick={() => setConfirm('deny')} className="flex-1">
                    Deny all ({approvals.length})
                  </Button>
                  <Button variant="default" onClick={() => setConfirm('approve')} className="flex-1">
                    Approve all ({approvals.length})
                  </Button>
                </div>
              )}
              {batchNote && <div className="text-[14px] text-rose-glow">{batchNote}</div>}
            </Card>
          )}

          {inbox.items.length === 0 ? (
            <div className="h-[60vh]">
              {conn.state === 'ready' ? (
                <Empty
                  title="All clear"
                  body="Tool approvals and questions from every session land here the moment dorabot needs you."
                />
              ) : (
                <Empty title="Not connected" body="Items waiting on you will appear once the phone reaches your Mac." />
              )}
            </div>
          ) : (
            inbox.items.map((item) => {
              const name = sessionLabel(conn.sessions, item.sessionKey)
              return (
                <div key={item.id} className="space-y-1">
                  {item.kind === 'approval' && item.approval && (
                    <ApprovalCard
                      approval={item.approval}
                      session={name}
                      compact
                      onApprove={(mod) => inbox.approve(item, mod)}
                      onDeny={(reason) => inbox.deny(item, reason)}
                    />
                  )}
                  {item.kind === 'question' && item.question && (
                    <QuestionCard
                      question={item.question}
                      session={name}
                      startedAt={item.at}
                      timedOut={item.timedOut}
                      onAnswer={(answers) => inbox.answerQuestion(item, answers)}
                      onDismiss={() => inbox.dismissLocal(item)}
                    />
                  )}
                  {item.kind === 'elicitation' && item.elicitation && (
                    <ElicitationCard
                      elicitation={item.elicitation}
                      session={name}
                      onSubmit={(values) => inbox.answerElicitation(item, values)}
                      onDismiss={() => inbox.dismissElicitation(item)}
                    />
                  )}
                  {item.sessionKey && (
                    <button
                      onClick={() => open(item)}
                      className="tap w-full px-2 text-left text-[14px] text-ink-400 active:text-ink-100"
                    >
                      Open session →
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>
      </ScopeGate>
    </Screen>
  )
}
