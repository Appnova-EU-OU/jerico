import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { getConfigPath, getPlistName, getKeychainAccount } from './utils/profile.js'

interface JericoSettings {
  server?: string
  token?: string
  [key: string]: unknown
}

function hasAuthToken(settings: JericoSettings): boolean {
  if (process.platform === 'darwin') {
    // Keychain is the source of truth on macOS — the daemon strips the token
    // from settings.json after migrating it to the Keychain.
    try {
      const account = getKeychainAccount()
      const result = execFileSync('/usr/bin/security', [
        'find-generic-password', '-s', 'com.jerico.bridge-agent', '-a', account, '-w',
      ], { timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (result.trim().length > 0) return true
    } catch (err) {
      // exit 44 = errSecItemNotFound (no token yet — expected on a fresh/never-authed
      // machine; Welcome is correct). Any OTHER failure (locked keychain, ACL denial,
      // timeout) is logged so a systematic read failure isn't silently re-presented as
      // "Welcome on every restart". Either way, fall through to the file-token check.
      const status = (err as { status?: number }).status
      if (status !== 44) {
        const reason = err instanceof Error ? err.message : String(err)
        console.warn('[jerico-desktop] keychain token read failed unexpectedly, using file fallback', { status, reason })
      }
    }
    // Legacy fallback: pre-migration file token
    return !!settings['token']
  }
  // Linux / others: token lives in the file
  return !!settings['token']
}

export function isSetupComplete(): boolean {
  const settingsPath = getConfigPath()
  if (!fs.existsSync(settingsPath)) return false

  let settings: JericoSettings
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as JericoSettings
  } catch {
    return false
  }

  // Truthiness accepted `server: 42` and `server: {}` as configured. The gate's
  // job is to decide whether this machine is actually set up, and a number is
  // not a server URL — this is the check being wrong, not merely lenient.
  const server = settings['server']
  if (typeof server !== 'string' || server.trim() === '') return false
  if (!hasAuthToken(settings)) return false

  // The plist FILE, not the loaded registration. This question is "has this machine
  // been through setup", and it has: the file is ours and the token is there.
  //
  // It therefore returns true on a machine with a foreign launchd registration
  // (#577), where the file is correct and launchd is nonetheless holding a
  // different install's program under the same label — so such a machine skips the
  // wizard and goes to the tray. That is the intended route: the wizard cannot
  // repair a registration (launchd does not re-read the plist file of a
  // bootstrapped label), and the tray can — it surfaces the daemon's
  // `foreign_registration_running` verdict as the popover's foreignregistration
  // phase with a "Re-register login service" action. See permission-gate.ts's
  // checkLaunchAgent() for the same deliberate limit.
  const plistPath = path.join(
    homedir(), 'Library', 'LaunchAgents', getPlistName(),
  )
  return fs.existsSync(plistPath)
}
