/**
 * Orchestrator event broker (#616, phase 1 slice 1).
 *
 * Why this exists: orchestration notices are delivered today by writing text
 * into the orchestrator panel's PTY stdin (`output-tap.ts` →
 * `forwardOrchestratorInput`). A PTY has exactly one input channel, so a notice
 * is indistinguishable from the human typing and lands mid-sentence. This
 * broker is the destination that replaces that write.
 *
 * Deliberately NOT wired to any production path yet: it is driven by records
 * handed to `publish()`, so subscriber lifecycle, ordering, backpressure and
 * hang detection can be settled in isolation.
 *
 * A stream fails DIFFERENTLY from a PTY push. Push failed loudly — a retry
 * storm, a notice naming a dead panel. A stream fails QUIETLY, and silence is
 * the one state an orchestrator cannot tell apart from "nothing happened". Every
 * decision below is therefore about making failure observable.
 *
 * ── Two design errors this file was rewritten to remove ────────────────────
 * A first version was reviewed by four agents and probed by its author; ten
 * findings resolved to exactly two modelling errors, and the rewrite targets
 * those rather than patching the symptoms:
 *
 *  1. **One buffer served as both the delivery queue and the replay log.**
 *     Draining emptied it (records lost), replay read it without consuming
 *     (records delivered twice), and retention trimmed it while the gap record
 *     was only emitted on the attach path (silent loss on the ordinary drain
 *     path — five published, two delivered, no gap).
 *     → Retention and delivery are now separate: a retained ring nobody
 *       consumes, plus an explicit per-lease cursor.
 *
 *  2. **The closure fence was keyed on the subscriber.** One orchestrator panel
 *     is long-lived and watches many workers over time, so the first verdict
 *     silenced the whole stream — including the next task dispatched to the
 *     same panel, which is the normal workflow.
 *     → Closure is keyed per watch. A subscription is transport and stays open;
 *       a watch is what concludes.
 *
 * Delivery is at-least-once by construction: `read()` does not consume, and the
 * cursor only advances on an explicit `ack()`. A consumer that dies mid-write
 * re-reads rather than losing the record.
 *
 * No node:http, no Electron, no daemon singletons — a pure state machine over an
 * injected clock, so its tests need no ports and no real time.
 */

/** A record as it appears on the wire, one per line of subscriber stdout. */
export type BrokerRecord =
  | { type: 'event'; seq: number; watchId: string; kind: string; closure?: Closure; payload: string }
  | { type: 'heartbeat'; seq: number; at: number }
  | { type: 'gap'; fromSeq: number; toSeq: number; reason: 'retention_truncated' }
  | { type: 'control'; control: 'attached'; resumedFrom: number }

/**
 * Why a watch ended. Both values fence it; they are kept apart because a
 * consumer must tell "the work concluded" from "there is nothing left to
 * watch", and because conflating them is how a subscription ends up waiting for
 * a verdict that can never arrive.
 *
 * - `verdict`    — worker.done / worker.failed: a sealed outcome.
 * - `watch_over` — worker.panel_gone. Verified at
 *   the server output tap, where
 *   notifyWatchedPanelGone calls stopWatching() BEFORE composing and the payload
 *   reads "watch is over."
 */
export type Closure = 'verdict' | 'watch_over'

export interface PublishInput {
  /**
   * The watch this notice belongs to — one worker's task, not the orchestrator
   * panel. Closure is scoped to this, so a concluded task never silences the
   * next one on the same panel.
   */
  watchId: string
  /** Stable identity of the notice. A repeat is refused, never re-delivered. */
  idempotencyKey: string
  kind: string
  /** Present when this notice ends the watch. Absent means advisory. */
  closure?: Closure
  /**
   * The exact line the orchestrator will see. For a `verdict` this must stay
   * byte-identical to today's `[BRIDGE-ORCH]` envelope: the authority in
   * `packages/shared/src/orchestrator-completion-authority.ts` defines terminal
   * completion by that literal string. Advisory payloads that legitimately
   * contain newlines (the idle tail joins with '\n') are normalised at the
   * broker to single-line (`normalizeMultilinePayload`); verdict payloads
   * never reach that case because the server sanitises the free-text `note`
   * to a single line BEFORE composing the sealed envelope
   * (the server prompt sanitizer and output tap), so a terminal
   * envelope is stored and replayed byte-identical.
   */
  payload: string
}

export type PublishOutcome =
  | { published: true;  seq: number }
  | { published: false; reason: 'duplicate' | 'closed' | 'no_subscriber' | 'unsafe_payload' }

/**
 * A payload carrying a NUL would desynchronise a line-per-record stream and is
 * refused HERE, at the point of creation, rather than only at the point of
 * writing: a bad record admitted to the ring blocks every record behind it.
 *
 * Newlines previously caused the same refusal, but the server's idle path
 * composes a multiline quoted worker tail (output-tap.ts:1315 joins with '\n'),
 * so real notices were always refused `unsafe_payload` and never streamed.
 * The wire is single-line-per-record, so newlines are normalised to a
 * single-line representation at publish time (see `normalizeMultilinePayload`).
 * Only NUL remains a hard refusal — it has no safe single-line encoding and
 * cannot appear in legitimate `[BRIDGE-ORCH]` envelopes.
 *
 * Terminal `verdict`/`watch_over` envelopes are single-line by construction:
 * the server's `sanitizePromptInput` strips `\r`/`\n` from the free-text note
 * before `composeSealedFailure` builds the envelope, so normalisation is a
 * no-op for verdicts and byte-identity is preserved.
 */
export function isPublishablePayload(payload: string): boolean {
  return payload.length > 0
    && !payload.includes('\0')
}

/**
 * Normalise a payload that may contain newlines into a single-line
 * representation safe for the line-per-record stdout framing. Preserves all
 * content with an explicit separator so no information is silently dropped.
 */
export function normalizeMultilinePayload(payload: string): string {
  return payload.replace(/\r\n|\r|\n/g, ' | ')
}

/** Monotonic-clock reader, injected so tests need no real time. */
export type NowFn = () => number

export interface BrokerOptions {
  now?: NowFn
  /**
   * Records retained per subscriber. Older ones are dropped and reported as an
   * explicit `gap` on whichever path next observes the loss — attach OR read.
   * Silent truncation must never happen.
   */
  retention?: number
  /**
   * A subscriber not read from for this long is treated as wedged. Death is
   * signalled by the harness; a HANG is not, and a wedged stream is otherwise
   * indistinguishable from a quiet one.
   */
  hangAfterMs?: number
}

const DEFAULT_RETENTION      = 512
/** Concluded watches remembered per subscriber. Bounded because an orchestrator
 *  panel is long-lived and would otherwise accumulate one entry per task for the
 *  life of the process. */
const MAX_CLOSED_WATCHES     = 1_024
const DEFAULT_HANG_AFTER_MS  = 90_000
const MIN_RETENTION          = 1

interface StoredEvent {
  seq: number
  watchId: string
  kind: string
  closure?: Closure
  payload: string
  idempotencyKey: string
}

interface Subscription {
  /**
   * Bound at attach. A re-attach mints a new one so a reader that outlived its
   * own process cannot keep consuming — the same generation-identity rule the
   * server's watcher tokens follow, and whose absence caused the 0.26.14 retry
   * bug. `null` while detached; the rest of the state survives, so a reconnect
   * resumes instead of starting blind.
   */
  lease: symbol | null
  /** Retained ring. Never consumed by reading — only trimmed by retention. */
  ring: StoredEvent[]
  nextSeq: number
  /** Lowest seq still retained. Anything below it was trimmed. */
  floorSeq: number
  /** Highest seq the consumer has acknowledged. Advances only on ack(). */
  ackedSeq: number
  /**
   * Highest seq known to have been lost to retention and not yet acknowledged
   * by the consumer. `null` when there is nothing outstanding.
   *
   * This is STATE, not a one-shot message. The first version set a
   * `gapReported` boolean as a side effect of reading, so every event was
   * at-least-once while the admission that events were LOST was at-most-once —
   * and it was lost by exactly the crash the at-least-once machinery exists to
   * survive. The gap now re-emits until an ack covers it, like everything else.
   */
  gapThrough: number | null
  closedWatches: Map<string, Closure>
  lastReadAt: number
}

export class OrchestratorEventBroker {
  private readonly subs = new Map<string, Subscription>()
  private readonly now: NowFn
  private readonly retention: number
  private readonly hangAfterMs: number

  constructor(opts: BrokerOptions = {}) {
    this.now = opts.now ?? Date.now
    // A retention of 0 or a negative would silently discard everything, which is
    // the failure this class exists to prevent. Clamp loudly-by-construction
    // rather than trusting the caller.
    this.retention   = Math.max(MIN_RETENTION, Math.floor(opts.retention ?? DEFAULT_RETENTION))
    this.hangAfterMs = opts.hangAfterMs ?? DEFAULT_HANG_AFTER_MS
  }

  /**
   * Attach a subscriber and return its lease. Attaching where one exists
   * replaces the lease but keeps the ring, the cursor and the watch fences, so a
   * reconnect resumes. `since` rewinds the cursor for replay; an out-of-range
   * value is clamped to what is actually retained, and the clamp is reported as
   * a gap rather than silently honoured.
   */
  attach(subscriberId: string, since?: number): { lease: symbol; records: BrokerRecord[] } {
    const sub = this.subs.get(subscriberId) ?? this.createSubscription()
    sub.lease      = Symbol(`sub:${subscriberId}`)
    sub.lastReadAt = this.now()

    if (since !== undefined) {
      const requested = Number.isFinite(since) ? Math.floor(since) : 0
      // `since` REWINDS only. Letting it advance would silently skip records the
      // consumer never acknowledged — a caller resuming from 4 with 1..5
      // outstanding would lose four notices and be told nothing. Moving forward
      // is what ack() is for, and ack is the only thing that should do it.
      sub.ackedSeq = Math.max(0, Math.min(requested, sub.ackedSeq))
    }
    this.subs.set(subscriberId, sub)

    const records: BrokerRecord[] = [{ type: 'control', control: 'attached', resumedFrom: sub.ackedSeq }]
    records.push(...this.pending(sub))
    return { lease: sub.lease, records }
  }

  /**
   * Release the lease. State is retained deliberately: a disconnect must not
   * destroy the reconnect history, or every reconnect starts blind and anything
   * unacknowledged is lost.
   */
  detach(subscriberId: string, lease: symbol): boolean {
    const sub = this.subs.get(subscriberId)
    if (!sub || sub.lease !== lease) return false
    sub.lease = null
    return true
  }

  /** Forget a subscriber entirely. Only for a panel that is truly gone. */
  forget(subscriberId: string): void {
    this.subs.delete(subscriberId)
  }

  /**
   * Publish a notice to one subscriber's stream.
   *
   * Refusals are reported rather than swallowed: `duplicate` when the
   * idempotency key was already published, and `closed` when this WATCH already
   * concluded — which is why a verdict is never followed by "still working"
   * text, and why a dead panel's watch does not sit waiting for a verdict that
   * cannot come. A different watch on the same subscriber is unaffected.
   */
  publish(subscriberId: string, input: PublishInput): PublishOutcome {
    const sub = this.subs.get(subscriberId)
    if (!sub) return { published: false, reason: 'no_subscriber' }
    if (sub.closedWatches.has(input.watchId)) return { published: false, reason: 'closed' }
    if (!isPublishablePayload(input.payload)) return { published: false, reason: 'unsafe_payload' }
    // Demote wedged/detached readers back to PTY: publishing to a dead reader must
    // not suppress the PTY write. Check health synchronously so the very next
    // notice after death falls through, not only after the periodic sweep.
    if (sub.lease === null) return { published: false, reason: 'no_subscriber' }
    if (sub.lease !== null && sub.lastReadAt < this.now() - this.hangAfterMs) {
      return { published: false, reason: 'no_subscriber' }
    }
    if (sub.ring.some(e => e.idempotencyKey === input.idempotencyKey)) {
      return { published: false, reason: 'duplicate' }
    }

    const payload = normalizeMultilinePayload(input.payload)
    const seq = sub.nextSeq++
    sub.ring.push({
      seq,
      watchId:        input.watchId,
      kind:           input.kind,
      ...(input.closure ? { closure: input.closure } : {}),
      payload,
      idempotencyKey: input.idempotencyKey,
    })
    if (input.closure) {
      sub.closedWatches.set(input.watchId, input.closure)
      // Map iteration is insertion-ordered, so the first key is the oldest.
      while (sub.closedWatches.size > MAX_CLOSED_WATCHES) {
        const oldest = sub.closedWatches.keys().next().value
        if (oldest === undefined) break
        sub.closedWatches.delete(oldest)
      }
    }
    this.trim(sub)
    return { published: true, seq }
  }

  /**
   * Read everything not yet acknowledged. Does NOT consume: the cursor advances
   * only on `ack()`, so a consumer that dies mid-write re-reads rather than
   * losing the record. Marks the subscriber as read, which is what distinguishes
   * a quiet stream from a wedged one.
   */
  read(subscriberId: string, lease: symbol): BrokerRecord[] {
    const sub = this.subs.get(subscriberId)
    if (!sub || sub.lease !== lease) return []
    sub.lastReadAt = this.now()
    return this.pending(sub)
  }

  /**
   * Acknowledge delivery through `throughSeq`. Only this advances the cursor,
   * and it never moves backwards.
   */
  ack(subscriberId: string, lease: symbol, throughSeq: number): boolean {
    const sub = this.subs.get(subscriberId)
    if (!sub || sub.lease !== lease) return false
    if (!Number.isFinite(throughSeq)) return false
    sub.ackedSeq = Math.max(sub.ackedSeq, Math.min(Math.floor(throughSeq), sub.nextSeq - 1))
    return true
  }

  /** Emit a heartbeat so silence stops being ambiguous. */
  heartbeat(subscriberId: string): BrokerRecord | null {
    const sub = this.subs.get(subscriberId)
    if (!sub) return null
    return { type: 'heartbeat', seq: sub.nextSeq - 1, at: this.now() }
  }

  /**
   * Subscribers whose reader is ATTACHED but has stopped consuming. The server
   * demotes these back to PTY push: liveness must not depend on the model
   * remembering to re-attach.
   *
   * A detached subscriber is deliberately excluded. Nobody is supposed to be
   * reading it, so elapsed silence proves nothing — reporting it here would
   * conflate "the reader is stuck" with "the reader left", make the signal
   * useless for diagnosing which happened, and accumulate a permanently growing
   * list of false wedge reports. Use `detachedSubscribers()` for that state;
   * both may warrant demotion, but for different reasons.
   */
  wedgedSubscribers(): string[] {
    const cutoff = this.now() - this.hangAfterMs
    const out: string[] = []
    for (const [id, sub] of this.subs) {
      if (sub.lease !== null && sub.lastReadAt < cutoff) out.push(id)
    }
    return out
  }

  /** Subscribers with no attached reader that still hold unacknowledged work. */
  detachedSubscribers(): string[] {
    const out: string[] = []
    for (const [id, sub] of this.subs) {
      if (sub.lease === null && sub.ring.some(e => e.seq > sub.ackedSeq)) out.push(id)
    }
    return out
  }

  /**
   * Reopen a concluded watch, for a retry that reuses its identifier.
   *
   * The per-watch fence fixed "a concluded watch silences the SUBSCRIPTION" and
   * introduced "a concluded watch silences its own SUCCESSOR": jerico's retry
   * paths reuse todo ids, so a retried task arriving under the same watchId
   * would be refused forever. A caller re-arming a watch must either mint a
   * fresh watchId for the attempt or call this — and it is explicit rather than
   * automatic, because silently reopening on the next publish would defeat the
   * fence that stops a verdict being contradicted.
   *
   * Returns false when the watch was not closed, so a caller cannot mistake a
   * no-op for a reset.
   */
  reopenWatch(subscriberId: string, watchId: string): boolean {
    const sub = this.subs.get(subscriberId)
    if (!sub || !sub.closedWatches.has(watchId)) return false
    sub.closedWatches.delete(watchId)
    return true
  }

  /** Whether a specific watch has concluded, and why. `null` while open. */
  watchClosure(subscriberId: string, watchId: string): Closure | null {
    return this.subs.get(subscriberId)?.closedWatches.get(watchId) ?? null
  }

  /** Whether this lease is the currently attached one. Callers use it to refuse
   *  work for a stale reader instead of letting it wait on something that will
   *  never be delivered to it. */
  hasLease(subscriberId: string, lease: symbol): boolean {
    return this.subs.get(subscriberId)?.lease === lease
  }

  /** Unacknowledged record count — the consumer's backlog. */
  pendingCount(subscriberId: string): number {
    const sub = this.subs.get(subscriberId)
    if (!sub) return 0
    return sub.ring.filter(e => e.seq > sub.ackedSeq).length
  }

  private createSubscription(): Subscription {
    return {
      lease:         null,
      ring:          [],
      nextSeq:       1,
      floorSeq:      1,
      ackedSeq:      0,
      gapThrough:    null,
      closedWatches: new Map(),
      lastReadAt:    this.now(),
    }
  }

  /**
   * Records above the acknowledged cursor, preceded by a gap when retention
   * dropped records the consumer had not acknowledged. The gap is emitted on
   * THIS path too, not only on attach — that hole is what let five published
   * records deliver as two with nothing reported.
   */
  private pending(sub: Subscription): BrokerRecord[] {
    const out: BrokerRecord[] = []
    // Re-emitted on every read until an ack covers it. A gap carries no seq of
    // its own, so the consumer's cursor is what retires it: once ackedSeq has
    // passed the lost range, the loss has been delivered and can stop repeating.
    if (sub.gapThrough !== null && sub.ackedSeq < sub.gapThrough) {
      out.push({
        type:    'gap',
        fromSeq: sub.ackedSeq + 1,
        toSeq:   sub.gapThrough,
        reason:  'retention_truncated',
      })
    }
    for (const e of sub.ring) {
      if (e.seq <= sub.ackedSeq) continue
      out.push({
        type:    'event',
        seq:     e.seq,
        watchId: e.watchId,
        kind:    e.kind,
        ...(e.closure ? { closure: e.closure } : {}),
        payload: e.payload,
      })
    }
    return out
  }

  /**
   * Bound the ring. `seen` is not a separate structure: idempotency is answered
   * from the ring itself, so dedup memory is bounded by retention rather than
   * growing for the life of the panel.
   */
  private trim(sub: Subscription): void {
    while (sub.ring.length > this.retention) {
      const dropped = sub.ring.shift()
      if (!dropped) break
      sub.floorSeq = dropped.seq + 1
      // A record the consumer had not acknowledged just disappeared. Widen the
      // outstanding gap rather than replacing it, so a second truncation before
      // the first was delivered does not erase the first.
      if (dropped.seq > sub.ackedSeq) {
        sub.gapThrough = sub.gapThrough === null ? dropped.seq : Math.max(sub.gapThrough, dropped.seq)
      }
    }
  }
}
