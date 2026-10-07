import net from 'node:net'
import { stopDaemon } from './stop.js'
import { startOrKickstartDaemon, detectForeignRegistration, type ForeignRegistrationCheck } from './start.js'
import { getDaemonEntry } from '../version.js'
import { getHealthPort } from '../profile.js'
import { getDaemonVersion } from '../version.js'
import { logLifecycle } from '../lifecycle-log.js'

/**
 * Wait until the health port is free (TCP connect fails with ECONNREFUSED).
 * Returns true on success, false on timeout.
 */
function waitForPortFree(timeoutMs: number): Promise<boolean> {
  const port = getHealthPort()
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tryConnect = (): void => {
      if (Date.now() > deadline) {
        resolve(false)
        return
      }
      const sock = new net.Socket()
      sock.setTimeout(1000)
      sock.on('connect', () => {
        sock.destroy()
        setTimeout(tryConnect, 500)
      })
      sock.on('error', (err: NodeJS.ErrnoException) => {
        sock.destroy()
        if (err.code === 'ECONNREFUSED') {
          resolve(true)
        } else {
          setTimeout(tryConnect, 500)
        }
      })
      sock.on('timeout', () => {
        sock.destroy()
        setTimeout(tryConnect, 500)
      })
      sock.connect(port, '127.0.0.1')
    }
    tryConnect()
  })
}

/**
 * Poll /health until version matches target (or timeout).
 * Returns true if version matched, false on timeout or mismatch.
 */
function awaitHealthVersion(targetVersion: string, timeoutMs: number): Promise<boolean> {
  const port = getHealthPort()
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tryFetch = (): void => {
      if (Date.now() > deadline) {
        logLifecycle('lifecycle.restart.version_timeout', { target: targetVersion }, 'cli')
        resolve(false)
        return
      }
      const http = require('node:http')
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, (res: any) => {
        let data = ''
        res.on('data', (chunk: string) => { data += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.version === targetVersion) {
              logLifecycle('lifecycle.restart.version_confirmed', { version: parsed.version }, 'cli')
              resolve(true)
            } else {
              logLifecycle('lifecycle.restart.version_mismatch', { got: parsed.version, expected: targetVersion }, 'cli')
              setTimeout(tryFetch, 1000)
            }
          } catch {
            setTimeout(tryFetch, 1000)
          }
        })
      })
      req.on('error', () => { setTimeout(tryFetch, 1000) })
      req.on('timeout', () => { req.destroy(); setTimeout(tryFetch, 1000) })
    }
    setTimeout(tryFetch, 2000) // Give the daemon 2s to boot
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Re-read the registration until it PROVES it is ours, within a short budget.
 *
 * Three outcomes, not two. `detectForeignRegistration()` reports `foreign: false`
 * both for "I checked and it is ours" (`matches`) and for "I could not check"
 * (`probe_unavailable`, `unparseable`, `unresolvable_path`) — that conflation is
 * correct where it is used to gate a DESTRUCTIVE bootout, and wrong here, where the
 * same boolean was used to gate a claim of SUCCESS. Verification has to ask for the
 * positive.
 *
 * The retry exists because launchd genuinely lags: `launchctl list` right after a
 * bootstrap can answer before the new job's Program is queryable, and failing a
 * repair that worked is its own bug. Bounded so it cannot become a hang.
 */
const REGISTRATION_VERIFY_ATTEMPTS = 5
const REGISTRATION_VERIFY_DELAY_MS = 600

async function verifyRegistrationIsOurs(): Promise<ForeignRegistrationCheck> {
  let last = detectForeignRegistration()
  for (let attempt = 1; attempt < REGISTRATION_VERIFY_ATTEMPTS; attempt++) {
    if (last.reason === 'matches') return last
    logLifecycle('lifecycle.restart.registration_reprobe', {
      attempt,
      reason: last.reason,
      detail: last.detail,
    }, 'cli')
    await sleep(REGISTRATION_VERIFY_DELAY_MS)
    last = detectForeignRegistration()
  }
  return last
}

/**
 * restart = stop → waitForPortFree → start → awaitVersion
 *
 * Sequence:
 *  1. stop()           — graceful 3-phase stop, keeps launchd job loaded
 *  2. waitForPortFree() — wait up to 10s for health port to free
 *  3. start()           — idempotent enable+kickstart
 *  4. awaitVersion()    — wait up to 30s for /health version to match current binary
 */
export async function runRestart(): Promise<void> {
  logLifecycle('lifecycle.restart.begin', { version: getDaemonVersion() }, 'cli')
  console.log('[bridge] restart.begin — stopping daemon...')

  const targetVersion = getDaemonVersion()

  // Phase 1: stop
  //
  // A foreign/stale launchd registration (issue #577) cannot be repaired by a plain
  // stop: the job stays LOADED, so `start` finds the same stale registration. On the
  // exact population this repairs — pre-2026-05-01 installs — the old plist carries
  // a bare `KeepAlive = true` with no ThrottleInterval, so launchd respawns the old
  // program within ~10s and `start`'s probe can land after that respawn, see
  // loaded_running, and print the same advice again. `--unload` boots the job out, so
  // KeepAlive cannot respawn it and `start` bootstraps our own plist. Gated on a
  // PROVABLE mismatch: an ordinary restart still takes the non-unloading path.
  const registrationCheck = detectForeignRegistration()
  if (registrationCheck.foreign) {
    console.warn(`[bridge] restart.foreign_registration — ${registrationCheck.detail}. Unloading the login service so it is re-registered.`)
    logLifecycle('lifecycle.restart.foreign_registration', {
      reason: registrationCheck.reason,
      detail: registrationCheck.detail,
    }, 'cli')
  }
  const stopResult = stopDaemon(registrationCheck.foreign ? { unload: true } : undefined)
  if (!stopResult.ok) {
    logLifecycle('lifecycle.restart.stop_failed', { reason: stopResult.reason }, 'cli')
    console.error(`[bridge] restart.failed — stop: ${stopResult.reason}`)
    process.exit(1)
  }
  logLifecycle('lifecycle.restart.stop_ok', { reason: stopResult.reason }, 'cli')
  console.log('[bridge] restart.stop_ok')

  // Phase 2: wait for port to be free
  console.log('[bridge] restart.waiting_port_free...')
  const portFreed = await waitForPortFree(10_000)
  if (!portFreed) {
    logLifecycle('lifecycle.restart.port_busy_timeout', {}, 'cli')
    console.error('[bridge] restart.failed — health port still in use after 10s')
    process.exit(1)
  }
  logLifecycle('lifecycle.restart.port_free', {}, 'cli')
  console.log('[bridge] restart.port_free — starting new daemon...')

  // Phase 3: start
  const daemonEntry = getDaemonEntry()
  const result = startOrKickstartDaemon(daemonEntry)
  if (!result.ok) {
    logLifecycle('lifecycle.restart.start_failed', { reason: result.reason }, 'cli')
    console.error(`[bridge] restart.failed — ${result.reason}`)
    process.exit(1)
  }
  logLifecycle('lifecycle.restart.start_ok', { reason: result.reason }, 'cli')
  console.log(`[bridge] restart.start_ok — ${result.reason}`)

  // Phase 4: await version confirmation
  console.log('[bridge] restart.awaiting_version...')
  const versionConfirmed = await awaitHealthVersion(targetVersion, 30_000)
  if (!versionConfirmed) {
    logLifecycle('lifecycle.restart.version_not_confirmed', {}, 'cli')
    console.error('[bridge] restart.failed — version did not match after 30s')
    process.exit(1)
  }

  // Phase 5: prove the registration is ours now.
  //
  // The version check above cannot do it. `restart` is the advertised remedy for a
  // foreign registration (issue #577), and the commonest foreign registration is a
  // DIFFERENT DISTRIBUTION of the SAME version — an npm install and an app install
  // of 0.24.0 report identical /health versions, so the old program answering the
  // health port passes Phase 4 and `restart.complete` would claim a repair that
  // never happened. The registration itself is the thing this command changed, so
  // the registration is the thing it has to re-read.
  //
  // Only a positive `matches` ends this command successfully. `foreign: false` is NOT
  // that: `probe_unavailable`, `unparseable` and `unresolvable_path` all report it
  // while proving nothing, and reading them as success is the same fail-open shape
  // round 2 removed from `start.ts` and `stop.ts` — `restart.complete` would print,
  // the desktop would clear the fault, and launchd could still be holding the stale
  // registration. Not-proven is its own failure with its own reason code, distinct
  // from a proven mismatch so the desktop is not told the opposite of what is known.
  const afterCheck = await verifyRegistrationIsOurs()
  if (afterCheck.foreign) {
    logLifecycle('lifecycle.restart.foreign_registration_persists', {
      reason: afterCheck.reason,
      detail: afterCheck.detail,
    }, 'cli')
    console.error(`[bridge] restart.failed — the login service is STILL registered against another program: ${afterCheck.detail}`)
    console.error('[bridge] restart.failed.detail — foreign_registration_persists')
    process.exit(1)
  }
  if (afterCheck.reason !== 'matches') {
    logLifecycle('lifecycle.restart.registration_not_verified', {
      reason: afterCheck.reason,
      detail: afterCheck.detail,
      attempts: REGISTRATION_VERIFY_ATTEMPTS,
    }, 'cli')
    console.error('[bridge] restart.failed — the daemon restarted, but it could not be confirmed that the login '
      + `service now points at this install: ${afterCheck.detail}`)
    console.error('[bridge] restart.failed.detail — registration_not_verified')
    process.exit(1)
  }
  logLifecycle('lifecycle.restart.registration_verified', { reason: afterCheck.reason }, 'cli')

  logLifecycle('lifecycle.restart.complete', { version: targetVersion }, 'cli')
  console.log('[bridge] restart.complete')
  process.exit(0)
}
