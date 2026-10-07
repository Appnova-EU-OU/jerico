/**
 * The Antigravity (`agy`) quota parser.
 *
 * Fixture is the REAL `retrieveUserQuota` response, HTTP 200, measured
 * 2026-08-11. The single most important test in this file is the first one: the
 * payload reports what is **REMAINING** as a **FRACTION**, and every other
 * provider reports what is USED as a PERCENTAGE. Reading it the familiar way
 * would draw a completely fresh account as 100% spent — the most alarming
 * possible way to be wrong, and the reason this is pinned rather than trusted.
 */

import { describe, expect, test } from 'bun:test'
import { agyTokenLapsedFault, parseAgyQuota, resolveAgyCredential } from '../usage/providers/agy.js'
import type { CredentialLookup } from '../usage/credentials.js'

const REAL_PAYLOAD = {
  buckets: [
    { resetTime: '2026-08-12T18:59:02Z', tokenType: 'REQUESTS', modelId: 'gemini-2.5-flash', remainingFraction: 1 },
    { resetTime: '2026-08-12T18:59:02Z', tokenType: 'REQUESTS', modelId: 'gemini-2.5-flash-lite', remainingFraction: 1 },
    { resetTime: '2026-08-12T18:59:02Z', tokenType: 'REQUESTS', modelId: 'gemini-2.5-pro', remainingFraction: 1 },
    { resetTime: '2026-08-12T18:59:02Z', tokenType: 'REQUESTS', modelId: 'gemini-3.1-flash-lite', remainingFraction: 1 },
  ],
}

describe('parseAgyQuota', () => {
  test('remainingFraction 1 means NOTHING used, not everything', () => {
    const out = parseAgyQuota(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    for (const w of out.windows) expect(w.usedPercent).toBe(0)
  })

  test('a fraction is converted, not read as a percentage', () => {
    // 0.25 remaining = 75% used. Read as a percentage it would be 0.25% used.
    const out = parseAgyQuota({
      buckets: [{ modelId: 'm', tokenType: 'REQUESTS', remainingFraction: 0.25, resetTime: null }],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.find((w) => w.title === 'm')?.usedPercent).toBe(75)
  })

  test('one scoped window per model, under a single parent', () => {
    const out = parseAgyQuota(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    const parents = out.windows.filter((w) => w.scopedUnder === null)
    expect(parents).toHaveLength(1)
    expect(parents[0]?.id).toBe('models')
    expect(out.windows.filter((w) => w.scopedUnder === 'models')).toHaveLength(4)
  })

  test('the parent carries the WORST model, never an average', () => {
    // An average is a number no bucket reported. The register shows one row per
    // agent and it has to mean the model that will stop first.
    const out = parseAgyQuota({
      buckets: [
        { modelId: 'plenty', tokenType: 'REQUESTS', remainingFraction: 1, resetTime: null },
        { modelId: 'nearly-out', tokenType: 'REQUESTS', remainingFraction: 0.05, resetTime: '2026-08-12T18:59:02Z' },
      ],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    const parent = out.windows.find((w) => w.id === 'models')
    expect(parent?.usedPercent).toBe(95)
    // and it inherits that model's reset, not the other one's
    expect(parent?.resetsAt).toBe(Date.parse('2026-08-12T18:59:02Z'))
  })

  test('the most constrained model sorts first among the scoped rows', () => {
    const out = parseAgyQuota({
      buckets: [
        { modelId: 'a', tokenType: 'REQUESTS', remainingFraction: 1, resetTime: null },
        { modelId: 'b', tokenType: 'REQUESTS', remainingFraction: 0.1, resetTime: null },
      ],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    const scoped = out.windows.filter((w) => w.scopedUnder !== null)
    expect(scoped[0]?.title).toBe('b')
  })

  test('an unknown tokenType is dropped rather than mixed in with requests', () => {
    // A TOKENS bucket counts something else. Averaging units is worse than
    // omitting one.
    const out = parseAgyQuota({
      buckets: [
        { modelId: 'req', tokenType: 'REQUESTS', remainingFraction: 0.5, resetTime: null },
        { modelId: 'tok', tokenType: 'TOKENS', remainingFraction: 0.01, resetTime: null },
      ],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.some((w) => w.title === 'tok')).toBe(false)
    expect(out.windows.find((w) => w.id === 'models')?.usedPercent).toBe(50)
  })

  test('windowMinutes stays null — the payload states no window length', () => {
    const out = parseAgyQuota(REAL_PAYLOAD)
    if (!('windows' in out)) throw new Error('expected windows')
    // Which means no pace projection. The reset time is still shown, and that is
    // the actionable half.
    for (const w of out.windows) expect(w.windowMinutes).toBeNull()
  })

  test('a bucket with no model id is dropped', () => {
    const out = parseAgyQuota({
      buckets: [
        { tokenType: 'REQUESTS', remainingFraction: 0.5, resetTime: null },
        { modelId: 'ok', tokenType: 'REQUESTS', remainingFraction: 0.5, resetTime: null },
      ],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.filter((w) => w.scopedUnder !== null)).toHaveLength(1)
  })

  test('an empty or missing buckets array is an error, not an empty success', () => {
    expect('error' in parseAgyQuota({ buckets: [] })).toBe(true)
    expect('error' in parseAgyQuota({})).toBe(true)
    expect('error' in parseAgyQuota(null)).toBe(true)
    expect('error' in parseAgyQuota([])).toBe(true)
  })

  test('a fraction outside 0..1 clamps rather than drawing off the gauge', () => {
    const out = parseAgyQuota({
      buckets: [
        { modelId: 'over', tokenType: 'REQUESTS', remainingFraction: 1.4, resetTime: null },
        { modelId: 'under', tokenType: 'REQUESTS', remainingFraction: -0.2, resetTime: null },
      ],
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.find((w) => w.title === 'over')?.usedPercent).toBe(0)
    expect(out.windows.find((w) => w.title === 'under')?.usedPercent).toBe(100)
  })
})

describe('resolveAgyCredential', () => {
  const found = (data: Record<string, unknown>, describe: string): CredentialLookup => ({
    found: true,
    credential: { data, source: 'file', describe },
  })
  const absent: CredentialLookup = { found: false, reason: 'absent', detail: 'no file' }

  test('prefers the Antigravity token over the Gemini CLI credential', () => {
    // The point of the whole file: `agy` signs in to its own token, and
    // agents.ts currently checks the Gemini CLI's. A user with both must be asked
    // about with the one the agent actually uses.
    const r = resolveAgyCredential((rel) =>
      rel.includes('antigravity-oauth-token')
        ? found({ token: { access_token: 'AGY', expiry: '2099-01-01T00:00:00Z' } }, '~/agy')
        : found({ access_token: 'GEMINI', expiry_date: 4_000_000_000_000 }, '~/gemini'),
    )
    if ('error' in r) throw new Error(r.error)
    expect(r.accessToken).toBe('AGY')
    expect(r.expiresAt).toBe(Date.parse('2099-01-01T00:00:00Z'))
  })

  test('falls back to the Gemini CLI credential when Antigravity has none', () => {
    const r = resolveAgyCredential((rel) =>
      rel.includes('antigravity-oauth-token') ? absent : found({ access_token: 'GEMINI', expiry_date: 4_000_000_000_000 }, '~/gemini'),
    )
    if ('error' in r) throw new Error(r.error)
    expect(r.accessToken).toBe('GEMINI')
  })

  test('the Gemini CLI writes milliseconds; a seconds value is still read right', () => {
    const ms = resolveAgyCredential((rel) =>
      rel.includes('antigravity') ? absent : found({ access_token: 'G', expiry_date: 4_000_000_000_000 }, '~/g'),
    )
    const secs = resolveAgyCredential((rel) =>
      rel.includes('antigravity') ? absent : found({ access_token: 'G', expiry_date: 4_000_000_000 }, '~/g'),
    )
    if ('error' in ms || 'error' in secs) throw new Error('expected credentials')
    expect(ms.expiresAt).toBe(4_000_000_000_000)
    expect(secs.expiresAt).toBe(4_000_000_000_000)
  })

  test('neither file present is a credentials fault, not a malformed one', () => {
    const r = resolveAgyCredential(() => absent)
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.malformed).toBe(false)
    expect(r.error).toContain('sign in with `agy`')
  })

  test('a malformed Antigravity file does NOT silently fall through to Gemini', () => {
    // A broken file the agent wrote is the fault worth reporting; hiding it behind
    // a working fallback means the user never learns why agy misbehaves elsewhere.
    const r = resolveAgyCredential((rel) =>
      rel.includes('antigravity')
        ? { found: false, reason: 'malformed', detail: 'not valid JSON' }
        : found({ access_token: 'GEMINI' }, '~/gemini'),
    )
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.malformed).toBe(true)
  })

  test('a token file with no access_token is malformed, not absent', () => {
    const r = resolveAgyCredential((rel) =>
      rel.includes('antigravity') ? found({ token: {} }, '~/agy') : absent,
    )
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.malformed).toBe(true)
  })
})

test('a locally lapsed agy token is not reported as a provider rejection', () => {
  const result = agyTokenLapsedFault('~/.gemini/antigravity-cli/antigravity-oauth-token')
  expect(result).toMatchObject({ ok: false, code: 'token_lapsed' })
  if (!result.ok) expect(result.detail).toContain('running agy did not answer')
})
