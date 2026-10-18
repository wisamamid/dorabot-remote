import type { StoredSession } from '@dorabot-remote/protocol'
import { useEffect, useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic } from '../lib/platform.js'
import {
  buildModelGroups,
  currentModelValue,
  shortModelName,
  type CodexCatalogModel,
  type ModelGroup,
  type ProviderDetect,
  type ProviderName,
} from '../lib/models.js'
import { cx } from './ui.js'

interface Catalog {
  groups: ModelGroup[]
}

/** Same reads the desktop selector makes; cached so reopening is instant. */
let cached: Catalog | null = null

/** Session header pill showing the model; tap to pick another for this session. */
export function ModelPicker({
  session,
  sessionKey,
  running,
}: {
  session: StoredSession | null
  sessionKey: string
  running: boolean
}): ReactNode {
  const conn = useConnection()
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<Catalog | null>(cached)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const canRead = conn.hasScope('sessions')
  const canSet = conn.hasScope('chat')
  const current = currentModelValue(session)

  useEffect(() => {
    if (!open || !canRead || conn.state !== 'ready') return
    let dead = false
    void (async () => {
      const [detect, provider] = await Promise.allSettled([
        conn.rpc<ProviderDetect>('provider.detect'),
        conn.rpc<{ name?: string }>('provider.get'),
      ])
      const active: ProviderName | null =
        provider.status === 'fulfilled' && (provider.value?.name === 'claude' || provider.value?.name === 'codex')
          ? provider.value.name
          : null
      const d = detect.status === 'fulfilled' ? detect.value : null
      let codexModels: CodexCatalogModel[] | null = null
      if (d?.codex?.hasAuth || active === 'codex') {
        try {
          codexModels = (await conn.rpc<{ models?: CodexCatalogModel[] }>('provider.codex.models'))?.models ?? null
        } catch {
          codexModels = null
        }
      }
      if (dead) return
      const next = { groups: buildModelGroups({ detect: d, active, codexModels }) }
      cached = next
      setCatalog(next)
    })()
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, canRead, conn.state])

  if (!session) return null

  async function pick(model: string): Promise<void> {
    if (!session || model === current) {
      setOpen(false)
      return
    }
    setOpen(false)
    setError(null)
    setNote(null)
    try {
      const { live } = await conn.setSessionModel({ sessionId: session.id, sessionKey, running }, model)
      void haptic('success')
      if (running) setNote(live ? 'Switched mid-run' : 'Applies from the next message')
    } catch (err) {
      void haptic('warning')
      setError(`Could not switch model: ${(err as Error).message}`)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`Model: ${shortModelName(current, catalog?.groups)}`}
        className="flex h-8 max-w-[9.5rem] items-center gap-1 rounded-full border border-ink-600 bg-ink-850 px-2.5 text-[13px] font-medium text-ink-200 hover:bg-ink-800 active:bg-ink-700"
      >
        <span className="truncate">{shortModelName(current, catalog?.groups)}</span>
        <svg viewBox="0 0 24 24" className="size-3 shrink-0 text-ink-400" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {(error || note) && (
        <div
          role="status"
          onClick={() => {
            setError(null)
            setNote(null)
          }}
          className={cx(
            'fixed inset-x-4 top-[max(env(safe-area-inset-top),12px)] z-[70] mx-auto max-w-md rounded-xl px-4 py-3 text-[14px] shadow-lg',
            error ? 'bg-rose-dim text-rose-glow' : 'bg-ink-700 text-ink-100',
          )}
        >
          {error ?? note}
        </div>
      )}
      {open && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 md:items-center" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-label="Choose model"
            onClick={(e) => e.stopPropagation()}
            className="safe-bottom flex max-h-[80%] w-full max-w-md flex-col rounded-t-2xl border border-ink-700 bg-ink-850 pt-4 md:rounded-2xl md:pb-4"
          >
            <div className="px-4 pb-2">
              <h2 className="text-[17px] font-semibold">Model</h2>
              <p className="text-[13px] text-ink-400">
                {running ? 'A run is active: the switch is applied to it now if the provider allows, else from your next message.' : 'Applies to this session.'}
              </p>
            </div>
            <div className="scroll min-h-0 flex-1 px-2 pb-2">
              {!canRead ? (
                <p className="px-2 py-3 text-[14px] text-ink-300">Listing models needs the Sessions permission.</p>
              ) : !canSet ? (
                <p className="px-2 py-3 text-[14px] text-ink-300">Switching models needs the Chat permission. Allow it from your Mac.</p>
              ) : !catalog ? (
                <p className="px-2 py-3 text-[14px] text-ink-400">Loading models…</p>
              ) : catalog.groups.length === 0 ? (
                <p className="px-2 py-3 text-[14px] text-ink-300">No provider is set up on your Mac.</p>
              ) : (
                catalog.groups.map((g) => (
                  <div key={g.provider} className="mb-2">
                    <div className="px-2 pb-1 pt-2 text-[12.5px] font-semibold uppercase tracking-wider text-ink-400">{g.title}</div>
                    {!g.selectable && <div className="px-2 pb-1 text-[13px] text-ink-400">{g.reason}</div>}
                    {g.models.map((m) => {
                      const on = g.selectable && m.value === current
                      return (
                        <button
                          key={m.value}
                          disabled={!g.selectable}
                          onClick={() => void pick(m.value)}
                          className={cx(
                            'tap flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[15px] hover:bg-ink-800 active:bg-ink-700',
                            !g.selectable && 'opacity-40',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{m.label}</span>
                          {m.badge && <span className="text-[12.5px] text-ink-400">{m.badge}</span>}
                          {on && (
                            <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-mint-500" fill="none" stroke="currentColor" strokeWidth="2.6">
                              <path d="M5 12l5 5 9-10" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
