import { useState, type ReactNode } from 'react'
import { usePush } from '../lib/push-context.js'
import { Button } from './ui.js'

/**
 * Shown once after pairing (and on later starts while undecided). Asking for the
 * system permission at launch gets it refused; asking after explaining gets it granted.
 */
export function PushPrompt(): ReactNode {
  const push = usePush()
  const [busy, setBusy] = useState(false)
  if (!push.shouldPrompt) return null
  return (
    <div className="shrink-0 space-y-2.5 border-b border-ink-700 bg-ink-900 px-4 py-3">
      <div>
        <div className="text-[15px] font-medium">Get notified when dorabot needs you</div>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-400">
          A question or an approval can be waiting while the app is closed. The notification only says that something
          is waiting, never what it is.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={push.dismiss} className="flex-1 px-3 text-[14px]">
          Not now
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void push.enable().finally(() => setBusy(false))
          }}
          className="flex-1 px-3 text-[14px]"
        >
          Enable
        </Button>
      </div>
    </div>
  )
}
