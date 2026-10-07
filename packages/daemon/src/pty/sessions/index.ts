import type { ClaudeSessionEntry } from '@jerico/shared'
import { listClaudeSessions } from './claude.js'
import { listCodexSessions, codexThreadNativeRolloutExists } from './codex.js'
import { appendSessionRole, readSessionRoles } from './role-index.js'
import { sameSessionCwd, UUID_RE } from './session-utils.js'
import { nameClaudeSession, orchestratorSessionName } from './naming.js'
import { claudeSessionFile } from './claude.js'
import fs from 'node:fs'

type SessionListResult = { entries: ClaudeSessionEntry[]; truncated: boolean; truncatedReason?: 'cap' | 'deadline' }

export type { ClaudeSessionEntry }
export { appendSessionRole, readSessionRoles, listClaudeSessions, listCodexSessions, nameClaudeSession, orchestratorSessionName }

export async function listSessionsForCwd(cwd: string, requestedAgentKeys?: Array<'claude' | 'codex'>): Promise<SessionListResult> {
  const agentKeys = new Set(requestedAgentKeys ?? ['claude'])
  const providers = await Promise.allSettled([
    ...(agentKeys.has('claude') ? [listClaudeSessions(cwd)] : []),
    ...(agentKeys.has('codex') ? [listCodexSessions(cwd)] : []),
  ])
  const successes = providers.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  for (const result of providers) if (result.status === 'rejected') console.error('[daemon] sessions.provider.list_failed', { reason: String(result.reason) })
  if (successes.length === 0 && providers.some(result => result.status === 'rejected')) throw new Error('session providers failed')
  const truncated = successes.some(result => result.truncated)
  const truncatedReason = successes.some(result => result.truncatedReason === 'deadline')
    ? 'deadline'
    : successes.some(result => result.truncated) ? 'cap' : undefined
  return { entries: successes.flatMap(result => result.entries), truncated, ...(truncatedReason ? { truncatedReason } : {}) }
}

export async function renameNativeSession(agentKey: 'claude' | 'codex', cwd: string, sessionId: string, title: string): Promise<void> {
  if (!UUID_RE.test(sessionId)) throw new Error('invalid_session_id')
  const clean = title.trim()
  if (!clean || clean.length > 120) throw new Error('invalid title')
  if (agentKey === 'claude') {
    const file = claudeSessionFile(cwd, sessionId)
    const handle = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND)
    try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error('native_session_missing'); await handle.write(Buffer.from(`${JSON.stringify({ type: 'custom-title', customTitle: clean, sessionId })}\n`, 'utf8')) }
    finally { await handle.close() }
  } else throw new Error('codex session rename is unsupported')
}

export async function recordStartedSession(agentKey: 'claude' | 'codex', sessionId: string, role: string | undefined, cwd: string, isResume = false): Promise<void> {
  if (isResume && (await readSessionRoles()).has(`${agentKey}|${sessionId}|${cwd}`)) return
  await appendSessionRole({ agentKey, sessionId, role: role ?? null, cwd })
}

export async function assignOrchestratorName(cwd: string, sessionId: string, signal: AbortSignal): Promise<void> {
  await nameClaudeSession(cwd, sessionId, orchestratorSessionName(), signal)
}

export async function nativeSessionExists(agentKey: 'claude' | 'codex', cwd: string, sessionId: string, loadSQLite?: () => Promise<unknown>): Promise<boolean> {
  if (!UUID_RE.test(sessionId)) return false
  if (agentKey === 'claude') {
    try {
      const file = claudeSessionFile(cwd, sessionId), stat = await fs.promises.stat(file)
      if (!stat.isFile()) return false
      const handle = await fs.promises.open(file, 'r')
      try {
        const buffer = Buffer.alloc(64 * 1024), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        return buffer.toString('utf8', 0, bytesRead).split('\n').some(line => {
          try { const row: unknown = JSON.parse(line); return !!row && typeof row === 'object' && 'cwd' in row && typeof (row as { cwd?: unknown }).cwd === 'string' && sameSessionCwd((row as { cwd: string }).cwd, cwd) }
          catch { return false }
        })
      } finally { await handle.close() }
    } catch { return false }
  }
  return await codexThreadNativeRolloutExists(cwd, sessionId, loadSQLite) === true
}

export async function checkNativeSessionResumeAtCwd(
  agentKey: 'claude' | 'codex',
  effectiveCwd: string,
  sessionId: string,
  exists: typeof nativeSessionExists = nativeSessionExists,
): Promise<boolean> {
  return exists(agentKey, effectiveCwd, sessionId)
}
