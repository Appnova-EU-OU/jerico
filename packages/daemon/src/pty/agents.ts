import which from 'which'
import fs from 'fs'
import path from 'path'
import net from 'net'
import { spawnSync } from 'child_process'
import type { AgentKey, AgentInfo, PanelStartupGateKind, StartupGateReason } from '../shared/types.js'
import type { BridgeConfig } from '../config.js'
import type { StartupGateProfile } from '../workspace-trust.js'
import type { TuiReadyProvider } from './tui-ready-scanner.js'

export interface TuiProfile {
  /** How submit is triggered in this agent's TUI. */
  submitMode: 'lf' | 'cr' | 'cr-inline' | 'paste'
  /** Model-agnostic ready signals: first-match against ANSI-stripped output tail. */
  readySignals?: string[]
  /** Raw terminal-protocol readiness scanner. Exactly one scanner is owned by
   * each live panel instance; DECSET 2004 must precede the provider marker. */
  protocolReadyProvider?: TuiReadyProvider
  /** Delay between a positive readiness scan and input authorization. Blocker
   * matching remains active throughout this settle window (default 500 ms). */
  readySettleMs?: number
  /** Additional OR-ed startup blockers. Every descriptor is independently
   * typed and every allOf list is an AND conjunction. Extra blockers never
   * inherit the primary startupGate kind. */
  blockerSignatures?: ReadonlyArray<{
    id: string
    gate: PanelStartupGateKind
    reason: StartupGateReason
    allOf: ReadonlyArray<RegExp>
  }>
  /** Treat the live PTY as ready after it has emitted output and then stayed quiet
   * for this long. Use when the provider exposes no stable structural ready text. */
  readyQuiescenceMs?: number
  /** If present, readiness based on quiescence is only armed if the output tail contains one of these signals. */
  quiescenceSignals?: string[]
  /** Timeout before the readiness fallback fires (default 30_000). */
  readyTimeoutMs?: number
  /** A security-sensitive startup gate to detect and surface, never auto-answer. */
  startupGate?: StartupGateProfile
}

interface AgentSpec {
  key: AgentKey
  displayName: string
  binary: string
  checkAuth: () => Promise<boolean>
  /** Per-agent TUI interaction profile. Absent = no special TUI behavior. */
  tui?: TuiProfile
  /** If true, daemon generates a UUID at spawn and passes --session-id <uuid> to the CLI */
  assignSessionId?: boolean
  /**
   * If true, agent generates its OWN conversation id. Daemon captures it after
   * the first turn via a db set-diff (vs assignSessionId which assigns before spawn).
   */
  captureSessionId?: boolean
  /** Args to always prepend on fresh spawn (before --session-id) */
  spawnArgs?: string[]
  /** Args to prepend when resuming a specific session */
  resumeArgs?: (sessionId: string) => string[]
  /**
   * Transform injection text before writing to the PTY.
   * Responsible for appending the correct line terminator for this agent's TUI.
   * Daemons >= v1.1 apply this; the server sends raw text without a terminator.
   */
  formatInput?: (text: string) => string
  /**
   * Agent-specific version directory globs (relative to HOME).
   * Each entry is a glob pattern; the binary name is appended.
   */
  versionDirGlobs?: string[]
  /** Extra environment variables to set when spawning this agent's PTY. */
  env?: Record<string, string>
  /**
   * Build CLI flag(s) for model selection at spawn time.
   * Returns { args, prepend } where prepend=true means args should be placed
   * before all other args (used by ollama for positional subcommand).
   * Omit or return undefined for agents without launch-model support.
   */
  modelArgs?: (model: string) => { args: string[]; prepend?: boolean }
  /**
   * Build the in-session model-switch command for a RUNNING panel (no respawn).
   * Returns the text to inject plus a delivery mode:
   *  - 'submit': write text then a standalone submit keystroke (appendCR agents
   *    get a deferred \r via scheduleOrchSubmitCR; appendLF raw-REPL agents get
   *    \n via formatInput).
   *  - 'paste': wrap in bracketed-paste + submit \r (kimi — plain inject never submits).
   *  - 'picker': opens an interactive picker (not text-drivable; not used by any
   *    live-enabled agent in v1).
   * Omit for agents with no in-session switch (blocked in v1).
   */
  modelSwitch?: (model: string) => { text: string; mode: 'submit' | 'paste' | 'picker' }
  /**
   * Enumerate the models actually available for this agent ON THIS MACHINE
   * (dynamic, machine-specific — e.g. `opencode models`, `ollama list`).
   * `args` run against the agent's resolved binary; `parse` maps stdout to
   * model-id strings. Ran async after detection (never blocks it); results
   * are reported via agent_models_available and cached ~10 min.
   * Omit for agents with static or impractical lists (aider: hundreds;
   * agy: emits display names like "Gemini 3.5 Flash (Medium)" that are not
   * valid --model values, so it stays freeform).
   */
  listModels?: { args: string[]; parse: (stdout: string) => string[] }
}

// Standard \n terminator — works for readline-based CLIs (sh, Ollama, Aider)
const appendLF = (text: string): string => text + '\n'

// TUI agents that treat \n as soft newline (multi-line mode) and \r as submit.
// Strip any trailing \r/\n first to avoid a double-submit on the last line.
// Applies to: Claude Code, Codex CLI, Qwen CLI, Antigravity, Kimi, Forge, OpenCode.
const appendCR = (text: string): string => text.replace(/[\r\n]+$/, '') + '\r'

const CLAUDE_FLAG_SETTINGS = '{"skipDangerousModePermissionPrompt":true}'

const AGENT_SPECS: AgentSpec[] = [
  {
    key: 'sh',
    displayName: 'Shell',
    binary: 'sh',
    checkAuth: async () => true,
    formatInput: appendLF,
    tui: { submitMode: 'lf' },
  },
  {
    key: 'claude',
    displayName: 'Claude Code',
    binary: 'claude',
    checkAuth: async () => checkDir('.claude') || checkEnv('ANTHROPIC_API_KEY'),
    assignSessionId: true,
    spawnArgs: ['--dangerously-skip-permissions', '--settings', CLAUDE_FLAG_SETTINGS],
    resumeArgs: (id) => ['--dangerously-skip-permissions', '--resume', id, '--settings', CLAUDE_FLAG_SETTINGS],
    formatInput: appendCR,
    tui: {
      submitMode: 'cr',
      protocolReadyProvider: 'claude',
      startupGate: {
        kind: 'workspace_trust',
        allOf: [/trust this folder/i, /no, exit/i],
      },
      blockerSignatures: [
        { id: 'claude-theme', gate: 'unknown_startup', reason: 'prompt_observed', allOf: [/Choose the text style that looks best with your terminal/i] },
        { id: 'claude-dangerous-mode', gate: 'unknown_startup', reason: 'prompt_observed', allOf: [/WARNING: Claude Code running in Bypass Permissions mode/i] },
        { id: 'claude-mcp-approval', gate: 'unknown_startup', reason: 'prompt_observed', allOf: [/New MCP server found in this project/i] },
        // Claude's first-run workspace trust menu. Its selection cursor is the
        // same U+276F the composer uses, so the protocol scanner reads it as
        // readiness; without this signature the panel "readies" on the dialog
        // and the queued greeting is typed into it — Enter lands on the
        // default "No, exit" and the session dies with code 1. Measured on
        // 2.1.250. Claude draws the menu with cursor motion rather than
        // spaces, so the stripped tail arrives unspaced: match with \s*.
        {
          id: 'claude-workspace-trust',
          gate: 'workspace_trust',
          reason: 'prompt_observed',
          allOf: [/Quick\s*safety\s*check/i, /Yes,?\s*I\s*trust\s*this\s*folder/i],
        },
      ],
    },
    versionDirGlobs: ['.local/share/claude/versions/*'],
    modelArgs: (model) => ({ args: ['--model', model] }),
    modelSwitch: (model) => ({ text: `/model ${model}`, mode: 'submit' }),
  },
  {
    key: 'codex',
    displayName: 'Codex CLI',
    binary: 'codex',
    checkAuth: async () => checkCodexAuth(),
    // Full access, matching how every other agent here is spawned (claude/gemini
    // --dangerously-skip-permissions, qwen/kimi/opencode --yolo). The previous
    // workspace-write sandbox denied writes outside the project and blocked network,
    // so a worker hit approval/sandbox failures the orchestrator could not answer:
    // nothing is watching a codex panel for an approval prompt, so the task just stalled.
    spawnArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    resumeArgs: (id) => ['resume', id, '--dangerously-bypass-approvals-and-sandbox'],
    formatInput: appendCR,
    tui: {
      submitMode: 'cr',
      protocolReadyProvider: 'codex',
      readySettleMs: 2_000,
      readyTimeoutMs: 30_000,
      startupGate: {
        kind: 'workspace_trust',
        allOf: [/Yes, proceed/i, /Yes, and allow this/i],
      },
      blockerSignatures: [
        { id: 'codex-auth-welcome', gate: 'authentication', reason: 'authentication_required', allOf: [/Welcome\s*to\s*Codex[-,\s]*OpenAI(?:['’]s|-)\s*command-line[-\s]*coding[-\s]*agent/i] },
        { id: 'codex-auth-api-key', gate: 'authentication', reason: 'authentication_required', allOf: [/Provide\s*your\s*own\s*API\s*key/i] },
        {
          id: 'codex-workspace-trust-v150',
          gate: 'workspace_trust',
          reason: 'prompt_observed',
          allOf: [
            /Do\s*you\s*trust\s*the\s*contents\s*of\s*this\s*directory\?/i,
            /Yes,?\s*continue/i,
          ],
        },
      ],
    },
    modelArgs: (model) => ({ args: ['-m', model] }),
    listModels: {
      args: ['debug', 'models'],
      parse: (stdout) => {
        try {
          const json = JSON.parse(stdout)
          if (Array.isArray(json?.models)) {
            return json.models
              .filter((m: any) => m && m.slug && m.visibility !== 'hide')
              .map((m: any) => String(m.slug))
          }
        } catch {}
        return []
      },
    },
    // codex exposes model switch only via an interactive "Select Model and Effort"
    // picker (no text-drivable /model command) — blocked in v1; no modelSwitch.
  },
  {
    key: 'qwen',
    displayName: 'Qwen CLI',
    binary: 'qwen',
    checkAuth: async () => checkDir('.qwen'),
    assignSessionId: true,
    spawnArgs: ['--yolo'],
    resumeArgs: (id) => ['--resume', id, '--yolo'],
    formatInput: appendCR,
    // Qwen emits DECSET 2004 while its v0.24.4 UI is still Initializing, so
    // the scanner requires it first and then the captured editable-composer
    // placeholder. Until then all orchestrator input remains daemon-buffered.
    tui: { submitMode: 'cr', protocolReadyProvider: 'qwen' },
    versionDirGlobs: ['.local/share/qwen/versions/*'],
    modelArgs: (model) => ({ args: ['-m', model] }),
    // Live-verify group: implemented but gated OFF (not in IN_SESSION_MODEL_SWITCH_ENABLED).
    modelSwitch: (model) => ({ text: `/model ${model}`, mode: 'submit' }),
  },
  {
    key: 'agy',
    displayName: 'Antigravity',
    binary: 'agy',
    // The Antigravity CLI's OWN token first. `~/.gemini/oauth_creds.json` is the
    // Gemini CLI's file and signing into `agy` does not touch it — measured
    // 2026-08-11: an `agy` sign-in wrote
    // ~/.gemini/antigravity-cli/antigravity-oauth-token while oauth_creds.json
    // stayed at its 25 June mtime with a token that had expired on 26 June and
    // that the quota endpoint answers 401 for. So checking only the Gemini file
    // passed this agent as authenticated on the strength of an unrelated,
    // six-week-stale credential. The Gemini file stays as a fallback because a
    // user who signed in with the Gemini CLI genuinely has one.
    checkAuth: async () =>
      checkFile('.gemini/antigravity-cli/antigravity-oauth-token') ||
      checkFile('.gemini/oauth_creds.json') ||
      checkEnv('GEMINI_API_KEY'),
    spawnArgs: ['--dangerously-skip-permissions'],
    captureSessionId: true,
    resumeArgs: (id) => ['--dangerously-skip-permissions', '--conversation', id],
    formatInput: appendCR,
    tui: {
      submitMode: 'cr-inline',
      protocolReadyProvider: 'agy',
      blockerSignatures: [
        // Evidence boundary: the unsigned layout is the exact supplied
        // two-literal conjunction. Do not loosen it until reviewed raw and
        // production-sanitized captures exist.
        {
          id: 'agy-auth-unsigned-menu',
          gate: 'authentication',
          reason: 'authentication_required',
          allOf: [
            /Welcome to the Antigravity CLI\. You are currently not signed in\./i,
            /Select login method:/i,
          ],
        },
        { id: 'agy-auth-oauth-flow', gate: 'authentication', reason: 'authentication_required', allOf: [/Starting OAuth authentication flow/i] },
      ],
    },
    versionDirGlobs: ['.local/bin'],
    modelArgs: (model) => ({ args: ['--model', model] }),
    // Live-verify group: /model likely opens a picker (not confirmed direct-set); gated OFF.
    modelSwitch: (model) => ({ text: `/model ${model}`, mode: 'submit' }),
  },
  {
    key: 'ollama',
    displayName: 'Ollama',
    binary: 'ollama',
    checkAuth: async () => checkPort(11434),
    formatInput: appendLF,
    // `ollama run <model>` prints this prompt only after its REPL is reading.
    // Gate the spawn-time role/trust turn on that signal instead of writing it
    // synchronously into a process that may not yet accept stdin.
    tui: { submitMode: 'lf', readySignals: ['>>> '] },
    modelArgs: (model) => ({ args: ['run', model], prepend: true }),
    modelSwitch: (model) => ({ text: `/load ${model}`, mode: 'submit' }),
    // `ollama list` → header row then "NAME  ID  SIZE  MODIFIED"; first column is model:tag
    listModels: {
      args: ['list'],
      parse: (stdout) => stdout.split('\n').slice(1).map(l => l.split(/\s+/)[0] ?? '').filter(Boolean),
    },
  },
  {
    key: 'aider',
    displayName: 'Aider',
    binary: 'aider',
    checkAuth: async () => checkEnv('OPENAI_API_KEY') || checkEnv('ANTHROPIC_API_KEY'),
    formatInput: appendLF,
    tui: { submitMode: 'lf' },
    modelArgs: (model) => ({ args: ['--model', model] }),
    modelSwitch: (model) => ({ text: `/model ${model}`, mode: 'submit' }),
  },
  {
    key: 'kimi',
    displayName: 'Kimi Code',
    binary: 'kimi',
    // Issue #91: the runtime is `kimi-code` (config dir ~/.kimi-code, binary
    // ~/.kimi-code/bin/kimi), not the old Python `kimi-cli` — checkAuth/versionDirGlobs
    // below previously targeted the old CLI's paths. Kimi has also removed two
    // different ready strings across releases ('kimi-for-coding', then
    // 'ctrl+c: cancel'). Its prompt becomes quiet when it is driveable, so readiness
    // uses output quiescence rather than decorative footer copy.
    checkAuth: async () => checkFile('.kimi-code/credentials/kimi-code.json') || checkEnv('KIMI_API_KEY'),
    captureSessionId: true,
    spawnArgs: ['--yolo'],
    resumeArgs: (id) => ['-r', id, '--yolo'],
    // NOTE: Kimi does not support --system-prompt-file
    // Role prompts disabled via buildRolePromptArgs()
    formatInput: appendCR,
    tui: {
      submitMode: 'paste',
      readyQuiescenceMs: 3_000,
      quiescenceSignals: ['context:'],
      readyTimeoutMs: 30_000,
      startupGate: {
        kind: 'workspace_trust',
        allOf: [/Trust this folder/i, /Don't trust/i, /Enable project MCP servers/i, /Exit Kimi Code/i],
      },
    },
    versionDirGlobs: ['.kimi-code/bin'],
    modelArgs: (model) => ({ args: ['-m', model] }),
    // kimi: /model exists but plain PTY inject never submits — bracketed-paste path.
    // Blocked in v1 (not in IN_SESSION_MODEL_SWITCH_ENABLED); live-verify required.
    modelSwitch: (model) => ({ text: `/model ${model}`, mode: 'paste' }),
  },
  {
    key: 'forge',
    displayName: 'Forge',
    binary: 'forge',
    checkAuth: async () => checkDir('.forge/.credentials.json') || checkEnv('FORGE_API_KEY'),
    assignSessionId: true,
    resumeArgs: (id) => ['--conversation-id', id],
    formatInput: appendCR,
    tui: { submitMode: 'cr' },
    env: { CI: '1' },
  },
  {
    key: 'opencode',
    displayName: 'OpenCode',
    binary: 'opencode',
    checkAuth: async () => checkDir('.config/opencode') || checkEnv('OPENCODE_API_KEY') || checkEnv('ANTHROPIC_API_KEY') || checkEnv('OPENAI_API_KEY'),
    formatInput: appendCR,
    tui: { submitMode: 'cr', protocolReadyProvider: 'opencode' },
    versionDirGlobs: ['.opencode/bin'],
    env: { OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}' },
    modelArgs: (model) => ({ args: ['-m', model] }),
    // `opencode models` → one provider/model id per line (~dozens, machine-specific)
    listModels: {
      args: ['models'],
      parse: (stdout) => stdout.split('\n').map(l => l.trim()).filter(Boolean),
    },
  },
  {
    key: 'copilot',
    displayName: 'GitHub Copilot',
    binary: 'copilot',
    checkAuth: async () => {
      const hostsYml = path.join(process.env['HOME'] ?? '', '.config', 'gh', 'hosts.yml')
      try {
        return fs.existsSync(hostsYml) && fs.readFileSync(hostsYml, 'utf8').includes('oauth_token:')
      } catch {
        return false
      }
    },
    assignSessionId: true,
    spawnArgs: ['--yolo'],
    resumeArgs: (id) => ['--yolo', '--session-id', id],
    formatInput: appendCR,
    tui: { submitMode: 'cr' },
    versionDirGlobs: [
      '.npm-global/bin/copilot',
      '.local/share/npm/bin/copilot',
      '.local/bin/copilot',
    ],
    modelArgs: (model) => ({ args: ['--model', model] }),
  },
]

export { AGENT_SPECS }
export type { AgentSpec }

// ── Version detection helpers ────────────────────────────────────────────────

const HOME = process.env['HOME'] ?? '/Users/unknown'

/** Run `binary --version` and return the first non-empty stdout line, or undefined on failure. */
function getVersionFromBinary(binaryPath: string): string | undefined {
  try {
    const r = spawnSync(binaryPath, ['--version'], { timeout: 5000 })
    if (r.status !== 0) return undefined
    const firstLine = (r.stdout ?? r.stderr ?? Buffer.from(''))
      .toString('utf8')
      .split('\n')[0]!
      .trim()
    return firstLine || undefined
  } catch {
    return undefined
  }
}

/**
 * Scan agent-specific version directories for a working binary.
 * Returns candidates in order they should be tried (newest first).
 */
/**
 * Whether the daemon watches a startup gate for this agent at all.
 *
 * Derived from AGENT_SPECS rather than from a list, and it lives here rather
 * than in the WS client because two things now need the answer: the readiness
 * machinery that arms the gate, and `/health`, which has to say whether a panel
 * without a gate is un-monitored or merely un-reported. A second copy of this
 * predicate would drift from the specs, which is the failure this whole change
 * is cleaning up.
 */
export function getTuiProfile(agentKey: string | undefined): TuiProfile | undefined {
  return agentKey ? AGENT_SPECS.find(s => s.key === agentKey)?.tui : undefined
}

export function hasTuiReadinessCriterion(agentKey: string | undefined): boolean {
  const profile = getTuiProfile(agentKey)
  return profile?.protocolReadyProvider !== undefined
    || (profile?.readySignals?.length ?? 0) > 0
    || (profile?.readyQuiescenceMs ?? 0) > 0
}

export function isTuiStartupMonitored(agentKey: string | undefined): boolean {
  const profile = getTuiProfile(agentKey)
  return profile !== undefined && (profile.startupGate !== undefined || hasTuiReadinessCriterion(agentKey))
}

function scanVersionDirs(spec: AgentSpec): { path: string; version?: string }[] {
  if (!spec.versionDirGlobs?.length) return []

  // Use a simple glob-style scan — no extra dependencies needed
  const results: { path: string; version?: string }[] = []
  const patterns = spec.versionDirGlobs

  for (const pattern of patterns) {
    const baseDir = path.join(HOME, pattern.replace(/\/\*$/, ''))
    // If pattern ends in /*, scan that directory for versions
    if (pattern.endsWith('/*')) {
      let entries: string[] = []
      try {
        entries = fs.readdirSync(baseDir)
      } catch { /* dir doesn't exist */ }

      // Sort newest-first (assuming version numbers in dir names)
      entries.sort((a, b) => b.localeCompare(a))

      for (const entry of entries) {
        const candidate = path.join(baseDir, entry, spec.binary)
        if (fs.existsSync(candidate)) {
          const version = getVersionFromBinary(candidate)
          results.push({ path: candidate, version })
        }
      }
    } else {
      // Literal path — either the binary itself (e.g. ~/.local/share/uv/tools/kimi-cli/bin/kimi)
      // or a directory that contains it (e.g. ~/.opencode/bin → ~/.opencode/bin/opencode).
      // If it resolves to a directory, append the binary name so installer-default
      // bin dirs that are absent from the launchd daemon's PATH still get detected.
      let candidate = path.join(HOME, pattern)
      try {
        if (fs.statSync(candidate).isDirectory()) {
          candidate = path.join(candidate, spec.binary)
        }
      } catch { /* path doesn't exist — existsSync below handles it */ }
      if (fs.existsSync(candidate)) {
        const version = getVersionFromBinary(candidate)
        results.push({ path: candidate, version })
      }
    }
  }

  return results
}

/**
 * Resolve the best working binary for an agent.
 *
 * Priority order:
 *  1. Config override (global agentPaths from BridgeConfig)
 *  2. which() result + spawnSync --version validation
 *  3. Version directory scan (newest first) + spawnSync validation
 *
 * Returns { path, version } or throws if no working binary found.
 */
async function resolveAgentBinary(
  spec: AgentSpec,
  globalAgentPaths: Record<string, string> = {},
): Promise<{ path: string; version?: string }> {
  // 1. Config override
  if (globalAgentPaths[spec.key]) {
    const override = globalAgentPaths[spec.key]!
    const version = getVersionFromBinary(override)
    if (version) return { path: override, version }
  }

  // 2. which() + spawnSync validation
  try {
    const whichPath = await which(spec.binary)
    if (whichPath && fs.existsSync(whichPath)) {
      const version = getVersionFromBinary(whichPath)
      if (version !== undefined) {
        return { path: whichPath, version }
      }
    }
  } catch { /* not in PATH */ }

  // 3. Version directory scan
  const candidates = scanVersionDirs(spec)
  for (const candidate of candidates) {
    if (candidate.version !== undefined) {
      return candidate
    }
  }

  // Last resort: which() result even if --version failed (backward compat)
  try {
    const whichPath = await which(spec.binary)
    if (whichPath) return { path: whichPath }
  } catch { /* not in PATH */ }

  throw new Error(`No working binary found for agent '${spec.key}'`)
}

export async function detectAgents(globalAgentPaths: Record<string, string> = {}): Promise<AgentInfo[]> {
  const results: AgentInfo[] = []
  for (const spec of AGENT_SPECS) {
    try {
      const { path: binaryPath, version } = await resolveAgentBinary(spec, globalAgentPaths)
      const authOk = await spec.checkAuth()
      const authStatus = authOk ? 'ok' : 'missing'
      results.push({ key: spec.key, displayName: spec.displayName, binaryPath, authStatus, version })
    } catch {
      // binary not found or not spawnable — skip
    }
  }
  console.log('[daemon] agent.detect.done', {
    found: results.map(a => a.key),
    missing: AGENT_SPECS.map(s => s.key).filter(k => !results.find(r => r.key === k)),
  })
  return results
}

function checkDir(name: string): boolean {
  return fs.existsSync(path.join(process.env['HOME'] ?? '', name))
}

function checkFile(name: string): boolean {
  try {
    const p = path.join(process.env['HOME'] ?? '', name)
    return fs.existsSync(p) && fs.statSync(p).size > 0
  } catch {
    return false
  }
}

function checkEnv(key: string): boolean {
  return !!process.env[key]
}

async function checkPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(port, '127.0.0.1')
    s.setTimeout(200)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    s.on('timeout', () => { s.destroy(); resolve(false) })
  })
}

async function checkCodexAuth(): Promise<boolean> {
  if (checkEnv('OPENAI_API_KEY')) return true
  if (checkFile('.codex/auth.json')) return true
  try {
    const r = spawnSync('codex', ['login', 'status'], { timeout: 3000 })
    if (r.status === 0) {
      const out = (r.stdout ?? Buffer.from('')).toString('utf8')
      if (out.toLowerCase().includes('logged in')) return true
    }
  } catch {
    /* ignore */
  }
  return false
}
