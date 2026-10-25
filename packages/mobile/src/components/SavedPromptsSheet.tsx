/**
 * Sheet showing saved prompts. Tap a prompt to insert its text into the composer.
 * Uses portal to sit above the keyboard.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useSavedPrompts } from '../lib/saved-prompts-context.js'
import { Button, cx } from './ui.js'

interface SavedPromptsSheetCtx {
  open: (onSelect: (text: string) => void) => void
}

const Ctx = createContext<SavedPromptsSheetCtx>({ open: () => {} })
export const useSavedPromptsSheet = (): SavedPromptsSheetCtx => useContext(Ctx)

/** Owns the one saved prompts sheet, so any screen can open it. */
export function SavedPromptsSheetProvider({ children }: { children: ReactNode }): ReactNode {
  const prompts = useSavedPrompts()
  const [open, setOpen] = useState(false)
  const [callback, setCallback] = useState<((text: string) => void) | null>(null)

  const openSheet = useCallback((onSelect: (text: string) => void) => {
    setCallback(() => onSelect)
    setOpen(true)
  }, [])

  const selectPrompt = (text: string): void => {
    callback?.(text)
    setOpen(false)
  }

  const value = useMemo(() => ({ open: openSheet }), [openSheet])

  return (
    <Ctx.Provider value={value}>
      {children}
      {open && (
        <Sheet
          prompts={prompts.prompts}
          onSelect={selectPrompt}
          onClose={() => setOpen(false)}
        />
      )}
    </Ctx.Provider>
  )
}

interface SheetProps {
  prompts: Array<{ id: string; title: string; text: string }>
  onSelect: (text: string) => void
  onClose: () => void
}

function Sheet({ prompts, onSelect, onClose }: SheetProps): ReactNode {
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 md:items-center"
      style={{ paddingBottom: 'var(--kb, 0px)' }}
      onClick={onClose}
    >
      <form
        role="dialog"
        aria-label="Saved prompts"
        onClick={(e) => e.stopPropagation()}
        className="safe-bottom w-full max-w-md space-y-3.5 rounded-t-2xl border border-ink-700 bg-ink-850 px-4 pt-4 md:rounded-2xl md:pb-4"
      >
        <h2 className="text-[17px] font-semibold">Saved prompts</h2>
        {prompts.length === 0 ? (
          <div className="py-8 text-center text-[14px] text-ink-400">No saved prompts</div>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-2">
            {prompts.map((prompt) => (
              <button
                key={prompt.id}
                type="button"
                onClick={() => onSelect(prompt.text)}
                className="w-full text-left rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5 active:bg-ink-800"
              >
                <div className="text-[15px] font-medium text-ink-100">{prompt.title}</div>
                {prompt.title !== prompt.text && (
                  <div className="text-[13px] text-ink-400 line-clamp-2">{prompt.text}</div>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2 border-t border-ink-700 pt-3.5">
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Close
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
