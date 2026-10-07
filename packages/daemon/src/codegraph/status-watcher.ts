import { getCodegraphClient, getCodegraphHealth } from './supervisor.js'
import type { BridgeConfig } from '../config.js'
import type { PtyManager } from '../pty/manager.js'

const POLL_INTERVAL_MS = 30_000
const INITIAL_DELAY_MS = 2_000
const CALLTOOL_TIMEOUT_MS = 10_000

interface CodegraphStatus {
  indexed: number
  total: number
  stale: number
  lastIndexedAt: number | null
  indexing: boolean
  openDbs: number
  resolutionCoverage: { resolved: number; unresolved: number }
  unsupportedLanguages: string[]
}

export interface CodegraphStatusMessage {
  type: 'codegraph_status'
  daemonId: string
  health: { status: 'ok' | 'down' | 'error'; error: string | null }
  projects: CodegraphStatusProject[]
}

export interface CodegraphStatusProject {
  cwd: string
  indexed: number
  total: number
  stale: number
  lastIndexedAt: number | null
  indexing: boolean
  coverage: { resolved: number; unresolved: number }
  unsupportedLanguages: string[]
}

type EmitFn = (msg: CodegraphStatusMessage) => void

export function parseStatusResult(result: unknown): CodegraphStatus | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  const content = Array.isArray(r['content']) ? r['content'] : []
  const first = content[0]
  if (!first || typeof first !== 'object') return null
  const text = (first as Record<string, unknown>)['text']
  if (typeof text !== 'string') return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const p = parsed as Record<string, unknown>
    const resolutionCoverage = p['resolutionCoverage']
    if (!resolutionCoverage || typeof resolutionCoverage !== 'object') return null
    const cov = resolutionCoverage as Record<string, unknown>
    const unsupportedLanguages = Array.isArray(p['unsupportedLanguages'])
      ? p['unsupportedLanguages'].filter((l): l is string => typeof l === 'string')
      : []
    return {
      indexed: typeof p['indexed'] === 'number' ? p['indexed'] : 0,
      total: typeof p['total'] === 'number' ? p['total'] : 0,
      stale: typeof p['stale'] === 'number' ? p['stale'] : 0,
      lastIndexedAt: typeof p['lastIndexedAt'] === 'number' ? p['lastIndexedAt'] : null,
      indexing: typeof p['indexing'] === 'boolean' ? p['indexing'] : false,
      openDbs: typeof p['openDbs'] === 'number' ? p['openDbs'] : 0,
      resolutionCoverage: {
        resolved: typeof cov['resolved'] === 'number' ? cov['resolved'] : 0,
        unresolved: typeof cov['unresolved'] === 'number' ? cov['unresolved'] : 0,
      },
      unsupportedLanguages,
    }
  } catch {
    return null
  }
}

function collectKnownCwds(config: BridgeConfig, manager: PtyManager): string[] {
  const set = new Set<string>()
  if (config.projectPaths) {
    for (const cwd of Object.values(config.projectPaths)) {
      if (cwd) set.add(cwd)
    }
  }
  for (const panel of manager.getLivePanels()) {
    if (panel.cwd) set.add(panel.cwd)
  }
  return [...set]
}

async function pollOnce(daemonId: string, config: BridgeConfig, manager: PtyManager, emit: EmitFn): Promise<void> {
  const health = getCodegraphHealth()
  const projects: CodegraphStatusProject[] = []

  if (health.status === 'ok') {
    const client = getCodegraphClient()
    if (client) {
      const cwds = collectKnownCwds(config, manager)
      for (const cwd of cwds) {
        try {
          const result = await Promise.race<unknown>([
            client.callTool({ name: 'bridge_codegraph_status', arguments: { cwd } }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('callTool timeout')), CALLTOOL_TIMEOUT_MS),
            ),
          ])
          const status = parseStatusResult(result)
          if (!status) continue
          projects.push({
            cwd,
            indexed: status.indexed,
            total: status.total,
            stale: status.stale,
            lastIndexedAt: status.lastIndexedAt,
            indexing: status.indexing,
            coverage: status.resolutionCoverage,
            unsupportedLanguages: status.unsupportedLanguages,
          })
        } catch (err) {
          console.warn('[daemon] codegraph_status.poll_error', { daemonId: daemonId.slice(0, 8), cwd, error: String(err) })
        }
      }
    }
  }

  emit({ type: 'codegraph_status', daemonId, health, projects })
}

/**
 * Proactive periodic codegraph status forwarder.
 * Mirrors adoption-forwarder: poll every 30s, emit immediately on start, and
 * return a stop function. All I/O is inside try/catch; the setup only registers
 * timers so it cannot throw into the connect handler.
 */
export function startCodegraphStatusWatcher(
  daemonId: string,
  config: BridgeConfig,
  manager: PtyManager,
  emit: EmitFn,
): () => void {
  let running = true
  let pollTimer: NodeJS.Timeout | null = null
  let initialTimer: NodeJS.Timeout | null = null

  const scheduleNext = (): void => {
    if (!running) return
    pollTimer = setTimeout(() => { void tick() }, POLL_INTERVAL_MS)
  }

  const tick = async (): Promise<void> => {
    if (!running) return
    try {
      await pollOnce(daemonId, config, manager, emit)
    } catch (err) {
      console.warn('[daemon] codegraph_status.tick_error', { daemonId: daemonId.slice(0, 8), error: String(err) })
    } finally {
      // Self-chaining: next tick only starts after the current one settles.
      scheduleNext()
    }
  }

  // Initial emit after a short delay so the UI shows status without waiting a cycle.
  initialTimer = setTimeout(() => { void tick() }, INITIAL_DELAY_MS)

  return () => {
    running = false
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    if (initialTimer) {
      clearTimeout(initialTimer)
      initialTimer = null
    }
  }
}
