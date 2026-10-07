import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { PersonaScheduleSchema, registerPersonaScheduleTools } from '../tools/persona-schedules.js'

const ctx = { serverUrl: 'http://localhost:3000', token: 'test-token', workspaceId: 'ws-test', projectId: 'proj-test' }

type Handler = (params: Record<string, unknown>) => Promise<unknown>
/** Capture the real tool handler, so the forwarding under test is the tool's own switch. */
function captureHandler(): Handler {
  let handler: Handler | undefined
  const server = { tool: (_name: string, _description: string, _shape: unknown, fn: Handler) => { handler = fn } }
  registerPersonaScheduleTools(server as unknown as McpServer, ctx)
  return handler!
}

async function capturingFetch<T>(work: () => Promise<T>): Promise<Array<{ method: string, body: Record<string, unknown> }>> {
  const calls: Array<{ method: string, body: Record<string, unknown> }> = []
  const prior = globalThis.fetch
  globalThis.fetch = (async (_input, init) => {
    calls.push({ method: String(init?.method), body: JSON.parse(String(init?.body)) })
    return { ok: true, status: 200, json: async () => ({ schedule: {}, created: true }) } as Response
  }) as typeof fetch
  try { await work() } finally { globalThis.fetch = prior }
  return calls
}

const CREATE = { action: 'create', personaId: 'p', projectId: 'proj', daemonId: 'd', duty: 'inspect', kind: 'daily', atTime: '09:00', timezone: 'UTC' }

describe('bridge_persona_schedule guardrail posture', () => {
  it('validates the closed mode vocabulary and the 512-char text bound', () => {
    for (const mode of ['read_only_report', 'edit_worktree', 'custom']) {
      assert.equal(PersonaScheduleSchema.safeParse({ action: 'create', guardrailMode: mode }).success, true)
    }
    assert.equal(PersonaScheduleSchema.safeParse({ action: 'create', guardrailMode: 'none' }).success, false)
    assert.equal(PersonaScheduleSchema.safeParse({ action: 'update', guardrailText: null }).success, true)
    assert.equal(PersonaScheduleSchema.safeParse({ action: 'update', guardrailText: 'x'.repeat(513) }).success, false)
  })

  it('the create handler forwards guardrailMode and guardrailText to POST', async () => {
    const handler = captureHandler()
    const calls = await capturingFetch(() => handler({ ...CREATE, guardrailMode: 'custom', guardrailText: 'May edit docs/ only.' }))
    assert.equal(calls[0]?.method, 'POST')
    assert.equal(calls[0]?.body.guardrailMode, 'custom')
    assert.equal(calls[0]?.body.guardrailText, 'May edit docs/ only.')
  })

  it('the update handler forwards both fields to PATCH, keeping null distinct from omission', async () => {
    const handler = captureHandler()
    const calls = await capturingFetch(async () => {
      await handler({ action: 'update', scheduleId: 's', guardrailMode: 'read_only_report', guardrailText: null })
      await handler({ action: 'update', scheduleId: 's', duty: 'only the duty' })
    })
    assert.equal(calls[0]?.method, 'PATCH')
    assert.equal(calls[0]?.body.guardrailMode, 'read_only_report')
    assert.equal('guardrailText' in (calls[0]?.body ?? {}), true)
    assert.equal(calls[0]?.body.guardrailText, null)
    assert.equal('guardrailMode' in (calls[1]?.body ?? {}), false)
    assert.equal('guardrailText' in (calls[1]?.body ?? {}), false)
  })
})
