import fs from 'node:fs'
import { claudeSessionFile } from './claude.js'
import { UUID_RE } from './session-utils.js'

export function orchestratorSessionName(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `Orchestrator · ${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const CODEX_RENAME_SUBMIT_DELAY_MS = 400

export async function sendCodexOrchestratorRename(
  write: (data: Buffer) => boolean,
  title: string,
  delay: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<boolean> {
  if (!write(Buffer.from(`/rename ${title}`, 'utf8'))) return false
  await delay(CODEX_RENAME_SUBMIT_DELAY_MS)
  return write(Buffer.from('\r', 'utf8'))
}

export function createCodexRenameOnReady(
  isFreshOrchestrator: boolean,
  write: (data: Buffer) => boolean,
  getTitle: () => string,
  delay?: (ms: number) => Promise<void>,
): (() => Promise<boolean>) | null {
  if (!isFreshOrchestrator) return null
  let sent = false
  return () => {
    if (sent) return Promise.resolve(true)
    sent = true
    return sendCodexOrchestratorRename(write, getTitle(), delay)
  }
}

export async function nameClaudeSession(cwd: string, sessionId: string, title: string, signal: AbortSignal, pollMs = 5_000): Promise<boolean> {
  if (!UUID_RE.test(sessionId)) throw new Error('invalid_session_id')
  const file = claudeSessionFile(cwd, sessionId)
  while (!signal.aborted) {
    try {
      const handle = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND)
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) return false
        const readHandle = await fs.promises.open(file, 'r')
        let hasTitle = false
        try {
          const readSize = Math.min(stat.size, 64 * 1024), buffer = Buffer.alloc(readSize), tail = Buffer.alloc(readSize)
          const headRead = await readHandle.read(buffer, 0, readSize, 0)
          const tailRead = stat.size > readSize ? await readHandle.read(tail, 0, readSize, Math.max(0, stat.size - readSize)) : headRead
          hasTitle = [buffer.toString('utf8', 0, headRead.bytesRead), tail.toString('utf8', 0, tailRead.bytesRead)].some(content => content.split('\n').some(line => {
            try { const row: unknown = JSON.parse(line); return !!row && typeof row === 'object' && 'customTitle' in row && typeof row.customTitle === 'string' }
            catch { return false }
          }))
        } finally { await readHandle.close() }
        if (hasTitle) return false
        await handle.write(Buffer.from(`${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })}\n`, 'utf8'))
        return true
      } finally { await handle.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[daemon] sessions.naming.claude_failed', { reason: String(error) })
    }
    if (signal.aborted) return false
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, pollMs)
      signal.addEventListener('abort', done, { once: true })
    })
  }
  return false
}
