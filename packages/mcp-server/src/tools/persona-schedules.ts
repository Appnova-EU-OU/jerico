import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  type BridgeContext,
  listPersonaSchedules,
  createPersonaSchedule,
  updatePersonaSchedule,
  enablePersonaSchedule,
  disablePersonaSchedule,
  deletePersonaSchedule,
  runPersonaScheduleNow,
} from '../api.js'
import { safeTool as safe } from '../tool-result.js'

// ONE tool, not four (§4.3): four CRUD tools would cost four prompt updates
// for one resource. Zod validates the argument SHAPE only — idempotency, the
// cap, the provider gate, immutability and the §4.4 role check all live on the
// server, one enforcement point each. REST error codes surface verbatim.
export const PersonaScheduleSchema = z.object({
  action: z.enum(['list', 'create', 'update', 'enable', 'disable', 'delete', 'run_now']).describe('Operation to perform. Create is idempotent on (personaId, projectId, daemonId, kind, atTime); enabling is a deliberate second action, never folded into create/update. run_now queues one immediate run of an enabled schedule (202 = accepted, not started); it never waits for an offline machine and never retries.'),
  scheduleId:      z.string().min(1).optional().describe('Schedule id (required for update/enable/disable/delete/run_now)'),
  personaId:       z.string().min(1).optional().describe('Persona to run on schedule (required for create)'),
  projectId:       z.string().min(1).optional().describe('Target project (required for create)'),
  daemonId:        z.string().min(1).optional().describe('Machine to run on (required for create)'),
  duty:            z.string().min(1).max(2000).optional().describe('Task text, ≤2000 chars (required for create)'),
  kind:            z.enum(['daily', 'weekly']).optional().describe("'daily' or 'weekly' (required for create)"),
  atTime:          z.string().regex(/^\d{2}:\d{2}$/).optional().describe('HH:MM local wall clock (required for create)'),
  weekdays:        z.array(z.number().int().min(0).max(6)).optional().describe('0-6 (Sunday=0), required iff kind=weekly, rejected for daily'),
  timezone:        z.string().min(1).optional().describe('IANA timezone (required for create)'),
  maxRuntimeMs:    z.number().int().min(1).optional().describe('Runtime deadline ms (default 900000)'),
  expectedBranchRef: z.string().nullable().optional().describe("Branch pin (create/update): the run only starts if the project checkout is on exactly this branch; otherwise it closes skipped/branch_mismatch and is never retried. Plain branch name (a leading refs/heads/ is stripped); null on update clears it."),
  model: z.string().nullable().optional().describe('Optional launch model pin; null clears to daemon default. The model must be a valid single-token id and offered by the daemon at dispatch time.'),
  guardrailMode: z.enum(['read_only_report', 'edit_worktree', 'custom']).optional().describe('Duty guardrail posture (create/update). Defaults to read_only_report. Agents may only set read_only_report; edit_worktree/custom are refused 403 guardrail_change_requires_human and need the user in the Duties UI.'),
  guardrailText: z.string().max(512).nullable().optional().describe('Custom guardrail text, required iff guardrailMode=custom (≤512 chars); null clears it.'),
  retryOnDaemonOffline: z.boolean().optional().describe('Opt in: if the machine is offline at fire time, wait for it and retry up to 5 times within 12 hours (create/update). The run shows phase retry_wait while waiting; it closes skipped/retry_window_expired or skipped/retry_exhausted_daemon_offline if the machine never returns.'),
  idempotencyKey: z.string().uuid().optional().describe('Stable UUID for run_now: repeating the same key returns the same run instead of queueing another'),
})

export function registerPersonaScheduleTools(server: McpServer, ctx: BridgeContext): void {
  server.tool(
    'bridge_persona_schedule',
    'Manage scheduled personas — a single tool for list/create/update/enable/disable/delete/run_now of recurring persona duties. ' +
    'Write actions require an orchestrator-role panel; the server enforces it. Create always yields an ENABLED=false schedule; arming is the separate enable action. ' +
    'Create/update accept model: a per-schedule launch pin; null uses the daemon default, and an unavailable pin skips the run. guardrailMode defaults to read_only_report; agents can only set read_only_report — edit_worktree/custom require the user in the Duties UI. list returns each schedule with its last few runs, so you can answer "did last night\'s duty run?" without a second tool.',
    PersonaScheduleSchema.shape,
    (params) => safe(async () => {
      switch (params.action) {
        case 'list':
          return listPersonaSchedules(ctx, params.projectId ? { projectId: params.projectId } : undefined)
        case 'create':
          return createPersonaSchedule(ctx, {
            personaId: requireParam(params.personaId, 'personaId'),
            projectId: requireParam(params.projectId, 'projectId'),
            daemonId: requireParam(params.daemonId, 'daemonId'),
            duty: requireParam(params.duty, 'duty'),
            kind: requireParam(params.kind, 'kind'),
            atTime: requireParam(params.atTime, 'atTime'),
            timezone: requireParam(params.timezone, 'timezone'),
            ...(params.weekdays !== undefined ? { weekdays: params.weekdays } : {}),
            ...(params.maxRuntimeMs !== undefined ? { maxRuntimeMs: params.maxRuntimeMs } : {}),
            ...(params.retryOnDaemonOffline !== undefined ? { retryOnDaemonOffline: params.retryOnDaemonOffline } : {}),
            ...(params.expectedBranchRef !== undefined ? { expectedBranchRef: params.expectedBranchRef } : {}),
            ...(params.model !== undefined ? { model: params.model } : {}),
            ...(params.guardrailMode !== undefined ? { guardrailMode: params.guardrailMode } : {}),
            ...(params.guardrailText !== undefined ? { guardrailText: params.guardrailText } : {}),
          })
        case 'update':
          return updatePersonaSchedule(ctx, requireParam(params.scheduleId, 'scheduleId'), {
            ...(params.duty !== undefined ? { duty: params.duty } : {}),
            ...(params.kind !== undefined ? { kind: params.kind } : {}),
            ...(params.atTime !== undefined ? { atTime: params.atTime } : {}),
            ...(params.weekdays !== undefined ? { weekdays: params.weekdays } : {}),
            ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
            ...(params.maxRuntimeMs !== undefined ? { maxRuntimeMs: params.maxRuntimeMs } : {}),
            ...(params.expectedBranchRef !== undefined ? { expectedBranchRef: params.expectedBranchRef } : {}),
            ...(params.model !== undefined ? { model: params.model } : {}),
            ...(params.retryOnDaemonOffline !== undefined ? { retryOnDaemonOffline: params.retryOnDaemonOffline } : {}),
            ...(params.guardrailMode !== undefined ? { guardrailMode: params.guardrailMode } : {}),
            ...(params.guardrailText !== undefined ? { guardrailText: params.guardrailText } : {}),
          })
        case 'enable':
          return enablePersonaSchedule(ctx, requireParam(params.scheduleId, 'scheduleId'))
        case 'disable':
          return disablePersonaSchedule(ctx, requireParam(params.scheduleId, 'scheduleId'))
        case 'delete':
          return deletePersonaSchedule(ctx, requireParam(params.scheduleId, 'scheduleId'))
        case 'run_now':
          return runPersonaScheduleNow(ctx, requireParam(params.scheduleId, 'scheduleId'), params.idempotencyKey)
      }
    }),
  )
}

function requireParam<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null) {
    throw new Error(`missing required argument: ${name}`)
  }
  return value
}
