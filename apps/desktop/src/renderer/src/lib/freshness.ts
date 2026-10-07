/**
 * How long ago a reading was taken, in words.
 *
 * Lives here rather than inside UsagePanel.svelte so it can be tested: the clock
 * arithmetic is the part that was wrong, and a `.svelte` file cannot be reached by
 * `node --test`. Same split as `lib/rail.ts`.
 */

/**
 * `just now`, `41s ago`, `12m ago`, `3h 04m ago`, or `never` for no reading.
 *
 * `now` is passed in rather than read, both so this is a pure function and because
 * the component holds a clock that ticks once a second.
 *
 * The clamp is the fix, not a defensive habit: the daemon stamps `fetchedAt` with
 * its own clock and the caller's `now` moves in one-second steps, so a reading that
 * has only just landed can sit a few hundred milliseconds in the FUTURE. Floored,
 * that printed `updated -1s ago` — a measurement taken after the present — which was
 * observed live in the popover immediately after a refresh. Clamping to zero reports
 * a fresh reading as fresh. It also means a badly skewed daemon clock reads as `just
 * now` instead of as a negative age: still wrong, but wrong in a way that says
 * "recent" rather than nonsense, and the skew belongs to whoever set the clock.
 */
export function ago(fetchedAt: number | null, now: number): string {
  if (fetchedAt === null) return 'never'
  const s = Math.max(0, Math.floor((now - fetchedAt) / 1000))
  if (s === 0) return 'just now'
  if (s < 60) return `${String(s)}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${String(m)}m ago`
  const h = Math.floor(m / 60)
  return `${String(h)}h ${String(m % 60).padStart(2, '0')}m ago`
}
