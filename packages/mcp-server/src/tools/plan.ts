import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type BridgeContext, getProject, updateProject, getExecutionStatus } from '../api.js'
import { safeTool as safe } from '../tool-result.js'

export function registerPlanTools(server: McpServer, ctx: BridgeContext): void {
  // bridge_get_project moved to workspace.ts (uses safe() wrapper).
  // Kept here historically — duplicate registration crashed bridge-mcp init.

  // bridge_get_execution_status ──────────────────────────────────────────────
  server.tool(
    'bridge_get_execution_status',
    'Get the execution run history and status for this project. Returns recent runs with todo completion counts.',
    {},
    () => safe(() => getExecutionStatus(ctx)),
  )

  // bridge_get_blueprint (issue #512 D2) ─────────────────────────────────────
  // Canonical read of the project blueprint (markdown doc stored in the
  // project description field). Response shape: { blueprint, updatedAt }.
  server.tool(
    'bridge_get_blueprint',
    'Get the project blueprint — the architecture/conventions/features/decisions markdown doc for this project. Returns { blueprint, updatedAt }; updatedAt is null when the blueprint was never seeded.',
    {},
    () => safe(async () => {
      const project = await getProject(ctx)
      return { blueprint: project.description ?? '', updatedAt: project.blueprintUpdatedAt ?? null }
    }),
  )

  // bridge_update_blueprint (issue #512 D2) ──────────────────────────────────
  server.tool(
    'bridge_update_blueprint',
    'Update the project blueprint markdown doc. Stored as the project description and immediately reflected in the Bridge UI. Returns { ok, blueprint, updatedAt }.',
    { content: z.string().describe('New blueprint content in Markdown') },
    ({ content }) => safe(async () => {
      const project = await updateProject(ctx, content)
      return { ok: true, blueprint: project.description ?? '', updatedAt: project.blueprintUpdatedAt ?? null }
    }),
  )

  // bridge_get_plan — DEPRECATED alias for bridge_get_blueprint (one release).
  // Re-maps the new { blueprint, updatedAt } shape back to the legacy { plan }
  // shape rather than re-calling, so old agents keep working unchanged.
  server.tool(
    'bridge_get_plan',
    'DEPRECATED — use bridge_get_blueprint. Get the current plan / spec for this Bridge project (legacy { plan } response shape).',
    {},
    () => safe(async () => {
      const project = await getProject(ctx)
      return { plan: project.description ?? '' }
    }),
  )

  // bridge_update_plan — DEPRECATED alias for bridge_update_blueprint (one release).
  server.tool(
    'bridge_update_plan',
    'DEPRECATED — use bridge_update_blueprint. Update the plan / spec for this Bridge project (legacy response shape).',
    { content: z.string().describe('New plan content in Markdown') },
    ({ content }) => safe(async () => {
      await updateProject(ctx, content)
      return { ok: true }
    }),
  )
}
