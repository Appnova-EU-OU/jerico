/**
 * A daemon that refuses its own configured endpoint (#571), as the tray sees it.
 *
 * The daemon stays alive on purpose in this state — exiting non-zero under
 * launchd's KeepAlive would respawn it every 30 seconds — so from the outside
 * it looks exactly like a daemon whose socket is merely down. "Reconnecting"
 * is then the one word that is certainly wrong: nothing reconnects until the
 * settings file changes. These tests hold the surface to naming the cause.
 *
 * Wired into `npm run test` in apps/desktop/package.json. A test file that is
 * not named there never runs (#568).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHealth, NO_ANSWER } from '../src/main/utils/health-classify.ts'
import { derivePhase, present, type PopoverFacts } from '../src/main/utils/popover-model.ts'

const REASON =
  'a plaintext ws daemon endpoint is allowed only on a loopback host — '
  + 'this one would send the daemon token unencrypted to another machine'

function facts(over: Partial<PopoverFacts> = {}): PopoverFacts {
  return {
    state: 'yellow',
    transition: null,
    authFailed: false,
    endpointRejectedReason: null,
    endpointRepairCommand: null,
    foreignRegistrationReason: null,
    activePanels: 0,
    reconnectAttempts: 0,
    uptimeSeconds: 120,
    lastRttMs: null,
    lastPongAgoMs: null,
    rttHistory: null,
    healthPort: 3101,
    stoppedAgoMs: null,
    webAvailable: true,
    ...over,
  }
}

test('the daemon health reason survives the classifier intact', () => {
  const result = classifyHealth(
    {
      status: 'endpoint_rejected',
      profile: null,
      connected: false,
      authFailed: false,
      endpointRejected: true,
      endpointRejectedReason: REASON,
    },
    null,
    503,
  )
  assert.equal(result.endpointRejectedReason, REASON)
  // Still yellow: the daemon is up, so the tray must not claim it is stopped.
  assert.equal(result.state, 'yellow')
})

test('a daemon too old to report the field is not accused of refusing anything', () => {
  const result = classifyHealth({ connected: true, activePanels: 1 }, null, 200)
  assert.equal(result.endpointRejectedReason, null)
  assert.equal(NO_ANSWER.endpointRejectedReason, null)
})

test('the flag without a sentence still says something true', () => {
  const result = classifyHealth({ connected: false, endpointRejected: true }, null, 503)
  assert.equal(result.endpointRejectedReason, 'the configured server endpoint was refused')
})

test('a refused endpoint is its own state, not "Reconnecting"', () => {
  const f = facts({ endpointRejectedReason: REASON })
  assert.equal(derivePhase(f), 'endpointrejected')
  const p = present(f)
  assert.equal(p.headline, 'Server address refused')
  // The cause is on the surface, in the daemon's own words.
  assert.equal(p.sub.parts[0], REASON)
  assert.ok(!p.verbs.some((v) => v.action === 'reconnect'),
    'redialling cannot fix a value the daemon refuses to dial')
})

test('the offered action is not one that cannot work', () => {
  // 'reauth' opens the connect page (tray.ts runAction). Signing in on the web
  // does not rewrite settings.json, and plain `bridge-agent auth` exits 1 on an
  // invalid configured value — so offering "Re-authenticate" here pointed the
  // user at a door that does not open (#571 review B2).
  const p = present(facts({ endpointRejectedReason: REASON }))
  assert.notEqual(p.primary.action, 'reauth')
  assert.equal(p.primary.action, 'logs')
})

test('the command that does work is on the surface, verbatim', () => {
  const p = present(facts({
    endpointRejectedReason: REASON,
    endpointRepairCommand: 'bridge-agent --profile dev auth --daemon-server wss://<host>/ws/daemon',
  }))
  assert.ok(p.sub.parts.includes('bridge-agent --profile dev auth --daemon-server wss://<host>/ws/daemon'))
})

test('a daemon too old to send the command still gets a runnable one', () => {
  const p = present(facts({ endpointRejectedReason: REASON }))
  assert.ok(p.sub.parts.some((part) => part.includes('--daemon-server')))
})

test('a refused endpoint outranks a stale auth-failed flag', () => {
  // A daemon that never dials cannot have had its token rejected, so an
  // auth-failed reading alongside this one is stale by definition. Ranking it
  // first put a re-auth wizard in front of the user whose auth then fails on
  // the very endpoint being complained about. The daemon ranks them the same
  // way (commands/start.ts) — the two must not disagree.
  assert.equal(derivePhase(facts({ authFailed: true, endpointRejectedReason: REASON })), 'endpointrejected')
})

test('an ordinary wedged socket is still Reconnecting', () => {
  assert.equal(derivePhase(facts({ reconnectAttempts: 3 })), 'reconnecting')
})
