import { describe, expect, it } from 'vitest'
import { PREV_VALID_MS, ROTATE_EVERY_MS, ackCurrent, dueForRotation, initialState, pruneExpired, rotate, tokenSubject, validGens } from './relay-rotation.js'

const DAY = 86_400_000

describe('relay token rotation state', () => {
  it('generation 0 keeps the original token derivation', () => {
    expect(tokenSubject('dev', 0)).toBe('dev')
    expect(tokenSubject('dev', 3)).toBe('dev#3')
  })

  it('is due 30 days after issue, and only once the phone acked', () => {
    const s = initialState(0, true)
    expect(dueForRotation(s, ROTATE_EVERY_MS - 1)).toBe(false)
    expect(dueForRotation(s, ROTATE_EVERY_MS)).toBe(true)
    expect(dueForRotation({ ...s, acked: false }, 100 * DAY)).toBe(false)
  })

  it('rotating bumps the generation and keeps the old token valid until ack or 7 days', () => {
    const s1 = rotate(initialState(0, true), 100)
    expect(s1).toMatchObject({ gen: 1, issuedAt: 100, acked: false })
    expect(validGens(s1, 100 + PREV_VALID_MS - 1)).toEqual([1, 0])
    expect(validGens(s1, 100 + PREV_VALID_MS)).toEqual([1])
    expect(dueForRotation(s1, 100 + 60 * DAY)).toBe(false) // unacked never rotates on schedule
  })

  it('the ack drops every older generation at once', () => {
    const s = ackCurrent(rotate(initialState(0, true), 100))
    expect(s).toMatchObject({ gen: 1, acked: true, prev: [] })
    expect(validGens(s, 101)).toEqual([1])
  })

  it('a second rotation before any ack keeps the unacked token alive too', () => {
    const s2 = rotate(rotate(initialState(0, true), 100), 200)
    expect(s2.gen).toBe(2)
    expect(validGens(s2, 201)).toEqual([2, 0, 1])
  })

  it('prunes expired older generations', () => {
    const s1 = rotate(initialState(0, true), 100)
    expect(pruneExpired(s1, 100 + PREV_VALID_MS + 1).prev).toEqual([])
    expect(pruneExpired(s1, 101)).toBe(s1)
  })
})
