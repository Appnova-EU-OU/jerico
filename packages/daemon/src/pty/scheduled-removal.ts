import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

export interface ScheduledRemoval {
  operationId: string
  attempts: Array<{ agentId: string; spawnAttemptId: string }>
  projectCwd: string
  scheduleId: string
  slotKey: string
  worktreePath: string
}
type Record = { request: ScheduledRemoval; pid?: number }
export type RemovalResult = { ok: boolean; quiescent: boolean }
type Executor = (request: ScheduledRemoval, recordPid: (pid: number) => void) => Promise<boolean>

function groupAlive(pid: number): boolean {
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

export function validScheduledRemoval(request: ScheduledRemoval): boolean {
  if (!request || typeof request.operationId !== 'string' || !request.operationId || request.operationId.length > 128
    || !Array.isArray(request.attempts) || request.attempts.length < 1 || request.attempts.length > 2
    || request.attempts.some(a => !a || typeof a.agentId !== 'string' || !a.agentId || a.agentId.length > 256
      || typeof a.spawnAttemptId !== 'string' || !/^[a-f0-9-]{36}$/i.test(a.spawnAttemptId))
    || typeof request.projectCwd !== 'string' || !isAbsolute(request.projectCwd)
    || typeof request.worktreePath !== 'string' || !isAbsolute(request.worktreePath)
    || typeof request.scheduleId !== 'string' || typeof request.slotKey !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(request.scheduleId) || !/^[A-Za-z0-9_.:-]+$/.test(request.slotKey)
    || request.slotKey === '.' || request.slotKey === '..') return false
  const root = resolve(request.projectCwd, '.jerico', 'sched')
  const expected = resolve(root, request.scheduleId, request.slotKey.replace(/:/g, ''))
  return expected.startsWith(root + sep) && request.worktreePath === expected
}

/** Persistent exclusion, independent of WebSocket/server lifetime. No lease can
 * expire a running removal. A restarted daemon may reap only an absent group.
 * An unrecorded child cannot run: its stdin gate opens AFTER the pid is durable. */
export class ScheduledRemovalReservations {
  private records = new Map<string, Record>()
  private active = new Map<string, Promise<RemovalResult>>()
  private loaded = false
  private broken = false
  constructor(private path?: () => string, private execute: Executor = removeExactWorktree,
    private alive = groupAlive) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const path = this.path?.()
      if (!path) return
      const rows: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(rows) || rows.some(row => !validScheduledRemoval(row?.request)
        || (row.pid !== undefined && (!Number.isSafeInteger(row.pid) || row.pid <= 0)))) throw new Error('invalid cleanup journal')
      for (const row of rows) this.records.set(row.request.operationId, row)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.broken = true }
  }

  private save(): void {
    const path = this.path?.()
    if (!path) return
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify([...this.records.values()]), { mode: 0o600 })
    const fd = openSync(temp, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, path)
    const dir = openSync(dirname(path), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }

  private reap(): void {
    this.load()
    if (this.broken) return
    for (const [id, record] of this.records) {
      if (!this.active.has(id) && (!record.pid || !this.alive(record.pid))) {
        this.records.delete(id)
        try { this.save() } catch { this.records.set(id, record) }
      }
    }
  }

  snapshot(): Array<{ operationId: string; agentIds: string[] }> | undefined {
    this.reap()
    if (this.broken) return undefined
    return [...this.records.values()].map(row => ({ operationId: row.request.operationId,
      agentIds: row.request.attempts.map(a => a.agentId) }))
  }

  blocked(agentId: string): boolean {
    this.reap()
    if (this.broken) return agentId.startsWith('sched-')
    return [...this.records.values()].some(row => row.request.attempts.some(a => a.agentId === agentId))
  }

  quiescent(operationId: string): boolean {
    this.reap()
    return !this.broken && !this.records.has(operationId) && !this.active.has(operationId)
  }

  remove(request: ScheduledRemoval, roster: () => Array<{ agentId: string }>): Promise<RemovalResult> {
    this.reap()
    if (this.broken || !validScheduledRemoval(request)) return Promise.resolve({ ok: false, quiescent: false })
    const existing = this.records.get(request.operationId)
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) return Promise.resolve({ ok: false, quiescent: false })
      return this.active.get(request.operationId) ?? Promise.resolve({ ok: false, quiescent: false })
    }
    if (request.attempts.some(a => this.blocked(a.agentId))) return Promise.resolve({ ok: false, quiescent: true })
    // Install exclusion synchronously before the first await/roster read.
    const record: Record = { request }
    this.records.set(request.operationId, record)
    let finish!: (result: RemovalResult) => void
    const operation = new Promise<RemovalResult>(resolve => { finish = resolve })
    this.active.set(request.operationId, operation)
    void (async () => {
      let ok = false
      try {
        this.save()
        if (!roster().some(panel => request.attempts.some(a => a.agentId === panel.agentId))) {
          ok = await this.execute(request, pid => { record.pid = pid; this.save() })
        }
      } catch { /* retain exclusion until every possible child has stopped */ }
      this.active.delete(request.operationId)
      this.reap()
      finish({ ok, quiescent: this.quiescent(request.operationId) })
    })()
    return operation
  }
}

async function removeExactWorktree(request: ScheduledRemoval, recordPid: (pid: number) => void): Promise<boolean> {
  if (process.platform === 'win32') return false
  // Refuse symlinked containment ancestors. Missing worktrees are idempotent.
  const root = realpathSync(request.projectCwd)
  for (const path of [resolve(request.projectCwd, '.jerico'), resolve(request.projectCwd, '.jerico/sched'),
    dirname(request.worktreePath), request.worktreePath]) {
    if (existsSync(path) && realpathSync(path) !== resolve(root, path.slice(resolve(request.projectCwd).length + 1))) return false
  }
  await new Promise<void>(resolveExit => {
    // The child cannot execute git until its PID/group is durably reserved.
    const child = spawn('/bin/sh', ['-c', 'IFS= read -r gate && exec git worktree remove --force -- "$1"',
      'scheduled-cleanup', request.worktreePath], { cwd: request.projectCwd, detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
    let timer: ReturnType<typeof setTimeout> | undefined
    child.once('error', () => resolveExit())
    child.once('close', () => {
      // A descendant may outlive git; keep its group kill deadline and the
      // reservation until the whole group is absent.
      if (!child.pid || !groupAlive(child.pid)) clearTimeout(timer)
      resolveExit()
    })
    child.stdin.on('error', () => {})
    try {
      if (!child.pid) { child.stdin.destroy(); return }
      recordPid(child.pid)
      timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 10_000)
      timer.unref?.()
      child.stdin.end('remove\n')
    } catch {
      // Journal failure before gate acceptance cannot start destructive work.
      child.stdin.destroy()
    }
  })
  if (existsSync(request.worktreePath)) return false
  const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: request.projectCwd, encoding: 'utf8', timeout: 5_000 })
  return !list.split(/\r?\n/).includes(`worktree ${request.worktreePath}`)
}
