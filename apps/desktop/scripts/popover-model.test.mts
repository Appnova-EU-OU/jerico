import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  derivePhase,
  present,
  formatUptime,
  formatAgo,
  limitsFromUsage,
  type PopoverFacts,
} from '../src/main/utils/popover-model.ts'

/** A connected daemon with three panels and no readings the daemon cannot
 *  produce. Every test overrides only what it is about. */
function facts(over: Partial<PopoverFacts> = {}): PopoverFacts {
  return {
    state: 'green',
    transition: null,
    authFailed: false,
    endpointRejectedReason: null,
    endpointRepairCommand: null,
    foreignRegistrationReason: null,
    activePanels: 3,
    reconnectAttempts: 0,
    uptimeSeconds: 4 * 86400 + 6 * 3600 + 14 * 60,   // 4d 06:14
    lastRttMs: null,
    lastPongAgoMs: null,
    rttHistory: null,
    healthPort: 3101,
    stoppedAgoMs: null,
    webAvailable: true,
    ...over,
  }
}

// ── the seven states ──────────────────────────────────────────────────────

test('every one of the seven states is reachable from real health readings', () => {
  assert.equal(derivePhase(facts()), 'working')
  assert.equal(derivePhase(facts({ activePanels: 0 })), 'idle')
  assert.equal(derivePhase(facts({ transition: 'starting', state: 'red' })), 'starting')
  assert.equal(derivePhase(facts({ state: 'yellow' })), 'reconnecting')
  assert.equal(derivePhase(facts({ state: 'yellow', authFailed: true })), 'authfailed')
  assert.equal(derivePhase(facts({ transition: 'stopping' })), 'stopping')
  assert.equal(derivePhase(facts({ state: 'red', activePanels: 0 })), 'offline')
})

test('a start or stop this app launched outranks whatever health last said', () => {
  // Mid-start the daemon is still red and mid-stop still green; reading those
  // literally is how the surface flickers "Offline" over a start in progress.
  assert.equal(derivePhase(facts({ transition: 'starting', state: 'red' })), 'starting')
  assert.equal(derivePhase(facts({ transition: 'stopping', state: 'green' })), 'stopping')
})

test('a rejected token is the fault whether the daemon survived it or not', () => {
  // The daemon exits shortly after the second 1008, so both readings occur and
  // both mean the same thing to the user: sign in again.
  assert.equal(derivePhase(facts({ state: 'yellow', authFailed: true })), 'authfailed')
  assert.equal(derivePhase(facts({ state: 'red', authFailed: true })), 'authfailed')
})

test('usage-specific fault codes are neutral and actionable', () => {
  const phrase = (faultCode: string) => limitsFromUsage([{ agent: 'claude', windows: [], faultCode, stale: false, fetchedAt: null }] as any)?.[0]?.fault
  assert.equal(phrase('no_usage_token'), 'no usage token')
  assert.equal(phrase('keychain_deferred'), 'open usage to read')
  assert.equal(phrase('interactive_deferred'), 'open usage to read')
  assert.equal(phrase('token_lapsed'), 'reading paused')
  assert.equal(phrase('unauthorized'), 'token expired')
})

test('a deferred keychain reading stays visibly aged and an elapsed reset loses its percentage', () => {
  const [deferred] = limitsFromUsage([{
    agent: 'claude', windows: [{ id: 'session', title: 'session', usedPercent: 12, severity: 'normal', isActive: true, resetsAt: Date.now() + 60_000, windowMinutes: 300, scopedUnder: null, counts: null }],
    faultCode: 'keychain_deferred', faultDetail: 'not read', stale: true, fetchedAt: 1,
  }] as any) ?? []
  assert.equal(deferred?.stale, true)
  assert.equal(deferred?.deferred, true)
  assert.equal(deferred?.usedPercent, 12)

  const [expired] = limitsFromUsage([{
    agent: 'claude', windows: [{ id: 'session', title: 'session', usedPercent: 12, severity: 'normal', isActive: true, resetsAt: Date.now() - 1, windowMinutes: 300, scopedUnder: null, counts: null }],
    faultCode: 'keychain_deferred', faultDetail: 'not read', stale: true, fetchedAt: 1,
  }] as any) ?? []
  assert.equal(expired?.usedPercent, null)
  assert.equal(expired?.resetsAt, null)
})

// ── the reading follows the fault ─────────────────────────────────────────

test('with work running the headline is the work, and connected drops to the sub', () => {
  const p = present(facts())
  assert.equal(p.headline, '3 panels')
  assert.equal(p.sub.status, 'connected')
  assert.match(p.sub.parts.join(' · '), /up 4d/)
})

test('a fault takes the headline back', () => {
  assert.equal(present(facts({ state: 'red', activePanels: 0 })).headline, 'Offline')
  assert.equal(present(facts({ state: 'yellow' })).headline, 'Reconnecting')
  assert.equal(present(facts({ state: 'yellow', authFailed: true })).headline, 'Sign-in expired')
})

test('one panel is a panel, not 1 panels', () => {
  assert.equal(present(facts({ activePanels: 1 })).headline, '1 panel')
})

// ── so does the action ────────────────────────────────────────────────────

test('the one filled control is whatever you came here to do', () => {
  assert.equal(present(facts()).primary.action, 'open-jerico')
  assert.equal(present(facts({ state: 'red', activePanels: 0 })).primary.action, 'start')
  assert.equal(present(facts({ state: 'yellow', authFailed: true })).primary.action, 'reauth')
})

test('an invalid named-profile endpoint contract offers no production web CTA', () => {
  const working = present(facts({ webAvailable: false }))
  assert.equal(working.primary.label, 'Server configuration required')
  assert.equal(working.primary.enabled, false)

  const authFailed = present(facts({ state: 'yellow', authFailed: true, webAvailable: false }))
  assert.equal(authFailed.primary.label, 'Server configuration required')
  assert.equal(authFailed.primary.enabled, false)

  const offline = present(facts({ state: 'red', activePanels: 0, webAvailable: false }))
  assert.equal(offline.primary.action, 'start')
  assert.equal(offline.verbs.some((verb) => verb.action === 'open-jerico'), false)
})

test('the fix is never a grey row three items down', () => {
  // Reconnect is offered as a verb the moment the socket is wedged — the old
  // NSMenu hid it until the second attempt because a menu could not say why.
  const p = present(facts({ state: 'yellow', reconnectAttempts: 1 }))
  assert.ok(p.verbs.some((v) => v.action === 'reconnect'))
})

test('nothing offers to open into a daemon that is being stopped', () => {
  const p = present(facts({ transition: 'stopping' }))
  assert.equal(p.primary.enabled, false)
  assert.deepEqual(p.verbs, [])
})

test('a daemon that exited after rejection is not offered a stop', () => {
  const p = present(facts({ state: 'red', authFailed: true, activePanels: 0 }))
  assert.equal(p.verbs.length, 0)
})

// ── unknown is not zero ───────────────────────────────────────────────────

test('a daemon that does not report round-trips gets a strip that says so', () => {
  // A flat line at zero would read as "every ping took no time at all", which
  // is the opposite of what is true. This is the reading the daemon cannot
  // produce yet, so it is the one most likely to be drawn as a lie.
  assert.equal(present(facts({ rttHistory: null })).trace, 'none')
  assert.equal(present(facts({ rttHistory: [] })).trace, 'run')
  assert.equal(present(facts({ state: 'yellow', rttHistory: null })).trace, 'none')
  assert.equal(present(facts({ state: 'yellow', rttHistory: [80, 91] })).trace, 'break')
})

test('an unknown uptime is omitted, never rendered as zero', () => {
  const p = present(facts({ uptimeSeconds: null }))
  assert.equal(p.sub.parts.join(' '), '')
  assert.equal(p.sub.status, 'connected')
})

test('offline only claims a stopped-ago when this app watched it stop', () => {
  assert.deepEqual(present(facts({ state: 'red', activePanels: 0 })).sub.parts, ['launchd idle'])
  assert.deepEqual(
    present(facts({ state: 'red', activePanels: 0, stoppedAgoMs: 134_000 })).sub.parts,
    ['stopped 2m 14s ago', 'launchd idle'],
  )
})

test('reconnecting omits a last-pong it was never told', () => {
  const p = present(facts({ state: 'yellow', reconnectAttempts: 3 }))
  assert.deepEqual(p.sub.parts, ['attempt 3', '3 panels held'])
  const withPong = present(facts({ state: 'yellow', reconnectAttempts: 3, lastPongAgoMs: 41_000 }))
  assert.deepEqual(withPong.sub.parts, ['attempt 3', 'last pong 41s ago', '3 panels held'])
})

// ── formatting ────────────────────────────────────────────────────────────

test('uptime drops units it does not have yet', () => {
  assert.equal(formatUptime(null), null)
  assert.equal(formatUptime(14), '14s')
  assert.equal(formatUptime(3 * 60 + 5), '00:03')
  assert.equal(formatUptime(6 * 3600 + 14 * 60), '06:14')
  assert.equal(formatUptime(4 * 86400 + 6 * 3600 + 14 * 60), '4d 06:14')
})

test('ago reads in seconds until it cannot', () => {
  assert.equal(formatAgo(null), null)
  assert.equal(formatAgo(41_000), '41s')
  assert.equal(formatAgo(134_000), '2m 14s')
})
