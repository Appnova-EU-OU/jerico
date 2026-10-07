import fs from 'node:fs'
import path from 'node:path'
import { getCodegraphDir } from '../profile.js'

const BATCH_INTERVAL_MS = 45_000
const POLL_INTERVAL_MS = 30_000

interface AdoptionRow {
  eventId: string
  ts?: string
  tool?: string
  cwd?: string | null
  agentId?: string | null
  projectId?: string | null
  referencedFiles?: string[]
  referencedBytes?: number
  resultBytes?: number
}

export interface CodegraphAdoptionMessage {
  type: 'codegraph_adoption'
  daemonId: string
  rows: AdoptionRow[]
}

type EmitFn = (msg: CodegraphAdoptionMessage) => void

interface TailState {
  offset: number
  pending: Buffer
}

/** Persisted across forwarder recreations so reconnects don't replay the whole file. */
const tailStateByFile = new Map<string, TailState>()

function isAdoptionRow(v: unknown): v is AdoptionRow {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.eventId === 'string' && typeof r.ts === 'string' && typeof r.tool === 'string' && typeof r.referencedBytes === 'number'
}

/**
 * Offset-tail the codegraph adoption.jsonl and emit enriched rows to the server.
 * Mirrors claude-usage.ts: only NEW lines since the last offset are parsed,
 * malformed lines are skipped, and rotations/truncations are handled by re-reading
 * from 0 (the engine writes append-only, so a shrink means a new file).
 */
export function startCodegraphAdoptionForwarder(daemonId: string, emit: EmitFn): () => void {
  const dir = getCodegraphDir()
  const file = path.join(dir, 'adoption.jsonl')
  let running = true
  let flushTimer: NodeJS.Timeout | null = null
  let pollTimer: NodeJS.Timeout | null = null
  const tail: TailState = tailStateByFile.get(file) ?? { offset: 0, pending: Buffer.alloc(0) }
  tailStateByFile.set(file, tail)
  const batch: AdoptionRow[] = []

  function readNewLines(): void {
    try {
      if (!fs.existsSync(file)) return
      const stat = fs.statSync(file)
      if (stat.size < tail.offset) {
        // Truncated/rotated — re-read from start. Keep batch (it will flush on its own).
        tail.offset = 0
        tail.pending = Buffer.alloc(0)
      }
      if (stat.size === tail.offset && tail.pending.length === 0) return
      const fd = fs.openSync(file, 'r')
      try {
        const toRead = stat.size - tail.offset
        const buf = Buffer.alloc(toRead)
        const bytesRead = fs.readSync(fd, buf, 0, toRead, tail.offset)
        tail.offset += bytesRead
        const combined = tail.pending.length > 0 ? Buffer.concat([tail.pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
        const nl = combined.lastIndexOf(0x0a)
        if (nl === -1) {
          tail.pending = combined
          return
        }
        const complete = combined.subarray(0, nl + 1).toString('utf-8')
        tail.pending = combined.subarray(nl + 1)
        for (const line of complete.split('\n')) {
          if (!line.trim()) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch { continue }
          if (!isAdoptionRow(parsed)) continue
          // Only forward enriched query rows (status/index have no referencedBytes).
          if ((parsed.referencedBytes ?? 0) <= 0) continue
          batch.push(parsed)
        }
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      console.warn('[daemon] codegraph-adoption.tail_error', { daemonId: daemonId.slice(0, 8), error: String(err) })
    }
  }

  function flush(): void {
    if (batch.length === 0) return
    const rows = batch.splice(0, batch.length)
    emit({ type: 'codegraph_adoption', daemonId, rows })
  }

  const tick = (): void => {
    if (!running) return
    readNewLines()
  }

  flushTimer = setInterval(flush, BATCH_INTERVAL_MS)
  pollTimer = setInterval(tick, POLL_INTERVAL_MS)

  // Initial read after a short delay so the file has time to be created.
  setTimeout(tick, 2_000)

  return () => {
    running = false
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    readNewLines()
    flush()
  }
}
