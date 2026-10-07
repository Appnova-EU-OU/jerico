import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type BridgeContext, getTodos, addTodo, updateTodoStatus, updateTodo, cancelRun } from '../api.js'
import { safeTool as safe } from '../tool-result.js'
import {
  prependTodoRunWarning,
  todoRunWorkflowWarning,
  type TodoRunSessionState,
} from '../todo-run-session.js'

export function registerTodoTools(server: McpServer, ctx: BridgeContext, todoRunState: TodoRunSessionState): void {
  // bridge_get_todos ─────────────────────────────────────────────────────────
  server.tool(
    'bridge_get_todos',
    'List todos for this Bridge project. By default returns planning-draft todos only (pending items from a planning session). Pass scope:"active" to return the full todo DAG for the in-flight run (all statuses, ordered by seq). Returns session context (spec, status, name) alongside todos.',
    {
      scope: z.enum(['planning', 'active']).optional().describe('planning (default): pending planning-draft todos only. active: full todo DAG for the in-flight run.'),
    },
    ({ scope }) => safe(() => getTodos(ctx, scope ?? undefined)),
  )

  // bridge_cancel_run ────────────────────────────────────────────────────────
  server.tool(
    'bridge_cancel_run',
    'Cancel the currently active orchestration run for this project. Use this to clear a stale or incorrect run before starting a new one. Returns { ok, cancelled } where cancelled is the number of runs stopped.',
    {},
    () => safe(async () => {
      const warning = todoRunWorkflowWarning(todoRunState, ctx, 'bridge_cancel_run')
      return prependTodoRunWarning(warning, await cancelRun(ctx))
    }),
  )

  // bridge_add_todo ──────────────────────────────────────────────────────────
  server.tool(
    'bridge_add_todo',
    'Add a new todo to this Bridge project. The todo will appear in the Todos tab immediately. Use dependsOn to chain todos so a task only starts after its dependencies complete. Use todoType to classify the task (planning/implementation/review/infra) — review todos are automatically routed to reviewer-role panels.',
    {
      title:          z.string().min(1).describe('Short title for the todo item'),
      estimatedAgent: z.enum(['claude', 'sh', 'codex', 'qwen', 'kimi', 'agy', 'ollama', 'aider', 'forge', 'opencode', 'copilot']).optional().describe('Agent key expected to run this todo — omit to auto-derive from todoType'),
      dependsOn:      z.array(z.string()).optional().describe('List of todo IDs that must complete before this todo starts'),
      todoType:       z.enum(['planning', 'implementation', 'review', 'infra']).optional().describe('Task type — review todos are routed to reviewer-role panels automatically'),
    },
    ({ title, estimatedAgent, dependsOn, todoType }) => safe(async () => {
      // Default estimatedAgent from todoType so topological-sort tier/tiebreaker logic works:
      // infra → 'sh' (shell tier), everything else → 'claude' (ai tier)
      const agentDefault = todoType === 'infra' ? 'sh' : 'claude'
      const warning = todoRunWorkflowWarning(todoRunState, ctx, 'bridge_add_todo')
      return prependTodoRunWarning(
        warning,
        await addTodo(ctx, title, estimatedAgent ?? agentDefault, dependsOn, todoType),
      )
    }),
  )

  // bridge_update_todo ───────────────────────────────────────────────────────
  server.tool(
    'bridge_update_todo',
    'Update a todo item — change its title or status.',
    {
      id:     z.string().describe('Todo ID (UUID)'),
      title:  z.string().optional().describe('New title'),
      status: z.enum(['pending', 'assigned', 'running', 'completed', 'failed', 'blocked']).optional().describe('New status'),
    },
    ({ id, title, status }) => safe(() => updateTodo(ctx, id, { title, status })),
  )

  // bridge_update_todo_status ────────────────────────────────────────────────
  server.tool(
    'bridge_update_todo_status',
    "Update the status of a todo in this Bridge project. Valid statuses: 'completed', 'failed', 'pending', 'running'.",
    {
      id:     z.string().describe('Todo ID (UUID) returned by bridge_get_todos or bridge_add_todo'),
      status: z.enum(['pending', 'assigned', 'running', 'completed', 'failed', 'blocked']).describe('New status for the todo'),
    },
    ({ id, status }) => safe(() => updateTodoStatus(ctx, id, status)),
  )
}
