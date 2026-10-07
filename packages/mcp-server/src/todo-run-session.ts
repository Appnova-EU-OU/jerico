import type { BridgeContext } from './api.js'

export const TODO_RUN_WORKFLOW_WARNING =
  '[BRIDGE-ORCH] You have not read the todo/run workflow this session — call bridge_get_todo_run_instructions({}) first.'

export interface TodoRunSessionState {
  workflowPulled: boolean
}

let workflowPullsTotal = 0
let missingPullWarningsTotal = 0

export function createTodoRunSessionState(): TodoRunSessionState {
  return { workflowPulled: false }
}

export function noteTodoRunWorkflowPulled(state: TodoRunSessionState, ctx: BridgeContext): void {
  state.workflowPulled = true
  workflowPullsTotal++
  console.error('[mcp] todo_run.workflow.pulled', {
    agentId: ctx.agentId ?? null,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    pulls_total: workflowPullsTotal,
  })
}

export function todoRunWorkflowWarning(
  state: TodoRunSessionState,
  ctx: BridgeContext,
  tool: 'bridge_add_todo' | 'bridge_assign_task' | 'bridge_cancel_run',
): string | undefined {
  if (state.workflowPulled) return undefined

  missingPullWarningsTotal++
  console.warn('[mcp] todo_run.workflow.not_pulled', {
    tool,
    agentId: ctx.agentId ?? null,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    warnings_total: missingPullWarningsTotal,
  })
  return TODO_RUN_WORKFLOW_WARNING
}

export function prependTodoRunWarning<T>(warning: string | undefined, result: T): T | Record<string, unknown> {
  if (!warning) return result
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    return { warning, ...(result as Record<string, unknown>) }
  }
  return { warning, result }
}
