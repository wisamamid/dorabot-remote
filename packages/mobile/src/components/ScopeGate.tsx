import { SCOPE_DESCRIPTIONS, SCOPE_LABELS, type Scope } from '@dorabot-remote/protocol'
import { useEffect, useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { formatLeft } from '../lib/expiry.js'
import { useScopeRequest } from '../lib/scope.js'
import { Button, Card, Spinner } from './ui.js'

/**
 * Gated features are never hidden. Without the permission the screen says what it
 * is, which permission it needs, and offers to ask: the request shows up on the
 * Mac, where a human approves it.
 */
export function ScopeGate({
  scope,
  title,
  children,
}: {
  scope: Scope
  title: string
  children: ReactNode
}): ReactNode {
  const conn = useConnection()
  if (!conn.hasScope(scope)) return <Locked scope={scope} title={title} />
  const until = conn.scopeExpiry[scope]
  if (!until) return <>{children}</>
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TempAccessBanner scope={scope} until={until} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

/** Re-renders every 30s so the remaining time stays honest without a ticking-per-second layout. */
function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

/** Shown on a feature that was granted for a limited time: how long is left. */
export function TempAccessBanner({ scope, until }: { scope: Scope; until: number }): ReactNode {
  const now = useNow()
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-850 px-4 py-2 text-[13px] text-amber-glow">
      <LockIcon className="size-3.5 shrink-0" />
      <span>
        Temporary access to {SCOPE_LABELS[scope]}: {until > now ? `${formatLeft(until - now)} left` : 'ending now'}
      </span>
    </div>
  )
}

export function Locked({ scope, title }: { scope: Scope; title: string }): ReactNode {
  const conn = useConnection()
  const { requested, busy, error, request } = useScopeRequest(scope)
  const host = conn.host?.name ?? conn.pairing?.hostName ?? 'your Mac'
  const ended = conn.expiredScopes.includes(scope)

  return (
    <div className="scroll flex h-full flex-col justify-center gap-6 px-6">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-ink-800 text-ink-300">
        <LockIcon className="size-6" />
      </div>
      <div className="space-y-2">
        <h2 className="text-[22px] font-semibold tracking-[-0.01em]">{title} is locked</h2>
        <p className="text-[15px] leading-relaxed text-ink-300">
          This phone does not have the <span className="font-medium text-ink-100">{SCOPE_LABELS[scope]}</span>{' '}
          permission. {SCOPE_DESCRIPTIONS[scope]} It stays off until you allow it from {host}.
        </p>
        {ended && (
          <p className="text-[14px] leading-relaxed text-amber-glow" role="status">
            The time limit on this permission ended. Request it again to continue.
          </p>
        )}
      </div>
      {requested ? (
        <Card className="space-y-2">
          <div className="flex items-center gap-2 text-[15px] font-medium text-mint-500">
            <Spinner className="size-4 text-mint-500" />
            Waiting for approval
          </div>
          <p className="text-[14px] leading-relaxed text-ink-400">
            Open the pairing page on {host} and allow it there. This screen unlocks the moment you do.
          </p>
        </Card>
      ) : (
        <Button variant="primary" onClick={() => void request()} disabled={busy || conn.state !== 'ready'}>
          {busy ? 'Asking…' : 'Request access'}
        </Button>
      )}
      {error && <p className="text-[14px] text-rose-glow">{error}</p>}
    </div>
  )
}

/** A control the device is not allowed to use, shown rather than hidden. */
export function LockedControl({ scope, label }: { scope: Scope; label: string }): ReactNode {
  const { requested, busy, error, request } = useScopeRequest(scope)
  const conn = useConnection()
  return (
    <div className="rounded-card border border-ink-700 bg-ink-850 p-3.5">
      <div className="flex items-center gap-3">
        <LockIcon className="size-5 shrink-0 text-ink-400" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-ink-200">{label}</div>
          <div className="text-[13px] leading-snug text-ink-400">
            Needs the {SCOPE_LABELS[scope]} permission.{conn.expiredScopes.includes(scope) ? ' Its time limit ended.' : ''}
          </div>
        </div>
        {requested ? (
          <span className="flex items-center gap-1.5 text-[13px] text-mint-500">
            <Spinner className="size-3.5 text-mint-500" /> asked
          </span>
        ) : (
          <button
            onClick={() => void request()}
            disabled={busy || conn.state !== 'ready'}
            className="tap shrink-0 rounded-xl border border-ink-600 px-3.5 text-[14px] font-medium text-ink-200 active:bg-ink-700 disabled:opacity-40"
          >
            {busy ? 'Asking…' : 'Request access'}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-[13px] text-rose-glow">{error}</p>}
    </div>
  )
}

export function LockIcon({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 1 1 8 0v4" />
    </svg>
  )
}
