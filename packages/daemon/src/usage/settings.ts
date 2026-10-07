/**
 * Provider credentials the user supplies themselves.
 *
 * Read from the profile's own settings file — `~/.jerico/settings.json`, or the
 * per-profile equivalent — for one measured reason: **the launchd plist carries no
 * `EnvironmentVariables` block**, so a key exported in a shell never reaches the
 * daemon that actually runs. The first version of the kimi provider read only
 * `KIMI_CODE_API_KEY` from the environment and told the user to set it; that advice
 * worked for a foreground `bridge-agent` and silently did nothing for the launchd
 * service, which is how everyone runs it.
 *
 * Same pattern and same file as `pty/claude-quota.ts` `readTier()`, so a user who
 * has already set `claudeTier` knows where this goes.
 *
 * The environment still wins when it is set, because a foreground run for
 * debugging should be able to override the file without editing it.
 */

import { readFileSync, statSync } from 'node:fs'
import { getConfigPath } from '../config.js'

/**
 * A string setting, or null.
 *
 * Read at call time rather than cached: a user who pastes a key into the file
 * should not have to restart the daemon to see it work, and this runs once per
 * five-minute refresh at most.
 */
export function readSettingsString(key: string): string | null {
  try {
    const configPath = getConfigPath()
    if (!statSync(configPath, { throwIfNoEntry: false })) return null
    const obj = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    const value = obj[key]
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  } catch {
    // A malformed settings file is not this module's problem to report — the
    // provider that asked simply behaves as if the key were absent.
    return null
  }
}

/**
 * A provider key from the environment first, then the settings file.
 *
 * Returns the value AND where it came from, because the surface says which
 * credential answered and "$KIMI_CODE_API_KEY" versus "~/.jerico/settings.json" is
 * the difference between a user's two guesses about why a reading is missing.
 */
export function readProviderKey(
  envNames: readonly string[],
  settingsKey: string,
): { value: string; describe: string } | null {
  for (const name of envNames) {
    const v = process.env[name]
    if (v !== undefined && v.trim().length > 0) return { value: v.trim(), describe: `$${name}` }
  }
  const fromFile = readSettingsString(settingsKey)
  if (fromFile !== null) return { value: fromFile, describe: `${settingsKey} in ~/.jerico/settings.json` }
  return null
}
