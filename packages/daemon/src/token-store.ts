/**
 * token-store.ts — macOS Keychain token storage for bridge-agent daemon.
 *
 * On macOS (darwin), the auth token is stored in the login Keychain via the
 * /usr/bin/security CLI. On other platforms (Linux), the token is kept in the
 * settings.json file (mode 0o600) as before.
 *
 * Keychain entry scheme:
 *   Service: "com.jerico.bridge-agent" (constant)
 *   Account:  profile name, or "default" for the no-profile (prod) case
 *
 * Migration invariant: write to Keychain FIRST, verify readback, ONLY THEN
 * strip from file. If Keychain write fails, the file token is preserved.
 */

import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { getConfigPath, getKeychainAccount, getAllProfileNames } from './profile.js'

const SERVICE = 'com.jerico.bridge-agent'
const SECURITY_BIN = '/usr/bin/security'
const DEFAULT_KEYCHAIN_OPERATION_TIMEOUT_MS = 10_000

/** The desktop forwards the same per-operation bound used in its parent
 * contract. Standalone CLI callers may lower it for diagnostics, but cannot
 * extend one security invocation beyond the declared production ceiling. */
function keychainOperationTimeoutMs(): number {
  const configured = Number(process.env['BRIDGE_KEYCHAIN_OPERATION_TIMEOUT_MS'])
  return Number.isFinite(configured) && configured >= 50 && configured <= DEFAULT_KEYCHAIN_OPERATION_TIMEOUT_MS
    ? configured
    : DEFAULT_KEYCHAIN_OPERATION_TIMEOUT_MS
}

export interface TokenResult {
  found: boolean
  token: string | null
  source: 'keychain' | 'file' | 'none'
}

// ── platform guard ──────────────────────────────────────────────────────────

function isDarwin(): boolean {
  return process.platform === 'darwin'
}

/**
 * The disposable scheduled-duty harness deliberately has no macOS Keychain.
 * Its nonce HOME is deleted at teardown, so its token may live only in that
 * 0600 settings file.  Requiring both markers keeps this unavailable to every
 * normal CLI, desktop, launchd, dev, and production invocation.
 */
function useIsolatedHarnessFileStore(): boolean {
  return process.env['JERICO_ISOLATED_HARNESS'] === '1'
    && process.env['JERICO_HARNESS_FILE_TOKEN_STORE'] === '1'
}

// ── structured logging ──────────────────────────────────────────────────────

function logEvent(event: string, extra?: Record<string, unknown>): void {
  const profile = process.env['BRIDGE_PROFILE'] || 'default'
  const level =
    event.includes('_failed') || event.includes('critic') || event.includes('verify_failed')
      ? 'error'
      : event.includes('missing') || event.includes('locked')
        ? 'warn'
        : 'info'
  console.log(
    JSON.stringify({
      ts: Date.now(),
      level,
      event: `token_store.${event}`,
      profile,
      ...extra,
    }),
  )
}

// ── keychain helpers (darwin only) ──────────────────────────────────────────

function runSecurity(args: string[], input?: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(SECURITY_BIN, args, {
      input,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: keychainOperationTimeoutMs(),
    })
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 }
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; status?: number | null }
    const exitCode = e.status ?? 1
    const stderr = (typeof e.stderr === 'string' ? e.stderr : '') +
                   (typeof e.stdout === 'string' ? e.stdout : '')
    return { stdout: '', stderr: stderr.trim(), exitCode }
  }
}

function keychainRead(account: string): { found: true; token: string } | { found: false } {
  const { stdout, exitCode } = runSecurity([
    'find-generic-password',
    '-s', SERVICE,
    '-a', account,
    '-w',
  ])

  if (exitCode === 0 && stdout) {
    logEvent('keychain.read_ok')
    return { found: true, token: stdout }
  }

  if (exitCode === 44) {
    logEvent('keychain.missing')
    return { found: false }
  }

  logEvent('keychain.read_failed', { exitCode })
  return { found: false }
}

/**
 * Resolve the list of binary paths that should be trusted in the Keychain ACL.
 *
 * Reads `JERICO_TRUSTED_BINS` (colon-separated paths) injected by the desktop
 * app at spawn time.  When the env var is unset/empty (standalone CLI, dev),
 * falls back to `process.execPath` and the realpath of `process.argv[1]` so
 * the ACL still works without the desktop injector.
 *
 * Always includes `/usr/bin/security` as the baseline.  Invalid paths
 * (non-absolute or non-existent) are silently skipped.
 *
 * Env contract (set by desktop/utils/spawn.ts in Phase B):
 *   JERICO_TRUSTED_BINS=/Applications/Jerico.app/Contents/MacOS/Jerico:/path/to/bridge-agent
 */
function getTrustedBinPaths(): string[] {
  const bins = process.env['JERICO_TRUSTED_BINS'] || ''
  const envPaths = bins.split(':').filter(Boolean)

  const allPaths: string[] = [...envPaths]

  // When env is unset/empty (standalone CLI, dev mode), fall back to
  // process.execPath only (trusted binary path for Keychain ACL).
  // argv[1] is intentionally excluded — an attacker-influenced entry
  // script path should not be added to the ACL. The desktop always
  // injects JERICO_TRUSTED_BINS, so this fallback is dev-only.
  if (envPaths.length === 0) {
    allPaths.push(process.execPath)
  }

  // Validate: skip non-absolute or non-existent paths
  const trusted = allPaths.filter(p => {
    try { return path.isAbsolute(p) && fs.existsSync(p) } catch { return false }
  })

  if (!trusted.includes(SECURITY_BIN)) trusted.unshift(SECURITY_BIN)
  return trusted
}

function keychainWrite(account: string, token: string): boolean {
  // SAFETY: we NEVER delete the real account before proving we can re-create.
  // Instead, we write to a staging account first, verify readback (proves ACL
  // is functional), THEN delete the real account and create the real entry.
  // If any step fails, the real account is untouched — no data loss.
  // `security add-generic-password -U` does NOT update an existing item's ACL,
  // so delete+recreate is the only reliable way to apply fresh -T flags.
  const stagingAccount = `_staging_${account}`
  const trustedPaths = getTrustedBinPaths()

  // ── Step 1: delete any stale staging entry ──
  keychainDelete(stagingAccount)

  // ── Step 2: write token to staging account with -T flags ──
  const stagingArgs = [
    'add-generic-password',
    '-s', SERVICE,
    '-a', stagingAccount,
    '-w', token,
    ...trustedPaths.flatMap(p => ['-T', p]),
  ]
  const stagingResult = runSecurity(stagingArgs)
  if (stagingResult.exitCode !== 0) {
    logEvent('keychain.write_staging_failed', { exitCode: stagingResult.exitCode, stderr: stagingResult.stderr.slice(0, 200) })
    return false
  }

  // ── Step 3: verify staging readback (proves ACL is functional) ──
  const stagingRead = keychainRead(stagingAccount)
  if (!stagingRead.found || stagingRead.token !== token) {
    logEvent('keychain.write_staging_verify_failed')
    keychainDelete(stagingAccount)
    return false
  }

  // ── Step 4: delete the real account (safe — ACL is confirmed working) ──
  keychainDelete(account)

  // ── Step 5: create the real account with -T flags ──
  const realArgs = [
    'add-generic-password',
    '-s', SERVICE,
    '-a', account,
    '-w', token,
    ...trustedPaths.flatMap(p => ['-T', p]),
  ]
  const realResult = runSecurity(realArgs)
  if (realResult.exitCode !== 0) {
    logEvent('keychain.write_real_failed', { exitCode: realResult.exitCode, stderr: realResult.stderr.slice(0, 200) })
    // Staging entry still has the token — clean up and let caller fall back to file
    keychainDelete(stagingAccount)
    return false
  }

  // ── Step 6: clean up staging entry ──
  keychainDelete(stagingAccount)

  logEvent('keychain.write_ok')
  return true
}

function keychainDelete(account: string): void {
  const { exitCode, stderr } = runSecurity([
    'delete-generic-password',
    '-s', SERVICE,
    '-a', account,
  ])

  if (exitCode === 0) {
    logEvent('keychain.deleted')
    return
  }

  if (exitCode === 44) {
    // Already gone — idempotent
    logEvent('keychain.deleted')
    return
  }

  logEvent('keychain.delete_failed', { exitCode, stderr: stderr.slice(0, 200) })
}

// ── file fallback helpers ───────────────────────────────────────────────────

function readTokenFromFile(): string | null {
  const configPath = getConfigPath()
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8')
      const obj: unknown = JSON.parse(raw)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const token = (obj as Record<string, unknown>)['token']
        if (typeof token === 'string' && token) return token
      }
    }
  } catch {
    // fall through to legacy fallback
  }

  // F31b: prod-only legacy fallback to ~/.bridge/config.json so users whose
  // token lives only in the legacy file are not wrongly seen as unauthenticated.
  if (!process.env['BRIDGE_PROFILE']) {
    const legacyPath = path.join(homedir(), '.bridge', 'config.json')
    try {
      if (!fs.existsSync(legacyPath)) return null
      const raw = fs.readFileSync(legacyPath, 'utf-8')
      const obj: unknown = JSON.parse(raw)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const token = (obj as Record<string, unknown>)['token']
        if (typeof token === 'string' && token) {
          logEvent('legacy_token_read', { path: legacyPath })
          return token
        }
      }
    } catch {
      return null
    }
  }

  return null
}

function stripTokenFromFile(): void {
  const configPath = getConfigPath()
  try {
    if (!fs.existsSync(configPath)) return
    const raw = fs.readFileSync(configPath, 'utf-8')
    const obj: unknown = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const configObj = obj as Record<string, unknown>
      if ('token' in configObj) {
        delete configObj['token']
        fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2), { mode: 0o600 })
        logEvent('file.token_stripped')
      }
    }
  } catch {
    // Non-fatal — file may be locked or missing; keychain is source of truth
  }
}

function writeTokenToFile(token: string): void {
  const configPath = getConfigPath()
  const dir = path.dirname(configPath)
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  } catch { /* dir exists */ }

  let existing: Record<string, unknown> = {}
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    } catch { /* start fresh */ }
  }
  existing['token'] = token
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), { mode: 0o600 })
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Read-only probe: true if a token exists for the active profile.
 *
 * Does NOT migrate/strip from file or write to Keychain. Used in hot paths
 * such as `runDaemonServices` where we only need to know whether to enter
 * idle-alive mode and must not trigger a Keychain ACL write from a headless
 * launchd daemon.
 */
/** Does the Keychain itself hold a token? Distinct from hasToken(), which is
 *  true when EITHER store has one — the difference matters when deciding
 *  whether a copy in the settings file is redundant or is the only copy. */
export function keychainHasToken(): boolean {
  if (!isDarwin() || useIsolatedHarnessFileStore()) return false
  return keychainRead(getKeychainAccount()).found
}

export function hasToken(): boolean {
  if (isDarwin() && !useIsolatedHarnessFileStore()) {
    const account = getKeychainAccount()
    if (keychainRead(account).found) return true
    return readTokenFromFile() !== null
  }
  return readTokenFromFile() !== null
}

/**
 * Get the auth token. On macOS: Keychain first, then file (with migration).
 * On Linux: file only. Returns { found, token, source }.
 */
export function getToken(): TokenResult {
  if (isDarwin() && !useIsolatedHarnessFileStore()) {
    const account = getKeychainAccount()

    // 1. Try Keychain
    const kc = keychainRead(account)
    if (kc.found) {
      return { found: true, token: kc.token, source: 'keychain' }
    }

    // 2. Fall back to file (migration path)
    const fileToken = readTokenFromFile()
    if (fileToken) {
      // Migration: write to keychain, verify, then strip file
      const written = keychainWrite(account, fileToken)
      if (written) {
        // Verify readback
        const verify = keychainRead(account)
        if (verify.found && verify.token === fileToken) {
          stripTokenFromFile()
          logEvent('migrated', { from: 'file', to: 'keychain' })
          return { found: true, token: fileToken, source: 'keychain' }
        }
        // Readback mismatch — critical, keep file token
        logEvent('keychain.verify_failed', { error: 'token mismatch after write' })
        return { found: true, token: fileToken, source: 'file' }
      }
      // Keychain write failed — keep file token untouched, not lost
      logEvent('keychain.write_failed', { exitCode: -1, stderr: 'keychain write returned false' })
      return { found: true, token: fileToken, source: 'file' }
    }

    // 3. Self-heal: check _staging_${account} (crash mid-keychainWrite).
    // If found, promote to real entry + return it.
    const staging = keychainRead(`_staging_${account}`)
    if (staging.found) {
      logEvent('staging_recovery', { account })
      const promoted = keychainWrite(account, staging.token)
      if (promoted) {
        const verify = keychainRead(account)
        if (verify.found && verify.token === staging.token) {
          stripTokenFromFile()
          logEvent('staging_recovery.promoted')
          return { found: true, token: staging.token, source: 'keychain' }
        }
      }
      // Promotion failed — return staging token directly, next setToken
      // will clean up the staging entry via the 6-step pattern.
      logEvent('staging_recovery.direct_read')
      return { found: true, token: staging.token, source: 'keychain' }
    }

    // 4. No token anywhere
    return { found: false, token: null, source: 'none' }
  }

  // Non-darwin: file-only path
  const fileToken = readTokenFromFile()
  if (fileToken) {
    return { found: true, token: fileToken, source: 'file' }
  }
  return { found: false, token: null, source: 'none' }
}

/**
 * Set (or update) the auth token. On macOS: writes to Keychain, strips from
 * config file (only after verified write). On Linux: writes to config file.
 */
/** Where the token actually ended up. Callers need this: `auth` used to return
 *  0 whether the token reached the Keychain or a plaintext file, so the desktop
 *  app — which tells the user "stored in your macOS Keychain, not in a file on
 *  disk" — could not tell the difference and reported success either way. */
export type TokenStorage = 'keychain' | 'file' | 'none'

/** Set by the desktop before spawning `bridge-agent auth`. In this mode the
 *  file fallback is NOT allowed: a Keychain failure has to surface as a failure,
 *  because the screen that asked for the token promised the Keychain. The CLI,
 *  which promises nothing of the sort, keeps the fallback — for someone typing
 *  `bridge-agent auth` in a terminal, losing the token outright is the worse
 *  outcome. */
function keychainRequired(): boolean {
  return process.env['BRIDGE_REQUIRE_KEYCHAIN'] === '1'
}

export function setToken(token: string): TokenStorage {
  if (!token) {
    logEvent('setToken.empty_token')
    return 'none'
  }

  if (isDarwin() && !useIsolatedHarnessFileStore()) {
    const account = getKeychainAccount()

    // 1. Write to Keychain
    const written = keychainWrite(account, token)
    if (!written) {
      logEvent('setToken.keychain_write_failed_critical', { exitCode: -1 })
      if (keychainRequired()) {
        logEvent('setToken.keychain_required_refusing_file')
        return 'none'
      }
      // Write to file as fallback so token is not lost
      writeTokenToFile(token)
      logEvent('setToken.fallback_to_file')
      return 'file'
    }

    // 2. Verify readback
    const verify = keychainRead(account)
    if (!verify.found || verify.token !== token) {
      logEvent('keychain.verify_failed', { error: 'token mismatch or missing after write' })
      if (keychainRequired()) {
        logEvent('setToken.keychain_required_refusing_file')
        return 'none'
      }
      // Do NOT strip from file — keep token safe
      writeTokenToFile(token)
      logEvent('setToken.fallback_to_file_after_verify_fail')
      return 'file'
    }

    // 3. ONLY THEN strip from file
    stripTokenFromFile()
    logEvent('setToken.ok')
    return 'keychain'
  }

  // Non-darwin: file-only. There is no Keychain to require, and the desktop
  // ships macOS-only, so strict mode never reaches here in practice.
  writeTokenToFile(token)
  logEvent('setToken.file_only')
  return 'file'
}

/**
 * Delete the auth token. On macOS: remove Keychain entry and strip from config
 * file. On Linux: strip from config file only.
 */
export function deleteToken(): void {
  if (isDarwin() && !useIsolatedHarnessFileStore()) {
    const account = getKeychainAccount()
    keychainDelete(account)
  }
  stripTokenFromFile()
  logEvent('deleted')
}

/**
 * Delete Keychain entries for ALL known profiles (used by uninstall --all).
 * Iterates profile dirs, deletes each one's entry, then also deletes the
 * default (no-profile) entry. Non-darwin: no-op, file is handled by uninstall.
 */
export function deleteAllTokens(): void {
  if (!isDarwin()) return

  // Default (no-profile) entry
  keychainDelete('default')

  // Named profile entries
  const profiles = getAllProfileNames()
  for (const p of profiles) {
    keychainDelete(p === 'default' ? 'profile:default' : p)
  }
  logEvent('deleted_all', { profileCount: profiles.length + 1 })
}

// ── keychain ACL probe ──────────────────────────────────────────────────────

/**
 * Verify that Keychain ACLs are set up correctly by writing a throwaway test
 * entry, reading it back, and deleting it.
 *
 * Used by the desktop permission gate (Phase B) to prove Keychain works before
 * the user enters their real auth token. Pure ACL probe — does not touch the
 * real token entry.
 *
 * Returns true if write + readback both succeed (ACL is functional).
 * Non-darwin: always returns true (no Keychain).
 */
export function probeKeychainAcl(): boolean {
  if (!isDarwin()) return true

  const testAccount = '_permission_check'

  // Idempotent: clean any stale entry from a previous crash
  keychainDelete(testAccount)

  const testToken = randomBytes(16).toString('hex')

  const written = keychainWrite(testAccount, testToken)
  if (!written) {
    logEvent('permission_check.write_failed')
    return false
  }

  const readback = keychainRead(testAccount)
  if (!readback.found || readback.token !== testToken) {
    logEvent('permission_check.verify_failed')
    keychainDelete(testAccount)
    return false
  }

  keychainDelete(testAccount)
  logEvent('permission_check.ok')
  return true
}
