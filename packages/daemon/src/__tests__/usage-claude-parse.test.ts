/**
 * The Claude usage parser, against the shapes that actually occur.
 *
 * The first version of this parser walked every top-level key of the response
 * and would have rendered a row labelled "nimbus quill" — an internal Anthropic
 * codename — to a user. That is the regression these tests exist to prevent, so
 * the fixture below is the REAL payload observed on 2026-08-11, codenames
 * included, with only the timestamps and percentages left as they were.
 *
 * No network, no credential, no keychain: the parser is a pure function and this
 * file must stay runnable on a machine that has never installed Claude Code.
 */

import { describe, expect, test } from 'bun:test'
import { parseExtraUsage, parseUsageResponse, planLabel } from '../usage/providers/claude.js'

/** Observed verbatim. The six codename keys are the point. */
const REAL_PAYLOAD = {
  five_hour: { utilization: 5, resets_at: '2026-08-11T18:00:00.407586+00:00' },
  seven_day: { utilization: 40, resets_at: '2026-08-15T09:00:00.407610+00:00' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  seven_day_omelette: null,
  tangelo: null,
  iguana_necktie: null,
  omelette_promotional: null,
  // Live, non-null, and NOT a user-facing concept.
  nimbus_quill: { utilization: 0, resets_at: null },
  cinder_cove: null,
  amber_ladder: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: null,
    utilization: null,
    currency: null,
    decimal_places: null,
    user_disabled: true,
    spend_limit_reached: false,
    credits_ever_enabled: true,
  },
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 5,
      severity: 'normal',
      resets_at: '2026-08-11T17:59:59.634434+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 40,
      severity: 'normal',
      resets_at: '2026-08-15T08:59:59.634455+00:00',
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 0,
      severity: 'normal',
      resets_at: null,
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
}

describe('parseUsageResponse', () => {
  test('reads the three documented kinds and nothing else', () => {
    const out = parseUsageResponse(REAL_PAYLOAD)
    expect('windows' in out).toBe(true)
    if (!('windows' in out)) return
    expect(out.windows.map((w) => w.id)).toEqual(['session', 'weekly', 'weekly:fable'])
  })

  test('NEVER surfaces an internal codename, even when it is live', () => {
    const out = parseUsageResponse(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    const titles = out.windows.map((w) => w.title).join(' ')
    for (const codename of ['nimbus', 'quill', 'tangelo', 'iguana', 'necktie', 'cinder', 'cove', 'amber', 'ladder', 'omelette']) {
      expect(titles).not.toContain(codename)
    }
  })

  test('titles a scoped window by the model display name, nested under weekly', () => {
    const out = parseUsageResponse(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    const scoped = out.windows.find((w) => w.scopedUnder !== null)
    expect(scoped?.title).toBe('fable')
    expect(scoped?.scopedUnder).toBe('weekly')
  })

  test('a live window with no resets_at yields null, never a timestamp', () => {
    const out = parseUsageResponse(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.find((w) => w.id === 'weekly:fable')?.resetsAt).toBeNull()
    // and the ones that DO carry a reset are parsed, not dropped
    expect(out.windows.find((w) => w.id === 'weekly')?.resetsAt).toBeGreaterThan(0)
  })

  test('carries the provider severity and is_active rather than inventing them', () => {
    const out = parseUsageResponse(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.find((w) => w.id === 'weekly')?.isActive).toBe(true)
    expect(out.windows.find((w) => w.id === 'session')?.isActive).toBe(false)
    expect(out.windows.find((w) => w.id === 'session')?.severity).toBe('normal')
  })

  test('an unknown severity becomes null rather than a guess', () => {
    const out = parseUsageResponse({
      limits: [{ kind: 'session', group: 'session', percent: 1, severity: 'spicy', resets_at: null, scope: null, is_active: true }],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows[0]?.severity).toBeNull()
  })

  test('a weekly_scoped entry with no model display name is dropped, not labelled', () => {
    const out = parseUsageResponse({
      limits: [
        { kind: 'weekly_all', group: 'weekly', percent: 3, severity: 'normal', resets_at: null, scope: null, is_active: true },
        { kind: 'weekly_scoped', group: 'weekly', percent: 90, severity: 'critical', resets_at: null, scope: { model: { display_name: null } }, is_active: true },
      ],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.map((w) => w.id)).toEqual(['weekly'])
  })

  test('an unrecognised kind is dropped rather than guessed at', () => {
    const out = parseUsageResponse({
      limits: [
        { kind: 'session', group: 'session', percent: 2, severity: 'normal', resets_at: null, scope: null, is_active: true },
        { kind: 'lunar_bandwidth', group: 'lunar', percent: 99, severity: 'critical', resets_at: null, scope: null, is_active: true },
      ],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.map((w) => w.id)).toEqual(['session'])
  })

  test('percent over 100 is clamped, and a negative one too', () => {
    const out = parseUsageResponse({
      limits: [
        { kind: 'session', group: 'session', percent: 137, severity: 'critical', resets_at: null, scope: null, is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: -4, severity: 'normal', resets_at: null, scope: null, is_active: true },
      ],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.find((w) => w.id === 'session')?.usedPercent).toBe(100)
    expect(out.windows.find((w) => w.id === 'weekly')?.usedPercent).toBe(0)
  })

  test('session sorts before weekly regardless of array order', () => {
    const out = parseUsageResponse({
      limits: [
        { kind: 'weekly_all', group: 'weekly', percent: 40, severity: 'normal', resets_at: null, scope: null, is_active: true },
        { kind: 'session', group: 'session', percent: 5, severity: 'normal', resets_at: null, scope: null, is_active: true },
      ],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.map((w) => w.id)).toEqual(['session', 'weekly'])
  })

  test('a response with no limits array is an error, not an empty success', () => {
    // The distinction matters: empty windows would render as "nothing to report",
    // which is a lie about an account that has limits we failed to read.
    expect(parseUsageResponse({ five_hour: { utilization: 9 } })).toEqual({
      error: 'usage response carried no limits array',
    })
    expect('error' in parseUsageResponse(null)).toBe(true)
    expect('error' in parseUsageResponse([])).toBe(true)
  })

  test('a limits array with no recognised entry is an error, not silence', () => {
    expect('error' in parseUsageResponse({ limits: [{ kind: 'nope', group: 'nope', percent: 1 }] })).toBe(true)
  })
})

describe('parseExtraUsage', () => {
  test('a disabled arrangement carries NO figures at all', () => {
    // The shape is a union now: there is no `used` to fabricate and no `limit` to
    // read when there is nothing to spend. The previous version put `used: 0` in
    // a field meaning money spent — a number no provider reported, and one that
    // `usage --json` and /health published verbatim.
    const cost = parseExtraUsage(REAL_PAYLOAD)
    expect(cost).not.toBeNull()
    expect(cost?.enabled).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(cost as object, 'used')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(cost as object, 'limit')).toBe(false)
  })

  test('absent is null, which is not the same as disabled', () => {
    expect(parseExtraUsage({})).toBeNull()
    expect(parseExtraUsage({ extra_usage: null })).toBeNull()
  })

  test('decimal_places is read, not assumed to be 2', () => {
    const cents = parseExtraUsage({
      extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 550, currency: 'EUR', decimal_places: 2 },
    })
    expect(cents?.used).toBe(5.5)
    expect(cents?.limit).toBe(20)
    expect(cents?.currency).toBe('EUR')

    const whole = parseExtraUsage({
      extra_usage: { is_enabled: true, monthly_limit: 20, used_credits: 5, currency: 'USD', decimal_places: 0 },
    })
    expect(whole?.used).toBe(5)
    expect(whole?.limit).toBe(20)
  })

  test('enabled but reporting nothing usable does not become a zero balance', () => {
    const cost = parseExtraUsage({ extra_usage: { is_enabled: true, monthly_limit: null, used_credits: null } })
    expect(cost?.enabled).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(cost as object, 'used')).toBe(false)
  })
})

describe('planLabel', () => {
  test('surfaces the Max multiplier, because 5x and 20x are different ceilings', () => {
    expect(planLabel(null, 'default_claude_max_20x')).toBe('max 20x')
    expect(planLabel('max', 'default_claude_max_5x')).toBe('max 5x')
  })

  test('falls back to subscriptionType, then to a cleaned tier, then to null', () => {
    expect(planLabel('pro', null)).toBe('pro')
    expect(planLabel(null, 'default_claude_pro')).toBe('pro')
    expect(planLabel(null, null)).toBeNull()
    expect(planLabel('', '')).toBeNull()
  })
})
