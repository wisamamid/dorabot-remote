/**
 * Context provider for saved prompts. Loads on first access and syncs with storage.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SavedPrompt } from './saved-prompts.js'
import { loadPrompts, addPrompt, updatePrompt, removePrompt, reorderPrompts } from './saved-prompts.js'

interface SavedPromptsContextValue {
  prompts: SavedPrompt[]
  loading: boolean
  add: (prompt: Omit<SavedPrompt, 'id'>) => Promise<SavedPrompt>
  update: (id: string, prompt: Omit<SavedPrompt, 'id'>) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (ids: string[]) => Promise<void>
}

const Ctx = createContext<SavedPromptsContextValue | null>(null)

export function useSavedPrompts(): SavedPromptsContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSavedPrompts must be used inside <SavedPromptsProvider>')
  return v
}

export function SavedPromptsProvider({ hostId, children }: { hostId: string; children: ReactNode }): ReactNode {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void loadPrompts(hostId).then((loaded) => {
      if (alive) {
        setPrompts(loaded)
        setLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [hostId])

  const add = useCallback(
    async (prompt: Omit<SavedPrompt, 'id'>) => {
      const newPrompt = await addPrompt(hostId, prompt)
      setPrompts((prev) => [...prev, newPrompt])
      return newPrompt
    },
    [hostId],
  )

  const update = useCallback(
    async (id: string, prompt: Omit<SavedPrompt, 'id'>) => {
      await updatePrompt(hostId, id, prompt)
      setPrompts((prev) => prev.map((p) => (p.id === id ? { ...p, ...prompt } : p)))
    },
    [hostId],
  )

  const remove = useCallback(
    async (id: string) => {
      await removePrompt(hostId, id)
      setPrompts((prev) => prev.filter((p) => p.id !== id))
    },
    [hostId],
  )

  const reorder = useCallback(
    async (ids: string[]) => {
      await reorderPrompts(hostId, ids)
      const map = new Map(prompts.map((p) => [p.id, p]))
      const reordered = ids.map((id) => map.get(id)).filter((p) => p !== undefined) as SavedPrompt[]
      setPrompts(reordered)
    },
    [hostId, prompts],
  )

  const value = useMemo(() => ({ prompts, loading, add, update, remove, reorder }), [prompts, loading, add, update, remove, reorder])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
