/**
 * Reading a `bridge-agent` failure the way the daemon meant it to be read.
 *
 * The daemon prints TWO lines when a start fails — the humanised sentence first,
 * then the machine reason (`packages/daemon/src/commands/start.ts`, the
 * `start.failed` / `start.failed.detail` pair). Every consumer here used
 * `stderr.trim().split('\n').pop()`, which takes the LAST line, so the readable
 * sentence was thrown away and the opaque code kept — for every failure mode, not
 * just this one. This module is the coupling made explicit and testable instead of
 * two files silently agreeing about line order.
 *
 * IF YOU CHANGE THE MARKERS HERE, the other side is
 * `packages/daemon/src/commands/start.ts` (`start.failed` / `start.failed.detail`)
 * and `packages/daemon/src/commands/install-service.ts` +
 * `packages/daemon/src/index.ts` (`install-service.failed` /
 * `install-service.failed.detail`). Neither side may assume a position; both must
 * agree on these prefixes.
 */

/** The lines the daemon writes for a HUMAN, in the order it prefers them. */
const HUMAN_LINES: readonly RegExp[] = [
  /^\[bridge\]\s*start\.failed\s*—\s*(?<text>.+)$/,
  /^\[bridge\]\s*install-service\.failed:\s*(?<text>.+)$/,
  /^\[bridge\]\s*restart\.failed\s*—\s*(?<text>.+)$/,
]

/** The machine-readable companions. Never shown; matched against. */
const DETAIL_LINES: readonly RegExp[] = [
  /^\[bridge\]\s*start\.failed\.detail\s*—\s*(?<text>.+)$/,
  /^\[bridge\]\s*install-service\.failed\.detail\s*—\s*(?<text>.+)$/,
  /^\[bridge\]\s*restart\.failed\.detail\s*—\s*(?<text>.+)$/,
]

function lines(stderr: string): string[] {
  return stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

/**
 * The one line worth showing a person, out of everything the command printed.
 *
 * Prefers the daemon's own humanised sentence wherever it exists; falls back to the
 * last non-empty line, which is what the old `.pop()` always did.
 */
export function preferredFailureLine(stderr: string): string | null {
  const all = lines(stderr)
  if (all.length === 0) return null
  for (const pattern of HUMAN_LINES) {
    for (const line of all) {
      const text = pattern.exec(line)?.groups?.['text']
      if (text) return text
    }
  }
  return all[all.length - 1] ?? null
}

/** The machine reason, when the daemon printed one. For matching, not display. */
export function failureCode(stderr: string): string | null {
  const all = lines(stderr)
  for (const pattern of DETAIL_LINES) {
    for (const line of all) {
      const text = pattern.exec(line)?.groups?.['text']
      if (text) return text
    }
  }
  return null
}

export type ForeignRegistrationKind = 'running' | 'bootout_failed'

/**
 * The leading token of a `*.failed.detail` line, which is the daemon's reason CODE.
 *
 * The daemon writes the code first and then, after a colon, a detail string that
 * carries paths and prose (`start.ts`: `foreign_registration_running: launchd holds
 * this label against "…"`). Only the code decides anything; the detail is evidence
 * for a human. Anchoring here is the point — see foreignRegistrationFault().
 */
function reasonCode(stderr: string): string | null {
  const detail = failureCode(stderr)
  if (detail === null) return null
  return /^([A-Za-z0-9_]+)/.exec(detail)?.[1] ?? null
}

export interface ForeignRegistrationFault {
  kind: ForeignRegistrationKind
  /** The sentence to put on the surface: the daemon's humanised line when it sent
   *  one, else its raw reason. Never fabricated here. */
  message: string
}

/**
 * Did this failure mean "launchd holds a registration that is not ours"?
 *
 * This is the one daemon failure the desktop cannot retry its way out of: `start`
 * is deliberately non-destructive for a RUNNING foreign registration, so pressing
 * Start again produces the identical error forever. Recognising it is what lets the
 * tray offer the repair as an explicit action instead of going red and staying red.
 *
 * Matched on the ANCHORED reason code, never on the raw blob. A substring test over
 * everything the command printed also fires on text that merely CONTAINS the word —
 * a quoted path is enough, e.g. a plist or settings file under
 * `…/backups/foreign_registration_archive/`, which the daemon happily prints inside
 * its detail strings and which the desktop then classified as this fault. Both
 * consumers are destructive-adjacent when that happens: the wizard tells the user to
 * run `bridge-agent restart` (which kills live PTY sessions) for an unrelated
 * problem, and the tray pins the popover to the foreignregistration phase, HIDING
 * the real error. So the test is: did the daemon name this as its reason code.
 */
export function foreignRegistrationFault(stderr: string): ForeignRegistrationFault | null {
  const code = reasonCode(stderr)
  if (code === null || !code.startsWith('foreign_registration')) return null
  const kind: ForeignRegistrationKind = code === 'foreign_registration_bootout_failed'
    ? 'bootout_failed'
    : 'running'
  const human = preferredFailureLine(stderr)
  return { kind, message: human ?? failureCode(stderr) ?? 'the login service is registered against another install' }
}
