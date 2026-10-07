/**
 * Codex usage, from OpenAI's own endpoint.
 *
 *   GET https://chatgpt.com/backend-api/wham/usage
 *   Authorization: Bearer <tokens.access_token>
 *   ChatGPT-Account-Id: <tokens.account_id>   (when present)
 *
 * Credentials come from `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`), which
 * the Codex CLI writes itself. Same policy as every provider here: read what the
 * agent already stored, never a browser cookie jar, never a prompt.
 *
 * MEASURED shape (CodexBar's own fixture, and confirmed live on this machine):
 *
 *   { "plan_type": "pro", "email": "…", "account_id": "…",
 *     "rate_limit": {
 *       "allowed": true, "limit_reached": false,
 *       "primary_window":   { "used_percent": 4,  "limit_window_seconds": 18000,
 *                             "reset_after_seconds": 8657, "reset_at": 1776216359 },
 *       "secondary_window": { "used_percent": 19, "limit_window_seconds": 604800, … } },
 *     "credits": { "has_credits": false, "unlimited": false, "balance": "0E-10" } }
 *
 * Three ways this differs from Claude, all of which the parser has to respect
 * rather than paper over:
 *
 *   1. `used_percent`, not `utilization`. Same meaning, different spelling — and
 *      guessing either name would have produced a silent zero.
 *   2. `limit_window_seconds` STATES the window length, so nothing here hardcodes
 *      five hours or seven days. Claude's payload does not, which is why its
 *      provider has those constants and this one must not.
 *   3. `reset_at` is Unix **seconds**. Treating it as milliseconds would put every
 *      reset in 1970 and every countdown at "passed" — the exact class of bug the
 *      no-invented-numbers rule exists for, arriving through a unit rather than
 *      through an absence.
 *
 * There is no `severity` field, so severity is null and the surface falls back to
 * its own thresholds. That is the designed meaning of null, not a gap.
 *
 * NOT IMPLEMENTED, deliberately: token refresh. CodexBar refreshes an access
 * token whose `last_refresh` is older than eight days. Here an expired token
 * comes back as `unauthorized` with the sentence that says to sign in again —
 * honest and useless-free, where a half-built refresh that silently writes to the
 * CLI's own auth.json would be neither.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { readCredentialFile } from '../credentials.js'
import {
  fault,
  type CostSnapshot,
  type IdentitySnapshot,
  type RateWindow,
  type UsageResult,
} from '../model.js'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const REQUEST_TIMEOUT_MS = 12_000

/** `$CODEX_HOME` wins, exactly as the CLI itself resolves it, so a user with a
 *  non-default Codex home is not told they are signed out. */
function credentialRelativePath(): string {
  const codexHome = process.env['CODEX_HOME']
  if (codexHome !== undefined && codexHome.length > 0) {
    const home = process.env['HOME'] || os.homedir()
    const rel = path.relative(home, path.join(codexHome, 'auth.json'))
    // Only usable as a home-relative path when it really is under home;
    // otherwise fall back to the default rather than emit `../../…`.
    if (!rel.startsWith('..')) return rel
  }
  return '.codex/auth.json'
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * A window's reset, as epoch **milliseconds**.
 *
 * `reset_at` is Unix seconds; `reset_after_seconds` is a relative fallback for
 * payloads that omit it. `now` is a parameter so the relative path is testable
 * without freezing the clock.
 */
export function readReset(win: Record<string, unknown>, now: number): number | null {
  const at = finite(win['reset_at'])
  // A plausible-looking `reset_at` in the past by years is a unit mistake on the
  // wire, not a reset that already happened; refusing it is safer than drawing
  // "passed" forever. 10^11 seconds is year 5138, 10^9 is 2001.
  if (at !== null && at > 1_000_000_000 && at < 100_000_000_000) return at * 1000
  const after = finite(win['reset_after_seconds'])
  if (after !== null && after >= 0) return now + after * 1000
  return null
}

interface Described {
  id: string
  title: string
}

/**
 * What to call a window, derived from the length the payload STATES.
 *
 * This replaces the first version's positional guess, which live data disproved
 * immediately: on a `prolite` account `primary_window.limit_window_seconds` is
 * 604800 — seven days — and `secondary_window` is null. Labelling that "session"
 * because of where it sat in the object put a weekly budget under a name that
 * promises it returns in hours. The key's position carries no meaning; the
 * duration does.
 */
export function describeByDuration(seconds: number | null): Described {
  if (seconds === null || seconds <= 0) return { id: 'window', title: 'window' }
  if (seconds <= 24 * 3600) return { id: 'session', title: 'session' }
  if (seconds <= 8 * 86_400) return { id: 'weekly', title: 'weekly' }
  const days = Math.round(seconds / 86_400)
  // Anything longer is named for what it is rather than mapped onto a lane we
  // recognise — a 30-day limit called "weekly" would be worse than an odd label.
  return { id: `window-${String(days)}d`, title: `${String(days)}-day` }
}

function windowFrom(
  raw: unknown,
  d: Described,
  now: number,
  scopedUnder: string | null,
): RateWindow | null {
  const rec = asRecord(raw)
  if (rec === null) return null
  const pct = finite(rec['used_percent'])
  if (pct === null) return null
  const seconds = finite(rec['limit_window_seconds'])
  return {
    id: d.id,
    title: d.title,
    // Clamp: a gauge cannot draw 104%, and over 100 is still spent.
    usedPercent: Math.max(0, Math.min(100, pct)),
    // OpenAI does not grade its own limits, so this stays null and the surface
    // uses its own thresholds. Null means "not stated", never "fine".
    severity: null,
    // Nor does it say which lane is binding. `allowed` / `limit_reached` are
    // account-wide, not per window, so claiming one window is the active one
    // would be inventing a distinction the payload does not draw.
    isActive: true,
    resetsAt: readReset(rec, now),
    windowMinutes: seconds === null || seconds <= 0 ? null : Math.round(seconds / 60),
    scopedUnder,
    // This provider reports a percentage and no counts.
    counts: null,
  }
}

/** Both lanes of one `rate_limit` object, named by their real durations. Used for
 *  the account's own limits and, unchanged, for each entry of
 *  `additional_rate_limits[]` — which carries a nested `rate_limit` of exactly
 *  the same shape. */
function windowsOf(
  rl: Record<string, unknown>,
  now: number,
  taken: Set<string>,
  opts: { titlePrefix?: string; scopedUnder?: (id: string) => string | null } = {},
): RateWindow[] {
  const out: RateWindow[] = []
  for (const key of ['primary_window', 'secondary_window']) {
    const rec = asRecord(rl[key])
    if (rec === null) continue
    const base = describeByDuration(finite(rec['limit_window_seconds']))
    // Two lanes of the same duration would collide on one id; the source key
    // disambiguates without inventing a difference in meaning.
    let id = opts.titlePrefix === undefined ? base.id : `${base.id}:${opts.titlePrefix}`
    if (taken.has(id)) id = `${id}:${key.replace('_window', '')}`
    const title = opts.titlePrefix === undefined ? base.title : opts.titlePrefix
    const w = windowFrom(rec, { id, title }, now, opts.scopedUnder?.(base.id) ?? null)
    if (w === null) continue
    taken.add(id)
    out.push(w)
  }
  return out
}

/**
 * Parse `wham/usage`. Exported so every shape can be tested without a network
 * call or a credential.
 */
export function parseCodexUsage(payload: unknown, now: number): { windows: RateWindow[] } | { error: string } {
  const root = asRecord(payload)
  if (root === null) return { error: 'usage response is not a JSON object' }
  const rl = asRecord(root['rate_limit'])
  if (rl === null) return { error: 'usage response carried no rate_limit object' }

  const taken = new Set<string>()
  const windows: RateWindow[] = windowsOf(rl, now, taken)

  /**
   * Model-scoped limits. The live shape is NOT flat — each entry is
   *
   *   { "limit_name": "GPT-5.3-Codex-Spark", "metered_feature": "codex_bengalfox",
   *     "rate_limit": { "primary_window": {…}, "secondary_window": null } }
   *
   * The first version of this parser looked for `used_percent` at the entry's top
   * level, found none, and dropped every entry silently. Dropping was the safe
   * direction — an unknown shape must never be guessed into a gauge — but it was
   * still wrong, and only a real payload showed it.
   */
  const extra = root['additional_rate_limits']
  if (Array.isArray(extra)) {
    for (const raw of extra) {
      const rec = asRecord(raw)
      if (rec === null) continue
      const name = rec['limit_name']
      if (typeof name !== 'string' || name.length === 0) continue
      const nested = asRecord(rec['rate_limit'])
      if (nested === null) continue
      windows.push(
        ...windowsOf(nested, now, taken, {
          titlePrefix: name.toLowerCase(),
          // Nest under the account lane of the same duration when there is one,
          // so a model's weekly limit sits inside weekly rather than beside it.
          scopedUnder: (laneId) => (windows.some((w) => w.id === laneId) ? laneId : null),
        }),
      )
    }
  }

  // `code_review_rate_limit` is a third lane, null on every account seen so far.
  // Read with the same helper rather than special-cased, so it appears the day it
  // is populated instead of the day someone notices.
  const review = asRecord(root['code_review_rate_limit'])
  if (review !== null) {
    windows.push(...windowsOf(review, now, taken, { titlePrefix: 'code review' }))
  }

  if (windows.length === 0) return { error: 'rate_limit carried no window with a used_percent' }
  return { windows }
}

/**
 * `credits.balance` arrives as a STRING, and not always a friendly one — the
 * fixture's own value is `"0E-10"`, which is exponent notation for zero. Number()
 * parses it correctly; a naive `parseFloat` would give 0 for the wrong reason and
 * a substring check would give NaN.
 *
 * `unlimited: true` is reported as no cost section at all rather than as an
 * infinite one: a gauge cannot draw infinity, and "unlimited" is better said in
 * words somewhere else than implied by an empty bar here.
 */
export function parseCodexCredits(payload: unknown): CostSnapshot | null {
  const root = asRecord(payload)
  if (root === null) return null
  const c = asRecord(root['credits'])
  if (c === null) return null
  if (c['unlimited'] === true) return null

  const raw = c['balance']
  const balance = typeof raw === 'string' ? Number(raw) : finite(raw)
  if (balance === null || Number.isNaN(balance)) return null

  const hasCredits = c['has_credits'] === true
  // Credits are a balance REMAINING, not an amount spent, so there is no `used` to
  // report and the union no longer asks for one. A balance with no arrangement, or
  // an empty one, is `enabled: false` — which the surface draws as "not enabled"
  // rather than as a spent budget.
  if (!hasCredits || balance <= 0) {
    return { enabled: false, currency: 'USD', period: 'no credit balance' }
  }
  return {
    enabled: true,
    // The remaining balance is what OpenAI states; `limit` is unknown, so the
    // surface shows a figure and no gauge rather than a gauge against a guess.
    used: 0,
    limit: null,
    currency: 'USD',
    period: `credit balance ${balance.toFixed(2)}`,
  }
}

export function planLabel(planType: unknown): string | null {
  if (typeof planType !== 'string' || planType.length === 0) return null
  // `plan_type` is already a short slug (`pro`, `plus`, `free`, `go`). Underscores
  // become spaces and nothing else is invented — an unknown plan is passed
  // through rather than mapped to a guess, because CodexBar hit exactly that
  // (`prolite` rejected as an "unknown variant") and a surface that blanks an
  // unrecognised plan is less useful than one that shows it verbatim.
  return planType.replace(/_/g, ' ')
}

export async function fetchCodexUsage(_opts: { allowInteractive: boolean }): Promise<UsageResult> {
  const rel = credentialRelativePath()
  const lookup = readCredentialFile(rel)
  if (!lookup.found) {
    if (lookup.reason === 'malformed') return fault('malformed', lookup.detail)
    return fault('no_credentials', `${lookup.detail} — sign in with \`codex\` first`)
  }

  const tokens = asRecord(lookup.credential.data['tokens'])
  const accessToken = tokens === null ? null : tokens['access_token']
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return fault('no_credentials', `${lookup.credential.describe} has no access token`)
  }
  const accountId = tokens !== null && typeof tokens['account_id'] === 'string' ? tokens['account_id'] : null

  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
  }
  // Account-scoped, when the CLI recorded an account. Omitted rather than sent
  // empty: an empty account header is not the same request as no account header.
  if (accountId !== null && accountId.length > 0) headers['chatgpt-account-id'] = accountId

  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return fault('network', `could not reach chatgpt.com: ${msg}`)
  }

  if (response.status === 401) {
    return fault(
      'unauthorized',
      'the stored Codex token was rejected — run `codex` and sign in again (Jerico does not refresh it)',
    )
  }
  if (response.status === 403) {
    return fault('scope_insufficient', 'this Codex token is not allowed to read usage')
  }
  if (!response.ok) {
    return fault('network', `chatgpt.com returned HTTP ${String(response.status)}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return fault('malformed', 'usage response was not valid JSON')
  }

  const now = Date.now()
  const parsed = parseCodexUsage(body, now)
  if ('error' in parsed) return fault('malformed', parsed.error)

  const root = asRecord(body)
  const identity: IdentitySnapshot = {
    plan: planLabel(root?.['plan_type']),
    loginMethod: 'OAuth',
    accountId,
  }

  return {
    ok: true,
    snapshot: {
      agent: 'codex',
      windows: parsed.windows,
      cost: parseCodexCredits(body),
      identity,
      fetchedAt: now,
      source: `chatgpt.com · ~/${rel}`,
    },
  }
}
