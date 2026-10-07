import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { app } from 'electron'
import type { DaemonLifecycle, DaemonState, LifecycleProgressCallback, SpawnResult } from './types.js'
import {
  DAEMON_RESTART_TIMEOUT_MS,
  DAEMON_START_TIMEOUT_MS,
  DAEMON_STOP_TIMEOUT_MS,
  DAEMON_UNLOAD_STOP_TIMEOUT_MS,
  daemonUninstallTimeoutMs,
  spawnBridgeAgent,
} from '../utils/spawn.js'
import { pollOnce, pollVersion } from '../utils/health.js'
import { foreignRegistrationFault } from '../utils/daemon-failure.js'

const LAUNCH_AGENTS = path.join(os.homedir(), 'Library', 'LaunchAgents')

export class MacLaunchdLifecycle implements DaemonLifecycle {
  constructor(private readonly port: number) {}

  private installInFlight: Promise<SpawnResult> | null = null
  private startInFlight: Promise<SpawnResult> | null = null

  install(): Promise<SpawnResult> {
    if (this.installInFlight) return this.installInFlight
    const p = spawnBridgeAgent(['install-service'], undefined, DAEMON_START_TIMEOUT_MS).finally(() => {
      this.installInFlight = null
    })
    this.installInFlight = p
    return p
  }

  async start(onProgress?: LifecycleProgressCallback): Promise<SpawnResult> {
    if (this.startInFlight) return this.startInFlight
    const p = this.doStart(onProgress).finally(() => {
      this.startInFlight = null
    })
    this.startInFlight = p
    return p
  }

  private async doStart(onProgress?: LifecycleProgressCallback): Promise<SpawnResult> {
    // Phase B: auto-install LaunchAgent if the plist is missing.
    // This ensures the daemon is managed by launchd before we try to start it,
    // preventing the orphaned-CLI-lock scenario that caused Issue #19.
    const plistExists = await this.isInstalled()
    if (!plistExists) {
      console.log('[jerico-desktop] LaunchAgent not installed — installing before start')
      const installResult = await this.install()
      if (installResult.code !== 0) {
        console.warn('[jerico-desktop] LaunchAgent install failed, proceeding anyway:', installResult.stderr.trim())
      }
    }

    const result = await spawnBridgeAgent(['start'], undefined, DAEMON_START_TIMEOUT_MS)

    // Handle launchctl EALREADY (exit code = 1, stderr contains "EALREADY" or
    // "already bootstrapped"): the daemon is already loaded by a concurrent
    // process — treat as success.
    if (result.code === 1 && (result.stderr.includes('EALREADY') || result.stderr.includes('already bootstrapped'))) {
      console.log('[jerico-desktop] start returned EALREADY — daemon already loaded, treating as success')
      return { ...result, code: 0 }
    }

    // A foreign launchd registration (#577) is deliberately NOT folded into the
    // already-running case below, and deliberately NOT auto-repaired here.
    //
    // The daemon returns `foreign_registration_running` — an old install IS running
    // under our label, so `alreadyRunning` would have been tempting and is wrong:
    // this install is not the one launchd will keep launching, and `update` can
    // never succeed on such a machine. The repair (`bridge-agent restart`) unloads
    // the job and kills live PTY sessions, and doStart() runs on every app launch
    // and every tray Reconnect, so doing it from here would kill a user's agents
    // repeatedly without ever asking. It stays a failure with an intact reason
    // string; TrayController.handleReregister() offers it as an explicit action
    // (see utils/daemon-failure.ts for the reason-string contract).
    // Recognised through the anchored reason code, not a substring of the blob: the
    // daemon prints paths inside its detail strings, and one containing the word
    // (a `…/foreign_registration_archive/…` backup path, say) would otherwise
    // short-circuit the already-running handling below for an unrelated failure.
    if (result.code !== 0 && foreignRegistrationFault(result.stderr) !== null) {
      console.warn('[jerico-desktop] launchd holds a foreign registration for this label — surfacing the repair, not performing it')
      return result
    }

    // Exit 1 + stderr "already.running" OR exit 0 + stdout "already_running"
    // means daemon is already running — treat as success.
    const alreadyRunning =
      (result.code === 1 && result.stderr.includes('already.running')) ||
      (result.code === 0 && (
        result.stdout.includes('already_running') ||
        result.stdout.includes('daemon_predates_readiness_signal')
      ))
    if (alreadyRunning) {
      // Check if the running daemon matches the version bundled with this app.
      // After a desktop update the old launchd process keeps running stale code;
      // detect that and delegate restart to bridge-agent restart (Phase10).
      const expectedVersion = app.getVersion()
      const runningVersion = await pollVersion(this.port)
      if (runningVersion && runningVersion !== expectedVersion) {
        console.log(
          '[jerico-desktop] daemon version mismatch: %s != %s, delegating restart to bridge-agent',
          runningVersion,
          expectedVersion,
        )
        const restarted = await this.delegateRestart(expectedVersion, onProgress)
        if (restarted) {
          return { code: 0, stdout: 'daemon restarted (version mismatch)', stderr: '' }
        }
        // restart failed or version never matched — warn, but proceed.
        console.warn(
          '[jerico-desktop] daemon restart failed, running stale version %s (expected %s)',
          runningVersion,
          expectedVersion,
        )
      }
      return { ...result, code: 0 }
    }
    return result
  }

  /** The user asked for the registration to be replaced. Same command the
   *  version-skew path delegates to; the difference is who decided. */
  reregister(onProgress?: LifecycleProgressCallback): Promise<SpawnResult> {
    return this.runRestartCommand(onProgress)
  }

  stop(): Promise<SpawnResult> {
    return spawnBridgeAgent(['stop'], undefined, DAEMON_STOP_TIMEOUT_MS)
  }

  shutdownForQuit(): Promise<SpawnResult> {
    return spawnBridgeAgent(['stop', '--unload', '--purge'], undefined, DAEMON_UNLOAD_STOP_TIMEOUT_MS)
  }

  uninstall(): Promise<SpawnResult> {
    let profileCount = 0
    try {
      profileCount = fs.readdirSync(path.join(os.homedir(), '.jerico', 'profiles'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9-]+$/.test(entry.name))
        .length
    } catch { /* no profiles directory means zero named Keychain entries */ }
    return spawnBridgeAgent(['uninstall', '--force'], undefined, daemonUninstallTimeoutMs(profileCount))
  }

  async status(): Promise<DaemonState> {
    const { state } = await pollOnce(this.port)
    if (state === 'red') return 'not-running'
    if (state === 'green') return 'running-connected'
    return 'running-disconnected'
  }

  async isInstalled(): Promise<boolean> {
    const p = this.plistPath()
    if (!fs.existsSync(p)) return false
    // Existence alone made the gate report a green tick for a zero-length file,
    // for XML garbage, and for a plist naming a program that is not there. The
    // gate's whole job is telling the user the truth about their machine, so a
    // check that cannot fail is worse than no check. Cheap sanity only — the
    // daemon rewrites this file on every start, so a corrupt one self-heals;
    // what matters is not claiming it is fine in the meantime.
    try {
      const raw = fs.readFileSync(p, 'utf-8')
      return raw.includes('<plist') && raw.includes('ProgramArguments')
    } catch {
      return false
    }
  }

  logsPath(): { out: string; err: string; lifecycle: string } {
    const profile = process.env['BRIDGE_PROFILE']
    const suffix = profile ? `-${profile}` : ''
    return {
      out: path.join(os.homedir(), `bridge-daemon${suffix}.log`),
      err: path.join(os.homedir(), `bridge-daemon${suffix}.err.log`),
      lifecycle: path.join(os.homedir(), `bridge-daemon${suffix}.lifecycle.log`),
    }
  }

  /**
   * Phase10: Delegate restart to bridge-agent CLI instead of direct launchctl.
   * The desktop app never touches launchctl directly — bridge-agent restart
   * handles stop + port-free wait + start + version verification internally.
   */
  /** `bridge-agent restart`, with its stdout mapped onto the app's progress
   *  vocabulary. Shared by the version-skew delegation below and by the
   *  user-invoked reregister() above, so both report progress identically. */
  private runRestartCommand(onProgress?: LifecycleProgressCallback): Promise<SpawnResult> {
    onProgress?.({ stage: 'stopping', message: 'Stopping the old daemon…' })
    return spawnBridgeAgent(
      ['restart'],
      undefined,
      DAEMON_RESTART_TIMEOUT_MS,
      (line) => {
        if (line.includes('restart.port_free')) {
          onProgress?.({ stage: 'starting', message: 'Starting the replacement daemon…' })
        } else if (line.includes('start.waiting_launchd')) {
          onProgress?.({ stage: 'waiting_for_launchd', message: 'Waiting for launchd readiness…' })
        }
      },
    )
  }

  private async delegateRestart(
    expectedVersion: string,
    onProgress?: LifecycleProgressCallback,
  ): Promise<boolean> {
    try {
      const result = await this.runRestartCommand(onProgress)
      if (result.code !== 0) {
        console.warn('[jerico-desktop] bridge-agent restart failed (code %d): %s',
          result.code, result.stderr.trim())
        return false
      }
      console.log('[jerico-desktop] bridge-agent restart ok')
      return true
    } catch (err) {
      console.warn('[jerico-desktop] bridge-agent restart error:', String(err))
      return false
    }
  }

  private plistPath(): string {
    const profile = process.env['BRIDGE_PROFILE']
    const name = profile
      ? `com.jerico.bridge-agent.${profile}.plist`
      : 'com.jerico.bridge-agent.plist'
    return path.join(LAUNCH_AGENTS, name)
  }

  /**
   * DEPRECATED — superseded by delegateRestart() in Phase10.
   * Kept as dead code intentionally until Phase10 is fully validated.
   */
  /*
  private async restartAndAwaitVersion(expectedVersion: string): Promise<boolean> {
    // ... removed — desktop no longer calls launchctl directly
  }
  */
}
