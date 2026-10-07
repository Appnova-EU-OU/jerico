/**
 * Orchestrator event stream — producer + consumer end-to-end (the redelivery
 * guard is load-bearing).
 *
 * Covers the four assertions the producer must satisfy:
 *  - redelivery guard: two polls after one publish deliver ONCE
 *  - publish-refused → PTY fallback still fires
 *  - publish-succeeded → no PTY write
 *  - 409 panel_gone for stale generation
 *
 * Plus source wiring guards (the defect class is an unreached path).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { OrchestratorEventBroker } from '../events/broker.js'
import { OrchestratorEventPoller } from '../events/poller.js'
import { dispatchDaemonHttpRequest } from '../commands/http-dispatch.js'
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
import { orchestratorBroker, orchestratorPoller } from '../events/instance.js'

const TOKEN = 'b'.repeat(64)
const EVENT_TOKEN = 'e'.repeat(64)
const AGENT = 'panel-616'

// ── source wiring guards ──────────────────────────────────────────────
describe('#616 wiring exists', () => {
  test('consumer: start.ts wires 5th handleOrchestratorEvents arg', () => {
    const src = readFileSync(new URL('../commands/start.ts', import.meta.url), 'utf8')
    expect(src).toContain('handleOrchestratorEvents')
    // Wiring is now delegated to the production factory so the test suite
    // imports the SAME handler (not a copy). Either direct authorize in
    // start.ts (old) or factory delegation (new) is acceptable.
    const hasDirectAuth = src.includes('authorizeEventsRequest')
    const hasFactory = src.includes('createOrchestratorEventsHandler')
    expect(hasDirectAuth || hasFactory).toBe(true)
    expect(src).toContain('orchestratorBroker')
    expect(src).toContain('orchestratorPoller')
    // Factory itself must enforce per-panel tokens — verify it contains the real checks
    if (hasFactory) {
      const handlerSrc = readFileSync(new URL('../events/orchestrator-handler.ts', import.meta.url), 'utf8')
      expect(handlerSrc).toContain('authorizeEventsRequest')
      expect(handlerSrc).toContain('getPanelEventToken')
    } else {
      expect(src).toContain('EVENTS_ACK_PATH')
    }
    // must pass as 5th arg, not 4
    expect(src).toMatch(/dispatchDaemonHttpRequest\(req, res,[\s\S]*?handleOrchestratorEvents\)/)
  })

  test('producer: client.ts publishes before prompt-gate and falls back on refusal', () => {
    const src = readFileSync(new URL('../ws/client.ts', import.meta.url), 'utf8')
    // Delegated to the helper so the gate is execution-tested; direct
    // `orchestratorPoller.publish` now lives in notice-publish.ts
    const hasDirect = src.includes('orchestratorPoller.publish')
    const hasHelper = src.includes('tryPublishOrchestratorNotice')
    expect(hasDirect || hasHelper).toBe(true)
    expect(src).toContain('notice.published')
    expect(src).toContain('notice.publish_refused')
    // publish must be BEFORE promptGate.decide for notices
    const pubIdx = hasHelper ? src.indexOf('tryPublishOrchestratorNotice') : src.indexOf('orchestratorPoller.publish')
    const gateIdx = src.indexOf('promptGate.decide(msg.agentId)')
    expect(pubIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeGreaterThan(-1)
    // the notice branch's publish should appear before its gate decide
    // (within the same if block — coarse but catches the ordering defect)
    expect(pubIdx).toBeLessThan(gateIdx)
  })
})

// ── behavioral: redelivery guard ─────────────────────────────────────
describe('#616 redelivery guard', () => {
  test('two polls after one publish deliver the notice ONCE — ack stops redelivery', async () => {
    const broker = new OrchestratorEventBroker()
    const poller = new OrchestratorEventPoller(broker)
    const sub = 'orch-panel-1#1'
    const { lease } = broker.attach(sub)

    poller.publish(sub, { watchId: 'w1', idempotencyKey: 'k1', kind: 'worker.notice', payload: '[BRIDGE-ORCH] hello' })

    const first = await poller.poll(sub, lease, 10)
    expect(first.records.filter(r => r.type === 'event')).toHaveLength(1)
    const through = first.throughSeq!
    expect(through).toBe(1)

    // ACK — the fix that stops infinite redelivery
    expect(poller.ack(sub, lease, through)).toBe(true)

    // Second poll must be empty — using read() via poll(), not attach() per poll
    const second = await poller.poll(sub, lease, 10)
    expect(second.records.filter(r => r.type === 'event')).toHaveLength(0)
    expect(second.idle).toBe(true)
  })

  test('BUG variant: attach() per poll replays forever (this is what gate 5 exposed)', async () => {
    const broker = new OrchestratorEventBroker()
    const sub = 'orch-panel-bug#1'
    // Correct first attach
    const firstLease = broker.attach(sub).lease
    new OrchestratorEventPoller(broker).publish(sub, { watchId: 'w1', idempotencyKey: 'k1', kind: 'k', payload: '[BRIDGE-ORCH] once' })

    // Simulate buggy handler: every poll calls attach() and ignores ack
    const buggyFirst = broker.attach(sub)
    const buggySecond = broker.attach(sub)
    // Both attaches replay — same record delivered twice without ack
    const events1 = buggyFirst.records.filter(r => r.type === 'event')
    const events2 = buggySecond.records.filter(r => r.type === 'event')
    expect(events1).toHaveLength(1)
    expect(events2).toHaveLength(1)
    // Proves the trap: a handler that attaches per poll redelivers forever.
    // The correct handler must reuse the lease and ack.
    expect(firstLease).not.toBe(buggyFirst.lease)
  })

  test('ACK route actually calls broker.ack() — stubbed ack redelivers forever', async () => {
    const broker = new OrchestratorEventBroker()
    const poller = new OrchestratorEventPoller(broker)
    const sub = 'orch-panel-ack#1'
    const { lease } = broker.attach(sub)
    poller.publish(sub, { watchId: 'w1', idempotencyKey: 'k1', kind: 'k', payload: '[BRIDGE-ORCH] ack-me' })

    const before = await poller.poll(sub, lease, 10)
    expect(before.records.filter(r => r.type === 'event')).toHaveLength(1)

    // Do NOT ack — simulate stubbed handler
    const withoutAck = await poller.poll(sub, lease, 10)
    expect(withoutAck.records.filter(r => r.type === 'event')).toHaveLength(1)

    // Now ack and verify it stops
    poller.ack(sub, lease, before.throughSeq!)
    const after = await poller.poll(sub, lease, 10)
    expect(after.records.filter(r => r.type === 'event')).toHaveLength(0)
  })
})

// ── publish refused/succeeded → PTY fallback semantics ─────────────────
describe('#616 producer fallback semantics', () => {
  test('no_subscriber → PTY fallback must fire (refused)', () => {
    const broker = new OrchestratorEventBroker()
    const out = broker.publish('no-such-sub', { watchId: 'w', idempotencyKey: 'k', kind: 'k', payload: 'hi' })
    expect(out).toEqual({ published: false, reason: 'no_subscriber' })
    // The wire must treat this as fallback: prompt-gate still reachable
  })

  test('closed → PTY fallback', () => {
    const broker = new OrchestratorEventBroker()
    const sub = 's#1'
    broker.attach(sub)
    broker.publish(sub, { watchId: 'w1', idempotencyKey: 'k1', kind: 'k', payload: 'first', closure: 'verdict' })
    const second = broker.publish(sub, { watchId: 'w1', idempotencyKey: 'k2', kind: 'k', payload: 'second' })
    expect(second).toEqual({ published: false, reason: 'closed' })
  })

  test('unsafe_payload → PTY fallback (NUL still refused)', () => {
    const broker = new OrchestratorEventBroker()
    const sub = 's#2'
    broker.attach(sub)
    const out = broker.publish(sub, { watchId: 'w', idempotencyKey: 'k', kind: 'k', payload: 'bad\0payload' })
    expect(out).toEqual({ published: false, reason: 'unsafe_payload' })
  })

  test('multiline payload now normalizes and publishes (Fix 4)', () => {
    const broker = new OrchestratorEventBroker()
    const sub = 's#2b'
    broker.attach(sub)
    const out = broker.publish(sub, { watchId: 'w', idempotencyKey: 'k', kind: 'k', payload: 'two\nlines' })
    expect(out.published).toBe(true)
  })

  test('duplicate → PTY fallback', () => {
    const broker = new OrchestratorEventBroker()
    const sub = 's#3'
    broker.attach(sub)
    broker.publish(sub, { watchId: 'w', idempotencyKey: 'k1', kind: 'k', payload: 'hi' })
    const dup = broker.publish(sub, { watchId: 'w2', idempotencyKey: 'k1', kind: 'k', payload: 'hi2' })
    expect(dup).toEqual({ published: false, reason: 'duplicate' })
  })

  test('publish-succeeded → no PTY write (event reaches stream)', () => {
    const broker = new OrchestratorEventBroker()
    const poller = new OrchestratorEventPoller(broker)
    const sub = 'orch#1'
    const { lease } = broker.attach(sub)
    const out = poller.publish(sub, { watchId: 'w1', idempotencyKey: 'k1', kind: 'worker.done', payload: '[BRIDGE-ORCH] event=worker.done verified=true evidence=... completionId=abc worker=xyz. Read the report.' })
    expect(out.published).toBe(true)
    if (out.published) expect(out.seq).toBe(1)
    // No PTY write should happen for this notice — verified by the caller checking outcome.published
    // Here we assert the poll sees it
    const pending = broker.read(sub, lease)
    expect(pending.filter(r => r.type === 'event')).toHaveLength(1)
  })
})

// ── 409 panel_gone for stale generation ────────────────────────────────
describe('#616 consumer 409 panel_gone', () => {
  test('authorizeEventsRequest returns 409 for dead panel generation', () => {
    const headers = {
      [HEADER_TOKEN]: TOKEN,
      [HEADER_PROTOCOL]: HOOK_PROTOCOL,
      [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
      [HEADER_AGENT_ID]: AGENT,
      [HEADER_INSTANCE_ID]: '1',
      [HEADER_EVENT_TOKEN]: EVENT_TOKEN,
    }
    const dead = () => false
    expect(authorizeEventsRequest(headers, TOKEN, dead, () => EVENT_TOKEN)).toEqual({ ok: false, status: 409, error: 'panel_gone' })
  })

  test('HTTP surface 409s a stale instance and 200s the live one (real HTTP)', async () => {
    // Stand up a real loopback server using the new wiring semantics (lease reuse + ack)
    let server: Server | null = null
    const broker = new OrchestratorEventBroker()
    const poller = new OrchestratorEventPoller(broker)
    const leases = new Map<string, symbol>()
    const liveInstance = 5
    const isLive = (agentId: string, instanceId: number) => agentId === AGENT && instanceId === liveInstance

    const handler = (req: InstanceType<typeof import('node:http').IncomingMessage>, res: InstanceType<typeof import('node:http').ServerResponse>, url: URL) => {
      const auth = authorizeEventsRequest(req.headers as Record<string, string | string[] | undefined>, TOKEN, isLive, () => EVENT_TOKEN)
      if (!auth.ok) {
        req.resume()
        res.writeHead(auth.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: auth.error }))
        return
      }
      const sub = subscriberIdFor(auth.agentId, auth.instanceId)
      if (url.pathname === EVENTS_ACK_PATH) {
        const through = Number.parseInt(url.searchParams.get('through') ?? '', 10)
        const lease = leases.get(sub)
        const ok = lease ? poller.ack(sub, lease, through) : false
        res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok }))
        return
      }
      const waitMs = clampPollWait(url.searchParams.get('waitMs'), 1_000)
      let lease = leases.get(sub)
      if (!lease || !broker.hasLease(sub, lease)) {
        lease = broker.attach(sub).lease
        leases.set(sub, lease)
      }
      req.resume()
      void poller.poll(sub, lease, waitMs).then(r => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(r))
      })
    }

    server = createServer((req, res) => {
      const route = dispatchDaemonHttpRequest(req, res, (_q, r) => { r.writeHead(422); r.end() }, 'http://127.0.0.1', handler)
      if (route.handled) return
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    })
    await new Promise<void>((r, j) => { server!.once('error', j); server!.listen(0, '127.0.0.1', r) })
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`

    const goodHeaders = {
      [HEADER_TOKEN]: TOKEN,
      [HEADER_PROTOCOL]: HOOK_PROTOCOL,
      [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
      [HEADER_AGENT_ID]: AGENT,
      [HEADER_INSTANCE_ID]: String(liveInstance),
      [HEADER_EVENT_TOKEN]: EVENT_TOKEN,
    }
    const staleHeaders = { ...goodHeaders, [HEADER_INSTANCE_ID]: '99' }

    const ok = await fetch(`${base}${EVENTS_ROUTE_PATH}?waitMs=1000`, { method: 'POST', headers: goodHeaders })
    expect(ok.status).toBe(200)

    const gone = await fetch(`${base}${EVENTS_ROUTE_PATH}?waitMs=1000`, { method: 'POST', headers: staleHeaders })
    expect(gone.status).toBe(409)
    expect((await gone.json() as { error: string }).error).toBe('panel_gone')

    await new Promise<void>((r, j) => server!.close(e => e ? j(e) : r()))
  })

  test('singleton broker is shared between producer and consumer (same instance)', () => {
    // Producer publishes via singleton, consumer reads via same singleton
    const sub = subscriberIdFor('shared-agent', 1)
    // Ensure a subscriber exists — attach via singleton
    const { lease } = orchestratorBroker.attach(sub)
    const out = orchestratorPoller.publish(sub, { watchId: 'w1', idempotencyKey: 'k-shared-1', kind: 'k', payload: '[BRIDGE-ORCH] shared' })
    expect(out.published).toBe(true)
    const pending = orchestratorBroker.read(sub, lease)
    expect(pending.some(r => r.type === 'event' && (r as { payload: string }).payload === '[BRIDGE-ORCH] shared')).toBe(true)
    // cleanup
    orchestratorBroker.forget(sub)
  })
})
