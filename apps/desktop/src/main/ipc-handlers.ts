import { ipcMain, shell, app } from 'electron'
import * as https from 'node:https'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { consentSatisfied, CURRENT_CONSENT_VERSION } from '@jerico/shared'
import { isSetupComplete } from './setup-check.js'
import { getPlatformLifecycle } from './lifecycle/factory.js'
import { pollOnce, pollVersion } from './utils/health.js'

/** A refresh reads up to five providers over the network, one of which may raise a
 *  Keychain prompt the user has to answer. Generous on purpose. */
const USAGE_REFRESH_TIMEOUT_MS = 30_000
import type { HealthUsage } from './utils/health-classify.js'
import {
  DAEMON_AUTH_TIMEOUT_MS,
  DAEMON_HEAL_KEYCHAIN_TIMEOUT_MS,
  DAEMON_PROBE_KEYCHAIN_TIMEOUT_MS,
  spawnBridgeAgent,
} from './utils/spawn.js'
import {
  getConfigPath,
  getHealthPort,
  getLockPath,
  getServerConfig,
  getAuthFailedFlagPath,
  getPlistName,
  getProfileName,
} from './utils/profile.js'
import { preferredFailureLine, foreignRegistrationFault } from './utils/daemon-failure.js'
import type { WizardController } from './wizard.js'

const LEGACY_CONFIG_PATH = path.join(os.homedir(), '.bridge', 'config.json')

/** Host of a ws(s)://…/ws/daemon URL, for display. The full URL is noise in a
 *  520pt column and the host is the part that answers "which server". */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** What the Finish screen states about this machine. Every field is read at
 *  call time from the same sources the daemon uses, so the screen cannot claim
 *  a service is installed when the plist is not there. */
function connectionSummary(): { machine: string; server: string; serviceInstalled: boolean } {
  let machine = os.hostname().replace(/\.local$/, '')
  try {
    const settingsPath = getConfigPath()
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      if (typeof raw['name'] === 'string' && raw['name']) machine = raw['name']
    }
  } catch {
    // Unreadable settings — the hostname is a truthful fallback.
  }
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', getPlistName())
  let server = 'Configuration required'
  try { server = hostOf(getServerConfig().wsUrl) } catch { /* surfaced on endpoint-specific screens */ }
  return {
    machine,
    server,
    serviceInstalled: fs.existsSync(plistPath),
  }
}

// Phase B fix (#10): guard that prevents setup:complete / startTray from
// running before the permission gate has passed.  Set from index.ts after
// runPermissionGate() succeeds, and from permissions:gate-complete on re-check.
let _gatePassed = false
export function setGatePassed(v: boolean): void { _gatePassed = v }

/** Why a token check failed, so the screen can say something true. Collapsing
 *  every outcome to "Token validation failed" told a user with a flaky network
 *  that their token was bad, which sends them off regenerating tokens that were
 *  fine. */
type ValidateOutcome =
  | { ok: true }
  | { ok: false; reason: 'configuration' | 'rejected' | 'server-error' | 'unreachable' | 'timeout'; detail?: string }

const VALIDATE_TIMEOUT_MS = 8000

function validateTokenHttp(token: string): Promise<ValidateOutcome> {
  let cfg
  try {
    cfg = getServerConfig()
  } catch (err) {
    return Promise.resolve({ ok: false, reason: 'configuration', detail: String(err instanceof Error ? err.message : err) })
  }
  const client = cfg.validateSecure ? https : http
  return new Promise((resolve) => {
    let settled = false
    const done = (r: ValidateOutcome): void => { if (!settled) { settled = true; resolve(r) } }

    const req = client.request(
      {
        hostname: cfg.validateHost,
        port: cfg.validatePort,
        path: '/api/tokens/validate',
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        // The health poll has always had a timeout; this one did not, so a
        // server that accepted the connection and never answered left the Auth
        // step frozen for ~15s on an OS default before saying the wrong thing.
        timeout: VALIDATE_TIMEOUT_MS,
      },
      (res) => {
        res.resume()
        const code = res.statusCode ?? 0
        if (code === 200) return done({ ok: true })
        if (code === 401 || code === 403) return done({ ok: false, reason: 'rejected' })
        done({ ok: false, reason: 'server-error', detail: String(code) })
      },
    )
    req.on('timeout', () => { req.destroy(); done({ ok: false, reason: 'timeout' }) })
    req.on('error', (err: Error) => { done({ ok: false, reason: 'unreachable', detail: err.message }) })
    req.end()
  })
}

function validateMessage(r: Extract<ValidateOutcome, { ok: false }>): string {
  switch (r.reason) {
    case 'configuration':
      return r.detail ?? 'This profile has no valid server configuration.'
    case 'rejected':
      return 'The server did not accept this token. Generate a new one and paste it here.'
    case 'server-error':
      return `The server answered with an error (${r.detail ?? 'unknown'}). This is not your token — try again shortly.`
    case 'timeout':
      return 'The server did not answer in time. Check your connection and try again.'
    case 'unreachable':
      return 'Could not reach the server. Check your connection and try again.'
  }
}

/** Write a settings file the way a reader can survive.
 *
 *  Every writer here used plain writeFileSync, which truncates and then fills.
 *  The desktop and the daemon both target the same profile-scoped path, so a
 *  reader between those two steps sees a truncated file: a chaos run measured
 *  torn JSON on 6000 of 6000 reads under contention. Nothing crashed, because
 *  every reader fails closed — but "fails closed" for isSetupComplete() means
 *  "not set up", which is how a wizard flashes in front of someone who is.
 *
 *  Write to a temp file in the same directory, then rename. rename(2) is atomic
 *  within a filesystem, so a reader sees either the old file or the new one. */
function writeSettingsAtomic(configPath: string, data: unknown): void {
  const tmp = `${configPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, configPath)
}

function ensureJericoDir(): void {
  const dir = path.dirname(getConfigPath())
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function registerIpcHandlers(wizard: WizardController, onSetupComplete?: () => void): void {
  /** Writes settings.json with everything EXCEPT the token. The token lives in
   *  the Keychain and nowhere else; anything that merges an existing file has
   *  to actively drop a `token` key a previous version may have left behind,
   *  or the leak survives the fix. */
  function writeSettingsWithoutToken(name?: string): void {
    ensureJericoDir()
    let existing: Record<string, unknown> = {}
    try {
      existing = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
    } catch { /* first run or malformed — start fresh */ }
    delete existing['token']
    const settings = {
      ...existing,
      name: name ?? (typeof existing['name'] === 'string' ? existing['name'] : os.hostname()),
    }
    writeSettingsAtomic(getConfigPath(), settings)
  }

  ipcMain.handle('setup:check', (): { complete: boolean } => ({
    complete: isSetupComplete(),
  }))

  ipcMain.handle('setup:connection-summary', () => connectionSummary())

  ipcMain.handle('server:endpoints', (): {
    ok: boolean
    wsUrl?: string
    connectPageUrl?: string
    connectPageLabel?: string
    error?: string
  } => {
    try {
      const cfg = getServerConfig()
      const connect = new URL(cfg.connectPageUrl)
      return {
        ok: true,
        wsUrl: cfg.wsUrl,
        connectPageUrl: cfg.connectPageUrl,
        connectPageLabel: `${connect.host}${connect.pathname}`,
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'This profile has no valid server configuration.',
      }
    }
  })

  /** Everything the Manage window states about this installation, read at call
   *  time from the same sources the daemon uses. Assembled in one place because
   *  the alternative — six round trips from the renderer — makes a screen whose
   *  whole job is telling the truth arrive in pieces, each capable of being
   *  stale relative to the others. */
  ipcMain.handle('manage:summary', async () => {
    const base = connectionSummary()
    const health = await pollOnce(getHealthPort()).catch(() => null)
    const version = await pollVersion(getHealthPort()).catch(() => null)

    let claudeTier = 'pro'
    try {
      const raw = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
      if (typeof raw['claudeTier'] === 'string') claudeTier = raw['claudeTier']
    } catch { /* absent or unreadable — the default is the documented one */ }

    return {
      ...base,
      appVersion: app.getVersion(),
      arch: process.arch,
      // Only true in a packaged build; `pnpm dev` is never signed.
      signed: app.isPackaged,
      daemonVersion: version,
      daemonRunning: health?.state === 'green',
      activePanels: health?.activePanels ?? 0,
      documentsFolderReadable: health?.documentsFolderReadable ?? null,
      claudeTier,
      // Stated rather than implied: the token's home is the one claim this app
      // makes about security, and Manage is where a suspicious user checks it.
      tokenStore: process.platform === 'darwin'
        ? 'macOS Keychain · com.jerico.bridge-agent'
        : getConfigPath().replace(os.homedir(), '~'),
    }
  })

  /**
   * The agent usage window's data.
   *
   * Polls the daemon rather than reading a cached copy from the tray: the window
   * can be open while the tray is not pushing, and a detail surface that shows a
   * different number from the register it was opened from is worse than a slow
   * one. `usage: null` from the daemon means it does not report limits at all —
   * distinct from an empty array, which means it does and has nothing yet.
   */
  /**
   * Ask the daemon to re-read every provider NOW, then return the fresh reading.
   *
   * This is the ONLY path that can produce a Keychain-backed reading: the daemon's
   * scheduled cycle refuses to touch the Keychain because it must not raise a system
   * prompt on its own schedule. Opening the usage view or pressing its refresh is
   * the user action that earns the prompt.
   *
   * Before this existed, the refresh button re-read a five-minute-old cache and
   * `refreshUsageNow()` had zero call sites — a button labelled refresh that
   * refreshed nothing.
   */
  ipcMain.handle('usage:refresh', async (): Promise<{
    usage: HealthUsage[] | null
    daemonReachable: boolean
    foreign?: boolean
  }> => {
    // Token-gated, exactly like the reconnect route: the token is the 0600
    // shutdownToken the daemon mints in its own lock file, and this endpoint is
    // gated because an interactive refresh may raise a Keychain prompt.
    let token = ''
    try {
      const raw = fs.readFileSync(getLockPath(), 'utf-8')
      token = (JSON.parse(raw) as { shutdownToken?: string }).shutdownToken ?? ''
    } catch {
      token = ''
    }
    if (token !== '') {
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: getHealthPort(),
            path: `/usage/refresh?token=${encodeURIComponent(token)}`,
            method: 'POST',
            timeout: USAGE_REFRESH_TIMEOUT_MS,
          },
          (res) => { res.resume(); res.on('end', resolve) },
        )
        // A refresh that cannot be asked for is not an error worth surfacing: the
        // poll below still returns the cached reading, which is what the caller
        // wanted anyway.
        req.on('error', () => resolve())
        req.on('timeout', () => { req.destroy(); resolve() })
        req.end()
      })
    }
    const result = await pollOnce(getHealthPort())
    // A foreign profile answered: its numbers belong to somebody else and must not
    // be drawn, but saying "the daemon is not running" for it is a different and
    // wrong sentence — something IS running, it just is not ours.
    if (result.foreign === true) return { usage: null, daemonReachable: true, foreign: true }
    return { usage: result.usage, daemonReachable: result.state !== 'red' }
  })

  ipcMain.handle('usage:detail', async (): Promise<{
    usage: HealthUsage[] | null
    daemonReachable: boolean
    foreign?: boolean
  }> => {
    const result = await pollOnce(getHealthPort())
    // A foreign profile's numbers are somebody else's; classifyHealth already
    // blanks them, and this must not paper over that with an empty array.
    if (result.foreign === true) return { usage: null, daemonReachable: true, foreign: true }
    return { usage: result.usage, daemonReachable: result.state !== 'red' }
  })

  ipcMain.handle('manage:set-claude-tier', (_event, tier: string): { ok: boolean } => {
    const allowed = new Set(['free', 'pro', 'max_5x', 'max_20x'])
    if (!allowed.has(tier)) return { ok: false }
    try {
      ensureJericoDir()
      let existing: Record<string, unknown> = {}
      try {
        existing = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
      } catch { /* first run */ }
      delete existing['token']
      writeSettingsAtomic(getConfigPath(), { ...existing, claudeTier: tier })
      return { ok: true }
    } catch (err) {
      console.warn('[jerico-desktop] could not write claudeTier', err)
      return { ok: false }
    }
  })

  ipcMain.handle('setup:complete', async (): Promise<void> => {
    // Re-run the permission gate to defend against TOCTOU: grants may have
    // been revoked between the initial gate pass and setup completion.
    const { runPermissionGate } = await import('./permission-gate.js')
    const recheck = await runPermissionGate()
    if (!recheck.passed) {
      console.warn('[jerico-desktop] setup:complete blocked — permission gate re-check failed', recheck.status)
      return
    }
    wizard.close()
    onSetupComplete?.()
  })

  ipcMain.handle('system:open-external', async (_event, url: string): Promise<void> => {
    await shell.openExternal(url)
  })

  ipcMain.handle('system:get-logs-path', (): { out: string; err: string } => {
    const lifecycle = getPlatformLifecycle(getHealthPort())
    return lifecycle.logsPath()
  })

  // Auth
  ipcMain.handle('auth:open-url', async (): Promise<void> => {
    try {
      await shell.openExternal(getServerConfig().connectPageUrl)
    } catch (err) {
      console.warn('[jerico-desktop] auth URL blocked by endpoint configuration', err)
    }
  })

  ipcMain.handle(
    'auth:validate-token',
    async (_event, token: string): Promise<{ ok: boolean; error?: string }> => {
      const r = await validateTokenHttp(token)
      return r.ok ? { ok: true } : { ok: false, error: validateMessage(r) }
    },
  )

  ipcMain.handle(
    'auth:save',
    async (_event, token: string): Promise<{ ok: boolean; error?: string }> => {
      let authServerUrl: string
      try {
        authServerUrl = getServerConfig().authServerUrl
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'This profile has no valid server configuration.',
        }
      }
      // Phase B fix (A): pass token via BRIDGE_AUTH_TOKEN env var, NOT argv,
      // so it's not visible to other local processes via ps(1).
      // Daemon's runAuth() reads + deletes the env var before use.
      const spawned = await spawnBridgeAgent(
        [
          'auth', '--server', authServerUrl,
          '--daemon-server', getServerConfig().wsUrl,
          '--connect-page', getServerConfig().connectPageUrl,
          '--no-browser',
        ],
        // The screen promised the Keychain, so the daemon must not fall back to
      // a plaintext file and report success (#556, daemon half).
      { BRIDGE_AUTH_TOKEN: token, BRIDGE_REQUIRE_KEYCHAIN: '1' },
      DAEMON_AUTH_TIMEOUT_MS,
      )

      if (spawned.code !== 0) {
        // #556. This used to fall back to fs.writeFileSync(settings.json) with
        // the token in it. The Auth screen tells the user "stored in your macOS
        // Keychain — not in a file on disk", and a fallback that quietly does
        // the opposite turns that sentence into a lie on exactly the machines
        // where the Keychain is the thing going wrong. There is no silent
        // fallback now: the write does not happen and the user is told.
        console.warn('[jerico-desktop] auth helper failed:', spawned.stderr.trim())
        return {
          ok: false,
          error:
            spawned.stderr.trim() ||
            'The authentication helper failed before the token could be stored.',
        }
      }

      console.log('[jerico-desktop] auth:save routed through daemon setToken via BRIDGE_AUTH_TOKEN')
      writeSettingsWithoutToken()
      try { fs.unlinkSync(getAuthFailedFlagPath()) } catch { /* absent is normal */ }
      return { ok: true }
    },
  )

  // Config migration
  ipcMain.handle(
    'config:detect-legacy',
    // configPath and server are returned so the screen can show WHAT it found
    // rather than asserting that it found something. A migration step that says
    // "carried over" with nothing to point at is unauditable by the person
    // whose credentials are being moved.
    async (): Promise<{
      found: boolean
      tokenValid?: boolean
      configPath?: string
      server?: string
    }> => {
      // The legacy file predates profiles and belongs only to unnamed prod.
      // Reading it under a named profile crosses both credential and endpoint
      // boundaries, even if validation is later rejected.
      try {
        if (getProfileName() !== null) return { found: false }
      } catch {
        return { found: false }
      }
      if (!fs.existsSync(LEGACY_CONFIG_PATH)) return { found: false }
      try {
        const raw = JSON.parse(
          fs.readFileSync(LEGACY_CONFIG_PATH, 'utf-8'),
        ) as Record<string, unknown>
        if (typeof raw['server'] !== 'string' || typeof raw['token'] !== 'string') {
          return { found: false }
        }
        return {
          found: true,
          configPath: LEGACY_CONFIG_PATH.replace(os.homedir(), '~'),
          server: hostOf(raw['server']),
        }
      } catch {
        return { found: false }
      }
    },
  )

  ipcMain.handle(
    'config:migrate-legacy',
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        if (getProfileName() !== null) {
          return { ok: false, error: 'Global legacy configuration is available only to the unnamed profile.' }
        }
      } catch {
        return { ok: false, error: 'The active profile name is invalid.' }
      }
      // #556. Migration used to copy the legacy token straight into
      // settings.json in plaintext — and this is the ORDINARY upgrade path for
      // anyone who used the CLI first, so it was the more common of the two
      // leaks, not the edge case. The token now goes where every other token
      // goes: through the daemon, into the Keychain.
      // Its sibling detect-legacy is wrapped and this was not, so a file that
      // vanished or was truncated between the two calls — an ordinary TOCTOU —
      // sent a raw ENOENT or SyntaxError to the renderer instead of a sentence.
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, 'utf-8')) as Record<string, unknown>
      } catch {
        return { ok: false, error: 'The existing configuration could not be read. Sign in with a new token instead.' }
      }
      const token = typeof raw['token'] === 'string' ? raw['token'] : ''
      const name = typeof raw['name'] === 'string' ? raw['name'] : os.hostname()
      if (!token) return { ok: false, error: 'The existing config has no token to carry over.' }

      let authServerUrl: string
      try {
        authServerUrl = getServerConfig().authServerUrl
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'This profile has no valid server configuration.',
        }
      }

      const spawned = await spawnBridgeAgent(
        [
          'auth', '--server', authServerUrl,
          '--daemon-server', getServerConfig().wsUrl,
          '--connect-page', getServerConfig().connectPageUrl,
          '--no-browser',
        ],
        // The screen promised the Keychain, so the daemon must not fall back to
      // a plaintext file and report success (#556, daemon half).
      { BRIDGE_AUTH_TOKEN: token, BRIDGE_REQUIRE_KEYCHAIN: '1' },
      DAEMON_AUTH_TIMEOUT_MS,
      )
      if (spawned.code !== 0) {
        console.warn('[jerico-desktop] migrate auth helper failed:', spawned.stderr.trim())
        return {
          ok: false,
          error:
            spawned.stderr.trim() ||
            'The authentication helper failed before the carried-over token could be stored.',
        }
      }

      writeSettingsWithoutToken(name)
      return { ok: true }
    },
  )

  // Permissions
  ipcMain.handle('permissions:open-fda', async (): Promise<void> => {
    // Darwin 22 = macOS 13 (Ventura); prior versions use the AllFilesAccess pane key
    const darwinMajor = parseInt(os.release().split('.')[0] ?? '0', 10)
    const url =
      darwinMajor >= 22
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
        : 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFilesAccess'
    await shell.openExternal(url)
  })

  ipcMain.handle('permissions:probe-and-open-fda', async (): Promise<void> => {
    // Spawn bridge-agent probe-fda: the access attempt causes macOS to add the binary
    // to the FDA list (toggled off) so the user can find and enable it without hunting.
    await spawnBridgeAgent(['probe-fda'])
    // Give TCC a moment to register the entry before System Settings opens.
    await new Promise<void>((r) => setTimeout(r, 1500))
    const darwinMajor = parseInt(os.release().split('.')[0] ?? '0', 10)
    const url =
      darwinMajor >= 22
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
        : 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFilesAccess'
    await shell.openExternal(url)
  })

  ipcMain.handle('permissions:reveal-bridge-agent', async (): Promise<void> => {
    const bridgePath = app.isPackaged
      ? path.join(process.resourcesPath, 'bridge-agent')
      : path.join(app.getAppPath(), '..', '..', 'packages', 'daemon', 'dist')
    shell.showItemInFolder(path.resolve(bridgePath))
  })

  ipcMain.handle('permissions:check-documents-access', async (): Promise<{ readable: boolean }> => {
    // Query the launchd-managed daemon's Documents-service observation. A
    // child-spawn from Electron has a different TCC context and is not evidence
    // about the already-running daemon. This is not a Full Disk Access verdict.
    try {
      const healthPort = getHealthPort()
      const { pollOnce } = await import('./utils/health.js')
      const health = await pollOnce(healthPort, { freshProbe: true })
      if (health.state !== 'red') {
        return { readable: !!health.documentsFolderReadable }
      }
    } catch {
      // Daemon unreachable — fall through to unknown
    }
    // Daemon is down — unknown must not be rendered as a successful read.
    return { readable: false }
  })

  ipcMain.handle(
    'permissions:set-login-item',
    (_event, enabled: boolean): { didStick: boolean } => {
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
      const actual = app.getLoginItemSettings().openAtLogin
      return { didStick: actual === enabled }
    },
  )

  ipcMain.handle('permissions:get-login-item', (): boolean => {
    return app.getLoginItemSettings().openAtLogin
  })

  // Phase B: permission gate IPC
  ipcMain.handle('permissions:check', async (): Promise<{
    passed: boolean
    keychain: boolean
    launchAgent: boolean
    bridgeDir: boolean
    jericoDir: boolean
  }> => {
    const { runPermissionGate } = await import('./permission-gate.js')
    const result = await runPermissionGate()
    return { passed: result.passed, ...result.status }
  })

  ipcMain.handle('permissions:gate-complete', async (): Promise<{ ok: boolean }> => {
    // Re-check the gate. If passed, resume the normal startup flow:
    //   if !isSetupComplete() → wizard.show() (user continues in wizard)
    //   else → onSetupComplete (startTray)
    const { runPermissionGate } = await import('./permission-gate.js')
    const result = await runPermissionGate()
    if (result.passed) {
      _gatePassed = true
      wizard.close()
      if (!isSetupComplete()) {
        wizard.show()
      } else {
        onSetupComplete?.()
      }
      return { ok: true }
    }
    console.warn('[jerico-desktop] gate-complete: still blocked', result.status)
    return { ok: false }
  })

  ipcMain.handle('permissions:install-launchagent', async (): Promise<{ ok: boolean; error?: string }> => {
    const healthPort = getHealthPort()
    const lifecycle = getPlatformLifecycle(healthPort)
    const result = await lifecycle.install()
    if (result.code !== 0) {
      const errLog = lifecycle.logsPath().err
      try {
        const tail = fs.readFileSync(errLog, 'utf8').slice(-4096)
        if (tail.includes('Config not found') || tail.includes('Config missing server or token') || tail.includes('token missing at startup')) {
          return { ok: false, error: 'Sign-in required — please re-authenticate' }
        }
      } catch { /* ignore log read failures */ }
      const fault = foreignRegistrationFault(result.stderr)
      if (fault) {
        // The first-run wizard's highest-stakes screen. `install-service` cannot
        // repair this — launchd will not re-read the plist file of a bootstrapped
        // label — so the honest answer names the repair and where to run it, rather
        // than dropping the daemon's path-bearing diagnostic into a checklist row.
        return {
          ok: false,
          error: `${fault.message} Use “Re-register login service” in the jerico menu bar icon, `
            + 'or run `bridge-agent restart` in a terminal.',
        }
      }
      // The daemon prints its humanised sentence first and the machine reason
      // second (install-service.failed / install-service.failed.detail); show the
      // sentence rather than whichever line happens to be last.
      return { ok: false, error: preferredFailureLine(result.stderr) ?? `exit code ${String(result.code)}` }
    }
    return { ok: true }
  })

  ipcMain.handle('permissions:heal-keychain', async (): Promise<{ ok: boolean; error?: string }> => {
    // Step 1: run probe to trigger macOS consent dialog for the test entry
    const probeResult = await spawnBridgeAgent(
      ['probe-keychain'],
      undefined,
      DAEMON_PROBE_KEYCHAIN_TIMEOUT_MS,
    )
    if (probeResult.code !== 0) {
      console.log(JSON.stringify({ ts: Date.now(), level: 'error', event: 'permissions.heal_keychain_probe_failed', stderr: probeResult.stderr.trim() }))
      return { ok: false, error: probeResult.stderr.trim() || 'Keychain probe failed — did you click Always Allow?' }
    }

    // Step 2: run daemon-side heal-keychain which reads the token from
    // Keychain (or _staging_ recovery) and re-applies -T ACL via setToken().
    const healResult = await spawnBridgeAgent(
      ['heal-keychain'],
      undefined,
      DAEMON_HEAL_KEYCHAIN_TIMEOUT_MS,
    )
    if (healResult.code !== 0) {
      const reason = healResult.code === 3
        ? 'No token found — complete setup first to create a token, then heal.'
        : healResult.stderr.trim() || `heal-keychain failed (exit ${String(healResult.code)})`
      console.log(JSON.stringify({ ts: Date.now(), level: 'error', event: 'permissions.heal_keychain_failed', exitCode: healResult.code, stderr: healResult.stderr.trim() }))
      return { ok: false, error: reason }
    }

    console.log(JSON.stringify({ ts: Date.now(), level: 'info', event: 'permissions.heal_keychain_ok' }))
    return { ok: true }
  })

  // Daemon
  ipcMain.handle(
    'daemon:install',
    async (): Promise<{ ok: boolean; error?: string }> => {
      const healthPort = getHealthPort()
      const lifecycle = getPlatformLifecycle(healthPort)
      const result = await lifecycle.install()
      if (result.code !== 0) {
        return { ok: false, error: result.stderr.trim() || `exit code ${String(result.code)}` }
      }
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        const health = await pollOnce(healthPort)
        if (health.state !== 'red') return { ok: true }
        await new Promise<void>((r) => setTimeout(r, 500))
      }
      return { ok: false, error: 'Daemon did not become healthy within 8s' }
    },
  )

  ipcMain.handle(
    'daemon:run-now',
    async (): Promise<{ ok: boolean; error?: string }> => {
      const healthPort = getHealthPort()
      const lifecycle = getPlatformLifecycle(healthPort)
      const result = await lifecycle.start()
      if (result.code !== 0) {
        return { ok: false, error: result.stderr.trim() || `exit code ${String(result.code)}` }
      }
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        const health = await pollOnce(healthPort)
        if (health.state !== 'red') return { ok: true }
        await new Promise<void>((r) => setTimeout(r, 500))
      }
      return { ok: false, error: 'Daemon did not become healthy within 8s' }
    },
  )

  ipcMain.handle(
    'daemon:uninstall',
    async (): Promise<{ ok: boolean; error?: string }> => {
      const lifecycle = getPlatformLifecycle(getHealthPort())
      const result = await lifecycle.uninstall()
      if (result.code !== 0) {
        return { ok: false, error: result.stderr.trim() || `exit code ${String(result.code)}` }
      }
      return { ok: true }
    },
  )

  ipcMain.handle('bridge:get-consent-status', (): { consented: boolean } => {
    try {
      const configPath = getConfigPath()
      if (!fs.existsSync(configPath)) return { consented: false }
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
      return { consented: consentSatisfied(raw['consentVersion'], CURRENT_CONSENT_VERSION) }
    } catch {
      return { consented: false }
    }
  })

  // TODO(#403): route through mergeSettings() so other config fields are preserved atomically
  ipcMain.handle('bridge:record-consent', (): { ok: boolean } => {
    try {
      const configPath = getConfigPath()
      let existing: Record<string, unknown> = {}
      if (fs.existsSync(configPath)) {
        try {
          existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
        } catch {
          existing = {}
        }
      }
      // #556 cleanup. Merging `existing` forward preserves whatever is already
      // in the file — including a plaintext token a previous version wrote.
      // Every write of this file now actively drops it, so the leak does not
      // survive an upgrade on machines that already have one.
      delete existing['token']
      const updated = { ...existing, consentVersion: CURRENT_CONSENT_VERSION }
      writeSettingsAtomic(configPath, updated)
      console.log('[bridge] consent.accepted', { version: CURRENT_CONSENT_VERSION })
      return { ok: true }
    } catch (err) {
      console.error('[bridge] consent.record.failed', String(err))
      return { ok: false }
    }
  })


  ipcMain.handle('app:quit', (): void => {
    console.log('[bridge] app.quit — requested via renderer')
    app.quit()
  })
}
