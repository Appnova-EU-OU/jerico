/**
 * Pure utility: determine if a verifiedAt timestamp is stale (>7 days old).
 */
export function isPathStale(verifiedAt: string | undefined | null): boolean {
  if (!verifiedAt) return false
  const ms = Date.now() - new Date(verifiedAt).getTime()
  return ms > 7 * 24 * 60 * 60 * 1000
}

export function daysSince(verifiedAt: string | undefined | null): number | undefined {
  if (!verifiedAt) return undefined
  const ms = Date.now() - new Date(verifiedAt).getTime()
  return Math.floor(ms / (24 * 60 * 60 * 1000))
}
