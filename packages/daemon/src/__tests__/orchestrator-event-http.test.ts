/**
 * #616 slice 2 — the events surface over a REAL loopback HTTP server.
 *
 * Every other test in this slice is a pure state machine over injected IO, which
 * is the right shape for logic but proves nothing about the wiring. This one
 * stands up an actual server and speaks to it with fetch, because the defect
 * class this repo hits most often is a mechanism that exists and works while the
 * caller's real path never reaches it.
 *
 * The health fallback below is deliberately plausible: if an events request ever
 * falls through the router again, these assertions must fail rather than see a
 * health-shaped 200 and pass.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { dispatchDaemonHttpRequest } from '../commands/http-dispatch.js'
import { OrchestratorEventBroker } from '../events/broker.js'
import { OrchestratorEventPoller } from '../events/poller.js'
import {
  EVENTS_ROUTE_PATH,
  EVENTS_ACK_PATH,
  authorizeEventsRequest,
  clampPollWait,
  subscriberIdFor,
} from '../events/route.js'
import {
  HOOK_PROTOCOL,
  EVENTS_PROTOCOL_VERSION,
  HEADER_TOKEN,
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_VERSION,
  HEADER_AGENT_ID,
  HEADER_INSTANCE_ID,
  HEADER_EVENT_TOKEN,
} from '../hooks/protocol.js'

const TOKEN = 'c'.repeat(64)
const EVENT_TOKEN = 'e'.repeat(64)
const AGENT = 'panel-http'
const INST  = 7

let server: Server | null = null

afterEach(async () => {
  const current = server
  server = null
  if (current) await new Promise<void>((r, j) => current.close(e => e ? j(e) : r()))
})

interface Stand {
  base: string
  broker: OrchestratorEventBroker
  poller: OrchestratorEventPoller
}

async function standUp(opts: { wireEvents?: boolean; panelLive?: boolean } = {}): Promise<Stand> {
  const wireEvents = opts.wireEvents ?? true
  const panelLive  = opts.panelLive ?? true
  const broker = new OrchestratorEventBroker()
  const poller = new OrchestratorEventPoller(broker)

  const handler = (req: Parameters<typeof dispatchDaemonHttpRequest>[0], res: Parameters<typeof dispatchDaemonHttpRequest>[1], url: URL) => {
    const auth = authorizeEventsRequest(req.headers, TOKEN, () => panelLive, () => EVENT_TOKEN)
    if (!auth.ok) {
      req.resume()
      res.writeHead(auth.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: auth.error }))
      return
    }
    const sub = subscriberIdFor(auth.agentId, auth.instanceId)
    const leaseHolder = leases.get(sub)
    req.resume()

    if (url.pathname === EVENTS_ACK_PATH) {
      const through = Number.parseInt(url.searchParams.get('through') ?? '', 10)
      const ok = leaseHolder ? poller.ack(sub, leaseHolder, through) : false
      res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok }))
      return
    }

    const waitMs = clampPollWait(url.searchParams.get('waitMs'), 1_000)
    const lease  = leaseHolder ?? broker.attach(sub).lease
    leases.set(sub, lease)
    void poller.poll(sub, lease, waitMs).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    })
  }

  const leases = new Map<string, symbol>()

  server = createServer((req, res) => {
    const route = dispatchDaemonHttpRequest(
      req, res,
      (_q, r) => { r.writeHead(422); r.end() },
      'http://127.0.0.1',
      wireEvents ? handler : undefined,
    )
    if (route.handled) return
    // Plausible health fallback — see the file comment.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', healthReady: true }))
  })
  await new Promise<void>((r, j) => { server!.once('error', j); server!.listen(0, '127.0.0.1', r) })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { base: `http://127.0.0.1:${port}`, broker, poller }
}

const authHeaders = (over: Record<string, string> = {}) => ({
  [HEADER_TOKEN]: TOKEN,
  [HEADER_PROTOCOL]: HOOK_PROTOCOL,
  [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
  [HEADER_AGENT_ID]: AGENT,
  [HEADER_INSTANCE_ID]: String(INST),
  [HEADER_EVENT_TOKEN]: EVENT_TOKEN,
  ...over,
})

describe('#616 events surface over real HTTP', () => {
  test('a published record reaches a real HTTP client', async () => {
    const s = await standUp()
    const sub = subscriberIdFor(AGENT, INST)

    // Prime the subscription the way a first poll would, then publish.
    const first = await fetch(`${s.base}${EVENTS_ROUTE_PATH}?waitMs=1000`, { method: 'POST', headers: authHeaders() })
    expect(first.status).toBe(200)

    s.poller.publish(sub, {
      watchId: 'w1', idempotencyKey: 'k1', kind: 'worker.advisory',
      payload: '[BRIDGE-ORCH] hello',
    })

    const res  = await fetch(`${s.base}${EVENTS_ROUTE_PATH}?waitMs=1000`, { method: 'POST', headers: authHeaders() })
    const body = await res.json() as { records: Array<{ type: string; payload?: string }>; throughSeq: number | null }
    expect(res.status).toBe(200)
    expect(body.records.some(r => r.type === 'event' && r.payload === '[BRIDGE-ORCH] hello')).toBe(true)
    expect(body.throughSeq).toBe(1)
  })

  test('an unauthenticated poll is refused by the surface, not answered by health', async () => {
    const s = await standUp()
    const res = await fetch(`${s.base}${EVENTS_ROUTE_PATH}`, {
      method: 'POST', headers: authHeaders({ [HEADER_TOKEN]: 'd'.repeat(64) }),
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { error?: string; status?: string }
    expect(body.error).toBe('invalid_token')
    expect(body.status).toBeUndefined()   // did NOT reach the health fallback
  })

  test('a dead panel instance is refused at the surface', async () => {
    const s = await standUp({ panelLive: false })
    const res = await fetch(`${s.base}${EVENTS_ROUTE_PATH}`, { method: 'POST', headers: authHeaders() })
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('panel_gone')
  })

  test('an unwired daemon 404s the path instead of answering something plausible', async () => {
    const s = await standUp({ wireEvents: false })
    const res = await fetch(`${s.base}${EVENTS_ROUTE_PATH}`, { method: 'POST', headers: authHeaders() })
    expect(res.status).toBe(404)
    const body = await res.json() as { error?: string; status?: string }
    expect(body.error).toBe('not_found')
    expect(body.status).toBeUndefined()
  })

  test('GET on the events path is refused outright, not answered by health', async () => {
    const s = await standUp()
    const res = await fetch(`${s.base}${EVENTS_ROUTE_PATH}`, { method: 'GET', headers: authHeaders() })

    // I expected this to fall through to the health fallback and it does not:
    // the router's catch-all refuses any unrecognised method/path pair, so a GET
    // on the events path is a 404 rather than a plausible 200. That is stronger
    // than the behaviour I wrote the test for, and it is the router's stated
    // reason for existing — an unknown pair must never look like health.
    expect(res.status).toBe(404)
    const body = await res.json() as { error?: string; status?: string }
    expect(body.error).toBe('not_found')
    expect(body.status).toBeUndefined()
  })

  test('an idle poll returns quickly and carries nothing to print', async () => {
    const s = await standUp()
    const started = Date.now()
    const res = await fetch(`${s.base}${EVENTS_ROUTE_PATH}?waitMs=1000`, { method: 'POST', headers: authHeaders() })
    const body = await res.json() as { records: unknown[]; idle: boolean }
    expect(body.records).toEqual([])
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('acknowledging over HTTP stops re-delivery', async () => {
    const s = await standUp()
    const sub = subscriberIdFor(AGENT, INST)
    await fetch(`${s.base}${EVENTS_ROUTE_PATH}?waitMs=1000`, { method: 'POST', headers: authHeaders() })

    s.poller.publish(sub, { watchId: 'w1', idempotencyKey: 'k1', kind: 'k', payload: 'p1' })
    const before = await (await fetch(`${s.base}${EVENTS_ROUTE_PATH}?waitMs=1000`, { method: 'POST', headers: authHeaders() })).json() as { records: unknown[] }
    expect(before.records.length).toBeGreaterThan(0)

    const ack = await fetch(`${s.base}${EVENTS_ACK_PATH}?through=1`, { method: 'POST', headers: authHeaders() })
    expect(ack.status).toBe(200)

    const after = await (await fetch(`${s.base}${EVENTS_ROUTE_PATH}?waitMs=1000`, { method: 'POST', headers: authHeaders() })).json() as { records: unknown[] }
    expect(after.records).toEqual([])
  })
})
