/**
 * #616 slice 2 — the long-poll coordinator's failure modes.
 *
 * The transport was chosen for liveness, not speed: every poll return refreshes
 * the broker's read clock, so a wedged reader is identified by six missed
 * returns. That only holds if the poll actually returns — so these tests are
 * about the ways it could fail to.
 */
import { describe, expect, test } from 'bun:test'
import { OrchestratorEventBroker } from '../events/broker.js'
import { OrchestratorEventPoller, type TimerFns } from '../events/poller.js'

const SUB = 'orch-1'
const W1  = 'watch-1'

/** Timers that fire only when a test says so. */
function manualTimers(): TimerFns & { fire: () => void; pending: () => number } {
  const queue: Array<() => void> = []
  return {
    setTimeout: (fn: () => void) => { queue.push(fn); return queue.length - 1 },
    clearTimeout: (h: unknown) => { const i = h as number; if (queue[i]) queue[i] = () => {} },
    fire: () => { const q = [...queue]; queue.length = 0; for (const f of q) f() },
    pending: () => queue.length,
  }
}

const ev = (key: string, extra: Partial<{ closure: 'verdict' | 'watch_over'; watchId: string }> = {}) => ({
  watchId: extra.watchId ?? W1,
  idempotencyKey: key,
  kind: 'worker.advisory',
  ...(extra.closure ? { closure: extra.closure } : {}),
  payload: `[BRIDGE-ORCH] ${key}`,
})

describe('#616 poller failure modes', () => {
  test('a pending record returns immediately, without waiting out the poll', async () => {
    const b = new OrchestratorEventBroker()
    const p = new OrchestratorEventPoller(b, manualTimers())
    const { lease } = b.attach(SUB)
    p.publish(SUB, ev('a1'))

    const r = await p.poll(SUB, lease)
    expect(r.idle).toBe(false)
    expect(r.records.filter(x => x.type === 'event')).toHaveLength(1)
    expect(r.throughSeq).toBe(1)
  })

  test('a publish wakes a waiting poll — otherwise it would sit out its full wait', async () => {
    const b = new OrchestratorEventBroker()
    const t = manualTimers()
    const p = new OrchestratorEventPoller(b, t)
    const { lease } = b.attach(SUB)

    const inFlight = p.poll(SUB, lease)
    expect(p.waitingCount()).toBe(1)

    p.publish(SUB, ev('a1'))
    const r = await inFlight
    expect(r.idle).toBe(false)
    expect(r.throughSeq).toBe(1)
    expect(p.waitingCount()).toBe(0)
  })

  test('an elapsed wait resolves idle — and idle must produce no output', async () => {
    const b = new OrchestratorEventBroker()
    const t = manualTimers()
    const p = new OrchestratorEventPoller(b, t)
    const { lease } = b.attach(SUB)

    const inFlight = p.poll(SUB, lease)
    t.fire()
    const r = await inFlight

    // The contract the client depends on: an idle return carries nothing to
    // print. A printed heartbeat would wake the model every 15s forever, which
    // is strictly worse than the nudge storm this design removes.
    expect(r.idle).toBe(true)
    expect(r.records).toEqual([])
    expect(r.throughSeq).toBeNull()
  })

  test('a stale lease never waits — hanging would hide the error behind a timeout', async () => {
    const b = new OrchestratorEventBroker()
    const t = manualTimers()
    const p = new OrchestratorEventPoller(b, t)
    const first = b.attach(SUB)
    b.attach(SUB)                       // the CLI restarted; first lease is dead

    const r = await p.poll(SUB, first.lease)
    expect(r.idle).toBe(true)
    expect(p.waitingCount()).toBe(0)    // and it did not park a waiter
  })

  test('a second poll displaces the first rather than leaking it', async () => {
    const b = new OrchestratorEventBroker()
    const t = manualTimers()
    const p = new OrchestratorEventPoller(b, t)
    const { lease } = b.attach(SUB)

    const firstPoll = p.poll(SUB, lease)
    const secondPoll = p.poll(SUB, lease)

    // The displaced poll resolves instead of hanging forever.
    expect(await firstPoll).toMatchObject({ idle: true, records: [] })
    expect(p.waitingCount()).toBe(1)

    p.publish(SUB, ev('a1'))
    expect((await secondPoll).throughSeq).toBe(1)
  })

  test('records are re-delivered until acknowledged', async () => {
    const b = new OrchestratorEventBroker()
    const p = new OrchestratorEventPoller(b, manualTimers())
    const { lease } = b.attach(SUB)
    p.publish(SUB, ev('a1'))

    const first = await p.poll(SUB, lease)
    expect(first.throughSeq).toBe(1)

    // The client crashed before writing. The next poll must still have it.
    const again = await p.poll(SUB, lease)
    expect(again.records.filter(x => x.type === 'event')).toHaveLength(1)

    p.ack(SUB, lease, 1)
    const t2 = manualTimers()
    const p2 = new OrchestratorEventPoller(b, t2)
    const after = p2.poll(SUB, lease)
    t2.fire()
    expect((await after).idle).toBe(true)
  })

  test('a closed watch does not wake a poll, and does not silence another watch', async () => {
    const b = new OrchestratorEventBroker()
    const t = manualTimers()
    const p = new OrchestratorEventPoller(b, t)
    const { lease } = b.attach(SUB)

    p.publish(SUB, ev('d1', { closure: 'verdict' }))
    b.ack(SUB, lease, 1)

    const inFlight = p.poll(SUB, lease)
    expect(p.publish(SUB, ev('late'))).toEqual({ published: false, reason: 'closed' })
    expect(p.waitingCount()).toBe(1)        // a refused publish must not wake it

    p.publish(SUB, ev('other', { watchId: 'watch-2' }))
    expect((await inFlight).idle).toBe(false)
  })

  test('releasing a waiter resolves it rather than leaving a dangling promise', async () => {
    const b = new OrchestratorEventBroker()
    const p = new OrchestratorEventPoller(b, manualTimers())
    const { lease } = b.attach(SUB)

    const inFlight = p.poll(SUB, lease)
    p.releaseWaiter(SUB)
    expect(await inFlight).toMatchObject({ idle: true })
    expect(p.waitingCount()).toBe(0)
  })

  /**
   * Surfaced by mutation testing, not by review: removing the empty-records
   * guard in wake() broke no test, which meant nothing constrained what happens
   * when a publish arrives while a parked poll holds a lease the reader has
   * since replaced.
   *
   * Leaving it parked was safe but slow — the client would lose the whole wait
   * before learning its lease was dead. It is now released immediately.
   */
  test('a publish releases a parked poll whose lease was replaced, without waiting it out', async () => {
    const b = new OrchestratorEventBroker()
    const t = manualTimers()
    const p = new OrchestratorEventPoller(b, t)

    const first = b.attach(SUB)
    const inFlight = p.poll(SUB, first.lease)
    expect(p.waitingCount()).toBe(1)

    b.attach(SUB)                       // the reader restarts; first lease dies
    p.publish(SUB, ev('a1'))

    // Resolved by the publish itself — no timer fired.
    const r = await inFlight
    expect(r.idle).toBe(true)
    expect(r.records).toEqual([])
    expect(p.waitingCount()).toBe(0)
  })
})
