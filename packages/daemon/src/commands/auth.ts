import https from 'https'
import http from 'http'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { assertDaemonEndpoint, isLoopbackHost, validateDaemonEndpoint } from '@jerico/shared'
import { consentSatisfied, mergeSettings, CURRENT_CONSENT_VERSION } from '../config.js'
import { getActiveProfile, getBuiltInProfileEndpoints, getConfigPath, getAuthFailedFlagPath, getEndpointRejectedFlagPath } from '../profile.js'
import { setToken } from '../token-store.js'

export const CANONICAL_AUTH_URL = 'https://lcars.jerico.appnova.io'
const CANONICAL_DAEMON_URL = 'wss://lcars.jerico.appnova.io/ws/daemon'
const CANONICAL_CONNECT_PAGE_URL = 'https://jerico.appnova.io/connect'

type ValidationOutcome =
  | { ok: true }
  | { ok: false; reason: 'rejected' | 'server-error' | 'unreachable' | 'timeout'; detail?: string }

function sanitizeToken(raw: string | undefined): string {
  return (raw ?? '').trim()
}

function disclosureText(daemonServerUrl: string): string {
  return `
jerico daemon — capability & data-access disclosure

This daemon accepts the following commands from the jerico server
over ${daemonServerUrl} (auth: your token):

  spawn      — start a PTY process for any installed agent (claude, sh, qwen, …)
               (agents spawned with --dangerously-skip-permissions)
  input      — send text to any running PTY
  kill       — terminate any running PTY
  resize     — resize any PTY terminal
  dir_list   — list directory contents on your filesystem
  orch_*     — orchestration control (inject text, pause, cancel, reassign panels)
  persona/role — apply persona or role to a panel

Data access:
  Runs as your user account with no OS sandbox.
  Can read and write: ~/.ssh, dotfiles, source code, shell history,
  and any file your user can access.
  If you grant Full Disk Access, this also includes other applications' data,
  such as messages, mail, and browser history.

You can remove this daemon at any time: bridge-agent uninstall
`
}

/** Same loopback rule the endpoint contract uses, so the auth server and the
 *  connect page cannot disagree with the daemon endpoint about what "local" is. */
const isLoopback = isLoopbackHost

function parseAuthServer(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('profile settings must include a non-empty "authServer" URL')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('auth server is not a valid URL')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('auth server must be an origin without credentials, path, query, or fragment')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('auth server must use https (or http on localhost)')
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new Error('an http auth server is allowed only on a loopback host')
  }
  return url.origin
}

function resolveAuthServer(serverUrl?: string): { url: string; source: 'argument' | 'profile' | 'default' } {
  if (serverUrl?.trim()) return { url: parseAuthServer(serverUrl), source: 'argument' }

  const profile = getActiveProfile()
  if (!profile) return { url: CANONICAL_AUTH_URL, source: 'default' }
  const builtIn = getBuiltInProfileEndpoints(profile)
  if (builtIn) return { url: builtIn.authServer, source: 'profile' }

  const configPath = getConfigPath()
  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    throw new Error(`profile "${profile}" has no readable settings at ${configPath}`)
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`profile "${profile}" settings must be a JSON object`)
  }
  return {
    url: parseAuthServer((settings as Record<string, unknown>)['authServer']),
    source: 'profile',
  }
}

/**
 * The endpoint the daemon will be told to dial.
 *
 * The rule itself lives in @jerico/shared and the daemon applies the very same
 * function when it READS the value back (#571) — so a value this accepts can
 * never be one the daemon then refuses. Exported for the parity test that
 * holds those two sides together.
 */
export function parseDaemonServer(raw: unknown): string {
  return assertDaemonEndpoint(raw)
}

function parseConnectPage(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('connect page must be an explicit URL')
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('connect page must not contain credentials, query, or fragment')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('connect page must use https (or http on localhost)')
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new Error('an http connect page is allowed only on a loopback host')
  }
  return url.toString()
}

function resolveConnectPage(explicitConnectPage?: string, explicitAuthServer?: string): string {
  if (explicitConnectPage?.trim()) return parseConnectPage(explicitConnectPage)

  const profile = getActiveProfile()
  if (!profile) {
    if (!explicitAuthServer || parseAuthServer(explicitAuthServer) === CANONICAL_AUTH_URL) {
      return CANONICAL_CONNECT_PAGE_URL
    }
    throw new Error(
      'a custom auth server needs a token-generation page; '
      + 'pass --connect-page https://your-app.example/connect (it is never inferred)',
    )
  }
  const builtIn = getBuiltInProfileEndpoints(profile)
  if (builtIn) return parseConnectPage(builtIn.connectPage)

  const configPath = getConfigPath()
  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    throw new Error(`profile "${profile}" has no readable settings at ${configPath}`)
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`profile "${profile}" settings must be a JSON object`)
  }
  return parseConnectPage((settings as Record<string, unknown>)['connectPage'])
}

/** An inline token has already completed the only step that uses a connect
 * page. Without one, auth must show a token-generation URL before prompting. */
export function authNeedsConnectPage(inlineToken: string): boolean {
  return !inlineToken
}

/** The unnamed production default is valid only when auth is also canonical.
 * A custom first-run auth origin has no truthful daemon URL unless the operator
 * supplies one separately. */
export function daemonServerForFreshUnnamedAuth(explicitAuthServer?: string): string {
  if (explicitAuthServer && parseAuthServer(explicitAuthServer) !== CANONICAL_AUTH_URL) {
    throw new Error('a custom auth server requires --daemon-server on first run; it is never inferred')
  }
  return CANONICAL_DAEMON_URL
}

interface DaemonServerSelection {
  effectiveUrl: string
  patch?: string
}

/**
 * Re-auth never repoints a daemon as a side effect. An explicit URL is still
 * meaningful: it is validated and must assert the already-configured value.
 *
 * With ONE exception, added in #571 review B2: when the configured value is
 * invalid, there is no working endpoint to protect from being repointed — the
 * daemon refuses to dial it — and every surface tells the user to re-auth. So
 * an explicit, valid `--daemon-server` REPAIRS an invalid configured value.
 * Without one, the error names the flag, because plain `auth` cannot fix this.
 *
 * `repaired` tells the caller to persist the new value; a re-auth that merely
 * confirms the configured endpoint still writes no `server` patch.
 */
export function configuredDaemonServerForAuth(
  configuredRaw: string,
  explicitDaemonServer?: string,
): { url: string; repaired: boolean } {
  const explicit = explicitDaemonServer?.trim() ? parseDaemonServer(explicitDaemonServer) : null
  const configured = validateDaemonEndpoint(configuredRaw)
  if (!configured.ok) {
    if (explicit) return { url: explicit, repaired: true }
    throw new Error(
      `configured daemon server is invalid: ${configured.reason}. `
      + 'Re-run with --daemon-server wss://<host>/ws/daemon to replace it',
    )
  }
  if (explicit && explicit !== configured.url) {
    throw new Error(
      `--daemon-server ${explicit} conflicts with configured daemon server ${configured.url}; `
      + 're-auth does not change this endpoint',
    )
  }
  return { url: configured.url, repaired: false }
}

/** A built-in profile may supply its daemon endpoint only when an explicit
 * auth override still names that profile's endpoint set. */
export function assertBuiltInAuthServer(
  profile: string,
  builtInAuthServer: string,
  explicitAuthServer?: string,
): void {
  if (!explicitAuthServer?.trim()) return
  const explicit = parseAuthServer(explicitAuthServer)
  const expected = parseAuthServer(builtInAuthServer)
  if (explicit !== expected) {
    throw new Error(
      `--server ${explicit} conflicts with built-in profile "${profile}" auth server ${expected}; `
      + 'omit --server or pass --daemon-server explicitly',
    )
  }
}

function selectDaemonServerForAuth(
  explicitDaemonServer?: string,
  explicitAuthServer?: string,
): DaemonServerSelection {
  const profile = getActiveProfile()
  const builtIn = profile ? getBuiltInProfileEndpoints(profile) : null
  const configPath = getConfigPath()
  let configuredRaw: string | undefined
  try {
    const settings = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    if (typeof settings['server'] === 'string' && settings['server'].trim()) {
      configuredRaw = settings['server']
    }
  } catch { /* first-run config is absent or unreadable */ }
  if (configuredRaw) {
    // A normal built-in-profile re-auth already has settings on disk. Keep the
    // profile consistency check ahead of that stored-value return so the first
    // auth and every later auth enforce the same endpoint contract. Supplying
    // --daemon-server explicitly is allowed only as the matching assertion
    // enforced below; it also makes a fully explicit custom endpoint set.
    if (builtIn && !explicitDaemonServer?.trim()) {
      assertBuiltInAuthServer(profile!, builtIn.authServer, explicitAuthServer)
    }
    const selected = configuredDaemonServerForAuth(configuredRaw, explicitDaemonServer)
    // A repair must be written back; a confirmation must not be.
    return selected.repaired
      ? { effectiveUrl: selected.url, patch: selected.url }
      : { effectiveUrl: selected.url }
  }
  if (explicitDaemonServer?.trim()) {
    const parsed = parseDaemonServer(explicitDaemonServer)
    return { effectiveUrl: parsed, patch: parsed }
  }
  if (!profile) {
    const selected = daemonServerForFreshUnnamedAuth(explicitAuthServer)
    return { effectiveUrl: selected, patch: selected }
  }
  if (builtIn) {
    assertBuiltInAuthServer(profile, builtIn.authServer, explicitAuthServer)
    const parsed = parseDaemonServer(builtIn.server)
    return { effectiveUrl: parsed, patch: parsed }
  }
  throw new Error(`profile "${profile}" has no daemon server; pass --daemon-server explicitly`)
}

export async function runAuth(
  serverUrl?: string,
  noBrowser = false,
  providedToken?: string,
  daemonServerUrl?: string,
  connectPageUrl?: string,
): Promise<void> {
  // Phase B fix: read BRIDGE_AUTH_TOKEN from env (set by desktop to avoid argv exposure)
  const envToken = sanitizeToken(process.env.BRIDGE_AUTH_TOKEN)
  if (envToken) {
    delete process.env.BRIDGE_AUTH_TOKEN
  }
  const effectiveProvided = providedToken || envToken
  const inlineToken = sanitizeToken(effectiveProvided)

  let resolvedServer: ReturnType<typeof resolveAuthServer>
  let resolvedConnectPage: string | undefined
  try {
    resolvedServer = resolveAuthServer(serverUrl)
    // An explicitly supplied endpoint is always validated. Otherwise an
    // already-provided token has no URL-printing/prompt step and therefore no
    // use for a connect page, regardless of --no-browser. Without a token the
    // connect page is needed to show where one can be generated. Crucially, no
    // branch derives it from the auth origin.
    resolvedConnectPage = connectPageUrl?.trim()
      ? parseConnectPage(connectPageUrl)
      : authNeedsConnectPage(inlineToken)
        ? resolveConnectPage(undefined, serverUrl)
        : undefined
  } catch (err) {
    console.error(`[bridge] Auth server configuration error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  const effectiveUrl = resolvedServer.url

  let daemonServer: DaemonServerSelection
  try {
    daemonServer = selectDaemonServerForAuth(daemonServerUrl, serverUrl)
  } catch (err) {
    console.error(`[bridge] Daemon server configuration error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  // Check if consent already recorded from a prior auth
  let alreadyConsented = false
  try {
    const configPath = getConfigPath()
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
      alreadyConsented = consentSatisfied(raw['consentVersion'], CURRENT_CONSENT_VERSION)
    }
  } catch {
    // config absent or unparseable — first-time auth
  }

  let consentAccepted = false
  if (!alreadyConsented) {
    if (process.stdin.isTTY) {
      console.log(disclosureText(daemonServer.effectiveUrl))
      console.log('[bridge] consent.shown', { version: CURRENT_CONSENT_VERSION })
      const accepted = await promptYes('Type "yes" to continue: ')
      if (!accepted) {
        console.log('[bridge] auth.consent_declined')
        process.exit(1)
      }
      consentAccepted = true
      console.log('[bridge] consent.accepted', { version: CURRENT_CONSENT_VERSION })
    } else {
      // Non-interactive (--token / CI): print to stderr and continue
      process.stderr.write(disclosureText(daemonServer.effectiveUrl) + '\n')
      console.log('[bridge] consent.skipped', { reason: 'non_interactive' })
    }
  } else {
    console.log('[bridge] consent.skipped', { reason: 'already_consented' })
  }

  console.log('[bridge] Starting auth flow...')
  console.log(`[bridge] Server: ${effectiveUrl}${resolvedServer.source === 'default' ? ' (default)' : ''}`)
  if (resolvedConnectPage) {
    console.log('[bridge] Open this URL to generate a daemon token:')
    console.log(`  ${resolvedConnectPage}`)
  }

  if (inlineToken) {
    console.log('[bridge] Using token from --token or BRIDGE_AUTH_TOKEN')
  }

  if (noBrowser) {
    if (inlineToken) {
      console.log('[bridge] --no-browser: using the provided token without a browser flow.')
    } else {
      console.log('[bridge] --no-browser: exiting after printing URL.')
      process.exit(0)
    }
  }

  let token = inlineToken
  if (!token) {
    console.log()
    console.log('[bridge] After authenticating, paste your token here:')
    token = await promptToken()
  }
  if (!token) {
    console.error('[bridge] No token provided. Exiting.')
    process.exit(1)
  }

  // Validate token with server
  const validation = await validateToken(effectiveUrl, token)
  if (!validation.ok) {
    switch (validation.reason) {
      case 'rejected':
        console.error('[bridge] Token validation failed. Please try again.')
        break
      case 'server-error':
        console.error(`[bridge] Token validation server error (${validation.detail ?? 'unknown'}). Try again shortly.`)
        break
      case 'timeout':
        console.error('[bridge] Token validation failed: server did not answer in time.')
        break
      case 'unreachable':
        console.error(`[bridge] Token validation failed: could not reach the server${validation.detail ? ` (${validation.detail})` : ''}.`)
        break
    }
    process.exit(1)
  }

  // Keychain-first on darwin, file on others. The result is checked: under
  // BRIDGE_REQUIRE_KEYCHAIN the caller has promised the user a Keychain and
  // nothing else, so anything short of that must exit non-zero rather than
  // quietly leaving a plaintext token on disk and reporting success.
  const storage = setToken(token)
  if (storage !== 'keychain' && process.env['BRIDGE_REQUIRE_KEYCHAIN'] === '1') {
    console.error(
      '[bridge] could not store the token in the macOS Keychain. Nothing was '
      + 'written to disk. Unlock your login keychain and try again.',
    )
    process.exit(1)
  }
  if (storage === 'file') {
    console.warn(
      '[bridge] the Keychain was unavailable — the token was written to '
      + `${getConfigPath()} in plaintext (mode 0600) so it is not lost. `
      + 'Re-run `bridge-agent auth` once the Keychain works to move it.',
    )
  }
  mergeSettings({
    ...(daemonServer.patch ? { server: daemonServer.patch } : {}),
    name: process.env['HOSTNAME'] ?? 'My Machine',
    ...(consentAccepted ? { consentVersion: CURRENT_CONSENT_VERSION } : {}),
  })
  try { unlinkSync(getAuthFailedFlagPath()) } catch { /* absent is normal */ }
  // A successful auth that rewrote the endpoint has repaired the very thing the
  // rejected-endpoint flag records. Leaving it would keep a fixed install
  // reporting a fault the daemon no longer has (#571 review).
  if (daemonServer.patch) {
    try { unlinkSync(getEndpointRejectedFlagPath()) } catch { /* absent is normal */ }
  }

  console.log(`[bridge] Auth successful! Config saved to ${getConfigPath()}`)
  console.log('[bridge] Run: bridge-agent start')
  process.exit(0)
}

async function promptYes(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    let input = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.resume()
    process.stdin.on('data', (chunk: string) => {
      input += chunk
      if (input.includes('\n')) {
        process.stdin.pause()
        resolve(input.trim().toLowerCase() === 'yes')
      }
    })
  })
}

async function promptToken(): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write('Token: ')
    let input = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk: string) => {
      input += chunk
      if (input.includes('\n')) {
        process.stdin.pause()
        resolve(input.trim())
      }
    })
    process.stdin.resume()
  })
}

function validationTimeoutMs(): number {
  const configured = Number(process.env['BRIDGE_AUTH_VALIDATE_TIMEOUT_MS'])
  return Number.isFinite(configured) && configured >= 50 && configured <= 30_000 ? configured : 8_000
}

async function validateToken(serverUrl: string, token: string): Promise<ValidationOutcome> {
  return new Promise(resolve => {
    const url = new URL('/api/tokens/validate', serverUrl)
    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      timeout: validationTimeoutMs(),
    }
    const req = lib.request(options, (res) => {
      res.resume()
      const code = res.statusCode ?? 0
      if (code === 200) return resolve({ ok: true })
      if (code === 401 || code === 403) return resolve({ ok: false, reason: 'rejected' })
      resolve({ ok: false, reason: 'server-error', detail: String(code) })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, reason: 'timeout' })
    })
    req.on('error', (err: Error) => resolve({ ok: false, reason: 'unreachable', detail: err.message }))
    req.end()
  })
}
