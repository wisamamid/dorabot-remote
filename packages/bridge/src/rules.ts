import { isRisky, offerableRule, ruleMatches, type AllowRuleSpec, type RiskContext } from '@dorabot-remote/protocol'
import type { AllowRuleRecord } from './store.js'

export const MAX_RULES = 100
const MAX_COMMAND = 4000

/**
 * Validate a rule a phone wants to add. A rule can never be broader than the
 * phone UI would have offered: no tool-wide rule for Bash (or anything that takes a
 * free-form command), and no rule for a command the classifier calls risky.
 */
export function parseNewRule(params: Record<string, unknown>): AllowRuleSpec {
  const toolName = typeof params.toolName === 'string' ? params.toolName.trim() : ''
  if (!toolName || toolName.length > 120 || /[\u0000-\u001f]/.test(toolName)) throw new Error('invalid tool name')
  if (params.kind === 'exact') {
    const command = typeof params.command === 'string' ? params.command : ''
    if (toolName !== 'Bash') throw new Error('an exact-command rule is only for Bash')
    if (!command.trim() || command.length > MAX_COMMAND) throw new Error('invalid command')
    if (isRisky('Bash', { command })) throw new Error('risky commands can never be always-allowed')
    return { kind: 'exact', toolName, command }
  }
  if (params.kind === 'tool') {
    if (params.command !== undefined) throw new Error('a tool rule has no command')
    // offerableRule(toolName, {}) is null for Bash (it needs a command), so reuse it as the single source of truth.
    if (toolName === 'Bash' || !offerableRule(toolName, {})) throw new Error('Bash can only be allowed one exact command at a time')
    return { kind: 'tool', toolName }
  }
  throw new Error('unknown rule kind')
}

export function toSpec(r: AllowRuleRecord): AllowRuleSpec {
  return r.kind === 'exact' ? { kind: 'exact', toolName: r.toolName, command: r.command ?? '' } : { kind: 'tool', toolName: r.toolName }
}

/** The first rule that covers this request, or null. Risky inputs never match. */
export function findMatchingRule(rules: readonly AllowRuleRecord[], toolName: unknown, input: unknown, ctx: RiskContext = {}): AllowRuleRecord | null {
  if (typeof toolName !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) return null
  return rules.find((r) => ruleMatches(toSpec(r), toolName, input as Record<string, unknown>, ctx)) ?? null
}

export function describeRule(r: Pick<AllowRuleRecord, 'kind' | 'toolName' | 'command'>): string {
  return r.kind === 'exact' ? `Bash: ${(r.command ?? '').replace(/\s+/g, ' ').slice(0, 120)}` : `${r.toolName} (any non-risky use)`
}
