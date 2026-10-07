// ============================================================================
// SHARED TYPES - Single Source of Truth
// ============================================================================
// These types are used across all Jerico packages:
// - daemon, server, web, mcp-server
// 
// DO NOT modify these without updating ALL consumers!
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Agent Types
// ─────────────────────────────────────────────────────────────────────────────

/** 
 * All supported AI agent CLI tools in Jerico.
 * This is the SINGLE SOURCE OF TRUTH for agent keys.
 * 
 * To add a new agent:
 * 1. Add to this union type
 * 2. Add to AGENT_LABELS below
 * 3. Add agent spec in packages/daemon/src/pty/agents.ts
 */
export type AgentKey = 
  | 'sh' 
  | 'claude' 
  | 'codex' 
  | 'qwen' 
  | 'kimi' 
  | 'agy'
  | 'ollama' 
  | 'aider'
  | 'forge'
  | 'opencode'
  | 'copilot'
  | 'sim_ios'

/** Array of all agent keys for iteration */
export const ALL_AGENT_KEYS: AgentKey[] = [
  'sh', 'claude', 'codex', 'qwen', 'kimi', 'agy', 'ollama', 'aider', 'forge', 'opencode', 'copilot', 'sim_ios'
]

/** AI agents only (excludes shell) */
export const AI_AGENT_KEYS: AgentKey[] = [
  'claude', 'codex', 'qwen', 'kimi', 'agy', 'ollama', 'aider', 'forge', 'opencode', 'copilot'
]

/** Shell/script agents */
export const SHELL_AGENT_KEYS: AgentKey[] = ['sh']

// Issue #85: the closed keystroke enum for bridge_send_keys. Deliberately
// closed (not free text, not a `raw: true` escape hatch) — the byte mapping
// (see daemon SEND_KEY_BYTES) contains no `[` or `]`, so no sequence of
// allowed keys can compose a CSI escape sequence or spell a reserved
// provenance marker (`⟦bridge:inject⟧` needs U+27E6/U+27E7, `[BRIDGE-ORCH]`
// needs `[`/`]` — neither reachable). Sufficient for the incident class
// (numbered menus, y/n confirms, arrow-nav selects, space-toggle checkboxes)
// without opening a general text-injection channel. Adding any new key
// requires re-running that composition analysis first.
export const SEND_KEYS = [
  'enter', 'escape', 'up', 'down', 'left', 'right', 'tab', 'space', 'y', 'n',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
] as const
export type SendKey = typeof SEND_KEYS[number]
export const SEND_KEYS_SET: ReadonlySet<string> = new Set(SEND_KEYS)

/** Agents that support MCP (Model Context Protocol) */
export const MCP_ENABLED_AGENTS: AgentKey[] = [
  'claude', 'codex', 'qwen', 'kimi', 'agy', 'forge', 'opencode', 'copilot'
]

/** Agents that support session resume */
export const SESSION_CAPABLE_AGENTS: AgentKey[] = [
  'claude', 'qwen', 'kimi', 'forge', 'copilot', 'agy'
]

/**
 * Agents the daemon can install a lifecycle hook for — the single source of
 * truth for "is this a hook target".
 *
 * Both sides of the wire derive from this list: the daemon's `HOOK_TARGETS`
 * (packages/daemon/src/hooks/targets.ts) and the server's inbound validation in
 * `parseAgentHookEvent` (the server's orchestrator output tap). They were
 * two independent hardcoded lists once, and they drifted — the server silently
 * dropped every `codex` and `agy` turn-end event while the daemon happily
 * installed and sealed them. Adding a hook target means adding it here, once.
 */
export const HOOK_CAPABLE_AGENT_KEYS = ['claude', 'kimi', 'codex', 'opencode', 'agy'] as const
export type HookCapableAgentKey = typeof HOOK_CAPABLE_AGENT_KEYS[number]
export const HOOK_CAPABLE_AGENT_KEYS_SET: ReadonlySet<string> = new Set(HOOK_CAPABLE_AGENT_KEYS)

/** Compile-time proof that every hook target is a real agent key. */
const _hookTargetsAreAgentKeys: readonly AgentKey[] = HOOK_CAPABLE_AGENT_KEYS
void _hookTargetsAreAgentKeys

export function isHookCapableAgent(key: string): key is HookCapableAgentKey {
  return HOOK_CAPABLE_AGENT_KEYS_SET.has(key)
}

/**
 * Delay (ms) before the standalone submit carriage-return sent after a TUI paste
 * injection. Paste buffers on slower machines need time to settle before the \r
 * keystroke can act as a submit rather than landing inside the buffer.
 */
export const TUI_SUBMIT_DELAY_MS = 1000

/**
 * The daemon's internal deadline for attempting to force a submit of PTY output.
 * If this time is exceeded, the daemon abandons the wait and fails the submit.
 */
export const FORCE_DEADLINE_MS = 30_000

/**
 * The server's timeout for waiting on an acknowledgement from the daemon after dispatching input.
 * Includes a +2000ms buffer over FORCE_DEADLINE_MS to allow for network roundtrip time
 * after the daemon's force-submit mechanism potentially times out.
 */
export const SUBMIT_TIMEOUT_MS = FORCE_DEADLINE_MS + 2_000

/**
 * TUI agents that use \r (not \n) as submit keystroke.
 * Bulk PTY writes to these agents don't trigger submission via appendCR alone —
 * a standalone \r must be sent TUI_SUBMIT_DELAY_MS after any orchestrator injection.
 * Matches agents with formatInput: appendCR in daemon/src/pty/agents.ts.
 */
export const TUI_SUBMIT_AGENT_KEYS: AgentKey[] = [
  'claude', 'codex', 'qwen', 'kimi', 'forge', 'opencode', 'agy', 'copilot'
]

/** Human-readable labels for agents */
export const AGENT_LABELS: Record<AgentKey, string> = {
  sh:     'Shell',
  claude: 'Claude Code',
  codex:  'Codex CLI',
  qwen:   'Qwen CLI',
  kimi:   'Kimi Code',
  agy: 'Antigravity',
  ollama: 'Ollama',
  aider:  'Aider',
  forge:  'Forge',
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot',
  sim_ios: 'iOS Simulator',
}

/** Short labels for compact UI */
export const AGENT_SHORT_LABELS: Record<AgentKey, string> = {
  sh:     'Shell',
  claude: 'Claude',
  codex:  'Codex',
  qwen:   'Qwen',
  kimi:   'Kimi',
  agy: 'Antigravity',
  ollama: 'Ollama',
  aider:  'Aider',
  forge:  'Forge',
  opencode: 'OpenCode',
  copilot: 'Copilot',
  sim_ios: 'Simulator',
}

/** All agent-facing roles that can be assigned to a panel */
export const AGENT_ROLES = [
  'developer',
  'reviewer',
  'planner',
  'executor',
  'shell',
  'runner',
  'orchestrator',
] as const

export type AgentRole = typeof AGENT_ROLES[number]

/** Roles that users are allowed to manually assign via spawn UI (excludes orchestrator) */
export const USER_ASSIGNABLE_ROLES = AGENT_ROLES.filter(r => r !== 'orchestrator') as readonly AgentRole[]

/** Roles that can appear in the project event log (agent roles + system) */
export const EVENT_ROLES = [...AGENT_ROLES, 'system'] as const
export type EventRole = typeof EVENT_ROLES[number]

/** Role labels */
export const ROLE_LABELS: Record<AgentRole, string> = {
  developer:    'Dev',
  reviewer:     'Rev',
  planner:      'Plan',
  executor:     'Exec',
  shell:        'Shell',
  runner:       'Run',
  orchestrator: 'Orch',
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Reference (used in orchestration panels)
// ─────────────────────────────────────────────────────────────────────────────

export type AgentRef = {
  agentId: string
  agentKey: AgentKey
  daemonId?: string
  role?: AgentRole
  orchestratorOwned?: boolean
  cwd?: string
  status?: string
  /** Timestamp (ms) of the most recent todo dispatch to this panel. Used for round-robin reviewer selection. */
  lastDispatchAt?: number
  /** Daemon-owned immutable PTY instance used by completion receipts. */
  panelInstanceId?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Branded Types (for type safety)
// ─────────────────────────────────────────────────────────────────────────────

export type AgentId = string & { readonly __brand: 'AgentId' }
export type PanelId = string & { readonly __brand: 'PanelId' }
export type SessionId = string & { readonly __brand: 'SessionId' }
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' }
export type ProjectId = string & { readonly __brand: 'ProjectId' }

export const mkAgentId = (s: string): AgentId => s as AgentId
export const mkPanelId = (s: string): PanelId => s as PanelId
export const mkSessionId = (s: string): SessionId => s as SessionId
export const mkWorkspaceId = (s: string): WorkspaceId => s as WorkspaceId
export const mkProjectId = (s: string): ProjectId => s as ProjectId

/** Browser-created identity for one exact spawn generation. It exists before
 * any spawn frame can leave the browser and is never completion evidence. */
export type SpawnAttemptId = string & { readonly __brand: 'SpawnAttemptId' }

const SPAWN_ATTEMPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSpawnAttemptId(value: unknown): value is SpawnAttemptId {
  return typeof value === 'string' && SPAWN_ATTEMPT_ID_RE.test(value)
}

export const mkSpawnAttemptId = (value: string): SpawnAttemptId => value as SpawnAttemptId

/** Adapter protocol revisions, not claims of runtime MCP health or duty ACK. */
export interface ScheduledDutyV1Capability {
  version: 1
  providers: Partial<Record<AgentKey, number>>
}

/** Presence mandates scheduled cwd and context checks, independently of trust seeding. */
export interface ScheduledDutyV1Launch {
  version: 1
  providerRevision: number
}

export interface ProtocolCapabilities {
  scheduledDutyV1?: ScheduledDutyV1Capability
  spawnCancelV1?: true
  /** A scheduled spawn's daemonLocalPath takes precedence over projectPaths. */
  scheduledWorktreeCwdV1?: true
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Types
// ─────────────────────────────────────────────────────────────────────────────

export type AuthStatus = 'ok' | 'missing' | 'unknown'
export type DaemonStatus = 'connected' | 'disconnected' | 'connecting'
export type PanelStatus = 'spawning' | 'running' | 'exited' | 'error' | 'disconnected' | 'pending_kill' | 'quarantined'
export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'circuit_broken' | 'partial' | 'executed'

export type CompletionEvidenceTaskKind = 'ai' | 'shell'
export type CompletionOutcome = 'complete' | 'failed'
export const COMPLETION_FAILURE_CODES = [
  'blocked',
  'dependency_missing',
  'invalid_result',
  'tool_error',
  'command_failed',
  'unknown',
] as const
export type CompletionFailureCode = typeof COMPLETION_FAILURE_CODES[number]
export type CompletionEvidencePrepareError = 'invalid_request' | 'panel_instance_mismatch' | 'collision' | 'path_denied' | 'write_failed'
export type CompletionEvidenceCheckError = 'invalid_request' | 'panel_instance_mismatch' | 'not_registered' | 'binding_mismatch' | 'not_found' | 'settling' | 'invalid_record' | 'read_failed' | 'consumed' | 'released'
export type CompletionEvidenceSealError = 'invalid_request' | 'panel_instance_mismatch' | 'not_registered' | 'binding_mismatch' | 'wrong_task_kind' | 'already_sealed' | 'released' | 'write_failed'

/** Public nudge input is deliberately non-terminal. `worker.done` is private to
 * the sealed-evidence acceptor in output-tap.ts, so ordinary callers cannot
 * manufacture a successful completion through composeNudge. */
export type NonTerminalNudgeEventKind = 'worker.advisory' | 'worker.error' | 'worker.turn_ended' | 'worker.idle_no_verdict'

export interface CompletionEvidenceRecord {
  marker: string
  agent: string
  verdict: string
  exitCode?: number
}

/** Metadata cached by the daemon from the inbound spawn message, sent to the
 *  server via `daemon_resync` for authoritative roster reconciliation. */
export interface PanelMeta {
  agentId:           string
  spawnAttemptId?:   SpawnAttemptId
  agentKey:          string
  role?:             string
  personaId?:        string
  projectId?:        string
  workspaceId?:      string
  cwd?:              string
  runnerCmd?:        string
  groupId?:          string
  orchestratorOwned?: boolean
  sessionId?:        string
  model?:            string
  /** Server-observed receipt time of the latest validated agent hook callback. */
  lastHookCallbackAt?: number
  hookState?: 'configured' | 'manual' | 'unsupported' | 'refused'
  panelInstanceId?:  number
  /** Settled result of the panel's spawn-time MCP wiring (issue #617). Omission
   *  means legacy/unknown, never `false` — a reconnect or server restart must
   *  not demote an already-known-configured panel. Captured only once the
   *  daemon's async spawn-time resolution has settled. */
  mcpConfigured?:    boolean
  /** New daemons report either their current ephemeral startup state or an
   * authoritative clear. Omission is reserved for legacy producers. */
  startupGate?: PanelStartupGateState | null
  startupGatePanelInstanceId?: number | null
}

export type PanelHookConfigState =
  | 'unknown'
  | 'absent'
  | 'present_ok'
  | 'malformed'
  | 'unsupported_trust_required'
  | 'unsupported_not_a_jerico_agent'
  | 'unsupported_runtime_unverified'
  | 'unsupported_different_contract'
  | 'unsupported_no_config_hook_surface'

export type HookInstallRefusalStatus =
  | 'refused-malformed'
  | 'target-missing'
  | 'refused-invalid-script'
  | 'refused-conflict'
  | 'refused-unsafe-target'
  | 'installer-threw'

export interface HookInstallRefusal {
  status: HookInstallRefusalStatus
  at: number
}

export interface PanelHookState {
  configState: PanelHookConfigState
  callbackCount: number
  dispatchesSinceCallback: number
  hookInstallRefused?: HookInstallRefusal
}

export type StartupGateReason =
  | 'prompt_observed'
  | 'authentication_required'
  | 'credential_check_unverified'
  | 'ready_timeout'
  | 'seed_refused_invalid_cwd'
  | 'seed_refused_unsafe_target'
  | 'seed_refused_conflict'
  | 'seed_failed'
  | 'trust_provenance_missing'

export type PanelStartupGateKind = 'workspace_trust' | 'authentication' | 'unknown_startup'

export type StartupDiagnosticCode =
  | 'process_not_started'
  | 'protocol_handshake_missing'
  | 'auth_preflight_negative'
  | 'auth_preflight_unknown'

export type StartupElapsedBucket = 'lt_1s' | '1_5s' | '5_15s' | '15_30s' | 'gte_30s'

/** Closed, non-sensitive startup metadata. Terminal output, input, paths, args,
 * environment values, URLs, identities, and arbitrary error strings are never
 * valid diagnostic fields. */
export interface PanelStartupDiagnostic {
  code: StartupDiagnosticCode
  providerKey: AgentKey
  providerVersion?: string
  panelInstanceId: number
  elapsedBucket: StartupElapsedBucket
  outputReceived: boolean
  decsetSeen: boolean
  providerMarkerSeen: boolean
  tailTruncated: boolean
  correlationId?: string
  /**
   * #615: why readiness never completed, when the cause is known at the moment
   * the gate closes. A ready timeout overwrites `PanelStartupGateState.reason`
   * with `'ready_timeout'`, so the original cause — e.g. a workspace-trust seed
   * refused for missing provenance — was destroyed before any client saw it.
   * Observed live: the `trust_provenance_missing` state is emitted and then
   * replaced within the same millisecond, leaving the UI with a generic
   * "handshake timed out" and no way to tell an unbindable project apart from a
   * hung provider. Carry the seed reason on the diagnostic so the terminal state
   * still names its cause.
   */
  seedReason?: StartupGateReason
}

export interface PanelStartupGateState {
  phase: 'checking' | 'ready' | 'blocked' | 'attention'
  gate: PanelStartupGateKind
  reason?: StartupGateReason
  observedAt: number
  diagnostic?: PanelStartupDiagnostic
}

/** PTY activity state — used by orchestrator to decide safe dispatch windows (Phase 1) */
export type PtyState = 'idle' | 'working'

/** Threshold (ms) after last output before an agent is considered idle.
 *  Shared constant — both daemon and server use the same value so they
 *  agree on idle/working state. */
export const IDLE_THRESHOLD_MS = 3000

// ─────────────────────────────────────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'NO_DAEMON'
  | 'AGENT_NOT_FOUND'
  | 'SPAWN_FAILED'
  | 'SPAWN_DUPLICATE'
  | 'CAPACITY_EXCEEDED'
  | 'DUPLICATE_SIMULATOR'
  | 'DUPLICATE_ORCHESTRATOR'
  | 'SPAWN_HELPER_BROKEN'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'SESSION_TAKEN'
  | 'INVALID_MSG'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'FEATURE_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'RESOURCE_NOT_OWNED'
  | 'PROJECT_PATH_REQUIRED'
  | 'CWD_MISSING_ON_DAEMON'
  | 'INSPECT_NO_ACTIVE_AGENT'
  | 'RESERVED_MARKER'
  | 'BLAST_RADIUS_CONFIRMATION_REQUIRED'

// ─────────────────────────────────────────────────────────────────────────────
// Data Transfer Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentInfo {
  key: AgentKey
  displayName: string
  binaryPath: string
  authStatus: AuthStatus
  version?: string
}

export interface DirEntry {
  name: string
  path: string
}

// Entry in the editor file-tree (project-cwd-scoped list_dir). `path` is relative to
// the pane's cwd so the browser never handles absolute host paths.
export interface TreeEntry {
  name: string
  path: string
  isDir: boolean
}

// One changed file in the VS Code-style "Changes" view (git_status). `path` is relative
// to cwd. status = worktree/index code; staged = the change is in the index vs HEAD.
export interface GitStatusEntry {
  path: string
  status: 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?'
  staged: boolean
  oldPath?: string
}

export interface ClaudeSessionEntry {
  agentKey?: 'claude' | 'codex'
  sessionId:     string
  cwd:           string | null
  title?:        string | null
  lastActivity?: string | null
  daemonId?:     string
  role?:         string | null
  live?:         boolean
  status?:       string | null
  updatedAt?:    string | null
  startedAt?:    string | null
  endedAt?:      string | null
  sizeBytes?:    number | null
  renamable?:    boolean
}

export interface ClaudeSessionListResult { entries: ClaudeSessionEntry[]; truncated: boolean; truncatedReason?: 'cap' | 'deadline' }

export interface DaemonInfo {
  id: string
  name: string
  version: string
  npmVersion?: string | null
  installModel?: 'pkg' | 'npm'
  agents: AgentInfo[]
  workspaceIds: string[]
  spawnHelperBroken?: boolean
  ptyHealth?: PtyHealthInfo
  protectedFoldersReadable?: boolean
  claudeTier?: ClaudeTier
  capabilities?: ProtocolCapabilities
  // Socket liveness (#527): whether the daemon's active socket is OPEN right now,
  // and the timestamp of its last pong. Lets the web store derive real connection
  // status instead of assuming every listed daemon is connected (phantom-daemon fix).
  connected?: boolean
  lastPongTs?: number | null
}

export type ClaudeTier = 'free' | 'pro' | 'max_5x' | 'max_20x'

export const TIER_VALUES: readonly ['free', 'pro', 'max_5x', 'max_20x'] = ['free', 'pro', 'max_5x', 'max_20x'] as const

export const isClaudeTier = (val: unknown): val is ClaudeTier =>
  TIER_VALUES.includes(val as ClaudeTier)

export type CwdSource = 'local_override' | 'daemon_override' | 'server_project' | 'fallback_home'

export interface AgentState {
  id: AgentId
  agentKey: AgentKey
  daemonId: string
  status: PanelStatus
  spawnAttemptId?: SpawnAttemptId
  model?: string
  /** Per-scope monotonic display ordinal (e.g. #2 in "OpenCode #2"). Server-assigned; stable for panel lifetime. */
  ordinal?: number
  cwd?: string
  exitCode?: number
  exitSignal?: string
  orchestratorOwned?: boolean
  projectId?: string
  workspaceId?: string
  role?: AgentRole
  runnerCmd?: string
  sessionId?: string
  mcpConfigured?: boolean
  mcpTransport?: string
  cwdFallback?: boolean
  effectiveCwd?: string
  effectiveRole?: AgentRole
  lastOutputAt?: number
  /** Cold daemon observation plus server-owned callback/dispatch counters. Absent means the
   *  daemon is too old to report hook state; it must never be rendered as healthy zero. */
  hook?: PanelHookState
  /** Daemon-observed startup gate state. Absent means the daemon does not report it. */
  startupGate?: PanelStartupGateState
  /** Immutable PTY generation that owns the ephemeral startup reading. */
  startupGatePanelInstanceId?: number
  waitingResume?: boolean
  groupId?: string
  teamName?: string
  teamColor?: string
  resynced?: boolean
  minimized?: boolean
  personaId?: string
  /** Daemon-side orchestrator input submit state (busy-panel retry / force-submit). */
  orchSubmit?: {
    state: 'buffering' | 'pending' | 'forced' | 'submitted' | 'failed'
    ts: number
    /** The daemon's own reason for a terminal failure, forwarded rather than reinvented. Absent
     *  for the non-terminal states, and absent from an older daemon — the UI must not guess. */
    reason?: string
  }

  verifiedAt?: string
  setVia?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration Types
// ─────────────────────────────────────────────────────────────────────────────

export type TodoStatus = 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'blocked' | 'paused' | 'cancelled' | 'awaiting_confirmation'

export type TodoType = 'planning' | 'implementation' | 'infra' | 'review'

export interface TodoItem {
  id: string
  seq: number
  title: string
  estimatedAgent: AgentKey
  todoType?: TodoType
  requiredRole?: AgentRole
  priority?: number
  dependsOn: string[]
  status: TodoStatus
  assignedAgent?: string
  workerId?: string
  timeoutAt?: string
  retryCount?: number
  retryContext?: string
  rejectedBy?: string
  rejectionReason?: string
  handoffFrom?: string
  waitForMarker?: string
  projectId?: string
  transcript?: string | null
  errorMessage?: string
  lastLine?: string
  originTodoId?: string
  startedAt?: Date | string
  completedAt?: Date | string
}

export interface WorkerConfig {
  machineId: string
  agentKey: AgentKey
  todoIds: string[]
}

export interface RunConfig {
  workers: WorkerConfig[]
  maxParallelTodos?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API DTOs
// ─────────────────────────────────────────────────────────────────────────────

export interface Workspace {
  id: string
  name: string
  description: string | null
  color: string
  isDefault: boolean
  createdAt: string
  machineIds: string[]
  isOwner: boolean
  role: 'viewer' | 'editor' | 'admin' | 'owner'
  eventAccess: 'read' | 'write'
}

export interface Project {
  id: string
  workspaceId: string
  name: string
  /** Blueprint text — only present on the single-project detail GET and
   *  mutation responses (issue #512 D1 DTO split); list/create DTOs omit it. */
  description?: string | null
  /** ISO timestamp of the last blueprint write; null/omitted = never seeded. */
  blueprintUpdatedAt?: string | null
  cwd: string | null
  machineId: string | null
  color: string | null
  icon: string | null
  createdAt: string
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Messages
// ─────────────────────────────────────────────────────────────────────────────

export interface CodegraphStatusHealth {
  status: 'ok' | 'down' | 'error'
  error: string | null
}

export interface CodegraphStatusProject {
  projectId?: string | null
  /** Daemon that produced this status (server-enriched). */
  daemonId: string
  /** Epoch ms when this status was received (server-enriched; used for TTL + tie-break). */
  receivedAt: number
  cwd: string
  indexed: number
  total: number
  stale: number
  lastIndexedAt: number | null
  indexing: boolean
  coverage: { resolved: number; unresolved: number }
  unsupportedLanguages: string[]
}

export type SimHealthCheckId =
  | 'xcrun_exists'
  | 'simctl_ok'
  | 'booted_simulator'
  | 'idb_present'

export interface SimHealthCheck {
  id: SimHealthCheckId
  status: 'pass' | 'fail' | 'warn'
  label: string
  detail?: string
  fixCmd?: string
}

export interface DevServerInfo {
  title: string
  address: string
}

export type DevServerDiscoveryError =
  | 'unsupported_platform'
  | 'enumeration_failed'
  | 'scan_timeout'
  | 'permission_denied'
  | 'resource_not_owned'

export type MediaPreviewKind = 'image' | 'video'

export type MediaPreviewError =
  | 'invalid_request'
  | 'invalid_cwd'
  | 'path_denied'
  | 'not_found'
  | 'unsupported_type'
  | 'unsupported_platform'
  | 'dimensions_too_large'
  | 'too_large'
  | 'thumbnail_failed'
  | 'busy'
  | 'rate_limited'
  | 'timed_out'
  | 'unavailable'
  | 'permission_denied'
  | 'resource_not_owned'
  | 'project_path_required'

export interface AgentResyncPanel {
  agentId: string
  spawnAttemptId?: SpawnAttemptId
  agentKey: AgentKey
  daemonId: string
  model?: string
  ordinal?: number
  sessionId?: string
  projectId?: string
  workspaceId?: string
  cwd?: string
  mcpConfigured?: boolean
  role?: AgentRole
  runnerCmd?: string
  orchestratorOwned?: boolean
  minimized?: boolean
  groupId?: string
  teamName?: string
  teamColor?: string
  status?: string
  personaId?: string
  lastOutputAt?: number
  lastHookCallbackAt?: number
  /** Omitted = legacy producer; null = authoritative clear. */
  startupGate?: PanelStartupGateState | null
  startupGatePanelInstanceId?: number | null
}

export type ServerMessage =
  // Issue #92: `replay`/`requestId` are present only on a buffer-replay response to
  // `agent_buffer_request` (undefined on ordinary live PTY output). `requestId` echoes
  // the requester's own id back so ONLY the TerminalPane instance that asked for this
  // specific replay resets and applies it — point-to-point, not a broadcast every
  // mounted instance for the agentId must react to (see terminal-bus.ts).
  | { type: 'output'; agentId: string; data: string; replay?: boolean; requestId?: string; replayGeneration?: number; replayEvictions?: number }
  | { type: 'exit'; agentId: string; spawnAttemptId?: SpawnAttemptId; exitCode: number | null; signal: string | null }
  | { type: 'agents'; daemonId: string; list: AgentInfo[] }
  | { type: 'ready'; version: string; name?: string; spawnHelperBroken?: boolean; ptyHealth?: PtyHealthInfo; claudeTier?: ClaudeTier; capabilities?: ProtocolCapabilities }
  | { type: 'daemon_registered' }
  | { type: 'daemon_connected'; daemonId: string; version: string; npmVersion?: string | null; installModel?: 'pkg' | 'npm'; name: string; spawnHelperBroken?: boolean; ptyHealth?: PtyHealthInfo; protectedFoldersReadable?: boolean; capabilities?: ProtocolCapabilities }
  | { type: 'daemon_disconnected'; daemonId: string; reason: string }
  | { type: 'daemon_settings_updated'; daemonId: string; claudeTier?: ClaudeTier; ok: boolean; error?: string }
  | { type: 'daemon_list'; daemons: DaemonInfo[] }
  | { type: 'error'; code: ErrorCode; message: string; rejectedType?: string; agentId?: string; daemonId?: string; spawnAttemptId?: SpawnAttemptId; existingAgentId?: string; udid?: string; sessionId?: string; limit?: 'input' | 'buffer_replay' | 'resize' | 'spawn' | 'media' | 'general'; requiredPermission?: string; workspaceRole?: string; eventAccess?: 'read' | 'write'; requestId?: string }
  | { type: 'tcc_eperm_blocked'; agentId: string; daemonId: string; cwd: string; probedPath: string; service?: 'documents' | 'desktop' | 'downloads' | 'icloud-drive' | 'app-data' }
  | { type: 'session_started'; agentId: string; spawnAttemptId?: SpawnAttemptId; sessionId: string }
  | { type: 'resize_applied'; agentId: string; cols: number; rows: number }
  | { type: 'orch_run_started'; runId: string; todos: TodoItem[]; panels: AgentRef[]; daemonId?: string; projectId?: string; name?: string; spec?: string }
  | { type: 'workspace_machines_updated'; workspaceId: string; daemonIds: string[] }
  | { type: 'orch_todo_assigned'; runId: string; todoId: string; agentId: string; todo?: TodoItem }
  | { type: 'orch_todo_started'; runId: string; todoId: string; agentId: string; todo?: TodoItem }
  | { type: 'orch_todo_completed'; runId: string; todoId: string; mechanism: 'receipt' | 'manual' }
  | { type: 'orch_todo_rejected'; runId: string; todoId: string; reason: string; retryCount: number }
  | { type: 'orch_todo_failed'; runId: string; todoId: string; reason: string }
  | { type: 'orch_todo_cancelled'; runId: string; todoId: string; affectedTodos: string[]; dependentAction: 'block' | 'reset' | 'cancel_all' }
  | { type: 'orch_panel_warning'; runId?: string; requiredRoles: Array<{ role: string; count: number; present: number }>; message: string }
  | { type: 'orch_todo_paused'; runId: string; todoId: string; agentId: string }
  | { type: 'orch_awaiting_confirmation'; runId: string; todoId: string; todoTitle?: string; reason: string; requiredRole?: string | null }
  | { type: 'orch_run_paused'; runId: string }
  | { type: 'orch_run_resumed'; runId: string }
  | { type: 'orch_run_rehydrated'; sessionId: string; todos: TodoItem[]; runState: 'running' | 'paused' }
  | { type: 'orch_daemon_disconnected'; runId: string }
  | { type: 'orch_daemon_reconnected'; runId: string }
  | { type: 'orch_run_completed'; runId: string; status: 'completed' | 'partial' | 'failed' }
  | { type: 'orch_run_circuit_broken'; runId: string; consecutiveFailures: number }
  | { type: 'orch_todos_reopened'; runId: string; todoIds: string[] }
  | { type: 'orch_plan_ready'; runId: string; todos: TodoItem[]; projectId?: string; cycles?: string[]; requiredRoles?: Array<{ role: string; count: number }> }
  | { type: 'orch_run_awaiting_approval'; runId: string; todos: TodoItem[]; projectId?: string; requiredRoles?: Array<{ role: string; count: number }> }
  | { type: 'orch_run_cancelled'; runId: string; reason: string }
  | { type: 'orch_action_broadcast'; action: 'spawn' | 'cancel' | 'complete'; agentId: string; userId: string; timestamp: number }
  | { type: 'dir_list_result'; requestId: string; path: string; entries: DirEntry[]; error?: string }
  | { type: 'file_read_result'; requestId: string; path: string; content: string; truncated: boolean; truncatedFrom?: 'start' | 'end'; size?: number; mtime?: number; error?: string }
  | { type: 'file_write_result'; requestId: string; path: string; ok: boolean; mtime?: number; error?: string }
  | { type: 'image_drop_result'; requestId: string; ok: boolean; relPath?: string; error?: string }
  | { type: 'git_diff_result'; requestId: string; diff: string; error?: string }
  | { type: 'list_dir_result'; requestId: string; path: string; entries: TreeEntry[]; error?: string }
  | { type: 'project_tree_result'; requestId: string; cwd: string; tree: string; error?: string }
  | { type: 'git_status_result'; requestId: string; files: GitStatusEntry[]; error?: string }
  | { type: 'claude_sessions_result'; requestId: string; cwd: string; entries: ClaudeSessionEntry[]; truncated?: boolean; truncatedReason?: 'cap' | 'deadline'; error?: string }
  | { type: 'plan_updated'; projectId: string; workspaceId: string; description: string }
  | { type: 'panel_hook_state'; agentId: string; panelInstanceId: number; configState: PanelHookConfigState; callbackCount?: number; dispatchesSinceCallback?: number; hookInstallRefused?: HookInstallRefusal }
  | { type: 'panel_startup_gate_state'; agentId: string; panelInstanceId: number; state: PanelStartupGateState }
  | { type: 'mcp_status'; agentId: string; mcpConfigured: boolean; transport?: string; projectId?: string; error?: string; effectiveCwd?: string; cwdSource?: CwdSource; verifiedAt?: string; setVia?: string }
  | { type: 'agents_resynced'; full?: boolean; panels: AgentResyncPanel[] }
  | { type: 'agent_message'; fromAgentId: string; toAgentId?: string; content: string; ts: number }
  | { type: 'agent_spawned'; agentId: string; spawnAttemptId?: SpawnAttemptId; agentKey: AgentKey; daemonId: string; model?: string; ordinal?: number; projectId?: string; workspaceId?: string; cwd?: string; role?: AgentRole; runnerCmd?: string; personaId?: string; orchestratorOwned?: boolean; groupId?: string }
  | { type: 'spawn_cancelled'; agentId: string; daemonId: string; spawnAttemptId: SpawnAttemptId; outcome: 'prevented' | 'killed' | 'already_cancelled' }
  | { type: 'persona_applied'; agentId: string; personaId: string; personaName: string; agentKey: AgentKey; role?: AgentRole }
  | { type: 'agent_effective_role'; agentId: string; effectiveRole: AgentRole }
  | { type: 'agents_removed'; agentIds: string[]; spawnAttemptId?: SpawnAttemptId }
  | { type: 'system_metrics'; daemonId: string; cpu: number; ramUsedMb: number; ramTotalMb: number; ramCachedMb?: number; battery?: { percent: number; charging: boolean } }
  | { type: 'panel_token_usage'; agentId: string; usedPct: number; usedTokens: number; prompts5h?: number; limit5h?: number; resetAt?: number; tier?: string; outputTokens?: number; reset?: boolean }
  | { type: 'panel_codegraph_usage'; agentId: string; codegraph: number; nativeSearch: number; other: number }
  // Cohort step 3 (Fork 5): daemon→server only — one final whole-transcript
  // parse per panel at exit; the server persists one codegraph_ab_results row.
  | { type: 'panel_codegraph_ab_result'; agentId: string; sessionId: string; stats: { input: number; cacheCreation: number; cacheRead: number; output: number; turns: number; codegraphCalls: number; nativeSearchCalls: number; otherCalls: number; hadCompaction: boolean; anomalyCount: number; truncatedTail: boolean } }
  | { type: 'orch_planning_todos_updated'; projectId: string }
  | { type: 'team_renamed'; teamId: string; name: string; color?: string }
  | { type: 'team_removed'; teamId: string }
  | { type: 'orch_start_ack'; ok?: boolean; error?: string }
  | { type: 'server_info'; version: string; env: string; capabilities?: ProtocolCapabilities }
  | { type: 'sim_frame'; agentId: string; image: string; width?: number; height?: number }
  | { type: 'sim_source'; agentId: string; source: string }
  | { type: 'sim_health'; agentId: string; checks: SimHealthCheck[] }
  | { type: 'sim_install_progress'; agentId: string; spawnAttemptId: SpawnAttemptId; step?: 'pre_check' | 'xcode_install' | 'brew_check' | 'idb_install' | 'sim_boot' | 'done' | 'error'; stream?: 'stdout' | 'stderr'; line?: string; exitCode?: number; error?: string }
  | { type: 'panel_state'; agentId: string; state: PtyState; lastOutputAt: number }
  | { type: 'panel_error'; agentId: string; signature: string }
  | { type: 'panel_error_cleared'; agentId: string; status: string }
  | { type: 'submit_failed'; agentId: string; reason: string; queuedCount: number; retryActive: boolean }
  | { type: 'orch_submit_state'; agentId: string; state: 'buffering' | 'pending' | 'forced' | 'submitted'; dispatchId?: string }
  | { type: 'cwd_fallback'; agentId: string; requestedCwd: string | undefined; actualCwd: string; source: CwdSource; reason: 'not_found' | 'daemon_override_missing'; projectId?: string; daemonId: string }
  | { type: 'monitor_event'; subId: string; sourceKind: 'panel' | 'daemon' | 'project' | 'run'; sourceId: string; matchedText: string; fullEvent?: unknown; timestamp: number }
  | { type: 'monitor_error'; subId: string; error: string }
  | { type: 'tool_usage'; daemonId: string; tool: 'qwen' | 'opencode' | 'agy' | 'kimi' | 'claude'; kind: 'quota' | 'spent'; prompts5h?: number; limit5h?: number; resetAt?: number; estimate?: boolean; tokensSpent5h?: number; tokensTotal?: number; contextPct?: number; contextTokens?: number; maxContextTokens?: number; bindingWindow?: 'five_hour' | 'overage'; tier?: string }
  | { type: 'limit_alert'; runId: string; daemonId: string; level: 'info' | 'warn' | 'consent' | 'clear'; usedPercentage: number; prompts5h: number; limit5h: number; resetAt: number; message: string }
  | { type: 'model_switch_confirmed'; agentId: string; model: string }
  | { type: 'model_switch_unconfirmed'; agentId: string; model: string }
  | { type: 'set_model_rejected'; agentId: string; model: string; reason: string }
  | { type: 'agent_models_available'; daemonId: string; agentKey: AgentKey; models: string[] }
  | { type: 'model_favorites'; byAgent: Record<string, Array<{ model: string; count: number; lastUsedAt: number }>> }
  | { type: 'codegraph_status'; daemonId: string; health: CodegraphStatusHealth; projects: CodegraphStatusProject[] }
  | { type: 'claude_session_limit'; agentId: string; daemonId: string; pct: number; limitName: string; resetRaw: string | null; hard: boolean }
  | { type: 'claude_session_renamed'; requestId: string; sessionId: string; title: string; ok: boolean; error?: string }
  | { type: 'daemon_shutdown'; purge?: boolean }
  | { type: 'preview_proxy_ready'; paneId: string; proxyUrl: string }
  | { type: 'preview_proxy_error'; paneId: string; error: string }
  | { type: 'dev_servers'; requestId: string; daemonId: string; servers: DevServerInfo[]; scannedAt: number; truncated?: boolean; error?: DevServerDiscoveryError }
  | { type: 'media_preview_result'; requestId: string; daemonId: string; agentId: string; path: string; resolvedPath?: string; kind?: MediaPreviewKind; mime?: 'image/jpeg' | 'image/png'; data?: string; width?: number; height?: number; mtime?: number; size?: number; playable?: boolean; mediaMime?: 'video/mp4' | 'video/webm'; mediaData?: string; error?: MediaPreviewError }
  | { type: 'watch_artifact_check_result'; requestId: string; agentId: string; verified: boolean; sentinel?: string; error?: 'invalid_cwd' | 'path_denied' | 'not_found' | 'stale' | 'settling' | 'read_failed'; changedEntries?: Array<{ path: string; ageMs: number }>; changedEntryCount?: number; changedEntryScanTruncated?: boolean }
  | { type: 'prepare_completion_evidence_result'; requestId: string; completionId: string; agentId: string; panelInstanceId: number; ok: boolean; path?: string; error?: CompletionEvidencePrepareError }
  | { type: 'check_completion_evidence_result'; requestId: string; completionId: string; agentId: string; panelInstanceId: number; verified: boolean; record?: CompletionEvidenceRecord; error?: CompletionEvidenceCheckError }
  | { type: 'seal_completion_evidence_result'; requestId: string; completionId: string; agentId: string; panelInstanceId: number; sealed: boolean; record?: CompletionEvidenceRecord; error?: CompletionEvidenceSealError }
  | { type: 'send_keys_result'; requestId: string; agentId: string; ok: boolean; error?: 'panel_not_found' | 'not_interactive_agent' | 'write_failed' }
  | { type: 'agent_hook_event'; protocolVersion: number; eventId: string; agentId: string; panelInstanceId: number; agentKey: AgentKey; event: 'turn_ended' | 'turn_failed'; providerSessionId?: string }

/**
 * Orchestrator scope — project-scoped orchestrators (default) only see and
 * command agents of their project; workspace scope is an explicit user opt-in
 * that grants visibility over project-less agents and all projects' panels.
 */
export type OrchScope = 'project' | 'workspace'

/** Server-originated daemon controls. Kept out of ClientMessage so browser
 * message exhaustiveness cannot accidentally authorize an injection notice. */
export interface ScheduledWorktreeRemoval {
  operationId: string
  attempts: Array<{ agentId: string; spawnAttemptId: string }>
  projectCwd: string
  scheduleId: string
  slotKey: string
  worktreePath: string
}

export type DaemonControlMessage =
  | { type: 'scheduled_cleanup_remove'; daemonId: string; requestId: string; removal: ScheduledWorktreeRemoval }
  | { type: 'scheduled_cleanup_status'; daemonId: string; requestId: string; operationId: string }
  | { type: 'scheduled_cleanup_probe'; daemonId: string; requestId: string; attempts?: Array<{ agentId: string; spawnAttemptId: string }>; agentIds?: string[] }
  | { type: 'permissions_changed'; agentId: string; capabilitiesVersion: number }
  // Issue #84: notBeforeAgeMs (a duration) replaces notBeforeMs (a server epoch)
  // — comparing a server-clock timestamp against the daemon host's filesystem
  // mtime was a genuine cross-machine clock-skew bug. The daemon now computes
  // entirely in its own clock domain: `Date.now() - mtimeMs > notBeforeAgeMs`.
  | { type: 'watch_artifact_check'; requestId: string; agentId: string; cwd: string; path: string; taskSuffix?: string; notBeforeAgeMs: number; includeRecentChanges?: boolean; changedSinceAgeMs?: number }
  | { type: 'prepare_completion_evidence'; requestId: string; completionId: string; agentId: string; panelInstanceId: number; expectedMarker: string; taskKind: CompletionEvidenceTaskKind }
  | { type: 'check_completion_evidence'; requestId: string; completionId: string; agentId: string; panelInstanceId: number }
  | { type: 'seal_completion_evidence'; requestId: string; completionId: string; agentId: string; panelInstanceId: number; outcome: CompletionOutcome; failureCode?: CompletionFailureCode }
  | { type: 'release_completion_evidence'; completionId: string; agentId: string; panelInstanceId: number }
  // Issue #85: raw keystrokes for an interactive TUI menu (approval overlay,
  // y/n confirm, arrow-nav select) that `input` cannot deliver — `input`
  // always envelope-wraps text and routes through the idle-gate buffer
  // (`orchPendingInput`/`flushOrchPendingInput`), which defers indefinitely
  // while a menu keeps repainting, and forces a single trailing `\r` after
  // TUI_SUBMIT_DELAY_MS that can select the wrong option mid-sequence. This
  // message bypasses both: one ordered raw PTY write, no envelope, no
  // terminator, no idle-gate queueing.
  | { type: 'send_keys'; requestId: string; agentId: string; daemonId: string; keys: SendKey[] }

export type ClientMessage =
  | { type: 'daemon_registered' }
  | { type: 'spawn'; agentId: string; daemonId: string; spawnAttemptId?: SpawnAttemptId; agentKey: AgentKey; cols: number; rows: number; model?: string; sessionId?: string; projectId?: string; workspaceId?: string; cwd?: string; daemonLocalPath?: string | null; daemonBindingSetVia?: string | null; scheduledDutyV1?: ScheduledDutyV1Launch; role?: AgentRole; runnerCmd?: string; orchestratorOwned?: boolean; repoUrl?: string; groupId?: string; personaId?: string; systemPrompt?: string; orchScope?: OrchScope; confirmBlastRadius?: boolean }
  | { type: 'spawn_cancel'; agentId: string; daemonId: string; spawnAttemptId: SpawnAttemptId }
  | { type: 'input'; agentId: string; daemonId: string; data: string; source?: 'user' | 'orchestrator'; ownsSubmit?: boolean; dispatchId?: string; panelInstanceId?: number; replay?: boolean; notice?: boolean; watchId?: string; idempotencyKey?: string; kind?: string; closure?: 'verdict' | 'watch_over' }
  | { type: 'kill'; agentId: string; daemonId: string; force: boolean }
  | { type: 'resize'; agentId: string; daemonId: string; cols: number; rows: number }
  | { type: 'detect_agents'; daemonId?: string }
  | { type: 'detect_dev_servers'; daemonId: string; requestId: string }
  | { type: 'media_preview'; daemonId: string; agentId: string; requestId: string; cwd: string; path: string }
  | { type: 'orch_start'; spec: string; daemonId: string; panels: AgentRef[]; projectId?: string; workspaceId?: string; name?: string; runConfig?: RunConfig }
  | { type: 'orch_todo_done'; sessionId: string; todoId: string }
  | { type: 'orch_todo_fail'; sessionId: string; todoId: string; reason?: string }
  | { type: 'orch_cancel'; sessionId: string }
  | { type: 'orch_kill_project'; projectId: string }
  | { type: 'dir_list'; daemonId: string; requestId: string; path: string }
  | { type: 'file_read'; daemonId: string; requestId: string; path: string; cwd: string; from?: 'start' | 'end' }
  | { type: 'file_write'; daemonId: string; requestId: string; path: string; cwd: string; content: string; baseMtime?: number }
  | { type: 'image_drop'; daemonId: string; requestId: string; cwd: string; filename: string; mime: string; data: string; sizeBytes: number }
  | { type: 'git_diff'; daemonId: string; requestId: string; cwd: string; path?: string; baseRef?: string }
  | { type: 'list_dir'; daemonId: string; requestId: string; cwd: string; path: string }
  | { type: 'project_tree'; daemonId: string; requestId: string; projectId?: string; cwd?: string; daemonLocalPath?: string | null }
  | { type: 'git_status'; daemonId: string; requestId: string; cwd: string }
  | { type: 'claude_sessions_list'; daemonId: string; requestId: string; cwd: string; agentKeys?: Array<'claude' | 'codex'> }
  | { type: 'claude_session_rename'; daemonId: string; cwd: string; sessionId: string; title: string; requestId: string; agentKey?: 'claude' | 'codex' }
  | { type: 'orch_inject'; agentId: string; daemonId: string; text: string; confirmBlastRadius?: boolean }
  | { type: 'orch_todo_cancel'; sessionId: string; todoId: string; dependentAction: 'block' | 'reset' | 'cancel_all' }
  | { type: 'orch_todo_pause'; sessionId: string; todoId: string }
  | { type: 'orch_todo_resume'; sessionId: string; todoId: string }
  | { type: 'orch_todo_reset'; sessionId: string; todoId: string }
  | { type: 'agent_relay'; fromAgentId: string; toAgentId: string; toDaemonId: string; lines: number }
  // Issue #92 (defect 2): requestId is echoed back on the `output` response so
  // only this requester's TerminalPane instance applies it (see ServerMessage's
  // `output` variant doc comment).
  | { type: 'agent_buffer_request'; agentId: string; requestId?: string }
  | { type: 'broadcast'; text: string; targets: Array<{ agentId: string; daemonId: string }>; confirmBlastRadius?: boolean }
  | { type: 'agent_role_changed'; agentId: string; role: AgentRole | null }
  | { type: 'persona_apply'; agentId: string; personaId: string }
  | { type: 'role_apply'; agentId: string; role: AgentRole }
  | { type: 'agent_send'; fromAgentId: string; toAgentId?: string; content: string; confirmBlastRadius?: boolean }
  | { type: 'agent_group_changed'; agentId: string; groupId: string | null }
  | { type: 'panel_set_minimized'; agentId: string; minimized: boolean }
  | { type: 'set_model'; agentId: string; daemonId: string; model: string }
  | { type: 'orch_retry_run'; sessionId: string }
  | { type: 'orch_plan_approved'; runId: string; autoSpawnMissing?: boolean }
  | { type: 'orch_plan_rejected'; runId: string }
  | { type: 'orch_approve_run'; sessionId: string; autoSpawnMissing?: boolean }
  | { type: 'orch_todo_reassign'; sessionId: string; todoId: string; newAgentId: string }
  | { type: 'orch_pause_run'; sessionId: string }
  | { type: 'orch_resume_run'; sessionId: string }
  | { type: 'orch_confirm_blast_radius'; sessionId: string; todoId: string }
  | { type: 'orch_limit_sleep'; sessionId: string; daemonId: string; resetAt?: number }
  | { type: 'sim_tap'; agentId: string; daemonId: string; x: number; y: number }
  | { type: 'sim_swipe'; agentId: string; daemonId: string; x1: number; y1: number; x2: number; y2: number; duration?: number }
  | { type: 'sim_key'; agentId: string; daemonId: string; key: string }
  | { type: 'sim_button'; agentId: string; daemonId: string; button: 'HOME' | 'LOCK' | 'SIDE_BUTTON' | 'SIRI' | 'APPLE_PAY' }
  | { type: 'sim_get_source'; agentId: string; daemonId: string }
  | { type: 'sim_subscribe'; agentId: string; daemonId: string; spawnAttemptId: SpawnAttemptId }
  | { type: 'sim_unsubscribe'; agentId: string; daemonId: string; spawnAttemptId: SpawnAttemptId }
  | { type: 'sim_healthcheck'; agentId: string; daemonId: string }
  | { type: 'sim_install_run'; agentId: string; daemonId: string; spawnAttemptId: SpawnAttemptId }
  | { type: 'sim_install_cancel'; agentId: string; daemonId: string; spawnAttemptId: SpawnAttemptId }
  | { type: 'set_daemon_settings'; daemonId: string; patch: { claudeTier?: ClaudeTier } }
  | { type: 'monitor_subscribe'; subId: string; sourceKind: 'panel' | 'daemon' | 'project' | 'run'; sourceId: string; pattern: { kind: 'substring' | 'regex' | 'verdict_marker'; value: string }; eventTypes?: string[] }
  | { type: 'monitor_unsubscribe'; subId: string }
  | { type: 'inspect_result'; daemonId: string; paneId: string; requestId: string; payload: InspectPayload; cwd?: string; targetAgentId?: string }
  | { type: 'preview_proxy_start'; paneId: string; daemonId: string; devUrl: string; denyOrigins?: string[] }
  | { type: 'preview_proxy_stop'; paneId: string; daemonId: string }
  | { type: 'clear_panel_error'; agentId: string }

// ─────────────────────────────────────────────────────────────────────────────
// Type Guards
// ─────────────────────────────────────────────────────────────────────────────

export const isAgentKey = (key: string): key is AgentKey => 
  ALL_AGENT_KEYS.includes(key as AgentKey)

export const isAIAgent = (key: AgentKey): boolean => 
  AI_AGENT_KEYS.includes(key)

export const isMCPEnabled = (key: AgentKey): boolean => 
  MCP_ENABLED_AGENTS.includes(key)

export const isSessionCapable = (key: AgentKey): boolean =>
  SESSION_CAPABLE_AGENTS.includes(key)

// ─────────────────────────────────────────────────────────────────────────────
// Group Schemas (reusable team/group templates)
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupSchemaSlotPayload {
  agentKey:  AgentKey
  model?:    string
  role?:     AgentRole
  count:     number
  personaId?: string
  cmd?:      string
}

export interface GroupSchemaGroupPayload {
  name:  string
  color?: string
  slots: GroupSchemaSlotPayload[]
}

export interface GroupSchemaPayload {
  version: 1
  groups:  GroupSchemaGroupPayload[]
}

export interface GroupSchema {
  id:          string
  userId:      string
  workspaceId: string | null
  projectId:   string | null
  name:        string
  slug:        string
  description: string | null
  color:       string
  groupsJson:  unknown
  shared:      boolean
  archivedAt:  string | null
  createdAt:   string
  updatedAt:   string
  scope:       PersonaScope
}

// ─────────────────────────────────────────────────────────────────────────────
// Personas
// ─────────────────────────────────────────────────────────────────────────────

export type PersonaScope = 'personal' | 'workspace' | 'project'

export interface Persona {
  id: string
  userId: string
  workspaceId: string | null
  projectId: string | null
  name: string
  slug: string
  description: string | null
  agentKey: AgentKey
  role: AgentRole
  systemPrompt: string
  defaultCwd: string | null
  defaultDaemonId: string | null
  color: string
  icon: string
  tags: string[]
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  scope: PersonaScope
  launchCount?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspect Feature Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Single-element inspect (jerico-design item 1). `kind` optional for backward compat. */
export interface ElementInspectPayload {
  kind?: 'element'
  selector: string
  tagName: string
  id: string
  classes: string[]
  htmlSnippet: string
  computedStyles: Record<string, string>
  attributes: Record<string, string>
  textSnippet: string
  rectViewport: Rect
  rectPage: Rect
  devicePixelRatio: number
  sourceFile: string | null
  screenshotDataUrl?: string
}

/** One element inside a drawn region (jerico-design item 2). Lean descriptor — no computedStyles. */
export interface RegionElement {
  selector: string
  tagName: string
  role: string | null
  htmlSnippet: string
  rectViewport: Rect
}

/** Region-select + annotate (jerico-design item 2). No screenshot in item-2; item-3 fills it. */
export interface RegionInspectPayload {
  kind: 'region'
  rectViewport: Rect
  rectPage: Rect
  annotation: string
  elements: RegionElement[]
  devicePixelRatio: number
  screenshotDataUrl?: string
}

export type InspectPayload = ElementInspectPayload | RegionInspectPayload

// ─────────────────────────────────────────────────────────────────────────────
// Active Panel Capacity & PTY Health
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fallback panel cap, used only when a daemon does not advertise its own.
 *
 * This was a bare `8` and it was wrong twice over. It is not the number the
 * machine can carry — the user routinely ran ~30 panels on a larger machine, and
 * measurement on a 16 GB one put the binding constraint at roughly 20–25, with
 * agent processes averaging ~200 MB resident. And it was guarding the wrong
 * resource: the known /dev/ptmx leak (`daemon/src/pty/manager.ts:435`, one fd per
 * KILLED panel after mitigation) accrues on panel churn over a daemon's lifetime,
 * not on how many are alive at once, so a concurrency cap never constrained it at
 * all. Live measurement while investigating: 16 ptmx fds against 4 live panels,
 * 20 of a 511 system ceiling in use — the fds tracked panels killed, not panels
 * running.
 *
 * So capacity is a property of the machine, and the daemon is the only party that
 * knows the machine. It advertises `maxActivePanels` and the server uses that;
 * this constant is the floor for a daemon too old to send one.
 */
export const MAX_ACTIVE_PANELS = 8

/** Upper bound on an advertised or configured cap. Not a resource limit — a guard
 *  against a typo or a hostile value turning into an unbounded spawn loop. */
export const MAX_ACTIVE_PANELS_CEILING = 128

/**
 * Panels a machine can carry, from its RAM.
 *
 * Derived rather than fixed because the answer differs per machine by a factor of
 * several. Agent processes measured at ~200 MB resident mean; half of physical RAM
 * is left to everything else, including the panels' own growth as their context
 * fills — an agent's footprint at the end of a long session is much larger than at
 * spawn, which is why the divisor is deliberately pessimistic.
 */
export function panelCapacityForMachine(totalBytes: number, opts: { perPanelBytes?: number } = {}): number {
  const perPanel = opts.perPanelBytes ?? 400 * 1024 * 1024
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return MAX_ACTIVE_PANELS
  const budget = Math.floor((totalBytes / 2) / perPanel)
  return Math.min(MAX_ACTIVE_PANELS_CEILING, Math.max(MAX_ACTIVE_PANELS, budget))
}

/** Clamp a cap from a daemon or a config file. An absent or nonsense value falls
 *  back to the floor rather than to "unlimited": a refusal with a clear error is
 *  recoverable, silent resource exhaustion is not. */
export function resolveActivePanelCap(advertised: unknown): number {
  const n = typeof advertised === 'number' ? advertised : Number.NaN
  if (!Number.isFinite(n) || n < 1) return MAX_ACTIVE_PANELS
  return Math.min(MAX_ACTIVE_PANELS_CEILING, Math.floor(n))
}

export interface CapacityPanelLike {
  status?: string
  role?: string
  agentKey?: string
  orchestratorOwned?: boolean
}

/**
 * Shared predicate for panels that consume active PTY capacity.
 * Active panels are regular AI/project panels (including orchestrator-owned worker panels)
 * in 'spawning' or 'running' status.
 * History entries (disconnected, exited, error), runners, and simulators do not count.
 */
export function consumesActiveCapacity(panel: CapacityPanelLike): boolean {
  if (panel.role === 'runner' || panel.role === 'simulator' || panel.agentKey === 'sim_ios') {
    return false
  }
  const status = panel.status ?? 'spawning'
  return status === 'spawning' || status === 'running'
}

export type HelperPreflightStatus = 'not_applicable' | 'missing' | 'not_executable' | 'executable'
export type ProbeStatus = 'ok' | 'spawn_failed' | 'skipped'
export type PtyProbeErrorCategory = 'none' | 'spawn_failed' | 'permission_denied' | 'resource_limit' | 'unknown'

export interface PtyHealthInfo {
  preflight: HelperPreflightStatus
  probe: ProbeStatus
  probeErrorCategory?: PtyProbeErrorCategory
  spawnHelperBroken: boolean
}

/** Positive PTY generation bound to browser terminal input. Optional so untagged
 *  clients keep writing; missing/invalid tags are never recovery-authoritative. */
export function sanitizeInputPanelInstanceId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

export function sanitizeInputReplay(value: unknown): boolean | undefined {
  return value === true ? true : undefined
}
