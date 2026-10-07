/**
 * Finding an agent's credential without ever asking the user for one.
 *
 * The policy, stated once here because every provider inherits it:
 *
 *   1. Jerico reads what the agent already stored. It never prompts for a
 *      password, never opens a browser, and never reads a browser cookie jar.
 *      The reference implementation lifts `sessionKey` out of Safari's
 *      Cookies.binarycookies and Chrome's cookie database; that is a different
 *      category of access and it is deliberately not implemented here.
 *   2. A file the agent wrote is free to read. The daemon already reads
 *      ~/.claude/projects/** for context and quota; a credential file beside it
 *      is the same directory and the same trust.
 *   3. The Keychain is NOT free: reading it can raise a modal, and there is no way
 *      to ask `/usr/bin/security` to fail instead of prompting. So a background
 *      refresh does not call it AT ALL. The first version of this file gated the
 *      call on a shorter timeout and claimed in this very comment that it never
 *      prompted in the background — two reviewers caught that the code was weaker
 *      than the sentence, and they were right: on a locked keychain the user would
 *      have got a modal every five minutes, which is precisely the behaviour
 *      that makes users uninstall a menu-bar usage tool. A timeout dismisses
 *      nothing; the modal outlives the process that raised it.
 *
 * Measured on the machine this was written on: ~/.claude/.credentials.json does
 * NOT exist and a Keychain item named `Claude Code-credentials` DOES. So the
 * file path is not the common case on macOS and cannot be the only path.
 */

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Overridable ONLY so a test can point the keychain read at a real, slow
 *  subprocess and measure event-loop liveness without mocking
 *  `node:child_process` — mocking a node: builtin in Bun permanently breaks
 *  named-export resolution for every later test file in the same process
 *  (#505 / #552), and no restore shape fixes it. Unset in production. */
/** Read at CALL time, not module load. As a module-level const this silently
 *  Both seams are additionally gated on NODE_ENV === 'test' (which `bun test`
 *  sets and a packaged daemon does not), so a stray variable in a real user's
 *  environment cannot redirect which binary the daemon executes.
 *  As a module-level const this silently
 *  did nothing in the full suite: bun runs every daemon test file in one
 *  process, so an earlier file had already imported this module and frozen the
 *  real path before the test could set the variable. Same reason
 *  `credentialHome()` below is a function. */
const testSeamsEnabled = (): boolean => process.env['NODE_ENV'] === 'test'
/** Test-only, same gate: lets the keychain tests drive the macOS branch on
 *  any OS (the read itself is already redirected by the two seams below), so
 *  the public Linux CI runs them instead of skipping them. */
const keychainPlatform = (): string =>
  (testSeamsEnabled() ? process.env['JERICO_TEST_KEYCHAIN_PLATFORM'] : undefined) ?? process.platform
const securityBin = (): string =>
  (testSeamsEnabled() ? process.env['JERICO_TEST_SECURITY_BIN'] : undefined) ?? '/usr/bin/security'
/** Test-only, same reasoning as securityBin(). Lets the liveness test point the
 *  read at a stock slow binary (`/bin/sleep 0.4`) instead of writing an
 *  executable stub — a written stub depends on the exec bit surviving the
 *  runner's umask and on TMPDIR not being noexec, and it silently took the
 *  spawn-error branch on CI while passing locally. */
const SECURITY_ARGS = (service: string): string[] => {
  const override = testSeamsEnabled() ? process.env['JERICO_TEST_SECURITY_ARGS'] : undefined
  return override ? override.split(' ') : ['find-generic-password', '-s', service, '-w']
}
export const KEYCHAIN_TIMEOUT_MS = 10_000

/** Read at call time, not module load: the daemon's own profile.ts does the
 *  same, because Bun caches os.homedir() and tests isolate HOME. */
function home(): string {
  return process.env['HOME'] || os.homedir()
}

export type CredentialSource = 'file' | 'keychain'

export interface Credential {
  /** The parsed JSON blob the agent stored. Providers pick their own fields out
   *  of it; this module does not interpret them. */
  data: Record<string, unknown>
  source: CredentialSource
  /** For the surface's "updated … · <source>" line and for logs. Never the
   *  secret, and never a path that contains one. */
  describe: string
}

export type CredentialLookup =
  | { found: true; credential: Credential }
  | { found: false; reason: 'absent' | 'keychain_deferred' | 'keychain_locked' | 'malformed'; detail: string }

/**
 * A credential that lives in a JSON file the agent wrote.
 */
export function readCredentialFile(relativePath: string): CredentialLookup {
  const full = path.join(home(), relativePath)
  let raw: string
  try {
    raw = fs.readFileSync(full, 'utf-8')
  } catch {
    return { found: false, reason: 'absent', detail: `no credential file at ~/${relativePath}` }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { found: false, reason: 'malformed', detail: `~/${relativePath} is not a JSON object` }
    }
    return {
      found: true,
      credential: {
        data: parsed as Record<string, unknown>,
        source: 'file',
        describe: `~/${relativePath}`,
      },
    }
  } catch {
    return { found: false, reason: 'malformed', detail: `~/${relativePath} is not valid JSON` }
  }
}

/**
 * A credential that lives in the login keychain.
 *
 * `allowInteractive: false` returns WITHOUT calling `security`. That is the whole
 * mitigation, and the only honest one: `security` decides for itself whether to
 * prompt, a timeout does not dismiss a modal it already raised, and a surface that
 * pops a system dialog every five minutes on its own schedule is not a surface a
 * user keeps installed.
 *
 * The cost is stated rather than hidden: on an install whose Claude credential
 * lives only in the Keychain, a scheduled refresh reports `keychain_deferred` and
 * the reading appears when the user opens the usage view, which is an explicit
 * user action. That is a worse reading and a better program.
 */
export async function readCredentialKeychain(service: string, allowInteractive: boolean): Promise<CredentialLookup> {
  if (keychainPlatform() !== 'darwin') {
    return { found: false, reason: 'absent', detail: 'keychain is macOS-only' }
  }
  if (!allowInteractive) {
    return {
      found: false,
      reason: 'keychain_deferred',
      detail: `"${service}" was not read by this background refresh — opening usage allows an interactive read`,
    }
  }
  let stdout: string
  try {
    // `stdio` is dropped, not just untyped: `execFile`'s own promisified type
    // does not admit it, and unlike `execFileSync` its stdin is never inherited
    // from the parent in the first place — there is nothing here to protect
    // against by ignoring it.
    const result = await execFileAsync(securityBin(), SECURITY_ARGS(service), {
      encoding: 'utf-8',
      timeout: KEYCHAIN_TIMEOUT_MS,
    })
    stdout = result.stdout.trim()
  } catch (err: unknown) {
    // Async execFile reports a timeout differently from execFileSync: there is
    // no `ETIMEDOUT` code here, only `killed: true` + the kill signal. Exit
    // status also moves from `.status` to `.code` (a number, not the string
    // Node uses for spawn errors like ENOENT) — verified against this Bun
    // runtime, not assumed from execFileSync's shape.
    const e = err as Omit<NodeJS.ErrnoException, 'code'> & {
      code?: string | number | null
      status?: number | null
      killed?: boolean
    }
    // 44 is `security`'s "the specified item could not be found".
    if (e.code === 44 || e.status === 44) {
      return { found: false, reason: 'absent', detail: `no keychain item named "${service}"` }
    }
    if (e.killed === true) {
      return {
        found: false,
        reason: 'keychain_locked',
        detail: `reading "${service}" timed out — the keychain is locked or a prompt is waiting`,
      }
    }
    // `code` is overloaded on the async error: a NUMBER is the child's exit
    // status, a STRING is a spawn failure (ENOENT, EACCES, …) where the
    // binary never ran at all. Reporting the latter as "keychain refused"
    // told the user their keychain was locked when the real problem was a
    // missing or unusable `security` binary.
    if (typeof e.code === 'string') {
      return {
        found: false,
        reason: 'absent',
        detail: `could not run ${securityBin()} (${e.code}) — the keychain was never queried`,
      }
    }
    return {
      found: false,
      reason: 'keychain_locked',
      detail: `keychain refused "${service}" (security exit ${String(e.code ?? e.status ?? 'unknown')})`,
    }
  }
  if (!stdout) {
    return { found: false, reason: 'absent', detail: `keychain item "${service}" is empty` }
  }
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { found: false, reason: 'malformed', detail: `keychain item "${service}" is not a JSON object` }
    }
    return {
      found: true,
      credential: {
        data: parsed as Record<string, unknown>,
        source: 'keychain',
        describe: `keychain: ${service}`,
      },
    }
  } catch {
    return { found: false, reason: 'malformed', detail: `keychain item "${service}" is not valid JSON` }
  }
}

/**
 * File first, keychain second. The order is deliberate: the file never prompts.
 *
 * A malformed file does NOT fall through to the keychain. If the agent wrote a
 * credential file and it is broken, that is the fault worth reporting — falling
 * back would hide a corrupted file behind a working keychain read and the user
 * would never learn why their agent misbehaves elsewhere.
 */
export async function resolveCredential(
  opts: { file: string; keychainService: string; allowInteractive: boolean; acceptFile?: (data: Record<string, unknown>) => boolean },
): Promise<CredentialLookup> {
  const fromFile = readCredentialFile(opts.file)
  if (!fromFile.found) {
    if (fromFile.reason === 'malformed') return fromFile
    return readCredentialKeychain(opts.keychainService, opts.allowInteractive)
  }
  // A valid credential container can hold unrelated OAuth state (Claude's
  // mcpOAuth is one real example). The provider owns eligibility because a key
  // being present is not the same as a token being usable.
  if (opts.acceptFile === undefined || opts.acceptFile(fromFile.credential.data)) return fromFile
  return readCredentialKeychain(opts.keychainService, opts.allowInteractive)
}
