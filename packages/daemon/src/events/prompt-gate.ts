/**
 * Prompt gate (layer 2 of orchestrator notice delivery) — the GLOBAL fix for
 * interrupted typing.
 *
 * Layer 1 (the event stream) removes the PTY write entirely, but only for a
 * harness that can be woken by a process. Measured: `claude` can (per line),
 * `kimi` can (on exit), `codex` and `opencode` cannot at all — codex stayed
 * silent after its background process had long exited, and opencode blocks
 * rather than waking.
 *
 * So the stream cannot be the global answer. This is, because interruption is
 * caused by WHEN the write happens, not by writing: hold a notice until the
 * prompt is empty and no sentence is ever broken. It asks nothing of the
 * harness — it is a timing decision on the daemon, where both the write and the
 * prompt tail already live — so it covers every harness, including ones added
 * later.
 *
 * Scope is deliberately narrow. Only writes the SERVER marks as notices are
 * gated. A task dispatch to a worker must never be delayed by this: it does not
 * interrupt anyone's typing, and holding it would slow every run down to fix a
 * problem it does not have.
 *
 * Pure over an injected clock, so its tests need no PTY and no real time.
 */

/** Prompt-shape matcher, mirroring the server idle detector.
 *  A prompt marker followed by nothing but whitespace means the line is empty and
 *  a write cannot land mid-sentence. `❯` matches; `❯ dae` does not. */
const CLEAN_PROMPT_RE = /[❯>$%]\s*$/

/** Tail kept per agent. Enough to see the prompt line and a little context,
 *  small enough that a chatty panel cannot grow it without bound. */
export const TAIL_BYTES = 2_048

/**
 * A held notice is delivered when the prompt clears — but a prompt that never
 * clears must not swallow it. Past this deadline the notice goes out anyway:
 * interrupting a sentence is bad, and silently withholding a notice forever is
 * the same failure as losing it, which is worse.
 */
export const HOLD_DEADLINE_MS = 20_000

export type NowFn = () => number

export interface HeldWrite {
  data: string
  dispatchId?: string
  heldSince: number
}

export type GateDecision =
  | { action: 'write' }
  | { action: 'hold'; reason: 'prompt_dirty' }
  | { action: 'write'; forced: true; reason: 'hold_deadline_exceeded' }

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\x1b/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/** Whether the tail looks like an empty prompt awaiting input. */
export function promptIsClean(tail: string): boolean {
  const cleaned = stripAnsi(tail).replace(/\r/g, '').trimEnd()
  if (cleaned === '') return false      // nothing observed yet: do not assume safe
  return CLEAN_PROMPT_RE.test(cleaned)
}

export class PromptGate {
  private readonly tails = new Map<string, string>()
  private readonly held  = new Map<string, HeldWrite[]>()
  private readonly now: NowFn

  constructor(opts: { now?: NowFn } = {}) {
    this.now = opts.now ?? Date.now
  }

  /** Feed decoded PTY output. Keeps a bounded tail per agent. */
  noteOutput(agentId: string, chunk: string): void {
    const prev = this.tails.get(agentId) ?? ''
    const next = prev + chunk
    this.tails.set(agentId, next.length > TAIL_BYTES ? next.slice(-TAIL_BYTES) : next)
  }

  /** Drop all state for a panel that is gone. */
  forget(agentId: string): void {
    this.tails.delete(agentId)
    this.held.delete(agentId)
  }

  /**
   * Decide whether a notice may be written now.
   *
   * Holds while the prompt carries uncommitted text — the exact condition under
   * which a write breaks a sentence. Forces the write once the deadline passes,
   * and says so, because a notice withheld without trace is the failure this
   * whole design exists to remove.
   */
  decide(agentId: string, heldSince?: number): GateDecision {
    const tail = this.tails.get(agentId)
    // Nothing observed yet — no evidence the prompt is dirty, and holding on no
    // evidence would stall the very first notice indefinitely.
    if (tail === undefined) return { action: 'write' }

    if (promptIsClean(tail)) return { action: 'write' }

    if (heldSince !== undefined && this.now() - heldSince >= HOLD_DEADLINE_MS) {
      return { action: 'write', forced: true, reason: 'hold_deadline_exceeded' }
    }
    return { action: 'hold', reason: 'prompt_dirty' }
  }

  /** Queue a notice behind any already waiting, preserving order. */
  hold(agentId: string, write: { data: string; dispatchId?: string }): number {
    const queue = this.held.get(agentId) ?? []
    queue.push({ ...write, heldSince: this.now() })
    this.held.set(agentId, queue)
    return queue.length
  }

  /** Whether anything is waiting. A caller must drain before writing new
   *  notices, or a later one would overtake an earlier one. */
  hasHeld(agentId: string): boolean {
    return (this.held.get(agentId)?.length ?? 0) > 0
  }

  heldCount(agentId: string): number {
    return this.held.get(agentId)?.length ?? 0
  }

  /**
   * Notices that may go out now, oldest first, removed from the queue.
   *
   * Stops at the first one that must still wait, so order is preserved: a
   * younger notice never overtakes an older one just because the deadline
   * happened to expire for it first.
   */
  drainReady(agentId: string): HeldWrite[] {
    const queue = this.held.get(agentId)
    if (!queue || queue.length === 0) return []

    const out: HeldWrite[] = []
    while (queue.length > 0) {
      const head = queue[0]!
      const decision = this.decide(agentId, head.heldSince)
      if (decision.action !== 'write') break
      out.push(head)
      queue.shift()
    }
    if (queue.length === 0) this.held.delete(agentId)
    return out
  }

  /** Bytes currently retained for a panel, for diagnostics and for proving the
   *  bound holds — a test that only checks "a clean prompt is still recognised"
   *  passes with an unbounded tail, which is how this went untested at first. */
  tailBytes(agentId: string): number {
    return this.tails.get(agentId)?.length ?? 0
  }

  /** Oldest held notice's age, for diagnostics. `null` when nothing is held. */
  oldestHeldAgeMs(agentId: string): number | null {
    const head = this.held.get(agentId)?.[0]
    return head ? this.now() - head.heldSince : null
  }
}
