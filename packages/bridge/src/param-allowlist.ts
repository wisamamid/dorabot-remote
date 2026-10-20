import type { Scope } from '@dorabot-remote/protocol'

/**
 * Per-method params allowlist for sensitive gateway methods. The gateway reads
 * whatever it likes from `params` (tool.approve applies `modifiedInput`, the
 * scheduler stores every field it is handed, shell.spawn takes a cwd), so the
 * bridge forwards only the keys a phone legitimately sends and drops the rest.
 *
 * A key may be restricted to devices that hold a scope: `modifiedInput` rewrites
 * the tool input the agent runs, so it needs `terminal`.
 */
type Allow = string | { key: string; scope: Scope }

const SCHEDULE_FIELDS = [
  'id', 'type', 'summary', 'description', 'dtstart', 'dtend', 'due', 'rrule', 'timezone', 'valarm',
  'message', 'session', 'model', 'thinking', 'enabled', 'deleteAfterRun',
  // Legacy CronJob names the gateway maps onto the above.
  'name',
  // `channel`, `to` and `deliver` (send results to a messaging channel/recipient) are NOT allowed.
]

const ALLOW: Record<string, Allow[]> = {
  'tool.approve': ['requestId', { key: 'modifiedInput', scope: 'terminal' }],
  'tool.deny': ['requestId', 'reason'],
  'chat.send': ['prompt', 'sessionKey', 'chatId', 'images', 'model', 'source'],
  'chat.answerQuestion': ['requestId', 'answers'],
  'chat.answerElicitation': ['elicitationId', 'values', 'sessionKey'],
  'chat.dismissElicitation': ['elicitationId', 'sessionKey'],
  'sessions.rename': ['sessionId', 'name', 'channel'],
  'sessions.setModel': ['sessionId', 'model'],
  'sessions.get': ['sessionId', 'before', 'limit'],
  'agent.setModel': ['sessionKey', 'model'],
  'agent.run_background': ['prompt', 'sessionKey', 'model'],
  'shell.spawn': ['shellId', 'cols', 'rows', 'sessionKey'],
  'shell.write': ['shellId', 'data'],
  'shell.resize': ['shellId', 'cols', 'rows'],
  'shell.kill': ['shellId'],
  'shell.scrollback': ['shellId'],
  'shell.list': [],
  'git.stageFile': ['path', 'file'],
  'git.unstageFile': ['path', 'file'],
  'git.stageAll': ['path'],
  'git.unstageAll': ['path'],
  'git.commit': ['path', 'message'],
  'git.fetch': ['path'],
  'git.pull': ['path'],
  'git.push': ['path'],
  'git.checkout': ['path', 'branch', 'create'],
  'cron.add': SCHEDULE_FIELDS,
  'calendar.add': SCHEDULE_FIELDS,
  'calendar.update': SCHEDULE_FIELDS,
  'cron.toggle': ['id', 'enabled'],
  'calendar.toggle': ['id', 'enabled'],
  'cron.run': ['id'],
  'calendar.run': ['id'],
  'cron.remove': ['id'],
  'calendar.remove': ['id'],
}

/** Returns params with unexpected keys removed, or the input untouched for methods without a list. */
export function sanitizeParams(method: string, params: Record<string, unknown>, scopes: readonly Scope[]): Record<string, unknown> {
  const rules = ALLOW[method]
  if (!rules) return params
  const out: Record<string, unknown> = {}
  for (const rule of rules) {
    const key = typeof rule === 'string' ? rule : rule.key
    if (typeof rule !== 'string' && !scopes.includes(rule.scope)) continue
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const value = params[key]
      // Validate numeric parameters for sessions.get pagination
      if (method === 'sessions.get') {
        if (key === 'before' || key === 'limit') {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) continue
          if (key === 'limit' && value > 500) continue
        }
      }
      out[key] = value
    }
  }
  return out
}
