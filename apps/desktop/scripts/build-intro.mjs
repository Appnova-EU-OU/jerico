#!/usr/bin/env node
/**
 * Publishes the approved first-run scenes into the renderer source tree.
 *
 * 07, 08 and 09 remain the only reviewed copies. The Electron runner adds the
 * production lifecycle around them (autoplay, intro lock, whole-tour Skip and
 * completion IPC), but it never hand-ports their drawing code. Committed copies
 * let Vite treat every scene as an HTML entry; --check makes drift a build error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const design = join(root, 'design')
const output = join(root, 'src', 'renderer', 'first-run')
const check = process.argv.includes('--check')

const files = [
  '_fonts.css',
  '07-first-run-tour.html',
  '08-first-run-orchestrator.html',
  '09-first-run-close.html',
]

const stale = []
for (const file of files) {
  const sourcePath = join(design, file)
  const outputPath = join(output, file)
  const source = readFileSync(sourcePath, 'utf8')
  const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null
  if (current === source) continue
  stale.push(file)
  if (!check) {
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, source)
  }
}

if (check && stale.length > 0) {
  throw new Error(
    `first-run renderer assets are stale: ${stale.join(', ')}; run pnpm build:intro`,
  )
}

if (!check) {
  console.log(`published ${files.length} first-run assets from apps/desktop/design`)
}
