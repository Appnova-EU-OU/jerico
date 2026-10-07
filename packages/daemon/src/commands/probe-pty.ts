/**
 * probe-pty — Smoke-test command for CI and user debugging.
 *
 * Verifies that node-pty loads correctly (native addon dlopen succeeds,
 * spawn-helper is executable). Used in CI release pipeline as a gate
 * after pkg binary build, and by users troubleshooting installation.
 *
 * Exit code: 0 = PTY functional, 1 = failure.
 * Output: JSON to stdout (status + diagnostics), log lines to stderr.
 */

import { setupSpawnHelper } from '../pty/spawn-helper-patch.js'

type ProbeResult = {
  ok: boolean
  ptyLoaded: boolean
  ptySpawned: boolean
  ptyOutputReceived: boolean
  error?: string
  ptyLoadError?: string
  ptySpawnError?: string
  timeout?: boolean
  arch?: string
  platform?: string
  isPkg?: boolean
}

export async function runProbePty(): Promise<void> {
  const startedAt = Date.now()
  const result: ProbeResult = {
    ok: false,
    ptyLoaded: false,
    ptySpawned: false,
    ptyOutputReceived: false,
    arch: process.arch,
    platform: process.platform,
    isPkg: (process as any).pkg !== undefined,
  }

  // ── Step 1: Load node-pty ──────────────────────────────────────────────────
  // Use bare require (available in esbuild CJS bundle; pkg-compatible).
  // createRequire(import.meta.url) fails in pkg because import.meta.url
  // is undefined in pkg's VFS snapshot.
  let ptyModule: any = null
  try {
    ptyModule = require('node-pty')
    result.ptyLoaded = true
    console.error('[probe-pty] node-pty loaded OK')

    // Extract + monkeypatch spawn-helper for pkg binary compatibility.
    // In pkg, spawn-helper is inside the VFS snapshot and can't be exec'd
    // directly — setupSpawnHelper extracts it to ~/.bridge/bin/ and +x chmods.
    setupSpawnHelper()
  } catch (err) {
    result.ptyLoadError = String(err)
    console.error(`[probe-pty] node-pty load FAILED: ${err}`)
  }

  // ── Step 2: Spawn a test PTY ──────────────────────────────────────────────
  if (ptyModule) {
    try {
      const TIMEOUT_MS = 8000
      let output = ''
      let exited = false

      await new Promise<void>((resolve, reject) => {
        const proc = ptyModule!.spawn('/bin/sh', [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
        })

        const timeout = setTimeout(() => {
          result.timeout = true
          try { proc.kill() } catch {}
          reject(new Error(`PTY spawn timed out after ${TIMEOUT_MS}ms`))
        }, TIMEOUT_MS)

        proc.onData((data: string) => {
          output += data
          if (output.includes('PROBE_OK')) {
            result.ptyOutputReceived = true
            clearTimeout(timeout)
            try { proc.kill() } catch {}
          }
        })

        proc.onExit(({ exitCode }: { exitCode: number }) => {
          exited = true
          clearTimeout(timeout)
          if (result.ptyOutputReceived) {
            resolve()
          } else {
            reject(new Error(`PTY exited with code ${exitCode} before receiving PROBE_OK`))
          }
        })

        // Write test command — use echo + marker to verify
        proc.write('echo PROBE_OK\n')
      })

      result.ptySpawned = true
      console.error('[probe-pty] PTY spawn + echo OK')
    } catch (err) {
      result.ptySpawnError = String(err)
      console.error(`[probe-pty] PTY spawn/echo FAILED: ${err}`)
    }
  }

  // ── Result ────────────────────────────────────────────────────────────────
  const elapsed = Date.now() - startedAt
  result.ok = result.ptyLoaded && result.ptySpawned && result.ptyOutputReceived

  const logLine = `[probe-pty] ${result.ok ? 'PASS' : 'FAIL'} (${elapsed}ms) loaded=${result.ptyLoaded} spawned=${result.ptySpawned} output=${result.ptyOutputReceived} arch=${result.arch} platform=${result.platform} pkg=${result.isPkg}`
  if (result.ok) {
    console.error(logLine)
  } else {
    console.error(logLine)
  }

  // Print JSON result to stdout for machine parsing
  process.stdout.write(JSON.stringify(result) + '\n')

  process.exit(result.ok ? 0 : 1)
}
