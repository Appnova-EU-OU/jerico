import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  ListPersonasSchema,
  GetPersonaSchema,
  CreatePersonaSchema,
  UpdatePersonaSchema,
  ArchivePersonaSchema,
  LaunchPersonaSchema,
} from '../tools/personas.js'

describe('persona tool schemas', () => {

  it('ListPersonasSchema accepts valid input', () => {
    const result = ListPersonasSchema.safeParse({ scope: 'workspace', q: 'devops', limit: 50 })
    assert.strictEqual(result.success, true)
  })

  it('ListPersonasSchema rejects out-of-range limit', () => {
    const result = ListPersonasSchema.safeParse({ limit: 500 })
    assert.strictEqual(result.success, false)
  })

  it('GetPersonaSchema accepts id', () => {
    const result = GetPersonaSchema.safeParse({ id: 'devops-expert' })
    assert.strictEqual(result.success, true)
  })

  it('GetPersonaSchema rejects empty id', () => {
    const result = GetPersonaSchema.safeParse({ id: '' })
    assert.strictEqual(result.success, false)
  })

  it('CreatePersonaSchema accepts valid persona', () => {
    const result = CreatePersonaSchema.safeParse({
      name: 'DevOps Expert',
      slug: 'devops_expert',
      agentKey: 'claude',
      role: 'developer',
      systemPrompt: 'You are a DevOps specialist.',
      color: '#6366f1',
    })
    assert.strictEqual(result.success, true)
  })

  it('CreatePersonaSchema rejects invalid slug', () => {
    const result = CreatePersonaSchema.safeParse({
      name: 'Bad Slug',
      slug: 'Bad-Slug',
      agentKey: 'claude',
      role: 'developer',
    })
    assert.strictEqual(result.success, false)
  })

  it('CreatePersonaSchema rejects invalid agentKey', () => {
    const result = CreatePersonaSchema.safeParse({
      name: 'Test',
      slug: 'test',
      agentKey: 'invalid_key',
      role: 'developer',
    })
    assert.strictEqual(result.success, false)
  })

  it('CreatePersonaSchema rejects invalid role', () => {
    const result = CreatePersonaSchema.safeParse({
      name: 'Test',
      slug: 'test',
      agentKey: 'claude',
      role: 'invalid_role',
    })
    assert.strictEqual(result.success, false)
  })

  it('CreatePersonaSchema rejects invalid color', () => {
    const result = CreatePersonaSchema.safeParse({
      name: 'Test',
      slug: 'test',
      agentKey: 'claude',
      role: 'developer',
      color: 'red',
    })
    assert.strictEqual(result.success, false)
  })

  it('UpdatePersonaSchema accepts partial updates', () => {
    const result = UpdatePersonaSchema.safeParse({
      id: 'uuid-123',
      name: 'Updated Name',
      color: '#ff0000',
    })
    assert.strictEqual(result.success, true)
  })

  it('UpdatePersonaSchema rejects missing id', () => {
    const result = UpdatePersonaSchema.safeParse({ name: 'Updated' })
    assert.strictEqual(result.success, false)
  })

  it('ArchivePersonaSchema accepts id', () => {
    const result = ArchivePersonaSchema.safeParse({ id: 'uuid-123' })
    assert.strictEqual(result.success, true)
  })

  it('ArchivePersonaSchema rejects empty id', () => {
    const result = ArchivePersonaSchema.safeParse({ id: '' })
    assert.strictEqual(result.success, false)
  })

  it('LaunchPersonaSchema accepts id with optional overrides', () => {
    const result = LaunchPersonaSchema.safeParse({
      id: 'uuid-123',
      projectId: 'proj-1',
      daemonId: 'daemon-1',
      cols: 80,
      rows: 24,
    })
    assert.strictEqual(result.success, true)
  })

  it('LaunchPersonaSchema rejects empty id', () => {
    const result = LaunchPersonaSchema.safeParse({ id: '' })
    assert.strictEqual(result.success, false)
  })
})
