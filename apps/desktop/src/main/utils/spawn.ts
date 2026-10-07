import { app } from 'electron'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import type { SpawnResult } from '../lifecycle/types.js'

export const DAEMON_SETTLE_BUDGET_MS = 75_000
const LAUNCHCTL_OPERATION_TIMEOUT_MS = 8_000
const KICKSTART_TIMEOUT_MS = 15_000
const CLI_LOCK_RETRY_BUDGET_MS = 3_000
const PARENT_PROCESS_GRACE_MS = 20_000
export const AUTH_VALIDATION_TIMEOUT_MS = 8_000
export const DAEMON_CLI_STOP_WORST_CASE_MS = 18_000
const STOP_UNLOAD_BOOTOUT_TIMEOUT_MS = 5_000
const STOP_UNLOAD_POST_WAIT_MS = 3_000
const UNINSTALL_BOOTOUT_TIMEOUT_MS = 5_000
const UNINSTALL_PID_WAIT_MS = 3_000
export const KEYCHAIN_OPERATION_TIMEOUT_MS = 10_000
const AUTH_KEYCHAIN_SECURITY_OPERATION_COUNT = 7
const PROBE_KEYCHAIN_SECURITY_OPERATION_COUNT = 9
const HEAL_KEYCHAIN_SECURITY_OPERATION_COUNT = 17
const RESTART_PORT_WAIT_MS = 10_000
const RESTART_VERSION_WAIT_MS = 30_000

/** These are formulas, not independently chosen patience values. The start
 * maximum mirrors the not_loaded branch: list + enable + bootstrap + kickstart
 * + settle + the bounded CLI-lock retries. The parent adds process/IPC grace. */
export const DAEMON_CLI_START_WORST_CASE_MS =
  (3 * LAUNCHCTL_OPERATION_TIMEOUT_MS) + KICKSTART_TIMEOUT_MS
  + DAEMON_SETTLE_BUDGET_MS + CLI_LOCK_RETRY_BUDGET_MS
export const DAEMON_START_TIMEOUT_MS = DAEMON_CLI_START_WORST_CASE_MS + PARENT_PROCESS_GRACE_MS
export const DAEMON_CLI_RESTART_WORST_CASE_MS =
  DAEMON_CLI_STOP_WORST_CASE_MS + RESTART_PORT_WAIT_MS
  + DAEMON_CLI_START_WORST_CASE_MS + RESTART_VERSION_WAIT_MS
export const DAEMON_RESTART_TIMEOUT_MS = DAEMON_CLI_RESTART_WORST_CASE_MS + PARENT_PROCESS_GRACE_MS
/** setToken's successful Keychain path is keychainWrite's six security calls
 * (staging delete/write/read, real delete/write, staging cleanup) plus its
 * unconditional final account readback. Keep the executable gate paired with
 * this count so a token-store change cannot silently shorten the parent. */
export const DAEMON_CLI_AUTH_WORST_CASE_MS =
  AUTH_VALIDATION_TIMEOUT_MS
  + (AUTH_KEYCHAIN_SECURITY_OPERATION_COUNT * KEYCHAIN_OPERATION_TIMEOUT_MS)
export const DAEMON_AUTH_TIMEOUT_MS = DAEMON_CLI_AUTH_WORST_CASE_MS + PARENT_PROCESS_GRACE_MS
/** probeKeychainAcl adds a wrapper delete, readback, and cleanup around the
 * six-call keychainWrite. heal-keychain's longest successful route is a
 * nine-call staging-recovery getToken, seven-call setToken, then one read. */
export const DAEMON_CLI_PROBE_KEYCHAIN_WORST_CASE_MS =
  PROBE_KEYCHAIN_SECURITY_OPERATION_COUNT * KEYCHAIN_OPERATION_TIMEOUT_MS
export const DAEMON_PROBE_KEYCHAIN_TIMEOUT_MS =
  DAEMON_CLI_PROBE_KEYCHAIN_WORST_CASE_MS + PARENT_PROCESS_GRACE_MS
export const DAEMON_CLI_HEAL_KEYCHAIN_WORST_CASE_MS =
  HEAL_KEYCHAIN_SECURITY_OPERATION_COUNT * KEYCHAIN_OPERATION_TIMEOUT_MS
export const DAEMON_HEAL_KEYCHAIN_TIMEOUT_MS =
  DAEMON_CLI_HEAL_KEYCHAIN_WORST_CASE_MS + PARENT_PROCESS_GRACE_MS
export const DAEMON_ACTION_LATCH_TIMEOUT_MS =
  Math.max(DAEMON_START_TIMEOUT_MS, DAEMON_RESTART_TIMEOUT_MS) + 15_000
export const DAEMON_STOP_TIMEOUT_MS = DAEMON_CLI_STOP_WORST_CASE_MS + PARENT_PROCESS_GRACE_MS
export const DAEMON_CLI_UNLOAD_STOP_WORST_CASE_MS =
  DAEMON_CLI_STOP_WORST_CASE_MS + STOP_UNLOAD_BOOTOUT_TIMEOUT_MS + STOP_UNLOAD_POST_WAIT_MS
export const DAEMON_UNLOAD_STOP_TIMEOUT_MS =
  DAEMON_CLI_UNLOAD_STOP_WORST_CASE_MS + PARENT_PROCESS_GRACE_MS

/** Unnamed uninstall deletes the active Keychain entry, then default plus each
 * named profile. The timeout therefore depends on the number of on-disk
 * profiles instead of pretending one fixed number covers an unbounded loop. */
export function daemonUninstallTimeoutMs(profileCount: number): number {
  const safeProfileCount = Math.max(0, Math.floor(profileCount))
  const cliWorstCase = UNINSTALL_BOOTOUT_TIMEOUT_MS + UNINSTALL_PID_WAIT_MS
    + ((safeProfileCount + 2) * KEYCHAIN_OPERATION_TIMEOUT_MS)
  return cliWorstCase + PARENT_PROCESS_GRACE_MS
}

export function spawnBridgeAgent(
  args: string[],
  extraEnv?: Record<string, string>,
  timeoutOverrideMs?: number,
  onOutputLine?: (line: string) => void,
): Promise<SpawnResult> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env['PATH'] ?? ''}`,
    ...extraEnv,
  }

  // G1: pass BRIDGE_PROFILE to child when set; delete it otherwise to avoid inheriting
  // a stray BRIDGE_PROFILE=dev from the user's login shell and accidentally targeting the dev daemon.
  const profile = process.env['BRIDGE_PROFILE']
  if (profile) {
    childEnv['BRIDGE_PROFILE'] = profile
  } else {
    delete childEnv['BRIDGE_PROFILE']
  }

  // Phase10: Request correlation — generate a UUID so all lifecycle log lines
  // from this desktop-initiated action share a common requestId.
  childEnv['BRIDGE_REQUEST_ID'] = crypto.randomUUID()

  // Ordinary helpers remain short. Lifecycle callers pass their explicit
  // cross-process contract rather than relying on command-name deduction.
  const isRestart = args[0] === 'restart'
  const timeoutMs = timeoutOverrideMs ?? (isRestart ? 45_000 : 20_000)
  if (args[0] === 'auth') {
    // Overwrite, do not inherit: a user's shell may request up to 30s in the
    // standalone CLI, but a desktop child must consume the exact validation
    // bound from which its parent timeout was derived.
    childEnv['BRIDGE_AUTH_VALIDATE_TIMEOUT_MS'] = String(AUTH_VALIDATION_TIMEOUT_MS)
  }
  if (args[0] === 'auth' || args[0] === 'probe-keychain' || args[0] === 'heal-keychain') {
    childEnv['BRIDGE_KEYCHAIN_OPERATION_TIMEOUT_MS'] = String(KEYCHAIN_OPERATION_TIMEOUT_MS)
  }
  if (timeoutOverrideMs !== undefined) {
    childEnv['BRIDGE_DESKTOP_CHILD_TIMEOUT_MS'] = String(timeoutMs)
    childEnv['BRIDGE_DAEMON_SETTLE_BUDGET_MS'] = String(DAEMON_SETTLE_BUDGET_MS)
  }

  let cmd: string
  let cmdArgs: string[]

  if (app.isPackaged) {
    cmd = path.join(process.resourcesPath, 'bridge-agent')
    cmdArgs = args
  } else {
    // Dev: process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE=1 makes it behave
    // as plain node so the daemon JS runs correctly without spawning an Electron window.
    cmd = process.execPath
    childEnv['ELECTRON_RUN_AS_NODE'] = '1'
    const daemonDist = path.resolve(app.getAppPath(), '..', '..', 'packages', 'daemon', 'dist', 'index.js')
    cmdArgs = [daemonDist, ...args]
  }

  // Phase B: inject trusted binary paths for Keychain ACL (-T flags).
  // The daemon reads JERICO_TRUSTED_BINS and passes each path as -T on
  // add-generic-password, granting silent-access to both the bridge-agent
  // binary and the Jerico.app bundle (Electron shell).
  const appExePath = app.getPath('exe')
  childEnv['JERICO_TRUSTED_BINS'] = [cmd, appExePath].join(':')

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let stdoutLineBuffer = ''
    let settled = false
    const child = spawn(cmd, cmdArgs, { env: childEnv })

    // Safety: never let a hung child block the caller forever (e.g. a stuck
    // launchctl call would otherwise leave the tray's actionInFlight latch on).
    const killTimer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
      settled = true
      resolve({ code: null, stdout, stderr: stderr || `bridge-agent timed out after ${timeoutMs / 1000}s` })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      if (!onOutputLine) return
      stdoutLineBuffer += text
      let newline = stdoutLineBuffer.indexOf('\n')
      while (newline >= 0) {
        onOutputLine(stdoutLineBuffer.slice(0, newline))
        stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1)
        newline = stdoutLineBuffer.indexOf('\n')
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      if (onOutputLine && stdoutLineBuffer) onOutputLine(stdoutLineBuffer)
      resolve({ code, stdout, stderr })
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve({ code: null, stdout, stderr: err.message })
    })
  })
}
