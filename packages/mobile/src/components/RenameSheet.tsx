import type { StoredSession } from '@dorabot-remote/protocol'
import { createPortal } from 'react-dom'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic } from '../lib/platform.js'
import { MAX_NAME, normalizeName } from '../lib/rename.js'
import { LockIcon } from './ScopeGate.js'
import { Button } from './ui.js'

interface RenameCtx {
  /** Open the rename sheet for a stored session. */
  open: (session: StoredSession | null | undefined) => void
}

const Ctx = createContext<RenameCtx>({ open: () => {} })
export const useRename = (): RenameCtx => useContext(Ctx)

/** Owns the one rename sheet and the error toast, so any screen can open it. */
export function RenameProvider({ children }: { children: ReactNode }): ReactNode {
  const conn = useConnection()
  const [target, setTarget] = useState<StoredSession | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const open = useCallback((s: StoredSession | null | undefined) => {
    if (s) setTarget(s)
  }, [])
  const value = useMemo(() => ({ open }), [open])

  function save(name: string): void {
    const s = target
    setTarget(null)
    if (!s) return
    conn.renameSession(s.id, name).then(
      () => void haptic('success'),
      (err: Error) => {
        void haptic('warning')
        setToast(`Could not rename: ${err.message}`)
      },
    )
  }

  const live = target ? (conn.sessions.find((s) => s.id === target.id) ?? target) : null

  return (
    <Ctx.Provider value={value}>
      {children}
      {live && (
        <RenameSheet
          key={live.id}
          initial={live.name || live.senderName || ''}
          allowed={conn.hasScope('sessions')}
          offline={conn.state !== 'ready'}
          onCancel={() => setTarget(null)}
          onSave={save}
        />
      )}
      {toast && (
        <div role="alert" className="fixed inset-x-4 top-[max(env(safe-area-inset-top),12px)] z-[70] mx-auto max-w-md rounded-xl bg-rose-dim px-4 py-3 text-[14px] text-rose-glow shadow-lg" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </Ctx.Provider>
  )
}

function RenameSheet({
  initial,
  allowed,
  offline,
  onCancel,
  onSave,
}: {
  initial: string
  allowed: boolean
  offline: boolean
  onCancel: () => void
  onSave: (name: string) => void
}): ReactNode {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (allowed) {
      ref.current?.focus()
      ref.current?.select()
    }
  }, [allowed])
  const name = normalizeName(value)
  const canSave = allowed && !offline && name !== null && name !== initial.trim()

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 md:items-center" onClick={onCancel}>
      <form
        role="dialog"
        aria-label="Rename session"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave && name) onSave(name)
        }}
        className="safe-bottom w-full max-w-md space-y-3.5 rounded-t-2xl border border-ink-700 bg-ink-850 px-4 pt-4 md:rounded-2xl md:pb-4"
      >
        <h2 className="text-[17px] font-semibold">Rename session</h2>
        {allowed ? (
          <input
            ref={ref}
            value={value}
            onChange={(e) => setValue(e.target.value.slice(0, MAX_NAME))}
            maxLength={MAX_NAME}
            placeholder="Session name"
            enterKeyHint="done"
            className="selectable w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5"
          />
        ) : (
          <div className="flex items-center gap-2.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 text-[14px] text-ink-300">
            <LockIcon className="size-4 shrink-0" />
            Renaming needs the Sessions permission. Allow it from your Mac.
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} className="flex-1">
            Cancel
          </Button>
          <Button variant="primary" onClick={() => canSave && name && onSave(name)} disabled={!canSave} className="flex-1">
            Save
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
