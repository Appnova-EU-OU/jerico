/**
 * The normalised usage snapshot every provider returns.
 *
 * One shape, because there are three consumers with three different needs and
 * none of them should learn a provider's wire format: the popover's limits
 * register wants the single most-constrained window, the usage window wants all
 * of them, and orchestration routing wants to know whether an agent is about to
 * hit a wall before it dispatches work to it.
 *
 * The governing rule is inherited from `apps/desktop/src/main/utils/popover-model.ts`:
 * NOTHING in this file may invent a number. A window the provider did not report
 * is absent from `windows`, and a window it reported without a reset time carries
 * `resetsAt: null`. Absent is not zero, and null is not "now" — an empty gauge
 * reads as "plenty left", which is the most expensive thing this feature could
 * get wrong.
 */

/** A provider's own key for the window, verbatim (`five_hour`, `seven_day`,
 *  `seven_day_opus`). Kept unmapped so a log line can be matched against the
 *  provider's documentation without a translation table. */
export type WindowId = string

/** The provider's OWN judgement of how bad a number is, when it offers one.
 *  Preferred over a threshold we invent here: Anthropic knows which of its
 *  limits is binding and we do not. `null` means the provider said nothing and
 *  the consumer may fall back to its own thresholds. */
export type Severity = 'normal' | 'warning' | 'critical' | null

export interface RateWindow {
  id: WindowId
  /** What the surface calls it: `session`, `weekly`, or a model's display name. */
  title: string
  /** 0–100. The provider's own utilization, never a local estimate. */
  usedPercent: number
  severity: Severity
  /** Whether the provider considers this limit currently in force. A scoped
   *  window for a model you are not using is reported and inactive. */
  isActive: boolean
  /** Epoch ms, or null when the provider reported a utilization and no reset.
   *  `seven_day_opus` does exactly that, so null is a real state and not an
   *  error — see AGENT-USAGE-PROVIDERS.md. */
  resetsAt: number | null
  /** Nominal window length in minutes, when the provider states one. Used only
   *  to compute pace; never drawn on its own. */
  windowMinutes: number | null
  /** A model-scoped window (`seven_day_opus`) belongs UNDER its parent window
   *  rather than beside it: it is a sub-limit of weekly, not a fourth budget. */
  scopedUnder: WindowId | null
  /**
   * The raw counts, when the provider states them instead of a percentage.
   *
   * Anthropic and OpenAI both report `utilization` / `used_percent` and no
   * counts; Kimi reports `{"limit":"2048","used":"214"}` and no percentage. For
   * Kimi the percentage above is computed from these two numbers — arithmetic on
   * what was given, not an invented ceiling — and keeping the pair means the
   * surface can say "214 of 2048 requests" instead of throwing away the more
   * useful of the two facts.
   *
   * null means the provider gave a percentage only. It does NOT mean zero.
   */
  counts: { used: number; limit: number } | null
}

/**
 * Money, and the one place this model refused to be honest until a reviewer said so.
 *
 * It used to be a single shape with `enabled: boolean` and a `used: number` — so a
 * provider reporting "there is no spend arrangement" had to put a number in a field
 * meaning "money spent", and every one of them put `0`. Nobody reported that zero.
 * It was also published: `bridge-agent usage --json` dumps the snapshot verbatim and
 * `/health` carries it, both without consulting `enabled`.
 *
 * A union makes the lie unrepresentable. There is no `used` to fabricate when there
 * is nothing to spend.
 */
export type CostSnapshot =
  | {
      enabled: false
      /** ISO 4217, kept even when disabled: the surface can still say which
       *  currency the arrangement WOULD be in, and it costs nothing to be right. */
      currency: string
      period: string | null
    }
  | {
      enabled: true
      /** In `currency` major units. A provider that reports minor units divides at
       *  its own boundary — Anthropic sends `decimal_places` for exactly this, so
       *  the scale is read rather than assumed. */
      used: number
      limit: number | null
      currency: string
      period: string | null
    }

export interface IdentitySnapshot {
  /** The provider's own plan name (`max_20x` → `max 20x`). A READING, not a
   *  setting: this is what removes `claudeTier` from ~/.jerico/settings.json. */
  plan: string | null
  loginMethod: string | null
  accountId: string | null
}

export interface UsageSnapshot {
  agent: string
  /** Parent windows first, then their scoped children. Empty is legal — a
   *  provider can authenticate and report nothing yet. */
  windows: RateWindow[]
  cost: CostSnapshot | null
  identity: IdentitySnapshot
  /** Epoch ms this snapshot was taken. Every surface draws it, because a reading
   *  without a timestamp becomes a claim about the present the moment it goes
   *  stale. */
  fetchedAt: number
  /** Where it came from, for the surface's own "updated 14s ago · <source>"
   *  line. A user who can see the source can diagnose a wrong number. */
  source: string
  /** Credential provenance is behavior, unlike `source`, which is display copy. */
  credentialSource?: 'file' | 'keychain' | 'agent_cli'
}

/**
 * Why a provider could not answer. Each code is a DIFFERENT sentence and a
 * different remedy on the surface, which is the whole reason this is not a
 * boolean: "we have never had a fetcher for this agent" and "the token is
 * refused" both lack a number, and only one of them is actionable.
 */
export type UsageFaultCode =
  /** No credential found at any known location. */
  | 'no_credentials'
  /** A credential container exists but has no token this provider can use. */
  | 'no_usage_token'
  /** A credential was found and is not permitted to read usage — a Claude token
   *  carrying only `user:inference` is the documented case. Retrying is exactly
   *  what will not help, so the surface must not offer it. */
  | 'scope_insufficient'
  /** The credential was rejected outright (expired, revoked). */
  | 'unauthorized'
  /** A stored token was locally expired and was deliberately not sent. */
  | 'token_lapsed'
  /** The credential exists but is locked behind an interactive prompt this call
   *  was not allowed to raise. Not a failure: the honest state of a background
   *  refresh under the "never prompt in the background" policy. */
  | 'keychain_locked'
  /** A background refresh deliberately skipped a possibly-prompting keychain read. */
  | 'keychain_deferred'
  /** An agent CLI is intentionally only queried after a person opens usage. */
  | 'interactive_deferred'
  /** Could not reach the provider. Distinct from every code above because the
   *  last known snapshot is still worth drawing, dated. */
  | 'network'
  /** Reached the provider and could not understand the answer. A wire change,
   *  and the one code that should raise a maintenance alarm rather than ask the
   *  user for anything. */
  | 'malformed'
  /** No fetcher exists for this agent yet. The honest default for most agents,
   *  and NOT an error. */
  | 'unsupported'
  /**
   * The provider answered, and there is genuinely nothing to meter — every one of
   * its buckets is unlimited.
   *
   * Distinct from `malformed`, which the first version used for this and which
   * means "the wire format changed". An account with no ceilings is CORRECT: the
   * user was being told something was broken, and a maintenance alarm was firing,
   * for a perfectly healthy plan.
   */
  | 'no_limits'

export type UsageResult =
  | { ok: true; snapshot: UsageSnapshot }
  | { ok: false; code: UsageFaultCode; detail: string; at: number }

export function fault(code: UsageFaultCode, detail: string): UsageResult {
  return { ok: false, code, detail, at: Date.now() }
}

// ── derived readings ────────────────────────────────────────────────────────

/**
 * The window the surface should lead with: the one closest to its ceiling.
 *
 * This is the only honest single number for an agent, because an agent is
 * limited by whichever ceiling it reaches first — a comfortable session next to
 * a 96% weekly Opus budget is not a comfortable agent.
 */
export function mostConstrained(s: UsageSnapshot): RateWindow | null {
  let worst: RateWindow | null = null
  for (const w of s.windows) {
    if (worst === null || w.usedPercent > worst.usedPercent) worst = w
  }
  return worst
}

/**
 * Whether the burn rate will outlast the window.
 *
 * Arithmetic on two numbers we already have, never a new measurement: compare
 * how much of the budget is gone with how much of the clock is gone. Returns
 * null when the window carries no reset or no length, because then there is no
 * clock to compare against and a pace would be invented.
 */
export function pace(w: RateWindow, now: number): { gapPercent: number; willLast: boolean } | null {
  if (w.resetsAt === null || w.windowMinutes === null || w.windowMinutes <= 0) return null
  const windowMs = w.windowMinutes * 60_000
  const remainingMs = w.resetsAt - now
  if (remainingMs <= 0 || remainingMs > windowMs) return null
  const elapsedFraction = (windowMs - remainingMs) / windowMs
  const gapPercent = Math.round(w.usedPercent - elapsedFraction * 100)
  return { gapPercent, willLast: gapPercent <= 0 }
}
