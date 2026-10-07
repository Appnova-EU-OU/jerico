/**
 * #616 slice 2 — the subscriber loop's failure modes.
 *
 * Two rules are load-bearing and every test below pins one of them: a heartbeat
 * must never reach stdout (each line costs a model turn), and nothing is
 * acknowledged that was not actually written (the broker re-delivers, so a crash
 * costs a duplicate rather than a lost notice).
 */
import { describe, expect, test } from 'bun:test'
import { EXIT, isActionable, isSafeLine, renderRecord, runSubscriber } from '../events/subscriber.js'
import type { BrokerRecord } from '../events/broker.js'
import type { PollResult } from '../events/poller.js'

const eventRec = (seq: number, payload = `[BRIDGE-ORCH] n${seq}`): BrokerRecord =>
  ({ type: 'event', seq, watchId: 'w1', kind: 'worker.advisory', payload })

const idle = (): PollResult => ({ records: [], throughSeq: null, idle: true })
const carrying = (records: BrokerRecord[]): PollResult => ({
  records,
  throughSeq: records.reduce<number | null>((m, r) => (r.type === 'event' ? Math.max(m ?? 0, r.seq) : m), null),
  idle: false,
})

/** Drives a fixed script of poll results, then stops. */
function harness(script: PollResult[], opts: { failWriteAt?: number } = {}) {
  const written: string[] = []
  const acked: number[] = []
  let i = 0
  return {
    written, acked,
    io: {
      poll: async () => script[i++] ?? idle(),
      ack: (seq: number) => { acked.push(seq) },
      write: async (line: string) => {
        if (opts.failWriteAt !== undefined && written.length === opts.failWriteAt) {
          throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' })
        }
        written.push(line)
      },
      shouldStop: () => i >= script.length,
    },
  }
}

describe('#616 subscriber failure modes', () => {
  test('an idle poll writes nothing — a printed heartbeat would wake the model forever', async () => {
    const h = harness([idle(), idle(), idle()])
    const r = await runSubscriber(h.io)

    expect(h.written).toEqual([])
    expect(h.acked).toEqual([])
    expect(r.idleReturns).toBe(3)
    expect(r.exit).toBe(EXIT.stream_retired)
  })

  test('heartbeat and control records are transport bookkeeping, never output', () => {
    expect(isActionable({ type: 'heartbeat', seq: 3, at: 1 })).toBe(false)
    expect(isActionable({ type: 'control', control: 'attached', resumedFrom: 0 })).toBe(false)
    expect(isActionable(eventRec(1))).toBe(true)
    expect(isActionable({ type: 'gap', fromSeq: 1, toSeq: 2, reason: 'retention_truncated' })).toBe(true)
  })

  test("an event's payload is emitted verbatim — the authority contract is a literal string", () => {
    const exact = '[BRIDGE-ORCH] event=worker.done verified=true evidence=task_receipt completionId=abc'
    expect(renderRecord(eventRec(1, exact))).toBe(exact)
  })

  test('a gap is printed — silent truncation must never ship', async () => {
    const h = harness([carrying([{ type: 'gap', fromSeq: 2, toSeq: 4, reason: 'retention_truncated' }])])
    await runSubscriber(h.io)

    expect(h.written).toHaveLength(1)
    expect(h.written[0]).toContain('event=stream.gap')
    expect(h.written[0]).toContain('from=2')
    // A gap carries no event seq, so there is nothing to acknowledge.
    expect(h.acked).toEqual([])
  })

  test('nothing is acknowledged before it is written', async () => {
    const h = harness([carrying([eventRec(1), eventRec(2)])])
    await runSubscriber(h.io)

    expect(h.written).toHaveLength(2)
    expect(h.acked).toEqual([2])
  })

  test('a stdout failure acknowledges only what landed, so the rest is re-delivered', async () => {
    // Two records; the write of the second one fails.
    const h = harness([carrying([eventRec(1), eventRec(2)])], { failWriteAt: 1 })
    const r = await runSubscriber(h.io)

    expect(r.exit).toBe(EXIT.stdout_closed)
    expect(h.written).toHaveLength(1)
    // seq 1 reached stdout and is acknowledged; seq 2 did not and must not be.
    expect(h.acked).toEqual([1])
  })

  test('a first-write failure acknowledges nothing at all', async () => {
    const h = harness([carrying([eventRec(1)])], { failWriteAt: 0 })
    const r = await runSubscriber(h.io)

    expect(r.exit).toBe(EXIT.stdout_closed)
    expect(h.written).toEqual([])
    expect(h.acked).toEqual([])
  })

  /**
   * F2 from the final review, REPRODUCED there. Dying on an unwritable record
   * made it a poison pill: nothing acknowledged it, so the next reader re-read
   * it and died too, and every record behind it became permanently unreachable.
   * Losing one notice is bad; losing every notice after it is the failure this
   * design exists to remove.
   */
  test('an unprintable payload is replaced and reported, never fatal', async () => {
    const h = harness([carrying([eventRec(1, 'line one\nline two'), eventRec(2, 'the one behind it')])])
    const r = await runSubscriber(h.io)

    expect(r.exit).toBe(EXIT.stream_retired)
    expect(h.written).toHaveLength(2)
    // The bad one is announced rather than silently dropped...
    expect(h.written[0]).toContain('event=stream.unprintable')
    expect(h.written[0]).not.toContain('\n')
    // ...and the record behind it is still delivered.
    expect(h.written[1]).toBe('the one behind it')
    expect(h.acked).toEqual([2])
  })

  test('line safety rejects the shapes that break a line-per-record stream', () => {
    expect(isSafeLine('ok')).toBe(true)
    expect(isSafeLine('a\nb')).toBe(false)
    expect(isSafeLine('a\rb')).toBe(false)
    expect(isSafeLine('a\0b')).toBe(false)
    expect(isSafeLine('')).toBe(false)
  })

  test('a poll error is not terminal — exiting is what costs liveness', async () => {
    let calls = 0
    const written: string[] = []
    const r = await runSubscriber({
      poll: async () => {
        calls++
        if (calls === 1) throw new Error('ECONNRESET')
        if (calls === 2) return carrying([eventRec(1)])
        return idle()
      },
      ack: () => {},
      write: async (l: string) => { written.push(l) },
      shouldStop: () => calls > 3,
    })

    // It kept going and delivered the record that arrived after the failure.
    expect(written).toHaveLength(1)
    expect(r.exit).toBe(EXIT.stream_retired)
  })

  test('a concluded watch does not exit the subscriber — the panel outlives its tasks', async () => {
    const done: BrokerRecord = {
      type: 'event', seq: 1, watchId: 'w1', kind: 'worker.done', closure: 'verdict',
      payload: '[BRIDGE-ORCH] event=worker.done verified=true',
    }
    const h = harness([carrying([done]), carrying([eventRec(2)])])
    const r = await runSubscriber(h.io)

    expect(h.written).toHaveLength(2)
    expect(r.exit).toBe(EXIT.stream_retired)
  })

  /**
   * Surfaced by mutation testing: the early-continue on `idle` broke no test,
   * because an idle return carries no records anyway. That made it an
   * optimisation masquerading as a guard — and a dangerous one, since a poll
   * that ever reported idle WITH records would have had them silently dropped.
   *
   * Records are now the authority and the flag is only a statistic. This pins
   * that: a contradictory poll result still delivers rather than discards.
   */
  test('a contradictory idle-with-records result delivers rather than discards', async () => {
    const written: string[] = []
    let called = 0
    await runSubscriber({
      poll: async () => {
        called++
        return called === 1
          ? { records: [eventRec(1)], throughSeq: 1, idle: true }
          : { records: [], throughSeq: null, idle: true }
      },
      ack: () => {},
      write: async (l: string) => { written.push(l) },
      shouldStop: () => called >= 2,
    })

    expect(written).toHaveLength(1)
  })
})
