/**
 * The Kimi usage parser.
 *
 * These tests carry more weight than the Claude and Codex ones, because Kimi is
 * the one provider that could NOT be verified live: the CLI credential on the
 * machine this was written on had expired, and Kimi's access tokens last fifteen
 * minutes (`expires_in: 900`, measured). The endpoint and headers were confirmed —
 * `api.kimi.com/coding/v1/usages` answered `401 REASON_INVALID_AUTH_TOKEN`, which
 * proves the request shape and disproves nothing else. Everything below is
 * therefore checked against the response shape Moonshot documents, and the fact
 * that no live payload was seen is recorded here rather than in a commit message.
 *
 * Kimi is also the provider that breaks the two assumptions the earlier ones
 * established, which is why each has its own test:
 *   - every number arrives as a STRING
 *   - there is no percentage at all, only a limit and a used count
 */

import { describe, expect, test } from 'bun:test'
import {
  describeMinutes,
  isExpired,
  kimiTokenLapsedFault,
  numeric,
  parseKimiUsage,
  windowMinutes,
} from '../usage/providers/kimi.js'

/** Moonshot's documented response, verbatim. */
const DOC_PAYLOAD = {
  usage: {
    limit: '2048',
    used: '214',
    remaining: '1834',
    resetTime: '2026-01-09T15:23:13.716839300Z',
  },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: {
        limit: '200',
        used: '139',
        remaining: '61',
        resetTime: '2026-01-06T13:33:02.717479433Z',
      },
    },
  ],
}

/**
 * The REAL response, measured 2026-08-11 once a live token existed. It is here
 * because it differs from the documented example in a way that mattered:
 * `limits[].detail` carries `limit` and `remaining` and NO `used`. The parser
 * required `used`, so the five-hour window was dropped silently and only the
 * membership pool appeared. Nothing but a live payload would have shown that.
 */
const LIVE_PAYLOAD = {
  user: { region: 'REGION_OVERSEA', membership: { level: 'LEVEL_INTERMEDIATE' } },
  usage: { limit: '100', used: '100', resetTime: '2026-08-13T09:21:05.900040Z' },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', remaining: '100', resetTime: '2026-08-12T00:21:05.900040Z' },
    },
  ],
  parallel: { limit: '20' },
  authentication: { method: 'METHOD_ACCESS_TOKEN', scope: 'FEATURE_CODING' },
}

describe('parseKimiUsage — the live payload', () => {
  test('a detail with `remaining` and NO `used` still yields a window', () => {
    const out = parseKimiUsage(LIVE_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.map((w) => w.id)).toEqual(['session', 'quota'])
  })

  test('used is derived from limit − remaining', () => {
    const out = parseKimiUsage(LIVE_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    // 100 of 100 remaining = nothing used.
    const session = out.windows.find((w) => w.id === 'session')
    expect(session?.usedPercent).toBe(0)
    expect(session?.counts).toEqual({ used: 0, limit: 100 })
  })

  test('an explicit `used` still wins over the derivation', () => {
    const out = parseKimiUsage({
      limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '200', used: '139', remaining: '61' } }],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows[0]?.counts).toEqual({ used: 139, limit: 200 })
  })

  test('a remaining ABOVE the limit does not produce negative usage', () => {
    const out = parseKimiUsage({ usage: { limit: '10', remaining: '40' } })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows[0]?.usedPercent).toBe(0)
    expect(out.windows[0]?.counts).toEqual({ used: 0, limit: 10 })
  })

  test('neither used nor remaining still refuses the window', () => {
    expect('error' in parseKimiUsage({ usage: { limit: '100' } })).toBe(true)
  })
})

describe('numeric', () => {
  test('reads the strings Kimi actually sends', () => {
    // A parser that checked `typeof === 'number'` — which the Claude and Codex
    // parsers correctly do — would find nothing in this payload and report an
    // empty account.
    expect(numeric('2048')).toBe(2048)
    expect(numeric('0')).toBe(0)
    expect(numeric('12.5')).toBe(12.5)
    expect(numeric(2048)).toBe(2048)
  })

  test('refuses what is not a number rather than coercing it to zero', () => {
    expect(numeric('')).toBeNull()
    expect(numeric('   ')).toBeNull()
    expect(numeric('lots')).toBeNull()
    expect(numeric(null)).toBeNull()
    expect(numeric(undefined)).toBeNull()
    expect(numeric(Number.NaN)).toBeNull()
    expect(numeric(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('windowMinutes', () => {
  test('reads the unit, not just the number', () => {
    // 300 TIME_UNIT_MINUTE is five hours. Reading 300 alone and assuming minutes
    // happens to be right here and would be wrong for every other unit.
    expect(windowMinutes({ duration: 300, timeUnit: 'TIME_UNIT_MINUTE' })).toBe(300)
    expect(windowMinutes({ duration: 5, timeUnit: 'TIME_UNIT_HOUR' })).toBe(300)
    expect(windowMinutes({ duration: 7, timeUnit: 'TIME_UNIT_DAY' })).toBe(7 * 1440)
    expect(windowMinutes({ duration: 300, timeUnit: 'TIME_UNIT_SECOND' })).toBe(5)
  })

  test('an unrecognised unit is null, not a guess', () => {
    // Assuming minutes for an unknown unit would turn a 300-SECOND window into a
    // five-hour one. Null costs the pace projection and nothing else.
    expect(windowMinutes({ duration: 300, timeUnit: 'TIME_UNIT_FORTNIGHT' })).toBeNull()
    expect(windowMinutes({ duration: 300 })).toBeNull()
    expect(windowMinutes({ timeUnit: 'TIME_UNIT_MINUTE' })).toBeNull()
    expect(windowMinutes(null)).toBeNull()
    expect(windowMinutes({ duration: 0, timeUnit: 'TIME_UNIT_MINUTE' })).toBeNull()
  })
})

describe('describeMinutes', () => {
  test('uses the same lane names as the other providers', () => {
    // One register mixes agents; three vocabularies would make it unreadable.
    expect(describeMinutes(300).title).toBe('session')
    expect(describeMinutes(7 * 1440).title).toBe('weekly')
    expect(describeMinutes(null).title).toBe('quota')
    expect(describeMinutes(30 * 1440).title).toBe('30-day')
  })
})

describe('parseKimiUsage', () => {
  test('computes the percentage from the two numbers given', () => {
    const out = parseKimiUsage(DOC_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    const session = out.windows.find((w) => w.id === 'session')
    // 139 of 200 = 69.5%. Arithmetic on supplied numbers, not an invented ceiling.
    expect(session?.usedPercent).toBeCloseTo(69.5, 5)
  })

  test('KEEPS the counts, because "139 of 200" beats "70%"', () => {
    const out = parseKimiUsage(DOC_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.find((w) => w.id === 'session')?.counts).toEqual({ used: 139, limit: 200 })
    expect(out.windows.find((w) => w.id === 'quota')?.counts).toEqual({ used: 214, limit: 2048 })
  })

  test('reads both the rate-limit window and the membership pool', () => {
    const out = parseKimiUsage(DOC_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.map((w) => w.id)).toEqual(['session', 'quota'])
  })

  test('the shorter window sorts first — a 5h ceiling is more urgent than a pool', () => {
    const out = parseKimiUsage(DOC_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows[0]?.id).toBe('session')
  })

  test('parses a nanosecond ISO timestamp', () => {
    const out = parseKimiUsage(DOC_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    const at = out.windows.find((w) => w.id === 'session')?.resetsAt
    expect(at).toBe(Date.parse('2026-01-06T13:33:02.717Z'))
  })

  test('the membership pool has no duration, so it gets no invented one', () => {
    const out = parseKimiUsage(DOC_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.find((w) => w.id === 'quota')?.windowMinutes).toBeNull()
  })

  test('a zero limit is REFUSED, not drawn as 0% or 100%', () => {
    // 0% would say "plenty left" about an account with no allowance; 100% would
    // say the opposite. Neither is true, so the window does not appear.
    const out = parseKimiUsage({ usage: { limit: '0', used: '0', resetTime: null } })
    expect('error' in out).toBe(true)
  })

  test('a used count without a limit is refused', () => {
    expect('error' in parseKimiUsage({ usage: { used: '5' } })).toBe(true)
  })

  test('over-limit clamps to 100 rather than drawing past the end of the gauge', () => {
    const out = parseKimiUsage({ usage: { limit: '100', used: '137' } })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows[0]?.usedPercent).toBe(100)
    // The clamp is presentational: the true counts survive beside it.
    expect(out.windows[0]?.counts).toEqual({ used: 137, limit: 100 })
  })

  test('an empty response is an error, not an empty success', () => {
    expect('error' in parseKimiUsage({})).toBe(true)
    expect('error' in parseKimiUsage(null)).toBe(true)
    expect('error' in parseKimiUsage([])).toBe(true)
    expect('error' in parseKimiUsage({ limits: [] })).toBe(true)
  })

  test('two windows of the same class do not collide on one id', () => {
    const out = parseKimiUsage({
      limits: [
        { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '10', used: '1' } },
        { window: { duration: 60, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '20', used: '2' } },
      ],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    const ids = out.windows.map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('severity is null — Moonshot does not grade its own limits', () => {
    const out = parseKimiUsage(DOC_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    for (const w of out.windows) expect(w.severity).toBeNull()
  })
})

describe('isExpired', () => {
  const NOW = 1_786_474_448_000

  test('epoch SECONDS, as the CLI writes them', () => {
    // The real value on this machine: 1786441391, five hours before NOW.
    expect(isExpired({ expires_at: 1_786_441_391 }, NOW)).toBe(true)
    expect(isExpired({ expires_at: 1_786_999_999 }, NOW)).toBe(false)
  })

  test('a millisecond value is tolerated rather than called expired', () => {
    // Treating ms as seconds would put every expiry in the far future and never
    // report expiry; treating it as expired would lock a valid token out. Reading
    // the magnitude is the only reading that is right either way.
    expect(isExpired({ expires_at: NOW + 600_000 }, NOW)).toBe(false)
    expect(isExpired({ expires_at: NOW - 60_000 }, NOW)).toBe(true)
  })

  test('a token inside the sixty-second margin counts as expired', () => {
    // The margin exists because a token with four seconds left is not usable: the
    // request goes out valid and the answer arrives after it died, which reports
    // as "rejected" when the honest answer is "expired". Taken from the reference
    // implementation, which requires expiresAt > now + 60.
    expect(isExpired({ expires_at: NOW + 4_000 }, NOW)).toBe(true)
    expect(isExpired({ expires_at: NOW + 59_000 }, NOW)).toBe(true)
    expect(isExpired({ expires_at: NOW + 61_000 }, NOW)).toBe(false)
  })

  test('no expiry field means do not claim expiry — let the server decide', () => {
    expect(isExpired({}, NOW)).toBe(false)
    expect(isExpired({ expires_at: null }, NOW)).toBe(false)
    expect(isExpired({ expires_at: 'soon' }, NOW)).toBe(false)
  })
})

test('a locally lapsed Kimi token is not reported as a provider rejection', () => {
  const result = kimiTokenLapsedFault()
  expect(result).toMatchObject({ ok: false, code: 'token_lapsed' })
  if (!result.ok) expect(result.detail).toContain('kimiApiKey')
})
