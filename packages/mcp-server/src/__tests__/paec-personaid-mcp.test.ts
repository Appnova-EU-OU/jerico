/**
 * Unit tests — PAEC P1-2 MCP layer
 *
 * Covers:
 *   - getProjectEvents() forwards personaId as query param when provided
 *   - getProjectEvents() omits personaId param when not provided
 *   - request() includes X-Bridge-Panel-Id header when ctx.agentId is set (A6)
 *   - request() omits X-Bridge-Panel-Id when ctx.agentId is absent
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

const BASE_CTX = {
  serverUrl:   'http://localhost:3000',
  token:       'test-token',
  workspaceId: 'ws-test',
  projectId:   'proj-test',
}

function captureRequest(): { captured: { url: string; init: RequestInit | undefined }[]; fetch: typeof globalThis.fetch } {
  const captured: { url: string; init: RequestInit | undefined }[] = []
  const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), init })
    return {
      ok:   true,
      status: 200,
      json: async () => ({ events: [] }),
    } as unknown as Response
  }
  return { captured, fetch: mockFetch as unknown as typeof globalThis.fetch }
}

describe('getProjectEvents — personaId query param (P1-2)', () => {
  it('forwards personaId as query param when provided', async () => {
    const { getProjectEvents } = await import('../api.js')
    const { captured, fetch: mockFetch } = captureRequest()
    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = mockFetch
      await getProjectEvents(BASE_CTX, { personaId: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff' })
      assert.ok(captured.length === 1, 'expected one fetch call')
      const url = captured[0]!.url
      assert.ok(url.includes('personaId=aaaabbbb'), `expected personaId in URL, got: ${url}`)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('omits personaId param when not provided', async () => {
    const { getProjectEvents } = await import('../api.js')
    const { captured, fetch: mockFetch } = captureRequest()
    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = mockFetch
      await getProjectEvents(BASE_CTX, { eventType: 'decision' })
      assert.ok(captured.length === 1, 'expected one fetch call')
      const url = captured[0]!.url
      assert.ok(!url.includes('personaId'), `personaId should not appear in URL, got: ${url}`)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('omits personaId param when opts is undefined', async () => {
    const { getProjectEvents } = await import('../api.js')
    const { captured, fetch: mockFetch } = captureRequest()
    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = mockFetch
      await getProjectEvents(BASE_CTX)
      assert.ok(captured.length === 1, 'expected one fetch call')
      const url = captured[0]!.url
      assert.ok(!url.includes('personaId'), `personaId should not appear in URL, got: ${url}`)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('request() — X-Bridge-Panel-Id header (A6)', () => {
  it('includes X-Bridge-Panel-Id when ctx.agentId is set', async () => {
    const { request } = await import('../api.js')
    const { captured, fetch: mockFetch } = captureRequest()
    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = mockFetch
      const ctx = { ...BASE_CTX, agentId: 'panel-abc-123' }
      await request(ctx, 'GET', 'http://localhost:3000/api/workspaces/ws-test/projects/proj-test/events')
      assert.ok(captured.length === 1, 'expected one fetch call')
      const headers = captured[0]!.init?.headers as Record<string, string> | undefined
      assert.ok(headers, 'expected headers object')
      assert.strictEqual(headers['X-Bridge-Panel-Id'], 'panel-abc-123')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('omits X-Bridge-Panel-Id when ctx.agentId is absent', async () => {
    const { request } = await import('../api.js')
    const { captured, fetch: mockFetch } = captureRequest()
    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = mockFetch
      await request(BASE_CTX, 'GET', 'http://localhost:3000/api/workspaces/ws-test/projects/proj-test/events')
      assert.ok(captured.length === 1, 'expected one fetch call')
      const headers = captured[0]!.init?.headers as Record<string, string> | undefined
      assert.ok(!headers?.['X-Bridge-Panel-Id'], `X-Bridge-Panel-Id should be absent, got: ${headers?.['X-Bridge-Panel-Id']}`)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
