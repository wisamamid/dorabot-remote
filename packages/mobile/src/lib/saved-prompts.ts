/**
 * Saved prompt templates that users can quickly insert into the composer.
 * Stored per-Mac (via hostId) in Preferences.
 */
import { storage } from './platform.js'

export interface SavedPrompt {
  id: string
  title: string
  text: string
}

export interface SavedPromptsStore {
  prompts: SavedPrompt[]
}

const DEFAULT_PROMPTS: SavedPrompt[] = [
  { id: '1', title: 'Run the tests', text: 'Run the tests' },
  { id: '2', title: 'Summarise what changed today', text: 'Summarise what changed today' },
  { id: '3', title: 'What are you working on?', text: 'What are you working on?' },
]

export function storageKey(hostId: string): string {
  return `dorabot-remote.saved-prompts.${hostId}.v1`
}

export async function loadPrompts(hostId: string): Promise<SavedPrompt[]> {
  try {
    const key = storageKey(hostId)
    const stored = await storage.get(key)
    if (!stored) return DEFAULT_PROMPTS
    const data = JSON.parse(stored) as SavedPromptsStore
    return data.prompts || DEFAULT_PROMPTS
  } catch {
    return DEFAULT_PROMPTS
  }
}

export async function savePrompts(hostId: string, prompts: SavedPrompt[]): Promise<void> {
  const key = storageKey(hostId)
  const data: SavedPromptsStore = { prompts }
  await storage.set(key, JSON.stringify(data))
}

export async function addPrompt(hostId: string, prompt: Omit<SavedPrompt, 'id'>): Promise<SavedPrompt> {
  const prompts = await loadPrompts(hostId)
  const id = Math.random().toString(36).substring(2, 9)
  const newPrompt: SavedPrompt = { ...prompt, id }
  prompts.push(newPrompt)
  await savePrompts(hostId, prompts)
  return newPrompt
}

export async function updatePrompt(hostId: string, id: string, prompt: Omit<SavedPrompt, 'id'>): Promise<void> {
  const prompts = await loadPrompts(hostId)
  const index = prompts.findIndex((p) => p.id === id)
  if (index !== -1) {
    prompts[index] = { ...prompts[index], ...prompt }
    await savePrompts(hostId, prompts)
  }
}

export async function removePrompt(hostId: string, id: string): Promise<void> {
  const prompts = await loadPrompts(hostId)
  const filtered = prompts.filter((p) => p.id !== id)
  await savePrompts(hostId, filtered)
}

export async function reorderPrompts(hostId: string, ids: string[]): Promise<void> {
  const prompts = await loadPrompts(hostId)
  const map = new Map(prompts.map((p) => [p.id, p]))
  const reordered = ids.map((id) => map.get(id)).filter((p) => p !== undefined) as SavedPrompt[]
  await savePrompts(hostId, reordered)
}
