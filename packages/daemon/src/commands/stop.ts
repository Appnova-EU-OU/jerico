import { execSync } from 'node:child_process'
import { existsSync, unlinkSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'path'
import { getPlistName, getLockPath, getHealthPort } from '../profile.js'
import { logLifecycle } from '../lifecycle-log.js'

const LAUNCH_AGENTS = path.join(homedir(), 'Library', 'LaunchAgents')

export interface StopOptions {
  unload?: boolean
  purge?: boolean
}

export interface StopResult {
  ok: boolean
  reason: string
}

/**
 * Core stop logic — returns result instead of exiting.
 * Exported for use by the restart command (which chains stop + start).
 *
 * Normal stop (default): 3-phase graceful kill, NEVER bootout.
 *   Phase 1: POST /shutdown RPC — daemon kills agents, exits 0.
 *   Phase 2: process.kill(pid, SIGTERM) — direct signal.
 *   Phase 3: launchctl disable + launchctl kill SIGKILL — last resort.
 *   After stop: service stays LOADED in launchd (SuccessfulExit=false keeps it down).
 *   Next start: enable + kickstart the already-loaded job.
 *
 * --unload: same graceful kill, then launchctl bootout (NO disable).
 *   After stop: job unloaded from launchd — KeepAlive cannot respawn.
 *   Next start: bootstrap + kickstart.
 */
export function stopDaemon(opts?: StopOptions): StopResult {
  const plistName = getPlistName()
  const plistLabel = plistName.replace('.plist', '')
  const uid = userInfo().uid
  const healthPort = getHealthPort()

  logLifecycle('lifecycle.stop.begin', {}, 'cli')

  // ── Discover daemon PID + shutdown token from lock file ──
  let daemonPid: number | null = null
  let shutdownToken: string | null = null
  const lockPath = getLockPath()
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
      daemonPid = lock.pid ?? null
      shutdownToken = lock.shutdownToken ?? null
    } catch { /* lock corrupt — skip */ }
  }

  // Bug5: If lock is missing/corrupt, fall back to launchctl list to find the daemon PID.
  if (!daemonPid) {
    try {
      const listOut = execSync(`launchctl list gui/${uid}/${plistLabel}`, { encoding: 'utf8', stdio: 'pipe' })
      const m = listOut.match(/"PID"\s*=\s*(\d+)/)
      const pidStr = m?.[1]
      if (pidStr) {
        daemonPid = parseInt(pidStr, 10)
        logLifecycle('lifecycle.stop.pid_from_launchctl', { pid: daemonPid }, 'cli')
      }
    } catch { /* launchctl list failed — daemon likely not running */ }
  }

  // Last resort: ask the port. Without a PID every killing phase below is
  // skipped and `--unload` falls through to a bare bootout — which unloads the
  // job but does NOT synchronously kill the process, leaving it reparented to
  // launchd's init, unsupervised, still holding the port. The daemon is the one
  // process that always tells you where it is, because it is listening.
  if (!daemonPid) {
    try {
      const out = execSync(`lsof -ti tcp:${healthPort} -sTCP:LISTEN`, { encoding: 'utf8', stdio: 'pipe' })
      const pid = parseInt(out.trim().split('\n')[0] ?? '', 10)
      if (Number.isFinite(pid)) {
        daemonPid = pid
        logLifecycle('lifecycle.stop.pid_from_port', { pid: daemonPid, port: healthPort }, 'cli')
      }
    } catch { /* nothing listening — daemon really is gone */ }
  }

  // ── Phase 1: POST /shutdown RPC (graceful, with token auth) ──
  let shutdownOk = false
  if (daemonPid && shutdownToken) {
    try {
      const tokenSafe = encodeURIComponent(shutdownToken)
      const purgeFlag = opts?.purge ? '&purge=1' : ''
      execSync(`curl -fsS -X POST -o /dev/null "http://127.0.0.1:${healthPort}/shutdown?token=${tokenSafe}${purgeFlag}"`, {
        stdio: 'pipe', timeout: 5000,
      })
      shutdownOk = true
      logLifecycle('lifecycle.stop.shutdown_rpc_sent', { pid: daemonPid, purge: !!opts?.purge })
    } catch {
      logLifecycle('lifecycle.stop.shutdown_rpc_failed', { pid: daemonPid, purge: !!opts?.purge })
    }
  }

  // Wait for daemon to exit after shutdown RPC (bounded 5s)
  if (shutdownOk && daemonPid) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try { process.kill(daemonPid, 0) } catch { break }
      execSync('sleep 0.2', { stdio: 'ignore' })
    }
  }

  // Check if daemon is still alive
  const isAlive = daemonPid ? (() => { try { process.kill(daemonPid, 0); return true } catch { return false } })() : false

  // ── Phase 2: SIGTERM via process.kill (blind-spot A: not launchctl kill) ──
  if (isAlive && daemonPid) {
    logLifecycle('lifecycle.stop.sigterm_sent', { pid: daemonPid })
    try { process.kill(daemonPid, 'SIGTERM') } catch { /* already gone */ }

    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try { process.kill(daemonPid, 0) } catch { break }
      execSync('sleep 0.2', { stdio: 'ignore' })
    }
  }

  // Check again
  const stillAlive = daemonPid ? (() => { try { process.kill(daemonPid, 0); return true } catch { return false } })() : false

  // ── Phase 3a: SIGKILL (last resort for both paths) ──
  if (stillAlive && daemonPid) {
    logLifecycle('lifecycle.stop.sigkill_escalation', { pid: daemonPid })
    try {
      execSync(`launchctl kill SIGKILL gui/${uid}/${plistLabel}`, { stdio: 'pipe' })
    } catch { /* last resort — may already be dead */ }

    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try { process.kill(daemonPid, 0) } catch { break }
      execSync('sleep 0.2', { stdio: 'ignore' })
    }
  }

  // ── Phase 3b: unload from launchd (--unload only) ──
  const unload = opts?.unload === true
  /** Non-null once we know the job did NOT leave launchd. The old code caught every
   *  bootout exception as "already unloaded = success" and still returned
   *  stopped_unloaded, so `restart`'s #577 remedy — which exists ONLY to replace a
   *  foreign registration, and can only do that if the label really unloads — could
   *  report success without having unloaded anything. Absence has to be observed. */
  let unloadFailure: string | null = null
  if (unload) {
    logLifecycle('lifecycle.stop.bootout', { label: plistLabel })
    try {
      execSync(`launchctl bootout gui/${uid}/${plistLabel}`, { stdio: 'pipe', timeout: 5000 })
      logLifecycle('lifecycle.stop.bootout_ok', { label: plistLabel })
    } catch (err) {
      const detail = describeExecError(err)
      if (/Could not find|No such process|not loaded/i.test(detail)) {
        // Genuinely already unloaded — the only exception that is a success.
        logLifecycle('lifecycle.stop.bootout_already_unloaded', { label: plistLabel, detail })
      } else {
        unloadFailure = detail
        logLifecycle('lifecycle.stop.bootout_failed', { label: plistLabel, detail })
      }
    }

    // bootout unloads the JOB; it does not reliably kill the PROCESS. Verified
    // on macOS: the process survives, reparented to PID 1, still bound to its
    // port. Every phase above exists to have killed it already — but if none of
    // them ran (no PID could be found) this is the only thing that did, so
    // check, and finish the job rather than walk away from an orphan.
    if (daemonPid) {
      const deadline = Date.now() + 3000
      let alive = true
      while (Date.now() < deadline) {
        try { process.kill(daemonPid, 0) } catch { alive = false; break }
        execSync('sleep 0.2', { stdio: 'ignore' })
      }
      if (alive) {
        logLifecycle('lifecycle.stop.orphan_after_bootout', { pid: daemonPid })
        try { process.kill(daemonPid, 'SIGKILL') } catch { /* raced us to it */ }
      }
    }

    // bootout RETURNING is not the job being GONE — launchd tears down
    // asynchronously, and the caller that needs this (restart's #577 remedy) needs
    // the label actually free before it bootstraps our own plist into it.
    if (!unloadFailure) {
      const presence = probeLabelPresence(plistLabel)
      if (presence === 'listed') {
        unloadFailure = 'the label is still loaded in launchd after bootout'
        logLifecycle('lifecycle.stop.bootout_still_loaded', { label: plistLabel })
      } else if (presence === 'unknown') {
        // Not proof either way. bootout itself reported success, so this is logged
        // and not counted as a failure; start's own registration check fails closed
        // if the stale registration is in fact still there.
        logLifecycle('lifecycle.stop.bootout_unverified', { label: plistLabel })
      }
    }

    // Explicitly remove the lock file — the daemon's exit handlers may not have
    // run, leaving it behind.
    if (existsSync(lockPath)) {
      try { unlinkSync(lockPath) } catch {}
    }
  }

  // ── Phase 3c: disable (persistent stop only, not --unload) ──
  if (!unload && stillAlive && daemonPid) {
    try {
      execSync(`launchctl disable gui/${uid}/${plistLabel}`, { stdio: 'pipe' })
    } catch { /* best effort */ }
  }

  // ── Clean lock file (for non-unload path) ──
  if (!unload && existsSync(lockPath)) {
    const confirmedDown = daemonPid ? (() => { try { process.kill(daemonPid, 0); return false } catch { return true } })() : true
    if (confirmedDown) {
      try { unlinkSync(lockPath) } catch {}
      logLifecycle('lifecycle.stop.lock_cleaned')
    }
  }

  // Final status
  const finalAlive = daemonPid ? (() => { try { process.kill(daemonPid, 0); return true } catch { return false } })() : false
  if (finalAlive && !unload) {
    logLifecycle('lifecycle.stop.did_not_exit', { pid: daemonPid })
    return { ok: false, reason: 'daemon did not exit after 3-phase stop' }
  }
  if (unload && unloadFailure) {
    logLifecycle('lifecycle.stop.did_not_unload', { label: plistLabel, detail: unloadFailure })
    return { ok: false, reason: `bootout_failed: ${unloadFailure}` }
  }

  logLifecycle('lifecycle.stop.complete')
  return { ok: true, reason: unload ? 'stopped_unloaded' : 'stopped' }
}

/** launchd's own words for why a command failed, flattened onto one line — the
 *  difference between "already unloaded" and "denied" lives in this string. */
function describeExecError(err: unknown): string {
  let summary = String(err)
  let stderr = ''
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; message?: string }
    if (typeof e.stderr === 'string') stderr = e.stderr.trim()
    if (typeof e.message === 'string') summary = e.message
  }
  return `${summary}${stderr ? ` — ${stderr}` : ''}`.replace(/\s*\n\s*/g, ' / ').trim()
}

/**
 * Is the label still registered with launchd? Three answers, not two.
 *
 * `launchctl list` failing is not proof of absence — it also fails on a timeout or
 * an unreadable domain. Only launchd saying it cannot find the service counts
 * (measured: exit 113, `Could not find service "<label>" in domain for port`).
 * Mirrors the same predicate in start.ts, deliberately duplicated rather than
 * imported: stop.ts must not pull in start.ts's module-level launchd machinery.
 */
function probeLabelPresence(label: string): 'listed' | 'gone' | 'unknown' {
  try {
    execSync(`launchctl list ${label}`, { stdio: 'pipe', timeout: 5000 })
    return 'listed'
  } catch (err) {
    const status = err && typeof err === 'object' && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : Number.NaN
    if (/Could not find|No such process|No such file/i.test(describeExecError(err))) return 'gone'
    if (status === 113) return 'gone'
    return 'unknown'
  }
}

/**
 * CLI handler for `bridge-agent stop` / `bridge-agent stop --unload`.
 * Calls stopDaemon() with options and exits based on result.
 */
export function runStop(opts?: StopOptions): void {
  const result = stopDaemon(opts)
  if (!result.ok) {
    console.error(`[bridge] stop.failed — ${result.reason}`)
    process.exit(1)
  }
  if (opts?.unload) {
    console.log('[bridge] stop.ok — daemon stopped and unloaded from launchd')
  } else {
    console.log('[bridge] stop.ok — daemon stopped, service stays loaded')
  }
  process.exit(0)
}
