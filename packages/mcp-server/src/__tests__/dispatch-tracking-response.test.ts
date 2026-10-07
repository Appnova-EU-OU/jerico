import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTodoRunSessionState } from '../todo-run-session.js'
import { registerOrchestrationTools } from '../tools/orchestration.js'

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

for (const name of ['bridge_dispatch_brief', 'bridge_dispatch_free_task']) {
  describe(name, () => {
    for (const status of [200, 503]) {
      it(`preserves server tracking or failure without synthesizing readiness (${status})`, async () => {
        const handlers = new Map<string, Handler>()
        registerOrchestrationTools({
          tool(toolName: string, ...args: unknown[]) { handlers.set(toolName, args.at(-1) as Handler) },
        } as never, {
          serverUrl: 'http://bridge.test', token: 'test', projectId: '', workspaceId: 'workspace-1', agentId: 'orchestrator-1',
        }, createTodoRunSessionState())
        const expected = status === 200
          ? { ok: true, completionId: 'completion-1', tracking: {
              completionId: 'completion-1', hostSubscription: 'unverified', supervision: 'required',
              policy: {
                outcomeRead: { tool: 'bridge_get_free_task_outcome', args: { completionId: 'completion-1' } },
                mode: 'monitor_and_deep_peek', automaticTracking: 'unverified',
                deepPeek: { tool: 'bridge_peek_panel', args: { agentId: 'worker-1', lines: 300, expectedPanelInstanceId: 3 }, intervalMs: 120000, independentOfMonitor: true },
                taskState: { key: 'completion-1', lastCheckAt: null, ownedMonitorHandle: null, preventOverlappingChecks: true },
                cleanup: { terminalAuthority: 'accepted_daemon_sealed_receipt', scope: 'completionId', stopOwnedMonitor: true,
                  stopPeekLoop: true, sharedStream: 'keep_until_last_task', killWorkerPanel: false, cancellation: 'stop_owned_consumer_without_verdict' },
              },
              instructions: 'Server-controlled tracking guidance',
            } }
          : { error: 'completion_contract_persistence_failed' }
        const originalFetch = globalThis.fetch
        globalThis.fetch = async () => Response.json(expected, { status })
        try {
          const result = await handlers.get(name)!({ agentId: 'worker-1', text: 'Read brief' })
          assert.deepEqual(JSON.parse(result.content[0]!.text), expected)
          assert.equal(result.isError, status === 503 ? true : undefined)
        } finally {
          globalThis.fetch = originalFetch
        }
      })
    }
  })
}
