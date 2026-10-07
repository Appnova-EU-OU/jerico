import { describe, expect, test } from 'bun:test'
import { consentSatisfied } from '@jerico/shared'

describe('consent version comparison', () => {
  test.each([
    [undefined, 1, false],
    [1, 1, true],
    [1, 2, false],
    [2, 2, true],
    [2, 1, false],
    ['1', 1, false],
  ] as const)('%p against current %p returns %p', (stored, current, expected) => {
    expect(consentSatisfied(stored, current)).toBe(expected)
  })
})
