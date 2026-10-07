/**
 * Long-poll coordinator over the orchestrator event broker.
 *
 * Why long-poll and not SSE or a WebSocket: the daemon already runs a loopback
 * HTTP router (`commands/http-dispatch.ts`), so either of those buys new surface
 * for latency that does not exist here — measured loopback keep-alive RTT on
 * a development machine is 0.165 ms.
 *
 * The real reason is liveness, not speed. Every poll return refreshes the
 * broker's `lastReadAt`, so hang detection falls out of the transport itself:
 * a 15 s wait against the broker's 90 s threshold means six consecutive missed
 * polls prove the reader is gone. A long-lived streaming response would have to
 * invent that signal and hold a response open through a router never built to
 * keep one.
 *
 * Pure over an injected timer, so the tests need no ports and no real waiting.
 */

import { OrchestratorEventBroker, type BrokerRecord, type PublishInput, type PublishOutcome } from './broker.js'

/** Injected so tests advance time instead of spending it. */
export interface TimerFns {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realTimers: TimerFns = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface PollResult {
  records: BrokerRecord[]
  /** Highest event seq in `records`, or null when it carried no events. The
   *  client acknowledges with this only AFTER it has written them out. */
  throughSeq: number | null
  /** True when the wait elapsed with nothing to send. The client writes no
   *  stdout for this: an empty return must not wake the model. */
  idle: boolean
}

interface Waiter {
  resolve: (r: PollResult) => void
  timer: unknown
  lease: symbol
}

/** Default long-poll wait. One sixth of the broker's hang threshold, so a wedged
 *  reader is identified after six missed returns rather than one — a single
 *  missed poll is jitter, not a dead stream. */
export const DEFAULT_POLL_WAIT_MS = 15_000

export class OrchestratorEventPoller {
  private readonly waiters = new Map<string, Waiter>()

  constructor(
    private readonly broker: OrchestratorEventBroker,
    private readonly timers: TimerFns = realTimers,
  ) {}

  /**
   * Publish, then wake a waiting poll for that subscriber. Waking is the whole
   * point of routing publishes through here: without it a poll would sit out its
   * full wait while a record it should have delivered is already buffered.
   */
  publish(subscriberId: string, input: PublishInput): PublishOutcome {
    const outcome = this.broker.publish(subscriberId, input)
    if (outcome.published) this.wake(subscriberId)
    return outcome
  }

  /**
   * Wait for records. Returns immediately when any are pending, otherwise
   * resolves empty after `waitMs`.
   *
   * A second poll for the same subscriber displaces the first: one live reader
   * per subscriber, matching the broker's single-lease rule. The displaced poll
   * resolves empty rather than hanging, so a client that raced itself does not
   * leak a promise.
   */
  poll(subscriberId: string, lease: symbol, waitMs = DEFAULT_POLL_WAIT_MS): Promise<PollResult> {
    const immediate = this.broker.read(subscriberId, lease)
    if (immediate.length > 0) return Promise.resolve(this.toResult(immediate))

    // A stale or unknown lease never waits: it has nothing to be woken for, and
    // hanging would hide the error behind a timeout.
    if (!this.broker.hasLease(subscriberId, lease)) {
      return Promise.resolve({ records: [], throughSeq: null, idle: true })
    }

    this.releaseWaiter(subscriberId)
    return new Promise<PollResult>((resolve) => {
      const timer = this.timers.setTimeout(() => {
        this.waiters.delete(subscriberId)
        // Deliberately re-read rather than resolving blind: a record may have
        // arrived through a path that did not wake us.
        const late = this.broker.read(subscriberId, lease)
        resolve(late.length > 0 ? this.toResult(late) : { records: [], throughSeq: null, idle: true })
      }, waitMs)
      this.waiters.set(subscriberId, { resolve, timer, lease })
    })
  }

  /** Acknowledge through `seq`. The client calls this only after the records are
   *  actually written, so a crash mid-write re-reads instead of losing them. */
  ack(subscriberId: string, lease: symbol, throughSeq: number): boolean {
    return this.broker.ack(subscriberId, lease, throughSeq)
  }

  /** Release a pending waiter, e.g. on detach. Resolves empty, never hangs. */
  releaseWaiter(subscriberId: string): void {
    const waiter = this.waiters.get(subscriberId)
    if (!waiter) return
    this.waiters.delete(subscriberId)
    this.timers.clearTimeout(waiter.timer)
    waiter.resolve({ records: [], throughSeq: null, idle: true })
  }

  waitingCount(): number {
    return this.waiters.size
  }

  private wake(subscriberId: string): void {
    const waiter = this.waiters.get(subscriberId)
    if (!waiter) return

    // The reader restarted while this poll was parked, so the lease it holds is
    // no longer the live one. Release it now rather than letting it sit out the
    // full wait: the client learns its lease is dead immediately and re-attaches,
    // instead of losing up to waitMs to a connection that can never be served.
    if (!this.broker.hasLease(subscriberId, waiter.lease)) {
      this.waiters.delete(subscriberId)
      this.timers.clearTimeout(waiter.timer)
      waiter.resolve({ records: [], throughSeq: null, idle: true })
      return
    }

    // No empty-guard here on purpose. wake() runs only after a published:true
    // outcome, which means a record with seq > ackedSeq is in the ring, and the
    // lease was just confirmed live — so read() cannot come back empty. A guard
    // for it survived every mutation because nothing can reach it, and an
    // unreachable branch reads later as a meaningful invariant it is not.
    const records = this.broker.read(subscriberId, waiter.lease)
    this.waiters.delete(subscriberId)
    this.timers.clearTimeout(waiter.timer)
    waiter.resolve(this.toResult(records))
  }

  private toResult(records: BrokerRecord[]): PollResult {
    let throughSeq: number | null = null
    for (const r of records) {
      if (r.type === 'event') throughSeq = throughSeq === null ? r.seq : Math.max(throughSeq, r.seq)
    }
    return { records, throughSeq, idle: false }
  }
}
