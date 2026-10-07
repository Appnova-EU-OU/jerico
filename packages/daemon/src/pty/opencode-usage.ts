import path from 'path'
import os from 'os'
import fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import { safeStat } from './usage-cache.js'

const WORKER_TIMEOUT_MS = 12_000 // 12s timeout for worker queries

export interface OpenCodeUsageInfo {
  tokensSpent5h: number
  tokensTotal:   number
}

/**
 * Spawn a worker thread to scan the OpenCode SQLite DB.
 * better-sqlite3 is synchronous native code — it MUST NOT run on the main thread.
 * The worker is spawned once and reused via postMessage.
 *
 * PKG COMPAT: Inside a @yao-pkg/pkg binary, __dirname resolves to a virtual
 * /snapshot/... path. Node worker_threads cannot load from the snapshot
 * virtual filesystem (known limitation: yao-pkg/pkg#1931). When process.pkg
 * is truthy, extract the bundled opencode-worker.js to a real temp file and
 * spawn the worker from there. The extracted path is cached so extraction
 * happens at most once per daemon lifetime.
 */

// In dev, the worker sits alongside this file in dist/. In pkg, __dirname
// is the snapshot root where opencode-worker.js is embedded via pkg.scripts.
const SNAPSHOT_WORKER_PATH = path.join(__dirname, 'opencode-worker.js')

// Cached extracted worker path for pkg builds (lazy, at-most-once).
let _extractedWorkerPath: string | null = null

function getWorkerPath(): string {
  // Dev / npm install / launchd: __dirname points to real dist/
  if ((process as any).pkg === undefined) return SNAPSHOT_WORKER_PATH

  // Pkg binary: extract bundled worker to a real temp file
  if (_extractedWorkerPath) return _extractedWorkerPath

  try {
    console.log('[opencode-usage] pkg detected — extracting worker to temp file')
    const content = fs.readFileSync(SNAPSHOT_WORKER_PATH, 'utf-8')
    // PID in filename prevents collision between concurrent daemon instances
    const tmpPath = path.join(os.tmpdir(), `jerico-opencode-worker-${process.pid}.js`)
    fs.writeFileSync(tmpPath, content, 'utf-8')
    _extractedWorkerPath = tmpPath
    console.log('[opencode-usage] worker extracted to', tmpPath)
    return tmpPath
  } catch (err) {
    console.warn('[opencode-usage] worker extraction failed — opencode usage unavailable', err)
    // Return the snapshot path as fallback; the Worker constructor will need
    // its own try/catch (see getWorker) and the failure will be handled there.
    return SNAPSHOT_WORKER_PATH
  }
}

interface PendingRequest {
  resolve: (info: OpenCodeUsageInfo) => void
  timeout: ReturnType<typeof setTimeout>
}

let _worker: Worker | null = null
let _pending: PendingRequest | null = null

function getWorker(): Worker | null {
  if (!_worker) {
    const workerPath = getWorkerPath()
    try {
      _worker = new Worker(workerPath)
    } catch (err) {
      // Worker constructor failed — likely better-sqlite3 native addon
      // missing or platform mismatch. OpenCode usage is silently degraded.
      console.warn('[opencode-usage] worker() constructor failed — opencode usage unavailable', err)
      if (_pending) {
        clearTimeout(_pending.timeout)
        _pending.resolve({ tokensSpent5h: 0, tokensTotal: 0 })
        _pending = null
      }
      _worker = null
      return null
    }
    _worker.on('message', (msg: { type: string; tokensSpent5h?: number; tokensTotal?: number; message?: string }) => {
      if (_pending) {
        clearTimeout(_pending.timeout)
        if (msg.type === 'result') {
          _pending.resolve({ tokensSpent5h: msg.tokensSpent5h ?? 0, tokensTotal: msg.tokensTotal ?? 0 })
        } else {
          console.warn('[opencode-usage] worker error', msg.message)
          _pending.resolve({ tokensSpent5h: 0, tokensTotal: 0 })
        }
        _pending = null
      }
    })
    _worker.on('error', () => {
      if (_pending) {
        clearTimeout(_pending.timeout)
        _pending.resolve({ tokensSpent5h: 0, tokensTotal: 0 })
        _pending = null
      }
      _worker = null
    })
    _worker.on('exit', (code) => {
      // Worker exited without being terminated — resolve any pending with zeros
      if (code !== 0 && _pending) {
        clearTimeout(_pending.timeout)
        _pending.resolve({ tokensSpent5h: 0, tokensTotal: 0 })
        _pending = null
      }
      _worker = null
    })
  }
  return _worker
}

const CUTOFF_MS = 5 * 60 * 60 * 1000

/**
 * Re-query the OpenCode SQLite DB on every tick.
 * The query runs in a worker thread (off-thread, non-blocking) and
 * the DB is in WAL mode so (mtime, size) caching is unreliable.
 * The rolling 5h window advances every tick, so cached totals would
 * be stale. Always query fresh with a current cutoff.
 */
function queryOpenCodeUsageAsync(): Promise<OpenCodeUsageInfo> {
  return new Promise(async (resolve) => {
    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
    const stat = await safeStat(dbPath)
    if (!stat) {
      resolve({ tokensSpent5h: 0, tokensTotal: 0 })
      return
    }

    // If a previous request is still pending, cancel it (stale timeout + resolve)
    if (_pending) {
      clearTimeout(_pending.timeout)
      _pending.resolve({ tokensSpent5h: 0, tokensTotal: 0 })
      _pending = null
    }

    const timeout = setTimeout(() => {
      console.warn('[opencode-usage] worker query timed out — terminating worker')
      if (_worker) {
        try { _worker.terminate() } catch { /* ignore */ }
        _worker = null
      }
      if (_pending) {
        _pending = null
        resolve({ tokensSpent5h: 0, tokensTotal: 0 })
      }
    }, WORKER_TIMEOUT_MS)

    _pending = { resolve, timeout }

    const cutoffMs = Date.now() - CUTOFF_MS
    try {
      const worker = getWorker()
      if (!worker) {
        // getWorker() returns null when Worker constructor fails.
        // Resolve gracefully — opencode usage is silently unavailable.
        clearTimeout(timeout)
        _pending = null
        resolve({ tokensSpent5h: 0, tokensTotal: 0 })
        return
      }
      worker.postMessage({ type: 'scan', dbPath, cutoffMs })
    } catch (err) {
      console.warn('[opencode-usage] worker.postMessage failed', err)
      clearTimeout(timeout)
      _pending = null
      resolve({ tokensSpent5h: 0, tokensTotal: 0 })
    }
  })
}

/**
 * Start a global watcher that polls the OpenCode SQLite database every 60s
 * for token usage within the rolling 5-hour window.
 * Uses a worker thread so better-sqlite3 never blocks the main event loop.
 * Returns a cleanup function.
 */
export function startOpenCodeUsageWatcher(
  onUsage: (info: OpenCodeUsageInfo) => void,
): () => void {
  let running = true

  const tick = async (): Promise<void> => {
    if (!running) return
    try {
      const info = await queryOpenCodeUsageAsync()
      if (running) onUsage(info)
    } catch (err) {
      console.warn('[opencode-usage] poll failed', err)
    }
  }

  // Defer first scan: run after 2s grace period (daemon is healthy by then)
  const initialTimer = setTimeout(() => { void tick() }, 2000)
  const interval = setInterval(() => { void tick() }, 60_000)

  return () => {
    running = false
    clearTimeout(initialTimer)
    clearInterval(interval)
    if (_worker) {
      try { _worker.terminate() } catch { /* ignore */ }
      _worker = null
    }
  }
}
