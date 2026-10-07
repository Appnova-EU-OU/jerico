/**
 * #616 slice 2 — descriptor discovery and transport failure modes.
 *
 * Discovery is where a stream dies silently if it is sloppy: a missing file, a
 * stale protocol, or a descriptor pointing off-machine each produce "no notices
 * ever arrive", which is indistinguishable from a quiet day. So every refusal
 * here is specific and tested by name.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  EventsTransport,
  loadDescriptor,
  loadIdentity,
  eventHeaders,
  BACKOFF_MS,
} from '../events/client.js'
import { EXIT } from '../events/subscriber.js'
import { HOOK_PROTOCOL, EVENTS_PROTOCOL_VERSION, HEADER_TOKEN, HEADER_AGENT_ID } from '../hooks/protocol.js'

let dir: string | null = null
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null } })

function descriptorFile(body: unknown, mode = 0o600): string {
  dir = mkdtempSync(path.join(tmpdir(), 'jerico-616-'))
  const p = path.join(dir, 'agent-hook-endpoint.json')
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), { mode })
  chmodSync(p, mode)
  return p
}

const goodBody = {
  protocol: HOOK_PROTOCOL,
  protocolVersion: EVENTS_PROTOCOL_VERSION,
  // Exactly what start.ts:1958 writes — the full hook route, not a base.
  url: 'http://127.0.0.1:3101/v1/agent-hooks/events',
  hookToken: 'a'.repeat(64),
  profile: null,
  daemonPid: 1,
  writtenAt: 1,
}

describe('#616 descriptor discovery', () => {
  test('a well-formed descriptor loads', () => {
    const r = loadDescriptor(descriptorFile(goodBody))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.descriptor.url).toBe('http://127.0.0.1:3101/v1/agent-hooks/events')
      expect(r.descriptor.origin).toBe('http://127.0.0.1:3101')
      expect(r.descriptor.token).toBe('a'.repeat(64))
    }
  })

  test('a missing path is a usage error, not a silent no-op', () => {
    expect(loadDescriptor(undefined)).toMatchObject({ ok: false, exit: EXIT.usage_or_identity })
    expect(loadDescriptor('   ')).toMatchObject({ ok: false, exit: EXIT.usage_or_identity })
  })

  test('an unreadable descriptor is named, not guessed at', () => {
    expect(loadDescriptor('/nonexistent/does-not-exist.json'))
      .toMatchObject({ ok: false, exit: EXIT.unsafe_descriptor, reason: 'descriptor_unreadable' })
  })

  test('a world- or group-readable descriptor is refused — it is a token leak', () => {
    const p = descriptorFile(goodBody, 0o644)
    expect(loadDescriptor(p))
      .toMatchObject({ ok: false, exit: EXIT.unsafe_descriptor, reason: 'descriptor_permissions_too_open' })
  })

  test('malformed JSON is refused', () => {
    expect(loadDescriptor(descriptorFile('{not json')))
      .toMatchObject({ reason: 'descriptor_malformed' })
  })

  test('a different protocol generation is refused loudly', () => {
    expect(loadDescriptor(descriptorFile({ ...goodBody, protocolVersion: 99 })))
      .toMatchObject({ ok: false, exit: EXIT.protocol_mismatch })
    expect(loadDescriptor(descriptorFile({ ...goodBody, protocol: 'something-else' })))
      .toMatchObject({ ok: false, exit: EXIT.protocol_mismatch })
  })

  test('an incomplete descriptor is refused rather than half-used', () => {
    expect(loadDescriptor(descriptorFile({ ...goodBody, hookToken: '' })))
      .toMatchObject({ reason: 'descriptor_incomplete' })
    expect(loadDescriptor(descriptorFile({ ...goodBody, url: 42 })))
      .toMatchObject({ reason: 'descriptor_incomplete' })
  })

  test('a non-loopback url is refused — it would send the shared secret off-machine', () => {
    expect(loadDescriptor(descriptorFile({ ...goodBody, url: 'http://10.0.0.5:3101' })))
      .toMatchObject({ ok: false, exit: EXIT.unsafe_descriptor, reason: 'descriptor_url_not_loopback' })
    expect(loadDescriptor(descriptorFile({ ...goodBody, url: 'https://evil.example.com' })))
      .toMatchObject({ reason: 'descriptor_url_not_loopback' })
    // localhost and ::1 are the same machine and stay allowed.
    expect(loadDescriptor(descriptorFile({ ...goodBody, url: 'http://localhost:3101' })).ok).toBe(true)
    // IPv6 loopback: URL.hostname returns '[::1]' WITH brackets, so a bare
    // '::1' comparison silently never matched and the branch was dead code.
    expect(loadDescriptor(descriptorFile({ ...goodBody, url: 'http://[::1]:3101' })).ok).toBe(true)
  })

  test('identity must be present and positive', () => {
    expect(loadIdentity({ BRIDGE_PANEL_ID: 'p1', BRIDGE_PANEL_INSTANCE_ID: '3' }))
      .toEqual({ agentId: 'p1', instanceId: 3 })
    expect(loadIdentity({ BRIDGE_PANEL_ID: 'p1' })).toBeNull()
    expect(loadIdentity({ BRIDGE_PANEL_ID: '', BRIDGE_PANEL_INSTANCE_ID: '3' })).toBeNull()
    expect(loadIdentity({ BRIDGE_PANEL_ID: 'p1', BRIDGE_PANEL_INSTANCE_ID: '0' })).toBeNull()
    expect(loadIdentity({ BRIDGE_PANEL_ID: 'p1', BRIDGE_PANEL_INSTANCE_ID: 'x' })).toBeNull()
  })

  test('headers carry the token and identity the surface authorizes on', () => {
    const h = eventHeaders({ url: 'u', origin: 'u', token: 'tok' }, { agentId: 'p1', instanceId: 2 })
    expect(h[HEADER_TOKEN]).toBe('tok')
    expect(h[HEADER_AGENT_ID]).toBe('p1')
  })
})

describe('#616 transport failure modes', () => {
  const descriptor = {
    url: 'http://127.0.0.1:3101/v1/agent-hooks/events',
    origin: 'http://127.0.0.1:3101',
    token: 'tok',
  }
  const identity   = { agentId: 'p1', instanceId: 1 }

  function build(fetchImpl: Parameters<typeof makeTransport>[0]) { return makeTransport(fetchImpl) }
  function makeTransport(
    fetchImpl: (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ status: number; json: () => Promise<unknown> }>,
  ) {
    const slept: number[] = []
    const t = new EventsTransport({
      descriptor, identity, waitMs: 1000,
      fetchImpl,
      sleep: async (ms: number) => { slept.push(ms) },
    })
    return { t, slept }
  }

  test('a 200 carries records through', async () => {
    const { t } = build(async () => ({
      status: 200,
      json: async () => ({ records: [{ type: 'event', seq: 1, watchId: 'w', kind: 'k', payload: 'p' }], throughSeq: 1, idle: false }),
    }))
    const r = await t.poll()
    expect(r.records).toHaveLength(1)
    expect(t.terminalExit()).toBeNull()
  })

  test('a network error backs off and is NOT terminal — exiting costs liveness', async () => {
    const { t, slept } = build(async () => { throw new Error('ECONNREFUSED') })
    const r = await t.poll()
    expect(r.idle).toBe(true)
    expect(t.terminalExit()).toBeNull()
    expect(slept).toEqual([BACKOFF_MS[0]])

    await t.poll()
    expect(slept[1]).toBe(BACKOFF_MS[1])   // and it escalates
  })

  test('backoff climbs to the cap and STAYS there, never wrapping', async () => {
    const { t, slept } = build(async () => { throw new Error('down') })
    for (let i = 0; i < BACKOFF_MS.length + 4; i++) await t.poll()

    // The climb is monotonic through the table...
    expect(slept.slice(0, BACKOFF_MS.length)).toEqual([...BACKOFF_MS])
    // ...and everything after it is the cap. Checking only the MAXIMUM would
    // pass for a modulo that wraps back to 250ms, which is a busy loop wearing
    // a backoff's clothes.
    const tail = slept.slice(BACKOFF_MS.length)
    expect(tail.length).toBeGreaterThan(0)
    for (const ms of tail) expect(ms).toBe(BACKOFF_MS[BACKOFF_MS.length - 1])
  })

  test('a 403 is terminal — retrying a rejected token forever is hammering a locked door', async () => {
    const { t } = build(async () => ({ status: 403, json: async () => ({}) }))
    await t.poll()
    expect(t.terminalExit()).toBe(EXIT.auth_invariant)
  })

  test('a 422 and a 409 are terminal, and distinguishable', async () => {
    const a = build(async () => ({ status: 422, json: async () => ({}) }))
    await a.t.poll()
    expect(a.t.terminalExit()).toBe(EXIT.protocol_mismatch)

    const b = build(async () => ({ status: 409, json: async () => ({}) }))
    await b.t.poll()
    expect(b.t.terminalExit()).toBe(EXIT.panel_gone)
  })

  test('an unexpected status is transient, not terminal', async () => {
    const { t, slept } = build(async () => ({ status: 500, json: async () => ({}) }))
    const r = await t.poll()
    expect(r.idle).toBe(true)
    expect(t.terminalExit()).toBeNull()
    expect(slept).toHaveLength(1)
  })

  test('a garbage body yields idle rather than a crash', async () => {
    const { t } = build(async () => ({ status: 200, json: async () => ({ nope: true }) }))
    const r = await t.poll()
    expect(r).toMatchObject({ idle: true, records: [] })
  })

  test('a successful poll resets the backoff', async () => {
    let fail = true
    const { t, slept } = build(async () => {
      if (fail) throw new Error('x')
      return { status: 200, json: async () => ({ records: [], throughSeq: null, idle: true }) }
    })
    await t.poll()
    fail = false
    await t.poll()
    fail = true
    await t.poll()
    // Third call starts from the first backoff again, not the second.
    expect(slept).toEqual([BACKOFF_MS[0], BACKOFF_MS[0]])
  })

  test('a failed ack is swallowed — the record is re-delivered, not lost', async () => {
    const { t } = build(async () => { throw new Error('ack down') })
    await t.ack(5)   // must not throw
  })

  /**
   * F1 from the final review, REPRODUCED by the reviewer and confirmed against
   * source before acting on it. BLOCKING when found.
   *
   * `start.ts:1958` writes the descriptor url as the FULL hook route:
   * `http://127.0.0.1:<port>/v1/agent-hooks/events`. The transport treated it as
   * a base and appended, producing
   * `.../v1/agent-hooks/events/v1/orchestrator-events/poll` — a path that does
   * not exist. The CLI would have 404'd forever, silently.
   *
   * The existing HTTP test did not catch it because its harness built its own
   * base without the hook path. A test can be thorough about a component and
   * still never use the input production actually supplies.
   */
  test('the poll URL hangs off the origin, not off the hook route', async () => {
    const seen: string[] = []
    const t = new EventsTransport({
      descriptor: {
        url: 'http://127.0.0.1:3101/v1/agent-hooks/events',
        origin: 'http://127.0.0.1:3101',
        token: 'tok',
      },
      identity: { agentId: 'p1', instanceId: 1 },
      waitMs: 1000,
      fetchImpl: async (url: string) => {
        seen.push(url)
        return { status: 200, json: async () => ({ records: [], throughSeq: null, idle: true }) }
      },
      sleep: async () => {},
    })

    await t.poll()
    await t.ack(3)

    for (const url of seen) {
      expect(url).not.toContain('/v1/agent-hooks/events')
      expect(url.startsWith('http://127.0.0.1:3101/v1/orchestrator-events/')).toBe(true)
    }
    expect(seen).toHaveLength(2)
  })
})
