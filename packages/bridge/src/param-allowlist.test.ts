import { describe, it, expect } from 'vitest'
import { sanitizeParams } from './param-allowlist.js'

describe('param-allowlist', () => {
  describe('sessions.get', () => {
    it('allows sessionId parameter', () => {
      const params = { sessionId: 'sess-123' }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123' })
    })

    it('allows valid before parameter (integer >= 0)', () => {
      const params = { sessionId: 'sess-123', before: 50 }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123', before: 50 })
    })

    it('allows valid limit parameter (integer >= 0 and <= 500)', () => {
      const params = { sessionId: 'sess-123', limit: 100 }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123', limit: 100 })
    })

    it('allows limit of exactly 500', () => {
      const params = { sessionId: 'sess-123', limit: 500 }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123', limit: 500 })
    })

    it('rejects before parameter that is negative', () => {
      const params = { sessionId: 'sess-123', before: -1 }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123' })
      expect(result.before).toBeUndefined()
    })

    it('rejects before parameter that is not an integer', () => {
      const params = { sessionId: 'sess-123', before: 50.5 }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123' })
      expect(result.before).toBeUndefined()
    })

    it('rejects before parameter that is a string', () => {
      const params = { sessionId: 'sess-123', before: '50' as never }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123' })
      expect(result.before).toBeUndefined()
    })

    it('rejects limit parameter that is over 500', () => {
      const params = { sessionId: 'sess-123', limit: 501 }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123' })
      expect(result.limit).toBeUndefined()
    })

    it('rejects limit parameter that is negative', () => {
      const params = { sessionId: 'sess-123', limit: -1 }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123' })
      expect(result.limit).toBeUndefined()
    })

    it('rejects limit parameter that is not an integer', () => {
      const params = { sessionId: 'sess-123', limit: 50.5 }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123' })
      expect(result.limit).toBeUndefined()
    })

    it('rejects unexpected parameters', () => {
      const params = {
        sessionId: 'sess-123',
        before: 50,
        limit: 100,
        malicious: 'value',
      }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({
        sessionId: 'sess-123',
        before: 50,
        limit: 100,
      })
      expect(result.malicious).toBeUndefined()
    })

    it('handles before: 0 (beginning of pagination)', () => {
      const params = { sessionId: 'sess-123', before: 0 }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123', before: 0 })
    })

    it('handles limit: 0 (edge case)', () => {
      const params = { sessionId: 'sess-123', limit: 0 }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({ sessionId: 'sess-123', limit: 0 })
    })

    it('combines before and limit parameters', () => {
      const params = {
        sessionId: 'sess-123',
        before: 100,
        limit: 50,
      }
      const result = sanitizeParams('sessions.get', params, [])
      expect(result).toEqual({
        sessionId: 'sess-123',
        before: 100,
        limit: 50,
      })
    })
  })

  describe('other methods', () => {
    it('does not apply number validation to non-sessions.get methods', () => {
      const params = { id: 'cron-1', before: 'any-value' as never }
      const result = sanitizeParams('cron.toggle', params, [])
      // before is not in the allowlist for cron.toggle, so it should not appear
      expect(result).toEqual({ id: 'cron-1' })
    })
  })
})
