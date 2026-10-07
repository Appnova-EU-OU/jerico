/**
 * migrate-from-npm — Transition from npm-installed bridge-agent to standalone binary.
 *
 * When users switch from `npm i -g bridge-agent` to the standalone pkg binary,
 * the launchd plist still points to the old npm-installed path. This command
 * stops the old daemon, re-installs the launchd service pointing to the new binary,
 * and removes the old wrapper script.
 *
 * Run once after downloading the standalone binary:
 *   ./bridge-agent migrate-from-npm
 */

import { stopDaemon } from './stop.js'
import { runInstallService } from './install-service.js'

export function runMigrateFromNpm(): void {
  const isPkg = (process as any).pkg !== undefined

  if (!isPkg) {
    console.log('[bridge] migrate.from-npm.skipped — not running as standalone binary.')
    console.log('[bridge] This command is only needed when switching from npm to binary.')
    console.log('[bridge] If you want to update your launchd service, run: bridge-agent install-service')
    process.exit(0)
  }

  console.log('[bridge] migrate.from-npm.start')

  // Step 1: Stop any running daemon (old or new)
  console.log('[bridge] migrate.step1.stopping_old_daemon')
  const stopResult = stopDaemon()
  if (!stopResult.ok) {
    console.warn(`[bridge] migrate.step1.stop_note — ${stopResult.reason} (continuing anyway)`)
  } else {
    console.log('[bridge] migrate.step1.stop_ok')
  }

  // Step 2: Clean up old npm wrapper script (if it exists and differs)
  // The wrapper at ~/.bridge/bin/bridge-agent-wrapper might point to the npm path.
  // install-service will rewrite it to point to the binary.
  console.log('[bridge] migrate.step2.reinstalling_launchd_service')
  const result = runInstallService()
  if (!result.ok) {
    console.error(`[bridge] migrate.from-npm.failed: ${result.message}`)
    process.exit(1)
  }

  // Step 3: Inform user about optional npm cleanup
  console.log('[bridge] migrate.complete')
  console.log('[bridge] ')
  console.log('[bridge] Migration complete. The launchd service now points to this binary:')
  console.log(`[bridge]   ${process.execPath}`)
  console.log('[bridge] ')
  console.log('[bridge] Optional: remove the old npm package:')
  console.log('[bridge]   npm uninstall -g bridge-agent')

  process.exit(0)
}
