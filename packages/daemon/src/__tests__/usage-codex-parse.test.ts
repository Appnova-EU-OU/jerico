/**
 * The Codex usage parser, against the shape that actually arrives.
 *
 * The fixture below is the REAL `wham/usage` response observed on 2026-08-11
 * (identifiers redacted, numbers untouched), and it exists because the first
 * version of this parser got three things wrong that a hand-written fixture would
 * never have caught:
 *
 *   1. It named `primary_window` "session" by position. On this account
 *      `primary_window.limit_window_seconds` is 604800 — SEVEN DAYS — and
 *      `secondary_window` is null. A weekly budget was being shown under a name
 *      that promises it returns in hours.
 *   2. It read `additional_rate_limits[]` entries as flat objects with a
 *      `used_percent`. They are not: each carries `limit_name` and its own nested
 *      `rate_limit`. Every entry was silently dropped.
 *   3. `code_review_rate_limit` was not read at all.
 *
 * No network, no credential: the parser is a pure function and this file must stay
 * runnable on a machine that has never installed the Codex CLI.
 */

import { describe, expect, test } from 'bun:test'
import {
  describeByDuration,
  parseCodexCredits,
  parseCodexUsage,
  planLabel,
  readReset,
} from '../usage/providers/codex.js'

/** A fixed instant, so nothing in here depends on when the suite runs. */
const NOW = 1_786_460_000_000

/** Observed verbatim. Note the weekly-length primary and the null secondary. */
const REAL_PAYLOAD = {
  plan_type: 'prolite',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 9,
      limit_window_seconds: 604800,
      reset_after_seconds: 537543,
      reset_at: 1787011374,
    },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: [
    {
      limit_name: 'GPT-5.3-Codex-Spark',
      metered_feature: 'codex_bengalfox',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 604800,
          reset_after_seconds: 604800,
          reset_at: 1787078632,
        },
        secondary_window: null,
      },
    },
  ],
  credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: '0' },
}

/** CodexBar's own fixture: a five-hour primary AND a weekly secondary. */
const TWO_LANE_PAYLOAD = {
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 4, limit_window_seconds: 18000, reset_after_seconds: 8657, reset_at: 1776216359 },
    secondary_window: { used_percent: 19, limit_window_seconds: 604800, reset_after_seconds: 187681, reset_at: 1776395384 },
  },
  credits: { has_credits: false, unlimited: false, balance: '0E-10' },
}

describe('describeByDuration', () => {
  test('names a window by its stated length, never by its position', () => {
    expect(describeByDuration(18000).title).toBe('session')
    expect(describeByDuration(604800).title).toBe('weekly')
    expect(describeByDuration(3600).title).toBe('session')
  })

  test('a length we do not recognise is named for what it is', () => {
    expect(describeByDuration(30 * 86400).title).toBe('30-day')
    expect(describeByDuration(null).title).toBe('window')
    expect(describeByDuration(0).title).toBe('window')
  })
})

describe('parseCodexUsage — the real payload', () => {
  test('a weekly-length primary window is called weekly, not session', () => {
    const out = parseCodexUsage(REAL_PAYLOAD, NOW)
    if (!('windows' in out)) throw new Error('expected windows')
    const top = out.windows.filter((w) => w.scopedUnder === null)
    expect(top).toHaveLength(1)
    expect(top[0]?.title).toBe('weekly')
    expect(top[0]?.usedPercent).toBe(9)
  })

  test('a null secondary_window is absent, not a zero window', () => {
    const out = parseCodexUsage(REAL_PAYLOAD, NOW)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.some((w) => w.usedPercent === 0 && w.scopedUnder === null)).toBe(false)
  })

  test('a model-scoped limit is read out of its NESTED rate_limit and nested under its lane', () => {
    const out = parseCodexUsage(REAL_PAYLOAD, NOW)
    if (!('windows' in out)) throw new Error('expected windows')
    const scoped = out.windows.find((w) => w.scopedUnder !== null)
    expect(scoped).toBeDefined()
    expect(scoped?.title).toBe('gpt-5.3-codex-spark')
    expect(scoped?.scopedUnder).toBe('weekly')
    expect(scoped?.usedPercent).toBe(0)
  })

  test('reset_at is Unix SECONDS and becomes milliseconds', () => {
    const out = parseCodexUsage(REAL_PAYLOAD, NOW)
    if (!('windows' in out)) throw new Error('expected windows')
    const weekly = out.windows.find((w) => w.id === 'weekly')
    expect(weekly?.resetsAt).toBe(1787011374 * 1000)
    // and it must be in the FUTURE relative to a 2026 clock — the whole point
    expect((weekly?.resetsAt ?? 0) > NOW).toBe(true)
  })

  test('window length comes from the payload, not from a constant', () => {
    const out = parseCodexUsage(REAL_PAYLOAD, NOW)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.find((w) => w.id === 'weekly')?.windowMinutes).toBe(604800 / 60)
  })

  test('severity is null — OpenAI does not grade its own limits', () => {
    const out = parseCodexUsage(REAL_PAYLOAD, NOW)
    if (!('windows' in out)) throw new Error('expected windows')
    for (const w of out.windows) expect(w.severity).toBeNull()
  })
})

describe('parseCodexUsage — both lanes', () => {
  test('a five-hour primary and a weekly secondary get their own names', () => {
    const out = parseCodexUsage(TWO_LANE_PAYLOAD, NOW)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.map((w) => w.title)).toEqual(['session', 'weekly'])
    expect(out.windows.map((w) => w.usedPercent)).toEqual([4, 19])
  })

  test('two lanes of the SAME length do not collide on one id', () => {
    const out = parseCodexUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 1, limit_window_seconds: 604800, reset_at: 1787011374 },
          secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 1787011374 },
        },
      },
      NOW,
    )
    if (!('windows' in out)) throw new Error('expected windows')
    const ids = out.windows.map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('parseCodexUsage — refusals', () => {
  test('no rate_limit object is an error, not an empty success', () => {
    // Empty windows would render as "nothing to report", which is a lie about an
    // account that has limits we failed to read.
    expect(parseCodexUsage({ plan_type: 'pro' }, NOW)).toEqual({
      error: 'usage response carried no rate_limit object',
    })
    expect('error' in parseCodexUsage(null, NOW)).toBe(true)
    expect('error' in parseCodexUsage([], NOW)).toBe(true)
  })

  test('a rate_limit with no readable window is an error', () => {
    expect('error' in parseCodexUsage({ rate_limit: { primary_window: null, secondary_window: null } }, NOW)).toBe(true)
    expect('error' in parseCodexUsage({ rate_limit: { primary_window: { used_percent: 'lots' } } }, NOW)).toBe(true)
  })

  test('an additional limit with no limit_name is dropped rather than labelled', () => {
    const out = parseCodexUsage(
      {
        rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } },
        additional_rate_limits: [{ rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 18000 } } }],
      },
      NOW,
    )
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows).toHaveLength(1)
  })

  test('percent over 100 clamps, and a negative one too', () => {
    const out = parseCodexUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 140, limit_window_seconds: 18000 },
          secondary_window: { used_percent: -3, limit_window_seconds: 604800 },
        },
      },
      NOW,
    )
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.find((w) => w.id === 'session')?.usedPercent).toBe(100)
    expect(out.windows.find((w) => w.id === 'weekly')?.usedPercent).toBe(0)
  })
})

describe('readReset', () => {
  test('prefers reset_at, in seconds', () => {
    expect(readReset({ reset_at: 1787011374 }, NOW)).toBe(1787011374000)
  })

  test('falls back to reset_after_seconds, relative to now', () => {
    expect(readReset({ reset_after_seconds: 600 }, NOW)).toBe(NOW + 600_000)
  })

  test('a reset_at already in MILLISECONDS is refused rather than believed', () => {
    // 1787011374000 as "seconds" would be year 58600. Accepting it would draw a
    // countdown of 56,000 years; refusing it falls back or reports no reset.
    expect(readReset({ reset_at: 1787011374000 }, NOW)).toBeNull()
    expect(readReset({ reset_at: 1787011374000, reset_after_seconds: 60 }, NOW)).toBe(NOW + 60_000)
  })

  test('nothing usable yields null, never now', () => {
    expect(readReset({}, NOW)).toBeNull()
    expect(readReset({ reset_at: null, reset_after_seconds: null }, NOW)).toBeNull()
    expect(readReset({ reset_after_seconds: -5 }, NOW)).toBeNull()
  })
})

describe('parseCodexCredits', () => {
  test('"0E-10" is zero, not NaN', () => {
    // The value in CodexBar's own fixture. parseFloat would give 0 for the wrong
    // reason; a substring check would give NaN.
    const c = parseCodexCredits(TWO_LANE_PAYLOAD)
    expect(c).not.toBeNull()
    expect(c?.enabled).toBe(false)
  })

  test('no credit arrangement reports disabled, with no figures to misread', () => {
    // Credits are a balance REMAINING, not an amount spent, so there was never a
    // `used` to report. The union no longer asks for one.
    const c = parseCodexCredits(REAL_PAYLOAD)
    expect(c?.enabled).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(c as object, 'used')).toBe(false)
  })

  test('unlimited reports no section at all — a gauge cannot draw infinity', () => {
    expect(parseCodexCredits({ credits: { unlimited: true, has_credits: true, balance: '5' } })).toBeNull()
  })

  test('absent credits is null', () => {
    expect(parseCodexCredits({})).toBeNull()
    expect(parseCodexCredits({ credits: null })).toBeNull()
  })

  test('a real balance is reported as enabled', () => {
    const c = parseCodexCredits({ credits: { has_credits: true, unlimited: false, balance: '12.5' } })
    expect(c?.enabled).toBe(true)
    expect(c?.period).toContain('12.50')
  })
})

describe('planLabel', () => {
  test('passes an unrecognised plan through verbatim', () => {
    // CodexBar hit `prolite` being rejected as an "unknown variant". A surface
    // that blanks an unfamiliar plan is less useful than one that shows it.
    expect(planLabel('prolite')).toBe('prolite')
    expect(planLabel('pro')).toBe('pro')
    expect(planLabel('team_enterprise')).toBe('team enterprise')
  })

  test('absent or empty is null, not an empty badge', () => {
    expect(planLabel(null)).toBeNull()
    expect(planLabel('')).toBeNull()
    expect(planLabel(42)).toBeNull()
  })
})
