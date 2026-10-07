import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { dispatchDaemonHttpRequest } from '../commands/http-dispatch.js'
import { HOOK_ROUTE_PATH } from '../hooks/protocol.js'

let server: Server | null = null

afterEach(async () => {
  const current = server
  server = null
  if (current) await new Promise<void>((resolve, reject) => current.close(err => err ? reject(err) : resolve()))
})

async function standUpDispatcher(): Promise<string> {
  server = createServer((req, res) => {
    const route = dispatchDaemonHttpRequest(req, res, (_hookReq, hookRes) => {
      hookRes.writeHead(422, { 'Content-Type': 'application/json' })
      hookRes.end(JSON.stringify({ error: 'hook_handler_reached' }))
    })
    if (route.handled) return

    // Deliberately plausible health fallback: the three assertions below must
    // fail if an unsupported hook request can ever reach this branch again.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', healthReady: true }))
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  return `http://127.0.0.1:${address.port}`
}

async function jsonRequest(base: string, path: string, method: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, { method })
  return { status: response.status, body: await response.json() }
}

describe('daemon hook HTTP dispatch fallthrough guard', () => {
  test('unknown hook path is JSON 404, never the health body', async () => {
    const base = await standUpDispatcher()
    const response = await jsonRequest(base, `${HOOK_ROUTE_PATH}/nope`, 'POST')
    expect(response).toEqual({ status: 404, body: { error: 'not_found' } })
  })

  test('GET on the hook route is JSON 404, never the health body', async () => {
    const base = await standUpDispatcher()
    const response = await jsonRequest(base, HOOK_ROUTE_PATH, 'GET')
    expect(response).toEqual({ status: 404, body: { error: 'not_found' } })
  })

  test('query string preserves the hook pathname and reaches hook validation', async () => {
    const base = await standUpDispatcher()
    const response = await jsonRequest(base, `${HOOK_ROUTE_PATH}?x=1`, 'POST')
    expect(response).toEqual({ status: 422, body: { error: 'hook_handler_reached' } })
    expect(response.body).not.toEqual({ status: 'ok', healthReady: true })
  })
})
