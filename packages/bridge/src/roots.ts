import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * The folders a phone may browse, search and run git against. Nothing is shared
 * until the user adds a folder on the Mac. Stored as a small JSON file under the
 * bridge data dir and re-read on every call, so the CLI (another process) and the
 * control page see each other's edits without a restart.
 */
export interface RootsStore {
  /** Canonical (realpath) absolute folders currently shared. Folders whose time limit has passed are not listed. */
  listRoots(): string[]
  /** Time-limited folders only: path -> epoch ms it lapses. */
  listExpiry(): Record<string, number>
  /**
   * Validate and add a folder. Throws with a user-readable message when refused. Returns the stored path.
   * `expiresAt` makes the share temporary; re-adding a folder replaces its limit (none = permanent).
   */
  addRoot(path: string, opts?: { expiresAt?: number | null }): string
  /** Remove a folder. Returns whether it was shared. */
  removeRoot(path: string): boolean
  /** Remove folders whose time limit has passed. Returns the removed paths. */
  sweepExpired(now?: number): string[]
}

export interface RootsOptions {
  /** Bridge/dorabot data dirs. A root may not be one of these or a parent of one. */
  protectedPaths?: () => string[]
  home?: string
  now?: () => number
}

export function rootsFilePath(bridgeRoot: string): string {
  return join(bridgeRoot, 'shared-folders.json')
}

const lc = (p: string): string => p.toLowerCase()

function isWithinOrEqual(path: string, dir: string): boolean {
  const a = lc(path)
  const b = lc(dir)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

function canon(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

export function createRootsStore(fileOrFn: string | (() => string), opts: RootsOptions = {}): RootsStore {
  const home = canon(opts.home ?? homedir())
  const fileOf = (): string => (typeof fileOrFn === 'string' ? fileOrFn : fileOrFn())

  const clock = opts.now ?? Date.now

  interface State {
    roots: string[]
    expiry: Record<string, number>
  }
  const readState = (): State => {
    try {
      const parsed = JSON.parse(readFileSync(fileOf(), 'utf8')) as { roots?: unknown; expiry?: unknown }
      if (!Array.isArray(parsed.roots)) return { roots: [], expiry: {} }
      const roots = parsed.roots.filter((r): r is string => typeof r === 'string' && isAbsolute(r))
      const expiry: Record<string, number> = {}
      if (parsed.expiry && typeof parsed.expiry === 'object' && !Array.isArray(parsed.expiry)) {
        for (const [k, v] of Object.entries(parsed.expiry)) if (roots.includes(k) && typeof v === 'number' && Number.isFinite(v)) expiry[k] = v
      }
      return { roots, expiry }
    } catch {
      return { roots: [], expiry: {} }
    }
  }

  /** The policy check: a lapsed folder is not shared, whether or not the sweep has removed it yet. */
  const lapsed = (st: State, at = clock()): ((r: string) => boolean) => (r) => (st.expiry[r] ?? Infinity) <= at
  const read = (): string[] => {
    const st = readState()
    return st.roots.filter((r) => !lapsed(st)(r))
  }

  const write = (st: State): void => {
    const file = fileOf()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    const expiry = Object.fromEntries(Object.entries(st.expiry).filter(([k]) => st.roots.includes(k)))
    writeFileSync(tmp, JSON.stringify({ roots: st.roots, ...(Object.keys(expiry).length ? { expiry } : {}) }, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  }

  return {
    listRoots: read,

    listExpiry(): Record<string, number> {
      const st = readState()
      return Object.fromEntries(Object.entries(st.expiry).filter(([r, at]) => st.roots.includes(r) && at > clock()))
    },

    sweepExpired(now = clock()): string[] {
      const st = readState()
      const gone = st.roots.filter(lapsed(st, now))
      if (gone.length === 0) return []
      write({ roots: st.roots.filter((r) => !gone.includes(r)), expiry: st.expiry })
      return gone
    },

    addRoot(input: string, addOpts: { expiresAt?: number | null } = {}): string {
      if (typeof input !== 'string' || !input.trim()) throw new Error('Folder path required.')
      const raw = input.trim()
      if (!isAbsolute(raw)) throw new Error('Folder path must be absolute.')
      if (raw.split(/[\\/]+/).includes('..')) throw new Error('Folder path may not contain "..".')
      if (!existsSync(raw)) throw new Error(`"${raw}" does not exist.`)
      const real = canon(raw)
      if (!statSync(real).isDirectory()) throw new Error(`"${raw}" is not a folder.`)
      if (real === sep || lc(real) === lc(home)) {
        throw new Error('Sharing / or your whole home folder is not allowed. Pick a specific project folder.')
      }
      for (const raw of opts.protectedPaths?.() ?? []) {
        const p = canon(raw)
        if (isWithinOrEqual(p, real)) {
          throw new Error('That folder contains DoraBot or bridge data and cannot be shared.')
        }
        if (isWithinOrEqual(real, p)) throw new Error('That folder is inside DoraBot or bridge data and cannot be shared.')
      }
      const st = readState()
      const existing = st.roots.find((r) => lc(r) === lc(real))
      const path = existing ?? real
      const roots = existing ? st.roots : [...st.roots, real]
      const expiry = { ...st.expiry }
      if (typeof addOpts.expiresAt === 'number') expiry[path] = addOpts.expiresAt
      else delete expiry[path]
      write({ roots, expiry })
      return path
    },

    removeRoot(input: string): boolean {
      const real = lc(canon(input))
      const st = readState()
      const next = st.roots.filter((r) => lc(r) !== real && lc(r) !== lc(resolve(input)))
      if (next.length === st.roots.length) return false
      write({ roots: next, expiry: st.expiry })
      return true
    },
  }
}
