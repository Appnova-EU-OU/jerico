import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveSpawnHelperPath, setEffectiveSpawnHelperPath } from './spawn-helper-health.js'

/**
 * Resolve a stable spawn-helper path that pkg's VFS cache cannot invalidate.
 *
 * Precedence:
 *   1. Signed bundled sibling in Contents/Resources/ (Electron desktop install)
 *   2. pkg binary without a bundled sibling — extract from VFS snapshot to
 *      ~/.bridge/bin/spawn-helper and chmod +x so exec succeeds
 *   3. npm-global install — return null; postinstall.mjs already ensured +x
 *
 * Never throws; returns null on any failure so callers degrade gracefully.
 */
export function resolveStableSpawnHelper(): string | null {
  try {
    // Primary: signed bundled sibling (Electron desktop install).
    // bridge-agent lives at Contents/Resources/bridge-agent; spawn-helper is its sibling.
    const bundled = path.join(path.dirname(process.execPath), 'spawn-helper')
    if (fs.existsSync(bundled)) return bundled

    // Fallback: pkg binary without a bundled sibling (bare pkg, no Electron wrapper).
    // fs.readFileSync on a /snapshot/ VFS path works inside pkg; write bytes to real disk.
    if ((process as any).pkg !== undefined) {
      const srcPath = resolveSpawnHelperPath()
      if (srcPath) {
        const targetDir = path.join(os.homedir(), '.bridge', 'bin')
        const target = path.join(targetDir, 'spawn-helper')
        try {
          fs.mkdirSync(targetDir, { recursive: true })
          const bytes = fs.readFileSync(srcPath)
          fs.writeFileSync(target, bytes)
          fs.chmodSync(target, 0o755)
          return target
        } catch (err) {
          console.warn('[bridge] spawn-helper.extract.failed', { error: String(err) })
        }
      }
    }

    // npm-global install: no patch needed.
    return null
  } catch {
    return null
  }
}

/**
 * Monkeypatch node-pty's native fork() to substitute stablePath at argument
 * index 9 (helperPath). Must be called before any pty.spawn() invocation.
 *
 * The native binding is a process-wide singleton cached by Node's module loader.
 * Wrapping fork() before any UnixTerminal is constructed redirects all subsequent
 * pty.spawn() calls to use our stable, +x helper instead of the pkg-managed cache
 * path that lacks the executable bit.
 */
export function installSpawnHelperFork(stablePath: string): void {
  if (process.platform === 'win32') return

  let native: any
  try {
    native = (require('node-pty') as any).native
  } catch {
    return
  }

  if (!native || typeof native.fork !== 'function') return
  if (native.__helperPatched) return

  const orig = native.fork.bind(native)
  native.fork = function (...args: any[]) {
    if (args.length > 9) args[9] = stablePath
    return orig(...args)
  }
  native.__helperPatched = true
  // Record it so health probes stat the binary node-pty will really exec, not the
  // prebuild path this patch just redirected away from.
  setEffectiveSpawnHelperPath(stablePath)
  console.error('[bridge] spawn-helper.fork-patched', { path: stablePath })
}

/** Resolve a stable spawn-helper and install the fork monkeypatch. No-op when null. */
export function setupSpawnHelper(): void {
  const p = resolveStableSpawnHelper()
  if (p) installSpawnHelperFork(p)
}
