/**
 * Desktop-side mirror of packages/daemon/src/profile.ts.
 * Reads BRIDGE_PROFILE at call time (not module load) so the env var
 * set in main() before app.whenReady() is always visible.
 */
import { homedir } from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'

const JERICO_DIR = path.join(homedir(), '.jerico')

const SAFE_PROFILE_RE = /^[a-zA-Z0-9-]+$/

export class EndpointConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EndpointConfigurationError'
  }
}

function activeProfile(): string | undefined {
  const p = process.env['BRIDGE_PROFILE'] || undefined
  if (p !== undefined && !SAFE_PROFILE_RE.test(p)) {
    throw new EndpointConfigurationError(
      `Profile "${p}" contains unsafe characters. Use only letters, numbers, and hyphens.`,
    )
  }
  if (p !== undefined && p.toLowerCase() === 'dev' && p !== 'dev') {
    throw new EndpointConfigurationError(
      `Profile "${p}" differs from reserved profile "dev" only by case. Use exactly "dev" or choose another name.`,
    )
  }
  return p
}

export function getConfigPath(): string {
  const p = activeProfile()
  if (!p) return path.join(JERICO_DIR, 'settings.json')
  return path.join(JERICO_DIR, 'profiles', p, 'settings.json')
}

/** Marker for "the first-launch intro has already played". Profile-scoped like
 *  everything else here, so a dev profile gets its own first launch and does
 *  not consume the prod one. */
export function getIntroSeenPath(): string {
  const p = activeProfile()
  if (!p) return path.join(JERICO_DIR, 'intro-seen')
  return path.join(JERICO_DIR, 'profiles', p, 'intro-seen')
}

export function getKeychainAccount(): string {
  const profile = activeProfile()
  return profile === 'default' ? 'profile:default' : (profile ?? 'default')
}

export function getPlistName(): string {
  const p = activeProfile()
  return p ? `com.jerico.bridge-agent.${p}.plist` : 'com.jerico.bridge-agent.plist'
}

/** Health port. Must stay byte-for-byte in step with the daemon's own
 *  getHealthPort() (packages/daemon/src/profile.ts) — see the comment there for
 *  why every profile past `dev` gets its own port instead of sharing 3102. */
export function getHealthPort(): number {
  const explicit = process.env['HEALTH_PORT']
  if (explicit) {
    const n = parseInt(explicit, 10)
    if (Number.isFinite(n)) return n
  }
  const p = activeProfile()
  if (!p) return 3101
  if (p === 'dev') return 3102
  let h = 0x811c9dc5
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return 3103 + (h % 97)
}

/** The profile this app instance belongs to, as the daemon reports it in
 *  /health. `null` is the unnamed prod profile. */
export function getProfileName(): string | null {
  return activeProfile() ?? null
}

export function getAuthFailedFlagPath(): string {
  const p = activeProfile()
  const filename = p ? `auth-failed-${p}` : 'auth-failed'
  return path.join(homedir(), '.bridge', filename)
}

/** Rejected-endpoint flag (mirror of daemon profile.ts):
 *  ~/.bridge/endpoint-rejected[-<profile>].
 *
 *  It exists to be READ: a daemon that refuses its endpoint is otherwise
 *  indistinguishable from one that is merely down, and this file is the durable
 *  signal that survives the daemon not answering at all. */
export function getEndpointRejectedFlagPath(): string {
  const p = activeProfile()
  const filename = p ? `endpoint-rejected-${p}` : 'endpoint-rejected'
  return path.join(homedir(), '.bridge', filename)
}

/** What the daemon wrote in that flag, as far as it can be trusted. Absent
 *  file, unreadable file or missing fields all mean "no named fault" rather
 *  than a guess. */
export function readEndpointRejectedFlag(): { reason: string; remedy: string | null } | null {
  try {
    const raw = fs.readFileSync(getEndpointRejectedFlagPath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const rec = parsed as Record<string, unknown>
    const reason = typeof rec['reason'] === 'string' ? rec['reason'].trim() : ''
    if (!reason) return null
    const remedy = typeof rec['remedy'] === 'string' && rec['remedy'].trim() ? rec['remedy'].trim() : null
    return { reason, remedy }
  } catch {
    return null
  }
}

/** Daemon lock file (mirror of daemon profile.ts): ~/.bridge/daemon.lock or
 *  ~/.bridge/<p>.daemon.lock. Holds the 0600 shutdownToken used to authenticate
 *  the /shutdown + /reconnect RPCs on the daemon health server. */
export function getLockPath(): string {
  const p = activeProfile()
  const filename = p ? `${p}.daemon.lock` : 'daemon.lock'
  return path.join(homedir(), '.bridge', filename)
}

export interface ServerConfig {
  /** WS URL written into the daemon settings (server field) */
  wsUrl: string
  /** Host/port/protocol for the token-validate HTTP request */
  validateHost: string
  validatePort: number
  validateSecure: boolean
  /** Base HTTP(S) URL passed to bridge-agent auth. */
  authServerUrl: string
  /** Browser page where the user generates a daemon token */
  connectPageUrl: string
}

/** Browser destinations exposed by the tray surface. They are derived from
 * the same resolved endpoint contract the daemon/auth flows consume, so a
 * named profile can never silently inherit a production browser URL. */
export interface WebEndpointConfig {
  homeUrl: string
  connectPageUrl: string
  privacyUrl: string
  serverHost: string
}

const PROD_SERVER_CONFIG: ServerConfig = {
  wsUrl: 'wss://lcars.jerico.appnova.io/ws/daemon',
  validateHost: 'lcars.jerico.appnova.io',
  validatePort: 443,
  validateSecure: true,
  authServerUrl: 'https://lcars.jerico.appnova.io',
  connectPageUrl: 'https://jerico.appnova.io/connect',
}

const DEV_SERVER_CONFIG: ServerConfig = {
  wsUrl: 'ws://localhost:3100/ws/daemon',
  validateHost: 'localhost',
  validatePort: 3100,
  validateSecure: false,
  authServerUrl: 'http://localhost:3100',
  connectPageUrl: 'http://localhost:5174/connect',
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function parseEndpoint(
  value: unknown,
  field: string,
  secureProtocol: 'wss:' | 'https:',
  localProtocol: 'ws:' | 'http:',
): URL {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EndpointConfigurationError(`Named profile settings must include a non-empty "${field}" URL.`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new EndpointConfigurationError(`Named profile setting "${field}" is not a valid URL.`)
  }
  if (url.username || url.password) {
    throw new EndpointConfigurationError(`Named profile setting "${field}" must not contain credentials.`)
  }
  if (url.protocol !== secureProtocol && url.protocol !== localProtocol) {
    throw new EndpointConfigurationError(
      `Named profile setting "${field}" must use ${secureProtocol} (or ${localProtocol} on localhost).`,
    )
  }
  if (url.protocol === localProtocol && !isLoopback(url.hostname)) {
    throw new EndpointConfigurationError(
      `Named profile setting "${field}" may use ${localProtocol} only with a loopback host.`,
    )
  }
  return url
}

function writeMigratedSettings(configPath: string, settings: Record<string, unknown>): void {
  const temporaryPath = `${configPath}.${process.pid}.endpoint-migration.tmp`
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
    fs.renameSync(temporaryPath, configPath)
  } catch (err) {
    try { fs.unlinkSync(temporaryPath) } catch { /* a failed write may not have created it */ }
    throw new EndpointConfigurationError(
      `Could not persist migrated endpoint settings at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function legacyEndpointUpgrade(
  profile: string,
  configPath: string,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const hasAuth = settings['authServer'] !== undefined
  const hasConnect = settings['connectPage'] !== undefined
  if (hasAuth || hasConnect) return settings

  const ws = parseEndpoint(settings['server'], 'server', 'wss:', 'ws:')
  if (ws.pathname !== '/ws/daemon' || ws.search || ws.hash) {
    throw new EndpointConfigurationError('Named profile setting "server" must end at /ws/daemon.')
  }

  let authServer: string
  let connectPage: string
  if (ws.toString() === PROD_SERVER_CONFIG.wsUrl) {
    authServer = PROD_SERVER_CONFIG.authServerUrl
    connectPage = PROD_SERVER_CONFIG.connectPageUrl
  } else if (ws.toString() === DEV_SERVER_CONFIG.wsUrl) {
    authServer = DEV_SERVER_CONFIG.authServerUrl
    connectPage = DEV_SERVER_CONFIG.connectPageUrl
  } else if (isLoopback(ws.hostname)) {
    const httpProtocol = ws.protocol === 'wss:' ? 'https:' : 'http:'
    const origin = `${httpProtocol}//${ws.host}`
    authServer = origin
    connectPage = `${origin}/connect`
  } else {
    throw new EndpointConfigurationError(
      `Profile "${profile}" uses a legacy server-only configuration whose auth and connect endpoints are ambiguous. Add "authServer" and "connectPage" explicitly.`,
    )
  }

  const upgraded = { ...settings, authServer, connectPage }
  writeMigratedSettings(configPath, upgraded)
  return upgraded
}

function customServerConfig(profile: string): ServerConfig {
  const configPath = path.join(JERICO_DIR, 'profiles', profile, 'settings.json')
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch {
    throw new EndpointConfigurationError(
      `Profile "${profile}" has no readable endpoint configuration at ${configPath}.`,
    )
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EndpointConfigurationError(`Profile "${profile}" settings must be a JSON object.`)
  }
  const settings = legacyEndpointUpgrade(profile, configPath, raw as Record<string, unknown>)
  const ws = parseEndpoint(settings['server'], 'server', 'wss:', 'ws:')
  const auth = parseEndpoint(settings['authServer'], 'authServer', 'https:', 'http:')
  const connect = parseEndpoint(settings['connectPage'], 'connectPage', 'https:', 'http:')
  if (ws.pathname !== '/ws/daemon' || ws.search || ws.hash) {
    throw new EndpointConfigurationError('Named profile setting "server" must end at /ws/daemon.')
  }
  if ((auth.pathname !== '/' && auth.pathname !== '') || auth.search || auth.hash) {
    throw new EndpointConfigurationError('Named profile setting "authServer" must be an origin without a path.')
  }
  if (connect.search || connect.hash) {
    throw new EndpointConfigurationError('Named profile setting "connectPage" must not contain a query or fragment.')
  }
  return {
    wsUrl: ws.toString(),
    validateHost: auth.hostname,
    validatePort: auth.port ? Number(auth.port) : auth.protocol === 'https:' ? 443 : 80,
    validateSecure: auth.protocol === 'https:',
    authServerUrl: auth.origin,
    connectPageUrl: connect.toString(),
  }
}

/**
 * Server endpoints, profile-aware.
 * - dev profile → local stack (ws://localhost:3100); the dev token is minted on
 *   the local web app, so it is ONLY valid against the local server. Pointing the
 *   dev daemon at prod causes auth-reject crash loops.
 * - prod → the canonical Jerico service.
 */
export function getServerConfig(): ServerConfig {
  const profile = activeProfile()
  if (!profile) return { ...PROD_SERVER_CONFIG }
  if (profile === 'dev') {
    const configPath = path.join(JERICO_DIR, 'profiles', profile, 'settings.json')
    if (fs.existsSync(configPath)) customServerConfig(profile)
    return { ...DEV_SERVER_CONFIG }
  }
  return customServerConfig(profile)
}

export function getWebEndpointConfig(): WebEndpointConfig {
  const config = getServerConfig()
  return {
    homeUrl: new URL('/', config.connectPageUrl).toString(),
    connectPageUrl: config.connectPageUrl,
    privacyUrl: new URL('/privacy', config.connectPageUrl).toString(),
    serverHost: new URL(config.wsUrl).host,
  }
}
