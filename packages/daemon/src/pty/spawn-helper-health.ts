import fs from 'fs'
import path from 'path'
import * as pty from 'node-pty'
import type { PtyHealthInfo, HelperPreflightStatus, ProbeStatus, PtyProbeErrorCategory } from '@jerico/shared'

export interface PtyHealthDeps {
  resolveHelperPath?: () => string | undefined
  existsSync?: (path: string) => boolean
  accessSync?: (path: string, mode?: number) => void
  ptySpawn?: (file: string, args: string[], options: any) => { kill: () => void }
}

/**
 * Resolve the spawn-helper binary path for the currently loaded node-pty module
 * and active platform/architecture.
 */
export function resolveSpawnHelperPath(): string | undefined {
  try {
    const nodePtyEntry = require.resolve('node-pty')
    const nodePtyDir = path.resolve(path.dirname(nodePtyEntry), '..')
    const helperPath = path.join(
      nodePtyDir,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper'
    )
    return helperPath
  } catch {
    return undefined
  }
}

function categorizeProbeError(err: unknown): PtyProbeErrorCategory {
  if (!err) return 'none'
  const errno = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code ?? '').toUpperCase()
    : ''
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (errno === 'EACCES' || errno === 'EPERM') {
    return 'permission_denied'
  }
  if (errno === 'EMFILE' || errno === 'EAGAIN' || errno === 'ENFILE' || errno === 'EDQUOT') {
    return 'resource_limit'
  }
  if (msg.includes('failed') || msg.includes('spawn') || msg.includes('posix_spawnp')) {
    return 'spawn_failed'
  }
  return 'unknown'
}

/**
/**
 * The helper node-pty will actually exec. `installSpawnHelperFork` redirects the
 * native fork() at a stable path (the signed sibling inside the desktop bundle, or
 * a copy extracted from the pkg snapshot), so probing the prebuild path instead
 * would answer a question nobody asked.
 */
let effectiveHelperPath: string | undefined

export function setEffectiveSpawnHelperPath(helperPath: string): void {
  effectiveHelperPath = helperPath
}

export function getEffectiveSpawnHelperPath(): string | undefined {
  return effectiveHelperPath ?? resolveSpawnHelperPath()
}

/**
 * Is the spawn-helper itself missing or non-executable?
 *
 * This is a FILE check on purpose. The old test-spawn probe could not tell "the
 * helper lost its +x bit" from "this machine could not allocate a pty right now",
 * and reported both as a broken helper — so a daemon that had merely run out of
 * descriptors told its user to reinstall bridge-agent, which fixes nothing.
 * A stat cannot be confounded by resource pressure.
 *
 * Returns true when there is no helper to check (e.g. Windows): absence of the
 * file is not evidence of this failure mode.
 */
export function isSpawnHelperExecutable(): boolean {
  const helperPath = getEffectiveSpawnHelperPath()
  if (!helperPath || !fs.existsSync(helperPath)) return true
  try {
    fs.accessSync(helperPath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Can this machine start a pty at all right now?
 *
 * Distinct from `isSpawnHelperExecutable`: this one really spawns, so it answers
 * "is the whole path working" and a false here can mean either a broken helper or
 * an exhausted machine. Callers that need to name a cause must consult
 * `isSpawnHelperExecutable` as well.
 */
export function canSpawnPty(): boolean {
  const helperPath = getEffectiveSpawnHelperPath()
  if (!helperPath || !fs.existsSync(helperPath)) {
    return true // no helper shipped → nothing for this probe to prove
  }

  let proc: pty.IPty | undefined
  try {
    proc = pty.spawn('/bin/sh', [], { name: 'xterm-256color', cols: 80, rows: 24 })
    return true
  } catch {
    return false
  } finally {
    // The probe must not itself consume the budget it is measuring. It runs on
    // every reconnect, and node-pty only closes the master from its own exit path,
    // so `kill()` alone left one descriptor behind per probe.
    if (proc) {
      try { proc.kill() } catch { /* already gone */ }
      try { (proc as pty.IPty & { destroy?: () => void }).destroy?.() } catch { /* best effort */ }
    }
  }
}

/**
 * Perform structured PTY and spawn-helper health assessment.
 * Distinguishes helper preflight (not_applicable, missing, not_executable, executable)
 * from probe result (ok, spawn_failed, skipped).
 * Sanitizes errors into bounded probeErrorCategory enum without exposing system paths.
 */
export function checkPtyHealth(deps?: PtyHealthDeps): PtyHealthInfo {
  const getHelperPath = deps?.resolveHelperPath ?? getEffectiveSpawnHelperPath
  const checkExists = deps?.existsSync ?? fs.existsSync
  const checkAccess = deps?.accessSync ?? fs.accessSync
  const spawnPty = deps?.ptySpawn ?? ((f, a, o) => pty.spawn(f, a, o))

  const helperPath = getHelperPath()
  let preflight: HelperPreflightStatus = 'not_applicable'

  if (helperPath) {
    if (!checkExists(helperPath)) {
      preflight = 'missing'
    } else {
      try {
        checkAccess(helperPath, fs.constants.X_OK)
        preflight = 'executable'
      } catch {
        preflight = 'not_executable'
      }
    }
  }

  // Backward-compat flag: true ONLY if preflight found helper to be missing or not executable
  const spawnHelperBroken = preflight === 'missing' || preflight === 'not_executable'

  let probe: ProbeStatus = 'skipped'
  let probeErrorCategory: PtyProbeErrorCategory | undefined

  if (preflight === 'executable' || preflight === 'not_applicable') {
    let proc: any
    try {
      proc = spawnPty('/bin/sh', [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
      })
      probe = 'ok'
      probeErrorCategory = 'none'
    } catch (err: unknown) {
      probe = 'spawn_failed'
      probeErrorCategory = categorizeProbeError(err)
    } finally {
      if (proc) {
        try { proc.kill() } catch { /* already gone */ }
        try { proc.destroy?.() } catch { /* best effort */ }
      }
    }
  }

  return {
    preflight,
    probe,
    probeErrorCategory,
    spawnHelperBroken,
  }
}

/**
 * Check whether the node-pty spawn-helper is functional.
 * Backward-compatible wrapper returning boolean.
 */
export function isSpawnHelperHealthy(deps?: PtyHealthDeps): boolean {
  const health = checkPtyHealth(deps)
  return !health.spawnHelperBroken && health.probe === 'ok'
}

export type SpawnFailureKind = 'helper_broken' | 'exhausted' | 'other'

/**
 * node-pty prints the same opaque `posix_spawnp failed` whatever errno it got, so
 * the text alone never says whether the helper is broken or the machine simply
 * could not allocate a pty. Stat the helper to decide.
 *
 * This replaces a heuristic that only accepted "helper broken" once two DIFFERENT
 * agent keys had failed inside 30s. Someone retrying one orchestrator always sends
 * the same key, so they never crossed the threshold and never saw a reason at all —
 * while a machine that had merely run out of descriptors was told to reinstall
 * bridge-agent, which fixes nothing.
 *
 * `helperExecutable` is injectable so the decision can be tested without a
 * filesystem, and so callers can reuse one probe across a burst of failures.
 */
export function classifySpawnFailure(
  lastError: string | undefined | null,
  helperExecutable: () => boolean = isSpawnHelperExecutable,
): SpawnFailureKind {
  if (!lastError?.includes('posix_spawnp failed')) return 'other'
  return helperExecutable() ? 'exhausted' : 'helper_broken'
}

/** What to tell the user when the machine could not allocate a pty. */
export const EXHAUSTED_SPAWN_MESSAGE =
  'This machine could not allocate a terminal (posix_spawnp failed) — its agent runtime is out of file descriptors or processes. Restarting the agent runtime on that machine releases them.'
