import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useConnection } from '../lib/connection.js'
import { MAX_ALIAS, displayName, type HostPairing } from '../lib/hosts.js'
import { haptic } from '../lib/platform.js'
import { Button, Dot, cx } from './ui.js'

/**
 * Settings > Macs: every paired Mac, which one is active (and how it is reached),
 * switch by tapping, rename locally, and add another without forgetting these.
 * Unpairing lives in the danger zone below and always acts on the active Mac.
 */
export function MacsSection(): ReactNode {
  const conn = useConnection()
  const [renaming, setRenaming] = useState<HostPairing | null>(null)

  const status = (p: HostPairing): { tone: 'good' | 'warn' | 'bad' | 'idle'; text: string } => {
    if (p.hostId !== conn.activeHostId) return { tone: 'idle', text: 'Tap to switch' }
    if (conn.state === 'ready') {
      const via = conn.transport === 'lan' ? 'on your network' : conn.transport === 'relay' ? 'via relay' : ''
      return conn.gatewayConnected
        ? { tone: 'good', text: `Connected${via ? ` ${via}` : ''}` }
        : { tone: 'warn', text: 'Reachable, dorabot is not running' }
    }
    if (conn.state === 'revoked') return { tone: 'bad', text: 'Access removed' }
    return { tone: conn.state === 'connecting' || conn.state === 'handshaking' ? 'warn' : 'bad', text: conn.state === 'connecting' || conn.state === 'handshaking' ? 'Connecting…' : 'Offline' }
  }

  return (
    <section className="space-y-2">
      <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wider text-ink-400">Macs</h2>
      <div className="space-y-1.5">
        {conn.pairings.map((p) => {
          const active = p.hostId === conn.activeHostId
          const st = status(p)
          return (
            <div key={p.hostId} className={cx('flex items-center gap-1 rounded-card border bg-ink-850', active ? 'border-mint-500/50' : 'border-ink-700')}>
              <button
                onClick={() => conn.switchTo(p.hostId)}
                disabled={active}
                aria-current={active ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-card px-3.5 py-3 text-left active:bg-ink-800 disabled:active:bg-transparent"
              >
                <Dot tone={st.tone} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">{displayName(p)}</span>
                  <span className="block truncate text-[13px] text-ink-400">{st.text}</span>
                  <span className="block truncate text-[12.5px] text-ink-500">
                    Paired {new Date(p.addedAt).toLocaleDateString()}
                    {p.alias && p.alias !== p.hostName ? ` · ${p.hostName}` : ''}
                  </span>
                </span>
                {active && <span className="shrink-0 text-[12.5px] font-medium text-mint-500">active</span>}
              </button>
              <button
                onClick={() => setRenaming(p)}
                aria-label={`Rename ${displayName(p)}`}
                className="mr-1 flex size-10 shrink-0 items-center justify-center rounded-xl text-ink-400 active:bg-ink-800"
              >
                <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>
      <Button variant="default" onClick={() => conn.startAddMac()} className="w-full">
        Add another Mac
      </Button>
      <p className="px-1 text-[12.5px] leading-snug text-ink-500">
        One Mac is connected at a time. The Inbox shows the active Mac's items. Notifications arrive from every Mac and open the right one.
      </p>
      {renaming && (
        <RenameMacSheet
          key={renaming.hostId}
          initial={displayName(renaming)}
          original={renaming.hostName}
          onCancel={() => setRenaming(null)}
          onSave={(name) => {
            conn.renameMac(renaming.hostId, name)
            void haptic('success')
            setRenaming(null)
          }}
        />
      )}
    </section>
  )
}

function RenameMacSheet({
  initial,
  original,
  onCancel,
  onSave,
}: {
  initial: string
  original: string
  onCancel: () => void
  onSave: (name: string) => void
}): ReactNode {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  // Blank, or the Mac's own name, clears the nickname.
  const submit = (): void => onSave(value.trim() === original ? '' : value)
  return createPortal(
    // Portalled outside #root and lifted by the keyboard height (--kb), like the other sheets.
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 transition-[padding] duration-[250ms] md:items-center"
      style={{ paddingBottom: 'var(--kb, 0px)' }}
      onClick={onCancel}
    >
      <form
        role="dialog"
        aria-label="Rename Mac"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className="safe-bottom w-full max-w-md space-y-3.5 rounded-t-2xl border border-ink-700 bg-ink-850 px-4 pt-4 md:rounded-2xl md:pb-4"
      >
        <h2 className="text-[17px] font-semibold">Rename Mac</h2>
        <input
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, MAX_ALIAS))}
          maxLength={MAX_ALIAS}
          placeholder={original || 'Mac name'}
          enterKeyHint="done"
          className="selectable w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5"
        />
        <p className="text-[12.5px] leading-snug text-ink-500">Only changes the name on this phone. Leave it blank to use the Mac's own name.</p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} className="flex-1">
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} className="flex-1">
            Save
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
