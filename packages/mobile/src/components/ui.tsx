import { useEffect, useState, type ReactNode } from 'react'
import { SwipeBack } from './SwipeBack.js'

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
  onTitleClick,
}: {
  title: string
  subtitle?: ReactNode
  right?: ReactNode
  children: ReactNode
  onBack?: () => void
  /** Makes the title tappable (rename). */
  onTitleClick?: () => void
}): ReactNode {
  const screen = (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900/95 px-4 py-2 backdrop-blur">
        {onBack && (
          <button onClick={onBack} aria-label="Back" className="-ml-3 flex size-11 items-center justify-center rounded-xl text-ink-300 active:bg-ink-800">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <div className="min-w-0 flex-1">
          {onTitleClick ? (
            <button onClick={onTitleClick} aria-label={`Rename ${title}`} className="block max-w-full text-left">
              <h1 className="truncate text-[17px] font-semibold tracking-[-0.01em]">{title}</h1>
            </button>
          ) : (
            <h1 className="truncate text-[17px] font-semibold tracking-[-0.01em]">{title}</h1>
          )}
          {subtitle && <div className="truncate text-[13px] text-ink-300">{subtitle}</div>}
        </div>
        {right}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
  return onBack ? <SwipeBack onBack={onBack}>{screen}</SwipeBack> : screen
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

/** One-of-N switch for sub-views inside a tab. Every segment is a 44px target. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}): ReactNode {
  return (
    <div className="flex shrink-0 gap-1 rounded-xl bg-ink-850 p-1" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'tap flex-1 rounded-lg px-2 text-[14px] font-medium transition-colors',
            o.value === value ? 'bg-ink-700 text-ink-100' : 'text-ink-400 active:bg-ink-800',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Chip({ children, tone }: { children: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'idle' }): ReactNode {
  const t = {
    good: 'bg-mint-900 text-mint-500',
    warn: 'bg-amber-dim text-amber-glow',
    bad: 'bg-rose-dim text-rose-glow',
    idle: 'bg-ink-800 text-ink-300',
  }[tone ?? 'idle']
  return <span className={cx('inline-flex items-center rounded-md px-2 py-0.5 text-[13px] font-medium', t)}>{children}</span>
}

export function IconButton({
  label,
  onClick,
  children,
  disabled,
  className,
}: {
  label: string
  onClick?: () => void
  children: ReactNode
  disabled?: boolean
  className?: string
}): ReactNode {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-300 active:bg-ink-800 disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  multiline,
  mono,
  rows,
}: {
  label?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  multiline?: boolean
  mono?: boolean
  rows?: number
}): ReactNode {
  const cls = cx(
    'selectable w-full rounded-xl border border-ink-600 bg-ink-900 px-3.5 py-3 leading-snug',
    mono && 'font-mono text-[15px]',
  )
  return (
    <label className="block space-y-1.5">
      {label && <span className="block text-[13px] font-medium text-ink-300">{label}</span>}
      {multiline ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows ?? 4} className={cls} />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoCapitalize="off"
          autoCorrect="off"
          className={cx(cls, 'min-h-11')}
        />
      )}
    </label>
  )
}

export function ErrorNote({ error, onRetry }: { error: string | null; onRetry?: () => void }): ReactNode {
  if (!error) return null
  return (
    <div className="flex items-start gap-3 rounded-card border border-rose-glow/30 bg-rose-dim p-3.5 text-[14px] text-rose-glow">
      <span className="min-w-0 flex-1 break-words leading-snug">{error}</span>
      {onRetry && (
        <button onClick={onRetry} className="tap shrink-0 px-2 font-medium underline">
          Retry
        </button>
      )}
    </div>
  )
}

/**
 * A full-height layer over the current tab, for create/edit forms and detail
 * views. Absolute rather than fixed so it stays inside the safe-area box and
 * above the tab bar's reach, and scrolls its own content so the keyboard never
 * hides a field.
 */
export function Layer({ children }: { children: ReactNode }): ReactNode {
  return <div className="slide-up absolute inset-0 z-20 bg-ink-900">{children}</div>
}

export function SectionTitle({ children }: { children: ReactNode }): ReactNode {
  return <h2 className="px-1 pb-1 pt-4 text-[13px] font-semibold uppercase tracking-wider text-ink-400">{children}</h2>
}

/** Two-step destructive action: first tap arms it, second tap (within 4s) fires it. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
}: {
  label: string
  confirmLabel?: string
  onConfirm: () => void
  disabled?: boolean
}): ReactNode {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <Button
      variant="danger"
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else setArmed(true)
      }}
      className="w-full"
    >
      {armed ? (confirmLabel ?? 'Tap again to confirm') : label}
    </Button>
  )
}

/** Native select, styled: the OS picker is the best mobile control for a short list. */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}): ReactNode {
  return (
    <label className="block space-y-1.5">
      {label && <span className="block text-[13px] font-medium text-ink-300">{label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="min-h-11 w-full rounded-xl border border-ink-600 bg-ink-900 px-3.5 py-2.5 text-[16px]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** A tappable list row: title, optional subtitle, optional trailing content. */
export function Row({
  title,
  subtitle,
  meta,
  onClick,
  trailing,
}: {
  title: ReactNode
  subtitle?: ReactNode
  meta?: ReactNode
  onClick?: () => void
  trailing?: ReactNode
}): ReactNode {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[15px] font-medium leading-snug">{title}</div>
        {subtitle && <div className="mt-0.5 line-clamp-2 text-[14px] leading-snug text-ink-400">{subtitle}</div>}
        {meta && <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-400">{meta}</div>}
      </div>
      {trailing}
    </>
  )
  const cls = 'flex w-full items-center gap-3 rounded-card border border-ink-700 bg-ink-850 px-3.5 py-3 text-left'
  return onClick ? (
    <button onClick={onClick} className={cx(cls, 'active:bg-ink-800')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}
