/**
 * Worker thread for OpenCode SQLite scanning.
 *
 * better-sqlite3 is synchronous native code that blocks the event loop.
 * This worker isolates the full-table-scan queries off the daemon's main thread,
 * keeping /health and WS heartbeats responsive.
 *
 * Input:  { type: 'scan', dbPath: string }
 * Output: { type: 'result', tokensSpent5h: number, tokensTotal: number }
 *         { type: 'error', message: string }
 */

import { parentPort } from 'node:worker_threads'

interface ScanMessage {
  type: 'scan'
  dbPath: string
  cutoffMs: number
}

interface ResultMessage {
  type: 'result'
  tokensSpent5h: number
  tokensTotal: number
}

interface ErrorMessage {
  type: 'error'
  message: string
}

function loadSqlite(): any {
  try {
    return (require as NodeRequire)('better-sqlite3')
  } catch {
    return null
  }
}

const betterSqlite3 = loadSqlite()

parentPort?.on('message', (msg: ScanMessage) => {
  if (msg.type !== 'scan') return

  if (!betterSqlite3) {
    const out: ErrorMessage = { type: 'error', message: 'better-sqlite3 not available' }
    parentPort!.postMessage(out)
    return
  }

  let db: any
  try {
    db = new betterSqlite3(msg.dbPath, { readonly: true })

    const row5h = db.prepare(
      `SELECT sum(tokens_input + tokens_output + tokens_reasoning) AS spent
       FROM session WHERE time_updated >= ?`
    ).get(msg.cutoffMs) as { spent: number | null } | undefined

    const rowTotal = db.prepare(
      `SELECT sum(tokens_input + tokens_output + tokens_reasoning) AS total FROM session`
    ).get() as { total: number | null } | undefined

    const result: ResultMessage = {
      type: 'result',
      tokensSpent5h: row5h?.spent ?? 0,
      tokensTotal: rowTotal?.total ?? 0,
    }
    parentPort!.postMessage(result)
  } catch (err) {
    const out: ErrorMessage = { type: 'error', message: String(err) }
    parentPort!.postMessage(out)
  } finally {
    if (db) {
      try { db.close() } catch { /* ignore */ }
    }
  }
})
