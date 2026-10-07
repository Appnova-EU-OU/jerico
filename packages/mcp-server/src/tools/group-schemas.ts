import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type BridgeContext, request, workspacePath } from '../api.js'
import { safeTool as safe } from '../tool-result.js'

export function registerGroupSchemaTools(server: McpServer, ctx: BridgeContext): void {

  // bridge_list_group_schemas ───────────────────────────────────────────────────
  server.tool(
    'bridge_list_group_schemas',
    'List reusable team/group schema templates saved in this workspace. Returns name, slug, color, groupsJson payload, and metadata for each schema.',
    {
      scope:     z.enum(['personal', 'workspace', 'project']).optional().describe('Scope filter'),
      projectId: z.string().optional().describe('Filter to a specific project'),
      q:         z.string().optional().describe('Substring search on name'),
    },
    ({ scope, projectId, q }) => safe(() => {
      let path = '/group-schemas'
      const params = new URLSearchParams()
      if (scope) params.set('scope', scope)
      if (projectId) params.set('projectId', projectId)
      if (q) params.set('q', q)
      const qs = params.toString()
      if (qs) path += '?' + qs
      return request<{ groupSchemas: Array<{ id: string; name: string; slug: string; description: string | null; color: string; groupsJson: unknown; scope: string; archivedAt: string | null; createdAt: string | null; updatedAt: string | null }> }>(ctx, 'GET', workspacePath(ctx, path))
    }),
  )

  // bridge_apply_group_schema ───────────────────────────────────────────────────
  server.tool(
    'bridge_apply_group_schema',
    'Apply a group schema template to spawn all its groups and agents in one call. Validates model availability against the target daemon. Returns created groups + agent IDs and any partial failures. ' +
    'A destructive slot cmd for agentKey:"sh" is refused per slot — reported in partialFailures as "blast_radius_confirmation_required: <reason>" (deterministic, not transient: reapplying without confirmBlastRadius keeps failing that slot; other slots still apply). ' +
    'Resend the SAME call with confirmBlastRadius: true to proceed; it covers only that one call and is never stored.',
    {
      schemaId:  z.string().describe('The group schema ID to apply'),
      projectId: z.string().describe('Target project ID'),
      daemonId:  z.string().optional().describe('Target daemon ID (auto-resolves if omitted)'),
      mode:      z.enum(['auto-suffix', 'replace']).optional().describe('Name collision mode: auto-suffix (default) appends -2, -3, etc; replace reaps existing teams first'),
      confirmBlastRadius: z.boolean().optional()
        .describe('Set true to proceed after a blast_radius_confirmation_required refusal for a slot cmd in THIS schema. Omit or false: the gate applies. Not stored — must be resent on every call it should cover.'),
    },
    ({ schemaId, projectId, daemonId, mode, confirmBlastRadius }) => safe(() => {
      const body: { projectId: string; daemonId?: string; mode?: 'auto-suffix' | 'replace'; confirmBlastRadius?: boolean } =
        { projectId, daemonId, mode }
      if (confirmBlastRadius === true) body.confirmBlastRadius = true
      return request<{ created: Array<{ groupId: string; groupName: string; agentIds: string[] }>; partialFailures: Array<{ groupName: string; slotAgentKey?: string; error: string }> }>(
        ctx, 'POST', workspacePath(ctx, `/group-schemas/${schemaId}/apply`), body,
      )
    }),
  )

  // bridge_create_group_schema ──────────────────────────────────────────────────
  server.tool(
    'bridge_create_group_schema',
    'Create a reusable group schema template from the current project group setup. Serializes groups and agent slots into a template that can be applied later with bridge_apply_group_schema.',
    {
      name:        z.string().min(1).max(80).describe('Display name for the schema'),
      slug:        z.string().regex(/^[a-z][a-z0-9_]{1,62}$/).describe('Unique slug (lowercase, starts with letter, a-z0-9_ only, 2-63 chars)'),
      description: z.string().max(200).optional().describe('Optional description'),
      color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Hex colour for the schema card'),
      groupsJson:  z.any().optional().describe('GroupSchemaPayload: { version:1, groups:[{name, color?, slots:[{agentKey, model?, role?, count, cmd?}]}] }'),
      scope:       z.enum(['personal', 'workspace', 'project']).optional().describe('Visibility scope (default: workspace)'),
      projectId:   z.string().optional().describe('Project ID (required if scope=project)'),
    },
    ({ name, slug, description, color, groupsJson, scope, projectId }) => safe(() =>
      request<{ groupSchema: { id: string; name: string; slug: string; description: string | null; color: string; scope: string; groupsJson: unknown; archivedAt: string | null; createdAt: string; updatedAt: string } }>(
        ctx, 'POST', workspacePath(ctx, '/group-schemas'), { name, slug, description, color, groupsJson, scope, projectId },
      ),
    ),
  )

  // bridge_update_group_schema ──────────────────────────────────────────────────
  server.tool(
    'bridge_update_group_schema',
    'Update an existing (non-archived) group schema template. Pass schemaId plus only the fields to change (name, slug, description, color, groupsJson, shared). Returns the updated schema.',
    {
      schemaId:    z.string().describe('The group schema ID to update'),
      name:        z.string().min(1).max(80).optional().describe('New display name'),
      slug:        z.string().regex(/^[a-z][a-z0-9_]{1,62}$/).optional().describe('New unique slug (lowercase, starts with letter, a-z0-9_, 2-63 chars)'),
      description: z.string().max(200).optional().describe('New description'),
      color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('New hex colour e.g. #6366f1'),
      groupsJson:  z.any().optional().describe('Replacement GroupSchemaPayload: { version:1, groups:[{name, color?, slots:[{agentKey, model?, role?, count, cmd?}]}] }'),
      shared:      z.boolean().optional().describe('Workspace-scope only: mark the schema shared across the workspace'),
    },
    ({ schemaId, name, slug, description, color, groupsJson, shared }) => safe(() =>
      request<{ groupSchema: { id: string; name: string; slug: string; description: string | null; color: string; scope: string; groupsJson: unknown; archivedAt: string | null; createdAt: string; updatedAt: string } }>(
        ctx, 'PATCH', workspacePath(ctx, `/group-schemas/${schemaId}`), { name, slug, description, color, groupsJson, shared },
      ),
    ),
  )

  // bridge_list_agent_models ────────────────────────────────────────────────────
  server.tool(
    'bridge_list_agent_models',
    'List available models for an agent key on a target daemon. Validates model portability across machines; use before applying a group schema to verify required models exist.',
    {
      agentKey: z.string().optional().describe('Filter by agent key (e.g. claude, kimi, qwen)'),
      daemonId: z.string().optional().describe('Filter by daemon ID'),
    },
    ({ agentKey, daemonId }) => safe(() => {
      let path = '/agent-models'
      const params = new URLSearchParams()
      if (agentKey) params.set('agentKey', agentKey)
      if (daemonId) params.set('daemonId', daemonId)
      const qs = params.toString()
      if (qs) path += '?' + qs
      return request<{ agentModels: Array<{ agentKey: string; daemonId: string; source: string; models: string[] }> }>(ctx, 'GET', workspacePath(ctx, path))
    }),
  )
}
