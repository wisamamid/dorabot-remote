/**
 * Approval risk classifier, shared by the phone and the bridge so both agree on what
 * counts as risky. Pure: no I/O, no clock, no platform APIs.
 *
 * It is a heuristic read of a tool call, not a sandbox. Its jobs: (1) put a red
 * "Risky" badge and a reason on the approval, (2) demand a fresh Face ID before a
 * risky approval, (3) keep "always allow" rules from ever covering a risky input.
 * It errs towards flagging.
 */

export interface RiskAssessment {
  risky: boolean
  /** Short human reasons, most important first. Empty when not risky. */
  reasons: string[]
}

export interface RiskContext {
  /** The session's working directory, when known. Enables the "outside the session folder" check. */
  cwd?: string
  /** Home directory, used to expand `~` and to spot dotfiles under it. */
  home?: string
  /** The gateway's own "this path is outside what is allowed" flag on an approval. */
  blockedPath?: string
}

const SAFE = { risky: false, reasons: [] as string[] }

/** Command position: start of line, or after a separator / grouping / sudo-like prefix. */
const CMD = String.raw`(?:^|[;&|(\`\n]|\$\()\s*(?:(?:env|command|exec|time|nohup|xargs)\s+(?:-\S+\s+)*)?`

const BASH_RULES: Array<{ re: RegExp; reason: string }> = [
  { re: new RegExp(CMD + String.raw`(?:rm|rmdir|unlink|shred|srm)\b`), reason: 'Deletes files (rm)' },
  { re: /(?:^|\s)-[a-zA-Z]*r[a-zA-Z]*f|(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force|--force\s+--recursive/, reason: 'Recursive force delete (-rf)' },
  { re: /\bfind\b[^|;&]*(?:-delete\b|-exec\s+rm\b)/, reason: 'Deletes files (find -delete)' },
  { re: new RegExp(CMD + String.raw`(?:sudo|doas)\b`), reason: 'Runs with administrator rights (sudo)' },
  { re: new RegExp(CMD + String.raw`su\s+-?\w*(?:\s|$)`), reason: 'Switches user (su)' },
  { re: /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*push\b/, reason: 'Pushes to a git remote' },
  { re: /\bgit\b[^|;&]*(?:--force\b|--force-with-lease\b|\s-f\b)/, reason: 'Force-flag on a git command' },
  { re: /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*reset\s+(?:[^|;&]*\s)?--hard\b/, reason: 'git reset --hard discards work' },
  { re: /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*clean\b/, reason: 'git clean deletes untracked files' },
  { re: /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/, reason: 'Discards all working-tree changes' },
  { re: /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*branch\s+(?:[^|;&]*\s)?-D\b/, reason: 'Force-deletes a git branch' },
  { re: new RegExp(CMD + String.raw`(?:chmod|chown|chgrp)\b`), reason: 'Changes file permissions or ownership' },
  { re: /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/, reason: 'Pipes a download into a shell' },
  { re: /\b(?:bash|sh|zsh)\s+<\(\s*(?:curl|wget)\b/, reason: 'Runs a downloaded script' },
  { re: new RegExp(CMD + String.raw`(?:mkfs(?:\.\w+)?|fdisk|parted|diskutil\s+(?:erase|partition|reformat)\w*)\b`), reason: 'Formats or partitions a disk' },
  { re: /\bdd\s+[^|;&]*\b(?:if|of)=/, reason: 'Raw disk copy (dd)' },
  { re: />\s*\/dev\/(?:sd|disk|nvme|rdisk)/, reason: 'Writes to a disk device' },
  { re: new RegExp(CMD + String.raw`(?:shutdown|reboot|halt|poweroff|killall|pkill)\b`), reason: 'Shuts down or kills processes' },
  { re: /\bkill\s+-(?:9|KILL)\b/, reason: 'Force-kills a process' },
  {
    re: /\bcurl\b[^|;&]*(?:\s-[a-zA-Z]*[dFT]\b|\s--(?:data|data-\w+|form|upload-file|json)\b|\s-X\s*(?:POST|PUT|PATCH)\b)/i,
    reason: 'Uploads data over the network (curl)',
  },
  { re: /\bwget\b[^|;&]*--(?:post-data|post-file|body-data|body-file)\b/, reason: 'Uploads data over the network (wget)' },
  { re: new RegExp(CMD + String.raw`(?:scp|sftp|ftp|rsync|nc|ncat|netcat|socat|rclone|aws\s+s3\s+(?:cp|sync|mv))\b`), reason: 'Transfers data to another machine' },
  { re: /\bnpm\s+publish\b|\bgh\s+(?:release\s+create|repo\s+delete)\b/, reason: 'Publishes or deletes something remotely' },
  { re: /(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.[A-Za-z]/, reason: 'Writes into a dotfile in the home folder' },
  { re: /\bsed\s+(?:-\S+\s+)*-i\S*\s[^|;&]*(?:~|\$HOME)\/\.[A-Za-z]/, reason: 'Edits a dotfile in the home folder' },
  { re: /(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?\/(?:etc|usr|bin|sbin|System|Library|var|opt|private)\b/, reason: 'Writes to a system folder' },
]

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Hidden files that are ordinary project config, not credentials or shell setup. */
const BENIGN_DOT = new Set([
  '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.prettierignore', '.eslintrc', '.eslintignore',
  '.npmignore', '.dockerignore', '.nvmrc', '.node-version', '.env.example', '.github', '.vscode', '.gitkeep',
])

const SYSTEM_PREFIXES = ['/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/var', '/opt', '/private', '/dev', '/boot', '/sys', '/proc']

export function writePathOf(input: Record<string, unknown>): string | null {
  const p = input.file_path ?? input.notebook_path ?? input.path
  return typeof p === 'string' && p ? p : null
}

function normalize(path: string, base: string | undefined, home: string | undefined): string | null {
  let p = path
  if (p === '~' || p.startsWith('~/')) {
    if (!home) return null
    p = home.replace(/\/+$/, '') + p.slice(1)
  }
  if (!p.startsWith('/')) {
    if (!base) return null
    p = base.replace(/\/+$/, '') + '/' + p
  }
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

function within(path: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, '')
  return path === d || path.startsWith(d + '/')
}

function assessWritePath(path: string, ctx: RiskContext): string[] {
  const reasons: string[] = []
  const abs = normalize(path, ctx.cwd, ctx.home)
  const segs = (abs ?? path).split('/').filter(Boolean)
  const hidden = segs.filter((s) => s.startsWith('.') && s !== '.' && s !== '..' && !BENIGN_DOT.has(s) && !s.startsWith('.env.example'))
  if (hidden.length > 0) reasons.push(`Writes to a dotfile (${hidden[0]})`)
  if (abs && SYSTEM_PREFIXES.some((p) => within(abs, p))) reasons.push('Writes to a system folder')
  else if (abs && ctx.cwd && !within(abs, normalize(ctx.cwd, undefined, ctx.home) ?? ctx.cwd)) reasons.push('Writes outside the session folder')
  else if (!abs && /(^|\/)\.\.(\/|$)/.test(path)) reasons.push('Writes outside the session folder')
  return reasons
}

export function assessRisk(toolName: string, input: Record<string, unknown> | undefined | null, ctx: RiskContext = {}): RiskAssessment {
  const inp = input ?? {}
  const reasons: string[] = []
  if (toolName === 'Bash' || toolName === 'BashOutput' || typeof inp.command === 'string') {
    const cmd = typeof inp.command === 'string' ? inp.command : ''
    for (const r of BASH_RULES) if (r.re.test(cmd) && !reasons.includes(r.reason)) reasons.push(r.reason)
  }
  if (WRITE_TOOLS.has(toolName)) {
    const p = writePathOf(inp)
    if (p) reasons.push(...assessWritePath(p, ctx))
  }
  if (ctx.blockedPath && !reasons.some((r) => r.startsWith('Writes outside'))) reasons.push(`Outside allowed paths (${ctx.blockedPath})`)
  return reasons.length === 0 ? { ...SAFE, reasons: [] } : { risky: true, reasons }
}

export function isRisky(toolName: string, input: Record<string, unknown> | undefined | null, ctx: RiskContext = {}): boolean {
  return assessRisk(toolName, input, ctx).risky
}

// ---------------------------------------------------------------------------
// Always-allow rules
// ---------------------------------------------------------------------------

/**
 * A bridge-managed auto-approve rule.
 *  - `tool`: every non-risky call of `toolName`. Never valid for Bash.
 *  - `exact`: only this exact Bash command.
 */
export interface AllowRuleSpec {
  kind: 'tool' | 'exact'
  toolName: string
  /** For `exact`: the command string. */
  command?: string
}

/** Which rule, if any, may be offered for this approval. Null for risky ones and for shell-like tools in general. */
export function offerableRule(toolName: string, input: Record<string, unknown> | undefined | null, ctx: RiskContext = {}): AllowRuleSpec | null {
  if (isRisky(toolName, input, ctx)) return null
  const cmd = input?.command
  if (toolName === 'Bash') return typeof cmd === 'string' && cmd.trim() ? { kind: 'exact', toolName, command: cmd } : null
  // Anything that takes a free-form command is treated like Bash.
  if (typeof cmd === 'string') return null
  if (!toolName || toolName.length > 120) return null
  return { kind: 'tool', toolName }
}

/** Does `rule` cover this request? Risky inputs are never covered, whatever the rule says. */
export function ruleMatches(rule: AllowRuleSpec, toolName: string, input: Record<string, unknown> | undefined | null, ctx: RiskContext = {}): boolean {
  if (rule.toolName !== toolName) return false
  if (isRisky(toolName, input, ctx)) return false
  if (rule.kind === 'exact') return toolName === 'Bash' && typeof input?.command === 'string' && input.command === rule.command
  return toolName !== 'Bash' && typeof input?.command !== 'string'
}

// ---------------------------------------------------------------------------
// Preview and diff
// ---------------------------------------------------------------------------

export type DiffOp = { t: 'ctx' | 'add' | 'del'; text: string }

/** Line diff (LCS). Inputs over `maxLines` fall back to whole-block del/add so a huge file cannot stall the UI. */
export function lineDiff(before: string, after: string, maxLines = 1500): DiffOp[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  if (a.length > maxLines || b.length > maxLines) return [...a.map((text) => ({ t: 'del' as const, text })), ...b.map((text) => ({ t: 'add' as const, text }))]
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let ea = a.length
  let eb = b.length
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) {
    ea--
    eb--
  }
  const x = a.slice(start, ea)
  const y = b.slice(start, eb)
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const out: DiffOp[] = a.slice(0, start).map((text) => ({ t: 'ctx' as const, text }))
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ t: 'ctx', text: x[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ t: 'del', text: x[i++]! })
    else out.push({ t: 'add', text: y[j++]! })
  }
  while (i < x.length) out.push({ t: 'del', text: x[i++]! })
  while (j < y.length) out.push({ t: 'add', text: y[j++]! })
  for (const text of a.slice(ea)) out.push({ t: 'ctx', text })
  return out
}

export interface EditPair {
  oldText: string
  newText: string
}

export type ToolPreview =
  | { kind: 'command'; command: string; description?: string }
  | { kind: 'edit'; path: string; edits: EditPair[] }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'fields'; fields: Array<{ key: string; value: string }> }

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v))
const PREVIEW_KEYS = ['url', 'query', 'prompt', 'description', 'subagent_type', 'pattern', 'path', 'action', 'selector', 'text', 'name', 'title']

export function buildPreview(toolName: string, input: Record<string, unknown> | undefined | null): ToolPreview {
  const inp = input ?? {}
  if (typeof inp.command === 'string') {
    return { kind: 'command', command: inp.command, ...(typeof inp.description === 'string' && inp.description ? { description: inp.description } : {}) }
  }
  const path = writePathOf(inp)
  if (path && Array.isArray(inp.edits) && toolName === 'MultiEdit') {
    const edits = (inp.edits as Array<Record<string, unknown>>).map((e) => ({ oldText: str(e?.old_string), newText: str(e?.new_string) }))
    return { kind: 'edit', path, edits }
  }
  if (path && typeof inp.old_string === 'string') return { kind: 'edit', path, edits: [{ oldText: inp.old_string, newText: str(inp.new_string) }] }
  if (path && typeof inp.content === 'string') return { kind: 'write', path, content: inp.content }
  if (path && typeof inp.new_source === 'string') return { kind: 'write', path, content: inp.new_source }
  const fields: Array<{ key: string; value: string }> = []
  const seen = new Set<string>()
  for (const k of PREVIEW_KEYS) if (inp[k] !== undefined && inp[k] !== '') (fields.push({ key: k, value: str(inp[k]) }), seen.add(k))
  for (const [k, v] of Object.entries(inp)) {
    if (seen.has(k) || v === undefined || v === '' || fields.length >= 8) continue
    fields.push({ key: k, value: str(v) })
  }
  return { kind: 'fields', fields }
}
