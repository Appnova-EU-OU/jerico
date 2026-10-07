import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PersonaScheduleSchema } from '../tools/persona-schedules.js'
import { createPersonaSchedule, updatePersonaSchedule } from '../api.js'

const ctx = { serverUrl: 'http://localhost:3000', token: 'test-token', workspaceId: 'ws-test', projectId: 'proj-test' }

describe('bridge_persona_schedule model pin', () => {
  it('accepts a pin or explicit null and keeps omission distinct', () => {
    assert.equal(PersonaScheduleSchema.safeParse({ action: 'create', model: 'opus' }).success, true)
    assert.equal(PersonaScheduleSchema.safeParse({ action: 'update', model: null }).success, true)
    assert.equal(PersonaScheduleSchema.safeParse({ action: 'update' }).success, true)
  })

  it('forwards create pin and PATCH clear unchanged to REST', async () => {
    const bodies: Record<string, unknown>[] = []
    const prior = globalThis.fetch
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return { ok: true, status: 200, json: async () => ({ schedule: { model: bodies.at(-1)?.model }, created: true }) } as Response
    }) as typeof fetch
    try {
      await createPersonaSchedule(ctx, { personaId: 'p', projectId: 'proj', daemonId: 'd', duty: 'inspect', kind: 'daily', atTime: '09:00', timezone: 'UTC', model: 'opus' })
      await updatePersonaSchedule(ctx, 's', { model: null })
      assert.equal(bodies[0]?.model, 'opus')
      assert.equal(bodies[1]?.model, null)
    } finally { globalThis.fetch = prior }
  })
})
