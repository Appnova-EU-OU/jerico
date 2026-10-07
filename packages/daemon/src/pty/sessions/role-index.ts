import fs from 'node:fs'
import path from 'node:path'
import { sessionRolesPath } from '../../profile.js'
import { UUID_RE } from './session-utils.js'

export interface SessionRoleRecord { agentKey: 'claude' | 'codex'; sessionId: string; role: string | null; cwd: string; createdAt: string }
export const sessionRoleKey = (agentKey: 'claude' | 'codex', sessionId: string, cwd: string) => `${agentKey}|${sessionId}|${cwd}`
let writeQueue: Promise<void> = Promise.resolve()

function parseLines(raw: string): SessionRoleRecord[] {
  const result: SessionRoleRecord[] = []
  for (const line of raw.split(/\r?\n/)) {
    try {
      const row: unknown = JSON.parse(line)
      if (row && typeof row === 'object' && 'agentKey' in row && 'sessionId' in row && 'role' in row && 'cwd' in row && 'createdAt' in row) {
        const r = row as SessionRoleRecord
        if ((r.agentKey === 'claude' || r.agentKey === 'codex') && UUID_RE.test(r.sessionId) && (r.role === null || typeof r.role === 'string') && typeof r.cwd === 'string' && typeof r.createdAt === 'string') result.push(r)
      }
    } catch { /* tolerate a torn or corrupt JSONL record */ }
  }
  return result
}

export async function readSessionRoles(): Promise<Map<string, string | null>> {
  try {
    const records = parseLines(await fs.promises.readFile(sessionRolesPath(), 'utf8'))
    const roles = new Map<string, string | null>()
    for (const record of records) roles.set(sessionRoleKey(record.agentKey, record.sessionId, record.cwd), record.role)
    return roles
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[daemon] sessions.role_index.read_failed', { reason: String(error) })
    return new Map()
  }
}

export function appendSessionRole(record: Omit<SessionRoleRecord, 'createdAt'>): Promise<void> {
  const next = writeQueue.then(async () => {
    try {
      if (!UUID_RE.test(record.sessionId)) throw new Error('invalid_session_id')
      const file = sessionRolesPath()
      let lines: string[] = []
      try { lines = (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      let last: SessionRoleRecord | undefined
      for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = parseLines(lines[i]!)[0]
        if (parsed?.agentKey === record.agentKey && parsed.sessionId === record.sessionId && parsed.cwd === record.cwd) { last = parsed; break }
      }
      if (last?.role === record.role) return
      const entry: SessionRoleRecord = { ...record, createdAt: new Date().toISOString() }
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
      lines.push(JSON.stringify(entry))
      if (lines.length > 5000) {
        const compact: SessionRoleRecord[] = []
        const seen = new Set<string>()
        for (let i = lines.length - 1; i >= 0 && compact.length < 2000; i--) {
          const parsed = parseLines(lines[i]!)[0]
          if (!parsed) continue
          const key = sessionRoleKey(parsed.agentKey, parsed.sessionId, parsed.cwd)
          if (seen.has(key)) continue
          seen.add(key); compact.unshift(parsed)
        }
        const tmp = `${file}.${process.pid}.tmp`
        await fs.promises.writeFile(tmp, compact.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8')
        await fs.promises.rename(tmp, file)
      }
    } catch (error) {
      console.error('[daemon] sessions.role_index.write_failed', { agentKey: record.agentKey, reason: String(error) })
    }
  })
  writeQueue = next.catch(() => {})
  return next
}
