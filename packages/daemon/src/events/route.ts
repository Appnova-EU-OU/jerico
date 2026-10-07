/**
 * Authorization and request handling for the orchestrator event surface
 * (#616, slice 2), kept free of `node:http` so it is testable without a port.
 *
 * The daemon already runs a loopback HTTP router whose hook route implements
 * exactly the three checks this surface needs — constant-time shared secret,
 * protocol negotiation, and panel-instance binding
 * (`packages/daemon/src/hooks/receiver.ts:148,156-161,181`). Those are reused
 * rather than reinvented: a second trust model on the same socket would be new
 * attack surface bought for nothing.
 */

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

export const EVENTS_ROUTE_PATH = '/v1/orchestrator-events/poll'
export const EVENTS_ACK_PATH   = '/v1/orchestrator-events/ack'

/** Bound so a client cannot ask the daemon to hold a socket indefinitely, and so
 *  a wedged reader is still identified within the broker's hang window. */
export const MAX_POLL_WAIT_MS = 30_000
export const MIN_POLL_WAIT_MS = 1_000

export type AuthFailure =
  | { ok: false; status: 403; error: 'invalid_token' }
  | { ok: false; status: 422; error: 'protocol_mismatch' | 'missing_identity' | 'invalid_instance' }
  | { ok: false; status: 409; error: 'panel_gone' }

export type AuthResult =
  | { ok: true; agentId: string; instanceId: number }
  | AuthFailure

export interface RequestHeaders {
  [key: string]: string | string[] | undefined
}

/** Constant-time compare, mirroring `hooks/receiver.ts:28-35`. Length is
 *  compared first and leaks only the length, which the protocol fixes anyway. */
export function safeTokenEqual(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  let mismatch = 0
  for (let i = 0; i < actual.length; ++i) {
    mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return mismatch === 0
}

function header(headers: RequestHeaders, name: string): string | undefined {
  const raw = headers[name]
  return Array.isArray(raw) ? raw[0] : raw
}

/**
 * Authorize an events request. Order matters and mirrors the hook route: the
 * token is checked before anything else is even parsed, so a caller that cannot
 * authenticate learns nothing about which identities exist.
 */
export function authorizeEventsRequest(
  headers: RequestHeaders,
  expectedToken: string,
  isPanelLive: (agentId: string, instanceId: number) => boolean,
  getPanelEventToken: (agentId: string, instanceId: number) => string | undefined,
): AuthResult {
  if (!safeTokenEqual(header(headers, HEADER_TOKEN), expectedToken)) {
    return { ok: false, status: 403, error: 'invalid_token' }
  }

  const protocol = header(headers, HEADER_PROTOCOL)
  const version  = header(headers, HEADER_PROTOCOL_VERSION)
  if (protocol !== HOOK_PROTOCOL || version !== String(EVENTS_PROTOCOL_VERSION)) {
    // Loud rather than lenient: a version skew that parses "close enough" is how
    // a protocol change turns into silent misbehaviour months later.
    return { ok: false, status: 422, error: 'protocol_mismatch' }
  }

  const agentId       = header(headers, HEADER_AGENT_ID)
  const instanceIdRaw = header(headers, HEADER_INSTANCE_ID)
  if (!agentId || agentId.trim() === '' || !instanceIdRaw) {
    return { ok: false, status: 422, error: 'missing_identity' }
  }

  // Canonical decimal only. `Number.parseInt` stops at the first non-digit, so
  // '3abc', '007' and ' 3 ' all yield 3 — a malformed header silently accepted,
  // and several distinct header values collapsing onto one subscriber. Every
  // other check in this module refuses loudly rather than parsing leniently.
  if (!/^[1-9][0-9]*$/.test(instanceIdRaw)) {
    return { ok: false, status: 422, error: 'invalid_instance' }
  }
  const instanceId = Number.parseInt(instanceIdRaw, 10)
  if (!Number.isSafeInteger(instanceId)) {
    return { ok: false, status: 422, error: 'invalid_instance' }
  }

  // Panel-instance binding: a stream is bound to the PTY generation that asked
  // for it, so a restarted panel cannot resume the previous one's subscription.
  if (!isPanelLive(agentId, instanceId)) {
    return { ok: false, status: 409, error: 'panel_gone' }
  }

  // Fix 2: per-panel event token binds the stream to the panel that owns it.
  // The daemon-wide hook token proves "same machine and same daemon run"; the
  // per-panel token proves "this specific PTY generation". Without it, any
  // panel that can read BRIDGE_HOOK_DESCRIPTOR (every panel) could poll/ACK
  // another panel's stream and destroy its delivery (ACK advances the cursor).
  // This check is fail-closed: a missing resolver or a missing/undefined token
  // for a live panel is treated as 403, not skipped. A future call site that
  // forgets the 4th argument will be loudly rejected (every poll 403) rather
  // than silently losing the security property — the repo's most repeated
  // defect shape.
  {
    const expectedEventToken = getPanelEventToken(agentId, instanceId)
    const suppliedEventToken = header(headers, HEADER_EVENT_TOKEN)
    if (expectedEventToken === undefined) {
      // Panel is live per isPanelLive but no token was issued for this generation.
      // Treat as invalid auth rather than 409 — the generation exists but its
      // stream credential is absent (e.g. upgraded daemon with old panel, or a
      // caller that forgot the resolver). Fail closed, never skip.
      return { ok: false, status: 403, error: 'invalid_token' }
    }
    if (!safeTokenEqual(suppliedEventToken, expectedEventToken)) {
      return { ok: false, status: 403, error: 'invalid_token' }
    }
  }

  return { ok: true, agentId, instanceId }
}

/** Clamp a caller-supplied wait. An unbounded value would let a client pin a
 *  daemon socket open; a zero would turn long-poll into a busy loop. */
export function clampPollWait(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_POLL_WAIT_MS, Math.max(MIN_POLL_WAIT_MS, Math.floor(n)))
}

/**
 * The subscriber id for a panel. Derived rather than caller-supplied: a client
 * that could name its own subscriber could read another panel's stream, and the
 * headers are already authenticated.
 */
export function subscriberIdFor(agentId: string, instanceId: number): string {
  // The agent id is percent-encoded before joining. Today's ids are UUIDs with
  // no '#', so a plain join is unambiguous — but only by accident of the current
  // charset, and `subscriberIdFor('a#b', 1)` already collides in shape with
  // `subscriberIdFor('a', ...)`. Encoding costs nothing and removes the day the
  // charset widens from the list of things that can quietly break this.
  return `${encodeURIComponent(agentId)}#${instanceId}`
}
