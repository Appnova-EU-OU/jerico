import { execSync } from 'node:child_process'

/**
 * Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 * Inline implementation — no external dependency.
 * Handles pre-release tags by naive string comparison after the numeric parts.
 */
export function semverCmp(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < 3; i++) {
    const na = parseInt(pa[i] ?? '0', 10)
    const nb = parseInt(pb[i] ?? '0', 10)
    if (isNaN(na) || isNaN(nb)) break
    if (na !== nb) return na - nb
  }
  // All numeric parts equal — fall back to lexical for pre-release tags
  return a.localeCompare(b)
}

export function semverGt(a: string, b: string): boolean {
  return semverCmp(a, b) > 0
}

/**
 * Fetch the latest version of bridge-agent for the given npm dist-tag channel.
 *
 * @param channel - npm dist-tag (default 'latest')
 * @returns the latest version string, or null on failure (network, timeout, etc.)
 */
export function getLatest(channel: string = 'latest'): string | null {
  const validChannels = ['latest', 'beta', 'next', 'canary']
  const safeChannel = validChannels.includes(channel) ? channel : 'latest'

  try {
    const result = execSync(
      `npm view bridge-agent@${safeChannel} version`,
      { timeout: 5000, stdio: 'pipe' },
    )
    const version = result.toString().trim()
    // Basic validation: must look like x.y.z with optional pre-release
    if (/^\d+\.\d+\.\d+/.test(version)) {
      return version
    }
    return null
  } catch {
    return null
  }
}

/**
 * Get the latest version and compare against the current version.
 *
 * Returns:
 *   { updateAvailable: true, latestVersion } if latest > current
 *   { updateAvailable: false, currentVersion, reason } otherwise
 *
 * NEVER returns a downgrade path — if latest < current the user is
 * on a pre-release or dev build ahead of the public channel.
 */
export function checkForUpdate(
  channel: string = 'latest',
  currentVersion: string,
): { updateAvailable: boolean; latestVersion?: string; currentVersion: string; reason?: string } {
  const latest = getLatest(channel)
  if (!latest) {
    return {
      updateAvailable: false,
      currentVersion,
      reason: 'registry_unreachable',
    }
  }
  if (semverGt(currentVersion, latest)) {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: latest,
      reason: 'ahead_of_channel',
    }
  }
  if (currentVersion === latest) {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: latest,
      reason: 'up_to_date',
    }
  }
  return {
    updateAvailable: true,
    latestVersion: latest,
    currentVersion,
  }
}
