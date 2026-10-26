import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AlwaysAllowOffer } from '../lib/always-allow.js'
import { Button } from './ui.js'

/**
 * Explains an always-allow rule before it is created. Confirming asks for Face ID next.
 * Portalled to the body and lifted by the keyboard height like the other overlays.
 */
export function AlwaysAllowSheet({
  offer,
  command,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  offer: AlwaysAllowOffer
  command?: string
  busy: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/55 transition-[padding] duration-[250ms] md:items-center"
      style={{ paddingBottom: 'var(--kb, 0px)' }}
    >
      <div
        role="dialog"
        aria-label={offer.title}
        className="safe-bottom flex max-h-[85%] w-full max-w-md flex-col gap-3.5 rounded-t-2xl border border-ink-700 bg-ink-850 px-4 pt-4 md:rounded-2xl md:pb-4"
      >
        <h2 className="text-[17px] font-semibold">{offer.title}</h2>
        <p className="text-[13.5px] leading-relaxed text-ink-300">
          Your Mac will approve this by itself from now on, without asking you. It covers: {offer.scope}
        </p>
        {command && (
          <pre data-testid="always-allow-command" className="selectable scroll whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 font-mono text-[13px]">
            {command}
          </pre>
        )}
        <p className="text-[13px] leading-relaxed text-ink-400">
          Each automatic approval is recorded in the audit log. You can see and remove rules in Settings on this phone, or on the Mac control page. You will confirm with Face ID next.
        </p>
        {error && <p className="text-[14px] text-rose-glow">{error}</p>}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy} className="flex-1">
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy} className="flex-1">
            {busy ? 'Working…' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
