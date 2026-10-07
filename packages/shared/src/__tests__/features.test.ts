import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { isFeatureEnabled, enabledFeatures } from '../features.js'

describe('isFeatureEnabled', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env['JERICO_FEATURES']
  })

  afterEach(() => {
    if (original === undefined) delete process.env['JERICO_FEATURES']
    else process.env['JERICO_FEATURES'] = original
  })

  test('unset env → all flags false', () => {
    delete process.env['JERICO_FEATURES']
    expect(isFeatureEnabled('anything')).toBe(false)
    expect(enabledFeatures()).toEqual([])
  })

  test('single flag', () => {
    process.env['JERICO_FEATURES'] = 'test.flag'
    expect(isFeatureEnabled('test.flag')).toBe(true)
    expect(isFeatureEnabled('other.flag')).toBe(false)
    expect(enabledFeatures()).toEqual(['test.flag'])
  })

  test('multiple flags', () => {
    process.env['JERICO_FEATURES'] = 'a,b,c'
    expect(isFeatureEnabled('a')).toBe(true)
    expect(isFeatureEnabled('b')).toBe(true)
    expect(isFeatureEnabled('c')).toBe(true)
    expect(isFeatureEnabled('d')).toBe(false)
    expect(enabledFeatures()).toEqual(['a', 'b', 'c'])
  })

  test('whitespace trimming', () => {
    process.env['JERICO_FEATURES'] = ' a , b , c '
    expect(isFeatureEnabled('a')).toBe(true)
    expect(isFeatureEnabled('b')).toBe(true)
    expect(isFeatureEnabled('c')).toBe(true)
    expect(enabledFeatures()).toEqual(['a', 'b', 'c'])
  })

  test('empty tokens ignored', () => {
    process.env['JERICO_FEATURES'] = ',a,,b,'
    expect(isFeatureEnabled('a')).toBe(true)
    expect(isFeatureEnabled('b')).toBe(true)
    expect(enabledFeatures()).toEqual(['a', 'b'])
  })

  test('mutating env reflects immediately (no cache)', () => {
    process.env['JERICO_FEATURES'] = 'first'
    expect(isFeatureEnabled('first')).toBe(true)
    expect(isFeatureEnabled('second')).toBe(false)

    process.env['JERICO_FEATURES'] = 'second'
    expect(isFeatureEnabled('first')).toBe(false)
    expect(isFeatureEnabled('second')).toBe(true)
  })
})
