import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './ui.js'

/**
 * Every dorabot-remote://ask link (and so every Siri / Shortcuts ask) lands here first.
 * The prompt is shown in full and nothing is sent until Send is tapped.
 */
export function AskConfirmSheet({
  prompt,
  hostName,
  onSend,
  onCancel,
}: {
  prompt: string
  hostName: string
  onSend: () => void
  onCancel: () => void
}): ReactNode {
  return createPortal(
    // Portalled outside #root, so lift it by the keyboard height published in --kb.
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/55 transition-[padding] duration-[250ms] md:items-center"
      style={{ paddingBottom: 'var(--kb, 0px)' }}
    >
      <div
        role="dialog"
        aria-label="Send this to your Mac?"
        className="safe-bottom flex max-h-[85%] w-full max-w-md flex-col gap-3.5 rounded-t-2xl border border-ink-700 bg-ink-850 px-4 pt-4 md:rounded-2xl md:pb-4"
      >
        <h2 className="text-[17px] font-semibold">Start a session on {hostName}?</h2>
        <p className="text-[13.5px] text-ink-400">Another app or shortcut asked dorabot to run this prompt. Check it before you send.</p>
        <pre
          data-testid="ask-prompt"
          className="selectable min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 font-sans text-[14.5px]"
        >
          {prompt}
        </pre>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} className="flex-1">
            Cancel
          </Button>
          <Button variant="primary" onClick={onSend} className="flex-1">
            Send
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
