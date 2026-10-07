/** Bump when the daemon capability disclosure changes materially. */
export const CURRENT_CONSENT_VERSION = 1 as const

/** A stored acknowledgment satisfies only the disclosure version it names. */
export function consentSatisfied(stored: unknown, current: number): boolean {
  return typeof stored === 'number' && stored === current
}

/** Strip pre-release suffix: '0.10.0-beta.3' → '0.10.0' */
function normalize(v: string): string {
  return v.split('-')[0] ?? v
}

/** Parse 'major.minor.patch' into a numeric triple. Non-numeric parts become 0. */
function parse(v: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = normalize(v).split('.').map(Number)
  return [
    Number.isFinite(major) ? major : 0,
    Number.isFinite(minor) ? minor : 0,
    Number.isFinite(patch) ? patch : 0,
  ]
}

/**
 * Compare two semver strings. Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Null/undefined inputs are treated as '0.0.0' (always outdated).
 */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 {
  const [aMaj, aMin, aPat] = parse(a ?? '0.0.0')
  const [bMaj, bMin, bPat] = parse(b ?? '0.0.0')
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1
  if (aMin !== bMin) return aMin < bMin ? -1 : 1
  if (aPat !== bPat) return aPat < bPat ? -1 : 1
  return 0
}

/**
 * Returns true when the installed daemon version is behind the beta channel.
 * Returns false if any required value is missing (suppress banner rather than false-positive).
 */
export function daemonOutdated(
  installed: string | null | undefined,
  channel: { latest: string | null; beta: string | null } | null | undefined,
): boolean {
  if (!installed || !channel?.beta) return false
  return compareSemver(installed, channel.beta) < 0
}

/**
 * Returns the npm channel tag the user should install.
 * Prefers 'latest' (stable) when installed is behind latest; falls back to 'beta'.
 */
export function suggestedChannel(
  installed: string | null | undefined,
  channel: { latest: string | null; beta: string | null } | null | undefined,
): 'beta' | 'latest' {
  if (!channel?.latest || !installed) return 'beta'
  return compareSemver(installed, channel.latest) < 0 ? 'latest' : 'beta'
}
