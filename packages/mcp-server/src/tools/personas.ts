import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { USER_ASSIGNABLE_ROLES, ALL_AGENT_KEYS } from '@jerico/shared'
import {
  type BridgeContext,
  listPersonas, getPersona, createPersona, updatePersona, archivePersona, launchPersona, applyPersona,
} from '../api.js'
import { safeTool as safe } from '../tool-result.js'

// Exported schemas for testing
export const ListPersonasSchema = z.object({
  projectId:       z.string().min(1).optional().describe("Filter to project scope. Defaults to caller panel's project."),
  scope:           z.enum(['personal','workspace','project','all']).optional().describe('Scope filter (default: all)'),
  includeArchived: z.boolean().optional(),
  excludePersonal: z.boolean().optional().describe('Exclude personal-scoped personas from results (useful for orchestrator workspace-wide queries)'),
  agentKey:        z.enum(ALL_AGENT_KEYS as unknown as [string, ...string[]]).optional(),
  role:            z.enum(USER_ASSIGNABLE_ROLES as unknown as [string, ...string[]]).optional(),
  tag:             z.string().optional(),
  q:               z.string().optional().describe('Substring search on name+description'),
  limit:           z.number().int().min(1).max(200).optional(),
})

export const GetPersonaSchema = z.object({
  id:        z.string().min(1).describe('Persona id (UUID)'),
  projectId: z.string().min(1).optional(),
  fields:    z.array(z.enum(['id', 'name', 'systemPrompt', 'description', 'createdAt'])).optional().describe('Fields to project (e.g. ["systemPrompt"] reduces payload by ~75%).'),
})

export const CreatePersonaSchema = z.object({
  name:         z.string().min(1).max(80),
  slug:         z.string().min(1).max(63).regex(/^[a-z][a-z0-9_]*$/),
  description:  z.string().max(200).optional(),
  agentKey:     z.enum(ALL_AGENT_KEYS as unknown as [string, ...string[]]),
  role:         z.enum(USER_ASSIGNABLE_ROLES as unknown as [string, ...string[]]),
  systemPrompt: z.string().max(4000).optional(),
  defaultCwd:   z.string().optional(),
  defaultDaemonId: z.string().optional(),
  color:        z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  icon:         z.string().optional(),
  tags:         z.array(z.string()).max(10).optional(),
  projectId:    z.string().min(1).optional().describe('Make this a project-scoped persona. Omit for workspace-scoped.'),
})

export const UpdatePersonaSchema = z.object({
  id:           z.string().min(1),
  name:         z.string().min(1).max(80).optional(),
  description:  z.string().max(200).optional(),
  systemPrompt: z.string().max(4000).optional(),
  defaultCwd:   z.string().optional(),
  defaultDaemonId: z.string().optional(),
  color:        z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  icon:         z.string().optional(),
  tags:         z.array(z.string()).max(10).optional(),
})

export const ArchivePersonaSchema = z.object({
  id: z.string().min(1),
})

export const LaunchPersonaSchema = z.object({
  id:        z.string().min(1).describe('Persona id'),
  projectId: z.string().min(1).optional().describe('Target project for the spawned panel. Required from orchestrator.'),
  daemonId:  z.string().min(1).optional(),
  cwd:       z.string().optional(),
  cols:      z.number().int().optional(),
  rows:      z.number().int().optional(),
})

export const ApplyPersonaSchema = z.object({
  agentId:   z.string().min(1).describe('The panel/agent ID to apply the persona to'),
  personaId: z.string().min(1).describe('Persona id to apply'),
})

export function registerPersonaTools(server: McpServer, ctx: BridgeContext): void {

  // bridge_list_personas
  server.tool(
    'bridge_list_personas',
    'Query personas in the workspace. Returns lightweight list — call bridge_get_persona for full systemPrompt. ' +
    'Pass projectId to filter to a specific project. From the orchestrator (workspace scope) optionally pass projectId; per-project workers default to ctx.projectId. ' +
    'Set excludePersonal:true to filter out personal-scoped personas (useful for orchestrator workspace-wide queries).',
    ListPersonasSchema.shape,
    (opts) => safe(() => listPersonas(ctx, opts)),
  )

  // bridge_get_persona
  server.tool(
    'bridge_get_persona',
    'Fetch a single persona by id. Returns full systemPrompt and all fields.',
    GetPersonaSchema.shape,
    (params) => safe(() => getPersona(ctx, params)),
  )

  // bridge_create_persona
  server.tool(
    'bridge_create_persona',
    'Create a new persona. Required from the orchestrator: pass projectId if creating a project-scoped persona; omit for workspace-scoped.',
    CreatePersonaSchema.shape,
    (params) => safe(() => createPersona(ctx, params)),
  )

  // bridge_update_persona
  server.tool(
    'bridge_update_persona',
    'Update fields of an existing persona. Pass only the fields you want to change.',
    UpdatePersonaSchema.shape,
    (params) => safe(() => updatePersona(ctx, params)),
  )

  // bridge_archive_persona
  server.tool(
    'bridge_archive_persona',
    'Soft-archive a persona. Removes it from the active list but preserves audit trail.',
    ArchivePersonaSchema.shape,
    ({ id }) => safe(() => archivePersona(ctx, id)),
  )

  // bridge_launch_persona
  server.tool(
    'bridge_launch_persona',
    'Spawn a live panel from a persona. Returns the new agentId.',
    LaunchPersonaSchema.shape,
    (params) => safe(() => launchPersona(ctx, params)),
  )

  // bridge_apply_persona
  server.tool(
    'bridge_apply_persona',
    'Apply a persona to an existing running panel (soft swap). Sends a nudge telling the agent to call bridge_get_persona({ id }) to fetch its authoritative operating instructions. ' +
    'Returns 409 if the persona\'s agentKey does not match the panel\'s agentKey (e.g., claude persona on qwen panel).',
    ApplyPersonaSchema.shape,
    (params) => safe(() => applyPersona(ctx, params)),
  )
}
