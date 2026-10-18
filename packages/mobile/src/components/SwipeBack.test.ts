import { describe, expect, it } from 'vitest'
import { lockDirection, shouldComplete } from './SwipeBack.js'

describe('shouldComplete', () => {
  it('commits past 35% of the width', () => {
    expect(shouldComplete(140, 390, 0)).toBe(true)
    expect(shouldComplete(100, 390, 0)).toBe(false)
  })
  it('commits on a fast flick even when short', () => {
    expect(shouldComplete(60, 390, 0.8)).toBe(true)
  })
  it('a flick that barely moved does not commit', () => {
    expect(shouldComplete(5, 390, 2)).toBe(false)
  })
  it('a leftward flick never commits', () => {
    expect(shouldComplete(10, 390, -1)).toBe(false)
  })
})

describe('lockDirection', () => {
  it('waits for movement', () => {
    expect(lockDirection(3, 2)).toBe('undecided')
  })
  it('takes a mostly horizontal rightward drag', () => {
    expect(lockDirection(20, 5)).toBe('back')
  })
  it('leaves vertical and leftward drags alone', () => {
    expect(lockDirection(5, 30)).toBe('other')
    expect(lockDirection(-20, 2)).toBe('other')
  })
})
