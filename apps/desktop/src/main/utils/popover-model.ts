/**
 * What the popover says, and what it offers to do about it.
 *
 * The design's two governing rules — "the reading follows the fault" and "so
 * does the action" — are decisions, not styling, so they live here: pure, with
 * no Electron import, in the same spirit as health-classify.ts. Getting the
 * headline right for a state is worth a test; getting the padding right is not.
 *
 * Nothing in this file may invent a number. A reading the daemon does not
 * report arrives as `null` and leaves as an em dash — unknown is not zero, and
 * a popover that draws 0 ms of latency because it was told nothing is worse
 * than one that admits it does not know.
 */

import type { HealthUsage, TrayState } from './health-classify.js'

/** The seven states of design/01-tray-popover.html, rev D — plus one the
 *  design did not have: a daemon that refused its own configured endpoint
 *  (#571). It reads as "Reconnecting" without this, which is the one thing it
 *  is not: no amount of waiting fixes a settings.json the daemon will not
 *  dial, and the surface has to say so or the user waits forever. */
export type Phase =
  | 'working'
  | 'idle'
  | 'starting'
  | 'reconnecting'
  | 'authfailed'
  | 'endpointrejected'
  | 'foreignregistration'
  | 'stopping'
  | 'offline'

/** Every verb the popover can offer. The renderer never decides what an action
 *  means; it sends one of these back and main does the work. */
export type PopoverAction =
  | 'open-jerico'
  | 'start'
  | 'stop'
  | 'reconnect'
  | 'reauth'
  | 'reregister-service'
  | 'manage'
  | 'updates'
  | 'logs'
  | 'quit'
  | 'update-install'
  | 'update-download'

/** How the heartbeat strip should read, given what the connection is doing.
 *    run   — pongs are arriving; plot them
 *    break — pongs stopped mid-window; plot what we have, mark the drop
 *    scan  — a transition is in flight; there is nothing to plot yet
 *    flat  — the daemon is down; the line is flat because it is flat
 *    none  — the daemon does not report RTT at all; say so, plot nothing */
export type TraceMode = 'run' | 'break' | 'scan' | 'flat' | 'none'

export type Tone = '' | 'warn' | 'bad'

export interface Verb {
  label: string
  action: PopoverAction
  tone: Tone
}

export interface SubLine {
  /** The one word that is coloured by state, when there is one. */
  status: string | null
  /** The rest of the line. Segments are joined with " · " by the renderer so a
   *  segment that could not be computed can simply be left out. */
  parts: string[]
}

export interface PopoverFacts {
  state: TrayState
  /** A start or stop this app has in flight. Beats everything else: it is what
   *  is happening right now, and it is the only thing the user can be waiting on. */
  transition: 'starting' | 'stopping' | null
  authFailed: boolean
  /** The daemon is alive and deliberately not connecting because the endpoint
   *  in its settings breaks the contract. The string is the daemon's own
   *  sentence, already redacted; null means no such fault, or a daemon too old
   *  to report one. */
  endpointRejectedReason: string | null
  /** The command that repairs it, as the daemon spells it (profile included).
   *  null when the daemon is too old to send one; the surface then falls back
   *  to the unprofiled form. */
  endpointRepairCommand: string | null
  /**
   * launchd holds this label against a program we do not manage, as the daemon
   * itself reported it on the last start attempt (`foreign_registration_running`
   * / `foreign_registration_bootout_failed`). The string is the daemon's own
   * sentence; null means no such fault was observed.
   *
   * This is not a health reading and never expires on its own: nothing about a
   * launchd registration changes because a poll came back. It is set when a start
   * reports it and cleared when a start no longer does.
   */
  foreignRegistrationReason: string | null
  activePanels: number
  reconnectAttempts: number
  uptimeSeconds: number | null
  lastRttMs: number | null
  /** ms since the last pong. One of the three readings the daemon does not
   *  report yet, so it is normally null and the sub-line simply omits it. */
  lastPongAgoMs: number | null
  rttHistory: number[] | null
  healthPort: number
  /** ms since this app watched the daemon go down, when it was this app that
   *  stopped it. null across an app restart — and then the popover does not
   *  claim to know. */
  stoppedAgoMs: number | null
  /** Whether this profile resolved a complete endpoint contract. Browser
   * actions fail closed when false; local lifecycle actions remain available. */
  webAvailable: boolean
}

export interface Presentation {
  phase: Phase
  /** The single largest thing on the surface. */
  headline: string
  /** The right-hand half of the identity line: normally the server, but under a
   *  transition it is what the transition is doing. */
  context: string
  sub: SubLine
  /** Right-aligned count on the panels register. */
  count: string
  primary: { label: string; action: PopoverAction; enabled: boolean }
  verbs: Verb[]
  trace: TraceMode
  /** Which state colour the surface is tuned to. */
  tone: 'live' | 'hold' | 'down'
}

// ── the wire ──────────────────────────────────────────────────────────────

/** One panel row. Every field past the key may be unknown, and the renderer
 *  draws an em dash for each one that is — a panel whose project we cannot name
 *  is still a panel worth listing. */
export interface PopoverPanel {
  key: string
  agent: string | null
  project: string | null
  /** The full cwd, for the row's tooltip. `project` is what is drawn. */
  cwd: string | null
  contextPct: number | null
  hook: import('./health-classify.js').HealthHookState | null
  startupGate: import('./health-classify.js').HealthStartupGateState | null
  /**
   * Whether the daemon watches a gate for this panel. Without it a missing gate
   * has two meanings — un-watched and un-reported — and the register has to call
   * both unknown.
   */
  startupGateSupport: import('./health-classify.js').HealthStartupGateSupport
}

/**
 * The project column, from the daemon's `cwd`.
 *
 * The daemon reports a working directory — `/Users/me/Development/jerico`. The
 * design's column is `jerico`. A 368pt card ellipsises a home-relative path
 * down to the part that distinguishes nothing ("…evelopment/jer"), and the
 * leaf is both shorter and the thing anyone actually calls the project. The
 * full path survives on the row's title, so nothing is lost, only folded.
 */
export function projectFromCwd(cwd: string | null): string | null {
  if (cwd === null) return null
  const trimmed = cwd.replace(/\/+$/, '')
  if (trimmed === '') return '/'
  const leaf = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return leaf === '' ? trimmed : leaf
}

// ── the panels register ───────────────────────────────────────────────────

/**
 * How much vertical room a panel with nothing to say is allowed to take.
 *
 * The cap governs ONLY settled-healthy rows. A panel with a fault or an unknown
 * reading is always drawn, however many there are — capping those is how a
 * status surface hides the thing it exists to report. So the card's height is a
 * function of the fault count, not the panel count, which is the only thing
 * that should make a status surface grow.
 *
 * Six is calibrated, not sacred: it has to leave room for the action block, the
 * limits rows and three activity events on the shortest supported display.
 */
export const MAX_BORING_PANEL_ROWS = 6

/** settled-healthy · reading exists but is not known · actionable fault */
export type PanelHealth = 'healthy' | 'unknown' | 'fault'

/** One word of non-boring news about a panel, with the tone it earns. */
export interface PanelMark {
  text: string
  tone: Tone
}

export interface PanelRow {
  panel: PopoverPanel
  health: PanelHealth
  /**
   * What is not boring about this panel. EMPTY when and only when the panel is
   * settled and positively confirmed healthy — see `classifyPanel`.
   */
  marks: PanelMark[]
}

/**
 * One row of the main card's register: a PROJECT, with how many panels it holds.
 *
 * Why the project and not the panel: a panel list grows with the panel count,
 * which is now machine-derived and reaches 128, and it answers "which processes
 * exist" — a question for a roster, not for a glance. Projects are few, they are
 * what a person actually navigates by, and the count belongs on the same line as
 * the name. The per-panel roster moved to the detail view, where it has room.
 */
export interface ProjectRow {
  /** The cwd's leaf. null when no panel in the group reported a directory. */
  project: string | null
  /** The full path, for the row's title. null when unreported. */
  cwd: string | null
  panels: number
  health: PanelHealth
  /**
   * The group's news, aggregated and counted — `1 trust blocked`, `2 hook
   * unknown`. Counted rather than listed because the row stands for several
   * panels: naming one of them would be a lie about the others. Each cause is
   * its own mark; two causes need two fixes.
   */
  marks: PanelMark[]
  /** The highest context reading in the group. null = none reported. */
  topContextPct: number | null
}

export interface PanelsRegister {
  rows: ProjectRow[]
  /** Project rows the cap folded away. By construction all settled-healthy. */
  hiddenProjects: number
  /** How many panels are inside those hidden rows, so the tail can say. */
  hiddenPanels: number
  /**
   * Constant-size coverage of the whole panel population, e.g.
   * `gate 12 ready · hook 11 configured / 1 unknown`. This is what pays for the
   * silence: absence of a per-panel word would otherwise be taken on faith.
   * null when there are no panels.
   */
  coverage: string | null
  /**
   * What to append to the heading's own count when the panels are not all
   * settled-healthy — e.g. `2 faults`. null when there is nothing to add.
   *
   * A suffix and not a replacement: `presentation.count` is phase-aware
   * (`none open` when the daemon is stopped, `3 held` when it is paused), and a
   * register that overwrote it would say "running" about panels that are not.
   */
  alert: string | null
  faults: number
  unknowns: number
  totalPanels: number
}

/**
 * Whether a panel has earned silence.
 *
 * The rule, and the whole design is in the last clause: a reading is omitted if
 * and only if it is *settled* and *positively confirmed healthy*. "Not known"
 * is never omitted, because a silence that also covers the unknown case decays
 * into "silence means fine", and then the register is lying quietly.
 *
 * `unsupported_*` is silent on purpose and is NOT an unknown: a `sh` panel has
 * no turn hooks to configure. That is a settled capability answer, permanently
 * true, and drawing it would put a permanent non-fault on every shell row.
 */
export function classifyPanel(panel: PopoverPanel): PanelRow {
  const marks: PanelMark[] = []
  let unknown = false
  let fault = false

  const gate = panel.startupGate
  if (gate === null) {
    // A panel the daemon does not watch has nothing to report, and saying
    // "unknown" about it is noise no one can act on — a shell has no startup to
    // gate. Every other absence stays unknown, including on a daemon too old to
    // say which case this is: silence there would be a guess.
    if (panel.startupGateSupport !== 'not_applicable') {
      marks.push({ text: 'gate \u2014', tone: '' })
      unknown = true
    }
  } else if (gate.phase === 'blocked') {
    marks.push({ text: 'TRUST BLOCKED', tone: 'bad' })
    fault = true
  } else if (gate.phase === 'attention') {
    marks.push({ text: 'ATTENTION', tone: 'warn' })
    fault = true
  } else if (gate.phase === 'checking') {
    marks.push({ text: 'gate checking', tone: '' })
    unknown = true
  }

  const hook = panel.hook
  if (hook === null) {
    marks.push({ text: 'hook \u2014', tone: '' })
    unknown = true
  } else if (hook.configState === 'absent') {
    marks.push({ text: 'hook not configured', tone: 'warn' })
    fault = true
  } else if (hook.configState === 'malformed') {
    marks.push({ text: 'hook malformed', tone: 'bad' })
    fault = true
  } else if (hook.configState === 'unknown') {
    marks.push({ text: 'hook could not be determined', tone: '' })
    unknown = true
  }

  // A refusal is a fault on its own account: the hook may read `absent` for a
  // reason the user chose, and the row has to say which.
  if (hook?.hookInstallRefused) {
    marks.push({ text: `install refused ${hook.hookInstallRefused.status}`, tone: 'warn' })
    fault = true
  }

  return { panel, health: fault ? 'fault' : unknown ? 'unknown' : 'healthy', marks }
}

const HEALTH_ORDER: Record<PanelHealth, number> = { fault: 0, unknown: 1, healthy: 2 }

/** The causes a group can report, in the order a reader should meet them. */
const CAUSES: { key: string; label: string; tone: Tone; test: (r: PanelRow) => boolean }[] = [
  { key: 'gate_blocked', label: 'trust blocked', tone: 'bad', test: (r) => r.panel.startupGate?.phase === 'blocked' },
  { key: 'hook_malformed', label: 'hook malformed', tone: 'bad', test: (r) => r.panel.hook?.configState === 'malformed' },
  { key: 'gate_attention', label: 'needs attention', tone: 'warn', test: (r) => r.panel.startupGate?.phase === 'attention' },
  { key: 'hook_absent', label: 'hook not configured', tone: 'warn', test: (r) => r.panel.hook?.configState === 'absent' },
  { key: 'refused', label: 'install refused', tone: 'warn', test: (r) => Boolean(r.panel.hook?.hookInstallRefused) },
  // Same rule as `classifyPanel`: an absent gate on a panel the daemon does not
  // watch is not an unknown reading. These two lists encoding the rule
  // separately is how this row kept saying "gate unknown" about a shell after
  // classifyPanel had already stopped — `marksAgreeWithCauses` now pins them
  // together.
  { key: 'gate_unknown', label: 'gate unknown', tone: '', test: (r) =>
    (r.panel.startupGate === null && r.panel.startupGateSupport !== 'not_applicable')
    || r.panel.startupGate?.phase === 'checking' },
  { key: 'hook_unknown', label: 'hook unknown', tone: '', test: (r) => r.panel.hook === null || r.panel.hook.configState === 'unknown' },
]

/**
 * The main card's register: one row per project, worst first, boring rows
 * capped, faults never capped.
 *
 * The sort is the same worst-first rule `limitsFromUsage` already applies to the
 * limits register — the row a reader needs is the one at the top.
 */
export function panelsRegister(
  panels: PopoverPanel[],
  opts: { maxBoringRows?: number } = {},
): PanelsRegister {
  const cap = Math.max(0, opts.maxBoringRows ?? MAX_BORING_PANEL_ROWS)
  const classified = panels.map(classifyPanel)

  // Group by the full cwd, not the leaf: two different checkouts can share a
  // leaf name, and merging them would report one project that does not exist.
  // Panels with no reported directory group together under their own honest row
  // rather than being dropped or folded into a real project.
  const groups = new Map<string, PanelRow[]>()
  for (const row of classified) {
    const key = row.panel.cwd ?? '\u0000none'
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }

  const rows: ProjectRow[] = [...groups.entries()].map(([key, members]) => {
    const cwd = key === '\u0000none' ? null : key
    const health: PanelHealth = members.some((m) => m.health === 'fault')
      ? 'fault'
      : members.some((m) => m.health === 'unknown') ? 'unknown' : 'healthy'

    const marks: PanelMark[] = []
    for (const cause of CAUSES) {
      const n = members.filter(cause.test).length
      if (n > 0) marks.push({ text: `${n} ${cause.label}`, tone: cause.tone })
    }

    const readings = members
      .map((m) => m.panel.contextPct)
      .filter((v): v is number => v !== null)

    return {
      project: cwd === null ? null : (projectFromCwd(cwd) ?? cwd),
      cwd,
      panels: members.length,
      health,
      marks,
      topContextPct: readings.length > 0 ? Math.max(...readings) : null,
    }
  })

  rows.sort((a, b) => {
    const h = HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health]
    if (h !== 0) return h
    if (a.panels !== b.panels) return b.panels - a.panels
    // The unreported group sorts last among equals: it is the least navigable
    // row on the card, so it should not sit above a project with a name.
    if ((a.project === null) !== (b.project === null)) return a.project === null ? 1 : -1
    return (a.project ?? '').localeCompare(b.project ?? '')
  })

  const kept: ProjectRow[] = []
  let hiddenProjects = 0
  let hiddenPanels = 0
  let boringDrawn = 0
  for (const row of rows) {
    if (row.health === 'healthy') {
      if (boringDrawn >= cap) { hiddenProjects += 1; hiddenPanels += row.panels; continue }
      boringDrawn += 1
    }
    kept.push(row)
  }

  const faults = classified.filter((r) => r.health === 'fault').length
  const unknowns = classified.filter((r) => r.health === 'unknown').length
  const alert = faults > 0
    ? `${faults} ${faults === 1 ? 'fault' : 'faults'}`
    : unknowns > 0 ? `${unknowns} unknown` : null

  return {
    rows: kept,
    hiddenProjects,
    hiddenPanels,
    coverage: coverageLine(classified),
    alert,
    faults,
    unknowns,
    totalPanels: panels.length,
  }
}

/**
 * The one line that keeps the silence honest, and the one line that must not
 * grow with N. It counts the whole population, including the rows the cap hid,
 * so `+34 more` can never be where a bad reading went.
 */
function coverageLine(rows: PanelRow[]): string | null {
  if (rows.length === 0) return null

  let gateReady = 0
  let gateOther = 0
  let gateNa = 0
  for (const { panel } of rows) {
    if (panel.startupGate?.phase === 'ready') gateReady += 1
    else if (panel.startupGate === null && panel.startupGateSupport === 'not_applicable') gateNa += 1
    else gateOther += 1
  }

  let hookOk = 0
  let hookUnsupported = 0
  let hookOther = 0
  for (const { panel } of rows) {
    const c = panel.hook?.configState
    if (c === 'present_ok') hookOk += 1
    else if (c !== undefined && c.startsWith('unsupported')) hookUnsupported += 1
    else hookOther += 1
  }

  const gateParts = [`${gateReady} ready`]
  if (gateNa > 0) gateParts.push(`${gateNa} n/a`)
  if (gateOther > 0) gateParts.push(`${gateOther} not`)
  const gate = `gate ${gateParts.join(' / ')}`
  const hookParts = [`${hookOk} configured`]
  if (hookUnsupported > 0) hookParts.push(`${hookUnsupported} n/a`)
  if (hookOther > 0) hookParts.push(`${hookOther} not`)
  return `${gate} \u00b7 hook ${hookParts.join(' / ')}`
}

/**
 * One row of the limits register: an agent, and the single window closest to its
 * ceiling.
 *
 * Why the most-constrained window and not the session: an agent is limited by
 * whichever ceiling it reaches first, so a comfortable session next to a 96%
 * weekly Opus budget is not a comfortable agent. And why `scope`: "claude 96%
 * resetting in 22m" and "claude opus 96% with no reset at all" are completely
 * different situations, and a row that flattens them into one number is worse
 * than no row.
 */
export interface PopoverLimit {
  agent: string
  /** The model a scoped window belongs to (`opus`, `fable`), drawn after the
   *  agent name. null when the constrained window is the plain session/weekly. */
  scope: string | null
  /** null = no reading. The gauge must then draw the not-reported mark, never an
   *  empty bar: an empty bar reads as headroom. */
  usedPercent: number | null
  /** null = the provider reported this window with no reset. Real, and not an
   *  error — the row says so rather than borrowing another window's clock. */
  resetsAt: number | null
  severity: 'normal' | 'warning' | 'critical' | null
  /** A short, user-facing reason there is no number, when the cause is a fault
   *  rather than a missing fetcher. Distinct from `usedPercent: null` alone,
   *  because only one of the two is actionable. */
  fault: string | null
  /** The reading survived a failed refresh. Drawn quieter and dated. */
  stale: boolean
  /** A deliberate background credential skip, distinct from a failed refresh. */
  deferred: boolean
  /** When the surviving reading was taken. */
  fetchedAt: number | null
}

/**
 * Fault codes the daemon can report, as one short phrase each.
 *
 * These are the register's whole vocabulary for "there is no number and here is
 * why". The detail sentence lives in the usage window, where there is room; a
 * 368pt row gets three words.
 */
function faultPhrase(code: string | null): string | null {
  switch (code) {
    case null: return null
    case 'no_credentials': return 'not signed in'
    case 'no_usage_token': return 'no usage token'
    case 'scope_insufficient': return 'token not authorized'
    // NOT "sign-in expired": for kimi and agy the sign-in is intact and only the
    // short-lived access token lapsed. Being told you are signed out when you are
    // signed in sends you to fix the wrong thing — a real user did exactly that.
    case 'unauthorized': return 'token expired'
    case 'token_lapsed': return 'reading paused'
    case 'keychain_locked': return 'keychain locked'
    case 'keychain_deferred': return 'open usage to read'
    case 'interactive_deferred': return 'open usage to read'
    case 'network': return 'provider unreachable'
    case 'malformed': return 'unreadable response'
    // Not a fault the user can act on, and not an error: this plan has no metered
    // ceiling. Said plainly rather than coloured amber.
    case 'no_limits': return 'no metered limits'
    // `unsupported` never reaches here: the daemon omits those agents entirely.
    default: return 'not reported'
  }
}

/**
 * Collapse each agent's windows to one register row.
 *
 * Returns null when the daemon does not report usage at all, so the surface can
 * stay silent on an older daemon instead of drawing an empty section that implies
 * there is nothing to know.
 */
export function limitsFromUsage(usage: HealthUsage[] | null): PopoverLimit[] | null {
  if (usage === null) return null
  const rows: PopoverLimit[] = []
  for (const u of usage) {
    let worst: HealthUsage['windows'][number] | null = null
    for (const w of u.windows) {
      if (worst === null || w.usedPercent > worst.usedPercent) worst = w
    }
    const expired = worst !== null && worst.resetsAt !== null && worst.resetsAt <= Date.now()
    rows.push({
      agent: u.agent,
      // Only name the scope when the constrained window IS a scoped one —
      // otherwise the row would read "claude weekly", which says nothing a
      // reset time does not already say.
      scope: worst !== null && worst.scopedUnder !== null ? worst.title : null,
      usedPercent: expired ? null : worst?.usedPercent ?? null,
      resetsAt: expired ? null : worst?.resetsAt ?? null,
      severity: worst?.severity ?? null,
      fault: worst === null ? faultPhrase(u.faultCode) : null,
      stale: u.stale,
      deferred: u.faultCode === 'keychain_deferred' || u.faultCode === 'interactive_deferred',
      fetchedAt: u.fetchedAt,
    })
  }
  return rows.sort((a, b) => {
    // Most constrained first: the row a user needs is the one at the top.
    const av = a.usedPercent ?? -1
    const bv = b.usedPercent ?? -1
    return bv - av || a.agent.localeCompare(b.agent)
  })
}

export interface PopoverEvent {
  at: number
  event: string
  detail: string
  level: Tone
}

export type UpdateNotice =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string | null; percent: number }
  | { kind: 'preparing'; version: string }
  | { kind: 'failed'; version: string; message: string }
  | { kind: 'ready'; version: string }

/** Everything the popover renders, computed in main and pushed whole. The
 *  renderer holds no daemon logic of its own: one state in, one surface out,
 *  which is also what makes the seven states drivable from a test harness. */
export interface PopoverState {
  presentation: Presentation
  machine: string
  server: string
  appVersion: string
  daemonVersion: string | null
  panels: PopoverPanel[]
  /**
   * The panels register as it should be drawn — sorted, capped and counted.
   * Computed here rather than in the renderer for the same reason as the rest
   * of this object: the renderer holds no logic of its own, so the honesty rule
   * (see `classifyPanel`) is testable without a DOM.
   */
  panelsView: PanelsRegister
  /**
   * How many points of content the card can actually show before
   * PopoverWindow.resizeTo clamps it — and a clamp CLIPS, with no overflow
   * anywhere in the card. The renderer needs this to decide what to shed,
   * because the thing a clip takes first is the bottom of the card, which is
   * where the primary action lives. 0 means "not known", and the renderer then
   * sheds nothing rather than guessing.
   */
  contentBudget: number
  /** One row per agent with a usage fetcher. null = this daemon does not report
   *  usage, and the register is omitted rather than drawn empty. */
  limits: PopoverLimit[] | null
  events: PopoverEvent[]
  update: UpdateNotice
  /** A start/stop/reconnect is in flight; every verb is inert until it lands. */
  busy: boolean
  /** Last N pong round-trips, oldest first. null = the daemon does not report
   *  them; the strip says "no heartbeat data" rather than drawing zeroes. */
  rttHistory: number[] | null
  lastRttMs: number | null
}

// ── formatting ────────────────────────────────────────────────────────────

/** `4d 06:14`, `06:14`, `14s`. Days only once there are days; seconds only
 *  while that is still the honest resolution. */
export function formatUptime(seconds: number | null): string | null {
  if (seconds === null || seconds < 0) return null
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (d > 0) return `${String(d)}d ${pad(h)}:${pad(m)}`
  if (h > 0 || m > 0) return `${pad(h)}:${pad(m)}`
  return `${String(s)}s`
}

/** `2m 14s`, `41s`. For "how long ago", where minutes are the coarsest unit
 *  anyone reads off a menu-bar popover. */
export function formatAgo(ms: number | null): string | null {
  if (ms === null || ms < 0) return null
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${String(s)}s`
  const m = Math.floor(s / 60)
  return `${String(m)}m ${String(s % 60)}s`
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

// ── driving the seven states in development ───────────────────────────────

const PHASES: readonly Phase[] = [
  'working', 'idle', 'starting', 'reconnecting', 'authfailed', 'endpointrejected',
  'foreignregistration', 'stopping', 'offline',
]

export function isPhase(v: string): v is Phase {
  return (PHASES as readonly string[]).includes(v)
}

/**
 * Bend the INPUTS so a chosen phase falls out of the ordinary code path.
 *
 * Four of the seven states cannot be produced on demand — a stop takes seconds
 * to pass through, a rejected token needs a revoked token, and a socket that
 * wedges does so on its own schedule — so without this the surface can only be
 * reviewed in the states that happened to occur. The design page has a state
 * switcher for exactly this reason.
 *
 * It sets health inputs, never readings: derivePhase, present() and every
 * string the user sees are the real ones, and no number is invented. Callers
 * gate it on a development build; there is no path to it in a packaged app.
 */
export function forcePhase(f: PopoverFacts, phase: Phase): PopoverFacts {
  switch (phase) {
    case 'working':      return { ...f, state: 'green', transition: null, authFailed: false, activePanels: Math.max(1, f.activePanels) }
    case 'idle':         return { ...f, state: 'green', transition: null, authFailed: false, activePanels: 0 }
    case 'starting':     return { ...f, transition: 'starting' }
    case 'stopping':     return { ...f, transition: 'stopping' }
    case 'reconnecting': return { ...f, state: 'yellow', transition: null, authFailed: false }
    case 'authfailed':   return { ...f, state: 'yellow', transition: null, authFailed: true }
    case 'endpointrejected': return {
      ...f, state: 'yellow', transition: null, authFailed: false,
      endpointRejectedReason: f.endpointRejectedReason
        ?? 'a plaintext ws daemon endpoint is allowed only on a loopback host',
      endpointRepairCommand: f.endpointRepairCommand
        ?? 'bridge-agent auth --daemon-server wss://<host>/ws/daemon',
    }
    case 'foreignregistration': return {
      ...f, transition: null, authFailed: false,
      foreignRegistrationReason: f.foreignRegistrationReason
        ?? 'The login service is registered against a different (older) install of the daemon, '
          + 'so restarting it would keep launching that one.',
    }
    case 'offline':      return { ...f, state: 'red', transition: null, authFailed: false, activePanels: 0 }
  }
}

// ── the phase ─────────────────────────────────────────────────────────────

export function derivePhase(f: PopoverFacts): Phase {
  // A start or stop this app launched outranks everything: the daemon's health
  // during a transition is a snapshot of something already being replaced.
  if (f.transition === 'starting') return 'starting'
  if (f.transition === 'stopping') return 'stopping'
  // A rejected token is the fault to fix whether the daemon survived it or not
  // — it exits shortly after the second 1008, so both readings mean sign-in.
  // A refused endpoint outranks a rejected token, and the order matters: the
  // daemon ranks it the same way (commands/start.ts), and it never dials in
  // this state, so any auth-failed reading alongside it is stale by definition.
  // Ranking auth-failed first put the wizard in front of the user instead —
  // and that wizard's auth fails on the very endpoint being complained about.
  if (f.endpointRejectedReason !== null) return 'endpointrejected'
  if (f.authFailed) return 'authfailed'
  // A launchd registration that is not ours (#577) outranks every health reading
  // below it and NONE of the two above it. Above: the daemon told us the fault
  // itself, over a working socket, and that is more specific than what we inferred
  // from a start attempt. Below: 'offline' would offer Start, which for this state
  // is the button that has already failed and will fail identically forever, and
  // 'reconnecting' / 'working' would name a socket while the actual fault is that
  // launchd is holding someone else's program under our label.
  if (f.foreignRegistrationReason !== null) return 'foreignregistration'
  if (f.state === 'red') return 'offline'
  if (f.state === 'yellow') return 'reconnecting'
  return f.activePanels > 0 ? 'working' : 'idle'
}

// ── the presentation ──────────────────────────────────────────────────────

export function present(f: PopoverFacts): Presentation {
  const phase = derivePhase(f)
  const uptime = formatUptime(f.uptimeSeconds)
  const panels = f.activePanels

  const openJerico = f.webAvailable
    ? { label: 'Open Jerico', action: 'open-jerico' as const, enabled: true }
    : { label: 'Server configuration required', action: 'open-jerico' as const, enabled: false }
  const stopVerb: Verb = { label: 'Stop daemon', action: 'stop', tone: 'bad' }

  switch (phase) {
    case 'working': {
      const parts: string[] = []
      if (uptime) parts.push(`up ${uptime}`)
      return {
        phase,
        headline: `${String(panels)} ${plural(panels, 'panel', 'panels')}`,
        context: '',
        sub: { status: 'connected', parts },
        count: `${String(panels)} running`,
        primary: openJerico,
        verbs: [stopVerb],
        trace: traceForRun(f),
        tone: 'live',
      }
    }

    case 'idle': {
      const parts: string[] = []
      if (uptime) parts.push(`up ${uptime}`)
      parts.push('no panels open')
      return {
        phase,
        headline: 'Idle',
        context: '',
        sub: { status: 'connected', parts },
        count: 'none open',
        primary: openJerico,
        verbs: [stopVerb],
        trace: traceForRun(f),
        tone: 'live',
      }
    }

    case 'starting':
      return {
        phase,
        headline: 'Starting…',
        context: 'launchd kickstart',
        sub: { status: null, parts: [`waiting for the health port on 127.0.0.1:${String(f.healthPort)}`] },
        count: '—',
        // Opening the app mid-start is harmless and often the reason someone
        // started it, so it stays live. There is nothing to stop yet.
        primary: openJerico,
        verbs: [],
        trace: 'scan',
        tone: 'hold',
      }

    case 'reconnecting': {
      const parts: string[] = []
      if (f.reconnectAttempts > 0) parts.push(`attempt ${String(f.reconnectAttempts)}`)
      const ago = formatAgo(f.lastPongAgoMs)
      if (ago) parts.push(`last pong ${ago} ago`)
      parts.push(
        panels > 0
          ? `${String(panels)} ${plural(panels, 'panel', 'panels')} held`
          : 'no panels held',
      )
      return {
        phase,
        headline: 'Reconnecting',
        context: 'the daemon is running, the socket is not',
        sub: { status: null, parts },
        count: panels > 0 ? `${String(panels)} held` : 'none held',
        primary: openJerico,
        // The fix for a wedged socket is a redial, and it is offered as soon as
        // the popover is open — unlike the old menu item, which stayed hidden
        // until the second attempt because a menu could not show why it existed.
        verbs: [{ label: 'Reconnect now', action: 'reconnect', tone: 'warn' }, stopVerb],
        trace: f.rttHistory === null ? 'none' : 'break',
        tone: 'hold',
      }
    }

    case 'endpointrejected':
      return {
        phase,
        headline: 'Server address refused',
        context: 'the daemon is running and will not dial it',
        sub: {
          status: null,
          // The daemon's own sentence, verbatim, then the command that actually
          // repairs it. Paraphrasing the first would put this file in the
          // business of restating a rule it does not own; omitting the second
          // was the first version's mistake — it named a remedy ("Re-authenticate")
          // that opens the connect page and cannot rewrite an endpoint.
          parts: [
            f.endpointRejectedReason ?? 'the configured server endpoint was refused',
            f.endpointRepairCommand ?? 'bridge-agent auth --daemon-server wss://<host>/ws/daemon',
          ],
        },
        count: panels > 0 ? `${String(panels)} running` : '0 running',
        // NOT "Re-authenticate": that action opens the connect page (tray.ts
        // runAction), and no amount of signing in on the web rewrites the
        // endpoint in settings.json. The honest primary is the log, where the
        // daemon has written the reason and the exact command.
        primary: { label: 'Open logs', action: 'logs', enabled: true },
        // No "Reconnect now" either: there is nothing to reconnect to, and
        // offering it would suggest the fault is transient.
        verbs: [stopVerb],
        trace: 'flat',
        tone: 'hold',
      }

    case 'foreignregistration':
      return {
        phase,
        headline: 'Login service misregistered',
        context: 'launchd holds another install of the daemon',
        sub: {
          status: null,
          // Same shape as endpointrejected, and for the same reason: the daemon's
          // own sentence verbatim (paraphrasing would put this file in the business
          // of restating a rule it does not own), then what the repair costs. The
          // cost line is not decoration — the repair stops running agents, and a
          // button that does that without saying so is a trap.
          parts: [
            f.foreignRegistrationReason ?? 'the login service is registered against another install',
            panels > 0
              ? `re-registering restarts the daemon and stops ${String(panels)} running ${plural(panels, 'panel', 'panels')}`
              : 're-registering restarts the daemon and stops any running agents',
          ],
        },
        count: panels > 0 ? `${String(panels)} running` : '0 running',
        // A BUTTON, deliberately, not an automatic restart: this state is observed
        // on every app launch and every tray Reconnect, and `restart` unloads the
        // job and kills live PTY sessions. Repeating that unasked is the same
        // mistake the daemon refuses to make when it declines to bootout a running
        // job. The user chooses, having been told what it costs.
        primary: { label: 'Re-register login service', action: 'reregister-service', enabled: true },
        verbs: [{ label: 'Open logs', action: 'logs', tone: '' }],
        trace: f.rttHistory === null ? 'none' : 'break',
        tone: 'hold',
      }

    case 'authfailed':
      return {
        phase,
        headline: 'Sign-in expired',
        context: 'token rejected',
        sub: {
          status: null,
          parts: [
            f.state === 'red'
              ? 'the daemon exited after the rejection'
              : 'the daemon is running',
            'the server closed with 1008',
          ],
        },
        count: panels > 0 ? `${String(panels)} running` : '0 running',
        primary: f.webAvailable
          ? { label: 'Re-authenticate', action: 'reauth', enabled: true }
          : { label: 'Server configuration required', action: 'reauth', enabled: false },
        verbs: f.state === 'red' ? [] : [stopVerb],
        trace: f.rttHistory === null ? 'none' : 'break',
        tone: 'hold',
      }

    case 'stopping':
      return {
        phase,
        headline: 'Stopping…',
        context: panels > 0
          ? `terminating ${String(panels)} ${plural(panels, 'panel', 'panels')}`
          : 'terminating',
        sub: { status: null, parts: ['SIGTERM sent', 'the login service unloads after'] },
        count: panels > 0 ? `${String(panels)} closing` : '—',
        // Nothing to open into: the thing being stopped is the thing that would
        // serve it. The design disables it rather than hiding it, so the
        // surface does not reflow under a click that is about to land.
        primary: { ...openJerico, enabled: false },
        verbs: [],
        trace: 'scan',
        tone: 'down',
      }

    case 'offline': {
      const parts: string[] = []
      const ago = formatAgo(f.stoppedAgoMs)
      if (ago) parts.push(`stopped ${ago} ago`)
      parts.push('launchd idle')
      return {
        phase,
        headline: 'Offline',
        context: 'daemon not running',
        sub: { status: null, parts },
        count: 'none',
        primary: { label: 'Start daemon', action: 'start', enabled: true },
        verbs: f.webAvailable
          ? [{ label: 'Open Jerico', action: 'open-jerico', tone: '' }]
          : [],
        trace: 'flat',
        tone: 'down',
      }
    }
  }
}

/** Healthy states plot the run — unless the daemon never sent one, in which
 *  case the strip says so instead of drawing a flat line that would read as
 *  "every ping took zero milliseconds". */
function traceForRun(f: PopoverFacts): TraceMode {
  return f.rttHistory === null ? 'none' : 'run'
}
