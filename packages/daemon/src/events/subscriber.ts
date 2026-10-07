/**
 * Subscriber loop for `bridge-agent events --follow` (#616, slice 2).
 *
 * This is the half that removes the PTY nudge: the orchestrator runs it as a
 * background process, and its stdout is what the harness turns into
 * notifications. Nothing is ever written to anyone's input channel.
 *
 * Pure over injected IO — no node:http, no process, no real timers — so the
 * loop's failure behaviour is testable without a port or a subprocess. The thin
 * binary wrapper supplies the real transport.
 *
 * Two rules govern everything here:
 *
 *  1. **Every line written wakes the model and costs tokens.** A heartbeat and
 *     an idle poll are liveness signals between the CLI and the daemon, not
 *     notifications — printing them would wake a quiet orchestrator every wait
 *     period forever, strictly worse than the nudge storm this replaces.
 *  2. **Acknowledge only what was actually written.** The broker re-delivers
 *     anything unacknowledged, so a crash mid-write costs a duplicate rather
 *     than a lost notice. Losing one silently is the failure class this whole
 *     design exists to remove.
 */

import type { BrokerRecord } from './broker.js'
import type { PollResult } from './poller.js'

/**
 * Exit codes. Distinct per terminal condition because the harness surfaces them:
 * the validation gate REPRODUCED that a clean exit reports `completed` and a
 * kill reports `failed`, so a code is the only structured thing a dead
 * subscriber can still say.
 *
 * `0` means the subscription itself was retired. A CLOSED WATCH IS NOT AN EXIT:
 * one orchestrator panel watches many workers over its life, so a concluded task
 * must not take the stream down with it.
 */
export const EXIT = {
  stream_retired:     0,
  usage_or_identity:  64,
  bad_record:         65,
  unsafe_descriptor:  66,
  protocol_mismatch:  67,
  auth_invariant:     68,
  panel_gone:         69,
  internal_invariant: 70,
  stdout_closed:      71,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export interface SubscriberIO {
  /** One long-poll round trip. Resolves idle when the wait elapsed empty. */
  poll: () => Promise<PollResult>
  /** Acknowledge through this seq. Called ONLY after a successful write. */
  ack: (throughSeq: number) => Promise<void> | void
  /**
   * Write one line to stdout. Must reject/throw on EPIPE so a closed reader is
   * a terminal condition rather than a silent discard.
   */
  write: (line: string) => Promise<void> | void
  /** Structured diagnostics. Never carries a token, payload or completion id. */
  log?: (event: string, detail?: Record<string, unknown>) => void
  /** Cooperative stop, checked once per iteration. */
  shouldStop?: () => boolean
}

export interface SubscriberResult {
  exit: ExitCode
  polls: number
  written: number
  idleReturns: number
}

/**
 * Which records the orchestrator must actually see.
 *
 * `event` and `gap` are actionable: one is work, the other is the admission that
 * work was lost, and silent truncation must never ship. `heartbeat` and
 * `control` are transport bookkeeping — printing them would spend a model turn
 * to say nothing happened.
 */
export function isActionable(record: BrokerRecord): boolean {
  return record.type === 'event' || record.type === 'gap'
}

/**
 * Render one record as a single stdout line.
 *
 * An event's payload is emitted VERBATIM. `orchestrator-completion-authority.ts`
 * defines terminal completion by the literal `[BRIDGE-ORCH] event=worker.done
 * verified=true evidence=... completionId=<id>` string and speaks of an "input
 * stream", never of stdin — so keeping the bytes identical means every stored
 * prompt keeps working and only the transport changed.
 */
export function renderRecord(record: BrokerRecord): string | null {
  if (record.type === 'event') return record.payload
  if (record.type === 'gap') {
    return `[BRIDGE-ORCH] event=stream.gap from=${record.fromSeq} to=${record.toSeq} reason=${record.reason}. `
      + 'Notices in this range were dropped before delivery; inspect the workers directly.'
  }
  return null
}

/** A payload spanning lines or carrying a NUL would desynchronise a line-per-
 *  record stream, so it is refused rather than written and hoped for. */
export function isSafeLine(line: string): boolean {
  return !line.includes('\n') && !line.includes('\r') && !line.includes('\0') && line.length > 0
}

export async function runSubscriber(io: SubscriberIO): Promise<SubscriberResult> {
  const log = io.log ?? (() => {})
  let polls = 0
  let written = 0
  let idleReturns = 0

  for (;;) {
    if (io.shouldStop?.()) {
      log('subscriber.stopped', { polls, written })
      return { exit: EXIT.stream_retired, polls, written, idleReturns }
    }

    let result: PollResult
    try {
      result = await io.poll()
    } catch (error) {
      // A transport hiccup is not terminal: exiting is what costs liveness, and
      // the caller's poll is responsible for its own backoff.
      log('subscriber.poll_failed', { error: String(error) })
      continue
    }
    polls++

    // `idle` is counted, never used to suppress. An idle return carries no
    // records, so nothing is printed either way — but trusting the flag to skip
    // would silently DROP records if a poll ever reported both, which is the
    // exact failure class this design exists to remove. Records are the
    // authority; the flag is a statistic.
    if (result.idle) idleReturns++

    let highestWritten: number | null = null
    for (const record of result.records) {
      if (!isActionable(record)) continue
      const line = renderRecord(record)
      if (line === null) continue

      // A record that cannot be written as one line is REPLACED, not fatal.
      // Dying here made it a poison pill: nothing acknowledged it, so the next
      // reader re-read it and died too, and every record behind it became
      // permanently unreachable. Losing one notice is bad; losing every notice
      // after it is the failure this design exists to remove. Say what happened
      // and keep going.
      const safeLine = isSafeLine(line)
        ? line
        : `[BRIDGE-ORCH] event=stream.unprintable kind=${record.type === 'event' ? record.kind : record.type} `
          + 'seq=' + (record.type === 'event' ? record.seq : 'n/a')
          + '. A notice could not be rendered as a single line; inspect the worker directly.'
      if (!isSafeLine(line)) log('subscriber.unprintable_record', { type: record.type })

      try {
        await io.write(safeLine)
      } catch (error) {
        // The reader is gone. Acknowledge nothing further: whatever was not
        // written stays unacknowledged and is re-delivered to the next reader.
        log('subscriber.stdout_closed', { error: String(error) })
        if (highestWritten !== null) await io.ack(highestWritten)
        return { exit: EXIT.stdout_closed, polls, written, idleReturns }
      }

      written++
      if (record.type === 'event') highestWritten = record.seq
    }

    // Acknowledge only what reached stdout, and only after it did. See rule 2.
    if (highestWritten !== null) await io.ack(highestWritten)
  }
}
