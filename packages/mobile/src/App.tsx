import type { StoredSession } from '@dorabot-remote/protocol'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { keyOf } from './lib/connection.js'
import { CodeScreen } from './components/CodeScreen.js'
import { InboxScreen } from './components/InboxScreen.js'
import { MoreScreen } from './components/MoreScreen.js'
import { WorkScreen } from './components/WorkScreen.js'
import { PairScreen } from './components/PairScreen.js'
import { SessionList } from './components/SessionList.js'
import { SessionView } from './components/SessionView.js'
import { PushPrompt } from './components/PushPrompt.js'
import { RenameProvider } from './components/RenameSheet.js'
import { Button, Spinner, cx } from './components/ui.js'
import { useSplit } from './lib/layout.js'
import { ConnectionProvider, useConnection } from './lib/connection.js'
import { InboxProvider, useInbox } from './lib/inbox-context.js'
import { bannerFor } from './lib/status-banner.js'
import { haptic, setStatusBarDark } from './lib/platform.js'
import { AppLockProvider, useAppLock } from './lib/app-lock.js'
import { clearDeliveredNotifications, onPushNavigate, pruneDeliveredNotifications } from './lib/push.js'
import { routePushAction, runDecision, type PushRoute } from './lib/push-actions.js'
import { createPortal } from 'react-dom'
import { PushProvider } from './lib/push-context.js'

type TabName = 'sessions' | 'inbox' | 'work' | 'code' | 'more'

type Open = { session: StoredSession | null; sessionKey: string } | null

export default function App(): ReactNode {
  useEffect(() => {
    void setStatusBarDark()
  }, [])
  return (
    <AppLockProvider>
      <ConnectionProvider>
        <PushProvider>
          <InboxProvider>
            <RenameProvider>
              <Shell />
            </RenameProvider>
          </InboxProvider>
        </PushProvider>
      </ConnectionProvider>
    </AppLockProvider>
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
  const lock = useAppLock()
  const [decision, setDecision] = useState<Extract<PushRoute, { type: 'decide' }> | null>(null)
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null)
  const paired = Boolean(conn.pairing)
  const split = useSplit()

  useEffect(() => {
    if (!paired) return
    return onPushNavigate((nav) => {
      const route = routePushAction(nav)
      setTab('inbox')
      setOpen(null)
      if (route.type === 'decide') {
        // Face ID is asked inside runDecision; the delivered notification is cleared by the prune below.
        setDecision(route)
        return
      }
      void clearDeliveredNotifications()
      if (route.sessionKey) {
        const key = route.sessionKey
        const s = connRef.current.sessions.find((x) => x.channel && x.chatType && x.chatId && `${x.channel}:${x.chatType}:${x.chatId}` === key)
        setTab('sessions')
        setOpen({ session: s ?? null, sessionKey: key })
      } else if (route.rid) {
        const rid = route.rid
        setPendingRid(rid)
        setTimeout(() => setPendingRid((r) => (r === rid ? null : r)), 15_000)
      }
    })
  }, [paired])

  // Approve / Deny from a notification: confirm with Face ID right away, then act once connected.
  const connRef = useRef(conn)
  connRef.current = conn
  const verifyOnce = useRef<Promise<'ok' | 'cancelled' | 'unavailable' | 'failed'> | null>(null)
  useEffect(() => {
    if (!decision) return
    verifyOnce.current ??= lock.verify(decision.decision === 'approve' ? 'Approve this request' : 'Deny this request')
  }, [decision, lock])
  useEffect(() => {
    if (!decision || conn.state !== 'ready') return
    const route = decision
    const verify = verifyOnce.current ?? lock.verify('Confirm')
    setDecision(null)
    verifyOnce.current = null
    void runDecision(route, { verify: () => verify, rpc: (m, p) => connRef.current.rpc(m, p) }).then((out) => {
      setToast({ text: out.message, ok: out.status === 'done' || out.status === 'already_resolved' })
      void haptic(out.status === 'done' ? 'success' : 'warning')
    })
  }, [decision, conn.state, lock])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  // Drop delivered notifications for requests that are already settled.
  useEffect(() => {
    if (!inbox.settled) return
    void pruneDeliveredNotifications(new Set(inbox.items.map((i) => i.id.slice(i.id.indexOf(':') + 1))))
  }, [inbox.settled, inbox.items])

  useEffect(() => {
    if (!pendingRid) return
    const item = inbox.items.find((i) => i.id.endsWith(`:${pendingRid}`))
    if (!item) return
    setPendingRid(null)
    if (!item.sessionKey) return
    const s = conn.sessions.find((x) => x.channel && x.chatType && x.chatId && `${x.channel}:${x.chatType}:${x.chatId}` === item.sessionKey)
    setOpen({ session: s ?? null, sessionKey: item.sessionKey })
  }, [pendingRid, inbox.items, conn.sessions])

  // Entering the two-pane layout with a conversation open: show it where it lives.
  useEffect(() => {
    if (split && open) setTab('sessions')
  }, [split, open])

  if (!conn.ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    )
  }

  if (!conn.pairing && !conn.demo) return <PairScreen />

  const openSession = (session: StoredSession | null, sessionKey: string): void => {
    setOpen({ session, sessionKey })
    if (split) setTab('sessions')
  }

  // The open row can be stale after a rename; always show the live one.
  const liveSession = open
    ? (conn.sessions.find((s) => (open.session && s.id === open.session.id) || keyOf(s) === open.sessionKey) ?? open.session)
    : null

  // Tabs stay mounted so a half-typed commit message or a scroll position
  // survives a switch; only the active one is visible.
  const pane = (name: TabName, node: ReactNode, wide = false): ReactNode => (
    <div className={cx('absolute inset-0', tab !== name && 'hidden')}>
      {split && !wide ? <div className="mx-auto h-full max-w-3xl">{node}</div> : node}
    </div>
  )

  const tabs = (rail: boolean): ReactNode => (
    <>
      <Tab rail={rail} active={tab === 'sessions'} onClick={() => setTab('sessions')} label="Sessions" icon={icon.sessions} />
      <Tab rail={rail} active={tab === 'inbox'} onClick={() => setTab('inbox')} badge={inbox.count} label="Inbox" icon={icon.inbox} />
      <Tab rail={rail} active={tab === 'work'} onClick={() => setTab('work')} locked={!conn.hasScope('work')} label="Work" icon={icon.work} />
      <Tab rail={rail} active={tab === 'code'} onClick={() => setTab('code')} locked={!conn.hasScope('files') && !conn.hasScope('git')} label="Code" icon={icon.code} />
      <Tab rail={rail} active={tab === 'more'} onClick={() => setTab('more')} label="More" icon={icon.more} />
    </>
  )

  const sessionsPane = split ? (
    <div className="flex h-full min-h-0">
      <div className="h-full w-[340px] shrink-0 border-r border-ink-700 lg:w-[360px]">
        <SessionList onOpen={openSession} onSettings={() => setTab('more')} selectedKey={open?.sessionKey} />
      </div>
      <div className="h-full min-w-0 flex-1 bg-ink-900">
        {open ? (
          <SessionView key={open.sessionKey} session={liveSession} sessionKey={open.sessionKey} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <svg viewBox="0 0 24 24" className="size-10 text-ink-500" fill="none" stroke="currentColor" strokeWidth="1.4">
              {icon.sessions}
            </svg>
            <p className="text-[17px] font-medium text-ink-200">Select a session</p>
            <p className="text-[14px] text-ink-400">Pick a conversation from the list.</p>
          </div>
        )}
      </div>
    </div>
  ) : (
    <SessionList onOpen={openSession} onSettings={() => setTab('more')} />
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
      {conn.demo && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-700 bg-amber-dim px-4 py-2">
          <p className="text-[13.5px] font-medium leading-snug text-amber-glow">Demo mode: sample data, no Mac connected</p>
          <button onClick={conn.exitDemo} className="shrink-0 rounded-md px-2 py-1 text-[13.5px] font-semibold text-amber-glow underline">
            Exit demo
          </button>
        </div>
      )}
      <StatusBanner />
      {!(open && !split) && (tab === 'sessions' || tab === 'inbox') && <PushPrompt />}
      <div className="flex min-h-0 flex-1">
        {split && (
          <nav className="safe-bottom flex w-[84px] shrink-0 flex-col gap-1 border-r border-ink-700 bg-ink-900 px-1.5 pt-3">
            {tabs(true)}
          </nav>
        )}
        <div className="relative min-h-0 min-w-0 flex-1">
          {pane('sessions', sessionsPane, true)}
          {pane('inbox', <InboxScreen onOpenSession={openSession} />)}
          {pane('work', <WorkScreen onOpenSession={openSession} />)}
          {pane('code', <CodeScreen />, true)}
          {pane('more', <MoreScreen />)}
          {open && !split && (
            <div className="absolute inset-0 z-30 bg-ink-900">
              <SessionView key={open.sessionKey} session={liveSession} sessionKey={open.sessionKey} onBack={() => setOpen(null)} />
            </div>
          )}
        </div>
      </div>

      {/* The tab bar disappears inside a conversation so the composer owns the
          bottom of the screen, which is where a thumb already is. */}
      {!split && !open && (
        <nav className="kb-hide safe-bottom flex shrink-0 border-t border-ink-700 bg-ink-900 px-1 pt-1.5">{tabs(false)}</nav>
      )}
      {toast &&
        createPortal(
          <div
            role="status"
            onClick={() => setToast(null)}
            className={cx(
              'fixed inset-x-4 top-[max(env(safe-area-inset-top),12px)] z-[80] mx-auto max-w-md rounded-xl px-4 py-3 text-[14px] shadow-lg',
              toast.ok ? 'bg-mint-900 text-mint-500' : 'bg-rose-dim text-rose-glow',
            )}
          >
            {toast.text}
          </div>,
          document.body,
        )}
    </div>
  )
}

function StatusBanner(): ReactNode {
  const conn = useConnection()
  const [online, setOnline] = useState(() => navigator.onLine)
  const [just, setJust] = useState(false)
  const wasDown = useRef(false)

  useEffect(() => {
    const on = (): void => setOnline(true)
    const off = (): void => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  useEffect(() => {
    if (conn.state !== 'ready') {
      wasDown.current = true
      return
    }
    if (!wasDown.current) return
    wasDown.current = false
    setJust(true)
    const t = setTimeout(() => setJust(false), 3000)
    return () => clearTimeout(t)
  }, [conn.state])

  const b = bannerFor({ state: conn.state, online, transport: conn.transport, justReconnected: just })
  if (!b) return null
  return (
    <div
      role="status"
      className={cx(
        'shrink-0 px-4 py-1.5 text-center text-[13px] font-medium',
        b.tone === 'bad' && 'bg-rose-dim text-rose-glow',
        b.tone === 'warn' && 'bg-amber-dim text-amber-glow',
        b.tone === 'good' && 'bg-mint-500/15 text-mint-500',
      )}
    >
      {b.text}
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
  rail,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: ReactNode
  badge?: number
  locked?: boolean
  /** Vertical sidebar item (iPad) instead of a bottom-bar item. */
  rail?: boolean
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={cx(
        'relative flex flex-col items-center gap-0.5 rounded-lg py-1.5 transition-colors',
        rail ? 'w-full py-2.5 hover:bg-ink-800' : 'flex-1',
        active ? 'text-mint-500' : 'text-ink-400',
        rail && active && 'bg-ink-800',
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
