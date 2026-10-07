/**
 * Phase 11: bridge-agent logs — unified lifecycle log viewer.
 *
 * Usage:
 *   bridge-agent logs [--follow] [--lines N] [--component daemon|desktop|cli]
 *
 * Reads the structured JSON-lines lifecycle log and pretty-prints
 * events to stdout. Supports --follow (tail -f via fs.watch) mode and
 * --component filtering.
*
* Both the daemon and the desktop app write structured JSON-lines to
* ~/bridge-daemon<suffix>.lifecycle.log with a component discriminator,
* enabling unified `bridge-agent logs` view.
 */
import { existsSync, readFileSync, watch, statSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { getLogPaths } from '../profile.js'

export interface LogsOptions {
  follow: boolean
  lines: number
  component?: 'daemon' | 'desktop' | 'cli'
}

export function runLogs(opts: LogsOptions): void {
  const logPath = getLogPaths().lifecycle

  if (!existsSync(logPath)) {
    console.log('[bridge-agent] No lifecycle log found at', logPath)
    process.exit(0)
  }

  const history = readTail(logPath, opts.lines)
  for (const line of history) {
    console.log(formatLine(line, opts.component))
  }

  if (!opts.follow) {
    process.exit(0)
    return
  }

  // Follow mode: watch for appends using fs.watch
  let lastSize: number
  try {
    lastSize = statSync(logPath).size
  } catch {
    lastSize = 0
  }

  let watcher: FSWatcher | null = null
  try {
    watcher = watch(logPath, { persistent: false }, (eventType) => {
      if (eventType !== 'change') return
      try {
        const stat = statSync(logPath)
        if (stat.size <= lastSize) return
        const chunk = readFileSync(logPath, 'utf8').slice(lastSize)
        lastSize = stat.size
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (trimmed) console.log(formatLine(trimmed, opts.component))
        }
      } catch { /* file may disappear mid-watch */ }
    })
  } catch {
    console.warn('[bridge-agent] Cannot watch log file — showing history only')
    process.exit(0)
  }

  // Keep process alive for follow mode
  process.on('SIGINT', () => {
    watcher?.close()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    watcher?.close()
    process.exit(0)
  })
}

/** Read the last `n` lines from a file. */
function readTail(filePath: string, n: number): string[] {
  try {
    const content = readFileSync(filePath, 'utf8')
    const lines = content.split('\n').filter((l) => l.trim())
    return lines.slice(-n)
  } catch {
    return []
  }
}

/** Pretty-print one JSON-lines log entry. */
function formatLine(line: string, component?: string): string {
  // Try JSON parse; if it fails, pass the raw line through
  try {
    const e = JSON.parse(line)
    // Component filter
    if (component && e.component !== component) return ''
    const ts = new Date(e.ts).toISOString()
    const comp = (e.component || '??').padEnd(8)
    const req = e.requestId ? ` [${e.requestId.slice(0, 8)}]` : ''
    const evt = e.event || '??'
    // Collect interesting detail fields
    const details: string[] = []
    for (const [k, v] of Object.entries(e)) {
      if (['ts', 'event', 'component', 'pid', 'requestId'].includes(k)) continue
      if (v === undefined || v === null) continue
      if (typeof v === 'object') {
        details.push(`${k}=${JSON.stringify(v)}`)
      } else {
        details.push(`${k}=${v}`)
      }
    }
    const detail = details.length > 0 ? ` | ${details.join(' ')}` : ''
    return `${ts} ${comp}${req} ${evt}${detail}`
  } catch {
    return component ? '' : line
  }
}
