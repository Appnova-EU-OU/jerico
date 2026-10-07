import { existsSync } from 'node:fs'
import path from 'path'
import { homedir } from 'node:os'
import { getDaemonEntry } from '../version.js'
import { setupLaunchd, startOrKickstartDaemon, verifyDaemonHealth, humanStartFailure } from './start.js'
import { getPlistName } from '../profile.js'

const LAUNCH_AGENTS = path.join(homedir(), 'Library', 'LaunchAgents')

export type InstallServiceResult =
  | { ok: true }
  | { ok: false; reason: 'plist_write' | 'launchctl_load' | 'permission_denied'; message: string }

export function runInstallService(): InstallServiceResult {
  console.log('[bridge] service.install.start')

  const daemonEntry = getDaemonEntry()
  const plistName = getPlistName()
  const plistPath = path.join(LAUNCH_AGENTS, plistName)

  const plistWritten = setupLaunchd(daemonEntry)
  if (!plistWritten) {
    const msg = `Failed to write plist at ${plistPath}`
    console.error('[bridge] service.install.plist_write.failed', { path: plistPath })
    return { ok: false, reason: 'plist_write', message: msg }
  }
  console.log('[bridge] service.install.plist_write.ok', { path: plistPath })

  const { ok: launched, reason } = startOrKickstartDaemon(daemonEntry)
  if (!launched) {
    if (reason === 'bootstrap_permission_denied') {
      console.error('[bridge] service.install.launchctl.permission_denied')
      return {
        ok: false,
        reason: 'permission_denied',
        message: `Permission denied. Manual: sudo launchctl bootstrap gui/$(id -u) "${plistPath}"`,
      }
    }
    // This is the FIRST-RUN wizard path: the desktop's permission gate renders this
    // message verbatim to someone who has just installed the app. It used to pass
    // the raw reason through — `foreign_registration_running: launchd holds this
    // label against "/Users/…/…"` — because only the `start` command called
    // humanStartFailure. The raw reason still goes to stderr as a separate detail
    // line, in this order, so the log and any consumer matching on the machine code
    // keep it while the LAST line stays the readable one.
    console.error('[bridge] service.install.launchctl.failed')
    console.error(`[bridge] install-service.failed.detail — ${reason}`)
    return { ok: false, reason: 'launchctl_load', message: humanStartFailure(reason) }
  }

  console.log('[bridge] service.install.ok')
  verifyDaemonHealth()
  return { ok: true }
}
