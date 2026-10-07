/**
 * Single source of truth for the daemon version string.
 *
 * The value is baked into the binary at build time by esbuild define,
 * replacing process.env.AGENT_VERSION with a string literal such as "0.13.6".
 *
 * In dev (running from TypeScript source), AGENT_VERSION may be undefined,
 * in which case falls back to "0.0.0-dev".
 *
 * This module exists so every consumer — index.ts, /health, WS identity, update —
 * reads the same canonical value.
 */

import path from 'path'

let currentVersion = process.env.AGENT_VERSION ?? '0.0.0-dev'
let currentBinaryPath: string | undefined

/** Returns the baked-in daemon version. Never throws. */
export function getDaemonVersion(): string {
  return currentVersion
}

/** Returns the daemon entry path used for lock identity. */
export function getDaemonEntry(): string {
  // When running inside a pkg-compiled binary, process.argv[1] is a virtual
  // /snapshot/... path that only exists inside the pkg VFS. launchd cannot use it.
  // process.execPath IS the pkg binary itself — use it directly.
  if (currentBinaryPath) return currentBinaryPath
  if ((process as any).pkg !== undefined) return process.execPath

  // Prefer the global npm install — use npm root to find the canonical path.
  // Falls back to argv[1] realpath (works when run directly by Node).
  // Last resort: process.execPath (Node.js binary itself).
  const candidates: string[] = [
    ...(process.env.npm_config_global_prefix
      ? [path.join(process.env.npm_config_global_prefix, 'lib', 'node_modules', 'bridge-agent', 'dist', 'index.js')]
      : []),
    ...(process.argv[1] ? [process.argv[1]] : []),
    process.execPath,
  ]
  for (const p of candidates) {
    try { return require('node:fs').realpathSync(p) } catch { /* try next */ }
  }
  return process.execPath
}

/** Test-only hook to override the identity used by lock reclaim logic. */
export function __setDaemonIdentity(version: string, binaryPath: string): void {
  currentVersion = version
  currentBinaryPath = binaryPath
}

/** Test-only hook to reset identity overrides. */
export function __resetDaemonIdentity(): void {
  currentVersion = process.env.AGENT_VERSION ?? '0.0.0-dev'
  currentBinaryPath = undefined
}
