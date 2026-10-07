// ============================================================================
// Bridge Tool Registry — Single source of truth for all bridge_* MCP tools.
// Added in pull-default architecture so server REST layer can substitute
// {{TOOL_TABLE}} without duplicating registry in daemon.
//
// Keep descriptions to terse one-line signatures (issue #512 P2): the rendered
// table is re-billed into every orchestrator turn, so verbosity here has a
// standing token cost. No behavior semantics belong in these strings.
// ============================================================================

export const BRIDGE_TOOL_DOCS = {
  // Project / plan
  bridge_get_project:         'Project metadata (name, cwd, machineId)',
  bridge_get_project_digest:  'Repo file-tree digest (capped), on demand',
  bridge_get_blueprint:       'Read project blueprint doc ({blueprint, updatedAt})',
  bridge_update_blueprint:    'Update project blueprint doc',
  bridge_get_project_history: 'Past runs + failure patterns',
  bridge_get_execution_status:'Run history + todo completion counts',
  bridge_get_todo_run_instructions:'Load authoritative opt-in Bridge todo/run workflow',
  bridge_get_project_events:  'Project event log: decisions, blockers, milestones (newest-first)',
  bridge_get_project_memory:  'Durable permanent constraints and architectural decisions',
  // Todos
  bridge_get_todos:           'List todos + session state',
  bridge_add_todo:            'Create todo (title, todoType, dependsOn)',
  bridge_update_todo:         'Update todo title/status',
  bridge_cancel_run:          'Cancel active run (before restarting a stale plan)',
  // Panel management
  bridge_get_session_context: 'Get this orchestrator\'s own session context — panelId, workspaceId, projectId, scope',
  bridge_list_agents:         'All agents: role, status, inRun',
  bridge_get_agent_status:    'Single agent status',
  bridge_spawn_worker:        'Spawn worker (agentKey, role)',
  bridge_kill_agent:          'Terminate stuck/dead agent',
  bridge_set_model:           'Change a running worker\'s model in place (claude/aider/ollama only) — no respawn',
  bridge_get_agent_output:    'Read agent terminal output (round-trip cursor = delta read)',
  bridge_send_input:          'Send text input to agent PTY',
  bridge_agent_is_idle:       'Inspect agent PTY state: idle, working, or awaiting_input (+ output age)',
  bridge_send_keys:           'Send raw keystrokes (enter/escape/arrows/y/n/digits) to clear a panel stuck on an interactive menu — only after bridge_agent_is_idle reports awaiting_input',
  bridge_dispatch_brief:      'Dispatch a new AI task with server-trusted durable guardrails',
  bridge_watch_panel:         'Arm a free-mode completion watcher on a worker panel, optionally pinned to a task suffix',
  bridge_get_free_task_outcome: 'Read one retained daemon-sealed outcome by completionId for its authorized orchestrator',
  bridge_complete_free_task:  'Submit a bound closed-schema outcome for an atomic free task',
  bridge_dispatch_free_task:  'Atomically dispatch a Quick-Launch AI task with a completion receipt',
  bridge_unwatch_panel:       'Disarm the free-mode completion watcher on a worker panel',
  bridge_record_event:        'Append a durable project/workspace event (type, summary, tags, permanence)',
  // Worker task lifecycle
  bridge_get_my_task:         'This agent\'s assigned task',
  bridge_complete_task:       'Signal task completion',
  bridge_fail_task:           'Signal failure with reason',
  bridge_get_todo_context:    'Read a todo\'s output/error',
  bridge_assign_task:         'Assign pending todo to an agent',
  // Workspace scope (Phase 6)
  bridge_list_groups:           'Groups + member agentIds',
  bridge_get_group_status:      'Group agents: status + last output line',
  bridge_dispatch_to_group:     'Send message to every agent in a group',
  bridge_create_group:          'Create group (name, optional color)',
  bridge_update_group:          'Rename/recolor a group',
  bridge_delete_group:          'Delete a group',
  bridge_assign_agent_to_group: 'Move agent into a group, or remove (groupId: null); orchestrators cannot join',
  bridge_list_workspace_projects:'Workspace projects: name, cwd, active run count',
  bridge_query_workspace:       'Natural-language query of orchestration state',
  bridge_list_active_runs:      'Active runs across workspace projects',
  bridge_peek_panel:            'Read any panel output workspace-wide (cursor = delta read)',
  bridge_status_panel:          'Status of any panel workspace-wide',
  // Personas
  bridge_get_persona:           'Persona by id (name, systemPrompt, role, agentKey)',
  bridge_list_personas:         'Visible personas (workspace + personal)',
  bridge_create_persona:        'Create persona',
  bridge_update_persona:        'Update persona fields',
  bridge_archive_persona:       'Archive a persona',
  bridge_launch_persona:        'Spawn worker with a persona',
  bridge_apply_persona:         'Apply persona to a running worker',
  bridge_persona_schedule:      'Manage scheduled personas (list/create/update/enable/disable/delete)',
  // Group Schemas (reusable team templates)
  bridge_list_group_schemas:    'Reusable team/group schema templates',
  bridge_create_group_schema:   'Create group schema from current groups',
  bridge_update_group_schema:   'Update a group schema (name/slug/desc/color/groups/shared)',
  bridge_apply_group_schema:    'Spawn a schema\'s groups and agents',
  // Agent Model Info
  bridge_list_agent_models:     'Available models for an agent key on a daemon',
  // Messaging
  bridge_send_message:          'Direct message to a peer agent',
  bridge_poll_messages:         'Poll unread messages for this agent',
  // Role Prompts
  bridge_list_role_prompts:     'Role prompt templates',
  bridge_get_role_prompt:       'Fetch resolved role prompt',
  bridge_update_role_prompt:    'Update custom role prompt',
  bridge_delete_role_prompt:    'Delete custom role prompt',
  bridge_update_todo_status:    'Update todo status only',
  // Codegraph (structural code intelligence — PREFER over Read/Grep for structure)
  bridge_codegraph_status:        'Codegraph index status + resolution coverage',
  bridge_codegraph_index:         'Index/refresh a project for codegraph',
  bridge_codegraph_find_symbol:   'Find a symbol by name (where is X)',
  bridge_codegraph_file_outline:  'Structural outline of a single file',
  bridge_codegraph_find_references:'All call/reference sites of a symbol (who calls X)',
  bridge_codegraph_call_graph:    'Call graph (in/out/both) around a symbol',
  bridge_codegraph_get_symbol_source:'Source snippet of a qualified symbol',
  bridge_codegraph_diff_impact:   'Blast-radius of a git diff (changed exported symbols + transitive callers)',
} as const

// Fail-fast at module load: empty registry means a packaging or bundling bug.
if (Object.keys(BRIDGE_TOOL_DOCS).length === 0) {
  throw new Error('BRIDGE_TOOL_DOCS registry is empty at module load — fail fast')
}

export type BridgeToolName = keyof typeof BRIDGE_TOOL_DOCS

/** Inline footer: "Available MCP tools: bridge_x, bridge_y, ..." */
export function toolRef(...tools: BridgeToolName[]): string {
  return `\n\n**Available MCP tools:** ${tools.join(', ')}`
}

/** Markdown table footer for orchestrator-style full reference */
export function toolTable(...tools: BridgeToolName[]): string {
  const rows = tools.map(t => `| \`${t}\` | ${BRIDGE_TOOL_DOCS[t]} |`).join('\n')
  return `\n\n| Tool | Purpose |\n|------|---------|\n${rows}`
}

/** Build a markdown table of ALL bridge_* tools for orchestrator prompts. */
export function buildToolTable(): string {
  const tools = Object.keys(BRIDGE_TOOL_DOCS) as BridgeToolName[]
  return toolTable(...tools)
}

/**
 * Tools the orchestrator never invokes — worker task-lifecycle (a worker signs
 * ITSELF off) and admin/UI-only ops. Excluded from the orchestrator's tool table
 * to trim the per-session token tax and stop it selecting worker-only tools.
 * Exclude-based (not allow-based) so a NEW tool is shown by default until it is
 * deliberately marked worker/admin-only here.
 */
export const ORCHESTRATOR_TOOL_EXCLUDE: BridgeToolName[] = [
  'bridge_get_my_task', 'bridge_complete_task', 'bridge_fail_task',
  'bridge_get_todo_context', 'bridge_update_todo_status',
  'bridge_create_persona', 'bridge_update_persona', 'bridge_archive_persona',
  'bridge_update_role_prompt', 'bridge_delete_role_prompt',
]

/** Curated tool table for the orchestrator prompt (all tools minus worker/admin-only). */
export function buildOrchestratorToolTable(): string {
  const excl = new Set<BridgeToolName>(ORCHESTRATOR_TOOL_EXCLUDE)
  const tools = (Object.keys(BRIDGE_TOOL_DOCS) as BridgeToolName[]).filter(t => !excl.has(t))
  return toolTable(...tools)
}
