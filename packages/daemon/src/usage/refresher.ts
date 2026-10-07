/**
 * Keeping usage snapshots warm, so a surface never has to wait for a provider.
 *
 * Three rules shape this:
 *
 *   1. NEVER interactive. Every refresh here is a background refresh, so it may
 *      not raise a keychain modal. A credential behind a lock therefore reports
 *      `keychain_deferred`, which is a state a surface can draw, not an error.
 *   2. A failed refresh does NOT erase the last good reading. It records the
 *      fault beside it. That is what makes "updated 2h 14m ago · last refresh
 *      failed" possible, and drawing nothing instead would throw away something
 *      still true: a quota does not become unknown because the network did.
 *   3. Slow on purpose. A five-hour window does not move meaningfully inside
 *      five minutes, and a provider endpoint is not a heartbeat. One request per
 *      supported agent per interval is the whole cost.
 */

import { fetchUsage, listSupported } from './registry.js'
import { KEYCHAIN_TIMEOUT_MS } from './credentials.js'
import { fault, type CostSnapshot, type UsageFaultCode, type UsageSnapshot } from './model.js'

const REFRESH_INTERVAL_MS = 5 * 60_000
/** The first refresh waits a moment: a daemon that has just started has a socket
 *  to open and panels to restore, and usage is the least urgent thing it does. */
const FIRST_REFRESH_DELAY_MS = 8_000

/** A per-agent keychain read is already bounded by `KEYCHAIN_TIMEOUT_MS` (#635),
 *  but a whole cycle must not still be swallowed by two or three agents each
 *  eating that ceiling back to back. Reuse that same constant rather than
 *  invent a second timeout: tolerate about two stalled reads, then leave the
 *  rest of the cycle's agents at their last known reading. */
const TOTAL_REFRESH_BUDGET_MS = KEYCHAIN_TIMEOUT_MS * 2

/**
 * Run `run(agent)` for each agent in order under a time bound.
 *
 * `mode: 'total'` (the background cycle) bounds the WHOLE pass: once the budget
 * is spent the loop stops and later agents are not started at all. `mode:
 * 'per-agent'` (the interactive path) gives each agent its own budget, so a
 * user-triggered refresh always attempts every provider — review found that a
 * shared cap let one slow provider (agy's 12s HTTP timeout, or a real keychain
 * prompt) silently consume the whole cycle and leave the rest unread with no
 * per-provider fault to explain it.
 *
 * An agent that outlives its bound is abandoned by the loop. Its promise is NOT
 * cancelled and keeps running. Its eventual write is rejected by the generation
 * guard in `refreshOne` ONLY IF a newer attempt for that agent has started —
 * expiry alone does not invalidate anything, and a late result with no
 * successor is still committed, which is correct. An earlier revision of this
 * comment claimed "the cache simply never gets to record it", which was false
 * and let a late write regress a newer reading.
 *
 * Exported for direct testing with a small budget instead of the real one.
 */
export async function __test_runAgentsWithBudget(
  agents: string[],
  budgetMs: number,
  run: (agent: string) => Promise<void>,
  mode: 'total' | 'per-agent' = 'total',
): Promise<void> {
  let deadline = Date.now() + budgetMs
  for (const agent of agents) {
    if (mode === 'per-agent') deadline = Date.now() + budgetMs
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      log('usage.refresh.budget_exhausted', { agent, budgetMs })
      break
    }
    try {
      await Promise.race([
        run(agent),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, remaining)
          t.unref()
        }),
      ])
    } catch (err: unknown) {
      log('usage.refresh.threw', { agent, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

export interface UsageEntry {
  agent: string
  /** The last snapshot that succeeded, however long ago. null = never once. */
  snapshot: UsageSnapshot | null
  /** The fault from the most recent attempt, or null when it succeeded. Both
   *  fields are populated together when a refresh fails after a success — that
   *  pairing IS the stale state. */
  fault: { code: UsageFaultCode; detail: string } | null
  lastAttemptAt: number
}

const cache = new Map<string, UsageEntry>()
let timer: NodeJS.Timeout | null = null
let running = false

function log(event: string, extra: Record<string, unknown> = {}): void {
  console.log(`[daemon] ${event}`, extra)
}

/** Per-agent attempt counter. A budget-abandoned fetch keeps running and will
 *  still try to write when it finally settles; without this it can land AFTER a
 *  newer attempt and regress the cache to older data (reproduced in review with
 *  two sequential refreshUsageNow calls: newer wrote 2, the abandoned older one
 *  then wrote 1). Only the newest attempt for an agent may commit. */
const attemptSeq = new Map<string, number>()

/** Claim the next attempt number for `agent`. Exported so a test can drive the
 *  guard directly instead of mocking the provider registry. */
export function __test_startAttempt(agent: string): number {
  const seq = (attemptSeq.get(agent) ?? 0) + 1
  attemptSeq.set(agent, seq)
  return seq
}

/** True only if `seq` is still the newest attempt started for `agent`. */
export function isCurrentAttempt(agent: string, seq: number): boolean {
  if (attemptSeq.get(agent) === seq) return true
  log('usage.refresh.stale_write_dropped', { agent, seq, current: attemptSeq.get(agent) ?? 0 })
  return false
}

/** Test-only fetch override. Exists so a test can drive the REAL `refreshOne`
 *  with two overlapping attempts and assert the cache keeps the newer one —
 *  the guard's wiring, not just the exported primitive. Mocking the registry
 *  module instead would risk the cross-file mock leak documented in
 *  `keychain-main-thread-stall.test.ts`. */
let fetchOverride: typeof fetchUsage | null = null
export function __test_setFetchOverride(fn: typeof fetchUsage | null): void { fetchOverride = fn }

export async function __test_refreshOne(agent: string, opts = { allowInteractive: false }): Promise<void> {
  return refreshOne(agent, opts)
}

async function refreshOne(agent: string, opts = { allowInteractive: false }): Promise<void> {
  const seq = __test_startAttempt(agent)
  // agy /usage creates a real CLI conversation. Once an interactive read has
  // populated this daemon's cache, scheduled refreshes intentionally retain it
  // rather than running agy again or replacing it with a stale OAuth fault.
  const previousBeforeFetch = cache.get(agent)
  const result = !opts.allowInteractive && agent === 'agy' && previousBeforeFetch?.snapshot?.credentialSource === 'agent_cli'
    ? fault('interactive_deferred', 'agy /usage is only run when usage is opened, so background refreshes do not create phantom sessions')
    : await (fetchOverride ?? fetchUsage)(agent, opts)
  if (!isCurrentAttempt(agent, seq)) return
  const previous = cache.get(agent)
  if (result.ok) {
    cache.set(agent, { agent, snapshot: result.snapshot, fault: null, lastAttemptAt: Date.now() })
    log('usage.refresh.ok', {
      agent,
      windows: result.snapshot.windows.length,
      plan: result.snapshot.identity.plan,
    })
    return
  }
  // A deferred keychain read is intentional, not a failed refresh. Retain a
  // previous snapshot without marking it stale; a cold row can explain how to
  // request an interactive read without claiming the keychain is locked.
  if ((result.code === 'keychain_deferred' || result.code === 'interactive_deferred')
    && previous?.snapshot?.credentialSource !== undefined) {
    cache.set(agent, { agent, snapshot: previous.snapshot, fault: { code: result.code, detail: result.detail }, lastAttemptAt: Date.now() })
    return
  }
  if (result.code === 'keychain_deferred' || result.code === 'interactive_deferred') {
    cache.set(agent, { agent, snapshot: null, fault: { code: result.code, detail: result.detail }, lastAttemptAt: Date.now() })
    return
  }
  cache.set(agent, {
    agent,
    // Keep whatever we had. See rule 2.
    snapshot: previous?.snapshot ?? null,
    fault: { code: result.code, detail: result.detail },
    lastAttemptAt: Date.now(),
  })
  // `unsupported` is not worth a log line on every cycle — it is the permanent,
  // correct answer for most agents and would drown the log.
  if (result.code !== 'unsupported') {
    log('usage.refresh.failed', { agent, code: result.code, detail: result.detail })
  }
}

async function refreshAll(): Promise<void> {
  // Sequential, not parallel: a handful of agents, and serialising keeps a slow
  // provider from making every other request contend with it. Budgeted so a
  // handful of stuck agents cannot swallow the whole cycle either (#635).
  await __test_runAgentsWithBudget(listSupported(), TOTAL_REFRESH_BUDGET_MS, (agent) => refreshOne(agent))
}

export function startUsageRefresher(): void {
  if (running) return
  running = true
  const first = setTimeout(() => {
    void refreshAll()
  }, FIRST_REFRESH_DELAY_MS)
  first.unref()
  timer = setInterval(() => {
    void refreshAll()
  }, REFRESH_INTERVAL_MS)
  // unref so a pending refresh can never be the reason the process will not exit
  // — the same class of bug that left three `bridge-agent status` processes alive
  // for 21 hours on the machine this was written on.
  timer.unref()
  log('usage.refresher.started', { agents: listSupported(), intervalMs: REFRESH_INTERVAL_MS })
}

export function stopUsageRefresher(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  running = false
}

/**
 * Force a cycle now, on behalf of a user who just asked.
 *
 * INTERACTIVE, and that is the point rather than an oversight. The scheduled cycle
 * refuses to read the Keychain at all, because it may not raise a system prompt on
 * its own schedule — which on a Keychain-only install leaves the headline provider
 * dark until somebody looks. This is where somebody looks: opening the usage view
 * or pressing its refresh IS the user action the policy reserves the prompt for.
 *
 * So the two paths together are the whole design: nothing prompts while you are
 * not watching, and everything is readable the moment you are.
 */
export async function refreshUsageNow(): Promise<void> {
  await __test_runAgentsWithBudget(
    listSupported(),
    TOTAL_REFRESH_BUDGET_MS,
    (agent) => refreshOne(agent, { allowInteractive: true }),
    // Per-agent: a human answering a keychain prompt must not cost the
    // providers behind it their turn.
    'per-agent',
  )
}

/**
 * The shape `/health` publishes.
 *
 * Deliberately flat and self-describing: the desktop reads this over HTTP and
 * must be able to render every state without knowing which provider produced it.
 * `stale` is computed here rather than in the renderer so one definition serves
 * every consumer.
 */
export interface UsageHealthEntry {
  agent: string
  plan: string | null
  source: string | null
  fetchedAt: number | null
  /** True when the last attempt failed but an older reading survives. The
   *  surface must date the reading rather than drawing it as current. */
  stale: boolean
  faultCode: UsageFaultCode | null
  faultDetail: string | null
  windows: Array<{
    id: string
    title: string
    usedPercent: number
    severity: 'normal' | 'warning' | 'critical' | null
    isActive: boolean
    resetsAt: number | null
    windowMinutes: number | null
    scopedUnder: string | null
    /** Raw counts when the provider gave them instead of a percentage (Kimi).
     *  null = a percentage-only provider, never zero. */
    counts: { used: number; limit: number } | null
  }>
  /** The union from model.ts, verbatim: a disabled arrangement carries no figures
   *  because there are none to carry. */
  cost: CostSnapshot | null
}

export function usageForHealth(): UsageHealthEntry[] {
  const out: UsageHealthEntry[] = []
  for (const entry of cache.values()) {
    // An agent whose only answer is "no fetcher exists" is omitted entirely: it
    // is not a reading, and publishing it would make every consumer filter it.
    if (entry.snapshot === null && entry.fault?.code === 'unsupported') continue
    out.push({
      agent: entry.agent,
      plan: entry.snapshot?.identity.plan ?? null,
      source: entry.snapshot?.source ?? null,
      fetchedAt: entry.snapshot?.fetchedAt ?? null,
      stale: entry.snapshot !== null && entry.fault !== null,
      faultCode: entry.fault?.code ?? null,
      faultDetail: entry.fault?.detail ?? null,
      windows: entry.snapshot?.windows ?? [],
      cost: entry.snapshot?.cost ?? null,
    })
  }
  return out.sort((a, b) => a.agent.localeCompare(b.agent))
}
