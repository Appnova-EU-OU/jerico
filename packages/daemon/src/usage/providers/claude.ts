/**
 * Claude usage, from Anthropic's own endpoint.
 *
 *   GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <accessToken>
 *   anthropic-beta: oauth-2025-04-20
 *
 * This replaces an estimate with an authority, which is the entire reason the
 * provider work is worth doing. `packages/daemon/src/pty/claude-quota.ts` counts
 * user prompts out of ~/.claude/projects/**.jsonl inside a five-hour window and
 * compares them against a limit derived from a `claudeTier` field the user sets
 * BY HAND. Both are admitted limitations: the count is "a good guess but not
 * exact" because Anthropic's real sliding-window algorithm is unknown, and the
 * tier is manual. Neither survives this file — `utilization` is
 * Anthropic's own number and `subscriptionType` is Anthropic's own plan.
 *
 * MEASURED against a real Max account, 2026-08-11. The response carries a
 * self-describing `limits` array, and that — not the top-level keys — is what we
 * read:
 *
 *   "limits": [
 *     { "kind": "session",       "group": "session", "percent": 5,  "severity": "normal",
 *       "resets_at": "…", "scope": null, "is_active": false },
 *     { "kind": "weekly_all",    "group": "weekly",  "percent": 40, "severity": "normal",
 *       "resets_at": "…", "scope": null, "is_active": true },
 *     { "kind": "weekly_scoped", "group": "weekly",  "percent": 0,  "severity": "normal",
 *       "resets_at": null, "scope": { "model": { "display_name": "Fable" } }, "is_active": false },
 *   ]
 *
 * WHY THE ARRAY AND NOT THE TOP-LEVEL KEYS. The same response also carries
 * `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
 * `seven_day_cowork`, `seven_day_omelette` — and `tangelo`, `iguana_necktie`,
 * `nimbus_quill`, `cinder_cove`, `amber_ladder`, `omelette_promotional`. Those
 * last six are internal codenames for limits that are not user-facing concepts.
 * Most are null, but not always: on the account this was written against
 * `nimbus_quill` was a live object with `utilization: 0`. A parser that walks
 * every key therefore renders a row labelled "nimbus quill" to a user — the
 * first version of this file did exactly that, and it is why the array won.
 *
 * The array is also strictly better data: it states the `group` (so nesting is
 * read, not inferred from a key prefix), the model's `display_name` (so a scoped
 * window is titled "Fable" rather than a codename), Anthropic's own `severity`
 * (so the colour is not our threshold), and `is_active` (so a scoped limit for a
 * model you are not using is not presented as binding).
 *
 * The edges that remain, all real: `percent` is ALREADY a percentage — there is
 * no prompt count to be had, which is why the local JSONL estimate cannot simply
 * be relabelled. `resets_at` can be null on a live window. And `extra_usage`
 * carries `is_enabled: false` with every figure null, which must render as "no
 * arrangement" and never as a zero balance.
 */

import { resolveCredential } from '../credentials.js'
import {
  fault,
  type CostSnapshot,
  type IdentitySnapshot,
  type RateWindow,
  type Severity,
  type UsageResult,
} from '../model.js'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'
const CREDENTIAL_FILE = '.claude/.credentials.json'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const REQUEST_TIMEOUT_MS = 12_000

/** Reading usage needs this scope. A CLI token minted with only `user:inference`
 *  authenticates fine and cannot call the endpoint, so the scope list lets us
 *  report that WITHOUT spending a request to be told. */
const REQUIRED_SCOPE = 'user:profile'

const FIVE_HOUR_MINUTES = 5 * 60
const SEVEN_DAY_MINUTES = 7 * 24 * 60

interface OAuthBlob {
  accessToken?: unknown
  scopes?: unknown
  subscriptionType?: unknown
  rateLimitTier?: unknown
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function hasUsableClaudeOAuth(data: Record<string, unknown>): boolean {
  const oauth = asRecord(data['claudeAiOauth'])
  return oauth !== null && typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0
}

/**
 * `default_claude_max_20x` → `max 20x`, `max` → `max`, `pro` → `pro`.
 *
 * The multiplier matters and is the reason this is not a passthrough: a Max 5x
 * and a Max 20x account read the same percentages against very different real
 * ceilings, and an operator comparing two machines needs to see which is which.
 */
export function planLabel(subscriptionType: unknown, rateLimitTier: unknown): string | null {
  // An EMPTY string is absent, not a plan. Without this the fallback chain
  // returns '' and the surface draws an empty plan badge, which reads as a
  // rendering bug rather than as "the provider did not say".
  const tier = typeof rateLimitTier === 'string' && rateLimitTier.length > 0 ? rateLimitTier : null
  if (tier !== null) {
    const m = /^default_claude_max_(\d+)x$/.exec(tier)
    if (m) return `max ${m[1]}x`
  }
  const sub = typeof subscriptionType === 'string' && subscriptionType.length > 0 ? subscriptionType : null
  if (sub !== null) return sub.replace(/_/g, ' ')
  if (tier !== null) return tier.replace(/^default_claude_/, '').replace(/_/g, ' ')
  return null
}

const SESSION_ID = 'session'
const WEEKLY_ID = 'weekly'

/** Only the three kinds the API documents through `limits[]`. An unrecognised
 *  kind is DROPPED rather than guessed at: this is the exact decision that keeps
 *  `nimbus_quill` off the user's screen, and a new kind should reach a surface
 *  through a deliberate release, not through a wildcard. */
function describeKind(
  kind: string,
  group: string,
  scopeModel: string | null,
): { id: string; title: string; minutes: number | null; scopedUnder: string | null } | null {
  if (kind === 'session') return { id: SESSION_ID, title: 'session', minutes: FIVE_HOUR_MINUTES, scopedUnder: null }
  if (kind === 'weekly_all') return { id: WEEKLY_ID, title: 'weekly', minutes: SEVEN_DAY_MINUTES, scopedUnder: null }
  if (kind === 'weekly_scoped') {
    // Titled by the model's own display name. Without one there is nothing
    // honest to call the row, so it is dropped rather than labelled "scoped".
    if (scopeModel === null) return null
    return {
      id: `${WEEKLY_ID}:${scopeModel.toLowerCase()}`,
      title: scopeModel.toLowerCase(),
      minutes: SEVEN_DAY_MINUTES,
      scopedUnder: WEEKLY_ID,
    }
  }
  // A future group we do not model yet: keep the group as the parent when it is
  // one we know, otherwise ignore the entry entirely.
  if (group === 'session' || group === 'weekly') return null
  return null
}

function readSeverity(v: unknown): Severity {
  return v === 'warning' || v === 'critical' || v === 'normal' ? v : null
}

function readReset(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const parsed = Date.parse(v)
  // An unparseable timestamp is treated as absent rather than as an error: the
  // percentage is still true and still worth drawing.
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Parse the usage payload's `limits` array.
 *
 * Exported so every shape that matters can be tested without a network call or a
 * credential — including the ones that only occur on someone else's account.
 */
export function parseUsageResponse(payload: unknown): { windows: RateWindow[] } | { error: string } {
  const root = asRecord(payload)
  if (root === null) return { error: 'usage response is not a JSON object' }
  const limits = root['limits']
  if (!Array.isArray(limits)) {
    return { error: 'usage response carried no limits array' }
  }

  const parents: RateWindow[] = []
  const scoped: RateWindow[] = []

  for (const entry of limits) {
    const rec = asRecord(entry)
    if (rec === null) continue
    const kind = rec['kind']
    const group = rec['group']
    const percent = rec['percent']
    if (typeof kind !== 'string' || typeof group !== 'string') continue
    if (typeof percent !== 'number' || !Number.isFinite(percent)) continue

    const scopeRec = asRecord(rec['scope'])
    const modelRec = scopeRec === null ? null : asRecord(scopeRec['model'])
    const display = modelRec === null ? null : modelRec['display_name']
    const scopeModel = typeof display === 'string' && display.length > 0 ? display : null

    const d = describeKind(kind, group, scopeModel)
    if (d === null) continue

    const window: RateWindow = {
      id: d.id,
      title: d.title,
      // Clamp: a gauge cannot draw 104%, and anything over 100 is still "spent",
      // so the clamp loses nothing a user would act on.
      usedPercent: Math.max(0, Math.min(100, percent)),
      severity: readSeverity(rec['severity']),
      isActive: rec['is_active'] === true,
      resetsAt: readReset(rec['resets_at']),
      windowMinutes: d.minutes,
      scopedUnder: d.scopedUnder,
      // This provider reports a percentage and no counts.
      counts: null,
    }
    if (d.scopedUnder === null) parents.push(window)
    else scoped.push(window)
  }

  if (parents.length === 0 && scoped.length === 0) {
    return { error: 'limits array carried no recognised window' }
  }

  // session before weekly, so a consumer rendering in order matches the design.
  parents.sort((a, b) => (a.id === SESSION_ID ? -1 : b.id === SESSION_ID ? 1 : a.id.localeCompare(b.id)))
  return { windows: [...parents, ...scoped] }
}

/**
 * `extra_usage` — the monthly overage arrangement.
 *
 * Returns null when the key is absent, and an object with `enabled: false` when
 * the account has the arrangement switched off. The difference matters: absent
 * means we do not know, disabled means we know there is no budget, and neither
 * may be drawn as a zero balance.
 *
 * `decimal_places` is read rather than assumed. The reference normalises a
 * `monthly_credit_limit` of 2000 to 20.00, i.e. cents — but the live payload
 * ships the scale explicitly, so nothing here hardcodes 100.
 */
export function parseExtraUsage(payload: unknown): CostSnapshot | null {
  const root = asRecord(payload)
  if (root === null) return null
  const extra = asRecord(root['extra_usage'])
  if (extra === null) return null

  const enabled = extra['is_enabled'] === true
  const places = typeof extra['decimal_places'] === 'number' ? extra['decimal_places'] : 0
  const scale = Math.pow(10, Math.max(0, Math.min(6, places)))
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v / scale : null

  const used = num(extra['used_credits'])
  const limit = num(extra['monthly_limit'])
  const currency = typeof extra['currency'] === 'string' && extra['currency'].length > 0 ? extra['currency'] : 'USD'

  if (!enabled) return { enabled: false, currency, period: 'monthly cap' }
  // Enabled and yet reporting nothing usable is a wire surprise, and it is reported
  // as "no arrangement" rather than as a zero balance — which is the honest reading
  // of "the provider says it is on and will not say how much".
  if (used === null) return { enabled: false, currency, period: 'monthly cap' }
  return { enabled: true, used, limit, currency, period: 'monthly cap' }
}

export async function fetchClaudeUsage(opts: { allowInteractive: boolean }): Promise<UsageResult> {
  const lookup = await resolveCredential({
    file: CREDENTIAL_FILE,
    keychainService: KEYCHAIN_SERVICE,
    allowInteractive: opts.allowInteractive,
    acceptFile: hasUsableClaudeOAuth,
  })
  if (!lookup.found) {
    if (lookup.reason === 'keychain_deferred') return fault('keychain_deferred', lookup.detail)
    if (lookup.reason === 'keychain_locked') return fault('keychain_locked', lookup.detail)
    if (lookup.reason === 'malformed') return fault('malformed', lookup.detail)
    return fault('no_usage_token', lookup.detail)
  }

  const oauth = asRecord(lookup.credential.data['claudeAiOauth']) as OAuthBlob | null
  if (oauth === null) {
    // Documented and real: on Claude Code 2.1.x the keychain item can hold only
    // MCP server OAuth state. The credential is present and simply is not the
    // one that can answer, which is a different sentence from "not signed in".
    const hasMcpOnly = asRecord(lookup.credential.data['mcpOAuth']) !== null
    return fault(
      'no_usage_token',
      hasMcpOnly
        ? `${lookup.credential.describe} holds only MCP OAuth state (no claudeAiOauth); no usage token is available`
        : `${lookup.credential.describe} has no claudeAiOauth entry`,
    )
  }

  const token = oauth.accessToken
  if (typeof token !== 'string' || token.length === 0) {
    return fault('no_usage_token', `${lookup.credential.describe} has no usable Claude usage token`)
  }

  // Check the scope BEFORE spending a request. A token that cannot read usage
  // says so in its own scope list, and a 403 would tell us the same thing more
  // slowly and less precisely.
  const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.filter((s): s is string => typeof s === 'string') : null
  if (scopes !== null && !scopes.includes(REQUIRED_SCOPE)) {
    return fault(
      'scope_insufficient',
      `this token carries ${scopes.join(', ') || 'no scopes'} — reading usage requires ${REQUIRED_SCOPE}`,
    )
  }

  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return fault('network', `could not reach api.anthropic.com: ${msg}`)
  }

  if (response.status === 401) {
    return fault('unauthorized', 'the access token was rejected — sign in to Claude Code again')
  }
  if (response.status === 403) {
    // 403 rather than 401 is the shape a scope problem takes when the token did
    // not enumerate its scopes locally, so it gets the same code and remedy.
    return fault('scope_insufficient', `usage is forbidden for this token — it likely lacks ${REQUIRED_SCOPE}`)
  }
  if (!response.ok) {
    return fault('network', `api.anthropic.com returned HTTP ${String(response.status)}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return fault('malformed', 'usage response was not valid JSON')
  }

  const parsed = parseUsageResponse(body)
  if ('error' in parsed) return fault('malformed', parsed.error)

  const root = asRecord(body)
  const identity: IdentitySnapshot = {
    // Prefer whatever the response states; fall back to the credential, which
    // carries subscriptionType on every install seen so far.
    plan:
      planLabel(root?.['subscription_type'] ?? root?.['subscriptionType'], root?.['rate_limit_tier']) ??
      planLabel(oauth.subscriptionType, oauth.rateLimitTier),
    loginMethod: 'OAuth',
    accountId: null,
  }

  return {
    ok: true,
    snapshot: {
      agent: 'claude',
      windows: parsed.windows,
      cost: parseExtraUsage(body),
      identity,
      fetchedAt: Date.now(),
      source: `api.anthropic.com · ${lookup.credential.describe}`,
      credentialSource: lookup.credential.source,
    },
  }
}
