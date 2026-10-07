/**
 * Thin HTTP wrapper for Bridge API calls.
 * All functions accept an explicit BridgeContext instead of reading env vars,
 * so the same code works for both stdio (env-based context) and HTTP (request-based context).
 */

export interface BridgeContext {
  serverUrl:   string
  token:       string
  workspaceId: string
  projectId:   string
  agentId?:    string   // set for orchestration worker panels
  personaId?:  string   // set when panel was spawned from a persona
  groupId?:    string   // set when panel belongs to a group topology
}

export class BridgeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : undefined
    super(typeof record?.['error'] === 'string' ? record['error'] : `HTTP ${status}`)
    this.name = 'BridgeApiError'
  }
}

function projectPath(ctx: BridgeContext, suffix = '', projectIdOverride?: string): string {
  const base = ctx.serverUrl.replace(/\/$/, '')
  // Treat empty/whitespace strings as missing — `??` only catches null/undefined,
  // but Zod's z.string().optional() allows empty strings, which would produce
  // a malformed URL (.../projects//events).
  const trimmed = projectIdOverride?.trim()
  const pid     = trimmed || ctx.projectId
  return `${base}/api/workspaces/${ctx.workspaceId}/projects/${pid}${suffix}`
}

export function workspacePath(ctx: BridgeContext, suffix = ''): string {
  const base = ctx.serverUrl.replace(/\/$/, '')
  return `${base}/api/workspaces/${ctx.workspaceId}${suffix}`
}

const DEFAULT_TIMEOUT_MS = 30_000

export async function request<T>(
  ctx:    BridgeContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url:    string,
  body?:  unknown,
  opts?:  { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization':    `Bearer ${ctx.token}`,
        'Content-Type':     'application/json',
        // A6: forward panel identity so server can resolve personaId from relay session (B1)
        ...(ctx.agentId ? { 'X-Bridge-Panel-Id': ctx.agentId } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let parsedBody: unknown = text
      try {
        parsedBody = JSON.parse(text) as unknown
      } catch { /* non-JSON body — use raw text */ }
      const body = parsedBody && typeof parsedBody === 'object'
        ? parsedBody
        : { ok: false, error: text || `HTTP ${res.status}` }
      throw new BridgeApiError(res.status, body)
    }
    // 204/empty bodies have no JSON to parse — res.json() throws on them (reproduced
    // with Bun's fetch: a 204 is `ok` but `.json()` throws "Unexpected end of JSON
    // input"). Any other empty-body success response hits the same failure mode.
    if (res.status === 204) return undefined as T
    const text = typeof res.text === 'function'
      ? await res.text()
      : JSON.stringify(await res.json())
    if (text.length === 0) return undefined as T
    return JSON.parse(text) as T
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${method} ${url}`)
    }
    throw err
  }
}

// ── Project plan ─────────────────────────────────────────────────────────────

export interface ProjectData {
  id:          string
  name:        string
  description: string
  blueprintUpdatedAt?: string | null
  cwd?:        string
  machineId?:  string
}

export async function getProject(ctx: BridgeContext): Promise<ProjectData> {
  return request<ProjectData>(ctx, 'GET', projectPath(ctx))
}

export async function getProjectDigest(ctx: BridgeContext): Promise<{ cwd: string; digest: string; bytes: number }> {
  return request<{ cwd: string; digest: string; bytes: number }>(ctx, 'GET', projectPath(ctx, '/digest'))
}

export async function updateProject(ctx: BridgeContext, description: string): Promise<ProjectData> {
  const res = await request<{ project: ProjectData }>(ctx, 'PATCH', projectPath(ctx), { description })
  return res.project
}

// ── Todos ─────────────────────────────────────────────────────────────────────

export interface TodoData {
  id:             string
  seq:            number
  title:          string
  status:         string
  estimatedAgent: string
  dependsOn:      string[]
  todoType?:      string
  assignedAgent?: string
  priority?:      number
}

export interface SessionSummary {
  id:     string
  spec:   string
  status: string
  name:   string | null
}

export async function getTodos(ctx: BridgeContext, scope?: 'planning' | 'active'): Promise<{ todos: TodoData[]; session: SessionSummary | null }> {
  const qs = scope === 'active' ? '?scope=active' : ''
  return request<{ todos: TodoData[]; session: SessionSummary | null }>(ctx, 'GET', projectPath(ctx, `/todos${qs}`))
}

export async function cancelRun(ctx: BridgeContext): Promise<{ ok: boolean; cancelled: number }> {
  return request<{ ok: boolean; cancelled: number }>(ctx, 'POST', projectPath(ctx, '/runs/cancel'))
}

export async function addTodo(
  ctx:            BridgeContext,
  title:          string,
  estimatedAgent: string,
  dependsOn?:     string[],
  todoType?:      string,
): Promise<{ todo: TodoData }> {
  return request<{ todo: TodoData }>(ctx, 'POST', projectPath(ctx, '/todos'), { title, estimatedAgent, dependsOn, todoType })
}

export async function updateTodoStatus(
  ctx:    BridgeContext,
  id:     string,
  status: string,
): Promise<{ ok: boolean }> {
  await request<unknown>(ctx, 'PATCH', projectPath(ctx, `/todos/${id}`), { status })
  return { ok: true }
}

export async function updateTodo(
  ctx:     BridgeContext,
  id:      string,
  updates: { title?: string; status?: string },
): Promise<{ ok: boolean }> {
  await request<unknown>(ctx, 'PATCH', projectPath(ctx, `/todos/${id}`), updates)
  return { ok: true }
}

// ── Runs ──────────────────────────────────────────────────────────────────────

export interface RunTodoData {
  id:             string
  title:          string
  status:         string
  transcript?:    string
  retryCount:     number
  todoType?:      string
  startedAt:      string | null
  completedAt:    string | null
  assignedAgent?: string
}

export interface RunData {
  id:        string
  spec:      string
  status:    string
  createdAt: string
  total:     number
  done:      number
  failed:    number
  todos:     RunTodoData[]
}

export async function getExecutionStatus(ctx: BridgeContext): Promise<{ runs: RunData[] }> {
  return request<{ runs: RunData[] }>(ctx, 'GET', projectPath(ctx, '/runs'))
}

// ── Project history ───────────────────────────────────────────────────────────

export interface FailedTodoSummary {
  seq:          number
  title:        string
  errorMessage: string | null
  failureHint:  string | null
}

export interface CompletedTodoSummary {
  seq:   number
  title: string
}

export interface RunHistorySummary {
  id:             string
  name:           string | null
  spec:           string
  status:         string
  createdAt:      string
  progress:       string
  failedTodos:    FailedTodoSummary[]
  completedTodos: CompletedTodoSummary[]
}

export interface ProjectHistoryData {
  runs: RunHistorySummary[]
}

export async function getProjectHistory(ctx: BridgeContext, limit?: number): Promise<ProjectHistoryData> {
  const qs = limit !== undefined ? `?limit=${limit}` : ''
  return request<ProjectHistoryData>(ctx, 'GET', projectPath(ctx, `/history${qs}`))
}

// ── MCP-native orchestration ──────────────────────────────────────────────────

export interface AssignmentData {
  todo:        TodoData | null
  runId:       string | null
  projectId?:  string
  projectName?: string
  projectCwd?: string | null
}

export async function getMyAssignment(ctx: BridgeContext): Promise<AssignmentData> {
  if (!ctx.agentId) throw new Error('agentId not set in BridgeContext')
  const url = `${projectPath(ctx, '/assignment')}?agentId=${encodeURIComponent(ctx.agentId)}`
  return request<AssignmentData>(ctx, 'GET', url)
}

export async function completeMyTask(ctx: BridgeContext, todoId: string, receiptId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(ctx, 'POST', projectPath(ctx, `/todos/${todoId}/done`), { receiptId, outcome: 'complete' })
}

export async function failMyTask(ctx: BridgeContext, todoId: string, receiptId: string, failureCode: string, note?: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(ctx, 'POST', projectPath(ctx, `/todos/${todoId}/fail`), { receiptId, outcome: 'failed', failureCode, note })
}

export async function completeFreeTask(
  ctx: BridgeContext,
  receiptId: string,
  outcome: 'complete' | 'failed',
  failureCode?: string,
  note?: string,
  result?: unknown,
): Promise<{ ok: boolean; completionId: string; outcome: string }> {
  return request(ctx, 'POST', workspacePath(ctx, '/completion/free'), { receiptId, outcome, failureCode, note, result })
}

export function acknowledgeScheduledDuty(ctx: BridgeContext, receiptId: string): Promise<{ ok: boolean }> {
  return request(ctx, 'POST', workspacePath(ctx, '/completion/scheduled/ack'), { receiptId })
}

export interface TodoContextData {
  todoId: string
  title:  string
  status: string
  output: string | null
}

export async function getTodoContext(ctx: BridgeContext, todoId: string, lines?: number): Promise<TodoContextData> {
  const qs = lines !== undefined ? `?lines=${lines}` : ''
  return request<TodoContextData>(ctx, 'GET', projectPath(ctx, `/todos/${todoId}/context${qs}`))
}

// ── Agent Messaging ───────────────────────────────────────────────────────────

export interface AgentMessageData {
  id:          string
  fromAgentId: string
  toAgentId?:  string
  content:     string
  ts:          number
}

export interface SendAgentMessageResult {
  ok: boolean
  messageId?: string
  queued?: boolean
  pushed?: boolean
  failedAgentIds?: string[]
}

export async function sendAgentMessage(
  ctx:        BridgeContext,
  content:    string,
  toAgentId?: string,
  confirmBlastRadius?: boolean,
): Promise<SendAgentMessageResult> {
  const body: { fromAgentId: string | undefined; toAgentId: string | undefined; content: string; confirmBlastRadius?: boolean } =
    { fromAgentId: ctx.agentId, toAgentId, content }
  if (confirmBlastRadius === true) body.confirmBlastRadius = true
  return request<SendAgentMessageResult>(ctx, 'POST', projectPath(ctx, '/messages'), body)
}

export async function pollAgentMessages(
  ctx:    BridgeContext,
  since?: number,
): Promise<{ messages: AgentMessageData[]; cursor: number }> {
  if (!ctx.agentId) return { messages: [], cursor: Date.now() }
  const qs = `?agentId=${encodeURIComponent(ctx.agentId)}${since !== undefined ? `&since=${since}` : ''}`
  return request<{ messages: AgentMessageData[]; cursor: number }>(
    ctx,
    'GET',
    projectPath(ctx, `/messages${qs}`),
  )
}

// ── Panel management ──────────────────────────────────────────────────────────

export interface AgentStatusData {
  agentId:       string
  agentKey:      string
  daemonId:      string
  mcpConfigured: boolean
  status:        'idle' | 'busy' | 'disconnected'
  assignedTodo:  { id: string; title: string; status: string } | null
  role:          string | null
  runnerCmd:     string | null
  projectId:     string | null
  inRun:         boolean
  state:         'idle' | 'working'
  lastOutputAt:  number | undefined
  contextUsedPct: number | null
  contextUsedTokens: number | null
  name:          string
  ordinal:       number | null
  model:         string | null
}

/** True when this MCP context is bound to a real project (project-scoped
 *  orchestrator / worker). 'workspace' is the explicit workspace-scope opt-in. */
export function isProjectScoped(ctx: BridgeContext): boolean {
  return !!ctx.projectId && ctx.projectId !== 'workspace'
}

export interface SessionContext {
  panelId:      string | null
  workspaceId:  string
  projectId:    string | null
  projectName:  string | null
  groupId:      string | null
  scope:        'workspace' | 'this project only'
  workspaceRole: string
  eventAccess: 'read' | 'write'
  capabilities: Record<string, boolean>
  capabilitiesVersion: number
}

const ACTOR_CAPABILITY_LABELS = [
  ['project.read', 'project.read'],
  ['project.write', 'project.write'],
  ['orchestration.observe', 'orchestration.observe'],
  ['orchestration.execute', 'orchestration.execute'],
  ['events.read', 'events.read'],
  ['events.write', 'events.write'],
  ['prompts.write', 'prompts.write'],
  ['workspace.members.manage', 'members.manage'],
] as const

/**
 * Render the short, volatile capability summary shown to an agent. The
 * booleans are the server-resolved session snapshot; this presentation layer
 * deliberately contains no role/capability resolution logic of its own.
 */
export function renderActorCapabilitiesHeader(
  session: Pick<SessionContext, 'workspaceRole' | 'eventAccess' | 'capabilities' | 'capabilitiesVersion'>,
): string {
  const allowed: string[] = []
  const denied: string[] = []
  for (const [capability, label] of ACTOR_CAPABILITY_LABELS) {
    const bucket = session.capabilities[capability] === true ? allowed : denied
    bucket.push(label)
  }

  return (
    `[JERICO ACTOR CAPABILITIES — authoritative snapshot, server enforcement always wins]\n` +
    `workspaceRole: ${session.workspaceRole}\n` +
    `eventAccess: ${session.eventAccess}\n` +
    `capabilitiesVersion: ${session.capabilitiesVersion}\n` +
    `allowed: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}\n` +
    `denied: ${denied.length > 0 ? denied.join(', ') : '(none)'}\n` +
    `If a tool returns permission_denied, do not retry or attempt to work around it — explain the missing permission to the user instead.\n` +
    `---\n\n`
  )
}

export async function resolveSessionContext(ctx: BridgeContext): Promise<SessionContext> {
  const accessResponse = await request<{
    access: {
      workspaceRole: string
      eventAccess: 'read' | 'write'
      capabilities: Record<string, boolean>
      capabilitiesVersion: number
    }
  }>(ctx, 'GET', workspacePath(ctx))
  const isWorkspace = !ctx.projectId || ctx.projectId === 'workspace'
  let projectName: string | null = isWorkspace ? null : ctx.projectId!
  if (!isWorkspace) {
    try {
      const projRes = await getProject(ctx)
      if (projRes.name) projectName = projRes.name
    } catch { /* keep projectId as fallback */ }
  }
  return {
    panelId:      ctx.agentId ?? null,
    workspaceId:  ctx.workspaceId,
    projectId:    isWorkspace ? null : ctx.projectId!,
    projectName,
    groupId:      ctx.groupId ?? null,
    scope:        isWorkspace ? 'workspace' : 'this project only',
    ...accessResponse.access,
  }
}

export async function listAgents(ctx: BridgeContext): Promise<{ panels: AgentStatusData[] }> {
  // Project-scoped contexts get a STRICT project filter — agents of other
  // projects are never visible. Workspace scope keeps the workspace-wide list.
  const suffix = isProjectScoped(ctx)
    ? `/agents?projectId=${encodeURIComponent(ctx.projectId)}`
    : '/agents'
  return request<{ panels: AgentStatusData[] }>(ctx, 'GET', workspacePath(ctx, suffix))
}

export async function getAgentStatus(ctx: BridgeContext, agentId: string): Promise<AgentStatusData> {
  return request<AgentStatusData>(ctx, 'GET', projectPath(ctx, `/agents/${agentId}`))
}

export async function spawnAgent(
  ctx:       BridgeContext,
  agentKey:  string,
  daemonId?: string,
  role?:     string,
  cmd?:      string,
  model?:    string,
  confirmBlastRadius?: boolean,
): Promise<{ ok: boolean; agentId: string; agentKey: string; daemonId: string; name?: string; ordinal?: number }> {
  const body: { agentKey: string; daemonId?: string; role?: string; cmd?: string; model?: string; confirmBlastRadius?: boolean } =
    { agentKey, daemonId, role, cmd, model }
  if (confirmBlastRadius === true) body.confirmBlastRadius = true
  return request(ctx, 'POST', projectPath(ctx, '/agents'), body)
}

export async function killAgent(ctx: BridgeContext, agentId: string): Promise<{ ok: boolean }> {
  const base = ctx.serverUrl.replace(/\/$/, '')
  // Workspace-scoped panels (e.g. global orchestrator) use the workspace endpoint.
  const url = ctx.projectId && ctx.projectId !== 'workspace'
    ? `${base}/api/workspaces/${ctx.workspaceId}/projects/${ctx.projectId}/agents/${agentId}`
    : `${base}/api/workspaces/${ctx.workspaceId}/agents/${agentId}`
  return request<{ ok: boolean }>(ctx, 'DELETE', url)
}

/**
 * Issue #39: in-session (no-respawn) model switch. Only live-enabled for
 * agents in IN_SESSION_MODEL_SWITCH_ENABLED (currently claude/aider/ollama —
 * see packages/shared/src/agent-models.ts); the server returns
 * { ok: false, error: 'agent_not_enabled' } for anything else rather than
 * silently ignoring the request.
 */
export async function setAgentModel(ctx: BridgeContext, agentId: string, model: string): Promise<{ ok: boolean; agentId?: string; model?: string; error?: string; message?: string }> {
  const base = ctx.serverUrl.replace(/\/$/, '')
  const url = `${base}/api/workspaces/${ctx.workspaceId}/agents/${agentId}/model`
  return request(ctx, 'POST', url, { model })
}

export async function assignTask(
  ctx:     BridgeContext,
  todoId:  string,
  agentId: string,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(ctx, 'POST', projectPath(ctx, `/todos/${todoId}/assign`), { agentId })
}

// ── Panel I/O ─────────────────────────────────────────────────────────────────

export interface AgentOutputData {
  agentId:       string
  output:        string
  /** Opaque server-assigned cursor (issue #512 P1.2) — round-trip it on the
   *  next call to receive only new output since this read. */
  cursor?:       string
  /** true when a supplied cursor went stale (buffer evicted / panel respawned)
   *  and `output` is the full tail instead of a delta. */
  cursor_reset?: boolean
}

export async function getAgentOutput(ctx: BridgeContext, agentId: string, lines?: number, cursor?: string): Promise<AgentOutputData> {
  const params = new URLSearchParams()
  if (lines !== undefined) params.set('lines', String(lines))
  if (cursor) params.set('cursor', cursor)
  const qs = params.toString()
  return request<AgentOutputData>(ctx, 'GET', projectPath(ctx, `/panels/${agentId}/output${qs ? `?${qs}` : ''}`))
}

export interface SendAgentInputResult {
  ok: boolean
  error?: string
  message?: string
  lastOutputAgeMs?: number | null
  submitState?: { state: 'accepted' | 'forced' | 'submitted' | 'failed' | 'timeout'; error?: string }
}

export async function sendAgentInput(ctx: BridgeContext, agentId: string, text: string, confirmBlastRadius?: boolean): Promise<SendAgentInputResult> {
  const body: { text: string; confirmBlastRadius?: boolean } = { text }
  if (confirmBlastRadius === true) body.confirmBlastRadius = true
  return request<SendAgentInputResult>(ctx, 'POST', workspacePath(ctx, `/agents/${agentId}/input`), body)
}

export type FreeTaskOutcomeResult = { status: 'unresolved'; completionId: string } | {
  status: 'accepted'; completionId: string; agentId: string; panelInstanceId: number; dispatchId: string
  outcome: 'complete' | 'failed'; failureCode: string | null; evidence: 'daemon_sealed_receipt'; acceptedAt: string
}
export function getFreeTaskOutcome(ctx: BridgeContext, completionId: string) {
  return request<FreeTaskOutcomeResult>(ctx, 'GET', workspacePath(ctx, `/completion/free/${encodeURIComponent(completionId)}`))
}

export interface DispatchTracking {
  completionId: string
  watchId: string
  dispatchId: string
  agentId: string
  panelInstanceId: number
  completionWatch: 'armed_before_input'
  hostSubscription: 'unverified'
  supervision: 'required'
  deduplicateBy: 'completionId'
  policy: {
    outcomeRead: { tool: 'bridge_get_free_task_outcome'; args: { completionId: string } }
    mode: 'monitor_and_deep_peek'
    automaticTracking: 'unverified'
    deepPeek: {
      tool: 'bridge_peek_panel'
      args: { agentId: string; lines: 300; expectedPanelInstanceId: number }
      intervalMs: 120000
      independentOfMonitor: true
    }
    taskState: { key: string; lastCheckAt: null; ownedMonitorHandle: null; preventOverlappingChecks: true }
    cleanup: {
      terminalAuthority: 'accepted_daemon_sealed_receipt'
      scope: 'completionId'
      stopOwnedMonitor: true
      stopPeekLoop: true
      sharedStream: 'keep_until_last_task'
      killWorkerPanel: false
      cancellation: 'stop_owned_consumer_without_verdict'
    }
  }
  instructions: string
}

export interface DispatchTaskResult {
  ok: boolean
  watcherArmed: boolean
  completionId: string
  completionProtocol: 'mcp-receipt-daemon-seal'
  submitState: NonNullable<SendAgentInputResult['submitState']>
  // Optional while older servers remain in use; absence is not readiness.
  tracking?: DispatchTracking
}

export interface DispatchBriefResult extends DispatchTaskResult {
  projectId: string
  guardrailsIncluded: boolean
  guardrailsTruncated: boolean
}

export async function dispatchBrief(
  ctx: BridgeContext,
  agentId: string,
  text: string,
  taskSuffix?: string,
  watchFile?: string,
): Promise<DispatchBriefResult> {
  return request<DispatchBriefResult>(
    ctx,
    'POST',
    workspacePath(ctx, `/agents/${agentId}/dispatch-brief`),
    { text, taskSuffix, watchFile },
  )
}

export async function dispatchFreeTask(
  ctx: BridgeContext,
  agentId: string,
  text: string,
  taskSuffix?: string,
): Promise<DispatchTaskResult> {
  return request(ctx, 'POST', workspacePath(ctx, `/agents/${agentId}/dispatch-free-task`), { text, taskSuffix })
}

export async function watchPanel(ctx: BridgeContext, agentId: string, taskSuffix?: string, watchFile?: string, force?: boolean): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(ctx, 'POST', workspacePath(ctx, `/agents/${agentId}/watch`), { taskSuffix, watchFile, force })
}

export async function unwatchPanel(ctx: BridgeContext, agentId: string, force?: boolean): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(ctx, 'POST', workspacePath(ctx, `/agents/${agentId}/unwatch`), { force })
}

// ── Agent idle state ─────────────────────────────────────────────────────────

export interface AgentIdleData {
  agentId:       string
  idle:          boolean
  // Issue #85: 'awaiting_input' means the panel looks blocked on an
  // interactive menu/confirmation prompt, not finished — use
  // bridge_send_keys, not bridge_send_input, to clear it.
  state:         'idle' | 'working' | 'awaiting_input'
  lastOutputAt:  number
  lastOutputAgeMs: number | null
  awaitingInput: boolean
}

export async function getAgentIdle(ctx: BridgeContext, agentId: string): Promise<AgentIdleData> {
  return request<AgentIdleData>(ctx, 'GET', projectPath(ctx, `/agents/${agentId}/idle`))
}

// ── Raw keystrokes (issue #85) ────────────────────────────────────────────────

export async function sendAgentKeys(
  ctx: BridgeContext,
  agentId: string,
  keys: string[],
): Promise<{ ok: boolean; error?: string; message?: string }> {
  return request<{ ok: boolean; error?: string; message?: string }>(
    ctx, 'POST', workspacePath(ctx, `/agents/${agentId}/keys`), { keys },
  )
}

// ── Project events ────────────────────────────────────────────────────────────

export interface RecordEventParams {
  eventType:  string
  summary:    string
  sessionId?: string
  payload?:   unknown
  tags?:      string[]
  permanent?: boolean
  personaId?: string   // advisory — server always overrides with relay-resolved value (C2)
  /**
   * Override target project. If omitted, uses ctx.projectId baked at MCP
   * startup. The orchestrator runs at workspace scope and must pass this
   * to record events on a specific project.
   */
  projectId?: string
}

export interface ProjectEvent {
  id:         string
  projectId:  string | null
  personaId:  string | null
  role:       string
  eventType:  string
  summary:    string
  payload:    unknown
  tags:       string[]
  permanent:  boolean
  sessionId:  string | null
  archivedAt: string | null
  createdAt:  string | null
}

export async function recordProjectEvent(
  ctx:    BridgeContext,
  params: RecordEventParams,
): Promise<{ id: string; createdAt: string | null }> {
  // Pass agentId so the server can enrich role server-side from the relay session.
  // params.projectId (if present) overrides ctx.projectId — required for the orchestrator
  // since it runs at workspace scope without a fixed project.
  const { projectId, ...body } = params
  const explicitProjectId = projectId?.trim()
  // Workspace-scoped orchestrator (ctx.projectId === 'workspace') without explicit projectId
  // routes to the workspace-level event endpoint instead of producing a 404.
  const isWorkspaceScope = ctx.projectId === 'workspace' && !explicitProjectId
  const url = isWorkspaceScope
    ? workspacePath(ctx, '/events')
    : projectPath(ctx, '/events', explicitProjectId)
  return request<{ id: string; createdAt: string | null }>(
    ctx,
    'POST',
    url,
    { ...body, agentId: ctx.agentId },
  )
}

export async function getProjectEvents(
  ctx:    BridgeContext,
  opts?:  { projectId?: string; workspaceScope?: boolean; role?: string; eventType?: string; personaId?: string; tags?: string; since?: string; search?: string; limit?: number; includeArchived?: boolean; permanent?: boolean },
): Promise<{ events: ProjectEvent[] }> {
  const params = new URLSearchParams()
  if (opts?.role)            params.set('role', opts.role)
  if (opts?.eventType)       params.set('eventType', opts.eventType)
  if (opts?.personaId)       params.set('personaId', opts.personaId)
  if (opts?.tags)            params.set('tags', opts.tags)
  if (opts?.since)           params.set('since', opts.since)
  if (opts?.search)          params.set('search', opts.search)
  if (opts?.limit)           params.set('limit', String(opts.limit))
  if (opts?.includeArchived) params.set('includeArchived', 'true')
  if (opts?.permanent)       params.set('permanent', 'true')
  if (ctx.agentId)           params.set('readerAgentId', ctx.agentId)
  const qs = params.toString()
  const basePath = opts?.workspaceScope
    ? workspacePath(ctx, `/events${qs ? '?' + qs : ''}`)
    : projectPath(ctx, `/events${qs ? '?' + qs : ''}`, opts?.projectId)
  return request<{ events: ProjectEvent[] }>(ctx, 'GET', basePath)
}

export async function getProjectMemory(
  ctx:    BridgeContext,
  opts:   { projectId?: string; limit?: number },
): Promise<{ events: ProjectEvent[]; omitted: { crossBranch: number }; advisory: { unresolved: number } }> {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit ?? 20))
  if (ctx.agentId) params.set('readerAgentId', ctx.agentId)
  const qs = params.toString()
  const basePath = projectPath(ctx, `/events/memory${qs ? '?' + qs : ''}`, opts.projectId)
  return request<{ events: ProjectEvent[]; omitted: { crossBranch: number }; advisory: { unresolved: number } }>(ctx, 'GET', basePath)
}

// ── Personas ──────────────────────────────────────────────────────────────────

export interface PersonaData {
  id:              string
  userId:          string
  workspaceId:     string | null
  projectId:       string | null
  name:            string
  slug:            string
  description:     string | null
  agentKey:        string
  role:            string
  systemPrompt:    string
  defaultCwd:      string | null
  defaultDaemonId: string | null
  color:           string
  icon:            string
  tags:            string[]
  archivedAt:      string | null
  createdAt:       string
  updatedAt:       string
  scope:           'personal' | 'workspace' | 'project'
}

export async function listPersonas(
  ctx:  BridgeContext,
  opts: { projectId?: string; scope?: string; includeArchived?: boolean; excludePersonal?: boolean; agentKey?: string; role?: string; tag?: string; q?: string; limit?: number },
): Promise<{ personas: PersonaData[]; total: number; page: number; pageSize: number }> {
  const params = new URLSearchParams()
  if (opts.projectId)       params.set('projectId', opts.projectId)
  if (opts.scope)           params.set('scope', opts.scope)
  if (opts.includeArchived) params.set('includeArchived', 'true')
  if (opts.excludePersonal) params.set('excludePersonal', 'true')
  if (opts.agentKey)        params.set('agentKey', opts.agentKey)
  if (opts.role)            params.set('role', opts.role)
  if (opts.tag)             params.set('tag', opts.tag)
  if (opts.q)               params.set('q', opts.q)
  if (opts.limit)           params.set('pageSize', String(opts.limit))
  const qs = params.toString()
  return request(ctx, 'GET', workspacePath(ctx, `/personas${qs ? '?' + qs : ''}`))
}

export async function getPersona(
  ctx:    BridgeContext,
  params: { id: string; projectId?: string; fields?: Array<'id' | 'name' | 'systemPrompt' | 'description' | 'createdAt'> },
): Promise<{ persona: Partial<PersonaData> }> {
  const qs = new URLSearchParams()
  if (params.fields?.length) qs.set('fields', params.fields.join(','))
  const qstr = qs.toString()
  const res = await request<{ persona: PersonaData }>(ctx, 'GET', workspacePath(ctx, `/personas/${encodeURIComponent(params.id)}${qstr ? '?' + qstr : ''}`))
  if (params.fields?.length && res.persona) {
    const projected: Partial<PersonaData> = {}
    for (const k of params.fields) {
      if (k in res.persona) (projected as any)[k] = (res.persona as any)[k]
    }
    return { persona: projected }
  }
  return res
}

export async function createPersona(
  ctx:    BridgeContext,
  params: {
    name: string
    slug: string
    description?: string
    agentKey: string
    role: string
    systemPrompt?: string
    defaultCwd?: string
    defaultDaemonId?: string
    color?: string
    icon?: string
    tags?: string[]
    projectId?: string
  },
): Promise<{ persona: PersonaData }> {
  const body = { ...params, scope: params.projectId ? 'project' : 'workspace' }
  return request(ctx, 'POST', workspacePath(ctx, '/personas'), body)
}

export async function updatePersona(
  ctx:    BridgeContext,
  params: {
    id: string
    name?: string
    description?: string
    systemPrompt?: string
    defaultCwd?: string
    defaultDaemonId?: string
    color?: string
    icon?: string
    tags?: string[]
  },
): Promise<{ persona: PersonaData }> {
  const { id, ...body } = params
  return request(ctx, 'PATCH', workspacePath(ctx, `/personas/${encodeURIComponent(id)}`), body)
}

export async function archivePersona(
  ctx: BridgeContext,
  id:  string,
): Promise<{ ok: boolean; archivedAt: string | null }> {
  return request(ctx, 'POST', workspacePath(ctx, `/personas/${encodeURIComponent(id)}/archive`))
}

export async function launchPersona(
  ctx:    BridgeContext,
  params: {
    id: string
    projectId?: string
    daemonId?: string
    cwd?: string
    cols?: number
    rows?: number
  },
): Promise<{ ok: boolean; agentId: string; agentKey: string; daemonId: string }> {
  const { id, projectId, ...rest } = params
  const trimmed = projectId?.trim()
  const pid = trimmed || ctx.projectId
  if (pid === 'workspace') {
    throw new Error('launchPersona requires a real projectId — cannot launch into workspace scope')
  }
  const body = pid ? { ...rest, projectId: pid } : rest
  return request(ctx, 'POST', workspacePath(ctx, `/personas/${encodeURIComponent(id)}/launch`), body)
}

export async function applyPersona(
  ctx:    BridgeContext,
  params: {
    agentId: string
    personaId: string
  },
): Promise<{ ok: boolean; personaId: string; personaName: string }> {
  return request(ctx, 'PATCH', workspacePath(ctx, `/agents/${encodeURIComponent(params.agentId)}/persona`), {
    personaId: params.personaId,
  })
}

// ── Persona Schedules (checkpoint 4b) ────────────────────────────────────────

export interface PersonaScheduleData {
  id:               string
  userId:           string
  workspaceId:      string
  projectId:        string
  personaId:        string
  daemonId:         string
  duty:             string
  kind:             'daily' | 'weekly'
  atTime:           string
  weekdays:         number[] | null
  timezone:         string
  expectedBranchRef: string | null
  model:            string | null
  guardrailMode: 'read_only_report' | 'edit_worktree' | 'custom'
  guardrailText: string | null
  guardrailSetVia: 'default' | 'human' | 'agent'
  maxRuntimeMs:     number
  enabled:          boolean
  retryOnDaemonOffline: boolean
  version:          number
  nextFireAt:       string | null
  createdBy:        string
  createdVia:       string
  createdAt:        string
  updatedAt:        string
  recentRuns?:      unknown[]
}

export async function listPersonaSchedules(
  ctx:  BridgeContext,
  opts?: { projectId?: string },
): Promise<{ schedules: PersonaScheduleData[] }> {
  const qs = opts?.projectId ? `?projectId=${encodeURIComponent(opts.projectId)}` : ''
  return request<{ schedules: PersonaScheduleData[] }>(ctx, 'GET', workspacePath(ctx, `/persona-schedules${qs}`))
}

export async function getPersonaSchedule(
  ctx: BridgeContext,
  scheduleId: string,
): Promise<{ schedule: PersonaScheduleData }> {
  return request<{ schedule: PersonaScheduleData }>(ctx, 'GET', workspacePath(ctx, `/persona-schedules/${encodeURIComponent(scheduleId)}`))
}

export async function createPersonaSchedule(
  ctx: BridgeContext,
  params: {
    personaId: string
    projectId: string
    daemonId: string
    duty: string
    kind: 'daily' | 'weekly'
    atTime: string
    weekdays?: number[]
    timezone: string
    maxRuntimeMs?: number
    retryOnDaemonOffline?: boolean
    expectedBranchRef?: string | null
    model?: string | null
    guardrailMode?: 'read_only_report' | 'edit_worktree' | 'custom'
    guardrailText?: string | null
  },
): Promise<{ created: boolean; schedule: PersonaScheduleData }> {
  return request<{ created: boolean; schedule: PersonaScheduleData }>(ctx, 'POST', workspacePath(ctx, '/persona-schedules'), params)
}

export async function updatePersonaSchedule(
  ctx: BridgeContext,
  scheduleId: string,
  fields: {
    duty?: string
    kind?: 'daily' | 'weekly'
    atTime?: string
    weekdays?: number[]
    timezone?: string
    maxRuntimeMs?: number
    expectedBranchRef?: string | null
    model?: string | null
    retryOnDaemonOffline?: boolean
    guardrailMode?: 'read_only_report' | 'edit_worktree' | 'custom'
    guardrailText?: string | null
  },
): Promise<{ schedule: PersonaScheduleData }> {
  return request<{ schedule: PersonaScheduleData }>(ctx, 'PATCH', workspacePath(ctx, `/persona-schedules/${encodeURIComponent(scheduleId)}`), fields)
}

export async function enablePersonaSchedule(
  ctx: BridgeContext,
  scheduleId: string,
): Promise<{ schedule: PersonaScheduleData }> {
  return request<{ schedule: PersonaScheduleData }>(ctx, 'POST', workspacePath(ctx, `/persona-schedules/${encodeURIComponent(scheduleId)}/enable`))
}

export async function disablePersonaSchedule(
  ctx: BridgeContext,
  scheduleId: string,
): Promise<{ schedule: PersonaScheduleData }> {
  return request<{ schedule: PersonaScheduleData }>(ctx, 'POST', workspacePath(ctx, `/persona-schedules/${encodeURIComponent(scheduleId)}/disable`))
}

export async function deletePersonaSchedule(
  ctx: BridgeContext,
  scheduleId: string,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(ctx, 'DELETE', workspacePath(ctx, `/persona-schedules/${encodeURIComponent(scheduleId)}`))
}

/** 202 means accepted, not started; an idempotent repeat returns the existing run's current phase. */
export interface PersonaScheduleRunNowResult {
  runId: string
  scheduleId: string
  slotKey: string
  phase: 'pending' | 'retry_wait' | 'starting' | 'running' | 'stopping' | 'closed'
}

export async function runPersonaScheduleNow(
  ctx: BridgeContext,
  scheduleId: string,
  idempotencyKey?: string,
): Promise<PersonaScheduleRunNowResult> {
  return request<PersonaScheduleRunNowResult>(ctx, 'POST', workspacePath(ctx, `/persona-schedules/${encodeURIComponent(scheduleId)}/run-now`),
    idempotencyKey ? { idempotencyKey } : {})
}

// ── Role Prompts (workspace_prompts) ─────────────────────────────────────────

export async function listRolePrompts(
  ctx: BridgeContext,
): Promise<{ prompts: Array<{ role: string; content: string; source: string }> }> {
  // #521 Step 2 FIX D: forward projectId so the bulk serve applies the same
  // per-(user,project) arm resolution as the single-role route.
  const qs = ctx.projectId ? `?projectId=${encodeURIComponent(ctx.projectId)}` : ''
  return request(ctx, 'GET', workspacePath(ctx, `/prompts${qs}`))
}

export async function getRolePrompt(
  ctx:  BridgeContext,
  role: string,
): Promise<{ role: string; content: string; source: string; updatedAt?: string }> {
  const start = Date.now()
  // #521 Step 2: pass projectId so the server strips the codegraph nudge per
  // the arm resolved for THIS (user, project) — not the bare global toggle.
  const qs = ctx.projectId ? `?projectId=${encodeURIComponent(ctx.projectId)}` : ''
  const res = await request<{ role: string; content: string; source: string; updatedAt?: string }>(
    ctx,
    'GET',
    workspacePath(ctx, `/prompts/${encodeURIComponent(role)}${qs}`),
  )
  const latencyMs = Date.now() - start
  const bytes = res.content.length
  console.error('[mcp] mcp.bridge_get_role_prompt', { role, wsId: ctx.workspaceId, latency_ms: latencyMs, bytes })

  // Substitute runtime vars (only ctx-aware site per architecture)
  let content = res.content
  if (content.includes('{{PANEL_ID}}')) {
    content = content.replaceAll('{{PANEL_ID}}', ctx.agentId ?? 'unknown')
    console.error('[mcp] prompts.runtime_var.substituted', { role, var: 'PANEL_ID', resolved: true })
  }
  if (content.includes('{{WORKSPACE_ID}}')) {
    content = content.replaceAll('{{WORKSPACE_ID}}', ctx.workspaceId)
    console.error('[mcp] prompts.runtime_var.substituted', { role, var: 'WORKSPACE_ID', resolved: true })
  }
  if (content.includes('{{PROJECT_ID}}')) {
    content = content.replaceAll('{{PROJECT_ID}}', ctx.projectId)
    console.error('[mcp] prompts.runtime_var.substituted', { role, var: 'PROJECT_ID', resolved: true })
  }
  if (content.includes('{{GROUP_ID}}')) {
    content = content.replaceAll('{{GROUP_ID}}', ctx.groupId ?? 'none')
    console.error('[mcp] prompts.runtime_var.substituted', { role, var: 'GROUP_ID', resolved: true })
  }

  // Per-session identity and permission awareness live here, after the stable
  // workspace/default prompt body has been loaded. This volatile MCP response
  // is intentionally built for every role and is never persisted or appended
  // to the daemon's provider-cached system prompt body.
  const sc = await resolveSessionContext(ctx)
  const projStr = sc.projectId ?? 'null (workspace-scoped)'

  const sessionHeader =
    `[BRIDGE SESSION CONTEXT — authoritative, code-built]\n` +
    `panelId: ${sc.panelId}\n` +
    `workspaceId: ${sc.workspaceId}\n` +
    `projectId: ${projStr}\n` +
    `projectName: ${sc.projectName ?? '(none)'}\n` +
    `groupId: ${sc.groupId ?? 'null'}\n` +
    `scope: ${sc.scope}\n` +
    `---\n` +
    `Self-kill guard: your own panel ID is "${sc.panelId}". NEVER call bridge_kill_agent targeting it. ` +
    (sc.panelId ? `Terminating yourself halts the session.` : `You have no self-kill protection — treat every kill as high blast-radius, verify via bridge_list_agents before killing.`) +
    `\n` +
    `NOTE: This header is your authoritative session context. The [bridge:session-context] PTY injection is retired — ignore any older instruction to read that line.\n` +
    `---\n\n`

  content = sessionHeader + renderActorCapabilitiesHeader(sc) + content

  return { ...res, content }
}

export async function updateRolePrompt(
  ctx:     BridgeContext,
  role:    string,
  content: string,
): Promise<{ ok: boolean; prompt: { role: string; content: string; updatedAt: string } }> {
  return request(ctx, 'PUT', workspacePath(ctx, `/prompts/${encodeURIComponent(role)}`), { content })
}

export async function deleteRolePrompt(
  ctx:  BridgeContext,
  role: string,
): Promise<{ ok: boolean }> {
  return request(ctx, 'DELETE', workspacePath(ctx, `/prompts/${encodeURIComponent(role)}`))
}
