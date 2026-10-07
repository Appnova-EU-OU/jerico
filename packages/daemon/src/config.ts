import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  consentSatisfied,
  CURRENT_CONSENT_VERSION,
  validateDaemonEndpoint,
  type EndpointRejection,
} from '@jerico/shared'
import { getConfigPath } from './profile.js'
import { getToken, keychainHasToken } from './token-store.js'

export { consentSatisfied, CURRENT_CONSENT_VERSION } from '@jerico/shared'
export type { EndpointRejection } from '@jerico/shared'

export interface BridgeConfig {
  server: string
  token: string
  name: string
  /** Global agent binary path overrides (key = agentKey, value = absolute path) */
  agentPaths?: Record<string, string>
  /** Per-project local path overrides (key = projectId, value = absolute path on this machine) */
  projectPaths?: Record<string, string>
  projectPathSources?: Record<string, 'cli' | 'auto'>
  /** Claude API tier — free | pro | max_5x | max_20x */
  claudeTier?: string
  /** npm dist-tag channel for self-update (default 'latest').
   *  Persisted via mergeSettings / saveConfig. */
  updateChannel?: string
  /** Capability + data-access consent version. Present iff user acknowledged the disclosure. */
  consentVersion?: typeof CURRENT_CONSENT_VERSION
  /** Set when `server` breaks the endpoint contract (#571). The value is still
   *  carried, so a caller that only wants to DISPLAY it can, but nothing may
   *  dial it: `startDaemonConnection()` refuses, and `start` idles instead. */
  endpointRejection?: EndpointRejection
}

/** Project-level settings from .jerico/settings.json in cwd */
export interface ProjectSettings {
  /** Override agent binary paths (key = agentKey, value = absolute path) */
  agentPaths?: Record<string, string>
  /** Override the agent binary to prefer in this project */
  preferredAgent?: string
  /** Shell hooks — see lifecycle hooks (ISSUE 7) */
  hooks?: Record<string, string>
  /** Additional env vars injected into spawned agents in this project */
  env?: Record<string, string>
}

function parseStringRecord(obj: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const val = obj[key]
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined
  return Object.fromEntries(
    Object.entries(val as Record<string, unknown>).filter(([, v]) => typeof v === 'string') as [string, string][]
  )
}

const CONFIG_PATH = path.join(os.homedir(), '.bridge', 'config.json')

// Re-export so existing callers that import getConfigPath from config.ts keep working.
export { getConfigPath }

/**
 * Which settings.json this process reads.
 *
 * Prefer the profile/default ~/.jerico path. Only fall back to legacy
 * ~/.bridge/config.json for prod (no profile); when BRIDGE_PROFILE is set, a
 * missing profile config is a hard error.
 */
function resolveConfigPath(): string {
  const activeConfigPath = getConfigPath()
  const hasProfile = !!process.env.BRIDGE_PROFILE
  return fs.existsSync(activeConfigPath) ? activeConfigPath : (!hasProfile ? CONFIG_PATH : activeConfigPath)
}

/**
 * Rewrite stale server URLs to the canonical lcars CF Worker endpoint.
 *
 * Users with old config files containing sslip.io or direct-IP URLs auto-migrate
 * to the Cloudflare Worker, gaining WSS encryption + edge proxy for free.
 *
 * The endpoint contract (#571) is applied to the result of this, never to the
 * input: two of the stale shapes are plaintext to a remote host, which the
 * contract refuses — judging before the rewrite would refuse a config the
 * daemon is about to fix by itself.
 */
const STALE_URL_PATTERNS = [
  /23-88-110-113\.sslip\.io/i,
  /23\.88\.110\.113:443\/ws\/daemon$/,
  /23\.88\.110\.113:3100\/ws\/daemon$/,
]
const CANONICAL_SERVER = 'wss://lcars.jerico.appnova.io/ws/daemon'

function migrateStaleServerUrl(server: string): string | null {
  if (!server || !STALE_URL_PATTERNS.some((re) => re.test(server))) return null
  return CANONICAL_SERVER
}

/**
 * Judge the configured endpoint without loading (or exiting on) anything else.
 *
 * `start` needs the verdict before it decides whether to open a socket, and it
 * must not inherit loadConfig()'s process.exit(1) paths to get it — under
 * launchd's `KeepAlive { SuccessfulExit false }` a non-zero exit is a job that
 * respawns every 30 seconds, forever, with no UI to say why.
 *
 * A missing, unreadable or server-less config returns null: those are
 * pre-existing conditions with their own handling, and labelling them
 * "endpoint rejected" would put a wrong reason on the tray.
 *
 * `configPath` is injectable so this is testable against a temp file rather
 * than the caller's real profile.
 */
export function getDaemonEndpointRejection(configPath?: string): EndpointRejection | null {
  const target = configPath ?? resolveConfigPath()
  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    obj = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const raw = typeof obj['server'] === 'string' ? obj['server'] : ''
  if (!raw) return null
  const server = migrateStaleServerUrl(raw) ?? raw
  const result = validateDaemonEndpoint(server)
  if (result.ok) return null
  const { ok: _ok, ...rejection } = result
  void _ok
  return rejection
}

/**
 * The command that actually repairs a refused endpoint, profile included.
 *
 * Every surface that names a remedy uses this one string. The first version of
 * this fix printed "bridge-agent auth", which does not work: with an invalid
 * value already on disk, plain `auth` exits 1 before it writes anything. Only
 * an explicit `--daemon-server` can replace it.
 */
export function endpointRepairCommand(): string {
  const profile = process.env['BRIDGE_PROFILE']
  const prefix = profile ? `bridge-agent --profile ${profile}` : 'bridge-agent'
  return `${prefix} auth --daemon-server wss://<host>/ws/daemon`
}

/**
 * The only supported way to turn the configured endpoint into an HTTP origin.
 *
 * Three call sites used to each re-derive this from `config.server` with their
 * own copy of the same regex, and none of them asked whether the endpoint was
 * usable — so a refused endpoint still received `Authorization: Bearer <token>`
 * through `cleanup-orphans` and `link-project`, which is the exact sentence
 * this change exists to prevent (#571 review B1).
 *
 * Returns null when there is no usable endpoint. A caller cannot obtain an
 * origin it could then send the token to; it has to handle the null.
 */
export function getServerHttpOrigin(config: BridgeConfig): string | null {
  if (config.endpointRejection || !config.server) return null
  // Re-judged here, not merely trusted. `loadConfig()` attaches the rejection
  // and empties `server`, but this helper must hold even for a config assembled
  // some other way — and a single deleted line in loadConfig must not silently
  // reopen the leak this function exists to close.
  if (!validateDaemonEndpoint(config.server).ok) return null
  return config.server
    .replace(/^wss?:/, (m) => (m === 'wss:' ? 'https:' : 'http:'))
    .replace(/\/ws(\/.*)?$/, '')
}

/**
 * May this config be dialed, and if not, why not?
 *
 * The socket guard's decision, as a function, so it can be tested without a
 * token, a Keychain or a network. Like getServerHttpOrigin it re-judges rather
 * than trusting `endpointRejection` to have been attached.
 */
export function endpointDialRefusal(config: BridgeConfig): EndpointRejection | null {
  if (config.endpointRejection) return config.endpointRejection
  const result = validateDaemonEndpoint(config.server)
  if (result.ok) return null
  const { ok: _ok, ...rejection } = result
  void _ok
  return rejection
}

export function loadConfig(): BridgeConfig {
  const configPath = resolveConfigPath()
  if (!fs.existsSync(configPath)) {
    const hint = process.env.BRIDGE_PROFILE
      ? `bridge-agent --profile ${process.env.BRIDGE_PROFILE} auth`
      : 'bridge-agent auth'
    console.error(`[bridge] Config not found. Run: ${hint}`)
    process.exit(1)
  }
  const raw = fs.readFileSync(configPath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error('[bridge] Invalid config file at', configPath)
    process.exit(1)
  }
  if (!parsed || typeof parsed !== 'object') {
    console.error('[bridge] Config must be a JSON object. Run: bridge-agent auth')
    process.exit(1)
  }
  const obj = parsed as Record<string, unknown>
  let server = typeof obj['server'] === 'string' ? obj['server'] : ''
  // Token is now stored in Keychain (macOS) or file (Linux).
  // getToken() handles Keychain-first lookup + migration from legacy file token.
  const tokenResult = getToken()
  const token = tokenResult.token ?? ''
  const name   = typeof obj['name']   === 'string' ? obj['name']   : 'bridge-agent'
  if (tokenResult.source !== 'none') {
    console.log(JSON.stringify({ ts: Date.now(), level: 'info', event: 'config.token_source', source: tokenResult.source, found: tokenResult.found }))
  }

  // One-time auto-migration of stale server URLs — the corrected config is
  // saved back. See migrateStaleServerUrl().
  const migrated = migrateStaleServerUrl(server)
  if (migrated) {
    console.warn(`[daemon] config.url_migration: migrating stale URL ${server} → ${migrated}`)
    server = migrated
    obj['server'] = server
    try {
      fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), { mode: 0o600 })
      fs.chmodSync(configPath, 0o600)
    } catch (err) {
      console.warn('[daemon] config.url_migration: failed to save migrated config', String(err))
    }
  }
  if (!server || !token) {
    console.error('[bridge] Config missing server or token. Run: bridge-agent auth')
    process.exit(1)
  }
  const config: BridgeConfig = { server, token, name }

  // #571 read side: the writer has always validated this value; now the reader
  // does too. Deliberately NOT a process.exit — see getDaemonEndpointRejection.
  const endpointResult = validateDaemonEndpoint(server)
  if (!endpointResult.ok) {
    const { ok: _ok, ...rejection } = endpointResult
    void _ok
    config.endpointRejection = rejection
    // The value is REMOVED, not merely flagged. Flagging it left every caller
    // free to build an origin out of it and send the token there — which two
    // commands did (#571 review B1). The redacted copy on the rejection is what
    // diagnostics use; `server` being empty is what makes the leak unreachable
    // even from a caller that never heard of `endpointRejection`.
    config.server = ''
    console.error(JSON.stringify({
      ts: Date.now(),
      level: 'error',
      event: 'config.endpoint_rejected',
      code: rejection.code,
      reason: rejection.reason,
      server: rejection.serverRedacted,
      configPath,
      remedy: endpointRepairCommand(),
    }))
  }

  const agentPaths   = parseStringRecord(obj, 'agentPaths')
  const projectPaths = parseStringRecord(obj, 'projectPaths')
  if (agentPaths)   config.agentPaths   = agentPaths
  // Normalize stale agent key overrides from pre-migration config
  if (config.agentPaths?.['gemini'] && !config.agentPaths['agy']) {
    config.agentPaths['agy'] = config.agentPaths['gemini']
    delete config.agentPaths['gemini']
  }
  if (projectPaths) config.projectPaths = projectPaths
  const projectPathSources = parseStringRecord(obj, 'projectPathSources') as Record<string, 'cli' | 'auto'> | undefined
  if (projectPathSources) config.projectPathSources = projectPathSources
  if (typeof obj['claudeTier'] === 'string') config.claudeTier = obj['claudeTier'] as string
  if (typeof obj['updateChannel'] === 'string') config.updateChannel = obj['updateChannel'] as string
  if (consentSatisfied(obj['consentVersion'], CURRENT_CONSENT_VERSION)) {
    config.consentVersion = CURRENT_CONSENT_VERSION
  }
  return config
}

export function saveConfig(config: BridgeConfig): void {
  const configPath = getConfigPath()
  const dir = path.dirname(configPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // Strip token from config before writing — Keychain (or file fallback) is source of truth
  const { token: _, tokenStripped, ...safeConfig } = config as BridgeConfig & { tokenStripped?: string }
  void _
  void tokenStripped
  fs.writeFileSync(configPath, JSON.stringify(safeConfig, null, 2), { mode: 0o600 })
}

export function mergeSettings(patch: Record<string, unknown>): void {
  const configPath = getConfigPath()
  const dir = path.dirname(configPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  let existing: Record<string, unknown> = {}
  if (fs.existsSync(configPath)) {
    try { existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown> }
    catch { existing = {} }
  }
  // Strip token from the patch before merging — Keychain is source of truth on darwin;
  // on non-darwin setToken() writes to file directly and callers do not pass token here.
  const { token: _, ...safePatch } = patch
  void _
  // …and from what is ALREADY in the file. Stripping only the patch left a
  // token written by an earlier fallback sitting there forever: every later
  // merge carried it forward untouched. Only on darwin, where the Keychain is
  // the real store — on Linux the file is the only copy and deleting it would
  // sign the user out.
  if (process.platform === 'darwin' && existing['token'] !== undefined && keychainHasToken()) {
    delete existing['token']
  }
  fs.writeFileSync(configPath, JSON.stringify({ ...existing, ...safePatch }, null, 2), { mode: 0o600 })
}

/**
 * Load project-level settings from .jerico/settings.json in the given directory (or cwd).
 * Returns empty object if the file does not exist or fails to parse.
 */
export function loadProjectSettings(cwd?: string): ProjectSettings {
  const settingsPath = path.join(cwd ?? process.cwd(), '.jerico', 'settings.json')
  if (!fs.existsSync(settingsPath)) return {}
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const obj = parsed as Record<string, unknown>
    const result: ProjectSettings = {}
    if (typeof obj['preferredAgent'] === 'string') result.preferredAgent = obj['preferredAgent']
    const hooks      = parseStringRecord(obj, 'hooks')
    const env        = parseStringRecord(obj, 'env')
    const agentPaths = parseStringRecord(obj, 'agentPaths')
    if (hooks)      result.hooks      = hooks
    if (env)        result.env        = env
    if (agentPaths) result.agentPaths = agentPaths
    // Normalize stale agent key overrides from pre-migration config
    if (result.agentPaths?.['gemini'] && !result.agentPaths['agy']) {
      result.agentPaths['agy'] = result.agentPaths['gemini']
      delete result.agentPaths['gemini']
    }
    return result
  } catch {
    console.warn('[bridge] Failed to parse .jerico/settings.json, ignoring')
    return {}
  }
}
