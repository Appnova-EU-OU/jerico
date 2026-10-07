/**
 * The popover's activity register.
 *
 * The design shows daemon-side events — `run.start`, `panel.spawn`,
 * `todo.completed`. The daemon does not expose any of that to this app: its
 * /health endpoint is a snapshot, not a stream, and nothing here can read the
 * orchestrator's log. So this records what the DESKTOP genuinely witnessed —
 * lifecycle actions it took, health transitions it polled, updater events it
 * was handed — and every line is a real observation with a real timestamp.
 *
 * That is a narrower register than the design draws, and deliberately so. The
 * alternative was rows of plausible-looking orchestrator traffic that no part
 * of this process has ever seen, which is the one thing a diagnostic surface
 * must not do.
 */

export type EventLevel = '' | 'warn' | 'bad'

export interface LoggedEvent {
  /** Wall clock, ms. Formatted in the renderer so it follows the user's locale. */
  at: number
  /** Dotted, lowercase, in the daemon's own log vocabulary. */
  event: string
  detail: string
  level: EventLevel
}

/** Deep enough for the expanded register (about twelve lines) with room to
 *  scroll a little, shallow enough that it is never a memory question. */
const CAPACITY = 60

const entries: LoggedEvent[] = []
const listeners = new Set<() => void>()

export function recordEvent(event: string, detail: string, level: EventLevel = ''): void {
  entries.push({ at: Date.now(), event, detail, level })
  if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY)
  for (const fn of listeners) fn()
}

/** Oldest first, which is the order the register reads in. */
export function getEvents(): LoggedEvent[] {
  return entries.slice()
}

export function onEvent(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Wall-clock ms of the most recent occurrence of an event, or null. Used for
 *  "stopped 2m 14s ago" — which is only claimed when this app is the thing that
 *  watched it stop. */
export function lastAt(event: string): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e && e.event === event) return e.at
  }
  return null
}

/** Reset between profiles/tests. Not called in the app's own lifetime. */
export function clearEvents(): void {
  entries.length = 0
  for (const fn of listeners) fn()
}
