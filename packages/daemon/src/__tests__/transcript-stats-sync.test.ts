import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Drift guard for the engine-free transcript parser replica.
 *
 * packages/daemon/src/pty/transcript-stats.ts MUST stay byte-identical to
 * packages/codegraph/src/transcript-stats.ts except for its leading
 * BEGIN/END DAEMON REPLICA SYNC NOTICE block. The parsing rules in that file
 * are load-bearing (dedupe by message.id, per-line census, MAX-output
 * watermark) and are shared by the scripted ab-run and the cohort pipeline —
 * a silent fork corrupts the A/B metric. Edit the codegraph original, then
 * re-copy it into the daemon.
 */
test('daemon transcript-stats replica is in lockstep with the codegraph original', () => {
  const originalPath = fileURLToPath(new URL('../../../codegraph/src/transcript-stats.ts', import.meta.url))
  const replicaPath  = fileURLToPath(new URL('../pty/transcript-stats.ts', import.meta.url))
  const original = readFileSync(originalPath, 'utf-8')
  const replica  = readFileSync(replicaPath, 'utf-8')

  const stripped = replica.replace(
    /^\/\/ ── BEGIN DAEMON REPLICA SYNC NOTICE ─+[\s\S]*?\/\/ ── END DAEMON REPLICA SYNC NOTICE ─+\n/,
    '',
  )
  expect(stripped.trim()).toBe(original.trim())
})
