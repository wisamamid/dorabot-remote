/**
 * "Always allow" from an approval: what is offered and what is sent to the bridge.
 * The rule itself (and the rule that it never covers a risky input) is decided in
 * @dorabot-remote/protocol so the bridge enforces the same thing.
 */
import { offerableRule, type AllowRuleSpec, type RiskContext } from '@dorabot-remote/protocol'

export interface AlwaysAllowOffer {
  spec: AllowRuleSpec
  /** Button text. */
  label: string
  /** Sheet title. */
  title: string
  /** What the rule will cover, in plain words. */
  scope: string
}

export function alwaysAllowOffer(toolName: string, input: Record<string, unknown> | undefined | null, ctx: RiskContext = {}): AlwaysAllowOffer | null {
  const spec = offerableRule(toolName, input, ctx)
  if (!spec) return null
  if (spec.kind === 'exact') {
    return {
      spec,
      label: 'Always allow this exact command',
      title: 'Always allow this exact command?',
      scope: 'Only this exact command, character for character. Any other Bash command still asks you.',
    }
  }
  return {
    spec,
    label: `Always allow ${toolName}`,
    title: `Always allow ${toolName}?`,
    scope: `Every use of ${toolName} that is not risky. Risky actions (deleting files, sudo, git push, writing into dotfiles or outside the project, uploads) still ask you every time.`,
  }
}

/**
 * Params for remote.rules.add. `nonce` comes from remote.rules.challenge on the same connection, fetched
 * before the Face ID prompt; the bridge accepts it once, within a minute.
 */
export function ruleParams(spec: AllowRuleSpec, nonce: string): Record<string, unknown> {
  return {
    kind: spec.kind,
    toolName: spec.toolName,
    ...(spec.kind === 'exact' ? { command: spec.command } : {}),
    freshAuth: nonce,
  }
}
