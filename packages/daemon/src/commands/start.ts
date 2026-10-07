import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { scheduledDescendantFalsifierPanel, scheduledDescendantHealthEnabled } from '../pty/scheduled-process-groups.js'
import { mkSpawnAttemptId, type AgentId, type WorkspaceId } from '../shared/types.js'
import { waitForReadiness, type ReadinessProbe, type WaitEvent, type WaitForReadinessResult } from './start-wait.js'
import WebSocket from 'ws'
import { execSync, execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync, renameSync, statSync, realpathSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'path'
import { PtyManager } from '../pty/manager.js'
import type { ManifestEntry } from '../pty/manager.js'
import { setupSpawnHelper } from '../pty/spawn-helper-patch.js'
import { startDaemonConnection, isDaemonWsConnected, resetDaemonConnectionState, setPurgeIntent, getReconnectCount, forceReconnect } from '../ws/client.js'
import { startSupervisor, shutdownSupervisor, markShuttingDown, getCodegraphHealth } from '../codegraph/supervisor.js'
import { getRttState } from '../ws/throttle.js'
import { refreshUsageNow, startUsageRefresher, usageForHealth } from '../usage/refresher.js'

function portableSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
import { getLockPath, getPlistName, getLogPaths, getHealthPort, getWrapperPath, getSpawnManifestPath, getAuthFailedFlagPath, getEndpointRejectedFlagPath, getActiveProfile } from '../profile.js'
import { getDaemonEndpointRejection, endpointRepairCommand } from '../config.js'
import type { EndpointRejection } from '@jerico/shared'
import { getToken, hasToken } from '../token-store.js'
import { getDaemonVersion, getDaemonEntry } from '../version.js'
import { logLifecycle } from '../lifecycle-log.js'
import { probeProtectedAccess } from '../probe-protected-access.js'
import { HOOK_EVENT_PATH, handleAgentHookRequest } from '../hooks/receiver.js'
import { lastHookInstallRefusal } from '../hooks/state.js'
import { DESCRIPTOR_FIELD_URL, DESCRIPTOR_FIELD_TOKEN, EVENTS_PROTOCOL_VERSION } from '../hooks/protocol.js'
import {
  HOOK_PROTOCOL,
  generateHookToken,
  removeHookEndpointDescriptorIfOwned,
  writeHookEndpointDescriptor,
} from '../hooks/endpoint.js'
import { dispatchDaemonHttpRequest } from './http-dispatch.js'
import { maintainHookDiagnostics } from '../hooks/diagnostics.js'
import { orchestratorBroker, orchestratorPoller } from '../events/instance.js'
import { createOrchestratorEventsHandler } from '../events/orchestrator-handler.js'
import { subscriberIdFor } from '../events/route.js'

const LAUNCH_AGENTS = path.join(homedir(), 'Library', 'LaunchAgents')
const KICKSTART_TIMEOUT_MS = 15_000
const DEFAULT_SETTLE_BUDGET_MS = 75_000

function settlementBudgetMs(): number {
  const configured = Number(process.env['BRIDGE_DAEMON_SETTLE_BUDGET_MS'])
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_SETTLE_BUDGET_MS
  const effective = Math.max(1_000, Math.min(DEFAULT_SETTLE_BUDGET_MS, configured))
  if (configured !== effective || effective !== DEFAULT_SETTLE_BUDGET_MS) {
    logLifecycle('lifecycle.start.settle_budget_override', { requestedMs: configured, effectiveMs: effective })
  }
  return effective
}

/** Minimum lock age (ms) before orphan reclaim is allowed. Prevents false
 *  reclaim when a PID is recycled to a ppid===1 process — the lock's
 *  startedAt must be older than this threshold to be considered reclaimable. */
const RECLAIM_STALENESS_MS = 5_000

/** Module-level PtyManager reference — set by runDaemonServices, read by health endpoint. */
let currentManager: PtyManager | null = null
/** Module-level shutdown token — generated at daemon start, validated by /shutdown endpoint. */
let currentShutdownToken: string | null = null
let currentDaemonStartedAt: number | null = null
/** Reference to the idle-mode retry timer so stop/restart can clean it up. */
let authFailedRetryTimer: NodeJS.Timeout | null = null

export function getCurrentManager(): PtyManager | null { return currentManager }

/** Generate a random hex token for shutdown authentication (blind-spot B mitigation). */
export function generateShutdownToken(): string {
  return randomBytes(16).toString('hex')
}

/** Read the current shutdown token (used by stop command). */
export function getCurrentShutdownToken(): string | null {
  return currentShutdownToken
}

/** Write (or update) the lock file from the daemon child — records real daemon PID + token. */
export function writeDaemonLock(version: string, binaryPath: string, healthReady = false, healthError?: string): void {
  const lockPath = getLockPath()
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true })
  } catch {
    // Best effort: directory likely exists; writeFileSync will surface real errors.
  }
  const token = currentShutdownToken ?? generateShutdownToken()
  currentShutdownToken = token
  const startedAt = currentDaemonStartedAt ?? Date.now()
  currentDaemonStartedAt = startedAt
  const data = JSON.stringify({
    pid: process.pid,
    startedAt,
    version,
    binaryPath,
    shutdownToken: token,
    healthReady,
    ...(healthReady ? { healthReadyAt: Date.now() } : {}),
    ...(healthError ? { healthError } : {}),
    ...(healthReady || healthError ? { healthObservedAt: Date.now() } : {}),
  })
  // Bug6: write lock 0600 — shutdown token must not be world-readable
  writeFileSync(lockPath, data, { encoding: 'utf-8', mode: 0o600 })
}

interface InitialLockProbe {
  pid: number | null
  readFailed: boolean
}

function daemonLockPid(): InitialLockProbe {
  try {
    const raw = JSON.parse(readFileSync(getLockPath(), 'utf8')) as Record<string, unknown>
    const pid = raw['pid']
    return { pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null, readFailed: false }
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    if (code !== 'ENOENT') {
      logLifecycle('lifecycle.start.initial_lock_probe_failed', {
        path: getLockPath(),
        error: String(err),
      })
    }
    return { pid: null, readFailed: code !== 'ENOENT' }
  }
}

export interface DaemonReadiness {
  pid: number
  healthError?: string
  /** A live daemon from before healthReady was added. This is deliberately
   * distinct from a new daemon that has written healthReady:false: callers may
   * use the legacy result to perform version-skew recovery, while the new
   * daemon must still prove that its listener is accepting connections. */
  predatesReadinessSignal?: true
}

export interface DaemonReadinessWaitDependencies {
  probe?: () => ReadinessProbe<DaemonReadiness>
  emit?: (event: string, payload: Record<string, unknown>) => void
  tickMs?: number
  now?: () => number
  sleep?: (ms: number) => void
}

export function probeReadyDaemonLock(
  excludedPid: number | null = null,
  minimumObservedAt = 0,
): ReadinessProbe<DaemonReadiness> {
  try {
    const raw = JSON.parse(readFileSync(getLockPath(), 'utf8')) as Record<string, unknown>
    const pid = raw['pid']
    if (typeof raw['shutdownToken'] !== 'string') return { state: 'waiting' }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === excludedPid) {
      return { state: 'waiting' }
    }
    if (minimumObservedAt > 0) {
      const observedAt = raw['healthObservedAt']
      if (typeof observedAt !== 'number' || observedAt < minimumObservedAt) return { state: 'waiting' }
    }
    try {
      process.kill(pid, 0)
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
      if (code === 'ESRCH') return { state: 'waiting' }
      return { state: 'probe_failed', error: `could not verify ready daemon PID ${pid}: ${String(err)}` }
    }
    if (raw['healthError'] === 'EADDRINUSE') return { state: 'ready', value: { pid, healthError: 'EADDRINUSE' } }
    if (!Object.prototype.hasOwnProperty.call(raw, 'healthReady')) {
      return { state: 'ready', value: { pid, predatesReadinessSignal: true } }
    }
    if (raw['healthReady'] !== true) return { state: 'waiting' }
    return { state: 'ready', value: { pid } }
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    if (code === 'ENOENT') return { state: 'waiting' }
    return { state: 'probe_failed', error: `could not read daemon readiness lock: ${String(err)}` }
  }
}

export function waitForDaemonReadiness(
  label: string,
  eventPrefix: 'settle' | 'concurrent' | 'already_running',
  excludedPid: number | null,
  budgetMs = settlementBudgetMs(),
  minimumObservedAt = 0,
  dependencies: DaemonReadinessWaitDependencies = {},
): WaitForReadinessResult<DaemonReadiness> {
  const emit = dependencies.emit ?? logLifecycle
  return waitForReadiness({
    budgetMs,
    probe: dependencies.probe ?? (() => probeReadyDaemonLock(excludedPid, minimumObservedAt)),
    ...(dependencies.tickMs === undefined ? {} : { tickMs: dependencies.tickMs }),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
    onEvent: (event: WaitEvent) => {
      if (event.event === 'probe_failed') {
        emit(`lifecycle.start.${eventPrefix}_probe_failed`, {
          label,
          elapsedMs: event.elapsedMs,
          error: event.error,
        })
      } else if (event.event === 'ready') {
        emit(`lifecycle.start.${eventPrefix === 'settle' ? 'settled' : `${eventPrefix}_settled`}`, {
          label,
          afterSeconds: event.afterSeconds,
          elapsedMs: event.elapsedMs,
        })
      } else {
        emit(`lifecycle.start.${eventPrefix}_exhausted`, {
          label,
          afterSeconds: event.afterSeconds,
          elapsedMs: event.elapsedMs,
          probeAttempts: event.probeAttempts,
          probeFailures: event.probeFailures,
          lastProbeError: event.lastProbeError,
        })
      }
    },
  })
}

export function readinessFailureReason(
  result: WaitForReadinessResult<DaemonReadiness>,
  absentReason: string,
): string | null {
  if (result.ready && result.value?.healthError === 'EADDRINUSE') return 'health_port_in_use'
  if (result.ready) return null
  if (result.probeAttempts > 0 && result.probeFailures === result.probeAttempts) {
    return `daemon_readiness_unobservable: ${result.probeFailures} probe failures${result.lastProbeError ? ` — ${result.lastProbeError}` : ''}`
  }
  return absentReason
}

/**
 * Get the parent PID of a process via `ps`. Returns null on failure.
 * Used to detect orphaned processes (parent dead → reparented to PID 1).
 * Uses execFileSync (no shell) and validates pid is an integer.
 */
function getParentPid(pid: number): number | null {
  if (!Number.isInteger(pid)) return null
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { stdio: 'pipe', encoding: 'utf8' }).trim()
    const ppid = parseInt(out, 10)
    return Number.isFinite(ppid) ? ppid : null
  } catch {
    return null
  }
}

/**
 * Acquire a lock to prevent multiple daemon instances.
 * Uses atomic exclusive create (O_CREAT | O_EXCL) — kernel-level race protection.
 * Returns true if lock acquired, false if another instance is already running.
 */
function cleanupStaleLock(): void {
  const lockPath = getLockPath()
  if (!existsSync(lockPath)) return
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch (err) {
    // A read error is not evidence of corruption. In particular, EMFILE and
    // EACCES can be transient and this may be a live daemon lock carrying the
    // shutdown token. Preserve it so the later observable-lock guard remains
    // reachable instead of destroying the daemon's control credential.
    logLifecycle('lifecycle.start.stale_lock_read_failed', {
      path: lockPath,
      error: String(err),
    })
    return
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    try { unlinkSync(lockPath) } catch {}      // corrupt -> remove
    return
  }

  try {
    const pid = data['pid']
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      unlinkSync(lockPath)
      return
    }

    // F30-B3: identity-aware reclaim — a lock from a different binary or
    // version belongs to a previous installation/upgrade and is stale.
    // ONLY reclaim CLI locks (no shutdownToken); daemon locks are NEVER reclaimed.
    if (!data['shutdownToken']) {
      const currentVersion = getDaemonVersion()
      const currentBinaryPath = getDaemonEntry()
      if (data['version'] !== currentVersion || data['binaryPath'] !== currentBinaryPath) {
        console.log(`[bridge] cleanupStaleLock — reclaiming stale CLI lock (identity changed: version=${String(data['version'])}→${currentVersion}, binaryPath=${String(data['binaryPath'])}→${currentBinaryPath})`)
        try { unlinkSync(lockPath) } catch {}
        return
      }
    }

    // Distinguish EPERM (process exists but inaccessible) from ESRCH (dead)
    try { process.kill(pid, 0) } catch (e: any) {
      if (e.code === 'EPERM') return           // alive but no permission -> keep
      // ESRCH or other -> stale, remove lock
      try { unlinkSync(lockPath) } catch {}
      return
    }
    // kill(pid,0) didn't throw -> process alive.
    // If the lock has no shutdownToken (CLI lock, not daemon lock) and the
    // holder is orphaned (parent is PID 1 / launchd), reclaim the lock.
    // This fixes the orphaned-desktop-child case: Cmd+Q kills the parent app,
    // bridge-agent is reparented to init, relaunch finds stale CLI lock.
    // Daemon locks (with shutdownToken) are NEVER reclaimed — they represent
    // a real running daemon that must be stopped explicitly.
    // Reclaim only if lock is older than RECLAIM_STALENESS_MS to prevent
    // false reclaim from PID recycling (a recycled ppid===1 PID would have
    // a very recent startedAt if it were a new process, but the lock's
    // startedAt is from the original holder and should be old).
    if (!data['shutdownToken']) {
      const startedAt = typeof data['startedAt'] === 'number' ? data['startedAt'] : 0
      if (Date.now() - startedAt >= RECLAIM_STALENESS_MS) {
        const ppid = getParentPid(pid)
        if (ppid === 1) {
          console.log(`[bridge] cleanupStaleLock — reclaiming orphaned CLI lock (pid=${pid}, ppid=1, age=${Date.now() - startedAt}ms)`)
          try { unlinkSync(lockPath) } catch {}
          return
        }
      }
    }
    // Legitimate live holder — keep lock
    return
  } catch {
    // Preserve the pre-existing fallback for unexpected decision errors. The
    // narrow safety change above is that a read failure never reaches here.
    try { unlinkSync(lockPath) } catch {}
  }
}

export function acquireDaemonLock(): { ok: boolean; err?: NodeJS.ErrnoException } {
  const lockPath = getLockPath()
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true })
  } catch (err: any) {
    if (err.code !== 'EEXIST' && err.code !== 'EISDIR') {
      console.warn(`[bridge] warning: mkdirSync failed for ${path.dirname(lockPath)} (${err.code})`)
    }
  }

  cleanupStaleLock()

  const binaryPath = getDaemonEntry()
  // Atomic exclusive create: wx = write-exclusive, fails with EEXIST if file exists
  try {
    const fd = openSync(lockPath, 'wx')
    writeSync(fd, JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      version: getDaemonVersion(),
      binaryPath,
    }))
    closeSync(fd)
    return { ok: true }
  } catch (err) {
    return { ok: false, err: err as NodeJS.ErrnoException }
  }
}

let idleSigtermHandler: (() => void) | null = null
let idleSigintHandler: (() => void) | null = null
let idleSighupHandler: (() => void) | null = null

function registerIdleSignalHandler(): void {
  if (idleSigtermHandler) return
  let handled = false
  const handler = (sig: string): void => {
    if (handled) return
    handled = true
    logLifecycle('lifecycle.idle.signal', { signal: sig })
    try {
      const lockPath = getLockPath()
      const data = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (data.pid === process.pid) unlinkSync(lockPath)
    } catch {}
    try {
      markShuttingDown()
    } catch {}
    // Graceful shutdown (SIGTERM → 5s grace → SIGKILL) of the CURRENT codegraph
    // child. The supervisor tracks the live pid (updated on every respawn), so a
    // prior crash-restart that changed the pid can never leave an orphan.
    void shutdownSupervisor()
      .catch(() => {})
      .then(() => process.exit(0))
    // Hard ceiling: never hang the daemon's own shutdown.
    setTimeout(() => process.exit(0), 7000)
  }
  idleSigtermHandler = () => handler('SIGTERM')
  idleSigintHandler = () => handler('SIGINT')
  idleSighupHandler = () => handler('SIGHUP')
  process.on('SIGTERM', idleSigtermHandler)
  process.on('SIGINT', idleSigintHandler)
  process.on('SIGHUP', idleSighupHandler)
}

export function unregisterIdleSignalHandler(): void {
  if (idleSigtermHandler) {
    process.off('SIGTERM', idleSigtermHandler)
    idleSigtermHandler = null
  }
  if (idleSigintHandler) {
    process.off('SIGINT', idleSigintHandler)
    idleSigintHandler = null
  }
  if (idleSighupHandler) {
    process.off('SIGHUP', idleSighupHandler)
    idleSighupHandler = null
  }
}

function getShellPath(): string {
  // Get the user's full PATH by running 'which' for known binaries.
  // This tells us where each binary lives, and we collect all those dirs.
  // Works on any machine — we discover what's available rather than hardcoding.
  const knownBinaries = ['claude', 'codex', 'qwen', 'ollama', 'aider', 'copilot', 'opencode', 'python3', 'node', 'bun', 'sh']
  const dirs = new Set<string>()
  dirs.add(path.join(homedir(), '.nvm', 'versions', 'node', `v${process.versions.node}`, 'bin'))
  dirs.add(path.join(homedir(), '.local', 'bin'))
  // opencode installer default — added to user's shell rc, which launchd does not source
  dirs.add(path.join(homedir(), '.opencode', 'bin'))
  dirs.add('/opt/homebrew/bin')
  dirs.add('/usr/local/bin')
  dirs.add('/usr/bin')
  dirs.add('/bin')
  // Also add directories that appear in PATH at startup
  const currentPath = process.env.PATH ?? ''
  for (const d of currentPath.split(':')) {
    if (d && !d.startsWith('/dev') && !d.startsWith('/tmp')) {
      dirs.add(d)
    }
  }
  // Discover dirs by locating each known binary
  for (const bin of knownBinaries) {
    try {
      const resolved = execSync(`which ${bin} 2>/dev/null`, { stdio: 'pipe' }).toString().trim()
      if (resolved && resolved.startsWith('/')) {
        dirs.add(path.dirname(resolved))
      }
    } catch { /* binary not found — skip */ }
  }

  // Claude Code often installed as VS Code extension — discover it
  const vscodeExtensions = path.join(homedir(), '.vscode', 'extensions')
  try {
    const entries = execSync(`ls "${vscodeExtensions}" 2>/dev/null`, { stdio: 'pipe' }).toString().split('\n')
    for (const entry of entries) {
      if (entry.startsWith('anthropic.claude-code-')) {
        const binDir = path.join(vscodeExtensions, entry, 'resources', 'native-binary')
        if (existsSync(binDir)) dirs.add(binDir)
      }
    }
  } catch { /* vscode extensions not found — skip */ }

  return [...dirs].join(':')
}

/**
 * Issue #12: the app-bundled binary and a standalone `npm install -g
 * bridge-agent` install both register under the identical launchd label
 * (com.jerico.bridge-agent, no --profile) because getPlistName() only
 * differentiates on --profile, not on distribution. setupLaunchd used to
 * overwrite an existing plist unconditionally — whichever distribution ran
 * `bridge-agent start` last silently won, downgrading the app's daemon to
 * whatever the npm package happened to be, with zero log signal anywhere.
 * This reads the plist BEFORE overwriting it and, if the ProgramArguments
 * target is changing to a DIFFERENT binary/wrapper path, logs loudly —
 * distinguishing an ordinary same-install version bump (self-update,
 * app-bundle relocation after being moved to /Applications) from a genuine
 * cross-distribution takeover.
 */
export function warnIfReplacingDifferentDaemonTarget(wrapperPath: string, newWrapperScript: string): void {
  try {
    if (!existsSync(wrapperPath)) return
    const existing = readFileSync(wrapperPath, 'utf-8')
    if (existing.trim() === newWrapperScript.trim()) return // identical — same binary, nothing to warn about
    // The wrapper script's `exec "<entry>" start` line is the actual
    // differentiator (its own path never changes — it's a fixed location
    // under ~/.bridge/ that BOTH distributions write into, which is why
    // comparing the plist's ProgramArguments alone can't detect a takeover).
    // The pkg-mode script has one quoted arg (`exec "<entry>" start`); the
    // npm-mode script has two (`exec "$(command -v node)" "<entry>" start`)
    // — always take the LAST quoted segment before `start`, never the first.
    const extractEntry = (s: string) => {
      const execLine = s.match(/exec\s+(.*?)\s+start\s*$/m)?.[1]
      const quoted = execLine?.match(/"([^"]*)"/g)
      return quoted?.[quoted.length - 1]?.slice(1, -1)
    }
    const previousEntry = extractEntry(existing)
    const nextEntry = extractEntry(newWrapperScript)
    console.warn(`[bridge] launchd.wrapper.replacing_different_target — a different daemon installation previously owned this LaunchAgent's wrapper script. previous="${previousEntry ?? '(unparsed)'}" next="${nextEntry ?? '(unparsed)'}". If this is unexpected, another bridge-agent distribution (app-bundled vs npm-installed) may have just taken over this daemon's launchd registration — see issue #12.`)
    logLifecycle('lifecycle.launchd.replacing_different_target', { previousEntry: previousEntry ?? null, nextEntry: nextEntry ?? null })
  } catch (err) {
    // Best-effort diagnostic only — never block the actual setup over a read/parse failure.
    console.warn('[bridge] launchd.wrapper.pre_check.failed', { error: String(err) })
  }
}

export function setupLaunchd(daemonEntry: string): boolean {
  try {
    execSync(`mkdir -p "${LAUNCH_AGENTS}"`, { stdio: 'pipe' })
  } catch { /* exists */ }

  const plistName = getPlistName()
  const plistPath = path.join(LAUNCH_AGENTS, plistName)
  const { out: logOut, err: logErr } = getLogPaths()
  const shellPath = getShellPath()
  const profileName = process.env['BRIDGE_PROFILE'] || ''
  const plistLabel = plistName.replace('.plist', '')

  const profileEnvEntry = profileName
    ? `    <key>BRIDGE_PROFILE</key>\n    <string>${profileName}</string>\n`
    : ''

  // --health-port (or an explicit HEALTH_PORT env at setup time) only sets
  // process.env in THIS CLI invocation — launchd spawns the actual daemon as
  // a separate process and only forwards env vars listed in the plist below.
  // Without this entry, an explicit --health-port silently had no effect on
  // the running daemon, which fell back to getHealthPort()'s profile default
  // and could collide with another named profile's daemon on the same port.
  const explicitHealthPort = process.env['HEALTH_PORT']
  const healthPortEnvEntry = explicitHealthPort
    ? `    <key>HEALTH_PORT</key>\n    <string>${explicitHealthPort}</string>\n`
    : ''

  const bridgeDir = path.join(homedir(), '.bridge')
  const wrapperPath = getWrapperPath()
  // pkg binaries are self-contained executables — running them via `node` fails.
  // For pkg, invoke the binary directly; for npm installs, use node to run the JS entry.
  const isPkg = (process as any).pkg !== undefined
  const wrapperScript = isPkg
    ? `#!/bin/bash --norc\nexec "${daemonEntry}" start\n`
    : `#!/bin/bash --norc\nexec "$(command -v node)" "${daemonEntry}" start\n`
  warnIfReplacingDifferentDaemonTarget(wrapperPath, wrapperScript)

  try {
    mkdirSync(bridgeDir, { recursive: true })
    writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 })
    console.log('[bridge] wrapper.refreshed', { path: wrapperPath, entry: daemonEntry })
  } catch (err) {
    console.warn('[bridge] wrapper.write.failed', { error: String(err) })
    return false
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${wrapperPath}</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${logOut}</string>
  <key>StandardErrorPath</key>
  <string>${logErr}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${shellPath}</string>
    <key>BRIDGE_DAEMON</key>
    <string>1</string>
    <key>BRIDGE_SUPERVISED</key>
    <string>1</string>
${profileEnvEntry}${healthPortEnvEntry}  </dict>
</dict>
</plist>
`

  try {
    writeFileSync(plistPath, plist, 'utf-8')
    return true
  } catch (err) {
    console.warn('[bridge] launchd.plist.write.failed', { error: String(err) })
    return false
  }
}

/**
 * What launchd actually holds for a label, as opposed to what our plist file says.
 *
 * launchd does not re-read the plist file of an already-bootstrapped label, so
 * rewriting the file repairs nothing for a stale registration (issue #577). The
 * loaded registration's own `Program` / `ProgramArguments` — and its
 * `LastExitStatus` — are already in the `launchctl list <label>` output this
 * function's caller has always fetched; the blindness was ours, not launchctl's:
 * everything except the `PID` match was discarded.
 */
export interface LaunchdRegistration {
  /** `"Program"`, or argv[0] of `"ProgramArguments"` — the executable launchd holds. */
  program: string | null
  /** `"LastExitStatus"` — the raw wait status of the previous run, 0 when clean. */
  lastExitStatus: number | null
  /**
   * A Program value was present but carried an escape this parser cannot decode,
   * so `program` is NOT the registered path and must never be compared with one.
   * Separate from `program: null` on purpose: absent is "nothing to say",
   * undecodable is "we read something and refuse to trust it".
   */
  programUndecodable: boolean
}

export type LaunchdRegistrationProbe =
  | { state: 'listed'; registration: LaunchdRegistration }
  | { state: 'unavailable'; error: string }

export type RegistrationVerdictReason =
  /** Provable mismatch: launchd holds an executable we do not manage. */
  | 'foreign_program'
  /** Provable mismatch: the registered executable does not exist on disk. */
  | 'program_missing'
  /** Registration agrees with what we manage. */
  | 'matches'
  /** `launchctl list` failed (or timed out) — nothing proven. */
  | 'probe_unavailable'
  /** Output carried no `Program` / `ProgramArguments` — nothing proven. */
  | 'unparseable'
  /** A path could not be canonicalised (EACCES, ELOOP, …) — nothing proven. */
  | 'unresolvable_path'

export interface RegistrationVerdict {
  /** True ONLY when the mismatch is provable. Guessing here boots out a healthy daemon. */
  mismatch: boolean
  reason: RegistrationVerdictReason
  detail: string
}

export interface RegistrationCheckDependencies {
  exists?: (candidate: string) => boolean
  canonicalize?: (candidate: string) => string
}

/**
 * Resolve a path to its canonical spelling even when it does not exist.
 *
 * On macOS `/tmp` is a symlink to `/private/tmp`, and the real #577 report showed
 * BOTH spellings for the same file in a single launchctl output — so a
 * string compare of the raw values reports a mismatch for identical files. Neither
 * side is guaranteed to exist (in the reported case neither did), so realpath the
 * longest existing ancestor and re-attach the remainder.
 *
 * Throws for anything other than a missing component; the caller treats a throw as
 * "not proven" and keeps the pre-#577 behaviour.
 */
export function canonicalizeLaunchdPath(candidate: string): string {
  const absolute = path.resolve(candidate)
  const tail: string[] = []
  let head = absolute
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(head) : path.join(realpathSync(head), ...tail)
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      const parent = path.dirname(head)
      if (parent === head) return absolute // reached the root without resolving anything
      tail.unshift(path.basename(head))
      head = parent
    }
  }
}

/** Escapes launchd's OpenStep-ish serialiser can emit, other than octal / \\U. */
const QUOTED_ESCAPES: Record<string, string> = {
  '"': '"', '\\': '\\', '/': '/',
  n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v',
}

/**
 * Read one quoted value, starting at its opening quote, decoding escapes.
 *
 * The first version captured with `([^"]*)`, which stops at the first ESCAPED
 * quote — a home directory containing a literal `"` therefore parsed as a
 * truncated fragment, compared unequal to the real wrapper, and classified as a
 * PROVABLE foreign registration, which on a stopped job is the branch that boots
 * a healthy daemon out (reproduced by a reviewer at the parser/classifier
 * boundary, #577 round 2). Every escape this decoder does not understand — and
 * any unterminated string — returns `ok: false`, and the caller turns that into
 * `unparseable`: the destructive branch may only run on a value decoded in full.
 */
export function readQuotedValue(text: string, openQuoteIndex: number): { value: string; ok: boolean } {
  let value = ''
  for (let i = openQuoteIndex + 1; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (ch === '"') return { value, ok: true }
    if (ch === '\n') return { value, ok: false } // a value never spans a line here
    if (ch !== '\\') { value += ch; continue }
    const next = text[i + 1]
    if (next === undefined) return { value, ok: false }
    const simple = QUOTED_ESCAPES[next]
    if (simple !== undefined) { value += simple; i += 1; continue }
    if (next >= '0' && next <= '7') {
      let digits = ''
      let j = i + 1
      while (j < text.length && digits.length < 3) {
        const d = text[j] ?? ''
        if (d < '0' || d > '7') break
        digits += d
        j += 1
      }
      value += String.fromCharCode(Number.parseInt(digits, 8))
      i = j - 1
      continue
    }
    if (next === 'U' || next === 'u') {
      const hex = text.slice(i + 2, i + 6)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, 16))
        i += 5
        continue
      }
      return { value, ok: false }
    }
    return { value, ok: false } // an escape we do not understand is not decoded
  }
  return { value, ok: false } // ran off the end without a closing quote
}

/** Find `pattern` (which must end at an opening quote) and decode its value.
 *  `{ value: null, ok: true }` means the key is simply absent. */
function readKeyedQuotedValue(out: string, pattern: RegExp): { value: string | null; ok: boolean } {
  const match = pattern.exec(out)
  if (!match) return { value: null, ok: true }
  const read = readQuotedValue(out, match.index + match[0].length - 1)
  return { value: read.value.trim(), ok: read.ok }
}

/**
 * Extract the registration facts from `launchctl list <label>` output.
 *
 * The output is plist-ish, not JSON:
 *   "Program" = "/Users/me/.bridge/bridge-agent-wrapper.sh";
 *   "ProgramArguments" = (
 *       "/Users/me/.bridge/bridge-agent-wrapper.sh";
 *   );
 *   "LastExitStatus" = 0;
 */
export function parseLaunchctlList(out: string): LaunchdRegistration {
  let program: string | null = null
  let programUndecodable = false

  const fromProgram = readKeyedQuotedValue(out, /"Program"\s*=\s*"/)
  if (!fromProgram.ok) programUndecodable = true
  else if (fromProgram.value) program = fromProgram.value

  if (!programUndecodable && !program) {
    // A plist with ProgramArguments and no Program key lists only the array;
    // argv[0] is the executable either way.
    const fromArgv = readKeyedQuotedValue(out, /"ProgramArguments"\s*=\s*\(\s*"/)
    if (!fromArgv.ok) programUndecodable = true
    else if (fromArgv.value) program = fromArgv.value
  }

  const rawExit = out.match(/"LastExitStatus"\s*=\s*(-?\d+)/)?.[1]
  const parsedExit = rawExit === undefined ? Number.NaN : Number.parseInt(rawExit, 10)
  return {
    program: programUndecodable ? null : program,
    lastExitStatus: Number.isInteger(parsedExit) ? parsedExit : null,
    programUndecodable,
  }
}

/**
 * Turn a raw `LastExitStatus` into something worth putting in front of a person.
 *
 * launchd reports the raw `waitpid(2)` status: a label pointed at a nonexistent
 * binary lists `"LastExitStatus" = 19968` — that is 78<<8, EX_CONFIG (measured on a
 * throwaway label). Plain N is decoded too, since one shift convention across all
 * macOS builds is not something this code should bet on. Both spellings are decoded;
 * the raw number is always kept, because it is the fact and the decoding is the
 * inference. Returns null for a clean (or absent) status — there is nothing to say.
 *
 * The decode follows the `<sys/wait.h>` LAYOUT, not a set of numeric ranges. "Signal
 * or exit code" was the previous model and it is not what the value holds: a
 * `< 32` split gets SIGTERM right and still misreads 139 (SIGSEGV *with core dumped*,
 * `11 | 0x80`) as "exit code 139", and says nothing at all about the stopped /
 * continued sentinels, which are not exits in the first place. The mistake matters
 * because it is a fabricated diagnosis, not a vague one: 15 decoded as an exit code
 * matched humanStartFailure's `exit code (\d+)` branch and told users whose daemon had
 * just been stopped normally that their service was "registered against a path that no
 * longer exists" (reviewer-reproduced with `kill -TERM` on a throwaway label). And
 * normal is what it is: stop.ts SIGTERMs and escalates to `launchctl kill SIGKILL`, so
 * with KeepAlive{SuccessfulExit:false} every stopped daemon on every machine sits at 15
 * or 9. A value the layout cannot explain keeps the compatibility reading as a plain
 * unshifted exit code — 78 (EX_CONFIG) was measured in that spelling on this host.
 *
 * WORDING IS LOAD-BEARING: `LastExitStatus` describes the run that ENDED, and it can
 * be non-zero while a current PID is alive and healthy — the reproducer measured
 * `LastExitStatus = 15` alongside a live PID 15743. So this string must never read as
 * a statement about the running process, and every caller inherits that constraint.
 * Say "previous run", always.
 */
const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT',
  7: 'SIGEMT', 8: 'SIGFPE', 9: 'SIGKILL', 10: 'SIGBUS', 11: 'SIGSEGV', 12: 'SIGSYS',
  13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM', 16: 'SIGURG', 17: 'SIGSTOP',
  18: 'SIGTSTP', 19: 'SIGCONT', 20: 'SIGCHLD', 21: 'SIGTTIN', 22: 'SIGTTOU',
  23: 'SIGIO', 24: 'SIGXCPU', 25: 'SIGXFSZ', 26: 'SIGVTALRM', 27: 'SIGPROF',
  28: 'SIGWINCH', 29: 'SIGINFO', 30: 'SIGUSR1', 31: 'SIGUSR2',
}

/**
 * The `<sys/wait.h>` layout, as this host's own macros compute it. Verified by
 * compiling the platform header against the exact values below (`cc` + WIF*):
 *
 *   139   → WIFSIGNALED, WTERMSIG 11 (SIGSEGV), WCOREFLAG set
 *   4479  → WIFSTOPPED,  WSTOPSIG 17 (SIGSTOP)      — 0x117F
 *   4991  → WIFCONTINUED, WSTOPSIG 19               — 0x137F, NOT stopped on Darwin
 *   19968 → WIFEXITED,   WEXITSTATUS 78 (EX_CONFIG)
 *
 * 4991 deserves a note: Darwin spells `WIFSTOPPED` as
 * `_WSTATUS(x) == _WSTOPPED && WSTOPSIG(x) != 0x13` and reserves `0x13` for
 * `WIFCONTINUED`, so 0x137F is the CONTINUED sentinel here and the SIGSTOP-stopped
 * sentinel is 0x117F. Decoding 4991 as "stopped by SIGSTOP" would be the same class
 * of error as calling 139 "exit code 139": a plausible reading of the number instead
 * of the platform's own.
 */
const WSTATUS_MASK = 0x7f
const WSTOPPED_SENTINEL = 0x7f
const WCONTINUED_STOPSIG = 0x13
const WCOREFLAG = 0x80
const MAX_SIGNAL = 31

export function describeLastExitStatus(status: number | null): string | null {
  if (status === null || status === 0) return null
  const prefix = 'previous launchd run'
  if (status < 0) return `${prefix} exited with status ${status}`

  const wstatus = status & WSTATUS_MASK
  const highByte = (status >> 8) & 0xff
  const named = (signal: number): string => {
    const name = SIGNAL_NAMES[signal]
    return `signal ${signal}${name ? ` (${name})` : ''}`
  }

  if (wstatus === 0) {
    return `${prefix} exited with status ${status} (exit code ${highByte})`
  }
  if (wstatus === WSTOPPED_SENTINEL) {
    // Not an exit at all: the job is suspended (or was just resumed), so nothing
    // here is a diagnosis about why anything failed.
    return highByte === WCONTINUED_STOPSIG
      ? `${prefix} was continued after a stop (status ${status}) and did not report an exit`
      : `${prefix} was stopped by ${named(highByte)} (status ${status}) and did not report an exit`
  }
  if (wstatus <= MAX_SIGNAL) {
    const core = (status & WCOREFLAG) !== 0 ? ' and dumped core' : ''
    return `${prefix} was killed by ${named(wstatus)}${core}`
  }
  // Compatibility fallback: not a wait status this host's macros can decode — a
  // plain, unshifted exit code, which is the spelling measured on this machine
  // (`"LastExitStatus" = 78`, EX_CONFIG, alongside 19968 = 78<<8 for the same fault).
  // One shift convention across every macOS build is not something to bet on.
  if (status < 256) {
    return `${prefix} exited with status ${status} (exit code ${status})`
  }
  return `${prefix} exited with status ${status}`
}

/**
 * Decide whether the loaded registration provably belongs to someone else.
 *
 * Deliberately NOT treated as a mismatch (each would mean booting out a possibly
 * healthy daemon on a guess, which is strictly worse than issue #577):
 *  - `launchctl list` failing, timing out, or carrying no Program/ProgramArguments
 *  - a path that cannot be canonicalised
 *  - a job registered from the program we manage that keeps exiting non-zero. That
 *    is a real environment/config failure, not a stale registration; it gets a
 *    truthful error (see describeLastExitStatus) and no bootout.
 */
export function classifyLaunchdRegistration(
  probe: LaunchdRegistrationProbe,
  expectedProgram: string,
  dependencies: RegistrationCheckDependencies = {},
): RegistrationVerdict {
  if (probe.state === 'unavailable') {
    return { mismatch: false, reason: 'probe_unavailable', detail: `launchctl list unavailable: ${probe.error}` }
  }
  const exists = dependencies.exists ?? existsSync
  const canonicalize = dependencies.canonicalize ?? canonicalizeLaunchdPath
  const { program } = probe.registration
  if (probe.registration.programUndecodable) {
    // A value we could not decode in full is not a path, so it cannot disagree
    // with one. Comparing the fragment is what manufactured a "provable"
    // mismatch out of a healthy registration (#577 round 2).
    return {
      mismatch: false,
      reason: 'unparseable',
      detail: 'launchctl list reported a Program this parser cannot decode (unsupported escape or unterminated string)',
    }
  }
  if (!program) {
    return { mismatch: false, reason: 'unparseable', detail: 'launchctl list reported no Program for this label' }
  }

  let registeredCanonical: string
  let expectedCanonical: string
  try {
    registeredCanonical = canonicalize(program)
    expectedCanonical = canonicalize(expectedProgram)
  } catch (err) {
    return {
      mismatch: false,
      reason: 'unresolvable_path',
      detail: `could not canonicalise "${program}" / "${expectedProgram}": ${String(err)}`,
    }
  }

  if (registeredCanonical !== expectedCanonical) {
    return {
      mismatch: true,
      reason: 'foreign_program',
      detail: `launchd holds this label against "${registeredCanonical}", not the program we manage ("${expectedCanonical}")`,
    }
  }
  if (!exists(registeredCanonical)) {
    return {
      mismatch: true,
      reason: 'program_missing',
      detail: `registered program "${registeredCanonical}" does not exist on disk`,
    }
  }
  return { mismatch: false, reason: 'matches', detail: `registration matches "${expectedCanonical}"` }
}

export interface ForeignRegistrationCheck {
  foreign: boolean
  reason: RegistrationVerdictReason
  detail: string
}

/**
 * Is this label loaded against a program we do not manage?
 *
 * Standalone so `restart` can ask BEFORE it stops the daemon: a plain stop leaves
 * the job loaded, and a foreign registration must be unloaded instead (issue #577,
 * see runRestart). Same probe and same predicate as startOrKickstartDaemon —
 * `launchctl list` only, no state changed.
 */
export function detectForeignRegistration(): ForeignRegistrationCheck {
  const plistLabel = getPlistName().replace('.plist', '')
  let probe: LaunchdRegistrationProbe
  try {
    const out = execSync(`launchctl list ${plistLabel}`, { stdio: 'pipe', encoding: 'utf8', timeout: 8000 })
    probe = { state: 'listed', registration: parseLaunchctlList(out.toString()) }
  } catch (err) {
    const details = extractExecSyncError(err)
    probe = { state: 'unavailable', error: `${details.summary}${details.stderr ? ' — ' + details.stderr : ''}` }
  }
  const verdict = classifyLaunchdRegistration(probe, getWrapperPath())
  return { foreign: verdict.mismatch, reason: verdict.reason, detail: verdict.detail }
}

/**
 * Is the label still registered with launchd?
 *
 * Three answers, not two. `launchctl list` failing is not proof of absence: it also
 * fails on a timeout, an unreadable domain, or any error we have not seen — and
 * treating those as "gone" is how a bootout that did nothing gets reported as one
 * that worked. Only launchd actually saying it cannot find the service counts
 * (measured: exit 113, stderr `Could not find service "<label>" in domain for port`).
 */
function probeLabelPresence(label: string): 'listed' | 'gone' | 'unknown' {
  try {
    execSync(`launchctl list ${label}`, { stdio: 'pipe', timeout: 8000 })
    return 'listed'
  } catch (err) {
    const details = extractExecSyncError(err)
    const status = err && typeof err === 'object' && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : Number.NaN
    if (/Could not find|No such process|No such file/i.test(`${details.summary} ${details.stderr}`)) return 'gone'
    if (status === 113) return 'gone'
    return 'unknown'
  }
}

/**
 * Remove a provably foreign registration so the not-loaded path can re-bootstrap it.
 *
 * Returns true only once the label is CONFIRMED gone: `bootout` returns before launchd
 * has finished tearing the job down, and bootstrapping into a half-removed label
 * fails with the opaque "Bootstrap failed: 5: Input/output error" (issue #42).
 * Returning false makes the caller fail closed — see the call site.
 */
function bootoutForeignRegistration(uid: string, label: string): boolean {
  try {
    execSync(`launchctl bootout gui/${uid}/${label}`, { stdio: 'pipe', timeout: 8000 })
  } catch (err) {
    const details = extractExecSyncError(err)
    const alreadyGone = /No such process|Could not find/i.test(`${details.summary} ${details.stderr}`)
    if (!alreadyGone) {
      logLifecycle('lifecycle.start.bootout_failed', { label, error: details.summary, stderr: details.stderr })
      return false
    }
  }
  let lastPresence: 'listed' | 'gone' | 'unknown' = 'unknown'
  for (let attempt = 0; attempt < 10; attempt++) {
    lastPresence = probeLabelPresence(label)
    if (lastPresence === 'gone') {
      logLifecycle('lifecycle.start.bootout_ok', { label, waitedMs: attempt * 500 })
      return true
    }
    // 'unknown' keeps polling rather than concluding either way — the loop's
    // timeout is the only thing allowed to end this, and it ends it as a failure.
    portableSleep(500)
  }
  logLifecycle('lifecycle.start.bootout_not_confirmed_gone', { label, lastPresence })
  return false
}

/**
 * Idempotent, state-aware daemon start via launchd.
 *
 * - already running → no-op success
 * - loaded but stopped (SuccessfulExit=false) → enable + kickstart
 * - not loaded → write plist + bootstrap
 * - loaded from a provably foreign registration → bootout, then the not-loaded path
 *
 * NEVER uses detached-spawn. Uses launchctl enable/kickstart/bootstrap which are the
 * only first-party stable verbs across macOS 13–15.
 *
 * NEVER unloads, with exactly ONE exception: a label whose loaded registration
 * provably is not ours — `launchctl list` names a Program we do not manage, or one
 * that does not exist on disk. launchd does not re-read the plist file of an
 * already-bootstrapped label, so for that state rewriting the file and kickstarting
 * re-kicks the stale program forever (issue #577: an install pointed at a deleted
 * /private/tmp home hung the wizard on "Installing…", exit 78 EX_CONFIG, penalty
 * box, and no err.log ever created). bootout is the only verb that clears it. The
 * mismatch must be PROVABLE — any doubt keeps the no-unload default, because
 * booting out a healthy daemon is worse than the bug.
 */
export function startOrKickstartDaemon(daemonEntry: string): { ok: boolean; reason: string } {
  const startAttemptedAt = Date.now()
  const plistName = getPlistName()
  const plistLabel = plistName.replace('.plist', '')
  const uid = execSync('id -u', { encoding: 'utf8' }).toString().trim()
  const plistPath = path.join(LAUNCH_AGENTS, plistName)
  const initialLock = daemonLockPid()

  // ── Probe launchd state first ──
  // launchctl list <label> prints JSON-like output on macOS 13+.
  // If loaded, output contains "PID" = <number>; if stopped, PID = 0.
  // If not loaded, exit code is non-zero and stderr says "Could not find".
  //
  // The SAME output also carries "Program" / "ProgramArguments" (the registration
  // launchd actually holds) and "LastExitStatus" (why its last run ended). Both are
  // parsed below: discarding everything but the PID is what made #577 invisible.
  let jobState: 'not_loaded' | 'loaded_stopped' | 'loaded_running' = 'not_loaded'
  let registrationProbe: LaunchdRegistrationProbe = { state: 'unavailable', error: 'not probed' }
  try {
    const out = execSync(`launchctl list ${plistLabel}`, { stdio: 'pipe', encoding: 'utf8', timeout: 8000 })
    const pidMatch = out.match(/"PID"\s*=\s*(\d+)/)
    if (pidMatch && pidMatch[1] && parseInt(pidMatch[1], 10) > 0) {
      jobState = 'loaded_running'
    } else {
      jobState = 'loaded_stopped'
    }
    registrationProbe = { state: 'listed', registration: parseLaunchctlList(out.toString()) }
  } catch (err) {
    const details = extractExecSyncError(err)
    logLifecycle('lifecycle.start.probe_failed', { error: details.summary, stderr: details.stderr })
    jobState = 'not_loaded'
    registrationProbe = { state: 'unavailable', error: `${details.summary}${details.stderr ? ' — ' + details.stderr : ''}` }
  }

  // ── Reconcile the LOADED registration, not just the plist file (issue #577) ──
  // Only meaningful when the label is loaded: the not-loaded path bootstraps from
  // our own plist, so there is nothing stale to reconcile.
  const registration = registrationProbe.state === 'listed' ? registrationProbe.registration : null
  const wrapperPath = getWrapperPath()
  const verdict = jobState === 'not_loaded'
    ? null
    : classifyLaunchdRegistration(registrationProbe, wrapperPath)

  // The registered program and last exit status are logged because diagnosing #577
  // required hand-running launchctl even though the lifecycle log held every other
  // detail of the failure.
  logLifecycle('lifecycle.start.probe', {
    state: jobState,
    label: plistLabel,
    expectedProgram: wrapperPath,
    registeredProgram: registration?.program ?? null,
    lastExitStatus: registration?.lastExitStatus ?? null,
    registrationVerdict: verdict?.reason ?? null,
  })

  /** The truthful fact about a failing job, appended to reasons that would otherwise
   *  name only our own execSync timeout. Cleared once we bootout, because after that
   *  the exit status belongs to a registration that no longer exists.
   *
   *  Only ever appended to a reason we are ALREADY returning as a failure, and it is
   *  read from the probe taken BEFORE this attempt's kickstart — so it always
   *  describes a finished run, never this one. It is not evidence on its own: a job
   *  can list a non-zero LastExitStatus while a current PID is alive and well
   *  (measured: status 15 next to a live PID). describeLastExitStatus says "previous
   *  run" for that reason; keep it that way if this moves to a non-failure path. */
  let lastExitNote = describeLastExitStatus(registration?.lastExitStatus ?? null)
  const withExitNote = (reason: string): string => (
    lastExitNote ? `${reason} — ${lastExitNote}; inspect with: launchctl print gui/${uid}/${plistLabel}` : reason
  )

  if (verdict?.mismatch) {
    console.warn(`[bridge] start.foreign_registration — ${verdict.detail}.`)
    logLifecycle('lifecycle.start.foreign_registration', {
      label: plistLabel,
      reason: verdict.reason,
      detail: verdict.detail,
      jobState,
      registeredProgram: registration?.program ?? null,
      lastExitStatus: registration?.lastExitStatus ?? null,
    })
    if (jobState === 'loaded_running' && verdict.reason === 'program_missing') {
      // Our own wrapper path, registered correctly, with the file deleted underneath
      // a process that is already running. setupLaunchd rewrites that exact file, so
      // this one is genuinely repaired by the write below — no bootout, no failure.
      console.warn('[bridge] start.foreign_registration.recreating_wrapper — the registration is ours; rewriting the missing wrapper.')
    } else if (jobState === 'loaded_running') {
      // DESIGN FORK, decided: a RUNNING job is never booted out here.
      //
      // The stale registration may be an older daemon that is up and serving live
      // PTY sessions (a pre-2026-05-01 registration whose program path — argv[1]
      // realpathed under an nvm node version — still exists). bootout would kill
      // those sessions mid-work, and this function runs on every desktop launch and
      // every tray Reconnect, so a wrong verdict would kill the daemon repeatedly,
      // with no consent and nothing to roll back to.
      // Reporting success is the other thing we refuse to do, and it is MEASURED, not
      // theorised: on the baseline build the reproducer ran install-service against a
      // foreign registration and got exit 0, "daemon already running via launchd" and
      // "service.install.ok", with the PID and the foreign Program both unchanged.
      // The install is NOT correct. `update` kickstarting this label restarts the old
      // program, and
      // because update.ts:327 requires /health to report the NEW version, update can
      // never succeed on such a machine — it rolls back every time, loudly, with no
      // way to fix the cause. So: refresh the plist file (it is what a later
      // bootstrap will read), fail with a distinct reason, and name the remedy.
      // `restart` detects the same mismatch and stops with --unload, which boots the
      // job out; a plain stop would leave it loaded for launchd's unconditional
      // KeepAlive to respawn before our probe runs.
      setupLaunchd(daemonEntry)
      const reason = `foreign_registration_running: ${verdict.detail}. Re-register the login service with: bridge-agent restart`
      logLifecycle('lifecycle.start.foreign_registration_running', { label: plistLabel, reason: verdict.reason })
      return { ok: false, reason }
    } else {
      // Loaded, not running, provably not ours → the one case that unloads.
      console.warn(`[bridge] start.foreign_registration.bootout — unloading the stale registration so the label can be re-bootstrapped from "${plistPath}".`)
      if (bootoutForeignRegistration(uid, plistLabel)) {
        // Fall through to the not-loaded branch: enable + bootstrap + kickstart.
        jobState = 'not_loaded'
        lastExitNote = null
      } else {
        // FAIL CLOSED. Falling through was the silent success this whole issue
        // exists to remove, re-entering by the back door: the code below rewrites
        // the plist FILE (which launchd will not re-read), kickstarts the
        // registration we have just PROVEN foreign, and returns ok:true if that
        // old program becomes ready — an install reported correct while launchd
        // still points somewhere else, and `update` can then never succeed on this
        // machine. There is nothing left to try here that is not a lie.
        console.error('[bridge] start.foreign_registration.bootout_failed — launchd still holds the stale registration; refusing to kick it.')
        const reason = `foreign_registration_bootout_failed: ${verdict.detail}, and it could not be unloaded. `
          + 'Re-register the login service with: bridge-agent restart'
        logLifecycle('lifecycle.start.foreign_registration_bootout_failed', {
          label: plistLabel,
          reason: verdict.reason,
          detail: verdict.detail,
        })
        return { ok: false, reason: withExitNote(reason) }
      }
    }
  }

  /** Wait for launchd to finish what it was already doing.
   *
   *  Measured on a loaded machine: a kickstart of a stopped job took 57s before
   *  the process appeared. launchd throttles respawns and, with KeepAlive set,
   *  is often already restarting the job on its own schedule — our kickstart
   *  just queues behind that. Waiting is cheap (one daemon-lock read a second);
   *  declaring failure is not, because it tells someone their install is broken
   *  while the daemon comes up behind the error. */
  function settleAfterTimeout(budgetMs = settlementBudgetMs()): WaitForReadinessResult<DaemonReadiness> {
    return waitForDaemonReadiness(
      plistLabel,
      'settle',
      initialLock.pid,
      budgetMs,
      initialLock.readFailed ? startAttemptedAt : 0,
    )
  }

  /** Short on purpose. If kickstart has not returned in this long it is launchd
   *  being slow, not an error, and the patience belongs in settleAfterTimeout()
   *  where it costs one process poll a second instead of a blocked shell. */
  // ── Already running → refresh wrapper best-effort, then no-op success ──
  // Best-effort only: daemon is running so a write failure is non-fatal.
  // Refreshing updates the wrapper CONTENTS (which distribution/binary the wrapper
  // execs) — that is what a running job picks up on its next launchd restart. It does
  // NOT change which program launchd has registered for this label; an
  // already-bootstrapped job keeps that until it is booted out, which is why the
  // registration itself is checked above instead of assumed repaired here (#577).
  if (jobState === 'loaded_running') {
    setupLaunchd(daemonEntry)
    const readiness = waitForDaemonReadiness(plistLabel, 'already_running', null)
    const failure = readinessFailureReason(readiness, 'running_job_never_became_ready')
    if (failure) return { ok: false, reason: withExitNote(failure) }
    console.log('[bridge] daemon already running via launchd')
    if (readiness.value?.predatesReadinessSignal) {
      return { ok: true, reason: 'daemon_predates_readiness_signal' }
    }
    return { ok: true, reason: 'already_running' }
  }

  // ── For stopped/not-loaded: wrapper + plist must be writable ──
  // Refreshes the wrapper's program path (e.g. a stale AppTranslocation path after
  // the app is moved to /Applications) in the FILE. That only reaches launchd on the
  // next bootstrap: an already-bootstrapped label keeps the program it was
  // registered with, which is why a foreign registration is booted out above
  // instead of being repaired here (issue #577).
  if (!setupLaunchd(daemonEntry)) {
    return { ok: false, reason: 'plist_write_failed' }
  }

  // ── Loaded but stopped (SuccessfulExit=false) → enable + kickstart ──
  if (jobState === 'loaded_stopped') {
    logLifecycle('lifecycle.start.enable_and_kickstart', { label: plistLabel })
    try {
      execSync(`launchctl enable gui/${uid}/${plistLabel}`, { stdio: 'pipe', timeout: 8000 })
    } catch (err) {
      const details = extractExecSyncError(err)
      logLifecycle('lifecycle.start.enable_failed', { error: details.summary, stderr: details.stderr })
      // enable may fail on older macOS — non-fatal, kickstart may still work
    }
    try {
      console.log('[bridge] start.waiting_launchd — waiting for launchd to start the daemon...')
      execSync(`launchctl kickstart -kp gui/${uid}/${plistLabel}`, { stdio: 'pipe', timeout: KICKSTART_TIMEOUT_MS })
      const readiness = settleAfterTimeout()
      const failure = readinessFailureReason(readiness, 'kickstarted_job_never_became_ready')
      if (failure) return { ok: false, reason: withExitNote(failure) }
      logLifecycle('lifecycle.start.kickstart_ok', { label: plistLabel })
      return { ok: true, reason: 'kickstarted_stopped_job' }
    } catch (err) {
      const details = extractExecSyncError(err)
      // A timeout is not a result. Ask launchd what actually happened before
      // telling the user their daemon failed to start.
      const readiness = settleAfterTimeout()
      const failure = readinessFailureReason(readiness, `kickstart_failed: ${details.summary}${details.stderr ? ' — ' + details.stderr : ''}`)
      if (!failure) {
        logLifecycle('lifecycle.start.kickstart_slow_but_ok', { label: plistLabel, error: details.summary })
        return { ok: true, reason: 'kickstarted_stopped_job' }
      }
      // `kickstart_failed: spawnSync /bin/sh ETIMEDOUT` names our own execSync
      // timeout and tells the user nothing. A non-zero LastExitStatus (78 on the
      // #577 machine) is the actual fact about their install — carry it.
      const reason = withExitNote(failure)
      logLifecycle('lifecycle.start.kickstart_failed', {
        error: details.summary,
        stderr: details.stderr,
        lastExitStatus: registration?.lastExitStatus ?? null,
      })
      return { ok: false, reason }
    }
  }

  // ── Not loaded → enable (idempotent) then bootstrap ──
  // A persistent stop / manual `launchctl disable` / reboot can leave the label in
  // launchd's disabled overrides. bootstrap then fails with the opaque
  // "Bootstrap failed: 5: Input/output error" (issue #42). `enable` clears the
  // override first; it is idempotent and safe on unknown / already-enabled / loaded
  // labels (verified). With RunAtLoad=false, bootstrap loads but does NOT start the
  // job — kickstart -kp actually launches the process.
  try {
    execSync(`launchctl enable gui/${uid}/${plistLabel}`, { stdio: 'pipe', timeout: 8000 })
  } catch (err) {
    const details = extractExecSyncError(err)
    logLifecycle('lifecycle.start.enable_before_bootstrap_failed', { error: details.summary, stderr: details.stderr })
    // Non-fatal — bootstrap below surfaces the real error if enable truly failed.
  }
  try {
    execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`, { stdio: 'pipe', timeout: 8000 })
    logLifecycle('lifecycle.start.bootstrap_ok', { label: plistLabel })
    // RunAtLoad=false — kickstart to actually start the process
    try {
      execSync(`launchctl kickstart -kp gui/${uid}/${plistLabel}`, { stdio: 'pipe', timeout: KICKSTART_TIMEOUT_MS })
      logLifecycle('lifecycle.start.kickstart_after_bootstrap_ok', { label: plistLabel })
    } catch (err2) {
      const details = extractExecSyncError(err2)
      logLifecycle('lifecycle.start.kickstart_after_bootstrap_failed', { error: details.summary, stderr: details.stderr })
      // Bootstrap succeeded, kickstart is best-effort — proceed anyway
    }
    console.log('[bridge] start.waiting_launchd — waiting for launchd readiness...')
    // "Loaded" is not "running". With RunAtLoad=false the bootstrap only
    // registers the job; the process appears when kickstart lands, which on a
    // loaded machine is seconds later. Returning ok here made `start` report
    // success while nothing was listening yet — the caller then polls a health
    // port that does not exist and concludes the daemon is down.
    const readiness = settleAfterTimeout()
    const settleFailure = readinessFailureReason(readiness, 'bootstrapped_but_never_started')
    if (settleFailure) {
      logLifecycle('lifecycle.start.bootstrapped_but_not_running', { label: plistLabel })
      return { ok: false, reason: settleFailure }
    }
    return { ok: true, reason: 'bootstrapped' }
  } catch (err) {
    const details = extractExecSyncError(err)
    const msg = details.summary
    // bootstrap exit 5 ("Input/output error") is AMBIGUOUS — it also fires when the
    // job is already loaded (raced past our probe) or the plist is malformed. Probe
    // actual state rather than trusting the opaque stderr string.
    let alreadyLoaded = false
    try { execSync(`launchctl list ${plistLabel}`, { stdio: 'pipe', timeout: 8000 }); alreadyLoaded = true } catch { /* not loaded */ }
    if (alreadyLoaded || msg.includes('already bootstrapped') || msg.includes('already loaded')) {
      try { execSync(`launchctl kickstart -kp gui/${uid}/${plistLabel}`, { stdio: 'pipe', timeout: 8000 }) } catch { /* best effort */ }
      const readiness = settleAfterTimeout()
      const failure = readinessFailureReason(readiness, 'already_bootstrapped_but_never_ready')
      if (failure) return { ok: false, reason: failure }
      return { ok: true, reason: 'already_bootstrapped' }
    }
    // Still disabled (the enable above failed — e.g. SIP / permissions)? Surface an
    // actionable message instead of launchctl's misleading "re-run as root" hint.
    let stillDisabled = false
    try {
      const out = execSync(`launchctl print-disabled gui/${uid}`, { encoding: 'utf8', stdio: 'pipe', timeout: 8000 })
      stillDisabled = out.includes(`"${plistLabel}" => disabled`)
    } catch { /* ignore */ }
    if (stillDisabled) {
      logLifecycle('lifecycle.start.bootstrap_disabled', { label: plistLabel })
      return { ok: false, reason: `launchd_label_disabled: "${plistLabel}" is disabled in launchd — run: launchctl enable gui/${uid}/${plistLabel}` }
    }
    const denied = msg.includes('Permission denied') || msg.includes('not allowed')
    logLifecycle('lifecycle.start.bootstrap_failed', { error: details.summary, stderr: details.stderr, denied })
    // Collapse the multi-line launchctl stderr onto one line — downstream UI (the
    // desktop tray takes the LAST stderr line) otherwise shows only launchctl's
    // misleading "Try re-running the command as root" hint (issue #42).
    const flatStderr = details.stderr.replace(/\s*\n\s*/g, ' / ').trim()
    return { ok: false, reason: denied ? 'bootstrap_permission_denied' : `bootstrap_failed: ${details.summary}${flatStderr ? ' — ' + flatStderr : ''}` }
  }
}

/**
 * Another `start` already holds the lock. Wait for its outcome instead of
 * calling it our failure.
 *
 * Two callers racing is ordinary here — the desktop ensures the daemon on every
 * launch, and the tray's Reconnect can land on top of that. Exiting 1 told the
 * second caller its start had failed while the first one was busy succeeding,
 * which surfaces as an error dialog over a daemon that is coming up fine.
 * Same shape as the kickstart timeout: someone else doing it is not a failure.
 */
function waitForConcurrentStart(budgetMs = settlementBudgetMs()): boolean {
  const label = getPlistName().replace('.plist', '')
  const result = waitForDaemonReadiness(label, 'concurrent', null, budgetMs)
  return readinessFailureReason(result, 'concurrent_start_never_became_ready') === null
}

/**
 * The one line a person sees when the daemon will not start.
 *
 * The reason strings are built for the log — `kickstart_failed: spawnSync
 * /bin/sh ETIMEDOUT` names an implementation detail of how we shelled out and
 * says nothing about what went wrong or what to do. The desktop app puts this
 * straight in front of someone who has just finished installing.
 *
 * Exported because `install-service` — the FIRST-RUN wizard path, the one a brand
 * new user is most likely to hit — printed the raw reason instead, purely because
 * only the `start` command happened to call this (#577 round 2).
 */
export function humanStartFailure(reason: string): string {
  if (reason.includes('foreign_registration_bootout_failed')) {
    return 'The login service is registered against a different install of the daemon, '
      + 'and macOS would not let us unload that registration. Run `bridge-agent restart` to '
      + 'replace it; if that also fails, restart the Mac and try again.'
  }
  if (reason.includes('foreign_registration_running')) {
    return 'The login service is registered against a different (older) install of the daemon, '
      + 'so restarting it would keep launching that one. Run `bridge-agent restart` to re-register it.'
  }
  // Checked before ETIMEDOUT: on a job that cannot exec, the timeout is our symptom
  // and the exit code is the cause (issue #577). Phrased as the PREVIOUS run, because
  // that is all LastExitStatus attests to — it can be non-zero next to a live PID.
  const exitCode = reason.match(/previous launchd run exited with status \d+ \(exit code (\d+)\)/)?.[1]
  if (exitCode) {
    return `The daemon did not become ready, and launchd's previous run of the login service exited with code ${exitCode}. `
      + 'The service may be registered against a path that no longer exists; '
      + 'run `bridge-agent restart` to re-register it.'
  }
  if (reason.includes('daemon_readiness_unobservable')) {
    return 'Could not observe daemon readiness because every readiness probe failed. Check the lifecycle log and try again.'
  }
  if (reason.includes('health_port_in_use')) {
    return 'The daemon started, but its health port is already in use. Stop the conflicting process or remove the HEALTH_PORT override.'
  }
  if (reason.includes('ETIMEDOUT')) {
    return 'launchd did not answer in time. The daemon may still be starting — '
      + 'open the menu bar in a moment, or try again.'
  }
  if (reason.includes('plist_write_failed')) {
    return 'Could not write the login service file. Check that ~/Library/LaunchAgents is writable.'
  }
  if (reason.includes('Input/output error') || reason.includes('bootstrap')) {
    return 'launchd refused to load the login service. Restarting the Mac usually clears this.'
  }
  if (reason.includes('EACCES') || reason.includes('permission')) {
    return 'Permission denied while starting the daemon. Check the ownership of ~/.bridge and ~/.jerico.'
  }
  // LAST, deliberately: a signal in LastExitStatus is what an ordinary stop leaves
  // behind (stop.ts SIGTERMs, then escalates to SIGKILL), so it explains nothing on
  // its own and must never outrank a branch that names the actual fault. It is here
  // only so the note does not fall through to the raw-reason fallback.
  const signal = reason.match(/previous launchd run was killed by signal (\d+)/)?.[1]
  if (signal) {
    return 'The daemon did not become ready. The previous run of the login service was killed by '
      + `signal ${signal}, which is what a normal stop looks like and says nothing about this attempt. `
      + 'Check the lifecycle log and try again.'
  }
  return `The daemon did not start (${reason}).`
}

function extractExecSyncError(err: unknown): { summary: string; stderr: string } {
  let summary = String(err)
  let stderr = ''
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: string }
    if (typeof e.stderr === 'string') stderr = e.stderr.trim()
    else if (typeof e.stdout === 'string') stderr = e.stdout.trim()
    if (typeof e.message === 'string') summary = e.message
  }
  return { summary, stderr }
}

// startAsDaemon() REMOVED — detached-spawn fallback is deleted.
// All daemon lifecycle goes through launchd (bootstrap / enable+kickstart).
// See: startOrKickstartDaemon() above.

/**
 * Verify the daemon is actually healthy after launchd reports success.
 * launchd can say "loaded" but the daemon might exit 1 second later.
 * Polls the health endpoint for up to 6 seconds before accepting success.
 */
export function verifyDaemonHealth(): void {
  const healthPort = getHealthPort()
  const deadline = Date.now() + 6000
  const tryConnect = (): void => {
    if (Date.now() > deadline) {
      console.error('[bridge] health.verify.timeout — daemon may have crashed immediately')
      return
    }
    try {
      const http = require('node:http')
      const req = http.get(`http://127.0.0.1:${healthPort}/health`, (res: { statusCode: number }) => {
        if (res.statusCode === 200) {
          console.log('[bridge] health.verify.ok')
        } else {
          setTimeout(tryConnect, 500)
        }
      })
      req.on('error', () => { setTimeout(tryConnect, 500) })
      req.setTimeout(1000, () => { req.destroy(); setTimeout(tryConnect, 500) })
    } catch { setTimeout(tryConnect, 500) }
  }
  setTimeout(tryConnect, 1000)
}

/**
 * Write ~/.bridge/bin/bridge-mcp, a tiny sh wrapper that invokes the pkg binary's
 * bridge-mcp subcommand. Only written inside a pkg binary; npm/monorepo installs
 * resolve bridge-mcp.cjs directly and never need this wrapper. Never throws.
 */
function setupMcpWrapper(): void {
  if ((process as any).pkg === undefined) return
  try {
    const binDir = path.join(homedir(), '.bridge', 'bin')
    mkdirSync(binDir, { recursive: true })
    const wrapperPath = path.join(binDir, 'bridge-mcp')
    writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" bridge-mcp "$@"\n`, { mode: 0o755 })
    console.log('[daemon] mcp.wrapper.written', { path: wrapperPath })
  } catch (err) {
    console.warn('[daemon] mcp.wrapper.write.failed', { error: String(err) })
  }
}

/**
 * Reap PTY processes orphaned by a previous daemon instance's death.
 * node-pty children survive a daemon crash/restart (they get reparented to
 * PID 1), the new instance has no handles for them, and subsequent kill
 * messages silently no-op — leaving zombie agent CLIs running forever.
 *
 * Discriminator: PPID == 1 AND the command carries one of OUR spawn markers
 * (bridge-mcp- / bridge-role-panel- / bridge-persona-panel- tmp files). Live
 * panels of ANY running daemon — including the other profile in dual-daemon
 * setups — have that daemon process as their parent and are never touched.
 */
function reapOrphanPtys(): void {
  const manifestPath = getSpawnManifestPath()
  if (!existsSync(manifestPath)) return

  let entries: ManifestEntry[] = []
  try {
    const raw = readFileSync(manifestPath, 'utf8')
    if (raw.trim()) entries = JSON.parse(raw)
    if (!Array.isArray(entries)) entries = []
  } catch {
    logLifecycle('pty.orphans.manifest_read_error', { path: manifestPath })
    return
  }

  const currentPid = process.pid
  let reaped = 0
  const survivors: ManifestEntry[] = []

  for (const e of entries) {
    // Keep entries from current daemon instance (same PID) — not orphans
    if (e.daemonPid === currentPid) {
      survivors.push(e)
      continue
    }

    // Blind-spot D: Validate the target PID still exists before PGID-kill.
    // Corrupt/stale manifest entries could point to pids that were recycled
    // to unrelated processes.  kill(pid,0) throws ESRCH if dead — safe skip.
    try {
      process.kill(e.pid, 0) // signal 0 = existence check
    } catch {
      // PID doesn't exist — stale manifest entry, skip safely
      logLifecycle('pty.orphan.skipped_dead_pid', { agentId: e.agentId, pid: e.pid })
      continue
    }

    // PGID-based kill: nuke the entire process group.
    // node-pty child IS session leader (pid==pgid) — kill(-pid) kills the process group.
    // Fall back to single-pid kill if group kill throws ESRCH/EPERM.
    try {
      process.kill(-e.pid, 'SIGKILL')
    } catch {
      try { process.kill(e.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    reaped++
    console.log('[daemon] pty.orphan.reaped', {
      agentId: e.agentId,
      pid: e.pid,
      pgid: e.pgid,
      daemonPid: e.daemonPid,
    })
  }

  // Rewrite manifest with only survivors from THIS daemon instance
  try {
    const tmp = manifestPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(survivors), 'utf-8')
    renameSync(tmp, manifestPath)
  } catch {
    // Best effort — stale entries won't block startup
  }

  if (reaped > 0) {
    console.log('[daemon] pty.orphans.done', { count: reaped, survivors: survivors.length })
  }
}

const AUTH_FAILED_RETRY_MS = 5_000

/**
 * Idle-mode recovery: when the auth-failed flag is deleted (bridge-agent auth
 * or desktop wizard), reset the connection gate and attempt one reconnect.
 *
 * Safety properties:
 * - Singleton: returns early if a timer is already scheduled.
 * - Single reconnect: clears the timer BEFORE calling startDaemonConnection so
 *   no second interval can fire while a reconnect is in progress.
 * - Bounded: if the new token is also invalid, client.ts writes the flag and
 *   exits 0; the next daemon process will idle again. No busy-spin.
 * - Guarded: resetDaemonConnectionState() makes the _started/_isConnected gate
 *   in client.ts safe for this one re-entry.
 */
function startAuthFailedRetryLoop(manager: PtyManager): void {
  if (authFailedRetryTimer) return
  const flagPath = getAuthFailedFlagPath()
  authFailedRetryTimer = setInterval(() => {
    if (existsSync(flagPath)) return
    clearInterval(authFailedRetryTimer!)
    authFailedRetryTimer = null
    logLifecycle('lifecycle.start.auth_failed_flag_cleared', { flag: flagPath })
    console.log('[daemon] auth_failed flag cleared — attempting reconnect')
    try {
      unregisterIdleSignalHandler()
      resetDaemonConnectionState()
      startDaemonConnection(manager)
      manager.startLivenessCheck(60_000)
    } catch (err) {
      logLifecycle('lifecycle.start.auth_failed_reconnect_error', {
        error: String(err),
      })
      console.error('[daemon] auth_failed reconnect failed:', err)
    }
  }, AUTH_FAILED_RETRY_MS)
}

/** The endpoint verdict this process is currently living under (#571). Read by
 *  /health so the tray can name the cause; cleared when the config is fixed. */
let currentEndpointRejection: EndpointRejection | null = null
let endpointRetryTimer: NodeJS.Timeout | null = null

const ENDPOINT_RETRY_MS = 5_000

/**
 * Idle-mode recovery for a refused endpoint.
 *
 * Unlike the auth-failed loop, this does NOT watch for the flag to be deleted:
 * deleting the flag does not make the configured endpoint valid, so a
 * flag-watching loop would dial, refuse, rewrite the flag and do it again every
 * five seconds. It re-reads the config instead, and only reconnects once the
 * value on disk actually satisfies the contract — which is what `bridge-agent
 * auth` (or a hand-fixed settings.json) produces.
 */
function startEndpointRejectedRetryLoop(manager: PtyManager): void {
  if (endpointRetryTimer) return
  endpointRetryTimer = setInterval(() => {
    const rejection = getDaemonEndpointRejection()
    if (rejection) {
      currentEndpointRejection = rejection
      return
    }
    clearInterval(endpointRetryTimer!)
    endpointRetryTimer = null
    currentEndpointRejection = null
    try { unlinkSync(getEndpointRejectedFlagPath()) } catch { /* absent is normal */ }
    logLifecycle('lifecycle.start.endpoint_rejection_cleared', {})
    console.log('[daemon] endpoint now satisfies the contract — attempting connection')
    try {
      unregisterIdleSignalHandler()
      resetDaemonConnectionState()
      startDaemonConnection(manager)
      manager.startLivenessCheck(60_000)
    } catch (err) {
      logLifecycle('lifecycle.start.endpoint_reconnect_error', { error: String(err) })
      console.error('[daemon] endpoint reconnect failed:', err)
    }
  }, ENDPOINT_RETRY_MS)
}

/**
 * Refuse the configured endpoint without ever exiting non-zero.
 *
 * The plist is `KeepAlive { SuccessfulExit false }` with `ThrottleInterval 30`,
 * so `process.exit(1)` here would turn one bad settings.json into a job launchd
 * respawns every 30 seconds forever — on a machine that worked yesterday, with
 * nothing on screen, because the daemon has no UI. So: do not connect, stay
 * alive, and leave the reason where both a human and the tray can find it.
 */
function enterEndpointRejectedMode(manager: PtyManager, rejection: EndpointRejection): void {
  currentEndpointRejection = rejection
  logLifecycle('lifecycle.start.endpoint_rejected', {
    code: rejection.code,
    reason: rejection.reason,
    server: rejection.serverRedacted,
    remedy: endpointRepairCommand(),
  })
  console.error(
    `[daemon] configured endpoint refused — ${rejection.reason}. `
    + `Not connecting. Fix it with: ${endpointRepairCommand()}`,
  )
  try {
    writeFileSync(
      getEndpointRejectedFlagPath(),
      JSON.stringify({
        rejectedAt: Date.now(),
        code: rejection.code,
        reason: rejection.reason,
        server: rejection.serverRedacted,
        remedy: endpointRepairCommand(),
      }),
      { encoding: 'utf-8', mode: 0o600 },
    )
  } catch (err) {
    console.warn('[daemon] endpoint_rejected.flag_write_failed', { error: String(err) })
  }
  // A daemon that never dials cannot have had its token rejected, so any
  // auth-failed flag here is stale — from before the endpoint went bad. Left in
  // place it hides this state on the tray and auto-opens a re-auth wizard whose
  // auth then fails on the very endpoint being complained about.
  try { unlinkSync(getAuthFailedFlagPath()) } catch { /* absent is normal */ }
  // Idle mode skips startDaemonConnection, so nothing else would clean our own
  // lock on SIGTERM/SIGINT.
  registerIdleSignalHandler()
  startEndpointRejectedRetryLoop(manager)
}

function runDaemonServices(): void {
  // Blind-spot A: Uncaught exceptions/unhandled rejections must exit(1) so
  // launchd auto-recovers (SuccessfulExit=false only suppresses restart on exit 0).
  // Clean shutdown is the ONLY path that exits 0.
  process.on('uncaughtException', (err) => {
    logLifecycle('lifecycle.uncaught_exception', {
      error: String(err),
      stack: err.stack?.slice(0, 500),
    })
    console.error('[daemon] FATAL uncaughtException — exiting 1:', err)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    logLifecycle('lifecycle.unhandled_rejection', {
      reason: String(reason),
    })
    console.error('[daemon] FATAL unhandledRejection — exiting 1:', reason)
    process.exit(1)
  })

  // Blind-spot C: verify spawn-helper health before proceeding; re-extract if broken
  setupSpawnHelper()
  setupMcpWrapper()

  cleanupStaleLock()   // prune dead PID entries so launchd respawns don't leave stale locks
  reapOrphanPtys()     // kill agent CLIs orphaned by a previous daemon instance

  // Write the daemon-owned lock with real PID, version, and shutdown token.
  // This overwrites any launcher-pid lock from acquireDaemonLock() since the
  // daemon child is the authoritative owner (Kimi lock model).
  const version = getDaemonVersion()
  const binaryPath = getDaemonEntry()
  writeDaemonLock(version, binaryPath)
  logLifecycle('lifecycle.start', { version, binaryPath, by: 'launchd' })

  const manager = new PtyManager()
  currentManager = manager
  const hookToken = generateHookToken()
  process.once('exit', () => removeHookEndpointDescriptorIfOwned(process.pid, hookToken))

  // #616: orchestrator event surface — exactly one broker/poller for the daemon run.
  // Leases are per-subscriber (orchestrator panel) and must survive across polls;
  // attach() only when there is no live lease, afterwards read() + poller.wait.
  // Handler is extracted to `events/orchestrator-handler.ts` so tests import the
  // SAME production handler (not a test-only copy) — a missing resolver would
  // be 403 in prod but 200 in a copied handler and hide the defect.
  const orchestratorLeases = new Map<string, symbol>()
  manager.onGenerationRetired = (agentId, instanceId) => {
    const subscriberId = subscriberIdFor(agentId, instanceId)
    orchestratorPoller.releaseWaiter(subscriberId)
    orchestratorLeases.delete(subscriberId)
    orchestratorBroker.forget(subscriberId)
  }
  const handleOrchestratorEvents: import('./http-dispatch.js').OrchestratorEventsHttpHandler = createOrchestratorEventsHandler({
    hookToken,
    isPanelLive: (agentId, instanceId) => manager.getPanelInstanceId(agentId) === instanceId,
    getPanelEventToken: (agentId, instanceId) => manager.getPanelEventToken(agentId, instanceId),
    broker: orchestratorBroker,
    poller: orchestratorPoller,
    leases: orchestratorLeases,
  })

  // #616 Fix 1: wire existing wedged/detached detectors on the same daemon-run
  // scope as the broker so a dead reader is demoted back to PTY instead of
  // silently absorbing notices. The synchronous publish gate (broker.publish)
  // already refuses wedged/detached on the next publish; this timer reclaims
  // the subscriber state and releases any parked long-poll so retention/leases
  // do not accumulate (also mitigates F6). Interval is 30s — one third of the
  // 90s hang window — so at most one extra notice is absorbed before sweep.
  const orchestratorEventDemoteTimer = setInterval(() => {
    try {
      const wedged = orchestratorBroker.wedgedSubscribers()
      const detached = orchestratorBroker.detachedSubscribers()
      const toDemote = new Set<string>([...wedged, ...detached])
      for (const subscriberId of toDemote) {
        orchestratorPoller.releaseWaiter(subscriberId)
        const lease = orchestratorLeases.get(subscriberId)
        if (lease) orchestratorBroker.detach(subscriberId, lease)
        // #616 r4 Fix 1: demotion must NOT destroy unacked ring/gap state.
        // Detaching clears the lease so the next publish is refused as
        // no_subscriber (stream not trusted → PTY fallback) while the retained
        // ring/gap remains replayable on reattach. `broker.detach` docstrings
        // say "state is retained deliberately" and `forget` is "only for a
        // panel that is truly gone"; a wedged reader is not gone — forgetting
        // loses an accepted, unacked verdict with no replay and no gap.
        // Leak tension (#619/F6): retaining forever would leak if detached
        // subscribers accumulated unboundedly. Bounded by (a) panel count
        // (maxActivePanels) and (b) per-subscriber ring retention (512) with
        // gap signal; full `forget` is reserved for authoritative panel-
        // generation death (isPanelLive===false / panel_gone 409 path) or a
        // bounded retention reaper — not the 30s wedge sweep.
        orchestratorLeases.delete(subscriberId)
        const reason = wedged.includes(subscriberId) ? 'wedged' : 'detached'
        console.log('[daemon] orchestrator.event.demoted', { subscriberId: subscriberId.slice(-20), reason })
      }
    } catch (err) {
      console.warn('[daemon] orchestrator.event.demote_error', { error: String(err) })
    }
  }, 30_000)
  // Do not keep the process alive solely for this sweep if everything else exits.
  if (typeof (orchestratorEventDemoteTimer as unknown as { unref?: () => void }).unref === 'function') {
    ;(orchestratorEventDemoteTimer as unknown as { unref: () => void }).unref()
  }

  void startSupervisor().catch((err) => {
    console.error('[daemon] codegraph supervisor start failed (daemon continues):', String(err))
  })

  // Variant B: if a previous run left an auth-failed flag, do not open the
  // WebSocket with the stale token. Stay alive idle so launchd cannot respawn
  // us, and poll for flag deletion so we reconnect when the user re-auths.
  const authFailedFlagPath = getAuthFailedFlagPath()

  // F31: Missing/invalid token at startup — route into idle-alive mode so the
  // health endpoint still binds and the desktop can open the re-auth wizard.
  if (!hasToken()) {
    logLifecycle('lifecycle.start.token_missing', { reason: 'token_missing_at_startup' })
    console.error('[daemon] token missing at startup — refusing WS connection. Run: bridge-agent auth')
    if (!existsSync(authFailedFlagPath)) {
      try { writeFileSync(authFailedFlagPath, '') } catch { /* best effort */ }
    }
  }

  // #571: judge the configured endpoint BEFORE anything can dial it. This
  // outranks the auth-failed gate — a token that cannot be sent anywhere is not
  // the fault worth naming, and re-authing would not fix this one.
  const endpointRejection = getDaemonEndpointRejection()
  if (!endpointRejection) {
    // A config that has since been fixed must not keep answering "rejected".
    try { unlinkSync(getEndpointRejectedFlagPath()) } catch { /* absent is normal */ }
  }

  if (endpointRejection) {
    enterEndpointRejectedMode(manager, endpointRejection)
  } else if (existsSync(authFailedFlagPath)) {
    logLifecycle('lifecycle.start.auth_failed_flag_present', {
      flag: authFailedFlagPath,
      remedy: 'bridge-agent auth',
    })
    console.error('[daemon] auth_failed flag present — refusing WS connection. Run: bridge-agent auth')
    // C: idle-mode signal handler — startDaemonConnection is skipped in idle mode,
    // so register a minimal handler here to clean our own lock on SIGTERM/SIGINT.
    registerIdleSignalHandler()
    startAuthFailedRetryLoop(manager)
  } else {
    startDaemonConnection(manager)
    manager.startLivenessCheck(60_000)
  }

  const healthPort = getHealthPort()
  const health = createServer((req, res) => {
    maintainHookDiagnostics()
    const route = dispatchDaemonHttpRequest(req, res, (hookReq, hookRes) => {
      void handleAgentHookRequest(hookReq, hookRes, {
        manager,
        expectedToken: hookToken,
        ws: manager.getCurrentWs(),
      })
    }, `http://127.0.0.1:${healthPort}`, handleOrchestratorEvents)
    if (route.handled) return
    const healthUrl = route.url
    const pathname = route.pathname

    // ── POST /usage/refresh — re-read every provider NOW, token-gated ──
    //
    // Token-gated for the same reason /shutdown is, plus one specific to this
    // route: an interactive refresh is allowed to raise a macOS Keychain prompt,
    // and an unauthenticated loopback endpoint that can pop a system dialog is a
    // nuisance vector. The scheduled cycle never prompts; this one may, because a
    // person just asked. The response carries readings, never a credential.
    if (req.method === 'POST' && pathname === '/usage/refresh') {
      const suppliedToken = healthUrl.searchParams.get('token')
      if (!suppliedToken || suppliedToken !== currentShutdownToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, reason: 'invalid or missing token' }))
        return
      }
      void refreshUsageNow()
        .then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, usage: usageForHealth() }))
        })
        .catch((err: unknown) => {
          // A provider throwing must not take the route down; the payload already
          // carries per-agent faults for everything that failed politely.
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
            usage: usageForHealth(),
          }))
        })
      return
    }

    // ── POST /shutdown — graceful daemon stop RPC (blind-spot B: token-gated) ──
    if (req.method === 'POST' && pathname === '/shutdown') {
      // Security: validate shutdown token matches lock file
      const suppliedToken = healthUrl.searchParams.get('token')
      if (!suppliedToken || suppliedToken !== currentShutdownToken) {
        logLifecycle('lifecycle.shutdown.denied', { reason: 'invalid_token' })
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, reason: 'invalid or missing shutdown token' }))
        return
      }

      const purge = healthUrl.searchParams.get('purge') === '1'
      setPurgeIntent(purge)
      logLifecycle('lifecycle.shutdown.received', { agents: currentManager?.getLiveAgentIds(), purge })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))

      // Notify server of purge intent before killing agents / closing socket.
      // cleanShutdown() is not invoked on this path, so we send explicitly here.
      const shutdownWs = currentManager?.getCurrentWs()
      if (shutdownWs?.readyState === WebSocket.OPEN) {
        try { shutdownWs.send(JSON.stringify({ type: 'daemon_shutdown', purge })) } catch {}
      }

      // Graceful agent cleanup with bounded wait + SIGKILL escalation
      currentManager?.killAll()
      setTimeout(async () => {
        const remaining = currentManager?.getLiveAgentIds() ?? []
        if (remaining.length > 0) {
          logLifecycle('lifecycle.shutdown.agents_alive_after_timeout', { remaining })
          for (const id of remaining) currentManager?.kill(id, true)
        }
        await shutdownSupervisor()
        logLifecycle('lifecycle.shutdown.complete')
        process.exit(0)
      }, 3000)
      return
    }

    // ── POST /reconnect — force an immediate WS reconnect (token-gated) ──
    // Lets the desktop tray break a wedged / backoff-waiting state without a full
    // daemon restart, preserving live PTY sessions. Mirrors /shutdown's token gate.
    if (req.method === 'POST' && pathname === '/reconnect') {
      const suppliedToken = healthUrl.searchParams.get('token')
      if (!suppliedToken || suppliedToken !== currentShutdownToken) {
        logLifecycle('lifecycle.reconnect.denied', { reason: 'invalid_token' })
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, reason: 'invalid or missing token' }))
        return
      }
      const dialed = forceReconnect()
      logLifecycle('lifecycle.reconnect.received', { dialed })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, dialed }))
      return
    }

    // ── GET /health — standard health check ──
    const connected = isDaemonWsConnected()
    const authFailed = existsSync(getAuthFailedFlagPath())
    // #571: a daemon that refused its endpoint looks exactly like one that is
    // merely offline, and the difference is the whole remedy. Say which.
    //
    // Read live, not only from the mode this process started in: the guard in
    // ws/client.ts can refuse an endpoint on a path that never sets the
    // module-local variable, and a /health that then answered "offline" put the
    // word "Reconnecting" on the tray — the one word this state exists to avoid.
    const endpointRejection = currentEndpointRejection ?? getDaemonEndpointRejection()
    const probe = healthUrl.searchParams.get('probe') === 'fresh'
      ? probeProtectedAccess({ forceRefresh: true })
      : probeProtectedAccess()
    const cg = getCodegraphHealth()
    const body = JSON.stringify({
      status: connected
        ? 'ok'
        : (endpointRejection ? 'endpoint_rejected' : (authFailed ? 'auth_failed' : 'offline')),
      // Identity, so a caller can tell whether this daemon is the one it meant
      // to ask. Ports are an addressing convention and conventions collide;
      // acting on another profile's health is worse than getting no answer.
      profile: getActiveProfile() ?? null,
      connected,
      reconnectAttempts: getReconnectCount(),
      authFailed,
      endpointRejected: endpointRejection !== null,
      /** The sentence, not the code — this is what the tray puts on screen. */
      endpointRejectedReason: endpointRejection?.reason ?? null,
      endpointRejectedCode: endpointRejection?.code ?? null,
      /** Userinfo already stripped: /health is not a place to repeat a secret. */
      endpointRejectedServer: endpointRejection?.serverRedacted ?? null,
      /** The command that repairs it, profile included. The desktop prints this
       *  verbatim rather than inventing a remedy of its own — the first version
       *  offered "Re-authenticate", which opens the connect page and cannot
       *  rewrite an endpoint (#571 review B2). */
      endpointRepairCommand: endpointRejection ? endpointRepairCommand() : null,
      hookInstallRefused: lastHookInstallRefusal,
      uptime: process.uptime(),
      version: getDaemonVersion(),
      activePanels: currentManager?.getLiveAgentIds().length ?? 0,
      agentIds: currentManager?.getLiveAgentIds() ?? [],
      panels: currentManager?.getLivePanelsReport() ?? [],
      pongRttHistory: getRttState().history ?? [],
      documentsFolderReadable: probe.readable,
      // Backward-compatible alias for older desktop builds. This observation
      // is Documents-specific; new callers must use documentsFolderReadable.
      protectedFoldersReadable: probe.readable,
      codegraph: cg,
      /** Provider limits, refreshed in the background. Empty until the first
       *  cycle lands; an agent with no fetcher is omitted rather than reported
       *  as a fault. The desktop's limits register reads exactly this. */
      usage: usageForHealth(),
      healthReady: true,
      // Harness-gated only (#637 cp5 Q1): exact sched-* PTY group identities
      // for the isolated descendant proof. Absent on every normal daemon.
      ...(scheduledDescendantHealthEnabled() && currentManager
        ? { scheduledProcessGroups: currentManager.getScheduledProcessGroups() }
        : {}),
    })
    res.writeHead(connected ? 200 : 503, { 'Content-Type': 'application/json' })
    res.end(body)
  })
  health.listen(healthPort, '127.0.0.1', () => {
    maintainHookDiagnostics()
    const address = health.address()
    const boundPort = typeof address === 'object' && address ? address.port : healthPort
    writeHookEndpointDescriptor({
      protocol: HOOK_PROTOCOL,
      // Keep the legacy field name: old events clients check this exact field
      // before constructing a request, while provider hooks ignore it.
      protocolVersion: EVENTS_PROTOCOL_VERSION,
      [DESCRIPTOR_FIELD_URL]: `http://127.0.0.1:${boundPort}${HOOK_EVENT_PATH}`,
      profile: getActiveProfile(),
      daemonPid: process.pid,
      [DESCRIPTOR_FIELD_TOKEN]: hookToken,
      writtenAt: Date.now(),
    })
    // Rewrite the existing daemon-owned lock only after the OS confirms the
    // health listener is bound. Settlement consumes this explicit bit rather
    // than launchd's early PID.
    writeDaemonLock(version, binaryPath, true)
    logLifecycle('lifecycle.health_bound', { port: healthPort, pid: process.pid })
    // Only once the surface can be asked. Starting the refresher earlier would
    // spend a provider request on a daemon that may still fail to bind.
    startUsageRefresher()
    const falsifier = scheduledDescendantFalsifierPanel()
    if (falsifier && currentManager) {
      // Provider-free, harness-gated SIGTERM-ignoring sched-* group. Spawned
      // through the real PTY path so the ledger and health field are exercised.
      const spawned = currentManager.spawn(falsifier.agentId, 'sh', falsifier.binary, falsifier.args, 80, 24,
        () => {}, () => {}, { serverUrl: '', token: '', workspaceId: randomUUID() as WorkspaceId, agentId: falsifier.agentId as AgentId, cwd: process.env['HOME'] },
        mkSpawnAttemptId(falsifier.spawnAttemptId))
      logLifecycle('lifecycle.sdv1_falsifier_panel', { agentId: falsifier.agentId, spawned })
    }
  })
  health.on('error', (err: Error & { code?: string }) => {
    if (err.code === 'EADDRINUSE') {
      writeDaemonLock(version, binaryPath, false, 'EADDRINUSE')
      // A daemon that cannot bind its health port is invisible to the desktop
      // app that manages it: the app polls, gets nothing, and shows red
      // forever while this process is in fact connected and working. That is
      // exactly the confusion the per-profile ports were introduced to end, so
      // it says so in one greppable line rather than a bare error string.
      logLifecycle('lifecycle.health_bind_failed', {
        port: healthPort,
        pid: process.pid,
        hint: 'another process already owns this port — a second daemon for this '
          + 'profile, or a stale HEALTH_PORT override. This daemon keeps running '
          + 'but the desktop app cannot see it.',
      })
      console.error(
        `[bridge] health port ${healthPort} is already in use — the desktop app `
        + 'will not be able to see this daemon. Stop the other process, or unset HEALTH_PORT.',
      )
      return
    }
    console.error('[bridge] health.error', { error: err.message })
  })
}

/**
 * Check ownership of `~/.bridge`. If root-owned, emit a clear remediation
 * message early so the user can fix it before any file operation fails with
 * EACCES. Skipped if the directory does not exist (will be created later
 * by acquireDaemonLock / setupLaunchd with correct ownership).
 */
function checkBridgeOwnership(): void {
  const bridgeDir = path.join(homedir(), '.bridge')
  try {
    if (!existsSync(bridgeDir)) return
    const s = statSync(bridgeDir)
    const uid = process.getuid?.()
    if (uid !== undefined && s.uid !== uid) {
      console.warn('[bridge] ~/.bridge directory is owned by uid ' + s.uid + ' (current: ' + uid + '). File operations will fail.')
      console.warn('[bridge] Fix: sudo chown -R "$(whoami):staff" ~/.bridge')
    }
  } catch {
    // statSync failed — ownership issue will surface via EACCES later
  }
}

export function runStart(): void {
  const isDaemon = process.env['BRIDGE_DAEMON'] === '1' || process.argv.includes('--daemon')

  // Q1 guard: monorepo binary run without --profile silently connects to prod.
  // Warn loudly so the hazard is surfaced without blocking intentional use.
  if (!isDaemon && !process.env['BRIDGE_PROFILE']) {
    const entry = process.argv[1] ?? ''
    if (entry.includes('packages/daemon/dist') || entry.includes('packages/daemon/src')) {
      console.warn('[bridge] WARNING: running monorepo daemon without --profile — will use prod config (~/.jerico/settings.json).')
      console.warn('[bridge] If this is unintentional, stop and rerun with:  node packages/daemon/dist/index.js --profile dev start')
    }
  }

  console.log('[bridge] Starting bridge-agent daemon...')

  if (isDaemon) {
    runDaemonServices()
    return
  }

  // Detect ~/.bridge ownership issues early so the remediation is visible
  // before any EACCES failure on lock/config writes.
  checkBridgeOwnership()

  // Prevent multiple CLI start invocations from racing.
  // The daemon also writes its own lock (with shutdownToken) — when the daemon
  // is already running, we detect it here and proceed to the idempotent check.
  const lockResult = acquireDaemonLock()
  if (!lockResult.ok) {
    const err = lockResult.err!
    const lockPath = getLockPath()
    if (err.code === 'EEXIST') {
      // Lock exists — could be the daemon's authoritative lock (has shutdownToken)
      // or another concurrent CLI invocation (no shutdownToken).  If it's the
      // daemon's lock, proceed to idempotent check instead of erroring out.
      let existingRaw: string | null = null
      try {
        existingRaw = readFileSync(lockPath, 'utf8')
      } catch (readErr) {
        const code = readErr && typeof readErr === 'object' && 'code' in readErr
          ? String(readErr.code)
          : ''
        if (code === 'ENOENT') {
          // The file disappeared between open('wx') and this recheck. Acquire
          // the now-free CLI lock and continue the ordinary start path.
          const retry = acquireDaemonLock()
          if (!retry.ok) {
            console.warn('[bridge] start.aborted.lock_busy_after_disappeared_recheck')
            process.exit(1)
          }
        } else {
          // As in cleanupStaleLock(), inability to read is not evidence that a
          // live daemon lock is corrupt. Preserve its shutdown credential and
          // fail closed instead of unlinking it.
          logLifecycle('lifecycle.start.lock_recheck_read_failed', {
            path: lockPath,
            error: String(readErr),
          })
          console.warn(`[bridge] start.aborted.lock_unreadable — cannot safely inspect ${lockPath}`)
          process.exit(1)
        }
      }

      if (existingRaw !== null) try {
        const existing = JSON.parse(existingRaw)
        const currentVersion = getDaemonVersion()
        const currentBinaryPath = getDaemonEntry()

        if (!existing.shutdownToken && (existing.version !== currentVersion || existing.binaryPath !== currentBinaryPath)) {
          // F30-B3: identity-aware reclaim for CLI locks only. Daemon locks are
          // NEVER reclaimed; they fall through to the daemon-lock branch below.
          console.log(`[bridge] start — reclaiming stale CLI lock in EEXIST path (identity changed: version=${existing.version}→${currentVersion}, binaryPath=${existing.binaryPath}→${currentBinaryPath})`)
          try { unlinkSync(lockPath) } catch {}
          const retry = acquireDaemonLock()
          if (!retry.ok) {
            console.warn('[bridge] start.aborted.lock_busy_after_identity_reclaim')
            process.exit(1)
          }
        } else if (existing.shutdownToken && existing.pid) {
          // Daemon lock detected — go to launchd state check
          console.log('[bridge] start — daemon lock exists, checking launchd state')
        } else {
          // F30-B2: wait-and-retry (~3s) to ride out upgrade handoff before
          // concluding another CLI is genuinely in progress.
          let acquired = false
          for (let i = 0; i < 6; i++) {
            portableSleep(500)
            const retry = acquireDaemonLock()
            if (retry.ok) { acquired = true; break }
            if (retry.err?.code !== 'EEXIST') {
              console.warn(`[bridge] start.aborted.lock_error — ${retry.err?.code}: ${retry.err?.message}`)
              process.exit(1)
            }
            console.log(`[bridge] start — lock busy, retry ${i + 1}/6`)
          }

          if (!acquired) {
            // Re-read lock fresh after the wait window: another process may have
            // rewritten it, and using stale data here could orphan a new daemon.
            let postWaitData: { pid?: number; startedAt?: number } = {}
            let cleanupAcquired = false
            try {
              postWaitData = JSON.parse(readFileSync(lockPath, 'utf8'))
            } catch {
              // Corrupt/missing lock — clean and retry once
              try { unlinkSync(lockPath) } catch {}
              const retry = acquireDaemonLock()
              if (!retry.ok) {
                console.warn('[bridge] start.aborted.lock_busy_after_cleanup')
                process.exit(1)
              }
              cleanupAcquired = true
            }

            if (cleanupAcquired) {
              // Lock acquired after cleanup; skip remaining orphan logic.
            } else {
              // Re-run orphan detection: the lock holder may have been reparented
              // to PID 1 between cleanupStaleLock() and openSync('wx'),
              // or it could be a live CLI from another terminal session.
              // Reclaim only if lock is older than RECLAIM_STALENESS_MS (PID
              // recycling guard).
              const startedAt: number = typeof postWaitData.startedAt === 'number' ? postWaitData.startedAt : 0
              const pid = postWaitData.pid ?? existing.pid
              if (Date.now() - startedAt >= RECLAIM_STALENESS_MS) {
                const ppid = getParentPid(pid)
                if (ppid === 1) {
                  console.log(`[bridge] start — reclaiming orphaned CLI lock in EEXIST path (pid=${pid}, ppid=1, age=${Date.now() - startedAt}ms)`)
                  try { unlinkSync(lockPath) } catch {}
                  const retry = acquireDaemonLock()
                  if (!retry.ok) {
                    console.warn('[bridge] start.aborted.lock_busy_after_orphan_reclaim')
                    process.exit(1)
                  }
                } else {
                  console.warn('[bridge] start — another start is already running, waiting for it')
                  if (waitForConcurrentStart()) {
                    console.log('[bridge] start.ok — started by the concurrent run')
                    process.exit(0)
                  }
                  console.error('[bridge] start.failed — another start held the lock and the daemon never came up')
                  process.exit(1)
                }
              } else {
                console.warn('[bridge] start — another start is already running, waiting for it')
                if (waitForConcurrentStart()) {
                  console.log('[bridge] start.ok — started by the concurrent run')
                  process.exit(0)
                }
                console.error('[bridge] start.failed — another start held the lock and the daemon never came up')
                process.exit(1)
              }
            }
          }
        }
      } catch {
        // Corrupt lock — clean and retry
        try { unlinkSync(lockPath) } catch {}
        const retry = acquireDaemonLock()
        if (!retry.ok) {
          console.warn('[bridge] start.aborted.lock_busy_after_cleanup')
          process.exit(1)
        }
      }
    } else if (err.code === 'EACCES' || err.code === 'EPERM') {
      console.warn(`[bridge] start.aborted.permission_denied — cannot write ${lockPath} (${err.code}). Directory may be owned by root from \`sudo npm install\`. Try: sudo chown -R "$(whoami):staff" ~/.bridge`)
      process.exit(1)
    } else if (err.code === 'ENOENT') {
      console.warn(`[bridge] start.aborted.lock_dir_missing — ${lockPath}`)
      process.exit(1)
    } else {
      console.warn(`[bridge] start.aborted.lock_error — ${err.code}: ${err.message}`)
      process.exit(1)
    }
  }

  // State-aware idempotent start via launchd.
  // NEVER uses detached-spawn fallback — always goes through launchd.
  const daemonEntry = getDaemonEntry()
  const result = startOrKickstartDaemon(daemonEntry)

  if (!result.ok) {
    // The reason string is for the log. The desktop shows this line to a person
    // who has just installed the app, and "kickstart_failed: spawnSync /bin/sh
    // ETIMEDOUT" tells them nothing they can act on.
    console.error(`[bridge] start.failed — ${humanStartFailure(result.reason)}`)
    console.error(`[bridge] start.failed.detail — ${result.reason}`)
    process.exit(1)
  }

  console.log(`[bridge] start.ok — ${result.reason}`)

  // Only verify health on fresh starts; skip if already running.
  if (result.reason !== 'already_running') {
    verifyDaemonHealth()
  }

  process.exit(0)
}
