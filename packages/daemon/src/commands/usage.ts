/**
 * `bridge-agent usage` — ask an agent's provider what is left, and print it.
 *
 * This exists so the provider layer is verifiable by a person before any of it
 * reaches a surface. Every number the popover will eventually draw can be read
 * here first, against the real account, which is the only way to tell an
 * authoritative reading from a plausible one.
 *
 * Interactive by default: a person ran this, so a keychain prompt is allowed.
 * `--no-interactive` is the shape a background refresh takes, and running both
 * is how you find out whether this machine's credential is behind a modal.
 */

import { fetchUsage, listSupported, NO_USAGE_BY_DESIGN } from '../usage/registry.js'
import { mostConstrained, pace, type RateWindow, type UsageSnapshot } from '../usage/model.js'

const DASH = '—'

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

/** `3h 53m`, `2d 04h`, `47m`. Never a negative countdown: a reset in the past is
 *  said as such, because an expired countdown is worse than no countdown. */
function until(epoch: number | null, now: number): string {
  if (epoch === null) return 'no reset reported'
  const ms = epoch - now
  if (ms <= 0) return `reset passed (${until(now + (now - epoch), now)} ago)`.replace(' ago) ago)', ' ago)')
  const mins = Math.floor(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${String(d)}d ${String(h).padStart(2, '0')}h`
  if (h > 0) return `${String(h)}h ${String(m).padStart(2, '0')}m`
  return `${String(m)}m`
}

function gauge(pct: number, cells = 14): string {
  const on = Math.round((pct / 100) * cells)
  return '█'.repeat(on) + '·'.repeat(cells - on)
}

function printWindow(w: RateWindow, now: number, indent: string): void {
  // The provider's own severity when it gives one, never our threshold. `!` and
  // `*` rather than colour, so this reads the same in a pipe and in a log file.
  const flag = w.severity === 'critical' ? ' !!' : w.severity === 'warning' ? ' ! ' : '   '
  const line =
    indent +
    pad(w.title.slice(0, 22 - indent.length), 24 - indent.length) +
    ' ' + gauge(w.usedPercent) +
    ' ' + padLeft(`${String(Math.round(w.usedPercent))}%`, 5) +
    flag +
    until(w.resetsAt, now) +
    (w.isActive ? '' : '  (not currently binding)')
  console.log(line)
  const p = pace(w, now)
  if (p !== null) {
    const verdict = p.willLast
      ? `behind pace by ${String(Math.abs(p.gapPercent))}% · lasts to reset`
      : `ahead of pace by ${String(p.gapPercent)}% · will not last to reset`
    console.log(indent + ' '.repeat(24 - indent.length) + ' ' + verdict)
  }
}

function printSnapshot(s: UsageSnapshot): void {
  const now = Date.now()
  console.log('')
  console.log(`${s.agent}${s.identity.plan !== null ? `  [${s.identity.plan}]` : ''}`)
  console.log(`  source: ${s.source}`)
  console.log('')
  const parents = s.windows.filter((w) => w.scopedUnder === null)
  for (const parent of parents) {
    printWindow(parent, now, '  ')
    for (const child of s.windows.filter((w) => w.scopedUnder === parent.id)) {
      printWindow(child, now, '    ')
    }
  }
  const orphans = s.windows.filter(
    (w) => w.scopedUnder !== null && !parents.some((p) => p.id === w.scopedUnder),
  )
  if (orphans.length > 0) {
    // A scoped window whose parent was not returned. Real: `seven_day` can be
    // absent while `seven_day_opus` is present. Printed at the top level rather
    // than dropped.
    console.log('')
    console.log('  (parent window not reported for these)')
    for (const w of orphans) printWindow(w, now, '  ')
  }
  if (s.cost !== null) {
    console.log('')
    if (!s.cost.enabled) {
      // Never "0.00 of 0.00": no arrangement is not an exhausted arrangement.
      console.log('  extra usage  not enabled on this account')
    } else {
      const limit = s.cost.limit === null ? DASH : s.cost.limit.toFixed(2)
      console.log(`  extra usage  ${s.cost.used.toFixed(2)} of ${limit} ${s.cost.currency}`)
    }
  }
  const worst = mostConstrained(s)
  console.log('')
  console.log(
    worst === null
      ? '  most constrained: none reported'
      : `  most constrained: ${worst.title} at ${String(Math.round(worst.usedPercent))}%`,
  )
  console.log('')
}

/** Deferred credential/CLI reads are deliberate background policy, not a CLI
 * failure condition. Exported for the command's narrow exit-status test. */
export function isRealUsageFault(result: Awaited<ReturnType<typeof fetchUsage>>): boolean {
  return !result.ok
    && result.code !== 'unsupported'
    && result.code !== 'keychain_deferred'
    && result.code !== 'interactive_deferred'
}

export async function runUsage(agentArg: string | undefined, opts: { json: boolean; interactive: boolean }): Promise<void> {
  const agents = agentArg !== undefined ? [agentArg] : listSupported()

  if (agents.length === 0) {
    console.error('No usage providers are implemented yet.')
    process.exit(1)
  }

  const results: Array<{ agent: string; result: Awaited<ReturnType<typeof fetchUsage>> }> = []
  for (const agent of agents) {
    results.push({ agent, result: await fetchUsage(agent, { allowInteractive: opts.interactive }) })
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2))
    // A fault is not a crash: the JSON says so, and a caller polling this should
    // not have to distinguish "the command broke" from "the token is refused".
    process.exit(0)
  }

  let anyOk = false
  for (const { agent, result } of results) {
    if (result.ok) {
      anyOk = true
      printSnapshot(result.snapshot)
    } else {
      console.log('')
      console.log(`${agent}  [${result.code}]`)
      console.log(`  ${result.detail}`)
      if (result.code === 'unsupported' && NO_USAGE_BY_DESIGN[agent] !== undefined) {
        console.log('  (this is by design, not a gap)')
      }
      console.log('')
    }
  }

  if (agentArg === undefined) {
    const missing = Object.keys(NO_USAGE_BY_DESIGN)
    if (missing.length > 0) {
      console.log(`by design, no usage: ${missing.join(', ')}`)
    }
  }
  // `unsupported` is NOT a failure: being told that ollama has no quota to report
  // is a correct answer, and exiting non-zero would tell a script something broke.
  // Exit 1 only when something a person could act on went wrong.
  const realFault = results.some((r) => isRealUsageFault(r.result))
  process.exit(anyOk || !realFault ? 0 : 1)
}
