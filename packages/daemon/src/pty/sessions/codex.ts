import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ClaudeSessionEntry } from '@jerico/shared'
import { readSessionRoles } from './role-index.js'
import { sessionRoleKey } from './role-index.js'
import { canonicalSessionCwd, sameSessionCwd, UUID_RE } from './session-utils.js'

const MAX_ENTRIES = 30
const MAX_DAY_DIRS = 60
const DEADLINE_MS = 3000
const FIRST_LINE_MAX_BYTES = 1024 * 1024
type SessionListResult = { entries: ClaudeSessionEntry[]; truncated: boolean; truncatedReason?: 'cap' | 'deadline' }
interface CodexCaptureLease { overlappingSpawn: boolean }
const captureLeases = new Map<string, CodexCaptureLease>()
function acquireCodexCapture(cwd: string): { lease: CodexCaptureLease; release: () => void } | null {
  cwd = canonicalSessionCwd(cwd)
  const existing = captureLeases.get(cwd)
  if (existing) { existing.overlappingSpawn = true; return null }
  const lease: CodexCaptureLease = { overlappingSpawn: false }
  captureLeases.set(cwd, lease)
  let released = false
  const release = () => {
    if (!released) {
      released = true
      if (captureLeases.get(cwd) === lease) captureLeases.delete(cwd)
    }
  }
  return { lease, release }
}
export function tryAcquireCodexCapture(cwd: string): (() => void) | null {
  return acquireCodexCapture(cwd)?.release ?? null
}
export function reserveCodexCaptureForSpawn(cwd: string): { shouldSpawn: true; shouldCapture: boolean; release: (() => void) | null; isAmbiguous: () => boolean } {
  const acquired = acquireCodexCapture(cwd)
  return acquired
    ? { shouldSpawn: true, shouldCapture: true, release: acquired.release, isAmbiguous: () => acquired.lease.overlappingSpawn }
    : { shouldSpawn: true, shouldCapture: false, release: null, isAmbiguous: () => true }
}
export const codexHome = () => process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex')
const sessionsRoot = () => path.join(codexHome(), 'sessions')

async function readFirstLine(file: string, onOversize?: () => void): Promise<string | null> {
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(file, 'r')
    const buffer = Buffer.alloc(FIRST_LINE_MAX_BYTES)
    let offset = 0
    while (offset < FIRST_LINE_MAX_BYTES) {
      const length = Math.min(64 * 1024, FIRST_LINE_MAX_BYTES - offset)
      const { bytesRead } = await handle.read(buffer, offset, length, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      const end = buffer.subarray(0, offset).indexOf(0x0a)
      if (end >= 0) return buffer.toString('utf8', 0, end)
      if (bytesRead < length) break
    }
    const stat = await handle.stat()
    if (offset >= FIRST_LINE_MAX_BYTES && stat.size > FIRST_LINE_MAX_BYTES) { onOversize?.(); return null }
    return buffer.toString('utf8', 0, offset)
  } catch { return null } finally { await handle?.close().catch(() => {}) }
}

interface SQLiteStatement { all(...params: Array<string | number>): unknown }
interface SQLiteDatabase { exec(sql: string): void; prepare(sql: string): SQLiteStatement; close(): void }
interface SQLiteModule { DatabaseSync: new (filename: string, options: { readOnly: true }) => SQLiteDatabase }
type SQLiteLoader = () => Promise<unknown>
const loadNodeSQLite: SQLiteLoader = async () => {
  const sqliteSpecifier: string = 'node:sqlite'
  try { return await import(sqliteSpecifier) }
  catch {
    // pkg's CommonJS snapshot runtime cannot service dynamic-import callbacks;
    // its embedded Node still exposes node:sqlite through require().
    try { return require('node:sqlite') as unknown }
    catch { throw new Error('node:sqlite unavailable') }
  }
}

export interface CodexStateQuery<T = Record<string, unknown>> { available: boolean; rows: T[] }
export async function queryCodexState<T = Record<string, unknown>>(sql: string, params: Array<string | number>, loadSQLite: SQLiteLoader = loadNodeSQLite): Promise<CodexStateQuery<T>> {
  let database: SQLiteDatabase | undefined
  try {
    const files = await fs.promises.readdir(codexHome())
    const stateFile = files.filter(file => /^state_\d+\.sqlite$/.test(file))
      .sort((a, b) => Number(b.match(/state_(\d+)/)?.[1]) - Number(a.match(/state_(\d+)/)?.[1]))[0]
    if (!stateFile) throw new Error('codex_state_db_missing')
    const sqlite = await loadSQLite() as SQLiteModule
    database = new sqlite.DatabaseSync(path.join(codexHome(), stateFile), { readOnly: true })
    database.exec('PRAGMA busy_timeout = 150')
    const rows = database.prepare(sql).all(...params)
    if (!Array.isArray(rows)) throw new Error('codex_state_query_invalid')
    return { available: true, rows: rows.filter(row => !!row && typeof row === 'object') as T[] }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
    const message = error instanceof Error ? error.message : ''
    const reason = code === 'ENOENT' || message === 'codex_state_db_missing' ? 'database_missing'
      : /locked/i.test(message) ? 'database_locked'
        : /not a database/i.test(message) ? 'database_corrupt'
          : code === 'ERR_UNKNOWN_BUILTIN_MODULE' || /node:sqlite/i.test(message) ? 'sqlite_unavailable' : 'database_read_failed'
    console.warn('[daemon] sessions.codex.state_read_failed', { reason })
    return { available: false, rows: [] }
  } finally {
    try { database?.close() } catch { /* ignore close errors */ }
  }
}

export async function readCodexThreadNames(ids: string[], loadSQLite: SQLiteLoader = loadNodeSQLite): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>()
  if (ids.length === 0) return names
  let database: SQLiteDatabase | undefined
  try {
    const files = await fs.promises.readdir(codexHome())
    const stateFile = files.filter(file => /^state_\d+\.sqlite$/.test(file))
      .sort((a, b) => Number(b.match(/state_(\d+)/)?.[1]) - Number(a.match(/state_(\d+)/)?.[1]))[0]
    if (!stateFile) throw new Error('codex_state_db_missing')
    const loaded: unknown = await loadSQLite()
    const sqlite = loaded as SQLiteModule
    database = new sqlite.DatabaseSync(path.join(codexHome(), stateFile), { readOnly: true })
    database.exec('PRAGMA busy_timeout = 150')
    const placeholders = ids.map(() => '?').join(',')
    const rows: unknown = database.prepare(`SELECT id, name FROM threads WHERE id IN (${placeholders})`).all(...ids)
    if (!Array.isArray(rows)) throw new Error('codex_state_query_invalid')
    for (const item of rows) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (typeof row.id === 'string' && (row.name === null || typeof row.name === 'string')) names.set(row.id, row.name)
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
    const message = error instanceof Error ? error.message : ''
    const reason = code === 'ENOENT' || message === 'codex_state_db_missing' ? 'database_missing'
      : /locked/i.test(message) ? 'database_locked'
        : /not a database/i.test(message) ? 'database_corrupt'
          : code === 'ERR_UNKNOWN_BUILTIN_MODULE' || /node:sqlite/i.test(message) ? 'sqlite_unavailable' : 'database_read_failed'
    console.warn('[daemon] sessions.codex.state_read_failed', { reason })
    return new Map()
  } finally {
    try { database?.close() } catch { /* ignore close errors */ }
  }
  return names
}

export async function snapshotCodexRollouts(): Promise<Set<string>> {
  const paths = new Set<string>()
  const deadline = Date.now() + DEADLINE_MS
  try {
    const years = (await fs.promises.readdir(sessionsRoot())).sort().reverse()
    let dirs = 0
    outer: for (const year of years) for (const month of (await fs.promises.readdir(path.join(sessionsRoot(), year)).catch(() => [])).sort().reverse())
      for (const day of (await fs.promises.readdir(path.join(sessionsRoot(), year, month)).catch(() => [])).sort().reverse()) {
        if (Date.now() > deadline || dirs++ >= MAX_DAY_DIRS) break outer
        const dir = path.join(sessionsRoot(), year, month, day)
        for (const name of await fs.promises.readdir(dir).catch(() => [])) if (/^rollout-.*\.jsonl$/.test(name)) paths.add(path.join(dir, name))
      }
  } catch { /* missing CODEX_HOME means no snapshot candidates */ }
  return paths
}

async function waitForPoll(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return false
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(true), delayMs)
    const finish = (continuePolling: boolean) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(continuePolling)
    }
    const onAbort = () => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface CodexNameConfirmation { available: boolean; confirmed: boolean; sessionId?: string; reason?: string }
export async function runCodexRenameReadySequence(options: {
  writeRename: () => boolean | Promise<boolean>
  confirm: () => Promise<CodexNameConfirmation>
  onConfirmed?: (confirmation: CodexNameConfirmation) => Promise<void> | void
  flushFirstInput: () => void
  onUnconfirmed: (reason: string) => void
  clearComposer: () => void
  signal?: AbortSignal
  isCurrent?: () => boolean
  timeoutMs?: number
  pollMs?: number
  settleMs?: number
  delay?: (ms: number) => Promise<void>
}): Promise<CodexNameConfirmation> {
  const active = () => !options.signal?.aborted && (options.isCurrent?.() ?? true)
  if (!active()) return { available: true, confirmed: false, reason: 'panel_exited' }
  const renameWritten = await options.writeRename()
  if (!active()) return { available: true, confirmed: false, reason: 'panel_exited' }
  const timeoutMs = options.timeoutMs ?? 5000, pollMs = options.pollMs ?? 250, settleMs = options.settleMs ?? 500
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const deadline = Date.now() + timeoutMs
  let result: CodexNameConfirmation = renameWritten
    ? { available: true, confirmed: false }
    : { available: true, confirmed: false, reason: 'rename_write_failed' }
  while (renameWritten && active() && Date.now() < deadline) {
    result = await options.confirm()
    if (!active()) return { available: true, confirmed: false, reason: 'panel_exited' }
    if (result.confirmed || !result.available) break
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
  if (result.confirmed && active()) await options.onConfirmed?.(result)
  if (!result.confirmed) {
    if (!active()) return { available: true, confirmed: false, reason: 'panel_exited' }
    result.reason ??= result.available ? 'confirmation_timeout' : 'database_unavailable'
    options.clearComposer()
    options.onUnconfirmed(result.reason!)
  }
  await delay(settleMs)
  if (!active()) return { available: true, confirmed: false, reason: 'panel_exited' }
  options.flushFirstInput()
  return result
}

export async function findCodexOrchestratorThread(cwd: string, name: string, spawnTime: number, loadSQLite: SQLiteLoader = loadNodeSQLite): Promise<CodexNameConfirmation> {
  const result = await queryCodexState<{ id?: unknown; cwd?: unknown }>(
    'SELECT id, cwd FROM threads WHERE name = ? AND created_at_ms >= ?',
    [name, spawnTime - 2000], loadSQLite,
  )
  if (!result.available) return { available: false, confirmed: false, reason: 'database_unavailable' }
  const ids = result.rows.filter(row => typeof row.cwd === 'string' && sameSessionCwd(row.cwd, cwd)).map(row => row.id).filter((id): id is string => typeof id === 'string' && UUID_RE.test(id))
  return ids.length === 1
    ? { available: true, confirmed: true, sessionId: ids[0]! }
    : { available: true, confirmed: false, reason: ids.length > 1 ? 'ambiguous_name_match' : 'name_not_found' }
}

export async function codexThreadExists(cwd: string, sessionId: string, loadSQLite: SQLiteLoader = loadNodeSQLite): Promise<boolean | null> {
  const result = await queryCodexState<{ id?: unknown; cwd?: unknown }>(
    'SELECT id, cwd FROM threads WHERE id = ? LIMIT 1', [sessionId], loadSQLite,
  )
  if (!result.available) return null
  return result.rows.some(row => row.id === sessionId && typeof row.cwd === 'string' && sameSessionCwd(row.cwd, cwd))
}

export async function codexThreadNativeRolloutExists(cwd: string, sessionId: string, loadSQLite: SQLiteLoader = loadNodeSQLite): Promise<boolean | null> {
  const result = await queryCodexState<{ id?: unknown; cwd?: unknown; rollout_path?: unknown }>(
    'SELECT id, cwd, rollout_path FROM threads WHERE id = ? LIMIT 1', [sessionId], loadSQLite,
  )
  if (!result.available) return null
  const row = result.rows.find(candidate => candidate.id === sessionId && typeof candidate.cwd === 'string' && sameSessionCwd(candidate.cwd, cwd))
  if (!row) return null
  return await rolloutSizeWithinCodexHome(row.rollout_path) !== null
}

export async function captureCodexThreadId(cwd: string, spawnTime: number, signal: AbortSignal, claimedIds: ReadonlySet<string>, timeoutMs = 20_000, loadSQLite: SQLiteLoader = loadNodeSQLite, isAmbiguous: () => boolean = () => false): Promise<{ available: boolean; sessionId: string | null }> {
  const deadline = Date.now() + timeoutMs
  let previousId: string | null = null, singleSince: number | null = null
  while (Date.now() < deadline && !signal.aborted) {
    if (isAmbiguous()) { console.warn('[daemon] codex.capture.ambiguous', { reason: 'overlap' }); return { available: true, sessionId: null } }
    const result = await queryCodexState<{ id?: unknown; cwd?: unknown }>(
      'SELECT id, cwd FROM threads WHERE created_at_ms >= ?',
      [spawnTime - 2000], loadSQLite,
    )
    if (!result.available) return { available: false, sessionId: null }
    if (isAmbiguous()) { console.warn('[daemon] codex.capture.ambiguous', { reason: 'overlap' }); return { available: true, sessionId: null } }
    const ids = [...new Set(result.rows.filter(row => typeof row.cwd === 'string' && sameSessionCwd(row.cwd, cwd)).map(row => row.id).filter((id): id is string => typeof id === 'string' && UUID_RE.test(id) && !claimedIds.has(id)))]
    if (ids.length > 1) {
      console.warn('[daemon] codex.capture.ambiguous', { candidateCount: ids.length })
      return { available: true, sessionId: null }
    }
    const id = ids[0] ?? null
    if (id && previousId === id && singleSince !== null && Date.now() - singleSince >= 1000) {
      if (isAmbiguous()) { console.warn('[daemon] codex.capture.ambiguous', { reason: 'overlap' }); return { available: true, sessionId: null } }
      return { available: true, sessionId: id }
    }
    if (id !== previousId) singleSince = id ? Date.now() : null
    previousId = id
    if (!await waitForPoll(signal, 500)) break
  }
  return { available: true, sessionId: null }
}

export async function captureCodexSessionId(cwd: string, spawnTime: number, before: Set<string>, signal: AbortSignal, timeoutMs = 20_000, isAmbiguous: () => boolean = () => false): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  let singleCandidateSince: number | null = null
  let oversizeWarned = false
  const warnOversize = () => { if (!oversizeWarned) { oversizeWarned = true; console.warn('[daemon] sessions.codex.first_line_oversize', { maxBytes: FIRST_LINE_MAX_BYTES, phase: 'capture' }) } }
  const overlappingSpawn = () => {
    if (!isAmbiguous()) return false
    console.warn('[daemon] codex.capture.ambiguous', { reason: 'overlap' })
    return true
  }
  while (Date.now() < deadline && !signal.aborted) {
    if (overlappingSpawn()) return null
    const candidates = new Set<string>()
    for (const dir of (await dateDirs()).slice(0, MAX_DAY_DIRS)) {
      if (Date.now() >= deadline || signal.aborted) break
      const cutoff = Date.now() - 60 * 86_400_000
      const day = path.basename(dir), month = path.basename(path.dirname(dir)), year = path.basename(path.dirname(path.dirname(dir)))
      if (Date.parse(`${year}-${month}-${day}T23:59:59`) < cutoff) continue
      for (const name of await fs.promises.readdir(dir).catch(() => [])) {
        if (!/^rollout-.*\.jsonl$/.test(name)) continue
        const file = path.join(dir, name)
        if (before.has(file)) continue
        const line = await readFirstLine(file, warnOversize)
        if (!line) continue
        try {
          const raw: unknown = JSON.parse(line)
          if (!raw || typeof raw !== 'object') continue
          const outer = raw as Record<string, unknown>, payload = outer.payload
          if (outer.type !== 'session_meta' || !payload || typeof payload !== 'object') continue
          const data = payload as Record<string, unknown>
        if (typeof data.id === 'string' && UUID_RE.test(data.id) && typeof data.cwd === 'string' && sameSessionCwd(data.cwd, cwd) && typeof data.timestamp === 'string' && Date.parse(data.timestamp) >= spawnTime) candidates.add(data.id)
        } catch { /* partial/corrupt first lines are not candidates */ }
      }
    }
    if (overlappingSpawn()) return null
    if (candidates.size > 1) { console.warn('[daemon] codex.capture.ambiguous', { candidateCount: candidates.size }); return null }
    if (candidates.size === 1) {
      if (singleCandidateSince === null) singleCandidateSince = Date.now()
      else if (Date.now() - singleCandidateSince >= 1000) {
        if (overlappingSpawn()) return null
        return [...candidates][0]!
      }
    } else singleCandidateSince = null
    if (!await waitForPoll(signal, 500)) return null
  }
  return null
}

interface Rollout { id: string; cwd: string; timestamp: string; mtime: string; size: number }
async function dateDirs(limit = MAX_DAY_DIRS + 1): Promise<string[]> {
  const result: string[] = [], root = sessionsRoot()
  const years = (await fs.promises.readdir(root).catch(() => [])).filter(y => /^\d{4}$/.test(y)).sort().reverse()
  outer: for (const year of years) {
    const months = (await fs.promises.readdir(path.join(root, year)).catch(() => [])).filter(m => /^\d{2}$/.test(m)).sort().reverse()
    for (const month of months) {
      const days = (await fs.promises.readdir(path.join(root, year, month)).catch(() => [])).filter(d => /^\d{2}$/.test(d)).sort().reverse()
      for (const day of days) { result.push(path.join(root, year, month, day)); if (result.length >= limit) break outer }
    }
  }
  return result
}

async function rolloutSizeWithinCodexHome(rolloutPath: unknown): Promise<number | null> {
  if (typeof rolloutPath !== 'string' || !rolloutPath) return null
  const root = path.resolve(sessionsRoot())
  const target = path.resolve(path.isAbsolute(rolloutPath) ? rolloutPath : path.join(codexHome(), rolloutPath))
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return null
  try {
    const [realRoot, realTarget] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(target)])
    const realRelative = path.relative(realRoot, realTarget)
    if (!realRelative || realRelative.startsWith(`..${path.sep}`) || realRelative === '..' || path.isAbsolute(realRelative)) return null
    const stat = await fs.promises.stat(realTarget)
    return stat.isFile() ? stat.size : null
  } catch { return null }
}

function codexMillis(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function listCodexSessions(cwd: string, budgetMs = DEADLINE_MS, loadSQLite?: SQLiteLoader): Promise<SessionListResult> {
  const state = await queryCodexState<{ id?: unknown; cwd?: unknown; name?: unknown; created_at_ms?: unknown; updated_at_ms?: unknown; rollout_path?: unknown }>(
    'SELECT id, cwd, name, created_at_ms, updated_at_ms, rollout_path FROM threads WHERE cwd IN (?, ?) AND archived = 0 ORDER BY updated_at_ms DESC LIMIT 31',
    [cwd, canonicalSessionCwd(cwd)], loadSQLite,
  )
  if (state.available) {
    const roles = await readSessionRoles()
    const rows = state.rows.filter(row => typeof row.id === 'string' && UUID_RE.test(row.id) && typeof row.cwd === 'string' && sameSessionCwd(row.cwd, cwd))
    const entries: ClaudeSessionEntry[] = []
    for (const row of rows.slice(0, MAX_ENTRIES)) {
      entries.push({
        agentKey: 'codex', sessionId: row.id as string, cwd,
        title: typeof row.name === 'string' ? row.name : null,
        startedAt: codexMillis(row.created_at_ms), lastActivity: codexMillis(row.updated_at_ms),
        sizeBytes: await rolloutSizeWithinCodexHome(row.rollout_path),
        role: roles.get(sessionRoleKey('codex', row.id as string, cwd)) ?? null, renamable: false,
      } as ClaudeSessionEntry)
    }
    const truncated = state.rows.length === MAX_ENTRIES + 1
    return { entries, truncated, ...(truncated ? { truncatedReason: 'cap' as const } : {}) }
  }
  return listCodexSessionsFromRollouts(cwd, budgetMs, undefined, true)
}

async function listCodexSessionsFromRollouts(cwd: string, budgetMs = DEADLINE_MS, loadSQLite?: SQLiteLoader, skipNames = false): Promise<SessionListResult> {
  const deadline = Date.now() + budgetMs, allDirs = await dateDirs(MAX_DAY_DIRS + 1), dirs = allDirs.slice(0, MAX_DAY_DIRS), cutoff = Date.now() - 60 * 86_400_000
  const roles = await readSessionRoles(), found: Rollout[] = []
  let visitedDirs = 0, truncated = false, oversizeWarned = false, stoppedWithCandidates = false
  const warnOversize = () => { if (!oversizeWarned) { oversizeWarned = true; console.warn('[daemon] sessions.codex.first_line_oversize', { maxBytes: FIRST_LINE_MAX_BYTES, phase: 'list' }) } }
  for (const dir of dirs) {
    if (Date.now() >= deadline || visitedDirs >= MAX_DAY_DIRS) { stoppedWithCandidates = true; break }
    const dateName = path.basename(dir), month = path.basename(path.dirname(dir)), year = path.basename(path.dirname(path.dirname(dir)))
    const dayTime = Date.parse(`${year}-${month}-${dateName}T23:59:59`)
    if (!Number.isNaN(dayTime) && dayTime < cutoff) break
    visitedDirs++
    const names = (await fs.promises.readdir(dir).catch(() => [])).filter(name => /^rollout-.*\.jsonl$/.test(name)).sort().reverse()
    for (let i = 0; i < names.length; i++) {
      if (Date.now() >= deadline) { stoppedWithCandidates ||= names.slice(i).length > 0; break }
      const name = names[i]!
      const file = path.join(dir, name), line = await readFirstLine(file, warnOversize)
      if (!line) continue
      try {
        const row: unknown = JSON.parse(line)
        if (!row || typeof row !== 'object') continue
        const meta = row as Record<string, unknown>, payload = meta.payload
        if (meta.type !== 'session_meta' || !payload || typeof payload !== 'object') continue
        const data = payload as Record<string, unknown>
        if (typeof data.id !== 'string' || !UUID_RE.test(data.id) || typeof data.cwd !== 'string' || !sameSessionCwd(data.cwd, cwd) || typeof data.timestamp !== 'string') continue
        const stat = await fs.promises.stat(file).catch(() => null)
        if (!stat) continue
        found.push({ id: data.id, cwd: data.cwd, timestamp: data.timestamp, mtime: stat.mtime.toISOString(), size: stat.size })
        if (found.length > MAX_ENTRIES) { truncated = true; break }
      } catch { /* first line may be half-written; ignore it */ }
    }
    if (found.length > MAX_ENTRIES) break
  }
  if (!truncated && !stoppedWithCandidates && allDirs.length > MAX_DAY_DIRS) {
    const extraDir = allDirs[MAX_DAY_DIRS]!
    const extraDay = path.basename(extraDir), extraMonth = path.basename(path.dirname(extraDir)), extraYear = path.basename(path.dirname(path.dirname(extraDir)))
    if (Date.parse(`${extraYear}-${extraMonth}-${extraDay}T23:59:59`) >= cutoff) {
      for (const name of (await fs.promises.readdir(extraDir).catch(() => [])).filter(item => /^rollout-.*\.jsonl$/.test(item))) {
        const line = await readFirstLine(path.join(extraDir, name), warnOversize)
        if (!line) continue
        try {
          const row: unknown = JSON.parse(line), payload = row && typeof row === 'object' ? (row as Record<string, unknown>).payload : null
          if (row && typeof row === 'object' && (row as Record<string, unknown>).type === 'session_meta' && payload && typeof payload === 'object') {
            const data = payload as Record<string, unknown>
            if (typeof data.cwd === 'string' && sameSessionCwd(data.cwd, cwd) && typeof data.id === 'string' && UUID_RE.test(data.id)) { truncated = true; break }
          }
        } catch { /* malformed first line cannot add a session */ }
      }
    }
  }
  truncated ||= stoppedWithCandidates
  const truncatedReason = stoppedWithCandidates ? 'deadline' as const : truncated ? 'cap' as const : undefined
  const index = skipNames ? new Map<string, string | null>() : await readCodexThreadNames([...new Set(found.map(row => row.id))], loadSQLite)
  const entries: ClaudeSessionEntry[] = found.slice(0, MAX_ENTRIES).map(row => {
    return { agentKey: 'codex', sessionId: row.id, cwd: row.cwd, title: index.get(row.id) ?? null, startedAt: row.timestamp, lastActivity: row.mtime, sizeBytes: row.size, role: roles.get(sessionRoleKey('codex', row.id, row.cwd)) ?? null, renamable: false }
  })
  return { entries, truncated, ...(truncatedReason ? { truncatedReason } : {}) }
}
