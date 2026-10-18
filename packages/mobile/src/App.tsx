import type { StoredSession } from '@dorabot-remote/protocol'
import { useEffect, useState, type ReactNode } from 'react'
import { CodeScreen } from './components/CodeScreen.js'
import { InboxScreen } from './components/InboxScreen.js'
import { MoreScreen } from './components/MoreScreen.js'
import { WorkScreen } from './components/WorkScreen.js'
import { PairScreen } from './components/PairScreen.js'
import { SessionList } from './components/SessionList.js'
import { SessionView } from './components/SessionView.js'
import { PushPrompt } from './components/PushPrompt.js'
import { Button, Spinner, cx } from './components/ui.js'
import { ConnectionProvider, useConnection } from './lib/connection.js'
import { InboxProvider, useInbox } from './lib/inbox-context.js'
import { setStatusBarDark } from './lib/platform.js'
import { clearDeliveredNotifications, onPushNavigate } from './lib/push.js'
import { PushProvider } from './lib/push-context.js'

type TabName = 'sessions' | 'inbox' | 'work' | 'code' | 'more'

type Open = { session: StoredSession | null; sessionKey: string } | null

export default function App(): ReactNode {
  useEffect(() => {
    void setStatusBarDark()
  }, [])
  return (
    <ConnectionProvider>
      <PushProvider>
        <InboxProvider>
          <Shell />
        </InboxProvider>
      </PushProvider>
    </ConnectionProvider>
  )
}

const icon = {
  sessions: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />,
  inbox: <path d="M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" strokeLinecap="round" strokeLinejoin="round" />,
  work: <path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" strokeLinecap="round" strokeLinejoin="round" />,
  code: <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </>
  ),
}

function Shell(): ReactNode {
  const conn = useConnection()
  const inbox = useInbox()
  const [tab, setTab] = useState<TabName>('sessions')
  const [open, setOpen] = useState<Open>(null)
  // A tapped notification carries only a routing id; wait for the matching inbox item.
  const [pendingRid, setPendingRid] = useState<string | null>(null)
  const paired = Boolean(conn.pairing)

  useEffect(() => {
    if (!paired) return
    return onPushNavigate((nav) => {
      setTab('inbox')
      setOpen(null)
      void clearDeliveredNotifications()
      if (nav.rid) {
        setPendingRid(nav.rid)
        setTimeout(() => setPendingRid((r) => (r === nav.rid ? null : r)), 15_000)
      }
    })
  }, [paired])

  useEffect(() => {
    if (!pendingRid) return
    const item = inbox.items.find((i) => i.id.endsWith(`:${pendingRid}`))
    if (!item) return
    setPendingRid(null)
    if (!item.sessionKey) return
    const s = conn.sessions.find((x) => x.channel && x.chatType && x.chatId && `${x.channel}:${x.chatType}:${x.chatId}` === item.sessionKey)
    setOpen({ session: s ?? null, sessionKey: item.sessionKey })
  }, [pendingRid, inbox.items, conn.sessions])

  if (!conn.ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    )
  }

  if (!conn.pairing) return <PairScreen />

  const openSession = (session: StoredSession | null, sessionKey: string): void => setOpen({ session, sessionKey })

  // Tabs stay mounted so a half-typed commit message or a scroll position
  // survives a switch; only the active one is visible.
  const pane = (name: TabName, node: ReactNode): ReactNode => (
    <div className={cx('absolute inset-0', tab !== name && 'hidden')}>{node}</div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {conn.state === 'revoked' && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-700 bg-ink-900 px-4 py-2.5">
          <p className="text-[13.5px] leading-snug text-amber-glow">
            {conn.stateDetail || 'This Mac no longer trusts this phone.'}
          </p>
          <Button variant="primary" onClick={() => void conn.forget()} className="shrink-0 px-3 text-[14px]">
            Pair again
          </Button>
        </div>
      )}
      {!open && (tab === 'sessions' || tab === 'inbox') && <PushPrompt />}
      <div className="relative min-h-0 flex-1">
        {pane('sessions', <SessionList onOpen={openSession} onSettings={() => setTab('more')} />)}
        {pane('inbox', <InboxScreen onOpenSession={openSession} />)}
        {pane('work', <WorkScreen onOpenSession={openSession} />)}
        {pane('code', <CodeScreen />)}
        {pane('more', <MoreScreen />)}
        {open && (
          <div className="absolute inset-0 z-30 bg-ink-900">
            <SessionView session={open.session} sessionKey={open.sessionKey} onBack={() => setOpen(null)} />
          </div>
        )}
      </div>

      {/* The tab bar disappears inside a conversation so the composer owns the
          bottom of the screen, which is where a thumb already is. */}
      {!open && (
        <nav className="safe-bottom flex shrink-0 border-t border-ink-700 bg-ink-900 px-1 pt-1.5">
          <Tab active={tab === 'sessions'} onClick={() => setTab('sessions')} label="Sessions" icon={icon.sessions} />
          <Tab active={tab === 'inbox'} onClick={() => setTab('inbox')} badge={inbox.count} label="Inbox" icon={icon.inbox} />
          <Tab active={tab === 'work'} onClick={() => setTab('work')} locked={!conn.hasScope('work')} label="Work" icon={icon.work} />
          <Tab active={tab === 'code'} onClick={() => setTab('code')} locked={!conn.hasScope('files') && !conn.hasScope('git')} label="Code" icon={icon.code} />
          <Tab active={tab === 'more'} onClick={() => setTab('more')} label="More" icon={icon.more} />
        </nav>
      )}
    </div>
  )
}

function Tab({
  active,
  onClick,
  label,
  icon,
  badge,
  locked,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: ReactNode
  badge?: number
  locked?: boolean
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={cx(
        'relative flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 transition-colors',
        active ? 'text-mint-500' : 'text-ink-400',
      )}
    >
      <span className="relative">
        <svg viewBox="0 0 24 24" className="size-[22px]" fill="none" stroke="currentColor" strokeWidth="1.7">
          {icon}
        </svg>
        {badge ? (
          <span className="absolute -right-1.5 -top-1 flex min-w-[18px] items-center justify-center rounded-full bg-amber-glow px-1 text-[13px] font-semibold leading-[18px] text-ink-950">
            {badge}
          </span>
        ) : null}
        {locked && (
          <span className="absolute -right-1.5 -top-0.5 text-ink-500">
            <svg viewBox="0 0 24 24" className="size-3" fill="currentColor">
              <path d="M12 2a4 4 0 0 0-4 4v3H7a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-1V6a4 4 0 0 0-4-4m0 2a2 2 0 0 1 2 2v3h-4V6a2 2 0 0 1 2-2" />
            </svg>
          </span>
        )}
      </span>
      <span className="text-[13px] font-medium">{label}</span>
    </button>
  )
}
