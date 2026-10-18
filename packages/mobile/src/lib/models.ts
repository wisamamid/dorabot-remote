import type { StoredSession } from '@dorabot-remote/protocol'

/**
 * The model list, mirrored from the desktop. The desktop hardcodes Claude's list in
 * desktop/src/lib/modelCatalog.ts (CLAUDE_MODELS) and fetches Codex's from the
 * gateway (`provider.codex.models`), so the phone does the same. Keep in step.
 */
export interface ModelOption {
  value: string
  label: string
  description?: string
  badge?: string
}

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'

export const CLAUDE_MODELS: ModelOption[] = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5', badge: 'default' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-opus-5', label: 'Opus 5 (legacy)' },
  { value: 'claude-fable-5', label: 'Fable 5 (legacy)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6 (legacy)' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5 (legacy)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (legacy)' },
]

export interface ProviderDetect {
  claude?: { installed?: boolean; hasOAuth?: boolean; hasApiKey?: boolean }
  codex?: { installed?: boolean; hasAuth?: boolean }
}

export interface CodexCatalogModel {
  id: string
  displayName?: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
}

export type ProviderName = 'claude' | 'codex'

export interface ModelGroup {
  provider: ProviderName
  title: string
  /** Models here can be picked for a session. Only the Mac's active provider can run. */
  selectable: boolean
  /** Why it is not selectable. */
  reason?: string
  models: ModelOption[]
}

/**
 * Providers that are set up on the Mac, as groups. The Mac runs one provider at a
 * time (config `provider.name`, which a phone may not change), and a per-session
 * model is only meaningful for that provider, so the other group is shown disabled.
 */
export function buildModelGroups(input: {
  detect: ProviderDetect | null
  active: ProviderName | null
  codexModels?: CodexCatalogModel[] | null
}): ModelGroup[] {
  const { detect, active } = input
  const claudeConfigured = detect ? Boolean(detect.claude?.hasOAuth || detect.claude?.hasApiKey) : active === 'claude'
  const codexConfigured = detect ? Boolean(detect.codex?.hasAuth) : active === 'codex'
  const groups: ModelGroup[] = []
  const off = (p: ProviderName): { selectable: boolean; reason?: string } =>
    active === p || active === null ? { selectable: true } : { selectable: false, reason: `Switch to ${p === 'claude' ? 'Anthropic' : 'OpenAI'} on your Mac to use these` }
  if (claudeConfigured || active === 'claude') {
    groups.push({ provider: 'claude', title: 'Anthropic', ...off('claude'), models: CLAUDE_MODELS })
  }
  if (codexConfigured || active === 'codex') {
    const models = (input.codexModels ?? [])
      .filter((m) => !m.hidden)
      .map((m): ModelOption => ({ value: m.id, label: m.displayName || m.id, description: m.description, badge: m.isDefault ? 'default' : undefined }))
    groups.push({ provider: 'codex', title: 'OpenAI', ...off('codex'), models })
  }
  return groups
}

/** What the pill shows: the session's own pick, else the Mac's default. */
export function currentModelValue(session: Pick<StoredSession, 'model'> | null | undefined): string {
  return session?.model || DEFAULT_CLAUDE_MODEL
}

/** Short pill text: catalog label without the "(legacy)" tail, else the id minus its vendor prefix. */
export function shortModelName(value: string, groups: ModelGroup[] = []): string {
  const found = [...groups.flatMap((g) => g.models), ...CLAUDE_MODELS].find((m) => m.value === value)
  const label = found?.label ?? value.replace(/^claude-/, '').replace(/-\d{8}$/, '')
  return label.replace(/\s*\((legacy|deprecated)\)$/, '')
}

type Rpc = <T = unknown>(method: string, params?: unknown) => Promise<T>

/**
 * Switch a session's model the way the desktop selector does: `sessions.setModel`
 * with the stored session id (persists and broadcasts `sessions.update`, so the
 * desktop follows). Optimistic, rolled back on failure. While a run is live the
 * desktop only applies the pick from the next message, so we also ask the live run
 * to switch with `agent.setModel` (best effort) and report whether it took.
 */
export async function switchModel(
  deps: { rpc: Rpc; setSessions: (update: (prev: StoredSession[]) => StoredSession[]) => void },
  target: { sessionId: string; sessionKey: string; running: boolean },
  model: string,
): Promise<{ live: boolean }> {
  let previous: string | undefined
  deps.setSessions((list) => {
    previous = list.find((s) => s.id === target.sessionId)?.model
    return list
  })
  const set = (value: string | undefined): void =>
    deps.setSessions((list) => list.map((s) => (s.id === target.sessionId ? { ...s, model: value } : s)))
  set(model)
  try {
    await deps.rpc('sessions.setModel', { sessionId: target.sessionId, model })
  } catch (err) {
    set(previous)
    throw err
  }
  if (!target.running) return { live: false }
  try {
    await deps.rpc('agent.setModel', { sessionKey: target.sessionKey, model })
    return { live: true }
  } catch {
    return { live: false }
  }
}
