import { execSync } from 'node:child_process'
import { existsSync, unlinkSync, rmdirSync, readFileSync, lstatSync, rmSync } from 'node:fs'
import path from 'path'
import { canRemoveSharedMcpWrapper, getAllArtifactPaths, getPlistName } from '../profile.js'
import { deleteToken, deleteAllTokens } from '../token-store.js'
import { removeHookBlock } from '../hooks/install.js'

export interface UninstallResult {
  stopped: boolean
  plistRemoved: boolean
  wrapperRemoved: boolean
  lockRemoved: boolean
  logsRemoved: boolean
  configRemoved: boolean
  hookDescriptorRemoved: boolean
  hookScriptRemoved: boolean
  residueRemoved: boolean
  dirsRemoved: string[]
  errors: Array<{ step: string; error: string }>
}

/** Remove a single file path, ENOENT-safe. Returns true if removed or already absent. */
function tryUnlink(filePath: string, dryRun: boolean, label: string, result: UninstallResult): boolean {
  if (!existsSync(filePath)) return true
  if (dryRun) {
    console.log(`[bridge] uninstall.dry_run — would remove: ${filePath}`)
    return true
  }
  try {
    unlinkSync(filePath)
    console.log(`[bridge] uninstall.${label}.removed`, { path: filePath })
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[bridge] uninstall.step.failed`, { step: label, error: msg })
    result.errors.push({ step: label, error: msg })
    return false
  }
}

/** Remove a directory only if empty. Never rm -rf. */
function tryRmdir(dirPath: string, dryRun: boolean, result: UninstallResult): void {
  if (!existsSync(dirPath)) return
  if (dryRun) {
    console.log(`[bridge] uninstall.dry_run — would rmdir (if empty): ${dirPath}`)
    return
  }
  try {
    rmdirSync(dirPath)
    console.log(`[bridge] uninstall.dir.removed`, { path: dirPath })
    result.dirsRemoved.push(dirPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if ((err as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
      console.log(`[bridge] uninstall.dir_not_empty`, { path: dirPath })
    } else if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[bridge] uninstall.step.failed`, { step: 'rmdir', error: msg })
      result.errors.push({ step: `rmdir:${dirPath}`, error: msg })
    }
  }
}

/** Remove the one profile-derived evidence tree. Refuse symlinks so recursive
 * removal can never follow a replacement outside the canonical profile root. */
function tryRemoveEvidenceRoot(dirPath: string, dryRun: boolean, result: UninstallResult): void {
  if (!existsSync(dirPath)) return
  if (dryRun) {
    console.log(`[bridge] uninstall.dry_run — would remove completion evidence: ${dirPath}`)
    return
  }
  try {
    const stat = lstatSync(dirPath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('completion evidence root is not a real directory')
    }
    rmSync(dirPath, { recursive: true, force: false })
    console.log('[bridge] uninstall.completion_evidence.removed', { path: dirPath })
    result.dirsRemoved.push(dirPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[bridge] uninstall.step.failed', { step: 'completion_evidence', error: msg })
    result.errors.push({ step: 'completion_evidence', error: msg })
  }
}

export async function runUninstall(opts: { dryRun?: boolean; force?: boolean; json?: boolean }): Promise<void> {
  const { dryRun = false, force = false, json = false } = opts

  if (process.getuid !== undefined && process.getuid() === 0) {
    console.error('[bridge] uninstall.aborted.root_user — do not run uninstall as root')
    process.exit(1)
  }

  if (!dryRun && !force && process.stdin.isTTY) {
    const confirmed = await promptConfirm()
    if (!confirmed) {
      console.log('[bridge] uninstall.cancelled')
      process.exit(0)
    }
  }

  console.log('[bridge] uninstall.start', { dryRun })

  const result: UninstallResult = {
    stopped: false,
    plistRemoved: false,
    wrapperRemoved: false,
    lockRemoved: false,
    logsRemoved: false,
    configRemoved: false,
    hookDescriptorRemoved: false,
    hookScriptRemoved: false,
    residueRemoved: false,
    dirsRemoved: [],
    errors: [],
  }

  const artifacts = getAllArtifactPaths()
  const removeSharedMcpWrapper = canRemoveSharedMcpWrapper()
  const plistName = getPlistName()
  const plistLabel = plistName.replace('.plist', '')

  // Step 1: stop daemon via launchctl bootout
  if (!dryRun) {
    try {
      execSync(`launchctl bootout gui/$(id -u)/${plistLabel} 2>/dev/null`, { stdio: 'pipe', timeout: 5000 })
      console.log('[bridge] uninstall.daemon.stopped')
      result.stopped = true
    } catch {
      console.log('[bridge] uninstall.daemon.not_managed')
    }

    // Step 2: if PID still alive from lock file, SIGKILL after 3s
    if (existsSync(artifacts.lock)) {
      try {
        const { pid } = JSON.parse(readFileSync(artifacts.lock, 'utf-8')) as { pid: number }
        if (pid) {
          const deadline = Date.now() + 3000
          while (Date.now() < deadline) {
            try {
              process.kill(pid, 0) // probe — throws if dead
              await new Promise<void>((r) => setTimeout(r, 300))
            } catch {
              break
            }
          }
          try {
            process.kill(pid, 0) // still alive?
            process.kill(pid, 9)
            console.log('[bridge] uninstall.daemon.killed', { pid })
            result.stopped = true
          } catch {
            // already dead — good
            result.stopped = true
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('[bridge] uninstall.daemon.kill_failed', { error: msg })
        result.errors.push({ step: 'daemon.kill', error: msg })
      }
    }
  } else {
    console.log('[bridge] uninstall.dry_run — would stop daemon via launchctl bootout')
  }

  // Step 3: remove plist
  result.plistRemoved = tryUnlink(artifacts.plist, dryRun, 'plist', result)

  // Step 4: remove wrapper
  result.wrapperRemoved = tryUnlink(artifacts.wrapper, dryRun, 'wrapper', result)

  // Step 5: remove lock
  result.lockRemoved = tryUnlink(artifacts.lock, dryRun, 'lock', result)

  // Step 6: remove logs
  const logOutRemoved = tryUnlink(artifacts.logOut, dryRun, 'log_out', result)
  const logErrRemoved = tryUnlink(artifacts.logErr, dryRun, 'log_err', result)
  const logLifecycleRemoved = tryUnlink(artifacts.logLifecycle, dryRun, 'log_lifecycle', result)
  result.logsRemoved = logOutRemoved && logErrRemoved && logLifecycleRemoved

  // Profile-owned residue which otherwise changes the next install's behaviour.
  const spawnManifestRemoved = tryUnlink(artifacts.spawnManifest, dryRun, 'spawn_manifest', result)
  const introSeenRemoved = tryUnlink(artifacts.introSeen, dryRun, 'intro_seen', result)
  const mcpWrapperRemoved = removeSharedMcpWrapper
    ? tryUnlink(artifacts.sharedMcpWrapper, dryRun, 'shared_mcp_wrapper', result)
    : true
  result.residueRemoved = spawnManifestRemoved && introSeenRemoved && mcpWrapperRemoved

  // Step 7: remove config (non-secret fields only; token is in Keychain) — lstat guard against symlink attack
  // Step 6.5 (before file): delete Keychain entry so we don't leave orphaned secrets
  if (!dryRun) {
    deleteToken()
    console.log('[bridge] uninstall.token.keychain_deleted')
  } else {
    console.log('[bridge] uninstall.dry_run — would delete Keychain token entry')
  }

  if (!existsSync(artifacts.config)) {
    // already absent — idempotent
    result.configRemoved = true
  } else if (!dryRun) {
    try {
      const stat = lstatSync(artifacts.config)
      if (!stat.isFile()) {
        console.warn('[bridge] uninstall.config.not_regular_file', { path: artifacts.config })
        result.errors.push({ step: 'config', error: 'not a regular file — skipped (symlink attack guard)' })
      } else {
        unlinkSync(artifacts.config)
        console.log('[bridge] uninstall.config.removed', { path: artifacts.config })
        result.configRemoved = true
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[bridge] uninstall.step.failed', { step: 'config', error: msg })
      result.errors.push({ step: 'config', error: msg })
    }
  } else {
    console.log(`[bridge] uninstall.dry_run — would remove config (auth token): ${artifacts.config}`)
    result.configRemoved = true
  }

  // Completion evidence is the only recursively-owned profile artifact. Its
  // path is derived centrally and never accepted from a caller.
  tryRemoveEvidenceRoot(artifacts.completionEvidenceRoot, dryRun, result)

  // Step 7.5: remove hook artifacts
  result.hookDescriptorRemoved = tryUnlink(artifacts.hookDescriptor, dryRun, 'hook_descriptor', result)
  
  if (artifacts.hookScript) { // only set for default profile
    let blockRemoved = false
    if (!dryRun) {
      try {
        const blockStatus = await removeHookBlock('claude')
        // Note: InstallResult is shared by install and remove paths. 
        // In the remove path, 'already-present' means the block was already ABSENT (i.e. successfully not there).
        if (blockStatus === 'installed' || blockStatus === 'already-present' || blockStatus === 'target-missing') {
          console.log('[bridge] uninstall.hook_block.removed', { status: blockStatus })
          blockRemoved = true
        } else {
          console.warn('[bridge] uninstall.step.refused', { step: 'hook_block', status: blockStatus })
          result.errors.push({ step: 'hook_block', error: `left the script in place because the block is still there (${blockStatus})` })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('[bridge] uninstall.step.failed', { step: 'hook_block', error: msg })
        result.errors.push({ step: 'hook_block', error: `left the script in place because the block is still there (threw: ${msg})` })
      }
    } else {
      console.log(`[bridge] uninstall.dry_run — would remove hook block from settings`)
      blockRemoved = true
    }
    if (blockRemoved) {
      result.hookScriptRemoved = tryUnlink(artifacts.hookScript, dryRun, 'hook_script', result)
    }
  }

  // Step 8: prod-only — remove update lock + state (not profile-isolated)
  if (artifacts.updateLock) tryUnlink(artifacts.updateLock, dryRun, 'update_lock', result)
  if (artifacts.updateState) tryUnlink(artifacts.updateState, dryRun, 'update_state', result)

  // Step 9: rmdir daemon-owned parent directories if empty.
  const bridgeDir = path.dirname(artifacts.lock)
  tryRmdir(path.dirname(artifacts.sharedMcpWrapper), dryRun, result)
  tryRmdir(bridgeDir, dryRun, result)

  // Step 10: rmdir ~/.jerico/profiles/<p>/ + ~/.jerico/ if empty
  const profileEnv = process.env['BRIDGE_PROFILE']
  const jericoDir = profileEnv
    ? path.resolve(path.dirname(artifacts.config), '..', '..')
    : path.dirname(artifacts.config)
  if (profileEnv) {
    tryRmdir(path.join(jericoDir, 'profiles', profileEnv), dryRun, result)
    tryRmdir(path.join(jericoDir, 'profiles'), dryRun, result)
  }
  tryRmdir(jericoDir, dryRun, result)

  // Step 11: global uninstall — clean up all profile Keychain entries
  // When no BRIDGE_PROFILE is set (prod uninstall), remove all named profile
  // Keychain entries too. The active entry was already deleted in step 6.5.
  if (!dryRun && !profileEnv) {
    deleteAllTokens()
    console.log('[bridge] uninstall.token.all_keychain_entries_deleted')
  }

  const removedCount = [result.plistRemoved, result.wrapperRemoved, result.lockRemoved, result.logsRemoved, result.configRemoved].filter(Boolean).length
  console.log('[bridge] uninstall.complete', { removedCount, errorCount: result.errors.length, dryRun })

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  }

  process.exit(result.errors.length > 0 ? 1 : 0)
}

async function promptConfirm(): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(
      'This will stop the daemon, remove the login service, delete the auth token,\n' +
      'config, logs, and wrapper script. This cannot be undone.\n' +
      'Type "yes" to continue: ',
    )
    let input = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.resume()
    process.stdin.on('data', (chunk: string) => {
      input += chunk
      if (input.includes('\n')) {
        process.stdin.pause()
        resolve(input.trim().toLowerCase() === 'yes')
      }
    })
  })
}
