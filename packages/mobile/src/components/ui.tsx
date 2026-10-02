import type { ReactNode } from 'react'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** Status dot used in the header. Colour is the whole message. */
export function Dot({ tone }: { tone: 'good' | 'warn' | 'bad' | 'idle' }): ReactNode {
  const colour =
    tone === 'good' ? 'bg-mint-500' : tone === 'warn' ? 'bg-amber-glow' : tone === 'bad' ? 'bg-rose-glow' : 'bg-ink-500'
  return <span className={cx('inline-block size-2 rounded-full', colour, tone === 'warn' && 'breathe')} />
}

export function Screen({
  title,
  subtitle,
  right,
  children,
  onBack,
}: {
  title: string
  subtitle?: ReactNode
  right?: ReactNode
  children: ReactNode
  onBack?: () => void
}): ReactNode {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900/95 px-4 py-3 backdrop-blur">
        {onBack && (
          <button onClick={onBack} className="-ml-2 flex size-9 items-center justify-center rounded-lg text-ink-300 active:bg-ink-800">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-semibold tracking-[-0.01em]">{title}</h1>
          {subtitle && <div className="truncate text-[13px] text-ink-300">{subtitle}</div>}
        </div>
        {right}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  className,
  type,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
}): ReactNode {
  const styles = {
    default: 'bg-ink-800 border border-ink-600 active:bg-ink-700',
    primary: 'bg-mint-500 text-ink-950 font-semibold active:bg-mint-600',
    danger: 'bg-rose-dim border border-rose-glow/40 text-rose-glow active:bg-rose-glow/20',
    ghost: 'text-ink-300 active:bg-ink-800',
  }[variant]
  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'tap flex items-center justify-center gap-2 rounded-xl px-4 text-[15px] transition-colors',
        styles,
        disabled && 'pointer-events-none opacity-40',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function Card({ children, className, tone }: { children: ReactNode; className?: string; tone?: 'warn' | 'danger' }): ReactNode {
  const toneClass =
    tone === 'warn'
      ? 'border-amber-glow/35 bg-amber-dim'
      : tone === 'danger'
        ? 'border-rose-glow/35 bg-rose-dim'
        : 'border-ink-700 bg-ink-850'
  return <div className={cx('rounded-card border p-4', toneClass, className)}>{children}</div>
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="text-[17px] font-medium text-ink-200">{title}</div>
      {body && <p className="max-w-xs text-[14px] leading-relaxed text-ink-400">{body}</p>}
      {action}
    </div>
  )
}

export function Spinner({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className={cx('size-4 animate-spin text-ink-400', className)} fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

/** Relative time that stays readable: "now", "4m", "2h", "Tue". */
export function timeAgo(ts: number | string | undefined): string {
  if (!ts) return ''
  const t = typeof ts === 'string' ? Date.parse(ts) : ts
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 7 * 86_400_000) return new Date(t).toLocaleDateString(undefined, { weekday: 'short' })
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
