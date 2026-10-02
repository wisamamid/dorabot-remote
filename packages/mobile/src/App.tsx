import type { StoredSession } from '@dorabot-remote/protocol'
import { useEffect, useState, type ReactNode } from 'react'
import { PairScreen } from './components/PairScreen.js'
import { SessionList } from './components/SessionList.js'
import { SessionView } from './components/SessionView.js'
import { SettingsScreen } from './components/SettingsScreen.js'
import { TerminalScreen } from './components/TerminalScreen.js'
import { Spinner, cx } from './components/ui.js'
import { ConnectionProvider, useConnection } from './lib/connection.js'
import { setStatusBarDark } from './lib/platform.js'

type View =
  | { name: 'sessions' }
  | { name: 'session'; session: StoredSession | null; sessionKey: string }
  | { name: 'terminal' }
  | { name: 'settings' }

export default function App(): ReactNode {
  useEffect(() => {
    void setStatusBarDark()
  }, [])
  return (
    <ConnectionProvider>
      <Shell />
    </ConnectionProvider>
  )
}

function Shell(): ReactNode {
  const conn = useConnection()
  const [view, setView] = useState<View>({ name: 'sessions' })

  if (!conn.ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    )
  }

  if (!conn.pairing) return <PairScreen />

  const waitingCount = conn.attention.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {view.name === 'sessions' && (
          <SessionList
            onOpen={(session, sessionKey) => setView({ name: 'session', session, sessionKey })}
            onSettings={() => setView({ name: 'settings' })}
          />
        )}
        {view.name === 'session' && (
          <SessionView
            session={view.session}
            sessionKey={view.sessionKey}
            onBack={() => setView({ name: 'sessions' })}
          />
        )}
        {view.name === 'terminal' && <TerminalScreen onBack={() => setView({ name: 'sessions' })} />}
        {view.name === 'settings' && <SettingsScreen onBack={() => setView({ name: 'sessions' })} />}
      </div>

      {/* The tab bar disappears inside a conversation so the composer owns the
          bottom of the screen, which is where a thumb already is. */}
      {view.name !== 'session' && (
        <nav className="safe-bottom flex shrink-0 border-t border-ink-700 bg-ink-900 px-2 pt-1.5">
          <Tab
            active={view.name === 'sessions'}
            onClick={() => setView({ name: 'sessions' })}
            badge={waitingCount}
            label="Sessions"
            icon={
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
            }
          />
          <Tab
            active={view.name === 'terminal'}
            onClick={() => setView({ name: 'terminal' })}
            locked={!conn.hasScope('terminal')}
            label="Terminal"
            icon={<path d="M4 17l6-5-6-5M12 19h8" strokeLinecap="round" strokeLinejoin="round" />}
          />
          <Tab
            active={view.name === 'settings'}
            onClick={() => setView({ name: 'settings' })}
            label="Settings"
            icon={
              <>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.63.68 1.1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </>
            }
          />
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
          <span className="absolute -right-1.5 -top-1 flex min-w-[17px] items-center justify-center rounded-full bg-amber-glow px-1 text-[11px] font-semibold leading-[17px] text-ink-950">
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
      <span className="text-[11px] font-medium">{label}</span>
    </button>
  )
}
