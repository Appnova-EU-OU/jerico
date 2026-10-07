/**
 * env-filter.ts — 4-tier allowlist filter for agent PTY environment.
 *
 * Tier 1: EXACT_ALLOW      → keep  (POSIX + API keys + named safe vars)
 * Tier 2: BRIDGE_ namespace → keep  (BRIDGE_TOKEN, BRIDGE_MCP_URL, etc.)
 * Tier 3: DENY_PATTERNS     → drop  (secret-suffix / secret-name tripwires)
 * Tier 4: PREFIX_ALLOW      → keep  (open-ended families, every entry ends in `_`)
 * DEFAULT                   → drop  (secure default)
 *
 * #427 — Daemon Env Scoping
 */

// ── Tier 1: ALLOWED_EXACT ────────────────────────────────────────────────────
// Every prefix-less variable goes here.  API keys are immune to denylist.

const ALLOWED_EXACT: ReadonlySet<string> = new Set([
  // ── POSIX / shell essentials ──
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'PWD', 'OLDPWD', 'SHLVL',
  'TMPDIR', 'TMP', 'TEMP',

  // ── Locale / terminal (prefix-less) ──
  'TERM', 'COLORTERM', 'LANG', 'TZ',
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID',

  // ── Display ──
  'DISPLAY', 'WAYLAND_DISPLAY',

  // ── macOS internals ──
  '__CFBundleIdentifier', 'COMMAND_MODE',

  // ── The 6 agent API keys — exactly the names agents.ts checkAuth reads ──
  // agents.ts:57  claude      → ANTHROPIC_API_KEY
  // agents.ts:69  codex       → OPENAI_API_KEY
  // agents.ts:90  agy         → GEMINI_API_KEY (fallback; primary auth is OAuth via ~/.gemini/oauth_creds.json)
  // agents.ts:109 aider       → OPENAI_API_KEY || ANTHROPIC_API_KEY
  // agents.ts:117 kimi        → KIMI_API_KEY
  // agents.ts:131 forge       → FORGE_API_KEY
  // agents.ts:141 opencode    → OPENCODE_API_KEY || ANTHROPIC_API_KEY || OPENAI_API_KEY
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'KIMI_API_KEY',
  'FORGE_API_KEY',
  'OPENCODE_API_KEY',

  // ── Agent endpoint + transport switch (URLs, not secrets) ──
  'OLLAMA_HOST',         // ollama endpoint
  'HTTP_MODE',           // mcp-server/src/index.ts:209 transport selector

  // ── Node / npm — exact safe vars ONLY ──
  'NODE_PATH', 'NODE_OPTIONS', 'NODE_ENV',
  'npm_config_global_prefix', 'npm_config_prefix',
  'npm_config_cache', 'npm_config_userconfig',
  'PNPM_HOME', 'BUN_INSTALL', 'VOLTA_HOME',
  'DENO_INSTALL', 'DENO_DIR',

  // ── Python (prefix-less) ──
  'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV',

  // ── Go (prefix-less) ──
  'GOPATH', 'GOROOT', 'GOBIN', 'GOMODCACHE', 'GOPROXY',

  // ── Rust (prefix-less) ──
  'CARGO_HOME', 'RUSTUP_HOME', 'RUST_BACKTRACE',

  // ── Java / Android / Homebrew (prefix-less) ──
  'JAVA_HOME', 'JDK_HOME', 'JRE_HOME',
  'ANDROID_HOME', 'ANDROID_SDK_ROOT',
  'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY',

  // ── Editor / pager (prefix-less) ──
  'EDITOR', 'VISUAL', 'PAGER', 'MANPATH', 'INFOPATH',

  // ── Linux session (prefix-less) ──
  'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE',

  // ── Git identity — NARROWED. Only author/committer metadata.
  //    GIT_SSH_COMMAND / GIT_PROXY_COMMAND / GIT_EXTERNAL_DIFF / GIT_ASKPASS
  //    are exec vectors and are NOT listed → dropped by default.
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',

  // ── Ruby version managers ──
  'RBENV_ROOT', 'RBENV_VERSION',
])

// ── Tier 4: ALLOWED_PREFIXES ─────────────────────────────────────────────────
// Only open-ended families that cannot be fully enumerated.
// EVERY entry ends in `_` — structural safety: no partial-word matches.
// Note: BRIDGE_ is NOT here — it is Tier-2 (before deny).
// Note: ANDROID_ is NOT here — ANDROID_HOME / ANDROID_SDK_ROOT are exact.

const ALLOWED_PREFIXES: readonly string[] = [
  'LC_',       // locale extensions: LC_ALL, LC_CTYPE, LC_NUMERIC, LC_TIME, …
  'XDG_',      // freedesktop dirs: XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, …
  'NVM_',      // nvm: NVM_DIR, NVM_BIN, NVM_INC
  'PYENV_',    // pyenv: PYENV_ROOT, PYENV_VERSION, PYENV_SHELL
  'CONDA_',    // conda: CONDA_PREFIX, CONDA_DEFAULT_ENV, CONDA_EXE
  'ITERM_',    // iTerm2: ITERM_PROFILE, ITERM_SESSION_ID
]

// ── Tier 3: DENIED_PATTERNS ──────────────────────────────────────────────────
// Anchored regex tripwires. Under secure-default-drop, most secrets drop at
// DEFAULT already. The denylist catches secret-suffixed names that could ride
// in on a future/broad prefix (Tier 4), and solo secret names that might
// accidentally be added to exact-allow later.

const DENIED_PATTERNS: readonly RegExp[] = [
  // Bare _KEY suffix — catches XDG_SIGNING_KEY, CONDA_SIGNING_KEY, etc.
  // Safe because Tier 1 (exact-allow) protects the 6 *_API_KEY names first.
  /_KEY$/i,

  // Secret-suffixed names that could ride in on a future/broad prefix.
  // (PRIVATE_KEY, SECRET_KEY, ACCESS_KEY sub-patterns now redundant under _KEY$ above.)
  /_(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|SECRET_KEY|ACCESS_KEY|API_SECRET)$/i,

  // Solo secret names.
  /^(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|SECRET_KEY|ACCESS_KEY|API_SECRET|KEY)$/i,
]

// ── Fail-fast: empty-allowlist guard ─────────────────────────────────────────
// Failing closed means the daemon refuses to start rather than silently
// dropping everything. Checked at module load.

if (ALLOWED_EXACT.size === 0 && ALLOWED_PREFIXES.length === 0) {
  throw new Error(
    '[daemon] env.filter.fail_fast: both ALLOWED_EXACT and ALLOWED_PREFIXES are empty — ' +
    'env scoping would drop everything. This is a build/config error.'
  )
}


// ── Public API ───────────────────────────────────────────────────────────────

export interface FilterResult {
  /** Filtered environment (only allowed keys, guaranteed non-null values). */
  env: Record<string, string>
  /** Names of dropped keys (NEVER log values). */
  dropped: string[]
}

/**
 * Apply the 4-tier allowlist filter to a raw environment object.
 *
 * Pure function — never mutates the source.  Idempotent:
 * `filterEnv(filterEnv(x).env)` deep-equals `filterEnv(x)`.
 *
 * @param source  Raw process env (Record<string, string|undefined>).
 * @returns       Filtered env + list of dropped key names.
 */
/**
 * Claude's subscription-token startup contract needs these three variables.
 * Keep this exception at the filtering boundary and keyed to the actual spawned
 * provider: callers cannot accidentally grant it to another agent.
 */
const CLAUDE_SPAWN_EXACT = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
])

export function filterEnv(source: Record<string, string | undefined>, agentKey?: string): FilterResult {
  const env: Record<string, string> = {}
  const dropped: string[] = []

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue

    // TIER 1 — exact-allow. API keys are immune to denylist.
    if (ALLOWED_EXACT.has(key)) { env[key] = value; continue }

    // TIER 2 — BRIDGE_ namespace. Must beat /_TOKEN$/ denylist.
    if (key.startsWith('BRIDGE_')) { env[key] = value; continue }

    // Narrow, provider-bound exception. In particular, do not make arbitrary
    // *_TOKEN names safe for Claude or any other agent.
    if (agentKey === 'claude' && CLAUDE_SPAWN_EXACT.has(key)) { env[key] = value; continue }

    // TIER 3 — deny. Catches secret-suffixed names before prefix-allow admits them.
    if (DENIED_PATTERNS.some(re => re.test(key))) { dropped.push(key); continue }

    // TIER 4 — prefix-allow. Only genuinely open-ended families ending in `_`.
    if (ALLOWED_PREFIXES.some(p => key.startsWith(p))) { env[key] = value; continue }

    // DEFAULT — drop unknown.
    dropped.push(key)
  }

  // Fallback: if host PATH is missing, empty, or corrupt, inject a safe default.
  if (!env.PATH) {
    env.PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  }

  return { env, dropped }
}
