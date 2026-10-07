import { describe, test, expect } from 'bun:test'
import { isPathStale, daysSince } from '../test-utils/path-staleness.js'

describe('isPathStale', () => {
  test('returns false for undefined', () => {
    expect(isPathStale(undefined)).toBe(false)
  })

  test('returns false for null', () => {
    expect(isPathStale(null)).toBe(false)
  })

  test('returns false for fresh timestamp', () => {
    const fresh = new Date(Date.now() - 1000).toISOString()
    expect(isPathStale(fresh)).toBe(false)
  })

  test('returns false for 6-day-old timestamp', () => {
    const sixDays = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString()
    expect(isPathStale(sixDays)).toBe(false)
  })

  test('returns true for 8-day-old timestamp', () => {
    const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    expect(isPathStale(eightDays)).toBe(true)
  })

  test('returns true for 7-days-and-1ms-old timestamp', () => {
    const sevenDays = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 - 1).toISOString()
    expect(isPathStale(sevenDays)).toBe(true)
  })
})

describe('daysSince', () => {
  test('returns undefined for undefined', () => {
    expect(daysSince(undefined)).toBeUndefined()
  })

  test('returns 0 for fresh timestamp', () => {
    const fresh = new Date(Date.now() - 1000).toISOString()
    expect(daysSince(fresh)).toBe(0)
  })

  test('returns 8 for 8-day-old timestamp', () => {
    const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    expect(daysSince(eightDays)).toBe(8)
  })
})

describe('property: isPathStale', () => {
  test('never crashes with random date strings', () => {
    const bases = [
      new Date().toISOString(),
      '2020-01-01T00:00:00Z',
      'invalid-date',
      '',
      '0',
    ]
    for (const base of bases) {
      let threw = false
      try { isPathStale(base) } catch { threw = true }
      expect(threw).toBe(false)
    }
  })
})
