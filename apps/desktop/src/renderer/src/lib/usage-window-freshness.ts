/** A provider measurement is no longer current once its stated reset elapsed. */
export function isUsageWindowExpired(window: { resetsAt: number | null }, now: number): boolean {
  return window.resetsAt !== null && window.resetsAt <= now
}
