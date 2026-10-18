/**
 * Which gateway RPC methods a scope unlocks.
 *
 * The dorabot gateway has no per-method authorisation of its own: once a client
 * authenticates, all 178 switch arms are reachable, including shell.spawn, fs.write,
 * git.push and config.set. That is fine for a local Electron window and not fine for
 * a phone on the internet. The bridge therefore re-imposes authorisation here, as a
 * strict allowlist: anything not matched is refused.
 *
 * Method names below were taken from the `case` labels in dorabot v0.3.2
 * src/gateway/server.ts, not from the RpcMethod union, which is badly out of date.
 */
import type { Scope } from './wire.js'

/** Exact method name, or a `prefix.*` wildcard. */
type Rule = string

const RULES: Record<Scope, Rule[]> = {
  sessions: [
    'ping',
    'status',
    'sessions.subscribe',
    'sessions.unsubscribe',
    'sessions.list',
    'sessions.get',
    'sessions.reset',
    'sessions.resume',
    'sessions.fork',
    'sessions.tag',
    'sessions.rename',
    'sessions.setModel',
    'sessions.checkpoint.get',
    'agent.abort',
    'agent.interrupt',
    'agent.setModel',
    'agent.stopTask',
    'agent.contextUsage',
    'agent.mcpStatus',
    'agent.background_runs',
    'agents.list',
    'agents.get',
    'skills.list',
    'mcp.list',
    'mcp.status',
    'provider.get',
    'provider.detect',
    'provider.codex.models',
    // Replays the durable session log, so it needs the same scope as reading sessions.
    'remote.events',
  ],
  chat: [
    'chat.send',
    'chat.history',
    'chat.answerQuestion',
    'chat.answerElicitation',
    'chat.dismissElicitation',
    'agent.run_background',
    'search.memory',
  ],
  approvals: [
    'tool.approve',
    'tool.deny',
    'tool.pending',
    'security.get',
    'security.tools.get',
    'security.paths.get',
  ],
  work: [
    'projects.list',
    'projects.add',
    'projects.update',
    'projects.delete',
    'goals.list',
    'goals.add',
    'goals.update',
    'goals.delete',
    'tasks.list',
    'tasks.view',
    'tasks.add',
    'tasks.update',
    'tasks.delete',
    'tasks.logs',
    'tasks.start',
    'research.add',
    'research.list',
    'research.read',
    'research.update',
    'research.delete',
    'calendar.list',
    'calendar.add',
    'calendar.remove',
    'calendar.toggle',
    'calendar.run',
    'calendar.update',
    'calendar.export',
    'cron.list',
    'cron.add',
    'cron.remove',
    'cron.toggle',
    'cron.run',
    'pulse.status',
  ],
  // Read-only by design. fs.write, fs.delete, fs.rename, fs.copy, fs.mkdir and
  // fs.reveal are deliberately absent: a phone browses, it does not edit in place.
  // search.files / search.ripgrep live here, not in `chat`: they return file
  // contents from anywhere under a path, which is file reading by another name.
  files: ['fs.list', 'fs.read', 'fs.readBinary', 'fs.stat', 'search.files', 'search.ripgrep'],
  // Read-only git. Nothing here changes the working tree, the index or a ref.
  git: [
    'git.detect',
    'git.status',
    'git.branches',
    'git.showFile',
    'git.log',
    'git.diff',
    'git.worktrees',
    'git.prs',
    'git.prView',
    'git.prComments',
    'git.prDiff',
    'git.prFileDiff',
    'git.branchCompare',
  ],
  // Everything that mutates the repo or talks to a remote. git.discardFile and
  // git.worktreeRemove exist on the gateway and are deliberately NOT exposed: they
  // destroy uncommitted work and a phone has no undo.
  git_write: [
    'git.stageFile',
    'git.unstageFile',
    'git.stageAll',
    'git.unstageAll',
    'git.commit',
    'git.fetch',
    'git.pull',
    'git.push',
    'git.checkout',
  ],
  terminal: ['shell.spawn', 'shell.write', 'shell.resize', 'shell.kill', 'shell.scrollback', 'shell.list'],
  admin: [
    'config.get',
    'config.set',
    'channels.status',
    'skills.*',
    'agents.*',
    'mcp.*',
    'pulse.setInterval',
    // No fs.*: reading lives in `files` (no duplicate listing), and fs writes are never exposed.
  ],
}

/**
 * Never forwarded, whatever scopes a device holds. These either hand out the host's
 * own credentials, let a remote device log the host out of its model provider, or
 * let it reconfigure the very security model constraining it.
 */
const NEVER_FORWARD = new Set([
  'auth',
  'provider.set',
  'provider.auth.method',
  'provider.auth.status',
  'provider.auth.apiKey',
  'provider.auth.oauth',
  'provider.auth.oauth.complete',
  'provider.codex.rpc',
  'provider.codex.appServerSnapshot',
  'provider.check',
  'channels.whatsapp.login',
  'channels.whatsapp.logout',
  'channels.telegram.link',
  'channels.telegram.unlink',
  'sessions.delete',
  'fs.delete',
  'skills.env.set',
  'skills.env.status',
])

/** Methods the bridge answers itself rather than forwarding to the gateway. */
export const BRIDGE_METHODS = new Set([
  'remote.hello',
  'remote.devices',
  'remote.revoke',
  'remote.rename',
  'remote.requestScope',
  'remote.scopeRequests',
  'remote.health',
  'remote.events',
])

/** Bridge methods that also require a scope (they are not open to every device). */
const BRIDGE_SCOPE_GATED = new Set(['remote.events'])

function matches(rule: Rule, method: string): boolean {
  if (rule.endsWith('.*')) return method.startsWith(rule.slice(0, -1))
  return rule === method
}

export function methodsForScopes(scopes: readonly Scope[]): string[] {
  const out = new Set<string>()
  for (const scope of scopes) {
    for (const rule of RULES[scope] ?? []) out.add(rule)
  }
  return [...out].sort()
}

export function isMethodAllowed(method: string, scopes: readonly Scope[]): boolean {
  if (NEVER_FORWARD.has(method)) return false
  if (BRIDGE_METHODS.has(method) && !BRIDGE_SCOPE_GATED.has(method)) return true
  for (const scope of scopes) {
    for (const rule of RULES[scope] ?? []) {
      if (matches(rule, method)) return true
    }
  }
  return false
}

/** Explanation for a refusal, so the app can say why instead of just failing. */
export function denialReason(method: string, scopes: readonly Scope[]): string {
  if (NEVER_FORWARD.has(method)) return `"${method}" can never be called from a remote device.`
  const needed = (Object.keys(RULES) as Scope[]).filter((s) => RULES[s].some((r) => matches(r, method)))
  if (needed.length === 0) return `"${method}" is not exposed to remote devices.`
  const missing = needed.filter((s) => !scopes.includes(s))
  if (missing.length === 0) return `"${method}" was refused.`
  return `"${method}" needs the ${missing.map((s) => `"${s}"`).join(' or ')} permission, which this device does not have.`
}

/**
 * Events the bridge refuses to forward to any device under any circumstances.
 *
 * `shell.data` is the important one. It is broadcast by the gateway with a
 * `shellId` but no `sessionKey`, so every authenticated client receives the raw
 * byte stream of every terminal anyone has open, including ones opened on the Mac
 * itself. The bridge re-scopes it by shell ownership rather than passing it on, so
 * it is handled explicitly in the connection layer, never by the generic fan-out.
 */
export const NEVER_FORWARD_EVENTS = new Set(['shell.data', 'gateway.telemetry', 'whatsapp.qr', 'provider.oauth_url'])
