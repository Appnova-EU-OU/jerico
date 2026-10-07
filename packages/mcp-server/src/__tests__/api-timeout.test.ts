/**
 * Tests for api.ts request() AbortController timeout (G3 — Issue #269)
 * Validates that HTTP calls to the Bridge API respect the configurable
 * timeout and throw a descriptive error on timeout.
 * Uses node:test (same as personas-tools.test.ts) for bun compatibility.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

function makeTimeoutFetch(abortAfterMs: number) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined
    if (!signal) return new Promise(() => {})
    await new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), abortAfterMs)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      })
    })
    throw new Error('unreachable')
  }
}

describe('api.ts request() timeout', () => {
  it('request() throws on slow server after timeout', async () => {
    const mod = await import('../api.js')
    const { request } = mod

    const ctx = {
      serverUrl: 'http://localhost:3000',
      token: 'test-token',
      workspaceId: 'ws-test',
      projectId: 'proj-test',
    }

    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = makeTimeoutFetch(100) as unknown as typeof globalThis.fetch

      let err: unknown
      await request(ctx, 'GET', 'http://localhost:3000/api/workspaces/ws-test/projects/proj-test/todos', undefined, { timeoutMs: 100 }).then(v => v, e => { err = e; throw e }).catch(e => { err = e; throw e })
      assert.fail('expected rejection')
    } catch (e) {
      const msg = (e as Error).message
      assert.ok(msg.includes('timed out') || msg.includes('100ms'), `Expected timeout message, got: ${msg}`)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('request() accepts custom timeoutMs option', async () => {
    const mod = await import('../api.js')
    const { request } = mod

    const ctx = {
      serverUrl: 'http://localhost:3000',
      token: 'test-token',
      workspaceId: 'ws-test',
      projectId: 'proj-test',
    }

    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = makeTimeoutFetch(50) as unknown as typeof globalThis.fetch

      let err: unknown
      await request(ctx, 'GET', 'http://localhost:3000/api/workspaces/ws-test/projects/proj-test/todos', undefined, { timeoutMs: 50 }).then(v => v, e => { err = e; throw e }).catch(e => { err = e; throw e })
      assert.fail('expected rejection')
    } catch (e) {
      const msg = (e as Error).message
      assert.ok(msg.includes('timed out') || msg.includes('50ms'), `Expected timeout message, got: ${msg}`)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('request() throws on HTTP error with descriptive message', async () => {
    const mod = await import('../api.js')
    const { request } = mod

    const ctx = {
      serverUrl: 'http://localhost:3000',
      token: 'bad-token',
      workspaceId: 'ws-test',
      projectId: 'proj-test',
    }

    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = async () =>
        ({
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: 'Unauthorized' }),
        }) as unknown as Response

      let err: unknown
      await request(ctx, 'GET', 'http://localhost:3000/api/workspaces/ws-test/projects/proj-test/todos').then(v => v, e => { err = e; throw e }).catch(e => { err = e; throw e })
      assert.fail('expected rejection')
    } catch (e) {
      const msg = (e as Error).message
      assert.ok(msg.includes('Unauthorized') || msg.includes('401'), `Expected error message, got: ${msg}`)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('request() returns parsed JSON on success', async () => {
    const mockData = { todos: [], session: null }
    const mod = await import('../api.js')
    const { request } = mod

    const ctx = {
      serverUrl: 'http://localhost:3000',
      token: 'good-token',
      workspaceId: 'ws-test',
      projectId: 'proj-test',
    }

    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => mockData,
        }) as unknown as Response

      const result = await request<typeof mockData>(ctx, 'GET', 'http://localhost:3000/api/workspaces/ws-test/projects/proj-test/todos')
      assert.deepStrictEqual(result, mockData)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('request() propagates non-timeout errors through', async () => {
    const mod = await import('../api.js')
    const { request } = mod

    const ctx = {
      serverUrl: 'http://localhost:3000',
      token: 'test-token',
      workspaceId: 'ws-test',
      projectId: 'proj-test',
    }

    const origFetch = globalThis.fetch
    try {
      const throwNetworkError = () => { throw new Error('network error') }
      globalThis.fetch = throwNetworkError as unknown as typeof globalThis.fetch

      let err: unknown
      await request(ctx, 'GET', 'http://localhost:3000/api/workspaces/ws-test/projects/proj-test/todos').then(v => v, e => { err = e; throw e }).catch(e => { err = e; throw e })
      assert.fail('expected rejection')
    } catch (e) {
      const msg = (e as Error).message
      assert.ok(msg.includes('network error'), `Expected network error, got: ${msg}`)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('killAgent() uses request() helper and respects timeout', async () => {
    const { killAgent } = await import('../api.js')

    const ctx = {
      serverUrl: 'http://localhost:3000',
      token: 'test-token',
      workspaceId: 'ws-test',
      projectId: 'proj-test',
    }

    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = makeTimeoutFetch(80) as unknown as typeof globalThis.fetch

      let err: unknown
      await killAgent(ctx, 'agent-123').then(v => v, e => { err = e; throw e }).catch(e => { err = e; throw e })
      assert.fail('expected rejection')
    } catch (e) {
      const msg = (e as Error).message
      assert.ok(msg.includes('timed out') || msg.includes('80ms'), `Expected timeout message, got: ${msg}`)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})