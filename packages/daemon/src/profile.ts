/**
 * SINGLE SOURCE OF TRUTH for all profile-derived daemon paths.
 *
 * CONVENTION: when adding any new daemon state file under ~/.jerico/ or ~/.bridge/,
 * add its path getter here FIRST. Call sites must import from this module —
 * never derive profile paths inline.
 *
 * Profile name is read from process.env.BRIDGE_PROFILE at call time (not module load time)
 * so that the --profile CLI flag (set via preAction hook in index.ts) is always visible.
 */

import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import path from 'path'

// Bun caches os.homedir() at process startup, unlike Node on POSIX. Tests and
// callers that deliberately isolate HOME therefore need the environment value
// read at call time rather than Bun's stale cache.
function currentHome(): string {
  return process.env['HOME'] || homedir()
}

function jericoDir(): string {
  return path.join(currentHome(), '.jerico')
}

const SAFE_PROFILE_RE = /^[a-zA-Z0-9-]+$/

export interface BuiltInProfileEndpoints {
  server: string
  authServer: string
  connectPage: string
}

const BUILT_IN_PROFILE_ENDPOINTS: Readonly<Record<string, BuiltInProfileEndpoints>> = {
  dev: {
    server: 'ws://localhost:3100/ws/daemon',
    authServer: 'http://localhost:3100',
    connectPage: 'http://localhost:5174/connect',
  },
}

export function getBuiltInProfileEndpoints(profile: string): BuiltInProfileEndpoints | null {
  return BUILT_IN_PROFILE_ENDPOINTS[profile] ?? null
}

function activeProfile(): string | undefined {
  const p = process.env['BRIDGE_PROFILE'] || undefined
  if (p !== undefined && !SAFE_PROFILE_RE.test(p)) {
    console.error(`[bridge] profile.invalid — BRIDGE_PROFILE "${p}" contains unsafe characters (allowed: a-z A-Z 0-9 -)`)
    process.exit(1)
  }
  return p
}

/** The active profile name, or null for the unnamed prod profile. Exported so
 *  /health can state which daemon is answering. */
export function getActiveProfile(): string | null {
  return activeProfile() ?? null
}

/** Config file: ~/.jerico/settings.json or ~/.jerico/profiles/<p>/settings.json */
export function getConfigPath(): string {
  const p = activeProfile()
  if (!p) return path.join(jericoDir(), 'settings.json')
  return path.join(jericoDir(), 'profiles', p, 'settings.json')
}

/** Daemon-private completion evidence root for the active profile. */
export function getCompletionEvidenceRoot(): string {
  const p = activeProfile()
  if (!p) return path.join(jericoDir(), 'completion-evidence')
  return path.join(jericoDir(), 'profiles', p, 'completion-evidence')
}

/** Durable scheduled-removal exclusions, isolated from other daemon profiles. */
export function getScheduledRemovalJournalPath(): string {
  return path.join(path.dirname(getConfigPath()), 'scheduled-removal-reservations.json')
}

/** Daemon-local native session role index, isolated with the active profile. */
export function sessionRolesPath(): string {
  return path.join(path.dirname(getConfigPath()), 'session-roles.jsonl')
}

/** Local-only, profile-isolated startup diagnostics. The production unnamed
 * profile is never eligible for the opt-in Agy capture, but keeping path
 * derivation here preserves the single-source-of-truth invariant. */
export function getStartupDiagnosticsDir(): string {
  const p = activeProfile()
  if (!p) return path.join(jericoDir(), 'diagnostics')
  return path.join(jericoDir(), 'profiles', p, 'diagnostics')
}

/** Lock file: ~/.bridge/daemon.lock or ~/.bridge/<p>.daemon.lock */
export function getLockPath(): string {
  const p = activeProfile()
  const filename = p ? `${p}.daemon.lock` : 'daemon.lock'
  return path.join(currentHome(), '.bridge', filename)
}

/** Hook endpoint descriptor: ~/.bridge/agent-hook-endpoint.json or ~/.bridge/agent-hook-endpoint-<p>.json */
export function getHookEndpointPath(): string {
  const p = activeProfile()
  const filename = p ? `agent-hook-endpoint-${p}.json` : 'agent-hook-endpoint.json'
  return path.join(currentHome(), '.bridge', filename)
}

/** Opt-in extra MCP servers for panels:
 *  ~/.bridge/extra-mcp.json  or  ~/.bridge/extra-mcp-<p>.json  (#626)
 *
 *  Deliberately under ~/.bridge (the user's own home), never inside a project
 *  checkout: panels spawn claude with --dangerously-skip-permissions
 *  (pty/agents.ts), so a repo-supplied server definition would be an arbitrary
 *  command executed on checkout alone. This file is the user's explicit
 *  allowlist and nothing else feeds it. */
export function getExtraMcpConfigPath(): string {
  const p = activeProfile()
  const filename = p ? `extra-mcp-${p}.json` : 'extra-mcp.json'
  return path.join(currentHome(), '.bridge', filename)
}

/** Global hook artifacts are intentionally profile-independent: one provider
 * config invokes one script, which selects the live panel from its environment. */
export function getGlobalHooksDir(): string {
  return path.join(currentHome(), '.jerico', 'hooks')
}

export function getHookScriptPath(): string {
  return path.join(getGlobalHooksDir(), 'jerico-hook.sh')
}

/** OpenCode config root owned by this daemon profile. OpenCode discovers
 * plugins under <config>/plugin/, so this must never point at the user's
 * project or at their ordinary ~/.config/opencode directory. */
export function getOpenCodeConfigDir(): string {
  const p = activeProfile()
  if (!p) return path.join(jericoDir(), 'opencode')
  return path.join(jericoDir(), 'profiles', p, 'opencode')
}

/** Codex trust keys ledger: ~/.jerico/codex-trust-keys.json or ~/.jerico/profiles/<p>/codex-trust-keys.json */
export function getCodexTrustLedgerPath(): string {
  if (process.env.JERICO_CODEX_TRUST_LEDGER_PATH) {
    return process.env.JERICO_CODEX_TRUST_LEDGER_PATH
  }
  const p = activeProfile()
  if (!p) return path.join(jericoDir(), 'codex-trust-keys.json')
  return path.join(jericoDir(), 'profiles', p, 'codex-trust-keys.json')
}


/** launchd plist name: com.jerico.bridge-agent[.<p>].plist */
export function getPlistName(): string {
  const p = activeProfile()
  return p ? `com.jerico.bridge-agent.${p}.plist` : 'com.jerico.bridge-agent.plist'
}

/** Log file paths: ~/bridge-daemon[.<p>].{log,err.log,lifecycle.log} */
export function getLogPaths(): { out: string; err: string; lifecycle: string } {
  const p = activeProfile()
  const suffix = p ? `-${p}` : ''
  return {
    out: path.join(currentHome(), `bridge-daemon${suffix}.log`),
    err: path.join(currentHome(), `bridge-daemon${suffix}.err.log`),
    lifecycle: path.join(currentHome(), `bridge-daemon${suffix}.lifecycle.log`),
  }
}

/** Spawn manifest: ~/.bridge/spawn-manifest[.<p>].json */
export function getSpawnManifestPath(): string {
  const p = activeProfile()
  const filename = p ? `spawn-manifest-${p}.json` : 'spawn-manifest.json'
  return path.join(currentHome(), '.bridge', filename)
}

/** First-launch marker owned by the active desktop/daemon profile. */
export function getIntroSeenPath(): string {
  return path.join(path.dirname(getConfigPath()), 'intro-seen')
}

/** The packaged daemon's MCP wrapper is machine-shared, not profile-specific. */
export function getSharedMcpWrapperPath(): string {
  return path.join(currentHome(), '.bridge', 'bin', 'bridge-mcp')
}

/** True only when removing the active profile cannot strand another profile's
 * packaged MCP wrapper. A profile is considered installed when its settings
 * file exists. */
export function canRemoveSharedMcpWrapper(): boolean {
  const active = activeProfile()
  const prodInstalled = active !== undefined && existsSync(path.join(jericoDir(), 'settings.json'))
  if (prodInstalled) return false
  return !getAllProfileNames().some((name) => name !== active && existsSync(path.join(jericoDir(), 'profiles', name, 'settings.json')))
}

/** Health port. 3101 for prod and 3102 for `dev` are fixed points — they are
 *  written into existing plists, into the developer docs and into the desktop app, and
 *  moving them would strand every install that already has one.
 *
 *  Everything else gets its own port derived from its name. It used to be
 *  "3102 for ANY named profile", which meant two named profiles silently shared
 *  one port: the second daemon fails to bind, and anything polling 3102 — the
 *  desktop tray, the wizard, the FDA dialog — reads the FIRST daemon's health and
 *  believes it is its own. That is how a healthy setup gets bounced back to the
 *  sign-in screen because a different profile's daemon was unhappy. */
export function getHealthPort(): number {
  const explicit = process.env['HEALTH_PORT']
  if (explicit) {
    const n = parseInt(explicit, 10)
    if (Number.isFinite(n)) return n
  }
  const p = activeProfile()
  if (!p) return 3101
  if (p === 'dev') return 3102
  // FNV-1a over the profile name, into 3103..3199. Deterministic, so the
  // daemon and the desktop agree without passing anything between them.
  let h = 0x811c9dc5
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return 3103 + (h % 97)
}

/** Wrapper script path: ~/.bridge/bridge-agent-wrapper[-<profile>].sh */
export function getWrapperPath(): string {
  const p = activeProfile()
  return path.join(currentHome(), '.bridge', p ? `bridge-agent-wrapper-${p}.sh` : 'bridge-agent-wrapper.sh')
}

/**
 * Keychain account name for the active profile.
 * Named profiles use the profile name; prod (no profile) uses 'default'.
 */
export function getKeychainAccount(): string {
  const p = activeProfile()
  return p === 'default' ? 'profile:default' : (p ?? 'default')
}

/**
 * List all profile names found under ~/.jerico/profiles/.
 * Returns empty array if the directory does not exist.
 */
export function getAllProfileNames(): string[] {
  const profilesDir = path.join(jericoDir(), 'profiles')
  if (!existsSync(profilesDir)) return []
  try {
    return readdirSync(profilesDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && SAFE_PROFILE_RE.test(e.name))
      .map(e => e.name)
  } catch {
    return []
  }
}

/**
 * Salt appended to machineFingerprint hash input to isolate dev/prod fingerprints.
 * Empty string for prod (default) — preserves existing prod fingerprint values.
 */
export function getProfileSalt(): string {
  const p = activeProfile()
  return p ? `:profile:${p}` : ''
}

/** Auth-failure flag file: ~/.bridge/auth-failed[-<profile>] */
export function getAuthFailedFlagPath(): string {
  const p = activeProfile()
  const filename = p ? `auth-failed-${p}` : 'auth-failed'
  return path.join(currentHome(), '.bridge', filename)
}

/**
 * Rejected-endpoint flag file: ~/.bridge/endpoint-rejected[-<profile>]
 *
 * Mirrors the auth-failure flag deliberately (#571). The daemon that refuses a
 * configured endpoint stays alive and silent otherwise — it has no UI — so the
 * reason has to be somewhere findable: this file holds the code, the sentence
 * and the redacted value, and /health reports the same three.
 */
export function getEndpointRejectedFlagPath(): string {
  const p = activeProfile()
  const filename = p ? `endpoint-rejected-${p}` : 'endpoint-rejected'
  return path.join(currentHome(), '.bridge', filename)
}

/**
 * Codegraph adoption log directory. The engine defaults to ~/.jerico/codegraph,
 * but we isolate it per profile so dev + prod daemons on the same machine do not
 * collide. Passed to the codegraph child as CODEGRAPH_ADOPTION_DIR.
 */
export function getCodegraphDir(): string {
  const p = activeProfile()
  if (!p) return path.join(jericoDir(), 'codegraph')
  return path.join(jericoDir(), 'profiles', p, 'codegraph')
}

/**
 * DELIBERATE GLOBAL EXCEPTION: ~/.bridge/update-lock and ~/.bridge/update-state.json
 * are NOT profile-isolated. Self-update replaces the npm global binary itself,
 * which is a machine-level operation — profile isolation would create a confusing
 * half-state where the binary changed but only one profile knows about it.
 * The update command (commands/update.ts) references these paths directly.
 */

/** All file artifacts created by this daemon profile, in safe removal order. */
export function getAllArtifactPaths(): {
  plist: string
  wrapper: string
  lock: string
  hookDescriptor: string
  logOut: string
  logErr: string
  logLifecycle: string
  spawnManifest: string
  introSeen: string
  sharedMcpWrapper: string
  config: string
  completionEvidenceRoot: string
  updateLock: string | null
  updateState: string | null
  hookScript: string | null
} {
  const p = activeProfile()
  const plistName = p ? `com.jerico.bridge-agent.${p}.plist` : 'com.jerico.bridge-agent.plist'
  const updateLockPath = path.join(currentHome(), '.bridge', 'update.lock')
  const updateStatePath = path.join(currentHome(), '.bridge', 'update-state.json')
  return {
    plist:       path.join(currentHome(), 'Library', 'LaunchAgents', plistName),
    wrapper:     getWrapperPath(),
    lock:        getLockPath(),
    hookDescriptor: getHookEndpointPath(),
    logOut:      getLogPaths().out,
    logErr:      getLogPaths().err,
    logLifecycle: getLogPaths().lifecycle,
    spawnManifest: getSpawnManifestPath(),
    introSeen: getIntroSeenPath(),
    sharedMcpWrapper: getSharedMcpWrapperPath(),
    config:      getConfigPath(),
    completionEvidenceRoot: getCompletionEvidenceRoot(),
    updateLock:  p ? null : updateLockPath,
    updateState: p ? null : updateStatePath,
    hookScript:  p ? null : getHookScriptPath(),
  }
}
