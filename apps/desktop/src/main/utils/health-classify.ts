/**
 * Turning one /health response into something the app may act on.
 *
 * Pure, and testable without Electron — the rule it encodes cost a working setup
 * its sign-in once and is invisible to a type checker.
 *
 * The one import is deliberate and type-only, so it erases at build time and
 * costs this file nothing at runtime. It exists because the alternative — a
 * hand-copied union — is exactly how this file came to accept two of the three
 * gate kinds the wire defines, and silently drop every panel blocked on
 * authentication. A copied enum is a drift waiting to happen; a derived one
 * fails the typecheck instead.
 */
import type { PanelStartupGateKind } from '@jerico/shared'

export type TrayState = 'green' | 'yellow' | 'red'

/** One panel, as the daemon describes it.
 *
 *  The field names are the daemon's own (`pty/manager.ts getLivePanelsReport`),
 *  not a shape invented on this side: `agentId`, `agentKey`, `cwd`, `usagePct`.
 *
 *  `cwd` and `usagePct` are optional and frequently absent, and absent means
 *  UNKNOWN rather than zero. `usagePct` in particular is only ever set from the
 *  Claude usage watcher, so a Kimi or shell panel legitimately has none — the
 *  em dash next to those rows is the truth, not a gap in this reader.
 *
 *  Older daemons send no `panels` at all and only `agentIds`. Those still list,
 *  with every field but the id unknown. */
export interface HealthPanel {
  agentId: string
  agentKey: string | null
  cwd: string | null
  usagePct: number | null
  hook: HealthHookState | null
  startupGate: HealthStartupGateState | null
  startupGateSupport: HealthStartupGateSupport
}

export interface HealthStartupGateState {
  phase: 'checking' | 'ready' | 'blocked' | 'attention'
  gate: PanelStartupGateKind
  reason: string | null
  observedAt: number
}

/**
 * The runtime list, and a compile-time proof it is the whole wire union.
 *
 * `_gateKindsAreTotal` is the load-bearing half: it stops compiling the moment
 * `PanelStartupGateKind` gains a member this list lacks, which is the failure
 * that shipped — `'authentication'` was added to the wire, the daemon emitted it
 * for every claude credential preflight and every codex/agy sign-in blocker, the
 * server accepted it, and this file threw the whole gate away, so an actionable
 * fault rendered as "we do not know".
 */
const GATE_KINDS = ['workspace_trust', 'authentication', 'unknown_startup'] as const
const _gateKindsAreWireKinds: readonly PanelStartupGateKind[] = GATE_KINDS
void _gateKindsAreWireKinds
type _NoGateKindMissing =
  Exclude<PanelStartupGateKind, typeof GATE_KINDS[number]> extends never ? true : never
const _gateKindsAreTotal: _NoGateKindMissing = true
void _gateKindsAreTotal

function isGateKind(v: unknown): v is PanelStartupGateKind {
  return typeof v === 'string' && (GATE_KINDS as readonly string[]).includes(v)
}

/**
 * Whether the daemon watches a startup gate for this panel at all.
 *
 * `'unknown'` is for daemons predating the field — and it is a real third
 * answer, not a default: on an older daemon a missing gate genuinely could mean
 * either thing, and the surface must keep saying so rather than quietly
 * deciding.
 */
export type HealthStartupGateSupport = 'monitored' | 'not_applicable' | 'unknown'

export interface HealthHookState {
  configState: 'unknown' | 'absent' | 'present_ok' | 'malformed'
    | 'unsupported_trust_required' | 'unsupported_not_a_jerico_agent'
    | 'unsupported_runtime_unverified' | 'unsupported_different_contract'
    | 'unsupported_no_config_hook_surface'
  hookInstallRefused: { status: string; at: number } | null
}

export interface HealthPayload {
  status?: string
  /** Which profile is answering. Absent on daemons older than this field. */
  profile?: string | null
  connected?: boolean
  authFailed?: boolean
  /** The daemon refused its own configured endpoint and is idling on purpose
   *  (#571). Absent on daemons predating the field, which is not the same as
   *  false — but for a reader there is nothing to say either way. */
  endpointRejected?: boolean
  /** One sentence naming why. This is what the surface prints; the code is for
   *  logs. Already redacted daemon-side. */
  endpointRejectedReason?: string | null
  /** The command that repairs it, spelled by the daemon that knows its own
   *  profile. Printing a remedy the user cannot run is worse than printing none. */
  endpointRepairCommand?: string | null
  activePanels?: number
  version?: string | null
  documentsFolderReadable?: boolean
  /** Legacy daemon field; it has always represented the Documents probe. */
  protectedFoldersReadable?: boolean
  reconnectAttempts?: number
  /** Seconds the daemon process has been up (process.uptime()). */
  uptime?: number
  agentIds?: string[]
  /** Recent pong round-trips in ms, oldest first, capped at 30 by the daemon
   *  (`ws/throttle.ts`). Absent on daemons predating that field. */
  pongRttHistory?: unknown
  /** Per-panel detail (`pty/manager.ts getLivePanelsReport`). Absent on
   *  daemons predating it, which send only `agentIds`. */
  panels?: unknown
  /** Provider limits (`usage/refresher.ts usageForHealth`). Absent on daemons
   *  predating it — which is NOT the same as an empty array: absent means the
   *  daemon cannot answer, empty means it answered "nothing to report yet". */
  usage?: unknown
}

/** One agent's provider limits, as the daemon publishes them. Field names are
 *  the daemon's own (`usage/refresher.ts UsageHealthEntry`). */
export interface HealthUsageWindow {
  id: string
  title: string
  usedPercent: number
  severity: 'normal' | 'warning' | 'critical' | null
  isActive: boolean
  resetsAt: number | null
  windowMinutes: number | null
  scopedUnder: string | null
  /** Raw counts, when the provider states them instead of a percentage. Kimi
   *  reports `{"limit":"2048","used":"214"}` and no percentage; Anthropic and
   *  OpenAI report the percentage and no counts. null is "not stated". */
  counts: { used: number; limit: number } | null
}

export interface HealthUsage {
  agent: string
  plan: string | null
  source: string | null
  fetchedAt: number | null
  /** A reading survived but the last refresh failed. Date it, do not draw it as
   *  current. */
  stale: boolean
  faultCode: string | null
  faultDetail: string | null
  windows: HealthUsageWindow[]
  /** A disabled arrangement carries no figures — see the daemon's usage/model.ts.
   *  The two shapes are kept apart here too, so a renderer cannot read `used` off
   *  something that never had one. */
  cost:
    | { enabled: false; currency: string; period: string | null }
    | { enabled: true; used: number; limit: number | null; currency: string; period: string | null }
    | null
}

export interface HealthResult {
  state: TrayState
  activePanels: number
  authFailed: boolean
  /** null when the daemon is fine, or too old to report it. A string here is a
   *  daemon that is deliberately not connecting, and the string says why. */
  endpointRejectedReason: string | null
  /** The repair command the daemon named, when it named one. */
  endpointRepairCommand: string | null
  documentsFolderReadable?: boolean
  /** Legacy alias retained for callers running across a daemon upgrade. */
  protectedFoldersReadable?: boolean
  reconnectAttempts: number
  /** A daemon answered, but it belongs to a different profile. Its numbers are
   *  somebody else's and must not reach the tray, the wizard or any dialog. */
  foreign?: boolean
  /** null when nothing answered or the daemon is too old to say. */
  uptimeSeconds: number | null
  daemonVersion: string | null
  /** Recent pong round-trips, oldest first. null = the daemon does not report
   *  them, which is not the same as an empty history. */
  rttHistory: number[] | null
  lastRttMs: number | null
  lastPongAgoMs: number | null
  /** One entry per live panel. Empty is a real answer (no panels); the optional
   *  fields inside are what may be unknown. */
  panels: HealthPanel[]
  /** Provider limits, one entry per agent that has a fetcher. `null` = the
   *  daemon does not report them at all (too old); `[]` = it does and has
   *  nothing yet. The register draws those two differently. */
  usage: HealthUsage[] | null
}

/** What a poll with nothing on the other end means. */
export const NO_ANSWER: HealthResult = {
  state: 'red',
  activePanels: 0,
  authFailed: false,
  endpointRejectedReason: null,
  endpointRepairCommand: null,
  reconnectAttempts: 0,
  uptimeSeconds: null,
  daemonVersion: null,
  rttHistory: null,
  lastRttMs: null,
  lastPongAgoMs: null,
  panels: [],
  usage: null,
}

/**
 * Provider limits, validated field by field.
 *
 * Returns null when the daemon sent nothing (an older build) and an array when
 * it sent one, INCLUDING an empty array — "I have no readings yet" and "I cannot
 * report readings" are different sentences on the surface, so they must not
 * collapse into the same value here.
 *
 * A window without a finite `usedPercent` is dropped: the whole point of the
 * register is that no gauge is ever drawn from a number nobody supplied.
 */
/** Both halves or nothing: a used count without a limit cannot make a fraction,
 *  and half a pair would be drawn as "214 of 0". */
function readCounts(v: unknown): { used: number; limit: number } | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const rec = v as Record<string, unknown>
  const used = finiteOrNull(rec['used'])
  const limit = finiteOrNull(rec['limit'])
  if (used === null || limit === null || limit <= 0) return null
  return { used, limit }
}

function readUsage(payload: HealthPayload): HealthUsage[] | null {
  if (!Array.isArray(payload.usage)) return null
  const out: HealthUsage[] = []
  for (const raw of payload.usage) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const rec = raw as Record<string, unknown>
    const agent = typeof rec['agent'] === 'string' ? rec['agent'] : null
    if (agent === null) continue

    const windows: HealthUsageWindow[] = []
    if (Array.isArray(rec['windows'])) {
      for (const w of rec['windows']) {
        if (w === null || typeof w !== 'object' || Array.isArray(w)) continue
        const wr = w as Record<string, unknown>
        const pct = wr['usedPercent']
        const id = wr['id']
        const title = wr['title']
        if (typeof pct !== 'number' || !Number.isFinite(pct)) continue
        if (typeof id !== 'string' || typeof title !== 'string') continue
        const sev = wr['severity']
        windows.push({
          id,
          title,
          usedPercent: Math.max(0, Math.min(100, pct)),
          severity: sev === 'normal' || sev === 'warning' || sev === 'critical' ? sev : null,
          isActive: wr['isActive'] === true,
          resetsAt: finiteOrNull(wr['resetsAt']),
          windowMinutes: finiteOrNull(wr['windowMinutes']),
          scopedUnder: typeof wr['scopedUnder'] === 'string' ? wr['scopedUnder'] : null,
          counts: readCounts(wr['counts']),
        })
      }
    }

    let cost: HealthUsage['cost'] = null
    const c = rec['cost']
    if (c !== null && typeof c === 'object' && !Array.isArray(c)) {
      const cr = c as Record<string, unknown>
      const currency = typeof cr['currency'] === 'string' ? cr['currency'] : 'USD'
      const period = typeof cr['period'] === 'string' ? cr['period'] : null
      if (cr['enabled'] !== true) {
        // Disabled first, and without looking at any figure. The previous version
        // built a cost object whenever `used` was finite regardless of `enabled`,
        // which is how a fabricated zero reached this side at all.
        cost = { enabled: false, currency, period }
      } else {
        const used = finiteOrNull(cr['used'])
        // Enabled but unreadable is reported as no arrangement rather than as zero
        // spend, for the same reason the daemon does it.
        cost = used === null
          ? { enabled: false, currency, period }
          : { enabled: true, used, limit: finiteOrNull(cr['limit']), currency, period }
      }
    }

    out.push({
      agent,
      plan: typeof rec['plan'] === 'string' ? rec['plan'] : null,
      source: typeof rec['source'] === 'string' ? rec['source'] : null,
      fetchedAt: finiteOrNull(rec['fetchedAt']),
      stale: rec['stale'] === true,
      faultCode: typeof rec['faultCode'] === 'string' ? rec['faultCode'] : null,
      faultDetail: typeof rec['faultDetail'] === 'string' ? rec['faultDetail'] : null,
      windows,
      cost,
    })
  }
  return out
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** A history is only usable if it is an array of finite numbers. A daemon that
 *  sends `[]` genuinely has no samples yet — that is still an answer, and it is
 *  drawn as an empty run rather than as "not reported". */
function readRttHistory(payload: HealthPayload): number[] | null {
  const raw = payload.pongRttHistory
  if (!Array.isArray(raw)) return null
  const out: number[] = []
  for (const v of raw) {
    const n = finiteOrNull(v)
    if (n !== null) out.push(n)
  }
  return out
}

/** Panels, preferring the daemon's rich list and falling back to the bare ids
 *  it has always sent. The fallback carries an id and nothing else, which is
 *  exactly true: we know a panel is there and nothing about it.
 *
 *  A `panels` array that yields no usable row falls through to `agentIds`
 *  rather than returning empty. The first version of this reader keyed on
 *  field names guessed before the daemon side existed, and because
 *  `Array.isArray(panels)` was true it returned `[]` and never reached the
 *  fallback — so a machine with three panels running rendered "no panels open".
 *  Failing to the coarser truth beats failing to a confident lie. */
function readPanels(payload: HealthPayload): HealthPanel[] {
  const fromIds = (): HealthPanel[] =>
    Array.isArray(payload.agentIds)
      ? payload.agentIds
          .filter((id): id is string => typeof id === 'string')
          // A daemon reporting only ids tells us nothing about gate monitoring,
          // and 'unknown' is the honest word for that — not 'not_applicable',
          // which would silence a real gate this daemon simply cannot describe.
          .map((id) => ({ agentId: id, agentKey: null, cwd: null, usagePct: null, hook: null, startupGate: null, startupGateSupport: 'unknown' as const }))
      : []

  const raw = payload.panels
  if (!Array.isArray(raw)) return fromIds()

  const out: HealthPanel[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const agentId = typeof rec['agentId'] === 'string' ? rec['agentId'] : null
    if (agentId === null) continue
    const rawHook = rec['hook']
    let hook: HealthHookState | null = null
    if (rawHook !== null && typeof rawHook === 'object' && !Array.isArray(rawHook)) {
      const hookRec = rawHook as Record<string, unknown>
      const configState = hookRec['configState']
      const validStates = new Set([
        'unknown', 'absent', 'present_ok', 'malformed', 'unsupported_trust_required',
        'unsupported_not_a_jerico_agent', 'unsupported_runtime_unverified',
        'unsupported_different_contract', 'unsupported_no_config_hook_surface'
      ])
      if (typeof configState === 'string' && validStates.has(configState)) {
        const rawRefusal = hookRec['hookInstallRefused']
        let hookInstallRefused: { status: string; at: number } | null = null
        if (rawRefusal !== null && typeof rawRefusal === 'object' && !Array.isArray(rawRefusal)) {
          const refusal = rawRefusal as Record<string, unknown>
          if (typeof refusal['status'] === 'string' && typeof refusal['at'] === 'number' && Number.isFinite(refusal['at'])) {
            hookInstallRefused = { status: refusal['status'], at: refusal['at'] }
          }
        }
        hook = { configState: configState as HealthHookState['configState'], hookInstallRefused }
      }
    }
    const rawStartupGate = rec['startupGate']
    let startupGate: HealthStartupGateState | null = null
    if (rawStartupGate !== null && typeof rawStartupGate === 'object' && !Array.isArray(rawStartupGate)) {
      const gateRec = rawStartupGate as Record<string, unknown>
      const phase = gateRec['phase']
      const observedAt = finiteOrNull(gateRec['observedAt'])
      const gate = gateRec['gate']
      if ((phase === 'checking' || phase === 'ready' || phase === 'blocked' || phase === 'attention')
        && isGateKind(gate) && observedAt !== null) {
        startupGate = {
          phase,
          gate,
          reason: typeof gateRec['reason'] === 'string' ? gateRec['reason'] : null,
          observedAt,
        }
      }
    }
    const rawSupport = rec['startupGateSupport']
    const startupGateSupport: HealthStartupGateSupport =
      rawSupport === 'monitored' || rawSupport === 'not_applicable' ? rawSupport : 'unknown'
    out.push({
      agentId,
      startupGateSupport,
      agentKey: typeof rec['agentKey'] === 'string' ? rec['agentKey'] : null,
      cwd: typeof rec['cwd'] === 'string' && rec['cwd'] !== '' ? rec['cwd'] : null,
      usagePct: finiteOrNull(rec['usagePct']),
      hook,
      startupGate,
    })
  }
  // An empty list from a daemon that HAS the field is a real "no panels".
  // An empty list because nothing parsed is not.
  return out.length === 0 && raw.length > 0 ? fromIds() : out
}

export function classifyHealth(
  payload: HealthPayload,
  myProfile: string | null,
  statusCode: number,
): HealthResult {
  // Ports are an addressing convention, and conventions collide: every named
  // profile used to answer on 3102, so this app could poll a stranger's daemon
  // and act on its state — throwing a healthy setup back to the sign-in screen
  // because a different profile's daemon was unhappy. Ports are unique again,
  // which makes this check cheap rather than unnecessary: a stale plist or a
  // hand-set HEALTH_PORT still puts someone else on the line.
  //
  // `profile` is absent on daemons predating the field. Those are trusted
  // exactly as before — a version skew must not lock anyone out of their own
  // daemon.
  if (payload.profile !== undefined && payload.profile !== myProfile) {
    return { ...NO_ANSWER, foreign: true }
  }

  const panels = readPanels(payload)
  const history = readRttHistory(payload)
  const usage = readUsage(payload)
  return {
    // green: HTTP 200 + connected:true
    // yellow: any response where connected is false (503 or connected:false)
    state: statusCode === 200 && payload.connected ? 'green' : 'yellow',
    activePanels: payload.activePanels ?? panels.length,
    authFailed: payload.authFailed ?? false,
    // A reason without the flag, or a flag without a reason, is still worth
    // saying — but only a non-empty sentence is worth printing.
    endpointRejectedReason:
      payload.endpointRejected === true || typeof payload.endpointRejectedReason === 'string'
        ? (payload.endpointRejectedReason?.trim() || 'the configured server endpoint was refused')
        : null,
    endpointRepairCommand: payload.endpointRepairCommand?.trim() || null,
    documentsFolderReadable: payload.documentsFolderReadable ?? payload.protectedFoldersReadable,
    protectedFoldersReadable: payload.documentsFolderReadable ?? payload.protectedFoldersReadable,
    reconnectAttempts: payload.reconnectAttempts ?? 0,
    uptimeSeconds: finiteOrNull(payload.uptime),
    daemonVersion: payload.version ?? null,
    rttHistory: history,
    usage,
    // The newest sample IS the last round-trip; there is no separate field for
    // it and there does not need to be.
    lastRttMs: history === null || history.length === 0 ? null : history[history.length - 1] ?? null,
    // Nothing reports this. The daemon keeps round-trip VALUES, not the times
    // they arrived, so "last pong 41s ago" cannot be said — and the sub-line
    // omits the segment rather than guessing at it.
    lastPongAgoMs: null,
    panels,
  }
}
