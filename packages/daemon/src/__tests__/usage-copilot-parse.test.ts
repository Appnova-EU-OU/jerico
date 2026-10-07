/**
 * The GitHub Copilot usage parser.
 *
 * Fixture is the REAL `copilot_internal/user` response, HTTP 200, measured
 * 2026-08-11. The first test is the one that matters most: an **unlimited** bucket
 * reports `quota_remaining: 0`, so a parser that reads the number without reading
 * the flag draws Copilot's chat allowance as completely exhausted while it is in
 * fact boundless.
 */

import { describe, expect, test } from 'bun:test'
import { parseCopilotUsage, planLabel, readGhToken, readResetDate } from '../usage/providers/copilot.js'

const REAL_PAYLOAD = {
  login: 'redacted',
  copilot_plan: 'individual',
  access_type_sku: 'free_educational_quota',
  quota_reset_date: '2026-09-01',
  quota_snapshots: {
    chat: { overage_count: 0, overage_permitted: false, percent_remaining: 100, quota_id: 'chat', quota_remaining: 0, unlimited: true },
    completions: { overage_count: 0, overage_permitted: false, percent_remaining: 100, quota_id: 'completions', quota_remaining: 0, unlimited: true },
    premium_interactions: { overage_count: 0, overage_permitted: false, percent_remaining: 35, quota_id: 'premium_interactions', quota_remaining: 70, unlimited: false },
  },
}

describe('parseCopilotUsage', () => {
  test('an UNLIMITED bucket is omitted, never drawn from its quota_remaining of 0', () => {
    const out = parseCopilotUsage(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.map((w) => w.id)).toEqual(['premium_interactions'])
    // The trap, stated as an assertion: chat is unlimited AND reports 0 remaining.
    expect(out.windows.some((w) => w.id === 'chat')).toBe(false)
  })

  test('percent_remaining is inverted into used', () => {
    const out = parseCopilotUsage(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows[0]?.usedPercent).toBe(65)
  })

  test('the reset DATE becomes UTC midnight, not an invented hour', () => {
    const out = parseCopilotUsage(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows[0]?.resetsAt).toBe(Date.parse('2026-09-01T00:00:00Z'))
  })

  test('counts stays null — a limit divided out of a rounded percent is not a reading', () => {
    // 70 remaining at 35% implies 200, but 35 is rounded so the truth is 197–203.
    // Publishing a derived limit as if GitHub had reported it is the invention this
    // whole feature refuses.
    const out = parseCopilotUsage(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows[0]?.counts).toBeNull()
  })

  test('windowMinutes stays null, so no pace is projected', () => {
    const out = parseCopilotUsage(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows[0]?.windowMinutes).toBeNull()
  })

  test('limited buckets are SIBLINGS, not nested', () => {
    // Unlike Antigravity's per-model buckets, which are alternatives to each
    // other, these are separate allowances that run out independently.
    const out = parseCopilotUsage({
      quota_reset_date: '2026-09-01',
      quota_snapshots: {
        a: { percent_remaining: 10, quota_id: 'a', unlimited: false },
        b: { percent_remaining: 80, quota_id: 'b', unlimited: false },
      },
    })
    if (!('windows' in out)) throw new Error('expected windows')
    for (const w of out.windows) expect(w.scopedUnder).toBeNull()
    // and the most constrained sorts first
    expect(out.windows[0]?.id).toBe('a')
  })

  test('an account with every quota unlimited says so instead of failing vaguely', () => {
    const out = parseCopilotUsage({
      quota_reset_date: '2026-09-01',
      quota_snapshots: {
        chat: { percent_remaining: 100, unlimited: true, quota_remaining: 0 },
        completions: { percent_remaining: 100, unlimited: true, quota_remaining: 0 },
      },
    })
    expect('error' in out).toBe(true)
    if (!('error' in out)) return
    expect(out.error).toContain('unlimited')
    expect(out.error).toContain('2 of them')
  })

  test('a missing reset date leaves resetsAt null rather than guessing', () => {
    const out = parseCopilotUsage({
      quota_snapshots: { premium: { percent_remaining: 50, quota_id: 'premium', unlimited: false } },
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows[0]?.resetsAt).toBeNull()
  })

  test('no quota_snapshots is an error, not an empty success', () => {
    expect('error' in parseCopilotUsage({ copilot_plan: 'individual' })).toBe(true)
    expect('error' in parseCopilotUsage(null)).toBe(true)
    expect('error' in parseCopilotUsage([])).toBe(true)
    expect('error' in parseCopilotUsage({ quota_snapshots: {} })).toBe(true)
  })

  test('a percent outside 0..100 clamps', () => {
    const out = parseCopilotUsage({
      quota_snapshots: {
        over: { percent_remaining: -20, quota_id: 'over', unlimited: false },
        under: { percent_remaining: 140, quota_id: 'under', unlimited: false },
      },
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.find((w) => w.id === 'over')?.usedPercent).toBe(100)
    expect(out.windows.find((w) => w.id === 'under')?.usedPercent).toBe(0)
  })

  test('titles read as words, not identifiers', () => {
    const out = parseCopilotUsage(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows[0]?.title).toBe('premium interactions')
  })
})

describe('readResetDate', () => {
  test('accepts a plain date and nothing else', () => {
    expect(readResetDate('2026-09-01')).toBe(Date.parse('2026-09-01T00:00:00Z'))
    expect(readResetDate('2026-09-01T12:00:00Z')).toBeNull()
    expect(readResetDate('next month')).toBeNull()
    expect(readResetDate(null)).toBeNull()
    expect(readResetDate(1_787_011_374)).toBeNull()
  })
})

describe('readGhToken', () => {
  test('finds the token in a normal hosts.yml', () => {
    const yml = ['github.com:', '    users:', '        me:', '            oauth_token: gho_ABC123', '    git_protocol: https'].join('\n')
    expect(readGhToken(yml)).toBe('gho_ABC123')
  })

  test('a file with no token yields null rather than a partial match', () => {
    // The gh CLI can keep the token in the system keychain, leaving only a user
    // here — a different situation from "not signed in", and it has its own
    // message at the call site.
    expect(readGhToken('github.com:\n    user: me\n')).toBeNull()
    expect(readGhToken('')).toBeNull()
    // Anchored: a token mentioned inside a comment or another key must not match.
    expect(readGhToken('# oauth_token: not-a-real-one is what we call it\n')).toBeNull()
  })
})

describe('planLabel', () => {
  test('reads the plan GitHub reports', () => {
    expect(planLabel('individual')).toBe('individual')
    expect(planLabel('business')).toBe('business')
    expect(planLabel('copilot_enterprise')).toBe('copilot enterprise')
  })

  test('absent or empty is null, not an empty badge', () => {
    expect(planLabel(null)).toBeNull()
    expect(planLabel('')).toBeNull()
    expect(planLabel(7)).toBeNull()
  })
})
