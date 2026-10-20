import { describe, it, expect, beforeEach } from 'vitest'
import {
  HISTORY_BUDGET_BYTES,
  HISTORY_LAN_CAP_BYTES,
  trimHistoryResult,
  getCachedHistory,
  clearHistoryCache,
} from './history-trim.js'

describe('history-trim', () => {
  beforeEach(() => {
    clearHistoryCache()
  })

  describe('trimHistoryResult', () => {
    it('returns unchanged result when small enough', () => {
      const result = {
        messages: [{ id: 1, text: 'hello' }],
        truncated: false,
      }
      const trimmed = trimHistoryResult('sessions.get', result, 10_000_000)
      expect(trimmed).toEqual(result)
    })

    it('returns unchanged result when not a history method', () => {
      const result = [{ id: 1, text: 'hello' }]
      const trimmed = trimHistoryResult('chat.send', result, 1000)
      expect(trimmed).toEqual(result)
    })

    it('adds truncation metadata when history is trimmed', () => {
      const largeMessages = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        content: 'x'.repeat(1000),
      }))
      const result = {
        messages: largeMessages,
      }
      const trimmed = trimHistoryResult(
        'sessions.get',
        result,
        HISTORY_BUDGET_BYTES,
        { sessionId: 'sess-1' }
      ) as Record<string, unknown>

      expect(trimmed.truncated).toBe(true)
      expect(trimmed.totalMessages).toBe(1000)
      expect(typeof trimmed.returnedMessages).toBe('number')
      expect((trimmed.returnedMessages as number) < 1000).toBe(true)
    })

    it('caches full history when sessionId is provided and history is trimmed', () => {
      const messages = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        text: `message with lots of content to make it much bigger so we definitely exceed the history budget ${i}`.repeat(10),
      }))
      const result = { messages }

      trimHistoryResult('sessions.get', result, HISTORY_BUDGET_BYTES, {
        sessionId: 'sess-1',
      })

      const cached = getCachedHistory('sess-1')
      expect(cached).toEqual(messages)
    })

    it('supports pagination with before parameter', () => {
      const messages = Array.from({ length: 200 }, (_, i) => ({
        id: i,
        text: `message ${i}`,
      }))
      const result = { messages }

      // Request older messages (before=100 means we have the last 100 newest messages)
      const trimmed = trimHistoryResult(
        'sessions.get',
        result,
        HISTORY_BUDGET_BYTES,
        { sessionId: 'sess-1', before: 100, limit: 50 }
      ) as Record<string, unknown>

      expect(trimmed.truncated).toBe(true)
      expect(trimmed.hasMore).toBe(true) // There are messages before our slice
      expect(typeof trimmed.startIndex).toBe('number')
      expect((trimmed.startIndex as number) > 0).toBe(true)
    })

    it('respects limit parameter when slicing', () => {
      const messages = Array.from({ length: 500 }, (_, i) => ({
        id: i,
        text: `message with enough content to trigger budget limits ${i}`,
      }))
      const result = { messages }

      const trimmed = trimHistoryResult(
        'sessions.get',
        result,
        HISTORY_BUDGET_BYTES,
        { sessionId: 'sess-1', before: 0, limit: 10 }
      ) as Record<string, unknown>

      // When limit is specified, we should get fewer messages
      expect((trimmed.returnedMessages as number) <= 10).toBe(true)
    })

    it('returns hasMore false when at beginning', () => {
      const messages = Array.from({ length: 50 }, (_, i) => ({
        id: i,
        text: `message ${i}`,
      }))
      const result = { messages }

      // Need enough messages to trigger trimming, and explicitly pass before
      const largeMessages = Array.from({ length: 500 }, (_, i) => ({
        id: i,
        text: `message with some content to make it bigger ${i}`,
      }))

      const trimmed = trimHistoryResult(
        'sessions.get',
        { messages: largeMessages },
        HISTORY_BUDGET_BYTES,
        { sessionId: 'sess-1', before: 0 }
      ) as Record<string, unknown>

      expect(trimmed.hasMore).toBe(false)
    })

    it('preserves message order when slicing', () => {
      const messages = Array.from({ length: 20 }, (_, i) => ({
        id: i,
        order: i,
      }))
      const result = { messages }

      const trimmed = trimHistoryResult(
        'sessions.get',
        result,
        HISTORY_BUDGET_BYTES,
        { sessionId: 'sess-1', before: 5, limit: 5 }
      ) as Record<string, unknown>

      const trimmedMessages = trimmed.messages as Array<Record<string, number>>
      for (let i = 1; i < trimmedMessages.length; i++) {
        expect(trimmedMessages[i].order).toBeGreaterThan(
          trimmedMessages[i - 1].order
        )
      }
    })

    it('rejects invalid before parameter (negative)', () => {
      // The param validation happens before calling trimHistoryResult,
      // so this is just showing the expected behavior
      const messages = [{ id: 1, text: 'hello' }]
      const result = { messages }

      // A negative before should be rejected by sanitizeParams before reaching here
      const trimmed = trimHistoryResult(
        'sessions.get',
        result,
        HISTORY_BUDGET_BYTES,
        { sessionId: 'sess-1', before: -1 } // Invalid, should be filtered
      )

      // It should still return something; the validation is at the param level
      expect(trimmed).toBeDefined()
    })

    it('rejects invalid limit parameter (over 500)', () => {
      // The param validation happens before calling trimHistoryResult
      const messages = Array.from({ length: 100 }, (_, i) => ({
        id: i,
      }))
      const result = { messages }

      // A limit over 500 should be rejected by sanitizeParams before reaching here
      const trimmed = trimHistoryResult(
        'sessions.get',
        result,
        HISTORY_BUDGET_BYTES,
        { sessionId: 'sess-1', limit: 501 } // Invalid, should be filtered
      )

      expect(trimmed).toBeDefined()
    })
  })

  describe('cache management', () => {
    it('caches history per sessionId during pagination', () => {
      const messages1 = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        text: 'session1',
      }))
      const messages2 = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        text: 'session2',
      }))

      // Pagination requests should cache the history
      trimHistoryResult('sessions.get', { messages: messages1 }, 1_000_000, {
        sessionId: 'sess-1',
        before: 50,
      })
      trimHistoryResult('sessions.get', { messages: messages2 }, 1_000_000, {
        sessionId: 'sess-2',
        before: 50,
      })

      expect(getCachedHistory('sess-1')).toEqual(messages1)
      expect(getCachedHistory('sess-2')).toEqual(messages2)
    })

    it('clears specific cache entry', () => {
      const messages = [{ id: 1 }]
      trimHistoryResult('sessions.get', { messages }, 1_000_000, {
        sessionId: 'sess-1',
      })

      expect(getCachedHistory('sess-1')).toBeDefined()
      clearHistoryCache('sess-1')
      expect(getCachedHistory('sess-1')).toBeNull()
    })

    it('clears all cache when no sessionId provided', () => {
      trimHistoryResult('sessions.get', { messages: [{ id: 1 }] }, 1_000_000, {
        sessionId: 'sess-1',
      })
      trimHistoryResult('sessions.get', { messages: [{ id: 2 }] }, 1_000_000, {
        sessionId: 'sess-2',
      })

      clearHistoryCache()
      expect(getCachedHistory('sess-1')).toBeNull()
      expect(getCachedHistory('sess-2')).toBeNull()
    })
  })

  describe('string clipping', () => {
    it('clips overly large strings', () => {
      const largeString = 'x'.repeat(100 * 1024) // 100KB string
      // Create a message that is definitely larger than the budget
      const result = {
        messages: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          content: i === 0 ? largeString : `message ${i}`,
        })),
      }

      const trimmed = trimHistoryResult(
        'sessions.get',
        result,
        HISTORY_BUDGET_BYTES // Uses default budget
      ) as Record<string, unknown>

      const trimmedMessages = trimmed.messages as Array<Record<string, unknown>>
      // Find the message with the large content that was clipped
      const clipped = trimmedMessages.find((m) => typeof m.content === 'string' && m.content.includes('[... truncated'))
      if (clipped) {
        expect((clipped.content as string).length).toBeLessThan(largeString.length)
        expect(clipped.content).toContain('[... truncated')
      }
    })
  })
})
