import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { authorizeEventsRequest, subscriberIdFor } from '../events/route.js'
import { HEADER_TOKEN, HEADER_PROTOCOL, HEADER_PROTOCOL_VERSION, HEADER_AGENT_ID, HEADER_INSTANCE_ID, HEADER_EVENT_TOKEN } from '../hooks/protocol.js'
import { HOOK_PROTOCOL, EVENTS_PROTOCOL_VERSION } from '../hooks/protocol.js'
import { dispatchDaemonHttpRequest } from '../commands/http-dispatch.js'
import { OrchestratorEventBroker } from '../events/broker.js'
import { OrchestratorEventPoller } from '../events/poller.js'
import { EVENTS_ROUTE_PATH, clampPollWait } from '../events/route.js'

const TOKEN = 'a'.repeat(64)
const VICTIM_AGENT = 'victim-panel-123'
const ATTACKER_AGENT = 'attacker-panel-999'
const INSTANCE = 1

describe('616 Fix 2 - per-panel token binding (real handler + production wiring)', () => {
  test('cross-panel poll without victim token is rejected 403 (helper)', () => {
    const victimToken = 'victim-secret-token-xyz'.repeat(2)
    const attackerToken = 'attacker-secret-token-abc'.repeat(2)
    const isLive = (agentId: string, instanceId: number) => true
    const getPanelEventToken = (agentId: string, instanceId: number) => {
      if (agentId === VICTIM_AGENT && instanceId === INSTANCE) return victimToken
      if (agentId === ATTACKER_AGENT && instanceId === INSTANCE) return attackerToken
      return undefined
    }

    const attackerHeadersWithVictimIdentity = {
      [HEADER_TOKEN]: TOKEN,
      [HEADER_PROTOCOL]: HOOK_PROTOCOL,
      [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
      [HEADER_AGENT_ID]: VICTIM_AGENT,
      [HEADER_INSTANCE_ID]: String(INSTANCE),
      [HEADER_EVENT_TOKEN]: attackerToken,
    }
    const result = authorizeEventsRequest(attackerHeadersWithVictimIdentity, TOKEN, isLive, getPanelEventToken)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)

    const victimHeaders = {
      [HEADER_TOKEN]: TOKEN,
      [HEADER_PROTOCOL]: HOOK_PROTOCOL,
      [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
      [HEADER_AGENT_ID]: VICTIM_AGENT,
      [HEADER_INSTANCE_ID]: String(INSTANCE),
      [HEADER_EVENT_TOKEN]: victimToken,
    }
    const victimResult = authorizeEventsRequest(victimHeaders, TOKEN, isLive, getPanelEventToken)
    expect(victimResult.ok).toBe(true)
  })

  test('cross-panel ACK also rejected', () => {
    const victimToken = 'victim-token-1234567890abc'.repeat(2)
    const isLive = () => true
    const getToken = (agentId: string, iid: number) => agentId === VICTIM_AGENT ? victimToken : 'other-token-x'
    const attackerHeaders = {
      [HEADER_TOKEN]: TOKEN,
      [HEADER_PROTOCOL]: HOOK_PROTOCOL,
      [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
      [HEADER_AGENT_ID]: VICTIM_AGENT,
      [HEADER_INSTANCE_ID]: String(INSTANCE),
      [HEADER_EVENT_TOKEN]: 'wrong-token',
    }
    const res = authorizeEventsRequest(attackerHeaders, TOKEN, isLive, getToken)
    expect(res.ok).toBe(false)
    expect((res as { status: number }).status).toBe(403)
  })

  test('existing panel_instance binding (409) preserved', () => {
    const isLive = (agentId: string, iid: number) => false
    const getToken = () => 'any-token'
    const headers = {
      [HEADER_TOKEN]: TOKEN,
      [HEADER_PROTOCOL]: HOOK_PROTOCOL,
      [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
      [HEADER_AGENT_ID]: VICTIM_AGENT,
      [HEADER_INSTANCE_ID]: String(INSTANCE),
      [HEADER_EVENT_TOKEN]: 'any-token',
    }
    const res = authorizeEventsRequest(headers, TOKEN, isLive, getToken)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(409)
  })

  test('own panel with correct token still succeeds', () => {
    const token = 'my-panel-token-12345'.repeat(3)
    const isLive = () => true
    const getToken = () => token
    const headers = {
      [HEADER_TOKEN]: TOKEN,
      [HEADER_PROTOCOL]: HOOK_PROTOCOL,
      [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
      [HEADER_AGENT_ID]: VICTIM_AGENT,
      [HEADER_INSTANCE_ID]: String(INSTANCE),
      [HEADER_EVENT_TOKEN]: token,
    }
    const res = authorizeEventsRequest(headers, TOKEN, isLive, getToken)
    expect(res.ok).toBe(true)
  })

  test('production handler: attacker cannot poll victim stream over real HTTP', async () => {
    // This drives the REAL production handler factory — not a test-only copy.
    // If start.ts forgot the resolver, the factory would also miss it and answer 200.
    const { createOrchestratorEventsHandler } = await import('../events/orchestrator-handler.js')
    const broker = new OrchestratorEventBroker()
    const poller = new OrchestratorEventPoller(broker)
    const leases = new Map<string, symbol>()
    const victimToken = 'victim-real-token-aaa'.repeat(4)
    const attackerToken = 'attacker-real-token-bbb'.repeat(4)

    // Mock manager's per-panel token store — same shape as pty/manager.ts
    const tokenStore = new Map<string, string>()
    tokenStore.set(subscriberIdFor(VICTIM_AGENT, INSTANCE), victimToken)
    tokenStore.set(subscriberIdFor(ATTACKER_AGENT, INSTANCE), attackerToken)
    const getPanelEventToken = (agentId: string, iid: number) => tokenStore.get(subscriberIdFor(agentId, iid))
    const isLive = () => true

    const handler = createOrchestratorEventsHandler({
      hookToken: TOKEN,
      isPanelLive: isLive,
      getPanelEventToken,
      broker,
      poller,
      leases,
    })

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (handler(req, res, url)) return
      const route = dispatchDaemonHttpRequest(req, res, (_q, r) => { r.writeHead(422); r.end() }, 'http://127.0.0.1')
      if (route.handled) return
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    })
    await new Promise<void>((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r) })
    const addr = server.address() as { port: number }
    const base = `http://127.0.0.1:${addr.port}`

    // Victim primes subscription
    const victimHeaders = {
      [HEADER_TOKEN]: TOKEN,
      [HEADER_PROTOCOL]: HOOK_PROTOCOL,
      [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
      [HEADER_AGENT_ID]: VICTIM_AGENT,
      [HEADER_INSTANCE_ID]: String(INSTANCE),
      [HEADER_EVENT_TOKEN]: victimToken,
    }
    const victimPrime = await fetch(`${base}${EVENTS_ROUTE_PATH}?waitMs=1000`, { method: 'POST', headers: victimHeaders })
    expect(victimPrime.status).toBe(200)

    // Attacker forges victim identity but only has own token — must be 403
    const attackerHeaders = {
      [HEADER_TOKEN]: TOKEN,
      [HEADER_PROTOCOL]: HOOK_PROTOCOL,
      [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
      [HEADER_AGENT_ID]: VICTIM_AGENT,
      [HEADER_INSTANCE_ID]: String(INSTANCE),
      [HEADER_EVENT_TOKEN]: attackerToken,
    }
    const attackerRes = await fetch(`${base}${EVENTS_ROUTE_PATH}?waitMs=1000`, { method: 'POST', headers: attackerHeaders })
    expect(attackerRes.status).toBe(403)
    expect((await attackerRes.json() as { error: string }).error).toBe('invalid_token')

    await new Promise<void>((r, j) => server.close(e => e ? j(e) : r()))
  })

  test('production wiring: start.ts delegates to the real handler factory with both resolvers', () => {
    const src = readFileSync(new URL('../commands/start.ts', import.meta.url), 'utf8')
    expect(src).toContain('createOrchestratorEventsHandler')
    expect(src).toContain('getPanelEventToken')
    expect(src).toContain('getPanelInstanceId')
    // Find the CALL site (with `({`), not the import line
    const factoryIdx = src.indexOf('createOrchestratorEventsHandler({')
    expect(factoryIdx).toBeGreaterThan(-1)
    const around = src.slice(factoryIdx, factoryIdx + 800)
    expect(around).toContain('isPanelLive')
    expect(around).toContain('getPanelEventToken')
    expect(around).toContain('getPanelInstanceId')
    // The handler module itself must enforce per-panel token binding
    const handlerSrc = readFileSync(new URL('../events/orchestrator-handler.ts', import.meta.url), 'utf8')
    expect(handlerSrc).toContain('authorizeEventsRequest')
    expect(handlerSrc).toContain('getPanelEventToken')
  })
})
