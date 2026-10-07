import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AGENT_ROLES } from '@jerico/shared'
import { type BridgeContext, listRolePrompts, getRolePrompt, updateRolePrompt, deleteRolePrompt } from '../api.js'
import { safeTool as safe } from '../tool-result.js'

const ROLE_PROMPT_KEYS = AGENT_ROLES as unknown as [string, ...string[]]

export const ListRolePromptsSchema = z.object({})

export const GetRolePromptSchema = z.object({
  role: z.enum(ROLE_PROMPT_KEYS).describe('Role name: developer, reviewer, planner, executor, shell, runner, or orchestrator'),
})

export const UpdateRolePromptSchema = z.object({
  role:    z.enum(ROLE_PROMPT_KEYS).describe('Role name to update'),
  content: z.string().min(1).describe('New system prompt content'),
})

export function registerRolePromptTools(server: McpServer, ctx: BridgeContext): void {
  server.tool(
    'bridge_list_role_prompts',
    'List all role prompts for the current workspace. Returns 7 entries (developer, reviewer, planner, executor, shell, runner, orchestrator) with merged workspace overrides or global defaults.',
    ListRolePromptsSchema.shape,
    () => safe(() => listRolePrompts(ctx)),
  )

  server.tool(
    'bridge_get_role_prompt',
    'Fetch the system prompt for a specific role. You MUST call this tool as your first action after spawn. Falls back to global default if no workspace override exists.',
    GetRolePromptSchema.shape,
    (params) => safe(() => getRolePrompt(ctx, params.role)),
  )

  server.tool(
    'bridge_update_role_prompt',
    'Update the workspace-specific system prompt for a role. Creates a workspace override; does not mutate the global default.',
    UpdateRolePromptSchema.shape,
    (params) => safe(() => updateRolePrompt(ctx, params.role, params.content)),
  )

  server.tool(
    'bridge_delete_role_prompt',
    'Revert a workspace role prompt to the global default. Removes the workspace-specific row; subsequent fetches return the system default content.',
    GetRolePromptSchema.shape,
    (params) => safe(() => deleteRolePrompt(ctx, params.role)),
  )
}
