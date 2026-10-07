/**
 * Structured JSON-lines lifecycle logger.
 *
 * Writes to a single findable log file (~/bridge-daemon<suffix>.lifecycle.log)
 * AND emits to stdout so launchd captures it in daemon.log.
 *
 * Both the daemon and the desktop app write to this same file with a
 * component discriminator field, enabling unified `bridge-agent logs` view.
 *
 * Design: forge model (unified single-file) + kimi schema.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { getLogPaths } from './profile.js'

let _logPath: string | null = null

export function getLifecycleLogFilePath(): string {
  return _logPath ?? getLogPaths().lifecycle
}

export function setLifecycleLogFilePath(p: string): void {
  _logPath = p
}

export interface LifecycleEvent {
  ts: number
  event: string
  component: 'daemon' | 'desktop' | 'cli'
  [key: string]: unknown
}

export function logLifecycle(
  event: string,
  payload: Record<string, unknown> = {},
  component: 'daemon' | 'desktop' | 'cli' = 'daemon',
): void {
  const entry: LifecycleEvent = {
    ts: Date.now(),
    event,
    component,
    pid: process.pid,
    ...payload,
  }

  // Phase10: Include BRIDGE_REQUEST_ID for full app→CLI→daemon correlation
  const requestId = process.env['BRIDGE_REQUEST_ID']
  if (requestId) entry.requestId = requestId

  const line = JSON.stringify(entry) + '\n'

  try {
    const logPath = getLifecycleLogFilePath()
    mkdirSync(path.dirname(logPath), { recursive: true })
    appendFileSync(logPath, line, 'utf-8')
  } catch {
    // Best effort — never crash on logging failure
  }

  // Also emit to stdout so launchd picks it up in daemon.log
  console.log(line.trim())
}
