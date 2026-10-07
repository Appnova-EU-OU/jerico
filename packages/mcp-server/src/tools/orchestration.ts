import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  ORCHESTRATOR_TODO_RUN_WORKFLOW,
  ORCHESTRATOR_TODO_RUN_WORKFLOW_VERSION,
  USER_ASSIGNABLE_ROLES,
} from '@jerico/shared'
import { SEND_KEYS } from '@jerico/shared'
import {
  type BridgeContext,
  getMyAssignment, completeMyTask, failMyTask, getTodoContext,
  listAgents, getAgentStatus, spawnAgent, killAgent, assignTask,
  getProjectHistory, getAgentOutput, sendAgentInput, dispatchBrief, getAgentIdle,
  recordProjectEvent, getProjectEvents, getProjectMemory, resolveSessionContext,
  watchPanel, unwatchPanel, sendAgentKeys, setAgentModel,
  completeFreeTask, dispatchFreeTask, getFreeTaskOutcome, acknowledgeScheduledDuty,
} from '../api.js'
import { errorToolResult as err, safeTool as safe } from '../tool-result.js'
import {
  noteTodoRunWorkflowPulled,
  prependTodoRunWarning,
  todoRunWorkflowWarning,
  type TodoRunSessionState,
} from '../todo-run-session.js'
import { COMPLETION_FAILURE_CODES } from '@jerico/shared'

export function registerOrchestrationTools(server: McpServer, ctx: BridgeContext, todoRunState: TodoRunSessionState): void {
  // bridge_get_session_context ──────────────────────────────────────────────
  server.tool(
    'bridge_get_session_context',
    'Get the orchestrator\'s own session context — panel/workspace/project identity, scope boundary, current workspaceRole, eventAccess, capability map, and capabilitiesVersion. Call this at startup before any other bridge_get_* tool.',
    {},
    async () => safe(() => resolveSessionContext(ctx)),
  )

  // bridge_get_todo_run_instructions ────────────────────────────────────────
  server.tool(
    'bridge_get_todo_run_instructions',
    'Load the authoritative opt-in Bridge todo/run workflow. Call only after explicit user opt-in and before any todo/run action.',
    {},
    () => safe(async () => {
      noteTodoRunWorkflowPulled(todoRunState, ctx)
      return {
        mode: 'bridge_todo_run' as const,
        workflowVersion: ORCHESTRATOR_TODO_RUN_WORKFLOW_VERSION,
        instructions: ORCHESTRATOR_TODO_RUN_WORKFLOW,
      }
    }),
  )

  // bridge_get_my_task ───────────────────────────────────────────────────────
  server.tool(
    'bridge_get_my_task',
    'Get the orchestration task currently assigned to this agent. Returns { todo, runId, projectId, projectName, projectCwd }. If todo is null, no task is currently assigned — go idle.',
    {},
    async () => {
      if (!ctx.agentId) return err({ ok: false, error: 'agentId not configured — this agent cannot receive tasks' })
      return safe(() => getMyAssignment(ctx))
    },
  )

  // bridge_complete_task ─────────────────────────────────────────────────────
  server.tool(
    'bridge_complete_task',
    'Signal task completion to the orchestrator. Returns { ok: true } on success. ' +
    'ONLY call this if your role is reviewer, planner, executor, or shell. ' +
    'Developer role agents are NOT allowed to call this — finish your implementation and go idle; the reviewer will signal completion. ' +
    'If you receive { ok: false, error: "..." }, read the error and follow its instructions.',
    {
      todoId: z.string().describe('The todo ID from bridge_get_my_task'),
      receiptId: z.string().uuid().describe('The one-shot receipt from the current task injection'),
    },
    ({ todoId, receiptId }) => safe(() => completeMyTask(ctx, todoId, receiptId)),
  )

  // bridge_fail_task ─────────────────────────────────────────────────────────
  server.tool(
    'bridge_fail_task',
    'Signal task failure to the orchestrator. The run will reset this task so it can be retried. ' +
    'Call this ONLY when you genuinely cannot complete the task (missing file, unresolvable error, wrong context). ' +
    'Do NOT use this as a "done" signal — failing causes the task to retry, wasting resources. ' +
    'Provide a specific reason so the next attempt can avoid the same problem.',
    {
      todoId: z.string().describe('The todo ID from bridge_get_my_task'),
      receiptId: z.string().uuid().describe('The one-shot receipt from the current task injection'),
      failureCode: z.enum(COMPLETION_FAILURE_CODES).describe('Closed failure category'),
      note: z.string().max(1024).optional().describe('Optional non-authoritative human context'),
    },
    ({ todoId, receiptId, failureCode, note }) => safe(() => failMyTask(ctx, todoId, receiptId, failureCode, note)),
  )

  server.tool(
    'bridge_ack_scheduled_duty',
    'Acknowledge receipt of a scheduled duty before beginning work. This is a receipt-bound startup signal, not a completion call.',
    { receiptId: z.string().uuid() },
    ({ receiptId }) => safe(() => acknowledgeScheduledDuty(ctx, receiptId)),
  )

  server.tool(
    'bridge_complete_free_task',
    'Submit the closed-schema terminal outcome for the current atomic free/Quick-Launch task. The server validates the one-shot receipt and asks the daemon to seal the authoritative record.',
    {
      receiptId: z.string().uuid(),
      outcome: z.enum(['complete', 'failed']),
      failureCode: z.enum(COMPLETION_FAILURE_CODES).optional(),
      note: z.string().max(1024).optional().describe('Non-authoritative context only'),
      result: z.object({
        status: z.enum(['findings', 'no_findings', 'blocked']), summary: z.string().max(480),
        findings: z.array(z.object({ title: z.string().max(200), severity: z.enum(['info', 'low', 'medium', 'high', 'critical']), evidence: z.string().max(1000), location: z.string().max(300).optional() })).max(20),
        recommendedAction: z.string().max(1000).optional(), limitations: z.string().max(1000).optional(),
      }).optional(),
    },
    ({ receiptId, outcome, failureCode, note, result }) => safe(() => completeFreeTask(ctx, receiptId, outcome, failureCode, note, result)),
  )

  // bridge_get_todo_context ──────────────────────────────────────────────────
  server.tool(
    'bridge_get_todo_context',
    'Read the terminal output of any todo in the current run (completed, failed, or running). ' +
    'Call this on dependency todo IDs before starting work — it tells you what upstream tasks produced. ' +
    'Returns { todoId, title, status, output }. If output is null, the todo has no recorded output yet.',
    {
      todoId: z.string().describe('The todo ID to inspect'),
      lines:  z.number().int().min(1).max(300).optional().describe('Trailing lines to return (default 50, max 300)'),
    },
    ({ todoId, lines }) => safe(() => getTodoContext(ctx, todoId, lines)),
  )

  // bridge_list_agents ───────────────────────────────────────────────────────
  server.tool(
    'bridge_list_agents',
    'List active agents in your scope. Project-scoped contexts (the default) see ONLY this project\'s agents; workspace-scoped contexts see all agents across projects. Each entry includes agentId, agentKey, name (human-readable label like "OpenCode #2 · Sonnet"), model, status (idle/busy/disconnected), assignedTodo, role, runnerCmd, projectId, inRun, state (idle/working), lastOutputAt, and contextUsedPct (0–100, null if not a Claude agent). ' +
    'inRun:true means the agent is already registered in the active run. inRun:false means it was spawned after the run started or in a previous session — it can still be assigned (auto-registered on first assign). ' +
    'Runner agents (role:"runner") are dev server consoles — use bridge_get_agent_output to read them.',
    {},
    () => safe(() => listAgents(ctx)),
  )

  // bridge_get_agent_status ──────────────────────────────────────────────────
  server.tool(
    'bridge_get_agent_status',
    'Get current status of a specific agent — name, model, idle or busy, which todo is assigned, MCP configured. ' +
    'Use this to check if a worker is free before assigning a task. Returns all agent fields including the human-readable name and launch model.',
    { agentId: z.string().describe('The agent ID to inspect') },
    ({ agentId }) => safe(() => getAgentStatus(ctx, agentId)),
  )

  // bridge_spawn_worker ──────────────────────────────────────────────────────
  server.tool(
    'bridge_spawn_worker',
    'Spawn a new worker agent on the connected machine. Returns { agentId, name (human-readable label), ordinal (sequential number, null for orchestrators), model }. ' +
    'Use bridge_assign_task after spawning to give the worker a task. ' +
    'For dev servers (npm run dev, flutter run, etc.) set role="runner" — the agent appears in the debug dock, not the agent grid. ' +
    'Shell runner panels are idempotent on cmd: if a runner with the same cmd already exists, its agentId is returned. ' +
    'A destructive cmd for agentKey: "sh" can return 400 { ok: false, error: "blast_radius_confirmation_required", message: <reason> } — ' +
    'deterministic, not transient: resending the identical cmd without confirmBlastRadius will keep failing. ' +
    'Resend the SAME call with confirmBlastRadius: true to proceed; it covers only that one call (this cmd) and is never stored.',
    {
      agentKey: z.string().describe('Agent type: claude, codex, sh, qwen, agy, ollama, aider, copilot'),
      daemonId: z.string().optional().describe('Target machine ID. Omit to use the workspace default machine.'),
      role:     z.enum(USER_ASSIGNABLE_ROLES as unknown as [string, ...string[]]).optional()
                      .describe(`Panel role: ${USER_ASSIGNABLE_ROLES.join(', ')}`),
      cmd:      z.string().max(512).optional().describe('Command to run after spawn (sh panels only, e.g. "npm run dev"). Sets role to runner automatically.'),
      model:    z.string().max(128).optional().describe('Launch-time model id (agent-specific format). Ignored by agents without launch-model support.'),
      confirmBlastRadius: z.boolean().optional()
        .describe('Set true to proceed after a blast_radius_confirmation_required refusal for THIS exact cmd. Omit or false: the gate applies. Not stored — must be resent on every call it should cover.'),
    },
    ({ agentKey, daemonId, role, cmd, model, confirmBlastRadius }) => safe(() => spawnAgent(ctx, agentKey, daemonId, role, cmd, model, confirmBlastRadius)),
  )

  // bridge_kill_agent ────────────────────────────────────────────────────────
  server.tool(
    'bridge_kill_agent',
    'Terminate an agent. The PTY is killed and removed from the active agent list. ' +
    'Use to clean up stuck or idle workers when you no longer need them.',
    { agentId: z.string().describe('The agent ID to terminate') },
    ({ agentId }) => safe(() => killAgent(ctx, agentId)),
  )

  // bridge_set_model ────────────────────────────────────────────────────────
  // Issue #39: change a RUNNING worker's model without losing its PTY,
  // context, or group membership. Only live-enabled for a subset of agents
  // (currently claude, aider, ollama) — the server rejects with
  // error:"agent_not_enabled" for anything else instead of silently
  // ignoring the request; for those agents, kill + respawn with the desired
  // launch-time model is still the only path.
  server.tool(
    'bridge_set_model',
    'Change an ALREADY-RUNNING worker\'s model in place, without killing or respawning it — preserves its PTY, conversation context, and group membership. ' +
    'Only live-enabled for a subset of agent types (currently claude, aider, ollama); returns { ok: false, error: "agent_not_enabled" } for others — kill and respawn with the desired model instead in that case. ' +
    'Returns { ok: true, agentId, model } on success.',
    {
      agentId: z.string().describe('The agent ID whose model to change'),
      model:   z.string().max(128).describe('Target model id (agent-specific format, e.g. "opus" for claude).'),
    },
    ({ agentId, model }) => safe(() => setAgentModel(ctx, agentId, model)),
  )

  // bridge_get_agent_output ─────────────────────────────────────────────────
  server.tool(
    'bridge_get_agent_output',
    'Read the last N lines of a panel\'s terminal output (ANSI codes stripped). ' +
    'Returns { output, cursor, cursor_reset }. Round-trip the returned cursor on the next call to get only new output (delta) — omit it for a full tail. ' +
    'cursor_reset: true means the cursor went stale (buffer evicted or panel respawned) and a full tail was returned. ' +
    'Use this to check a dev server for errors, verify a build succeeded, or read a shell panel\'s result. ' +
    'Works on any agent type — dev servers, shells, AI agents.',
    {
      agentId: z.string().describe('The agent ID to read'),
      lines:   z.number().int().min(1).max(300).optional().describe('Trailing lines for full-tail reads (default 50, max 300); delta reads return all new lines'),
      cursor:  z.string().optional().describe('Opaque cursor from a previous response — pass it back to receive only new output since that read'),
    },
    ({ agentId, lines, cursor }) => safe(() => getAgentOutput(ctx, agentId, lines, cursor)),
  )

  // bridge_send_input ───────────────────────────────────────────────────────
  server.tool(
    'bridge_send_input',
    'Send text input to a panel\'s PTY. The daemon appends the correct line terminator automatically (sh → \\n, claude/qwen → \\r) — do NOT add \\n or \\r yourself. ' +
    'Use to: run shell commands, trigger hot reload ("r" in Flutter), send prompts to AI panels, interact with CLIs. ' +
    'If the agent is mid-output, returns { ok: false, error: "agent_not_idle", lastOutputAgeMs } with 409 — poll bridge_agent_is_idle before retrying. ' +
    'A destructive command aimed at a shell panel can instead return 400 { ok: false, error: "blast_radius_confirmation_required", message: <reason> } — ' +
    'this is deterministic, not transient: resending the identical text without confirmBlastRadius will keep failing. ' +
    'Read `message`, and if the command is genuinely intended, resend the SAME call with confirmBlastRadius: true. ' +
    'Confirmation applies only to that one call (this panel, this exact text) and is never stored or reused for a later command.',
    {
      agentId: z.string().describe('The agent ID to send to'),
      text:    z.string().min(1).max(4096).describe('Text to send. No line terminator needed — daemon adds it.'),
      confirmBlastRadius: z.boolean().optional()
        .describe('Set true to proceed after a blast_radius_confirmation_required refusal for THIS exact text on a shell panel. Omit or false: the gate applies. Not stored — must be resent on every call it should cover.'),
    },
    ({ agentId, text, confirmBlastRadius }) => safe(() => sendAgentInput(ctx, agentId, text, confirmBlastRadius)),
  )

  // bridge_send_keys ─────────────────────────────────────────────────────────
  // Issue #85: a raw-keystroke escape hatch for a panel blocked on an
  // interactive menu (bridge_agent_is_idle returns state:"awaiting_input").
  // bridge_send_input cannot clear one — it always wraps text in an envelope
  // and waits for the panel to look idle, which a repainting menu never does.
  server.tool(
    'bridge_send_keys',
    'Send raw keystrokes to a panel BLOCKED on an interactive menu/confirmation prompt (e.g. an MCP tool-approval overlay, a y/n confirm, an arrow-key selection). ' +
    'Only use this after bridge_agent_is_idle reports state:"awaiting_input" — for ordinary text, always use bridge_send_input instead. ' +
    'Closed key set only (no free text): ' + SEND_KEYS.join(', ') + '. ' +
    'Inspect the panel output first (bridge_get_agent_output) to see which option is highlighted before choosing keys — sending the wrong sequence can confirm the wrong choice. ' +
    'Never select "Always allow" or an equivalent persistent-grant option without explicit human authorization for that specific action.',
    {
      agentId: z.string().describe('The worker panel currently blocked on an interactive prompt'),
      keys: z.array(z.enum(SEND_KEYS as unknown as [string, ...string[]])).min(1).max(32)
        .describe('Ordered keystroke sequence, e.g. ["down","down","enter"] to navigate to and select the third option.'),
    },
    ({ agentId, keys }) => safe(() => sendAgentKeys(ctx, agentId, keys)),
  )

  server.tool(
    'bridge_get_free_task_outcome',
    'Read one retained accepted daemon-sealed free-task outcome by completionId, including after worker reuse. Only its authorized orchestrator can read it. Unresolved is not a terminal verdict.',
    { completionId: z.string().uuid() },
    ({ completionId }) => safe(() => getFreeTaskOutcome(ctx, completionId)),
  )

  // bridge_dispatch_brief ──────────────────────────────────────────────────
  server.tool(
    'bridge_dispatch_brief',
    'Dispatch a NEW task\'s initial brief to one AI panel. The server resolves the target project, ' +
    'auto-includes server-trusted durable guardrails, and fails closed if they cannot be read. ' +
    'It also arms the free-mode completion watcher when called by an orchestrator panel. ' +
    'Follow the returned tracking.instructions for this task; watcher arming does not establish a host subscription. ' +
    'Use bridge_send_input instead for follow-ups within the same task and for shell commands.',
    {
      agentId: z.string().describe('The AI worker panel receiving the new task'),
      text: z.string().min(1).max(4096).describe('The initial task brief. No line terminator needed.'),
      taskSuffix: z.string().min(1).max(64).regex(/^[A-Z0-9_-]+$/).optional()
        .describe('Optional completion suffix used to pin the automatically armed watcher (e.g. AUTH_FIX).'),
      watchFile: z.string().min(1).max(1024).optional()
        .describe('Optional workspace-relative artifact file path for sentinel verification (e.g. docs/reports/task-DONE.md)'),
    },
    ({ agentId, text, taskSuffix, watchFile }) => safe(() => dispatchBrief(ctx, agentId, text, taskSuffix, watchFile)),
  )

  server.tool(
    'bridge_dispatch_free_task',
    'Atomically dispatch a new task to a Quick-Launch AI panel and install its bound completion receipt before input is sent. Follow the returned tracking.instructions for this task; watcher arming does not establish a host subscription.',
    {
      agentId: z.string(),
      text: z.string().min(1).max(4096),
      taskSuffix: z.string().min(1).max(64).regex(/^[A-Z0-9_-]+$/).optional(),
    },
    ({ agentId, text, taskSuffix }) => safe(() => dispatchFreeTask(ctx, agentId, text, taskSuffix)),
  )

  // bridge_watch_panel ───────────────────────────────────────────────────────
  server.tool(
    'bridge_watch_panel',
    'Arm a free-mode completion watcher on a worker panel. The server pushes a [BRIDGE-ORCH] nudge to your panel when the worker emits its sentinel. ' +
    'Call this when YOU named the task so you can pin the watcher to your task suffix — pinned matching is strictly safer and avoids noise from BUILD_DONE verdict=ok style output. ' +
    'taskSuffix must be UPPERCASE letters, digits, underscore, or hyphen only. Pinned sentinels may omit verdict=; unpinned sentinels require verdict= on the same line. ' +
    'watchFile is an optional workspace-relative file path. When set, the sentinel is verified against the artifact file before nudging. ' +
    'Returns 409 watcher_owned_by_other_panel if another orchestrator panel (or a live run) already has an active watcher here — pass force:true to take it over.',
    {
      agentId:    z.string().describe('The worker panel to watch'),
      taskSuffix: z.string().min(1).max(64).regex(/^[A-Z0-9_-]+$/).optional()
        .describe('Optional pinned task suffix (e.g. AUTH_FIX, R1-REVIEW). UPPERCASE letters/digits/_/- only.'),
      watchFile:  z.string().min(1).max(1024).optional()
        .describe('Optional workspace-relative artifact file path for sentinel verification (e.g. docs/reports/task-DONE.md)'),
      force:      z.boolean().optional()
        .describe('Take over a watcher already armed by another orchestrator panel or a live run. Only pass this after confirming the previous owner is gone/stale — it silently redirects that panel\'s completion nudge to you.'),
    },
    ({ agentId, taskSuffix, watchFile, force }) => safe(() => watchPanel(ctx, agentId, taskSuffix, watchFile, force)),
  )

  // bridge_unwatch_panel ─────────────────────────────────────────────────────
  server.tool(
    'bridge_unwatch_panel',
    'Disarm the free-mode completion watcher on a worker panel. Use when you no longer need nudges for that panel. ' +
    'Returns 409 watcher_owned_by_other_panel if the watcher belongs to a different orchestrator panel or a live run — pass force:true to disarm it anyway.',
    {
      agentId: z.string().describe('The worker panel to unwatch'),
      force:   z.boolean().optional()
        .describe('Disarm a watcher owned by a different orchestrator panel or a live run. Only pass this after confirming that owner is gone/stale.'),
    },
    ({ agentId, force }) => safe(() => unwatchPanel(ctx, agentId, force)),
  )

  // bridge_get_project_history ──────────────────────────────────────────────
  server.tool(
    'bridge_get_project_history',
    'Fetch recent run history for this project — completed/failed runs with todo breakdowns and failure hints. ' +
    'Call this BEFORE creating todos to understand what was already attempted and avoid repeating past failures.',
    {
      limit: z.number().int().min(1).max(10).optional()
        .describe('Number of recent runs to return (default 5, max 10)'),
    },
    ({ limit }) => safe(() => getProjectHistory(ctx, limit)),
  )

  // bridge_assign_task ───────────────────────────────────────────────────────
  server.tool(
    'bridge_assign_task',
    'Pin a pending todo to a specific agent so the orchestrator dispatches it there. ' +
    'Use bridge_list_agents first to find idle panels. ' +
    'Only works on todos with status pending or blocked — call bridge_get_my_task to check current state.',
    {
      todoId:  z.string().describe('The todo ID to assign (must be pending or blocked)'),
      agentId: z.string().describe('The target agent ID'),
    },
    ({ todoId, agentId }) => safe(async () => {
      const warning = todoRunWorkflowWarning(todoRunState, ctx, 'bridge_assign_task')
      return prependTodoRunWarning(warning, await assignTask(ctx, todoId, agentId))
    }),
  )

  // bridge_agent_is_idle ─────────────────────────────────────────────────────
  server.tool(
    'bridge_agent_is_idle',
    'Check whether a specific agent\'s PTY is currently idle (no output for 3+ seconds). ' +
    'Use this before dispatching input to avoid injecting commands during active generation. ' +
    'Returns { idle: boolean, state: "idle"|"working", lastOutputAgeMs: number|null }.',
    { agentId: z.string().describe('The agent ID to inspect') },
    ({ agentId }) => safe(() => getAgentIdle(ctx, agentId)),
  )

  // bridge_record_event ──────────────────────────────────────────────────────
  server.tool(
    'bridge_record_event',
    'Append an event to the project event log. Use to record decisions, discoveries, phase completions, or blockers so future agents and runs have durable context. ' +
    'Events are separate from run history — they persist across runs and are queryable by role/type/tag. ' +
    'Suggested eventTypes: decision, discovery, blocker, phase_complete, note, warning. ' +
    'Pass projectId to target a specific project (orchestrator must always pass it for project events; ' +
    'without projectId the event lands in the workspace log and is not tied to a specific project).',
    {
      eventType: z.string().min(1).max(64).describe('Free-form event type slug (e.g. decision, blocker, phase_complete)'),
      summary:   z.string().min(1).max(512).describe('Human-readable event summary (max 512 chars)'),
      projectId: z.string().min(1).optional().describe('Target project ID. Defaults to caller panel\'s project. Required when called from the orchestrator (workspace scope).'),
      sessionId: z.string().optional().describe('Orchestration session ID this event belongs to, if any'),
      payload:   z.record(z.unknown()).optional().describe('Optional structured data attached to the event'),
      tags:      z.array(z.string()).optional().describe('Free-form tags for filtering (e.g. ["auth", "security"])'),
      permanent: z.boolean().optional().describe(
        'Mark event as permanent — excluded from future archiving sweeps. Combined with ' +
        "eventType 'decision' or a 'constraint' tag, this also makes the event visible to every " +
        'branch (universal scope); otherwise it stays scoped to the branch/checkout it was written on.'
      ),
    },
    (params) => safe(() => recordProjectEvent(ctx, params)),
  )

  // bridge_get_project_events ────────────────────────────────────────────────
  server.tool(
    'bridge_get_project_events',
    'Query the project event log. Returns events newest-first. ' +
    'Use to recall decisions, discoveries, and blockers recorded by prior agents before starting new work. ' +
    'Filter by role or eventType to narrow results; use search for keyword lookup in summaries. ' +
    'Each event includes applicability and applicabilityBasis resolved per reader: applicable for the current checkout, cross_branch for a confirmed different branch ref, or unresolved when trustworthy git state is unavailable. ' +
    'Pass projectId to query a specific project (orchestrator must always pass it; per-project workers can omit). ' +
    'Set workspaceScope:true to get a cross-project timeline — all events across every project in the workspace. ' +
    'Use personaId to query your own prior events — pass the BRIDGE_PERSONA_ID env var value.',
    {
      projectId:       z.string().min(1).optional().describe('Target project ID. Defaults to caller panel\'s project. Required when called from the orchestrator (workspace scope). Ignored when workspaceScope is true.'),
      workspaceScope:  z.boolean().optional().describe('When true, returns all events across the entire workspace (all projects + workspace-level events). Useful for orchestrators managing multiple projects.'),
      role:            z.string().optional().describe('Filter by role (e.g. reviewer, developer)'),
      eventType:       z.string().optional().describe('Filter by eventType slug'),
      personaId:       z.string().min(1).optional().describe('Filter to events recorded by or for a specific persona. Pass your own personaId to read your history.'),
      tags:            z.string().optional().describe('Comma-separated tag list — only events containing ALL listed tags (e.g. "auth,security")'),
      since:           z.string().optional().describe('ISO 8601 timestamp — only events after this date'),
      search:          z.string().optional().describe('Keyword search in event summaries (case-insensitive)'),
      limit:           z.number().int().min(1).max(200).optional().describe('Max events to return (default 50, max 200)'),
      includeArchived: z.boolean().optional().describe('Include soft-archived events (default false)'),
    },
    (opts) => safe(() => getProjectEvents(ctx, opts)),
  )

  // bridge_get_project_memory ────────────────────────────────────────────────
  server.tool(
    'bridge_get_project_memory',
    'Get durable project memory guardrails (permanent constraints, architectural decisions, and active blockers). ' +
    'Excludes soft-archived items and events recorded on a different git branch from your current checkout. ' +
    'Events whose git branch applicability is unresolved are included in memories with their count reported in advisory.unresolved — ' +
    'unresolved memories may have been recorded on a different branch than yours, so treat them as advisory and verify before relying on them. ' +
    'Use bridge_get_project_events if you need to inspect all events including cross-branch ones.',
    {
      projectId: z.string().min(1).optional().describe('Target project ID. Defaults to caller panel project.'),
      limit:     z.number().int().min(1).max(50).optional().default(20).describe('Max memories to retrieve'),
    },
    async (opts) => safe(async () => {
      try {
        return await getProjectMemory(ctx, { projectId: opts.projectId, limit: opts.limit ?? 20 })
      } catch (error) {
        console.error('[memory] bridge_get_project_memory read failure', { error: String(error), projectId: opts.projectId ?? ctx.projectId })
        throw error
      }
    }),
  )
}
