import { describe, it, expect } from 'vitest'
import { sanitizeInputPanelInstanceId, sanitizeInputReplay } from '../types.js'

describe('sanitizeInputPanelInstanceId', () => {
  it('accepts positive safe integers', () => {
    expect(sanitizeInputPanelInstanceId(1)).toBe(1)
    expect(sanitizeInputPanelInstanceId(42)).toBe(42)
    expect(sanitizeInputPanelInstanceId(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('rejects zero, negative, non-integers, and non-numbers', () => {
    expect(sanitizeInputPanelInstanceId(0)).toBeUndefined()
    expect(sanitizeInputPanelInstanceId(-1)).toBeUndefined()
    expect(sanitizeInputPanelInstanceId(1.5)).toBeUndefined()
    expect(sanitizeInputPanelInstanceId(NaN)).toBeUndefined()
    expect(sanitizeInputPanelInstanceId(Infinity)).toBeUndefined()
    expect(sanitizeInputPanelInstanceId('1' as unknown as number)).toBeUndefined()
    expect(sanitizeInputPanelInstanceId(undefined)).toBeUndefined()
    expect(sanitizeInputPanelInstanceId(null as unknown as number)).toBeUndefined()
  })
  it('preserves compatibility: invalid tag is undefined, never coerced', () => {
    expect(sanitizeInputPanelInstanceId({} as unknown as number)).toBeUndefined()
  })
})

describe('sanitizeInputReplay', () => {
  it('only accepts true as replay', () => {
    expect(sanitizeInputReplay(true)).toBe(true)
    expect(sanitizeInputReplay(false)).toBeUndefined()
    expect(sanitizeInputReplay(1 as unknown as boolean)).toBeUndefined()
    expect(sanitizeInputReplay('true' as unknown as boolean)).toBeUndefined()
    expect(sanitizeInputReplay(undefined)).toBeUndefined()
    expect(sanitizeInputReplay(null as unknown as boolean)).toBeUndefined()
  })
})
