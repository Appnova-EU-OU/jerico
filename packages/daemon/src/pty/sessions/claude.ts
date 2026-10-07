import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ClaudeSessionEntry } from '@jerico/shared'
import { readSessionRoles } from './role-index.js'
import { sessionRoleKey } from './role-index.js'
import { canonicalSessionCwd, sameSessionCwd, UUID_RE } from './session-utils.js'

const MAX_ENTRIES = 30
const DEADLINE_MS = 3000
const CONCURRENCY = 16
const BUFFER_BYTES = 64 * 1024
type SessionListResult = { entries: ClaudeSessionEntry[]; truncated: boolean; truncatedReason?: 'cap' | 'deadline' }
const home = () => process.env.HOME || os.homedir()
export const encodeClaudeCwd = (cwd: string) => canonicalSessionCwd(cwd).replace(/[/.]/g, '-')
export const claudeSessionFile = (cwd: string, id: string) => path.join(home(), '.claude', 'projects', encodeClaudeCwd(cwd), `${id}.jsonl`)

async function parallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R | null>): Promise<R[]> {
  const output: R[] = []
  let index = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) { const item = items[index++]!; const value = await work(item); if (value !== null) output.push(value) }
  }))
  return output
}

export async function boundedClaudeStats(names: string[], dir: string, deadline: number, statFile = (file: string) => fs.promises.stat(file)):
  Promise<{ stats: Array<{ name: string; mtime: Date; birthtime: Date; size: number }>; timedOut: boolean }> {
  const stats: Array<{ name: string; mtime: Date; birthtime: Date; size: number }> = []
  let cursor = 0, accepting = true
  const scan = Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, async () => {
    while (accepting && Date.now() < deadline) {
      const name = names[cursor++]
      if (name === undefined) return
      try {
        const stat = await statFile(path.join(dir, name))
        if (accepting && stat.isFile()) stats.push({ name, mtime: stat.mtime, birthtime: stat.birthtime, size: stat.size })
      } catch { /* session may disappear while scanning */ }
    }
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const remaining = Math.max(0, deadline - Date.now())
  const completed = await Promise.race([scan.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), remaining) })])
  if (timer) clearTimeout(timer)
  if (!completed) accepting = false
  else accepting = false
  return { stats, timedOut: !completed || cursor < names.length }
}

function completeLines(buffer: string, fromHead: boolean, partialBoundary: boolean): string[] {
  const lines = buffer.split('\n')
  if (fromHead && partialBoundary) lines.pop()
  else if (!fromHead && partialBoundary) lines.shift()
  return lines
}

function promptTitle(record: Record<string, unknown>): string | null {
  let content: unknown
  if (record.role === 'user' && typeof record.content === 'string') content = record.content
  else if (record.type === 'user' && record.message && typeof record.message === 'object') content = (record.message as Record<string, unknown>).content
  if (typeof content === 'string' && content.trim()) return content.trim().slice(0, 80)
  if (Array.isArray(content)) {
    const text = content.flatMap(block => block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join(' ').trim()
    return text ? text.slice(0, 80) : null
  }
  return null
}

async function titleAndStart(file: string, size: number): Promise<{ title: string | null; startedAt: string | null; cwd: string | null }> {
  try {
    const handle = await fs.promises.open(file, 'r')
    try {
      const headBuf = Buffer.alloc(Math.min(BUFFER_BYTES, size)), headRead = await handle.read(headBuf, 0, headBuf.length, 0)
      const head = headBuf.toString('utf8', 0, headRead.bytesRead)
      let tail = head
      if (size > BUFFER_BYTES) { const buf = Buffer.alloc(BUFFER_BYTES), read = await handle.read(buf, 0, buf.length, Math.max(0, size - BUFFER_BYTES)); tail = buf.toString('utf8', 0, read.bytesRead) }
      let title: string | null = null, startedAt: string | null = null, cwd: string | null = null, fallback: string | null = null
      const firstLines = completeLines(head, true, size > headRead.bytesRead)
      for (const line of firstLines) {
        try { const value: unknown = JSON.parse(line); if (value && typeof value === 'object') { const r = value as Record<string, unknown>; if (!startedAt && typeof r.timestamp === 'string') startedAt = r.timestamp; if (!cwd && typeof r.cwd === 'string') cwd = r.cwd; if (typeof r.customTitle === 'string') title = r.customTitle; if (typeof r.aiTitle === 'string' && !title) title = r.aiTitle; if (!fallback) fallback = promptTitle(r) } } catch { /* corrupt lines are ignored */ }
      }
      if (size > BUFFER_BYTES) for (const line of completeLines(tail, false, true)) {
        try { const value: unknown = JSON.parse(line); if (value && typeof value === 'object') { const r = value as Record<string, unknown>; if (typeof r.customTitle === 'string') title = r.customTitle; else if (!title && typeof r.aiTitle === 'string') title = r.aiTitle } } catch { /* partial and corrupt lines are ignored */ }
      }
      return { title: title?.trim() || fallback, startedAt, cwd }
    } finally { await handle.close() }
  } catch { return { title: null, startedAt: null, cwd: null } }
}

export async function listClaudeSessions(cwd: string, budgetMs = DEADLINE_MS): Promise<SessionListResult> {
  const deadline = Date.now() + budgetMs
  const dir = path.join(home(), '.claude', 'projects', encodeClaudeCwd(cwd))
  let names: string[]
  try { names = await fs.promises.readdir(dir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[daemon] sessions.claude.list_failed', { reason: String(error) })
    return { entries: [], truncated: false }
  }
  const jsonl = names.filter(name => name.endsWith('.jsonl') && UUID_RE.test(name.slice(0, -6)))
  const scanned = await boundedClaudeStats(jsonl, dir, deadline)
  const stats = scanned.stats
  stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime() || a.name.localeCompare(b.name))
  const roles = await readSessionRoles()
  const top = stats.slice(0, MAX_ENTRIES)
  const entries = await parallel(top, CONCURRENCY, async item => {
    if (Date.now() >= deadline) return null
    const id = item.name.slice(0, -6), metadata = await titleAndStart(path.join(dir, item.name), item.size)
    if (!metadata.cwd || !sameSessionCwd(metadata.cwd, cwd)) return null
    return { agentKey: 'claude' as const, sessionId: id, cwd, title: metadata.title, startedAt: metadata.startedAt ?? item.birthtime.toISOString(), lastActivity: item.mtime.toISOString(), sizeBytes: item.size, role: roles.get(sessionRoleKey('claude', id, cwd)) ?? null, renamable: true }
  })
  const deadlineTruncated = scanned.timedOut || (Date.now() >= deadline && entries.length < top.length)
  const capped = stats.length > MAX_ENTRIES
  const truncated = deadlineTruncated || capped
  return { entries, truncated, ...(deadlineTruncated ? { truncatedReason: 'deadline' as const } : capped ? { truncatedReason: 'cap' as const } : {}) }
}
