import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type BridgeContext, request, workspacePath, getProject, getProjectDigest, isProjectScoped } from '../api.js'
import { safeTool as safe } from '../tool-result.js'

export function registerWorkspaceTools(server: McpServer, ctx: BridgeContext): void {
  // bridge_list_groups ─────────────────────────────────────────────────────────
  server.tool(
    'bridge_list_groups',
    'List agent groups (teams) in your scope. Project-scoped contexts see only their project\'s groups; workspace scope sees all. Returns groupId, teamName (human-readable name if set), member agentIds, and agent count.',
    {},
    () => safe(() => request<{ groups: Array<{ groupId: string; teamName: string | null; agentIds: string[]; agentCount: number }> }>(
      ctx, 'GET', workspacePath(ctx, isProjectScoped(ctx) ? `/groups?projectId=${encodeURIComponent(ctx.projectId)}` : '/groups'),
    )),
  )

  // bridge_get_group_status ────────────────────────────────────────────────────
  server.tool(
    'bridge_get_group_status',
    'Get all agents in a group with their current status, projectId, and last output line.',
    { groupId: z.string().describe('The group ID to inspect') },
    ({ groupId }) => safe(() => request<{ groupId: string; agents: Array<{ agentId: string; agentKey: string; status: string; projectId: string | null; lastLine?: string }> }>(ctx, 'GET', workspacePath(ctx, `/groups/${groupId}`))),
  )

  // bridge_dispatch_to_group ───────────────────────────────────────────────────
  server.tool(
    'bridge_dispatch_to_group',
    'Send a text message or command to every agent in a group via PTY stdin. Returns 409 agents_not_idle if any group member is mid-output (last PTY output within 3s) — retry after a delay. ' +
    'A destructive command is refused per-target for shell members only — AI members of the group still receive it. ' +
    'A refused shell member is reported in failedAgentIds (same convention as any other undelivered target), not a separate field. ' +
    'Refusal is deterministic: resending identical text without confirmBlastRadius keeps failing those members. ' +
    'Set confirmBlastRadius: true to resend and let them through too; it covers only that one call and is never stored.',
    {
      groupId: z.string().describe('The target group ID'),
      text:    z.string().min(1).max(4096).describe('Text to send to all group members'),
      confirmBlastRadius: z.boolean().optional()
        .describe('Set true to also deliver to shell members that were previously refused for THIS exact text. Omit or false: the gate applies to shell members. Not stored — must be resent on every call it should cover.'),
    },
    ({ groupId, text, confirmBlastRadius }) => safe(() => {
      const body: { text: string; confirmBlastRadius?: boolean } = { text }
      if (confirmBlastRadius === true) body.confirmBlastRadius = true
      return request<{ ok: boolean; dispatched: number; failed?: number; failedAgentIds?: string[]; error?: string; notIdle?: string[] }>(
        ctx, 'POST', workspacePath(ctx, `/groups/${groupId}/broadcast`), body,
      )
    }),
  )

  // bridge_list_workspace_projects ─────────────────────────────────────────────
  server.tool(
    'bridge_list_workspace_projects',
    'List all projects in the workspace with name, cwd, and machineId.',
    {},
    () => safe(() => request<{ projects: Array<{ id: string; name: string; description?: string; cwd?: string; machineId?: string }> }>(ctx, 'GET', workspacePath(ctx, '/projects'))),
  )

  // bridge_get_project ─────────────────────────────────────────────────────────
  server.tool(
    'bridge_get_project',
    'Get the current project details: id, name, description, cwd, machineId. ' +
    'Use this to confirm which project context the caller is operating in.',
    {},
    () => safe(() => getProject(ctx)),
  )

  // bridge_get_project_digest ──────────────────────────────────────────────────
  server.tool(
    'bridge_get_project_digest',
    'Get the repository file-tree digest for the current project (capped to preserve ' +
    'context budget). Use on demand for codebase orientation instead of expecting it at startup.',
    {},
    () => safe(() => getProjectDigest(ctx)),
  )

  // bridge_query_workspace ─────────────────────────────────────────────────────
  server.tool(
    'bridge_query_workspace',
    'Natural-language query about orchestration state (runs, todos, failures). No LLM involved — deterministic answer.',
    { q: z.string().min(1).max(500).describe('Natural language query, e.g. "what failed last time?"') },
    ({ q }) => safe(() => request<{ answer?: string; label?: string }>(ctx, 'GET', workspacePath(ctx, `/orchestration/query?q=${encodeURIComponent(q)}`))),
  )

  // bridge_list_active_runs ────────────────────────────────────────────────────
  server.tool(
    'bridge_list_active_runs',
    'All active orchestration runs across workspace projects with todo progress.',
    {},
    () => safe(() => request<{ runs: Array<{ runId: string; name?: string; status: string; projectId?: string; spec: string; progress: { done: number; total: number; failed: number } }> }>(ctx, 'GET', workspacePath(ctx, '/runs/active'))),
  )

  // bridge_peek_panel ──────────────────────────────────────────────────────────
  server.tool(
    'bridge_peek_panel',
    'Read the last N lines of a panel\'s terminal output. Project-scoped contexts may only peek at their own project\'s panels (403 cross_project_block otherwise); workspace scope has no project boundary. Use this to check what a specific agent is doing. ' +
    'Returns { output, cursor, cursor_reset } — round-trip the cursor on the next call to get only new output (delta); omit it for a full tail.',
    {
      agentId: z.string().describe('The panel/agent ID to peek at'),
      lines:   z.number().int().min(1).max(300).optional().describe('Trailing lines for full-tail reads (default 50, max 300); delta reads return all new lines'),
      expectedPanelInstanceId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Expected panel generation; mismatches or unknown identity refuse output.'),
      cursor:  z.string().optional().describe('Opaque cursor from a previous response — pass it back to receive only new output since that read'),
    },
    ({ agentId, lines, cursor, expectedPanelInstanceId }) => safe(() => {
      const params = new URLSearchParams()
      if (lines !== undefined) params.set('lines', String(lines))
      if (cursor) params.set('cursor', cursor)
      if (expectedPanelInstanceId !== undefined) params.set('expectedPanelInstanceId', String(expectedPanelInstanceId))
      const qs = params.toString()
      return request<{ agentId: string; output: string; cursor?: string; cursor_reset?: boolean }>(ctx, 'GET', workspacePath(ctx, `/agents/${agentId}/output${qs ? `?${qs}` : ''}`))
    }),
  )

  // bridge_status_panel ────────────────────────────────────────────────────────
  server.tool(
    'bridge_status_panel',
    'Get current status of a panel. Project-scoped contexts may only inspect their own project\'s panels (403 cross_project_block otherwise). Returns agentKey, status, daemonId, role, projectId.',
    { agentId: z.string().describe('The panel/agent ID to inspect') },
    ({ agentId }) => safe(() => request<{ agentId: string; agentKey: string; status: string; daemonId: string; role?: string; projectId?: string; workspaceId?: string }>(ctx, 'GET', workspacePath(ctx, `/agents/${agentId}`))),
  )

  // bridge_create_group ─────────────────────────────────────────────────────────
  server.tool(
    'bridge_create_group',
    'Create a new agent group in the current project with an optional color.',
    {
      name:  z.string().min(1).max(64).describe('Human-readable group name'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Hex color e.g. #6366f1'),
    },
    ({ name, color }) => safe(() => {
      if (!ctx.projectId) throw new Error('Project-scoped context required')
      return request<{ groupId: string; name: string; color: string }>(ctx, 'POST', workspacePath(ctx, `/projects/${ctx.projectId}/groups`), { name, color })
    }),
  )

  // bridge_update_group ─────────────────────────────────────────────────────────
  server.tool(
    'bridge_update_group',
    'Rename or recolor an existing agent group.',
    {
      groupId: z.string().describe('The group ID to update'),
      name:    z.string().min(1).max(64).optional().describe('New group name'),
      color:   z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('New hex color e.g. #6366f1'),
    },
    ({ groupId, name, color }) => safe(() => {
      if (!ctx.projectId) throw new Error('Project-scoped context required')
      return request<{ groupId: string; name: string; color: string }>(ctx, 'PATCH', workspacePath(ctx, `/projects/${ctx.projectId}/groups/${groupId}`), { name, color })
    }),
  )

  // bridge_assign_agent_to_group ───────────────────────────────────────────────
  server.tool(
    'bridge_assign_agent_to_group',
    'Assign a running agent to a group (team), or remove it with groupId:null. Orchestrator panels cannot join groups. Project-scoped context required; the group must already exist (use bridge_create_group first).',
    { agentId: z.string().min(1), groupId: z.string().nullable() },
    ({ agentId, groupId }) => safe(() => {
      if (!ctx.projectId) throw new Error('Project-scoped context required')
      return request(ctx, 'PATCH', workspacePath(ctx, `/projects/${ctx.projectId}/agents/${agentId}/group`), { groupId })
    }),
  )

  // bridge_delete_group ─────────────────────────────────────────────────────────
  server.tool(
    'bridge_delete_group',
    'Delete an agent group. Members are detached but keep running.',
    { groupId: z.string().describe('The group ID to delete') },
    ({ groupId }) => safe(() => {
      if (!ctx.projectId) throw new Error('Project-scoped context required')
      return request<{ ok: boolean }>(ctx, 'DELETE', workspacePath(ctx, `/projects/${ctx.projectId}/groups/${groupId}`))
    }),
  )
}
