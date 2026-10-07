/**
 * Kimi usage, from Moonshot's own endpoint.
 *
 *   GET https://api.kimi.com/coding/v1/usages
 *   Authorization: Bearer <access_token>
 *
 * The token comes from `~/.kimi-code/credentials/kimi-code.json`, which the Kimi
 * Code CLI writes — the same file `pty/agents.ts` `checkAuth` already reads to
 * decide whether `kimi` can be spawned. `KIMI_CODE_API_KEY` / `KIMI_API_KEY` are
 * accepted as an override, because a user who set one is telling us which
 * identity to ask about.
 *
 * READ-ONLY, and the consequence is bigger here than anywhere else — say it
 * plainly rather than discover it in the field:
 *
 * MEASURED on this machine: the CLI credential's `expires_in` is **900** — the
 * access token lives fifteen minutes. The file also carries a `refresh_token`,
 * and this file never touches it, because providers commonly ROTATE a refresh
 * token when it is used: spending it would invalidate the copy the Kimi CLI holds
 * and break the user's own sign-in. A monitoring feature that logs its subject out
 * is worse than one that says it cannot see.
 *
 * MEASURED, and it corrects an earlier assumption in this file: a RUNNING kimi does
 * not keep the token fresh. Observed with pid 99465 alive, the credential file
 * unwritten for 91 minutes and its token 76 minutes expired — the CLI refreshes
 * when it next makes a request, not merely by being open. So the reading is
 * available shortly after kimi does any work and unavailable once it has been idle
 * for a quarter of an hour.
 *
 * The durable path is a user-supplied API key. It is read from the profile's
 * settings file rather than only the environment, because the launchd plist has no
 * `EnvironmentVariables` block: an exported key never reaches the daemon that
 * actually runs, which made the first version's advice true for a foreground run
 * and useless for every real install.
 *
 * There is no third option. Asking the running process — the tactic that solved
 * agy — does not apply: kimi listens on no TCP port at all (measured). And the
 * reference implementation has exactly three strategies for this provider (API key,
 * this same credential file, browser cookies), so its answer to the fifteen minutes
 * is the API key or the cookie jar, and the cookie jar is out of policy here.
 *
 * MEASURED shape (CodexBar's documented response, confirmed live):
 *
 *   { "usage":  { "limit": "2048", "used": "214", "remaining": "1834",
 *                 "resetTime": "2026-01-09T15:23:13.716839300Z" },
 *     "limits": [ { "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
 *                   "detail": { "limit": "200", "used": "139", "remaining": "61",
 *                               "resetTime": "…" } } ] }
 *
 * THREE ways this differs from every provider before it:
 *
 *   1. Every number is a STRING. `"2048"`, not 2048. A parser that checked
 *      `typeof === 'number'` — which both earlier providers correctly do — would
 *      find nothing here and report an empty account.
 *   2. There is NO percentage. Anthropic and OpenAI hand over `utilization` /
 *      `used_percent`; Kimi hands over a limit and a used count, so the percentage
 *      is computed. That is arithmetic on two supplied numbers, not an invented
 *      ceiling — and the pair is kept in `counts` so the surface can say
 *      "139 of 200" rather than only "70%".
 *   3. The window length arrives as a duration plus a UNIT
 *      (`300` + `TIME_UNIT_MINUTE`). Reading the number without the unit would
 *      turn five hours into five minutes.
 *
 * `resetTime` carries nanoseconds (`…13.716839300Z`). `Date.parse` truncates to
 * milliseconds, which is exactly the precision anything here needs.
 */

import { readCredentialFile } from '../credentials.js'
import { readProviderKey } from '../settings.js'
import { fault, type IdentitySnapshot, type RateWindow, type UsageResult } from '../model.js'

const USAGE_URL = 'https://api.kimi.com/coding/v1/usages'
const CREDENTIAL_FILE = '.kimi-code/credentials/kimi-code.json'
const REQUEST_TIMEOUT_MS = 12_000
/** See isExpired(). */
const EXPIRY_MARGIN_MS = 60_000

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * A number that may have arrived as a string.
 *
 * Only used for Kimi, and deliberately not pushed into a shared helper: the other
 * providers send real numbers, and a lenient reader there would accept a string
 * where a wire change should be noticed instead.
 */
export function numeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function readIsoReset(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/**
 * `{ duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }` → 300 minutes.
 *
 * An unrecognised unit yields null rather than a guess: a window of unknown length
 * still shows its percentage and simply gets no pace projection, which is the
 * honest degradation. Silently assuming minutes would turn a 300-SECOND window
 * into a five-hour one.
 */
export function windowMinutes(win: unknown): number | null {
  const rec = asRecord(win)
  if (rec === null) return null
  const duration = numeric(rec['duration'])
  if (duration === null || duration <= 0) return null
  switch (rec['timeUnit']) {
    case 'TIME_UNIT_MINUTE': return duration
    case 'TIME_UNIT_HOUR': return duration * 60
    case 'TIME_UNIT_DAY': return duration * 1440
    case 'TIME_UNIT_SECOND': return duration / 60
    default: return null
  }
}

/** Minutes → the same lane names the other providers use, so one register can mix
 *  agents without three vocabularies. Derived from the length, never a position. */
export function describeMinutes(minutes: number | null): { id: string; title: string } {
  if (minutes === null || minutes <= 0) return { id: 'quota', title: 'quota' }
  if (minutes <= 1440) return { id: 'session', title: 'session' }
  if (minutes <= 8 * 1440) return { id: 'weekly', title: 'weekly' }
  const days = Math.round(minutes / 1440)
  return { id: `window-${String(days)}d`, title: `${String(days)}-day` }
}

function windowFrom(
  detail: Record<string, unknown>,
  d: { id: string; title: string },
  minutes: number | null,
): RateWindow | null {
  const limit = numeric(detail['limit'])
  // `used` OR `remaining`, because the live payload does not always send both.
  //
  // MEASURED 2026-08-11: Moonshot's documented example carries all three
  // (`limit: "200", used: "139", remaining: "61"`), but the real response's
  // `limits[].detail` carried only `limit` and `remaining` — no `used` at all.
  // Requiring `used` therefore DROPPED the five-hour window silently, leaving the
  // membership pool as the only row. Deriving it from the pair that did arrive is
  // arithmetic on given numbers, not an invention; and the derivation is clamped
  // because a `remaining` above `limit` would otherwise produce negative usage.
  const explicitUsed = numeric(detail['used'])
  const remaining = numeric(detail['remaining'])
  const used =
    explicitUsed ??
    (limit !== null && remaining !== null ? Math.max(0, Math.min(limit, limit - remaining)) : null)
  if (limit === null || used === null) return null
  // A zero or negative limit cannot be turned into a percentage. Reporting 0%
  // would say "plenty left" about an account with no allowance at all, and 100%
  // would say the opposite; refusing the window is the only honest option.
  if (limit <= 0) return null
  return {
    id: d.id,
    title: d.title,
    usedPercent: Math.max(0, Math.min(100, (used / limit) * 100)),
    // Moonshot does not grade its own limits.
    severity: null,
    isActive: true,
    resetsAt: readIsoReset(detail['resetTime']),
    windowMinutes: minutes,
    scopedUnder: null,
    counts: { used, limit },
  }
}

/**
 * Parse `coding/v1/usages`. Exported so every shape is testable without a network
 * call or a credential.
 */
export function parseKimiUsage(payload: unknown): { windows: RateWindow[] } | { error: string } {
  const root = asRecord(payload)
  if (root === null) return { error: 'usage response is not a JSON object' }

  const windows: RateWindow[] = []
  const taken = new Set<string>()

  // The rate-limit windows first: those are the ones that stop a run mid-task.
  const limits = root['limits']
  if (Array.isArray(limits)) {
    for (const raw of limits) {
      const rec = asRecord(raw)
      if (rec === null) continue
      const detail = asRecord(rec['detail'])
      if (detail === null) continue
      const minutes = windowMinutes(rec['window'])
      const base = describeMinutes(minutes)
      let id = base.id
      // Two windows of the same class would collide; the index disambiguates
      // without claiming they differ in kind.
      if (taken.has(id)) id = `${id}-${String(windows.length)}`
      const w = windowFrom(detail, { id, title: base.title }, minutes)
      if (w === null) continue
      taken.add(id)
      windows.push(w)
    }
  }

  // Then the membership pool. It carries a reset and no duration, so it is named
  // `quota` rather than mapped onto a lane whose length we would be inventing.
  const usage = asRecord(root['usage'])
  if (usage !== null) {
    const id = taken.has('quota') ? 'quota-pool' : 'quota'
    const w = windowFrom(usage, { id, title: 'quota' }, null)
    if (w !== null) {
      taken.add(id)
      windows.push(w)
    }
  }

  if (windows.length === 0) {
    return { error: 'usage response carried no window with a usable limit and used count' }
  }
  // Short windows first: a five-hour ceiling is more urgent than a monthly pool.
  windows.sort((a, b) => (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) - (b.windowMinutes ?? Number.MAX_SAFE_INTEGER))
  return { windows }
}

/** The credential's own expiry, checked BEFORE spending a request — the same
 *  reason Claude's scope list is checked locally. `expires_at` is epoch seconds in
 *  the file the CLI writes. */
export function isExpired(data: Record<string, unknown>, now: number): boolean {
  const at = numeric(data['expires_at'])
  if (at === null) return false
  // Tolerate a file written with milliseconds rather than declaring it expired.
  const ms = at > 100_000_000_000 ? at : at * 1000
  // A SIXTY-SECOND MARGIN, taken from the reference implementation, which requires
  // `expiresAt > now + 60`. Without it a token with four seconds left counts as
  // valid, the request goes out, and the answer arrives after it died — reported
  // as `unauthorized` when the honest answer was "expired". The margin turns a
  // race into a straight reading.
  return ms <= now + EXPIRY_MARGIN_MS
}

export async function fetchKimiUsage(_opts: { allowInteractive: boolean }): Promise<UsageResult> {
  // The environment for a foreground run, the settings file for the launchd
  // service — which carries no EnvironmentVariables block, so an exported key
  // never reaches it. See usage/settings.ts.
  const supplied = readProviderKey(['KIMI_CODE_API_KEY', 'KIMI_API_KEY'], 'kimiApiKey')
  let token = ''
  let describe = ''

  if (supplied !== null) {
    token = supplied.value
    describe = supplied.describe
  } else {
    const lookup = readCredentialFile(CREDENTIAL_FILE)
    if (!lookup.found) {
      if (lookup.reason === 'malformed') return fault('malformed', lookup.detail)
      return fault('no_credentials', `${lookup.detail} — sign in with \`kimi\` first`)
    }
    const access = lookup.credential.data['access_token']
    if (typeof access !== 'string' || access.length === 0) {
      return fault('no_credentials', `${lookup.credential.describe} has no access token`)
    }
    if (isExpired(lookup.credential.data, Date.now())) {
      return kimiTokenLapsedFault()
    }
    token = access
    describe = lookup.credential.describe
  }

  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return fault('network', `could not reach api.kimi.com: ${msg}`)
  }

  if (response.status === 401) {
    return fault(
      'unauthorized',
      supplied !== null
        ? `the Kimi API key from ${supplied.describe} was rejected`
        : 'the stored Kimi CLI token was rejected (they last ~15 minutes) — set "kimiApiKey" in ~/.jerico/settings.json for a durable reading',
    )
  }
  if (response.status === 403) {
    return fault('scope_insufficient', 'this Kimi credential is not allowed to read usage')
  }
  if (!response.ok) {
    return fault('network', `api.kimi.com returned HTTP ${String(response.status)}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return fault('malformed', 'usage response was not valid JSON')
  }

  const parsed = parseKimiUsage(body)
  if ('error' in parsed) return fault('malformed', parsed.error)

  const identity: IdentitySnapshot = {
    // The usages response carries no plan name. Null rather than a guess: the
    // surface draws no badge, which is correct — we do not know the tier.
    plan: null,
    loginMethod: supplied !== null ? 'API key' : 'CLI credential',
    accountId: null,
  }

  return {
    ok: true,
    snapshot: {
      agent: 'kimi',
      windows: parsed.windows,
      cost: null,
      identity,
      fetchedAt: Date.now(),
      source: `api.kimi.com · ${describe}`,
    },
  }
}

export function kimiTokenLapsedFault(): UsageResult {
  return fault(
    'token_lapsed',
    'reading paused — sign in to kimi, or add a Kimi API key (`kimiApiKey` in the profile settings) for a reading that never pauses',
  )
}
