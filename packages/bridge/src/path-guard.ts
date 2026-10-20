import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * File access model: an ALLOWLIST. A phone may only touch paths inside folders the
 * user explicitly shared on the Mac (see roots.ts); the list starts empty. Inside a
 * shared folder a denylist of credential-shaped material still applies.
 */

export const NOT_SHARED_MESSAGE =
  "This folder isn't shared with your phone. Add it on your Mac: control page > Shared folders."

/** Params that carry a filesystem path in fs.*, search.* and git.* gateway calls. */
const PATH_PARAMS = ['path', 'root', 'cwd', 'dir', 'directory', 'repo', 'repoRoot', 'file', 'from', 'to', 'src', 'dest', 'source', 'destination']
/** git.* params that name a file relative to the repo (`path`), not a standalone path. */
const GIT_REL_PARAMS = ['file', 'previousFilename']
/** git.* params that are standalone paths. */
const GIT_PATH_PARAMS = ['path', 'root', 'cwd', 'dir', 'directory', 'repo', 'repoRoot']

const HOME_DENIED = [
  '.dorabot',
  '.config',
  '.ssh',
  '.gnupg',
  '.aws',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.docker',
  '.kube',
  'Library/Keychains',
]

const PATH_GUARDED = /^(fs\.|git\.|search\.(files|ripgrep)$)/

export function isPathGuarded(method: string): boolean {
  return PATH_GUARDED.test(method)
}

/** Resolve ~, relative paths and symlinks (on the longest existing ancestor). */
export function normalisePath(input: string, home = homedir()): string {
  let p = input
  if (p === '~') p = home
  else if (p.startsWith('~/')) p = join(home, p.slice(2))
  p = isAbsolute(p) ? resolve(p) : resolve(home, p)
  const tail: string[] = []
  let cur = p
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) break
    tail.unshift(basename(cur))
    cur = parent
  }
  try {
    cur = realpathSync(cur)
  } catch {
    // Keep the lexical path.
  }
  return tail.length ? join(cur, ...tail) : cur
}

function lc(p: string): string {
  // macOS volumes are case-insensitive by default.
  return p.toLowerCase()
}

function within(path: string, dir: string): boolean {
  const a = lc(path)
  const b = lc(dir)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

function deniedDirs(extra: string[], home: string): string[] {
  const out = HOME_DENIED.map((d) => normalisePath(join(home, d), home))
  for (const e of extra) out.push(normalisePath(e, home))
  return out
}

function sensitiveSegment(path: string): boolean {
  const segs = path.split(sep).map((s) => s.toLowerCase())
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] ?? ''
    if (s.startsWith('.env')) return true
    if (s.endsWith('.pem') || s.endsWith('.p8') || s.endsWith('.key')) return true
    if (s === '.ssh' || s === '.aws' || s === '.gnupg' || s === '.git-credentials') return true
    if (s === '.netrc' || s === '.npmrc' || s === '.pypirc') return true
    if (s.endsWith('_history')) return true
    // Remote URLs in .git/config often embed tokens.
    if (s === '.git' && segs[i + 1] === 'config') return true
    if (s === 'library' && segs[i + 1] === 'keychains') return true
  }
  return false
}

export interface GuardContext {
  /** Shared folders. Empty means nothing is reachable. */
  roots: string[]
  /** Extra denied dirs (bridge and dorabot data). */
  extraDenied?: string[]
  home?: string
}

/** True when `p` (already normalised) is inside a shared root and not denylisted. */
function pathAllowed(p: string, roots: string[], denied: string[], home: string): 'ok' | 'outside' | 'denied' {
  const canonRoots = roots.map((r) => normalisePath(r, home))
  if (!canonRoots.some((r) => within(p, r))) return 'outside'
  if (denied.some((d) => within(p, d)) || sensitiveSegment(p)) return 'denied'
  return 'ok'
}

const DENIED_MESSAGE = (c: string): string =>
  `access to "${c}" is blocked: it holds credentials or private data that remote devices may not read.`

/**
 * Returns an error message when a path-like param of an fs.* / search.* / git.* call
 * is outside the shared folders or touches protected material, else null.
 */
export function checkPathParams(method: string, params: Record<string, unknown>, ctx: GuardContext): string | null {
  if (!isPathGuarded(method)) return null
  const home = ctx.home ?? homedir()
  const denied = deniedDirs(ctx.extraDenied ?? [], home)
  const isGit = method.startsWith('git.')
  const paths: string[] = []
  const rels: string[] = []
  for (const k of isGit ? GIT_PATH_PARAMS : PATH_PARAMS) {
    const v = params[k]
    if (typeof v === 'string' && v) paths.push(v)
    else if (v !== undefined && v !== null && typeof v !== 'string') return `"${k}" must be a string path.`
  }
  if (!isGit && Array.isArray(params.paths)) for (const v of params.paths) if (typeof v === 'string') paths.push(v)
  if (isGit) for (const k of GIT_REL_PARAMS) {
    const v = params[k]
    if (typeof v === 'string' && v) rels.push(v)
  }
  if (paths.length === 0) return 'a folder path is required.'

  const hasDotDot = (c: string): boolean => c.split(/[\\/]+/).includes('..')
  for (const c of [...paths, ...rels]) {
    if (hasDotDot(c)) return `access to "${c}" is blocked: paths may not contain "..".`
  }
  // Absolute paths only: the gateway resolves relative ones against its own cwd,
  // which this check cannot know.
  for (const c of paths) {
    if (!isAbsolute(c) && c !== '~' && !c.startsWith('~/')) {
      return `"${c}" must be an absolute path.`
    }
  }

  const check = (p: string, label: string): string | null => {
    const r = pathAllowed(p, ctx.roots, denied, home)
    if (r === 'outside') return NOT_SHARED_MESSAGE
    if (r === 'denied') return DENIED_MESSAGE(label)
    return null
  }

  for (const c of paths) {
    const bad = check(normalisePath(c, home), c)
    if (bad) return bad
  }
  if (rels.length) {
    // git file params are relative to the repo; each must stay allowed on its own.
    const repo = normalisePath(paths[0] as string, home)
    for (const f of rels) {
      const bad = check(normalisePath(isAbsolute(f) ? f : join(repo, f), home), f)
      if (bad) return bad
    }
  }
  return null
}

/**
 * Drop search results the phone may not see. The gateway walk does not consult any
 * path check and returns matching lines, so filtering happens on the way out.
 */
export function filterSearchResult(method: string, result: unknown, ctx: GuardContext): unknown {
  if (!/^search\.(files|ripgrep)$/.test(method)) return result
  const home = ctx.home ?? homedir()
  const denied = deniedDirs(ctx.extraDenied ?? [], home)
  const r = result as { results?: unknown } | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.results)) return { results: [] }
  const results = r.results.filter((item) => {
    const p = (item as { path?: unknown } | null)?.path
    if (typeof p !== 'string' || !p) return false
    return pathAllowed(normalisePath(p, home), ctx.roots, denied, home) === 'ok'
  })
  return { ...r, results }
}
