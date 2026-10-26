import { storage } from './platform.js'

/**
 * Messages typed while the Mac was unreachable. A draft belongs to one Mac (hostId) and one session; it is only
 * ever listed for, and sent to, that Mac. After DRAFT_AUTO_SEND_MS it is no longer sent by itself (the prompt may
 * no longer make sense), the person has to tap Send. Text only: photos are not queued.
 */
export interface OfflineDraft {
  id: string
  hostId: string
  sessionKey: string
  content: string
  timestamp: number
}

const DRAFTS_KEY = 'offline-drafts.v2'
export const DRAFT_AUTO_SEND_MS = 10 * 60_000
export const MAX_DRAFTS = 20
const MAX_CONTENT = 20_000

/** Whether a draft may be sent without the person asking. */
export function canAutoSend(d: OfflineDraft, now = Date.now()): boolean {
  return now - d.timestamp >= 0 && now - d.timestamp <= DRAFT_AUTO_SEND_MS
}

function isDraft(v: unknown): v is OfflineDraft {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  return typeof d.id === 'string' && typeof d.hostId === 'string' && typeof d.sessionKey === 'string' && typeof d.content === 'string' && typeof d.timestamp === 'number'
}

async function readAll(): Promise<OfflineDraft[]> {
  void storage.remove('offline-drafts').catch(() => {}) // v1 queue: no host binding, may hold photos; never sent again
  const stored = await storage.get(DRAFTS_KEY).catch(() => null)
  if (!stored) return []
  try {
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed.filter(isDraft) : []
  } catch {
    return []
  }
}

const writeAll = (drafts: OfflineDraft[]): Promise<void> => storage.set(DRAFTS_KEY, JSON.stringify(drafts.slice(-MAX_DRAFTS)))

export async function saveDraft(hostId: string, sessionKey: string, content: string): Promise<OfflineDraft> {
  const now = Date.now()
  const draft: OfflineDraft = { id: `${now}-${Math.random().toString(36).slice(2, 10)}`, hostId, sessionKey, content: content.slice(0, MAX_CONTENT), timestamp: now }
  await writeAll([...(await readAll()), draft])
  return draft
}

/** The drafts for this Mac and session, oldest first. Another Mac's drafts are never returned. */
export async function getDraftsForSession(hostId: string, sessionKey: string): Promise<OfflineDraft[]> {
  return (await readAll()).filter((d) => d.hostId === hostId && d.sessionKey === sessionKey)
}

/** Sent or discarded: either way the text is not kept. */
export async function removeDraft(draftId: string): Promise<void> {
  await writeAll((await readAll()).filter((d) => d.id !== draftId))
}

/** A Mac was unpaired: its queued messages go with it. */
export async function clearDraftsForHost(hostId: string): Promise<void> {
  await writeAll((await readAll()).filter((d) => d.hostId !== hostId))
}
