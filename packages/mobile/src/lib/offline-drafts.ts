import { storage } from './platform.js'

export interface OfflineDraft {
  id: string
  sessionKey: string
  content: string
  images?: Array<{ data: string; mediaType: string }>
  timestamp: number
  sent: boolean
}

const DRAFTS_KEY = 'offline-drafts'

export async function saveDraft(sessionKey: string, content: string, images?: Array<{ data: string; mediaType: string }>): Promise<OfflineDraft> {
  const drafts = await getDrafts()
  const draft: OfflineDraft = {
    id: `${sessionKey}:${Date.now()}`,
    sessionKey,
    content,
    images,
    timestamp: Date.now(),
    sent: false,
  }
  drafts.push(draft)
  await storage.set(DRAFTS_KEY, JSON.stringify(drafts))
  return draft
}

export async function getDrafts(): Promise<OfflineDraft[]> {
  const stored = await storage.get(DRAFTS_KEY)
  if (!stored) return []
  try {
    return JSON.parse(stored)
  } catch {
    return []
  }
}

export async function getDraftsForSession(sessionKey: string): Promise<OfflineDraft[]> {
  const drafts = await getDrafts()
  return drafts.filter((d) => d.sessionKey === sessionKey && !d.sent)
}

export async function markDraftSent(draftId: string): Promise<void> {
  const drafts = await getDrafts()
  const draft = drafts.find((d) => d.id === draftId)
  if (draft) {
    draft.sent = true
    await storage.set(DRAFTS_KEY, JSON.stringify(drafts))
  }
}

export async function removeDraft(draftId: string): Promise<void> {
  const drafts = await getDrafts()
  const filtered = drafts.filter((d) => d.id !== draftId)
  await storage.set(DRAFTS_KEY, JSON.stringify(filtered))
}

export async function clearDraftsForSession(sessionKey: string): Promise<void> {
  const drafts = await getDrafts()
  const filtered = drafts.filter((d) => d.sessionKey !== sessionKey)
  await storage.set(DRAFTS_KEY, JSON.stringify(filtered))
}
