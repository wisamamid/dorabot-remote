import { describe, expect, it } from 'vitest'
import type { StoredSession } from '@dorabot-remote/protocol'
import { normalizePins, partitionPinned, setPinned, withPin, type Pin } from './pins.js'

const row = (key: string) => ({ key, session: { id: key } as StoredSession })

describe('normalizePins', () => {
  it('sorts newest first, dedupes and drops junk', () => {
    expect(
      normalizePins([{ id: 'a', pinnedAt: 1 }, { id: 'b', pinnedAt: 3 }, { id: 'a', pinnedAt: 9 }, null, { pinnedAt: 4 }, { id: 'c', pinnedAt: 2 }]),
    ).toEqual([{ id: 'b', pinnedAt: 3 }, { id: 'c', pinnedAt: 2 }, { id: 'a', pinnedAt: 1 }])
    expect(normalizePins(undefined)).toEqual([])
  })
})

describe('withPin', () => {
  it('adds on top, removes, and is idempotent', () => {
    const base: Pin[] = [{ id: 'a', pinnedAt: 1 }]
    expect(withPin(base, 'b', true, 5)).toEqual([{ id: 'b', pinnedAt: 5 }, { id: 'a', pinnedAt: 1 }])
    expect(withPin(base, 'a', true, 9)).toBe(base)
    expect(withPin(base, 'a', false)).toEqual([])
    expect(withPin(base, 'z', false)).toBe(base)
  })
})

describe('partitionPinned', () => {
  it('puts pinned rows first in pin order and leaves the rest in their order', () => {
    const rows = [row('x'), row('a'), row('y'), row('b')]
    const { pinned, rest } = partitionPinned(rows, [{ id: 'b', pinnedAt: 2 }, { id: 'a', pinnedAt: 1 }, { id: 'gone', pinnedAt: 0 }])
    expect(pinned.map((r) => r.key)).toEqual(['b', 'a'])
    expect(rest.map((r) => r.key)).toEqual(['x', 'y'])
  })
})

describe('setPinned', () => {
  function rig(rpc: (m: string, p: unknown) => Promise<unknown>, initial: Pin[] = []) {
    let pins = initial
    return {
      get pins() {
        return pins
      },
      deps: {
        rpc: ((m: string, p: unknown) => rpc(m, p)) as never,
        setPins: (u: (prev: Pin[]) => Pin[]) => {
          pins = u(pins)
        },
      },
    }
  }

  it('applies optimistically, then adopts the bridge list', async () => {
    let seen: Pin[] = []
    const r = rig(async (m, p) => {
      expect(m).toBe('remote.pins.set')
      expect(p).toEqual({ id: 'a', pinned: true })
      seen = r.pins
      return { pins: [{ id: 'a', pinnedAt: 42 }] }
    })
    await setPinned(r.deps, 'a', true)
    expect(seen.map((p) => p.id)).toEqual(['a'])
    expect(r.pins).toEqual([{ id: 'a', pinnedAt: 42 }])
  })

  it('rolls back a failed pin without touching other pins', async () => {
    const r = rig(async () => {
      throw new Error('nope')
    }, [{ id: 'k', pinnedAt: 1 }])
    await expect(setPinned(r.deps, 'a', true)).rejects.toThrow('nope')
    expect(r.pins).toEqual([{ id: 'k', pinnedAt: 1 }])
  })

  it('rolls back a failed unpin, restoring the original timestamp', async () => {
    const r = rig(async () => {
      throw new Error('nope')
    }, [{ id: 'a', pinnedAt: 7 }])
    await expect(setPinned(r.deps, 'a', false)).rejects.toThrow()
    expect(r.pins).toEqual([{ id: 'a', pinnedAt: 7 }])
  })
})
