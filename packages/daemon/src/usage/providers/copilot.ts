/**
 * GitHub Copilot usage, from GitHub's own endpoint.
 *
 *   GET https://api.github.com/copilot_internal/user
 *   Authorization: token <github_oauth_token>
 *
 * The token is the `gh` CLI's, out of `~/.config/gh/hosts.yml` — the same file
 * `pty/agents.ts` `checkAuth` already reads to decide whether `copilot` can be
 * spawned. `GH_TOKEN` / `GITHUB_TOKEN` override it, because a user who exported
 * one is telling us which identity to ask about.
 *
 * MEASURED live, 2026-08-11, HTTP 200 (identifiers redacted):
 *
 *   { "copilot_plan": "individual", "access_type_sku": "free_educational_quota",
 *     "quota_reset_date": "2026-09-01",
 *     "quota_snapshots": {
 *       "chat":                 { "percent_remaining": 100, "unlimited": true,  "quota_remaining": 0 },
 *       "completions":          { "percent_remaining": 100, "unlimited": true,  "quota_remaining": 0 },
 *       "premium_interactions": { "percent_remaining": 35,  "unlimited": false, "quota_remaining": 70 } } }
 *
 * THE TRAP, and it is the sharpest one in any provider so far: an **unlimited**
 * quota reports `quota_remaining: 0`. Read that number without reading
 * `unlimited` and Copilot's chat allowance is drawn as completely exhausted while
 * it is in fact boundless. So unlimited buckets are omitted entirely rather than
 * drawn at 0% — a gauge is a claim that a ceiling exists, and for these there is
 * none.
 *
 * Two further decisions, both about NOT deriving things:
 *
 *   • No counts. `quota_remaining: 70` at `percent_remaining: 35` implies a total
 *     of 200 — but 35 is rounded, so the true total is anywhere in 197–203.
 *     Publishing a derived limit as if it were reported is exactly the class of
 *     invention this feature forbids, so `counts` stays null and the percentage,
 *     which GitHub actually states, is what is shown.
 *   • No window length. The payload gives a reset DATE and never says how long the
 *     window is, so `windowMinutes` is null and no pace is projected. The reset is
 *     still shown, which is the actionable half.
 *
 * A CORRECTION TO THE REFERENCE: CodexBar's `docs/copilot.md` states "Reset dates
 * are not provided by the API". They are — `quota_reset_date` was present on this
 * account. Their note is stale, and following it would have thrown away a real
 * reading.
 */

import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fault, type IdentitySnapshot, type RateWindow, type UsageResult } from '../model.js'
import { readProviderKey } from '../settings.js'

const USER_URL = 'https://api.github.com/copilot_internal/user'
const HOSTS_FILE = '.config/gh/hosts.yml'
const REQUEST_TIMEOUT_MS = 12_000

function home(): string {
  return process.env['HOME'] || os.homedir()
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * The `gh` CLI's OAuth token.
 *
 * `hosts.yml` is YAML and this reads it with a single anchored pattern rather than
 * pulling a YAML parser into the daemon for one field. That is a deliberate
 * trade with a stated limit: it finds the FIRST `oauth_token` in the file, which
 * is github.com's on every single-host install. A user with an enterprise host
 * listed first would have that token read instead — wrong identity rather than
 * wrong data, and it fails visibly as a 401 rather than silently. Revisit if
 * enterprise hosts are ever supported here.
 */
export function readGhToken(text: string): string | null {
  const m = /^\s*oauth_token:\s*(\S+)\s*$/m.exec(text)
  const token = m?.[1]
  return token !== undefined && token.length > 0 ? token : null
}

/** `2026-09-01` → that date at UTC midnight. A date is not a timestamp, and
 *  midnight is the only reading that does not invent an hour. */
export function readResetDate(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const t = Date.parse(`${v}T00:00:00Z`)
  return Number.isNaN(t) ? null : t
}

/** `premium_interactions` → `premium interactions`. */
function titleOf(id: string): string {
  return id.replace(/_/g, ' ')
}

/**
 * Parse `copilot_internal/user`. Exported so every shape is testable without a
 * network call or a credential.
 *
 * The buckets are SIBLINGS, not a parent with children: chat, completions and
 * premium interactions are separate allowances that run out independently. That
 * is the opposite of Antigravity's per-model buckets, which are alternatives to
 * one another and therefore nest.
 */
export function parseCopilotUsage(
  payload: unknown,
): { windows: RateWindow[] } | { error: string; noLimits?: true } {
  const root = asRecord(payload)
  if (root === null) return { error: 'user response is not a JSON object' }
  const snapshots = asRecord(root['quota_snapshots'])
  if (snapshots === null) return { error: 'user response carried no quota_snapshots object' }

  const resetsAt = readResetDate(root['quota_reset_date'])
  const windows: RateWindow[] = []
  let unlimitedCount = 0

  for (const [key, raw] of Object.entries(snapshots)) {
    const rec = asRecord(raw)
    if (rec === null) continue
    // UNLIMITED FIRST, before any number is read. See the note at the top of the
    // file: an unlimited bucket reports `quota_remaining: 0`.
    if (rec['unlimited'] === true) {
      unlimitedCount++
      continue
    }
    const remaining = finite(rec['percent_remaining'])
    if (remaining === null) continue
    const id = typeof rec['quota_id'] === 'string' && rec['quota_id'].length > 0 ? rec['quota_id'] : key
    windows.push({
      id,
      title: titleOf(id),
      // REMAINING → USED.
      usedPercent: Math.max(0, Math.min(100, 100 - remaining)),
      // GitHub does not grade its own quotas.
      severity: null,
      isActive: true,
      resetsAt,
      // The payload states a reset date and no window length, so no pace.
      windowMinutes: null,
      scopedUnder: null,
      // Deliberately not derived from quota_remaining ÷ percent — see the file note.
      counts: null,
    })
  }

  if (windows.length === 0) {
    // An account whose every bucket is unlimited is a real, correct state and NOT
    // an error: there is genuinely no ceiling to report. Saying so beats an empty
    // register row that reads as a failure.
    if (unlimitedCount > 0) {
      // `noLimits`, not a wire error: see UsageFaultCode.no_limits.
      return {
        error: `every Copilot quota on this account is unlimited (${String(unlimitedCount)} of them) — nothing to meter`,
        noLimits: true,
      }
    }
    return { error: 'quota_snapshots carried no bucket with a percent_remaining' }
  }

  windows.sort((a, b) => b.usedPercent - a.usedPercent || a.id.localeCompare(b.id))
  return { windows }
}

export function planLabel(plan: unknown): string | null {
  if (typeof plan !== 'string' || plan.length === 0) return null
  return plan.replace(/_/g, ' ')
}

export async function fetchCopilotUsage(_opts: { allowInteractive: boolean }): Promise<UsageResult> {
  // `??` only falls through on undefined, so an exported-but-EMPTY GH_TOKEN used to
  // mask a real GITHUB_TOKEN — and an empty export is a common shell accident.
  // Emptiness is absence here, and the same helper reads the settings file, which
  // is the only place a key reaches the launchd-started daemon.
  const supplied = readProviderKey(['GH_TOKEN', 'GITHUB_TOKEN'], 'githubToken')
  let token = ''
  let describe = ''

  if (supplied !== null) {
    token = supplied.value
    describe = supplied.describe
  } else {
    const full = path.join(home(), HOSTS_FILE)
    let text: string
    try {
      text = readFileSync(full, 'utf-8')
    } catch {
      return fault('no_credentials', `no GitHub credential at ~/${HOSTS_FILE} — run \`gh auth login\` first`)
    }
    const parsed = readGhToken(text)
    if (parsed === null) {
      // The gh CLI can keep its token in the system keychain instead, leaving the
      // file with only a username. That is a different sentence from "not signed
      // in", and the remedy is different too.
      return fault(
        'no_credentials',
        `~/${HOSTS_FILE} has no oauth_token — gh may be storing it in the keychain; export GH_TOKEN to let Jerico read usage`,
      )
    }
    token = parsed
    describe = `~/${HOSTS_FILE}`
  }

  let response: Response
  try {
    response = await fetch(USER_URL, {
      method: 'GET',
      headers: {
        authorization: `token ${token}`,
        accept: 'application/json',
        // GitHub's API rejects requests without one.
        'user-agent': 'jerico-bridge-agent',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return fault('network', `could not reach api.github.com: ${msg}`)
  }

  if (response.status === 401) {
    return fault('unauthorized', `the GitHub token in ${describe} was rejected — run \`gh auth login\` again`)
  }
  if (response.status === 403 || response.status === 404) {
    // 404 here means the account has no Copilot entitlement, which is not a
    // permissions problem to fix but a fact about the account.
    return fault(
      'scope_insufficient',
      response.status === 404
        ? 'this GitHub account has no Copilot subscription'
        : 'this GitHub token is not allowed to read Copilot usage',
    )
  }
  if (!response.ok) {
    return fault('network', `api.github.com returned HTTP ${String(response.status)}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return fault('malformed', 'user response was not valid JSON')
  }

  const parsed = parseCopilotUsage(body)
  if ('error' in parsed) {
    return fault(parsed.noLimits === true ? 'no_limits' : 'malformed', parsed.error)
  }

  const root = asRecord(body)
  const identity: IdentitySnapshot = {
    plan: planLabel(root?.['copilot_plan']),
    loginMethod: 'GitHub OAuth',
    accountId: null,
  }

  return {
    ok: true,
    snapshot: {
      agent: 'copilot',
      windows: parsed.windows,
      cost: null,
      identity,
      fetchedAt: Date.now(),
      source: `api.github.com · ${describe}`,
    },
  }
}
