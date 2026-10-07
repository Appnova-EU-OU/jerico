import { describe, test, expect } from 'bun:test'
import {
  TEAM_PRESET_COLORS,
  TEAM_DEFAULT_COLOR,
  isValidHexColor,
  pickPresetColor,
  hexContrastRatio,
  PANEL_CHROME_BG,
} from '../team-colors.js'

describe('TEAM_PRESET_COLORS palette', () => {
  test('has exactly 8 entries', () => {
    expect(TEAM_PRESET_COLORS.length).toBe(8)
  })

  test('every entry is a valid #RRGGBB hex', () => {
    for (const c of TEAM_PRESET_COLORS) expect(isValidHexColor(c)).toBe(true)
  })

  test('default color matches first palette entry (workspaces.color / personas.color precedent)', () => {
    expect(TEAM_DEFAULT_COLOR).toBe('#6366f1')
    expect(TEAM_PRESET_COLORS[0]).toBe('#6366f1')
  })

  test('no duplicate colors', () => {
    expect(new Set(TEAM_PRESET_COLORS).size).toBe(TEAM_PRESET_COLORS.length)
  })
})

describe('pickPresetColor round-robin', () => {
  test('index 0..7 cycles through the palette in order', () => {
    for (let i = 0; i < TEAM_PRESET_COLORS.length; i++) {
      expect(pickPresetColor(i)).toBe(TEAM_PRESET_COLORS[i]!)
    }
  })

  test('wraps via modulo at index 8, 16, 24 (deterministic for 25-team batch)', () => {
    for (let i = 0; i < 25; i++) {
      expect(pickPresetColor(i)).toBe(TEAM_PRESET_COLORS[i % TEAM_PRESET_COLORS.length]!)
    }
  })

  test('negative / fractional indices clamp to 0', () => {
    expect(pickPresetColor(-1)).toBe(TEAM_PRESET_COLORS[0]!)
    expect(pickPresetColor(0.7)).toBe(TEAM_PRESET_COLORS[0]!)
  })
})

describe('isValidHexColor', () => {
  test('accepts #RRGGBB', () => {
    expect(isValidHexColor('#6366f1')).toBe(true)
    expect(isValidHexColor('#ABCDEF')).toBe(true)
  })

  test('rejects shorthand, missing #, wrong length, non-hex chars, non-strings', () => {
    expect(isValidHexColor('#abc')).toBe(false)
    expect(isValidHexColor('6366f1')).toBe(false)
    expect(isValidHexColor('#6366f1ff')).toBe(false)
    expect(isValidHexColor('#zzzzzz')).toBe(false)
    expect(isValidHexColor(null)).toBe(false)
    expect(isValidHexColor(123)).toBe(false)
  })
})

describe('hexContrastRatio', () => {
  test('black vs white is the maximum 21:1', () => {
    expect(Math.round(hexContrastRatio('#000000', '#ffffff'))).toBe(21)
  })

  test('panel chrome bg is dark — white text has high contrast', () => {
    expect(hexContrastRatio('#ffffff', PANEL_CHROME_BG)).toBeGreaterThan(15)
  })

  test('a pitch-black color against panel chrome triggers the low-contrast guard (<3)', () => {
    expect(hexContrastRatio('#0a0a0a', PANEL_CHROME_BG)).toBeLessThan(3)
  })

  test('every preset color passes the >=3:1 guard against panel chrome', () => {
    for (const c of TEAM_PRESET_COLORS) {
      expect(hexContrastRatio(c, PANEL_CHROME_BG)).toBeGreaterThanOrEqual(3)
    }
  })
})
