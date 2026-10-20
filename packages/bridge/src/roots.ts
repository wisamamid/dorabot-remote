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
  /** Canonical (realpath) absolute folders currently shared. */
  listRoots(): string[]
  /** Validate and add a folder. Throws with a user-readable message when refused. Returns the stored path. */
  addRoot(path: string): string
  /** Remove a folder. Returns whether it was shared. */
  removeRoot(path: string): boolean
}

export interface RootsOptions {
  /** Bridge/dorabot data dirs. A root may not be one of these or a parent of one. */
  protectedPaths?: () => string[]
  home?: string
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

  const read = (): string[] => {
    try {
      const parsed = JSON.parse(readFileSync(fileOf(), 'utf8')) as { roots?: unknown }
      if (!Array.isArray(parsed.roots)) return []
      return parsed.roots.filter((r): r is string => typeof r === 'string' && isAbsolute(r))
    } catch {
      return []
    }
  }

  const write = (roots: string[]): void => {
    const file = fileOf()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ roots }, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  }

  return {
    listRoots: read,

    addRoot(input: string): string {
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
      const roots = read()
      if (!roots.some((r) => lc(r) === lc(real))) write([...roots, real])
      return real
    },

    removeRoot(input: string): boolean {
      const real = lc(canon(input))
      const roots = read()
      const next = roots.filter((r) => lc(r) !== real && lc(r) !== lc(resolve(input)))
      if (next.length === roots.length) return false
      write(next)
      return true
    },
  }
}
