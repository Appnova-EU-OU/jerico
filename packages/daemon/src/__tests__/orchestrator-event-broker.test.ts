/**
 * #616 slice 1 — the broker's failure modes.
 *
 * Written as failure scenarios, not happy paths: the reason a stream can replace
 * the PTY nudge at all is that it behaves correctly when it breaks. Push failed
 * loudly (retry storms, notices about dead panels); a stream fails QUIETLY, and
 * silence is the one state an orchestrator cannot distinguish from "nothing
 * happened".
 *
 * H-numbers label the hypotheses of an earlier false-positive review, which
 * resolved ten findings into two modelling errors. Each test below pins one of
 * the behaviours that were wrong.
 */
import { describe, expect, test } from 'bun:test'
import { OrchestratorEventBroker } from '../events/broker.js'

const SUB = 'orch-panel-1'
const W1  = 'watch-worker-1'
const W2  = 'watch-worker-2'

function fixedClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

function evt(key: string, opts: { watchId?: string; closure?: 'verdict' | 'watch_over'; kind?: string } = {}) {
  const kind = opts.kind ?? 'worker.advisory'
  return {
    watchId: opts.watchId ?? W1,
    idempotencyKey: key,
    kind,
    ...(opts.closure ? { closure: opts.closure } : {}),
    payload: `[BRIDGE-ORCH] ${kind} ${key}`,
  }
}

const events = (rs: ReturnType<OrchestratorEventBroker['read']>) => rs.filter(r => r.type === 'event')
const gaps   = (rs: ReturnType<OrchestratorEventBroker['read']>) => rs.filter(r => r.type === 'gap')

describe('#616 broker failure modes', () => {
  test('H1: a concluded watch does not silence the next task on the same panel', () => {
    const b = new OrchestratorEventBroker()
    const { lease } = b.attach(SUB)

    b.publish(SUB, evt('d1', { closure: 'verdict', kind: 'worker.done' }))
    expect(b.watchClosure(SUB, W1)).toBe('verdict')

    // The orchestrator dispatches a NEW task to the same panel. This is the
    // ordinary workflow, and a subscriber-scoped fence silenced it forever.
    const next = b.publish(SUB, evt('a-new', { watchId: W2 }))
    expect(next.published).toBe(true)

    // A concurrent watch on another worker is likewise unaffected.
    expect(b.watchClosure(SUB, W2)).toBeNull()
    expect(events(b.read(SUB, lease))).toHaveLength(2)
  })

  test('H1b: the concluded watch itself stays fenced', () => {
    const b = new OrchestratorEventBroker()
    b.attach(SUB)
    b.publish(SUB, evt('d1', { closure: 'verdict', kind: 'worker.done' }))
    expect(b.publish(SUB, evt('late'))).toEqual({ published: false, reason: 'closed' })
  })

  test('H2: reading twice does not duplicate, and reading after a re-attach does not lose', () => {
    const b = new OrchestratorEventBroker()
    const first = b.attach(SUB)
    b.publish(SUB, evt('a1'))
    b.publish(SUB, evt('a2'))

    // Read without acking: the same records must come back, not vanish.
    expect(events(b.read(SUB, first.lease))).toHaveLength(2)
    expect(events(b.read(SUB, first.lease))).toHaveLength(2)

    b.ack(SUB, first.lease, 2)
    expect(events(b.read(SUB, first.lease))).toHaveLength(0)

    // A reconnect asking to replay from the start gets both back.
    const second = b.attach(SUB, 0)
    expect(events(second.records)).toHaveLength(2)
  })

  test('H3: a record survives a consumer that dies before acknowledging', () => {
    const b = new OrchestratorEventBroker()
    const first = b.attach(SUB)
    b.publish(SUB, evt('a1'))
    events(b.read(SUB, first.lease))   // read, then the CLI dies mid-write

    const second = b.attach(SUB)
    expect(events(second.records)).toHaveLength(1)
  })

  test('H4: detach preserves reconnect history', () => {
    const b = new OrchestratorEventBroker()
    const first = b.attach(SUB)
    b.publish(SUB, evt('a1'))
    expect(b.detach(SUB, first.lease)).toBe(true)

    const second = b.attach(SUB)
    expect(events(second.records)).toHaveLength(1)
  })

  test('H5: retention loss is reported on the READ path, not only on attach', () => {
    const b = new OrchestratorEventBroker({ retention: 2 })
    const { lease } = b.attach(SUB)
    for (let i = 1; i <= 5; i++) b.publish(SUB, evt(`a${i}`))

    // Five published, two retained. The three that vanished must be announced
    // here — the ordinary path, with no reconnect involved.
    const records = b.read(SUB, lease)
    expect(events(records)).toHaveLength(2)
    expect(gaps(records)).toHaveLength(1)
    expect(gaps(records)[0]).toMatchObject({ type: 'gap', fromSeq: 1, toSeq: 3, reason: 'retention_truncated' })
  })

  test('H6: closure is per-watch, so one call site cannot fence another watch', () => {
    const b = new OrchestratorEventBroker()
    b.attach(SUB)
    b.publish(SUB, evt('g1', { watchId: W1, closure: 'watch_over', kind: 'worker.panel_gone' }))
    expect(b.watchClosure(SUB, W1)).toBe('watch_over')
    expect(b.publish(SUB, evt('ok', { watchId: W2 })).published).toBe(true)
  })

  test('H7: dedup memory is bounded by retention, not by panel lifetime', () => {
    const b = new OrchestratorEventBroker({ retention: 2 })
    const { lease } = b.attach(SUB)
    for (let i = 1; i <= 5; i++) b.publish(SUB, evt(`a${i}`))
    b.ack(SUB, lease, 5)

    // 'a1' aged out of the ring, so it is no longer remembered as seen. That is
    // the deliberate trade: bounded memory, and re-publishing an aged-out key is
    // treated as new rather than silently swallowed.
    expect(b.publish(SUB, evt('a1')).published).toBe(true)
    // A key still in the ring is still refused.
    expect(b.publish(SUB, evt('a5'))).toEqual({ published: false, reason: 'duplicate' })
  })

  test('H8: `since` rewinds only — it can never skip an unacknowledged record', () => {
    const b = new OrchestratorEventBroker()
    b.attach(SUB)
    b.publish(SUB, evt('a1'))

    // A cursor ahead of everything published used to fast-forward the consumer
    // past records it had never acknowledged, losing them with no gap reported.
    // Moving forward is what ack() is for; `since` may only go back.
    const ahead = b.attach(SUB, 9_999)
    expect(events(ahead.records)).toHaveLength(1)
    expect(ahead.records[0]).toMatchObject({ type: 'control', resumedFrom: 0 })

    const behind = b.attach(SUB, -5)            // nonsense, clamped to 0
    expect(events(behind.records)).toHaveLength(1)
  })

  test('H8b: `since` cannot be used to skip past records after an ack either', () => {
    const b = new OrchestratorEventBroker()
    const { lease } = b.attach(SUB)
    for (let i = 1; i <= 5; i++) b.publish(SUB, evt(`a${i}`))
    b.ack(SUB, lease, 2)

    // Asking to resume from 4 with 3..5 outstanding must not discard 3 and 4.
    const re = b.attach(SUB, 4)
    expect(events(re.records).map(r => (r as { seq: number }).seq)).toEqual([3, 4, 5])
  })

  test('H8b: a zero or negative retention cannot silently discard everything', () => {
    const b = new OrchestratorEventBroker({ retention: 0 })
    const { lease } = b.attach(SUB)
    b.publish(SUB, evt('a1'))
    expect(events(b.read(SUB, lease)).length).toBeGreaterThan(0)
  })

  test('H10: a wedged reader is detectable — the failure push did not have', () => {
    const clock = fixedClock()
    const b = new OrchestratorEventBroker({ now: clock.now, hangAfterMs: 60_000 })
    const { lease } = b.attach(SUB)

    b.publish(SUB, evt('a1'))
    b.read(SUB, lease)
    expect(b.wedgedSubscribers()).toEqual([])

    // The reader stops consuming but its process stays alive: no exit code, no
    // error, nothing on the wire. Only elapsed silence distinguishes it.
    clock.advance(60_001)
    expect(b.wedgedSubscribers()).toEqual([SUB])
  })

  test('H10b: reading resets the hang clock, so a quiet-but-live reader is not demoted', () => {
    const clock = fixedClock()
    const b = new OrchestratorEventBroker({ now: clock.now, hangAfterMs: 60_000 })
    const { lease } = b.attach(SUB)

    clock.advance(59_000)
    b.read(SUB, lease)
    clock.advance(59_000)

    expect(b.wedgedSubscribers()).toEqual([])
  })

  test('a stale lease cannot read or ack — a surviving old reader is not the live one', () => {
    const b = new OrchestratorEventBroker()
    const first = b.attach(SUB)
    b.publish(SUB, evt('a1'))
    const second = b.attach(SUB)
    expect(second.lease).not.toBe(first.lease)

    expect(b.read(SUB, first.lease)).toEqual([])
    expect(b.ack(SUB, first.lease, 1)).toBe(false)
    expect(events(b.read(SUB, second.lease))).toHaveLength(1)
  })

  test('publishing with no subscriber is refused, not silently dropped', () => {
    const b = new OrchestratorEventBroker()
    expect(b.publish(SUB, evt('a1'))).toEqual({ published: false, reason: 'no_subscriber' })
  })

  test('pendingCount reports the consumer backlog', () => {
    const b = new OrchestratorEventBroker()
    const { lease } = b.attach(SUB)
    b.publish(SUB, evt('a1'))
    b.publish(SUB, evt('a2'))
    expect(b.pendingCount(SUB)).toBe(2)
    b.ack(SUB, lease, 1)
    expect(b.pendingCount(SUB)).toBe(1)
  })

  /**
   * Found by sonnet answering "what did nobody check". A detached subscriber
   * was reported wedged: elapsed silence proves nothing when nobody is supposed
   * to be reading, and the entry stayed in the list forever. Conflating "the
   * reader is stuck" with "the reader left" also destroys the only signal that
   * tells those two apart.
   */
  test('a detached subscriber is not wedged — nobody is supposed to be reading it', () => {
    const clock = fixedClock()
    const b = new OrchestratorEventBroker({ now: clock.now, hangAfterMs: 60_000 })
    const { lease } = b.attach(SUB)
    b.publish(SUB, evt('a1'))
    b.read(SUB, lease)
    b.detach(SUB, lease)

    clock.advance(60_001)
    expect(b.wedgedSubscribers()).toEqual([])
    // It is still reportable, under the state it is actually in.
    expect(b.detachedSubscribers()).toEqual([SUB])
  })

  /**
   * Found by kimi answering the same question: every replay hypothesis assumed
   * the requested range was entirely present or entirely gone. The interesting
   * case is a cursor pointing into the MIDDLE of a trimmed ring — part survives,
   * part does not, and the consumer must be told exactly which part vanished.
   */
  test('a cursor landing mid-trim replays what survives and names what did not', () => {
    const b = new OrchestratorEventBroker({ retention: 2 })
    b.attach(SUB)
    for (let i = 1; i <= 5; i++) b.publish(SUB, evt(`a${i}`))

    const re = b.attach(SUB, 1)          // wants 2..5; 1..3 were trimmed
    const seqs = events(re.records).map(r => (r as { seq: number }).seq)
    expect(seqs).toEqual([4, 5])
    // The gap is reported from what the consumer actually acknowledged (nothing)
    // rather than from what it asked for, because 1 was lost to it as well.
    expect(gaps(re.records)[0]).toMatchObject({ fromSeq: 1, toSeq: 3, reason: 'retention_truncated' })
  })

  /**
   * F3 from the final review, REPRODUCED there. The gap was a one-shot message
   * set as a side effect of reading, so every EVENT was at-least-once while the
   * admission that events were LOST was at-most-once — and it was lost by
   * exactly the crash the at-least-once machinery exists to survive.
   */
  test('a gap survives a consumer that reads it and dies before acknowledging', () => {
    const b = new OrchestratorEventBroker({ retention: 2 })
    const first = b.attach(SUB)
    for (let i = 1; i <= 5; i++) b.publish(SUB, evt(`a${i}`))

    const seen = b.read(SUB, first.lease)
    expect(gaps(seen)).toHaveLength(1)

    // The consumer died before writing anything and acknowledged nothing.
    const again = b.read(SUB, first.lease)
    expect(gaps(again)).toHaveLength(1)

    // A fresh attach with no `since` must still carry it.
    const second = b.attach(SUB)
    expect(gaps(second.records)).toHaveLength(1)
  })

  test('an acknowledged gap stops repeating', () => {
    const b = new OrchestratorEventBroker({ retention: 2 })
    const { lease } = b.attach(SUB)
    for (let i = 1; i <= 5; i++) b.publish(SUB, evt(`a${i}`))

    expect(gaps(b.read(SUB, lease))).toHaveLength(1)
    b.ack(SUB, lease, 5)
    expect(gaps(b.read(SUB, lease))).toHaveLength(0)
  })

  test('a second truncation widens the gap rather than erasing the first', () => {
    const b = new OrchestratorEventBroker({ retention: 2 })
    const { lease } = b.attach(SUB)
    for (let i = 1; i <= 4; i++) b.publish(SUB, evt(`a${i}`))
    expect(gaps(b.read(SUB, lease))[0]).toMatchObject({ fromSeq: 1, toSeq: 2 })

    for (let i = 5; i <= 7; i++) b.publish(SUB, evt(`a${i}`))
    // Still starts at 1 — the earlier loss was never delivered and must not be
    // quietly dropped by the later one.
    expect(gaps(b.read(SUB, lease))[0]).toMatchObject({ fromSeq: 1, toSeq: 5 })
  })

  /**
   * The other half of F2: refuse an unwritable payload where it is created, not
   * only where it is written. A bad record admitted to the ring blocks nothing
   * now that the subscriber survives it, but it still cannot be rendered — so
   * the cheapest place to stop it is before it exists.
   *
   * Contract chosen (616 round-4, item 2): only NUL and empty are hard
   * refusals. Newlines/CR are not refused — the idle path composes a
   * multiline quoted worker tail (`output-tap.ts:1315` joins with '\n') that
   * legitimately needed streaming after Fix 4. The wire is single-line-per-
   * record, so the broker normalises newlines to ` | ` at publish time
   * (`normalizeMultilinePayload`), keeping the ring single-line. Terminal
   * verdicts remain byte-identical because the producer sanitises the
   * free-text note to a single line BEFORE composing the sealed envelope
   * (`sanitizePromptInput` strips `\r`/`\n`; `output-tap.ts:1225,1263`),
   * so normalisation is a no-op for verdicts and never rewrites their
   * authority literal. Refusing multiline verdicts would drop terminal
   * completion; accepting normalisation for verdicts would break the
   * literal authority the orchestrator matches on.
   */
  test('an unwritable payload is refused at publish', () => {
    const b = new OrchestratorEventBroker()
    const { lease } = b.attach(SUB)

    // Hard refusals: NUL has no safe single-line encoding, empty is not a record.
    for (const bad of ['nul\0byte', '']) {
      expect(b.publish(SUB, { watchId: W1, idempotencyKey: `k-${bad.length}`, kind: 'k', payload: bad }))
        .toEqual({ published: false, reason: 'unsafe_payload' })
    }
    expect(events(b.read(SUB, lease))).toHaveLength(0)
    // Multiline is publishable — normalised to single-line, not refused.
    const multi = b.publish(SUB, { watchId: W1, idempotencyKey: 'k-multiline', kind: 'k', payload: 'two\nlines' })
    expect(multi).toEqual({ published: true, seq: 1 })
    const ev = events(b.read(SUB, lease))[0] as { payload: string }
    expect(ev.payload.includes('\n')).toBe(false)
    expect(ev.payload).toBe('two | lines')
    const cr = b.publish(SUB, { watchId: W1, idempotencyKey: 'k-cr', kind: 'k', payload: 'carriage\rreturn' })
    expect(cr.published).toBe(true)

    // A normal payload is unaffected.
    expect(b.publish(SUB, evt('fine')).published).toBe(true)
  })

  /**
   * F5 from the final review, REPRODUCED there. The per-watch fence fixed "a
   * concluded watch silences the SUBSCRIPTION" and left "a concluded watch
   * silences its own SUCCESSOR" — and jerico's retry paths reuse todo ids, so a
   * retried task under the same watchId would have been refused forever.
   */
  test('a retry reusing a concluded watchId can be reopened, explicitly', () => {
    const b = new OrchestratorEventBroker()
    const { lease } = b.attach(SUB)

    b.publish(SUB, evt('d1', { closure: 'verdict', kind: 'worker.done' }))
    expect(b.publish(SUB, evt('retry-progress'))).toEqual({ published: false, reason: 'closed' })

    expect(b.reopenWatch(SUB, W1)).toBe(true)
    expect(b.publish(SUB, evt('retry-progress')).published).toBe(true)
    expect(b.watchClosure(SUB, W1)).toBeNull()
    expect(events(b.read(SUB, lease))).toHaveLength(2)
  })

  test('reopening is explicit — a no-op reports false rather than pretending', () => {
    const b = new OrchestratorEventBroker()
    b.attach(SUB)
    expect(b.reopenWatch(SUB, 'never-closed')).toBe(false)
    expect(b.reopenWatch('no-such-subscriber', W1)).toBe(false)
  })

  test('concluded watches do not accumulate for the life of the panel', () => {
    const b = new OrchestratorEventBroker({ retention: 4 })
    b.attach(SUB)
    for (let i = 0; i < 1_200; i++) {
      b.publish(SUB, {
        watchId: `w-${i}`, idempotencyKey: `k-${i}`, kind: 'worker.done',
        closure: 'verdict', payload: `done ${i}`,
      })
    }
    // The oldest are evicted; the newest still fence.
    expect(b.watchClosure(SUB, 'w-0')).toBeNull()
    expect(b.watchClosure(SUB, 'w-1199')).toBe('verdict')
  })
})
