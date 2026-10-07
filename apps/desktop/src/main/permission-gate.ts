import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { getPlatformLifecycle } from './lifecycle/factory.js'
import { getHealthPort } from './utils/profile.js'
import { DAEMON_PROBE_KEYCHAIN_TIMEOUT_MS, spawnBridgeAgent } from './utils/spawn.js'

const JERICO_DIR = path.join(homedir(), '.jerico')

export interface PermissionStatus {
  keychain: boolean
  launchAgent: boolean
  bridgeDir: boolean
  jericoDir: boolean
}

export interface PermissionGateResult {
  passed: boolean
  status: PermissionStatus
}

/**
 * Run all four mandatory permission checks:
 * 1. Keychain ACL — via bridge-agent probe-keychain (writes+reads test entry)
 * 2. LaunchAgent — the plist FILE exists and is structurally sane. NOT loaded, and
 *    NOT "the loaded registration is ours" — see checkLaunchAgent().
 * 3. ~/.bridge ownership — stat uid matches process uid
 * 4. ~/.jerico ownership — stat uid matches process uid
 */
export async function runPermissionGate(): Promise<PermissionGateResult> {
  const status: PermissionStatus = {
    keychain: await probeKeychainAcl(),
    launchAgent: await checkLaunchAgent(),
    bridgeDir: checkDirOwnership(path.join(homedir(), '.bridge')),
    jericoDir: checkDirOwnership(JERICO_DIR),
  }
  return {
    passed: status.keychain && status.launchAgent && status.bridgeDir && status.jericoDir,
    status,
  }
}

async function probeKeychainAcl(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  try {
    const result = await spawnBridgeAgent(
      ['probe-keychain'],
      undefined,
      DAEMON_PROBE_KEYCHAIN_TIMEOUT_MS,
    )
    return result.code === 0
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), level: 'error', event: 'permissions.probe_keychain_error', error: String(err) }))
    return false
  }
}

async function checkLaunchAgent(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const lifecycle = getPlatformLifecycle(getHealthPort())
  try {
    // Treat as granted when the plist exists on disk. We do NOT require
    // the job to be currently loaded/running — startTray will handle
    // loading+kickstart via lifecycle.start(). Requiring launchctl list
    // would false-block reopen after a bootout quit.
    //
    // DELIBERATELY NOT DETECTED HERE: a foreign launchd registration (#577) —
    // launchd holding this label against a different install's program. On such a
    // machine the plist file is well-formed and this returns true, so the gate
    // passes and isSetupComplete() routes to the tray. That is on purpose: this
    // check is a permission barrier, and a registration mismatch is neither a
    // permission nor something the gate could repair (it is not a matter of the
    // file, and only `bridge-agent restart` clears it). It is detected where the
    // repair lives — the daemon reports `foreign_registration_running` from
    // `start`, and TrayController surfaces the popover's foreignregistration phase
    // with a "Re-register login service" action. If that path is ever removed, this
    // comment becomes a lie and this check has to grow a launchctl probe.
    return await lifecycle.isInstalled()
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), level: 'error', event: 'permissions.check_launch_agent_error', error: String(err) }))
    return false
  }
}

function checkDirOwnership(dir: string): boolean {
  try {
    if (!existsSync(dir)) return true
    const s = statSync(dir)
    const uid = process.getuid?.()
    return uid === undefined || s.uid === uid
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), level: 'error', event: 'permissions.check_dir_ownership_error', dir, error: String(err) }))
    return false
  }
}
