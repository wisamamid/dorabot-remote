import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Params that carry a filesystem path in fs.* and search.* gateway calls. */
const PATH_PARAMS = ['path', 'root', 'cwd', 'dir', 'directory', 'file', 'from', 'to', 'src', 'dest', 'source', 'destination']

const HOME_DENIED = [
  '.dorabot',
  '.config',
  '.ssh',
  '.gnupg',
  '.aws',
  '.netrc',
  '.npmrc',
  '.docker',
  '.kube',
  'Library/Keychains',
]

const PATH_GUARDED = /^(fs\.|search\.(files|ripgrep)$)/

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
  for (const seg of path.split(sep)) {
    const s = seg.toLowerCase()
    if (s === '.env' || s.startsWith('.env.')) return true
    if (s.endsWith('.pem') || s.endsWith('.p8') || s.endsWith('.key')) return true
  }
  return false
}

/**
 * Returns an error message when a path-like param of an fs.* / search.* call
 * touches protected material, else null. For searches, a root that merely
 * contains a protected directory is refused too, because the gateway walk would
 * descend into it.
 */
export function checkPathParams(
  method: string,
  params: Record<string, unknown>,
  extraDenied: string[] = [],
  home = homedir(),
): string | null {
  if (!isPathGuarded(method)) return null
  const denied = deniedDirs(extraDenied, home)
  const isSearch = method.startsWith('search.')
  const candidates: string[] = []
  for (const k of PATH_PARAMS) {
    const v = params[k]
    if (typeof v === 'string' && v) candidates.push(v)
  }
  if (Array.isArray(params.paths)) for (const v of params.paths) if (typeof v === 'string') candidates.push(v)
  // fs.* defaults to the gateway cwd for relative paths; resolving against home
  // is the stricter reading for ".." escapes.
  for (const c of candidates) {
    const p = normalisePath(c, home)
    if (denied.some((d) => within(p, d)) || sensitiveSegment(p)) {
      return `access to "${c}" is blocked: it holds credentials or private data that remote devices may not read.`
    }
    if (isSearch && denied.some((d) => within(d, p))) {
      return `searching "${c}" is blocked because it contains protected folders; search a narrower project folder instead.`
    }
  }
  return null
}
