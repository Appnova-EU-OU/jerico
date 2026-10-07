/**
 * A launchd label registered against someone else's program (#577), as the desktop
 * sees it.
 *
 * This was the population the daemon-side fix could not reach: `start` correctly
 * refuses to boot out a RUNNING foreign registration and returns a reason naming
 * the repair — and the desktop had no way to run that repair, no way to recognise
 * the reason, and (because the plist FILE is fine) no gate that would even mention
 * it. Pressing Start again produced the identical failure forever.
 *
 * Two things are held here: the stderr contract between the daemon's two printed
 * lines and whatever the desktop shows, and the surface's promise that the remedy
 * is an explicit action which says what it costs.
 *
 * Wired into `npm run test` in apps/desktop/package.json. A test file that is not
 * named there never runs (#568).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  preferredFailureLine,
  failureCode,
  foreignRegistrationFault,
} from '../src/main/utils/daemon-failure.ts'
import { derivePhase, present, type PopoverFacts } from '../src/main/utils/popover-model.ts'

/** Exactly what `bridge-agent start` prints for this failure: the humanised
 *  sentence FIRST, the machine reason SECOND (start.ts, the start.failed pair). */
const START_STDERR = [
  '[bridge] start.foreign_registration — launchd holds this label against "/old/.bridge/bridge-agent-wrapper.sh", not the program we manage ("/Users/me/.bridge/bridge-agent-wrapper.sh").',
  '[bridge] start.failed — The login service is registered against a different (older) install of the daemon, so restarting it would keep launching that one. Run `bridge-agent restart` to re-register it.',
  '[bridge] start.failed.detail — foreign_registration_running: launchd holds this label against "/old/.bridge/bridge-agent-wrapper.sh", not the program we manage ("/Users/me/.bridge/bridge-agent-wrapper.sh"). Re-register the login service with: bridge-agent restart',
].join('\n')

const INSTALL_STDERR = [
  '[bridge] service.install.launchctl.failed',
  '[bridge] install-service.failed.detail — foreign_registration_running: launchd holds this label against "/old/w.sh", not the program we manage ("/new/w.sh"). Re-register the login service with: bridge-agent restart',
  '[bridge] install-service.failed: The login service is registered against a different (older) install of the daemon, so restarting it would keep launching that one. Run `bridge-agent restart` to re-register it.',
].join('\n')

// ── the stderr contract ───────────────────────────────────────────────────

test('the humanised sentence is what surfaces, not whichever line came last', () => {
  // `stderr.trim().split('\n').pop()` took the LAST line, which is always the
  // machine reason — so the sentence humanStartFailure() exists to produce was
  // discarded for every failure mode.
  const line = preferredFailureLine(START_STDERR)
  assert.ok(line?.startsWith('The login service is registered against a different'))
  assert.ok(!line?.includes('foreign_registration_running'))
})

test('it works whichever order the two lines arrive in', () => {
  // install-service prints detail-then-human, start prints human-then-detail.
  // Position must not be load-bearing in either direction.
  const line = preferredFailureLine(INSTALL_STDERR)
  assert.ok(line?.startsWith('The login service is registered against a different'))
})

test('an opaque generic failure still yields its last line rather than nothing', () => {
  assert.equal(preferredFailureLine('  \n launchctl: something odd \n'), 'launchctl: something odd')
  assert.equal(preferredFailureLine('   \n  '), null)
})

test('the machine reason stays available for matching, separately from display', () => {
  assert.ok(failureCode(START_STDERR)?.startsWith('foreign_registration_running:'))
  assert.equal(failureCode('[bridge] start.failed — something readable'), null)
})

test('both foreign-registration reasons are recognised, and nothing else is', () => {
  assert.equal(foreignRegistrationFault(START_STDERR)?.kind, 'running')
  assert.equal(
    foreignRegistrationFault('[bridge] start.failed.detail — foreign_registration_bootout_failed: …')?.kind,
    'bootout_failed',
  )
  assert.equal(foreignRegistrationFault('[bridge] start.failed.detail — kickstart_failed: ETIMEDOUT'), null)
  assert.equal(foreignRegistrationFault(''), null)
})

test('the keyword inside a path or a sentence is NOT this fault', () => {
  // Every other vector in this file is in the safe direction — the fault really is
  // present and we check it is found. This is the unsafe direction, and it is the
  // one that shipped: a substring test over the raw stderr blob classified an
  // unrelated failure as a foreign registration because the daemon quoted a path
  // that happens to contain the word. Consequence measured in both consumers: the
  // wizard advises a destructive `bridge-agent restart`, and the tray pins the
  // popover to the foreignregistration phase and hides the real error.
  const quotedPath = [
    '[bridge] start.failed — The daemon could not read its settings file. Check that it is valid JSON.',
    '[bridge] start.failed.detail — settings_unreadable: could not parse '
      + '"/Users/me/.jerico/backups/foreign_registration_archive/settings.json": Unexpected token }',
  ].join('\n')
  assert.equal(foreignRegistrationFault(quotedPath), null)

  // …and the detail must still be the thing that decides, so the sentence a human
  // reads is not a channel either.
  const inProse = [
    '[bridge] start.failed — kickstart timed out; the previous foreign_registration repair may not have finished.',
    '[bridge] start.failed.detail — kickstart_failed: ETIMEDOUT',
  ].join('\n')
  assert.equal(foreignRegistrationFault(inProse), null)

  // A reason code that merely BEGINS like one, with no code line at all, decides
  // nothing either — there is no anchored reason to read.
  assert.equal(foreignRegistrationFault('foreign_registration_running: launchd holds this label'), null)

  // The guard must not have cost us the real thing: same blob, real reason code.
  const real = [
    '[bridge] start.failed — Run `bridge-agent restart` to re-register it.',
    '[bridge] start.failed.detail — foreign_registration_running: launchd holds this label against '
      + '"/Users/me/.jerico/backups/foreign_registration_archive/wrapper.sh"',
  ].join('\n')
  assert.equal(foreignRegistrationFault(real)?.kind, 'running')
})

test('the kind comes from the code, not from the word appearing anywhere', () => {
  // `foreign_registration_bootout_failed` quoted inside a RUNNING verdict's detail
  // must not upgrade the kind — the two get different sentences on the surface.
  const running = [
    '[bridge] start.failed.detail — foreign_registration_running: launchd holds this label against '
      + '"/tmp/foreign_registration_bootout_failed.sh"',
  ].join('\n')
  assert.equal(foreignRegistrationFault(running)?.kind, 'running')
})

test('the fault carries the daemon\'s own sentence, never one invented here', () => {
  const fault = foreignRegistrationFault(START_STDERR)
  assert.ok(fault)
  assert.ok(START_STDERR.includes(fault.message))
})

// ── the surface ───────────────────────────────────────────────────────────

const REASON = 'The login service is registered against a different (older) install of the daemon, '
  + 'so restarting it would keep launching that one. Run `bridge-agent restart` to re-register it.'

function facts(over: Partial<PopoverFacts> = {}): PopoverFacts {
  return {
    state: 'green',
    transition: null,
    authFailed: false,
    endpointRejectedReason: null,
    endpointRepairCommand: null,
    foreignRegistrationReason: null,
    activePanels: 2,
    reconnectAttempts: 0,
    uptimeSeconds: 300,
    lastRttMs: null,
    lastPongAgoMs: null,
    rttHistory: null,
    healthPort: 3101,
    stoppedAgoMs: null,
    webAvailable: true,
    ...over,
  }
}

test('a foreign registration is named, whatever the health reading says', () => {
  // The old install may be up and connected (green) or down (red); either way the
  // fault is the registration, and neither "2 panels" nor "Offline" says so.
  for (const state of ['green', 'yellow', 'red'] as const) {
    assert.equal(derivePhase(facts({ state, foreignRegistrationReason: REASON })), 'foreignregistration')
  }
})

test('a transition, and a fault the daemon reports itself, still outrank it', () => {
  assert.equal(
    derivePhase(facts({ transition: 'stopping', foreignRegistrationReason: REASON })),
    'stopping',
  )
  assert.equal(
    derivePhase(facts({ foreignRegistrationReason: REASON, endpointRejectedReason: 'refused' })),
    'endpointrejected',
  )
  assert.equal(
    derivePhase(facts({ foreignRegistrationReason: REASON, authFailed: true, state: 'yellow' })),
    'authfailed',
  )
})

test('the remedy is an explicit action, and it says what it costs', () => {
  const p = present(facts({ foreignRegistrationReason: REASON }))
  assert.equal(p.primary.action, 'reregister-service')
  assert.equal(p.primary.enabled, true)
  // Not a terminal command the user is left to find, and not a silent restart:
  // the cost of the repair is on the surface next to the button that does it.
  const body = p.sub.parts.join(' · ')
  assert.ok(body.includes(REASON))
  assert.ok(/stops 2 running panels/.test(body))
})

test('the reason is shown verbatim — this file does not paraphrase the daemon', () => {
  const p = present(facts({ foreignRegistrationReason: REASON, activePanels: 0 }))
  assert.equal(p.sub.parts[0], REASON)
  assert.ok(/stops any running agents/.test(p.sub.parts[1] ?? ''))
})

test('Start is NOT offered here — it is the button that already failed', () => {
  const p = present(facts({ state: 'red', activePanels: 0, foreignRegistrationReason: REASON }))
  assert.equal(p.primary.action, 'reregister-service')
  assert.ok(!p.verbs.some((v) => v.action === 'start'))
  // The offline phase, for contrast, offers exactly that.
  assert.equal(present(facts({ state: 'red', activePanels: 0 })).primary.action, 'start')
})

test('clearing the reason returns the surface to the ordinary reading', () => {
  assert.equal(derivePhase(facts({ foreignRegistrationReason: null })), 'working')
})
