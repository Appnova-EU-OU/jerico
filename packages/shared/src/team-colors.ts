/**
 * Shared 8-color preset palette for entity colors (teams, personas).
 *
 * Lifted verbatim from the web console's persona modal palette
 * so server-side round-robin auto-assign + web swatch picker stay in sync.
 *
 * Order is load-bearing: server `getOrCreateTeam` uses index = teamCount % 8 to
 * deterministically pick a color for new teams. Reordering this array changes
 * the color of every newly-created team but never touches stored hex values.
 */
export const TEAM_PRESET_COLORS = [
  '#6366f1',  // indigo  (matches workspaces.color / personas.color default)
  '#ef4444',  // red
  '#f59e0b',  // amber
  '#10b981',  // emerald
  '#06b6d4',  // cyan
  '#8b5cf6',  // violet
  '#ec4899',  // pink
  '#64748b',  // slate
] as const

export type TeamPresetColor = typeof TEAM_PRESET_COLORS[number]

export const TEAM_DEFAULT_COLOR: TeamPresetColor = '#6366f1'

/** Strict hex `#RRGGBB` regex used by both API validation and web picker. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value)
}

/**
 * Pick a preset color deterministically from a non-negative integer index.
 * Used by `getOrCreateTeam` round-robin so the Nth team in a workspace gets
 * `TEAM_PRESET_COLORS[N % 8]`.
 */
export function pickPresetColor(index: number): TeamPresetColor {
  const safe = Math.max(0, Math.floor(index))
  return TEAM_PRESET_COLORS[safe % TEAM_PRESET_COLORS.length]!
}

/**
 * WCAG-style relative-luminance contrast ratio between two hex colors.
 * Used by the web picker to surface a soft (non-blocking) warning when a
 * user-picked custom hex has contrast <3:1 against the panel chrome bg.
 */
export function hexContrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA)
  const lB = relativeLuminance(hexB)
  if (lA === null || lB === null) return 1
  const lighter = Math.max(lA, lB)
  const darker  = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(hex: string): number | null {
  if (!HEX_COLOR_RE.test(hex)) return null
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const c = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
}

/** Panel chrome background — used as the contrast reference for custom hex picks. */
export const PANEL_CHROME_BG = '#111113'

/**
 * Deterministic integer hash from a string (stable across runs/runtimes).
 * Simple Bernstein hash — good enough for deterministic color distribution.
 */
export function hashStringToIndex(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * Resolve a project's display color: explicit override → hash-based auto from id.
 * Guaranteed to return a valid hex from TEAM_PRESET_COLORS.
 */
export const colorForProject = (p: { color?: string | null; id: string }): string =>
  p.color && isValidHexColor(p.color) ? p.color : pickPresetColor(hashStringToIndex(p.id))
