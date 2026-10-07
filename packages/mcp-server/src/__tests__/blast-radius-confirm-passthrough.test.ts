import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTodoRunSessionState } from '../todo-run-session.js'
import { registerOrchestrationTools } from '../tools/orchestration.js'
import { registerGroupSchemaTools } from '../tools/group-schemas.js'

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

function groupSchemaFixture(): Handler {
  const handlers = new Map<string, Handler>()
  registerGroupSchemaTools({
    tool(toolName: string, ...args: unknown[]) { handlers.set(toolName, args.at(-1) as Handler) },
  } as never, {
    serverUrl: 'http://bridge.test', token: 'test', projectId: '', workspaceId: 'workspace-1', agentId: 'orchestrator-1',
  } as never)
  return handlers.get('bridge_apply_group_schema')!
}

describe('bridge_send_input confirmBlastRadius passthrough', () => {
  function fixture() {
    const handlers = new Map<string, Handler>()
    registerOrchestrationTools({
      tool(toolName: string, ...args: unknown[]) { handlers.set(toolName, args.at(-1) as Handler) },
    } as never, {
      serverUrl: 'http://bridge.test', token: 'test', projectId: '', workspaceId: 'workspace-1', agentId: 'orchestrator-1',
    }, createTodoRunSessionState())
    return handlers
  }

  it('omits confirmBlastRadius from the request body when not passed', async () => {
    const handlers = fixture()
    const originalFetch = globalThis.fetch
    let sentBody: unknown
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(String(init?.body))
      return Response.json({ ok: true }, { status: 200 })
    }
    try {
      const result = await handlers.get('bridge_send_input')!({ agentId: 'shell-1', text: 'rm -rf /tmp/x' })
      assert.deepEqual(sentBody, { text: 'rm -rf /tmp/x' })
      assert.equal('confirmBlastRadius' in (sentBody as object), false)
      assert.deepEqual(JSON.parse(result.content[0]!.text), { ok: true })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('omits confirmBlastRadius from the request body when explicitly false', async () => {
    const handlers = fixture()
    const originalFetch = globalThis.fetch
    let sentBody: unknown
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(String(init?.body))
      return Response.json({ ok: true }, { status: 200 })
    }
    try {
      await handlers.get('bridge_send_input')!({ agentId: 'shell-1', text: 'rm -rf /tmp/x', confirmBlastRadius: false })
      assert.deepEqual(sentBody, { text: 'rm -rf /tmp/x' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('forwards confirmBlastRadius: true in the request body', async () => {
    const handlers = fixture()
    const originalFetch = globalThis.fetch
    let sentBody: unknown
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(String(init?.body))
      return Response.json({ ok: true }, { status: 200 })
    }
    try {
      const result = await handlers.get('bridge_send_input')!({ agentId: 'shell-1', text: 'rm -rf /tmp/x', confirmBlastRadius: true })
      assert.deepEqual(sentBody, { text: 'rm -rf /tmp/x', confirmBlastRadius: true })
      assert.deepEqual(JSON.parse(result.content[0]!.text), { ok: true })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('surfaces a blast_radius_confirmation_required refusal from the server unchanged', async () => {
    const handlers = fixture()
    const originalFetch = globalThis.fetch
    const expected = { ok: false, error: 'blast_radius_confirmation_required', message: 'destructive command targets a broad path' }
    globalThis.fetch = async () => Response.json(expected, { status: 400 })
    try {
      const result = await handlers.get('bridge_send_input')!({ agentId: 'shell-1', text: 'rm -rf /tmp/x' })
      assert.deepEqual(JSON.parse(result.content[0]!.text), expected)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('bridge_apply_group_schema confirmBlastRadius passthrough (#385 round 3)', () => {
  it('omits confirmBlastRadius from the request body when not passed', async () => {
    const handler = groupSchemaFixture()
    const originalFetch = globalThis.fetch
    let sentBody: unknown
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(String(init?.body))
      return Response.json({ created: [], partialFailures: [] }, { status: 201 })
    }
    try {
      await handler!({ schemaId: 'schema-1', projectId: 'project-1' })
      assert.deepEqual(sentBody, { projectId: 'project-1' })
      assert.equal('confirmBlastRadius' in (sentBody as object), false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('forwards confirmBlastRadius: true in the request body', async () => {
    const handler = groupSchemaFixture()
    const originalFetch = globalThis.fetch
    let sentBody: unknown
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(String(init?.body))
      return Response.json({ created: [], partialFailures: [] }, { status: 201 })
    }
    try {
      await handler!({ schemaId: 'schema-1', projectId: 'project-1', confirmBlastRadius: true })
      assert.deepEqual(sentBody, { projectId: 'project-1', confirmBlastRadius: true })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('surfaces a per-slot refusal from the server unchanged', async () => {
    const handler = groupSchemaFixture()
    const originalFetch = globalThis.fetch
    const expected = {
      created: [{ groupId: 'g1', groupName: 'Team A', agentIds: [] }],
      partialFailures: [{ groupName: 'Team A', slotAgentKey: 'sh', error: 'blast_radius_confirmation_required: Potential destructive command detected: "rm -rf"' }],
    }
    globalThis.fetch = async () => Response.json(expected, { status: 207 })
    try {
      const result = await handler!({ schemaId: 'schema-1', projectId: 'project-1' })
      assert.deepEqual(JSON.parse(result.content[0]!.text), expected)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
