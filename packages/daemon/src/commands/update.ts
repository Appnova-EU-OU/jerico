import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import http from 'node:http'
import { getDaemonVersion, getDaemonEntry } from '../version.js'
import path from 'path'
import { setupLaunchd, getCurrentManager } from './start.js'
import { getPlistName, getHealthPort } from '../profile.js'
import { loadConfig, mergeSettings } from '../config.js'
import { checkForUpdate, getLatest, semverGt } from '../update/registry.js'

// ── Global paths (deliberately NOT profile-isolated — see profile.ts comment) ───
const BRIDGE_DIR = path.join(homedir(), '.bridge')
const UPDATE_LOCK = path.join(BRIDGE_DIR, 'update.lock')
const UPDATE_STATE = path.join(BRIDGE_DIR, 'update-state.json')

const LAUNCH_AGENTS = path.join(homedir(), 'Library', 'LaunchAgents')

// ── Lock helpers (kernel-level O_EXCL, same pattern as start.ts:34-44) ──────────

function cleanupStaleUpdateLock(): void {
  if (!existsSync(UPDATE_LOCK)) return
  try {
    const { pid } = JSON.parse(readFileSync(UPDATE_LOCK, 'utf8'))
    if (pid && process.kill(pid, 0)) return   // alive → keep
    unlinkSync(UPDATE_LOCK)                   // stale → remove
  } catch {
    try { unlinkSync(UPDATE_LOCK) } catch {}
  }
}

function acquireUpdateLock(): { ok: boolean; err?: NodeJS.ErrnoException } {
  try { mkdirSync(BRIDGE_DIR, { recursive: true }) } catch {}
  cleanupStaleUpdateLock()
  try {
    const fd = openSync(UPDATE_LOCK, 'wx')
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
    closeSync(fd)
    return { ok: true }
  } catch (err) {
    return { ok: false, err: err as NodeJS.ErrnoException }
  }
}

function releaseUpdateLock(): void {
  try { unlinkSync(UPDATE_LOCK) } catch {}
}

// ── Update state persistence ────────────────────────────────────────────────────

interface UpdateState {
  previousVersion: string
  channel: string
  installedAt: string   // ISO-8601
}

function readUpdateState(): UpdateState | null {
  try {
    const raw = readFileSync(UPDATE_STATE, 'utf-8')
    return JSON.parse(raw) as UpdateState
  } catch {
    return null
  }
}

function writeUpdateState(state: UpdateState): void {
  try { mkdirSync(BRIDGE_DIR, { recursive: true }) } catch {}
  writeFileSync(UPDATE_STATE, JSON.stringify(state, null, 2), { mode: 0o600 })
}

// ── Health poll with version verification ───────────────────────────────────────

/**
 * Poll the daemon health endpoint, waiting for the new version to appear.
 * This is an AWAITED poll (not fire-and-exit).
 *
 * Success requires the daemon to report the target version in its health JSON.
 * Any status code is accepted — the daemon may return 503 while reconnecting
 * after a restart; what matters is `body.version === targetVersion`.
 * A 200 alone is not enough — the version match proves the NEW code is running.
 *
 * Returns true if the daemon reports version === target within timeoutMs.
 */
function awaitVersionHealth(targetVersion: string, timeoutMs = 30_000): Promise<boolean> {
  const healthPort = getHealthPort()
  const deadline = Date.now() + timeoutMs

  return new Promise((resolve) => {
    const poll = () => {
      if (Date.now() > deadline) {
        resolve(false)
        return
      }
      try {
        const req = http.get(`http://127.0.0.1:${healthPort}/health`, (res) => {
          let data = ''
          res.on('data', (chunk: string) => { data += chunk })
          res.on('end', () => {
            // Accept any status code — version match proves the new binary is running.
            // A daemon that hasn't reconnected yet returns 503 but has the correct version.
            try {
              const body = JSON.parse(data)
              if (body.version === targetVersion) {
                resolve(true)
                return
              }
            } catch { /* parse error — retry */ }
            setTimeout(poll, 500)
          })
        })
        req.on('error', () => { setTimeout(poll, 500) })
        req.setTimeout(1000, () => { req.destroy(); setTimeout(poll, 500) })
      } catch {
        setTimeout(poll, 500)
      }
    }
    setTimeout(poll, 1000)   // wait 1s for launchd to spawn
  })
}

// ── Prompt helpers ──────────────────────────────────────────────────────────────

function isInteractive(): boolean {
  return process.stdin.isTTY ?? false
}

function confirm(message: string, force?: boolean): boolean {
  if (force) {
    console.log(`[bridge] update.force: ${message}`)
    return true
  }
  if (!isInteractive()) {
    console.error('[bridge] update.aborted: non-interactive terminal — use --force')
    return false
  }
  try {
    const result = execSync(`read -p "${message} (y/N) " -n 1 REPLY && echo $REPLY`, {
      stdio: [process.stdin.fd, 'pipe', 'pipe'],
    }).toString().trim()
    return result.toLowerCase() === 'y'
  } catch {
    return false
  }
}

// ── Valid update channels (prevent command injection via user-supplied channel)
// Sync with registry.ts — any channel supported by npm dist-tag must be listed here.
const VALID_CHANNELS = new Set(['latest', 'stable', 'beta', 'alpha', 'next', 'canary']);

// ── Main update logic ───────────────────────────────────────────────────────────

export async function runUpdate(opts: {
  check?: boolean
  channel?: string
  saveChannel?: boolean
  force?: boolean
  yes?: boolean
}): Promise<void> {
  const currentVersion = getDaemonVersion()
  const config = loadConfig()
  const rawChannel = opts.channel ?? config.updateChannel ?? 'latest'
  const channel = VALID_CHANNELS.has(rawChannel) ? rawChannel : 'latest'

  // ── Refuse bundled (pkg) binary — update via the desktop app ────────────
  // @yao-pkg/pkg sets process.pkg to a non-undefined value when running inside
  // a compiled binary (same check used in start.ts:22,144,267). Bundled users
  // must update by upgrading the jerico.app itself (electron-updater), never npm.
  if ((process as any).pkg !== undefined) {
    console.error('[bridge] update.refused: bundled install — cannot self-update via npm.')
    console.error('[bridge]   Update via the Jerico desktop app (tray → Update).')
    process.exit(1)
  }

  // ── AC4: Refuse monorepo runs ────────────────────────────────────────────
  const daemonEntry = getDaemonEntry()
  if (daemonEntry.includes('packages/daemon/dist') || daemonEntry.includes('packages/daemon/src')) {
    console.error('[bridge] update.refused: running from monorepo — cannot self-update a dev checkout.')
    console.error('[bridge]   To test update logic, install the published package globally:')
    console.error('[bridge]   npm i -g bridge-agent')
    process.exit(1)
  }

  // ── --check mode (AC12): exit code semantics ─────────────────────────────
  if (opts.check) {
    const result = checkForUpdate(channel, currentVersion)
    if (result.updateAvailable) {
      console.log(`[bridge] update.available: ${currentVersion} → ${result.latestVersion} (channel: ${channel})`)
      process.exit(10)
    }
    const reason = result.reason ?? 'unknown'
    console.log(`[bridge] update.unavailable: ${currentVersion} (channel: ${channel}, reason: ${reason})`)
    process.exit(0)
  }

  // ── Check for update ─────────────────────────────────────────────────────
  const latest = getLatest(channel)
  if (!latest) {
    console.error('[bridge] update.failed: cannot reach npm registry')
    process.exit(1)
  }

  if (currentVersion === latest) {
    console.log(`[bridge] update.up_to_date: ${currentVersion} (channel: ${channel})`)
    if (opts.saveChannel) {
      mergeSettings({ updateChannel: channel })
      console.log(`[bridge] update.channel.saved: ${channel}`)
    }
    process.exit(0)
  }

  // NEVER downgrade (AC3)
  if (semverGt(currentVersion, latest)) {
    console.log(`[bridge] update.ahead: ${currentVersion} > ${latest} (channel: ${channel}).`)
    console.log('[bridge]   You are on a build ahead of the public channel. Update not available.')
    process.exit(0)
  }

  console.log(`[bridge] update.available: ${currentVersion} → ${latest} (channel: ${channel})`)

  // ── AC9: Active panels safety check ─────────────────────────────────────
  // --force bypasses this block. --yes does NOT — it only skips TTY prompts
  // for other confirmations. CI can --yes without risking panel kills.
  const activePanels = getCurrentManager()?.getLiveAgentIds().length ?? 0
  if (activePanels > 0 && !opts.force) {
    console.error(`[bridge] update.blocked: ${activePanels} active panel(s) — cannot update without --force`)
    console.error('[bridge]   Use --force to bypass this safety check, or stop panels first.')
    console.error('[bridge]   bridge-agent stop    # stop the daemon')
    process.exit(1)
  }
  if (activePanels > 0 && opts.force) {
    console.log(`[bridge] update.force: ${activePanels} active panel(s) will be terminated during update.`)
  }

  // ── Save channel if requested ────────────────────────────────────────────
  if (opts.saveChannel) {
    mergeSettings({ updateChannel: channel })
    console.log(`[bridge] update.channel.saved: ${channel}`)
  }

  // ── AC5: Global update lock ──────────────────────────────────────────────
  const lock = acquireUpdateLock()
  if (!lock.ok) {
    const err = lock.err!
    if (err.code === 'EEXIST') {
      console.error('[bridge] update.aborted: another update is already in progress (update.lock exists)')
    } else {
      console.error(`[bridge] update.lock.failed: ${err.code} — ${err.message}`)
    }
    process.exit(1)
  }

  // ── AC8: Install new version ─────────────────────────────────────────────
  console.log(`[bridge] update.installing: bridge-agent@${channel}...`)
  let installOk = false
  try {
    execSync(`npm install -g bridge-agent@${channel}`, {
      stdio: 'inherit',
      timeout: 120_000,
    })
    installOk = true
  } catch (err) {
    console.error(`[bridge] update.install.failed: ${String(err)}`)
    installOk = false
  }

  if (!installOk) {
    // AC8: npm install failed — attempt rollback to known-good previous version.
    // Postinstall scripts (e.g. node-pty spawn-helper chmod) may have corrupted
    // the new binary. Restore the previous version so launchd respawn boots a
    // working daemon.
    console.error(`[bridge] update.install.failed: rolling back to bridge-agent@${currentVersion}...`)
    try {
      execSync(`npm install -g bridge-agent@${currentVersion}`, {
        stdio: 'inherit',
        timeout: 120_000,
      })
      console.log('[bridge] update.install.rollback.ok — restored previous version')
    } catch (rollbackErr) {
      releaseUpdateLock()
      console.error(`[bridge] update.install.rollback.FAILED: ${String(rollbackErr)}`)
      console.error('[bridge] ╔══════════════════════════════════════════════════════════════╗')
      console.error('[bridge] ║  CRITICAL: npm install failed AND rollback failed.          ║')
      console.error(`[bridge] ║  Binary may be broken. Manual recovery needed.              ║`)
      console.error(`[bridge] ║  Try: npm install -g bridge-agent@${currentVersion}         ║`)
      console.error(`[bridge] ║  Then: bridge-agent start                                   ║`)
      console.error('[bridge] ╚══════════════════════════════════════════════════════════════╝')
      process.exit(1)
    }
    releaseUpdateLock()
    console.error('[bridge] update.aborted: npm install failed, daemon is on previous version.')
    process.exit(1)
  }

  // ── AC10/AC11: Refresh launchd + kickstart (only if service was already installed) ────
  const plistName = getPlistName()
  const plistLabel = plistName.replace('.plist', '')
  const plistPath = path.join(LAUNCH_AGENTS, plistName)

  const newEntry = getDaemonEntry()
  if (existsSync(plistPath)) {
    if (!setupLaunchd(newEntry)) {
      releaseUpdateLock()
      console.error('[bridge] update.failed: could not write launchd plist')
      console.error('[bridge]   npm install succeeded but launchd setup failed. Run: bridge-agent install-service')
      process.exit(1)
    }
  } else {
    console.log('[bridge] update.launchd.skipped', { reason: 'not_installed' })
  }
  if (existsSync(plistPath)) {
    try {
      execSync(`launchctl kickstart -kp gui/$(id -u)/${plistLabel}`, { stdio: 'pipe' })
      console.log('[bridge] update.kickstart.ok — daemon restarting with new version')
    } catch {
      releaseUpdateLock()
      console.error('[bridge] update.failed: launchctl kickstart failed')
      console.error(`[bridge]   Manual restart: launchctl kickstart -kp gui/$(id -u)/${plistLabel}`)
      process.exit(1)
    }
  } else {
    // run-now mode: binary updated, user must manually restart
    console.log('[bridge] update.complete.no_service — binary updated; restart with: bridge-agent start')
  }

  // ── AC6: Await version-verified health ───────────────────────────────────
  console.log(`[bridge] update.verifying: polling health for version ${latest}...`)
  const healthy = await awaitVersionHealth(latest, 30_000)

  if (healthy) {
    // Success!
    writeUpdateState({
      previousVersion: currentVersion,
      channel,
      installedAt: new Date().toISOString(),
    })
    releaseUpdateLock()
    console.log(`[bridge] update.complete: ${currentVersion} → ${latest}`)
    process.exit(0)
  }

  // ── AC7: Rollback on health failure ──────────────────────────────────────
  console.error(`[bridge] update.health.timeout: daemon did not report version ${latest} within 30s`)
  console.error(`[bridge] update.rolling_back: reinstalling bridge-agent@${currentVersion}...`)

  try {
    execSync(`npm install -g bridge-agent@${currentVersion}`, {
      stdio: 'inherit',
      timeout: 120_000,
    })
    console.log('[bridge] update.rollback.install.ok')
  } catch (rollbackErr) {
    releaseUpdateLock()
    console.error(`[bridge] update.rollback.install.FAILED: ${String(rollbackErr)}`)
    console.error('[bridge] ╔══════════════════════════════════════════════════════════════╗')
    console.error('[bridge] ║  CRITICAL: update failed AND rollback failed.               ║')
    console.error(`[bridge] ║  Daemon may be broken. Manual recovery needed.              ║`)
    console.error(`[bridge] ║  Try: npm install -g bridge-agent@${currentVersion}         ║`)
    console.error(`[bridge] ║  Then: bridge-agent start                                   ║`)
    console.error('[bridge] ╚══════════════════════════════════════════════════════════════╝')
    process.exit(1)
  }

  // Re-kickstart after rollback (only if service was installed before update)
  const rolledBackEntry = getDaemonEntry()
  if (existsSync(plistPath)) {
    try {
      setupLaunchd(rolledBackEntry)
      execSync(`launchctl kickstart -kp gui/$(id -u)/${plistLabel}`, { stdio: 'pipe' })
      console.log('[bridge] update.rollback.kickstart.ok')
    } catch {
      releaseUpdateLock()
      console.error('[bridge] update.rollback.kickstart.failed — daemon may need manual restart')
      console.error(`[bridge]   Run: launchctl kickstart -kp gui/$(id -u)/${plistLabel}`)
      process.exit(1)
    }
  } else {
    console.log('[bridge] update.rollback.complete.no_service — binary restored; restart with: bridge-agent start')
  }

  // Verify rollback health
  console.log(`[bridge] update.rollback.verifying: polling for version ${currentVersion}...`)
  const rollbackHealthy = await awaitVersionHealth(currentVersion, 30_000)

  releaseUpdateLock()

  if (rollbackHealthy) {
    console.log(`[bridge] update.rollback.complete: restored to ${currentVersion}`)
    console.log(`[bridge]   Update to ${latest} failed — daemon is running on previous version.`)
    process.exit(1)
  }

  // AC7: revert failed → leave daemon RUNNING + loud message
  console.error('[bridge] ╔══════════════════════════════════════════════════════════════╗')
  console.error('[bridge] ║  CRITICAL: update failed AND rollback health-check failed.║')
  console.error('[bridge] ║  Daemon may still be running — DO NOT KILL IT.            ║')
  console.error(`[bridge] ║  Manual check: bridge-agent status                          ║`)
  console.error(`[bridge] ║  Check logs: tail -f ~/bridge-daemon.log                    ║`)
  console.error('[bridge] ╚══════════════════════════════════════════════════════════════╝')
  process.exit(1)
}
