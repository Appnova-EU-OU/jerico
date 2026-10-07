import type { ClaudeSessionEntry } from '@jerico/shared'
import { listClaudeSessions, renameNativeSession } from './sessions/index.js'

export async function listClaudeSessionsForCwd(cwd: string): Promise<ClaudeSessionEntry[]> {
  return (await listClaudeSessions(cwd)).entries
}

export async function renameClaudeSession(cwd: string, sessionId: string, title: string): Promise<void> {
  await renameNativeSession('claude', cwd, sessionId, title)
}
