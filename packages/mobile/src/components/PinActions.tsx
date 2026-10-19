import { createPortal } from 'react-dom'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic } from '../lib/platform.js'

/**
 * Pin or unpin a session, with an error toast. Render `toast` somewhere in the
 * screen; the toast is portalled to the body so it floats above everything.
 */
export function usePinner(): { isPinned: (key: string) => boolean; toggle: (key: string) => void; toast: ReactNode } {
  const conn = useConnection()
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 4000)
    return () => clearTimeout(t)
  }, [message])

  const isPinned = useCallback((key: string) => conn.pins.some((p) => p.id === key), [conn.pins])
  const toggle = useCallback(
    (key: string) => {
      const next = !conn.pins.some((p) => p.id === key)
      conn.setPinned(key, next).then(
        () => void haptic('success'),
        (err: Error) => {
          void haptic('warning')
          setMessage(`Could not ${next ? 'pin' : 'unpin'}: ${err.message}`)
        },
      )
    },
    [conn],
  )

  const toast = message
    ? createPortal(
        <div
          role="alert"
          className="fixed inset-x-4 top-[max(env(safe-area-inset-top),12px)] z-[70] mx-auto max-w-md rounded-xl bg-rose-dim px-4 py-3 text-[14px] text-rose-glow shadow-lg"
          onClick={() => setMessage(null)}
        >
          {message}
        </div>,
        document.body,
      )
    : null

  return { isPinned, toggle, toast }
}

export interface SheetAction {
  label: string
  onPress: () => void
}

/** A bottom action sheet. Portalled to the body and lifted by the keyboard height (--kb), like RenameSheet. */
export function ActionSheet({
  title,
  actions,
  onClose,
}: {
  title: string
  actions: SheetAction[]
  onClose: () => void
}): ReactNode {
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 transition-[padding] duration-[250ms] md:items-center"
      style={{ paddingBottom: 'var(--kb, 0px)' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="safe-bottom w-full max-w-md space-y-2 rounded-t-2xl border border-ink-700 bg-ink-850 px-4 pt-4 md:rounded-2xl md:pb-4"
      >
        <h2 className="truncate text-[15px] font-semibold text-ink-300">{title}</h2>
        {actions.map((a) => (
          <button
            key={a.label}
            onClick={() => {
              onClose()
              a.onPress()
            }}
            className="block w-full rounded-xl bg-ink-800 px-4 py-3 text-left text-[16px] active:bg-ink-700"
          >
            {a.label}
          </button>
        ))}
        <button onClick={onClose} className="block w-full rounded-xl px-4 py-3 text-center text-[16px] text-ink-400 active:bg-ink-800">
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  )
}
