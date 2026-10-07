import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ORCHESTRATOR_TODO_RUN_WORKFLOW, ORCHESTRATOR_TODO_RUN_WORKFLOW_VERSION } from '@jerico/shared'
import type { BridgeContext } from '../api.js'
import { registerOrchestrationTools } from '../tools/orchestration.js'
import { registerTodoTools } from '../tools/todos.js'
import {
  createTodoRunSessionState,
  TODO_RUN_WORKFLOW_WARNING,
} from '../todo-run-session.js'

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

class FakeMcpServer {
  handlers = new Map<string, Handler>()
  tool(name: string, ...args: unknown[]): void {
    this.handlers.set(name, args.at(-1) as Handler)
  }
}

const ctx: BridgeContext = {
  serverUrl: 'http://bridge.test',
  token: 'token',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  agentId: 'orchestrator-1',
}

function payload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

describe('bridge_get_todo_run_instructions', () => {
  it('returns the static versioned workflow without an HTTP hop', async () => {
    const fake = new FakeMcpServer()
    const state = createTodoRunSessionState()
    registerOrchestrationTools(fake as never, ctx, state)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('unexpected fetch') }
    try {
      const result = await fake.handlers.get('bridge_get_todo_run_instructions')!({})
      assert.equal(result.isError, undefined)
      assert.deepEqual(payload(result), {
        mode: 'bridge_todo_run',
        workflowVersion: ORCHESTRATOR_TODO_RUN_WORKFLOW_VERSION,
        instructions: ORCHESTRATOR_TODO_RUN_WORKFLOW,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('prepends a warning to orchestrator mutations until the workflow is pulled', async () => {
    const fake = new FakeMcpServer()
    const state = createTodoRunSessionState()
    registerTodoTools(fake as never, ctx, state)
    registerOrchestrationTools(fake as never, ctx, state)

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => Response.json({ ok: true, cancelled: 1 })
    try {
      const protectedCalls: Array<[string, Record<string, unknown>]> = [
        ['bridge_add_todo', { title: 'Smoke todo', todoType: 'implementation' }],
        ['bridge_assign_task', { todoId: 'todo-1', agentId: 'worker-1' }],
        ['bridge_cancel_run', {}],
      ]
      for (const [name, args] of protectedCalls) {
        const before = payload(await fake.handlers.get(name)!(args))
        assert.equal(before.warning, TODO_RUN_WORKFLOW_WARNING, name)
        assert.equal(before.ok, true, name)
      }

      await fake.handlers.get('bridge_get_todo_run_instructions')!({})
      const after = payload(await fake.handlers.get('bridge_cancel_run')!({}))
      assert.equal(after.warning, undefined)
      assert.equal(after.ok, true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
