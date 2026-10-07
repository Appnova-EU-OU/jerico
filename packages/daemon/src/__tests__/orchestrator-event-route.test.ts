/**
 * #616 slice 2 — authorization for the events surface.
 *
 * This is the only new externally-reachable path in the design, so its tests are
 * about what must be REFUSED. It runs on the daemon's loopback socket alongside
 * the hook route and deliberately reuses that route's three checks; these pin
 * that the reuse is real and not merely claimed.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  authorizeEventsRequest,
  clampPollWait,
  safeTokenEqual,
  subscriberIdFor,
  MAX_POLL_WAIT_MS,
  MIN_POLL_WAIT_MS,
} from '../events/route.js'
import {
  HOOK_PROTOCOL,
  EVENTS_PROTOCOL_VERSION,
  HEADER_TOKEN,
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_VERSION,
  HEADER_AGENT_ID,
  HEADER_INSTANCE_ID,
  HEADER_EVENT_TOKEN,
} from '../hooks/protocol.js'

const TOKEN = 'a'.repeat(64)
const EVENT_TOKEN = 'e'.repeat(64)
const live = () => true
const dead = () => false
const eventTokenFor = () => EVENT_TOKEN

function headers(over: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    [HEADER_TOKEN]: TOKEN,
    [HEADER_PROTOCOL]: HOOK_PROTOCOL,
    [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
    [HEADER_AGENT_ID]: 'panel-1',
    [HEADER_INSTANCE_ID]: '3',
    [HEADER_EVENT_TOKEN]: EVENT_TOKEN,
  }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k]
    else base[k] = v
  }
  return base
}

describe('#616 events route authorization', () => {
  test('a correct request authorizes and carries its identity forward', () => {
    expect(authorizeEventsRequest(headers(), TOKEN, live, eventTokenFor)).toEqual({
      ok: true, agentId: 'panel-1', instanceId: 3,
    })
  })

  test('a wrong token is refused before anything else is parsed', () => {
    // Identity headers are absent AND the token is wrong: the answer must be
    // about the token, so a caller that cannot authenticate learns nothing about
    // which identities exist.
    const r = authorizeEventsRequest(
      headers({ [HEADER_TOKEN]: 'b'.repeat(64), [HEADER_AGENT_ID]: undefined }),
      TOKEN, live, eventTokenFor,
    )
    expect(r).toEqual({ ok: false, status: 403, error: 'invalid_token' })
  })

  test('a missing token is refused, not treated as empty', () => {
    expect(authorizeEventsRequest(headers({ [HEADER_TOKEN]: undefined }), TOKEN, live, eventTokenFor))
      .toMatchObject({ ok: false, status: 403 })
  })

  test('token comparison is length-safe and constant-time in shape', () => {
    expect(safeTokenEqual(undefined, TOKEN)).toBe(false)
    expect(safeTokenEqual('', TOKEN)).toBe(false)
    expect(safeTokenEqual('a'.repeat(63), TOKEN)).toBe(false)
    expect(safeTokenEqual('a'.repeat(65), TOKEN)).toBe(false)
    expect(safeTokenEqual(TOKEN, TOKEN)).toBe(true)
  })

  test('a protocol or version skew is refused loudly rather than parsed leniently', () => {
    expect(authorizeEventsRequest(headers({ [HEADER_PROTOCOL]: 'something-else' }), TOKEN, live, eventTokenFor))
      .toEqual({ ok: false, status: 422, error: 'protocol_mismatch' })
    expect(authorizeEventsRequest(headers({ [HEADER_PROTOCOL_VERSION]: '1' }), TOKEN, live, eventTokenFor))
      .toEqual({ ok: false, status: 422, error: 'protocol_mismatch' })
    expect(authorizeEventsRequest(headers({ [HEADER_PROTOCOL_VERSION]: undefined }), TOKEN, live, eventTokenFor))
      .toEqual({ ok: false, status: 422, error: 'protocol_mismatch' })
  })

  test('identity must be present and numeric', () => {
    expect(authorizeEventsRequest(headers({ [HEADER_AGENT_ID]: '   ' }), TOKEN, live, eventTokenFor))
      .toMatchObject({ error: 'missing_identity' })
    expect(authorizeEventsRequest(headers({ [HEADER_INSTANCE_ID]: undefined }), TOKEN, live, eventTokenFor))
      .toMatchObject({ error: 'missing_identity' })
    expect(authorizeEventsRequest(headers({ [HEADER_INSTANCE_ID]: 'not-a-number' }), TOKEN, live, eventTokenFor))
      .toMatchObject({ error: 'invalid_instance' })

    // Found by opencode: parseInt stops at the first non-digit, so these were
    // all silently accepted as 3 — a malformed header waved through, and four
    // distinct values collapsing onto one subscriber.
    for (const bad of ['3abc', '007', ' 3 ', '3.5', '+3', '-3', '0', '0x3', '1e3', '']) {
      expect(authorizeEventsRequest(headers({ [HEADER_INSTANCE_ID]: bad }), TOKEN, live, eventTokenFor))
        .toMatchObject({ ok: false, status: 422 })
    }
    // Canonical values still pass.
    expect(authorizeEventsRequest(headers({ [HEADER_INSTANCE_ID]: '42' }), TOKEN, live, eventTokenFor))
      .toMatchObject({ ok: true, instanceId: 42 })
  })

  test('a restarted panel cannot resume the previous generation stream', () => {
    expect(authorizeEventsRequest(headers(), TOKEN, dead, eventTokenFor))
      .toEqual({ ok: false, status: 409, error: 'panel_gone' })
  })

  test('the subscriber id is derived from authenticated identity, never supplied', () => {
    // A caller that could name its own subscriber could read another panel's
    // stream. The id is a function of headers that were already verified.
    expect(subscriberIdFor('panel-1', 3)).toBe('panel-1#3')
    expect(subscriberIdFor('panel-1', 4)).not.toBe(subscriberIdFor('panel-1', 3))

    // Found by opencode answering "what would an obvious-path reviewer skip":
    // the delimiter is only unambiguous by accident of today's UUID charset.
    // Two distinct panels must not be able to land in one bucket.
    expect(subscriberIdFor('a#b', 1)).not.toBe(subscriberIdFor('a', 'b#1' as unknown as number))
    expect(subscriberIdFor('a#b#1', 1)).not.toBe(subscriberIdFor('a#b', 1))
  })

  test('a caller cannot pin a daemon socket open, nor turn the poll into a busy loop', () => {
    expect(clampPollWait('999999', 15_000)).toBe(MAX_POLL_WAIT_MS)
    expect(clampPollWait('0', 15_000)).toBe(MIN_POLL_WAIT_MS)
    expect(clampPollWait('-5', 15_000)).toBe(MIN_POLL_WAIT_MS)
    expect(clampPollWait('abc', 15_000)).toBe(15_000)
    expect(clampPollWait(undefined, 15_000)).toBe(15_000)
    expect(clampPollWait('5000', 15_000)).toBe(5_000)
  })

  test('a repeated header array does not smuggle a second value past a check', () => {
    const h = headers() as Record<string, string | string[] | undefined>
    h[HEADER_TOKEN] = [TOKEN, 'b'.repeat(64)]
    expect(authorizeEventsRequest(h, TOKEN, live, eventTokenFor)).toMatchObject({ ok: true })

    h[HEADER_TOKEN] = ['b'.repeat(64), TOKEN]
    expect(authorizeEventsRequest(h, TOKEN, live, eventTokenFor)).toMatchObject({ ok: false, status: 403 })
  })

  /**
   * Structural, and deliberately so. Constant-time comparison is a TIMING
   * property; a behavioural test cannot assert it without measuring wall clock,
   * and a timing assertion in CI is a flake generator that would be silenced
   * within a week. Mutation testing confirmed the gap: replacing the accumulator
   * with an early return breaks no behavioural test, because the function still
   * returns the same booleans — it just leaks how many leading characters
   * matched.
   *
   * So the guard is on the shape. This repo already uses AST/source guards for
   * properties tests cannot reach (see
   * the corresponding server reachability test).
   */
  test('token comparison has no early return — a timing leak tests cannot catch', () => {
    const src = readFileSync(new URL('../events/route.ts', import.meta.url), 'utf8')
    const fn = src.slice(src.indexOf('export function safeTokenEqual'), src.indexOf('function header('))

    // The accumulator form: every character is always compared.
    expect(fn).toContain('mismatch |=')
    // No conditional exit inside the comparison loop.
    const loopBody = fn.slice(fn.indexOf('for ('))
    expect(loopBody).not.toMatch(/if\s*\([^)]*\)\s*return/)
  })
})
