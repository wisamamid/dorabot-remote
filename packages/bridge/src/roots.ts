/**
 * STUB: shared-folder roots. Written by the S3 branch only so the control page and
 * CLI have something to call. When merging, REPLACE this file with S2's real roots
 * module, which exposes the same three functions (sync or async; callers `await`).
 * Persists to <bridge data dir>/roots.json.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolvePaths } from './config.js'

function file(): string {
  return join(resolvePaths().root, 'roots.json')
}

function read(): string[] {
  try {
    const v = JSON.parse(readFileSync(file(), 'utf8')) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function write(roots: string[]): void {
  const f = file()
  mkdirSync(resolvePaths().root, { recursive: true, mode: 0o700 })
  writeFileSync(f, JSON.stringify(roots, null, 2), { mode: 0o600 })
}

export function listRoots(): string[] {
  return read()
}

export function addRoot(path: string): string[] {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Use an absolute path, e.g. /Users/you/Projects')
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('That folder does not exist')
  const real = realpathSync(path)
  if (real === '/') throw new Error('Sharing the whole disk is not allowed')
  const roots = read()
  if (!roots.includes(real)) write([...roots, real])
  return listRoots()
}

export function removeRoot(path: string): string[] {
  write(read().filter((r) => r !== path))
  return listRoots()
}
