import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { connectCodegraph, type CodegraphConnection } from './client.js'

const HEALTH_INTERVAL_MS = 30_000
// Per-ping timeout: a ping that doesn't answer within this is counted a failure.
const HEALTH_PING_TIMEOUT_MS = 10_000
// Consecutive failures before restart. A large-repo index runs synchronously in the
// engine's event loop and can't answer pings WHILE it runs — but it DOES complete
// (verified: the standalone CLI indexes jerico's 497 files to completion). Killing it
// mid-index restarts it from scratch → an infinite respawn loop that pegged a real Mac
// at 461% CPU. So tolerate a long unresponsive window (~6 min) to let an in-progress
// index finish; a genuinely-crashed engine still gets replaced, just not instantly.
const HEALTH_FAILURE_THRESHOLD = 12
const MAX_RAPID_RESTARTS = 3
const BACKOFF_STEPS_MS = [2_000, 10_000, 30_000]
const SHUTDOWN_GRACE_MS = 5_000

/**
 * Matches native-module load failures that are NOT recoverable by restarting:
 * a better-sqlite3 / tree-sitter ABI mismatch means the codegraph child dies
 * the moment it requires the native module. Restarting just loops the same
 * crash, so we surface a clear health error and stop retrying.
 */
const ABI_ERROR_RE = /NODE_MODULE_VERSION|compiled against a different Node\.js version|was compiled against a different|dlopen\(|Error: Could not locate the bindings file|MODULE_NOT_FOUND.*\.node/i

interface SupervisorState {
  client: Client | null
  pid: number | null
  restartCount: number
  backoffIndex: number
  lastRestartAt: number
  shuttingDown: boolean
  healthTimer: NodeJS.Timeout | null
  /** Consecutive failed health pings (reset on success; >= HEALTH_FAILURE_THRESHOLD restarts). */
  consecutiveFailures: number
  /** Set when codegraph is unavailable for a non-recoverable reason (e.g. ABI mismatch). */
  healthError: string | null
  /** Last captured child stderr (used to diagnose post-connect crashes). */
  lastStderr: string
}

const state: SupervisorState = {
  client: null,
  pid: null,
  restartCount: 0,
  backoffIndex: 0,
  lastRestartAt: 0,
  shuttingDown: false,
  healthTimer: null,
  consecutiveFailures: 0,
  healthError: null,
  lastStderr: '',
}

/**
 * Reap the CURRENT codegraph child before spawning a replacement. Without this,
 * every respawn (transport_closed / health_ping_failure) leaves the old child
 * running — they piled up to 7 orphans = 461% CPU on a real Mac. SIGKILL the
 * process group so any grandchildren die too.
 */
function killPreviousChild(): void {
  const pid = state.pid
  if (!pid) return
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
  state.pid = null
  state.client = null
}

/**
 * Synchronous safety net: guarantees the codegraph child is never orphaned,
 * regardless of WHICH exit path the daemon takes or how fast it exits.
 * `state.pid` always reflects the CURRENT child (updated on every spawn/respawn),
 * so even after a crash-restart changed the pid, this kills the live one.
 * `process.on('exit')` runs synchronously during process.exit(), so the SIGKILL
 * is delivered before the daemon's own process is reaped.
 */
function killChildSync(): void {
  const pid = state.pid
  if (!pid) return
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
}
process.on('exit', killChildSync)

export function getCodegraphClient(): Client | null {
  return state.client
}

export function getCodegraphPid(): number | null {
  return state.pid
}

export function getCodegraphHealth(): { status: 'ok' | 'down' | 'error'; error: string | null } {
  if (state.client && !state.healthError) return { status: 'ok', error: null }
  if (state.healthError) return { status: 'error', error: state.healthError }
  return { status: 'down', error: null }
}

function extractChildPid(client: Client): number | null {
  try {
    const transport = (client as unknown as { transport?: { pid?: number; _process?: { pid?: number } } }).transport
    if (transport?.pid) return transport.pid
    if (transport?._process?.pid) return transport._process.pid
  } catch {}
  return null
}

async function healthPing(): Promise<boolean> {
  if (!state.client) return false
  try {
    // Liveness must not select a project: launchd may start us in `/`, and
    // project status synchronously inventories that tree. The SDK timeout also
    // cancels the request and releases its pending handler instead of only racing it.
    await state.client.ping({ timeout: HEALTH_PING_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

// Self-scheduling (non-overlapping) health loop: only restart after
// HEALTH_FAILURE_THRESHOLD CONSECUTIVE failures, so an in-progress index (which
// blocks pings but does finish) is not killed mid-run.
function startHealthCheck(): void {
  if (state.healthTimer) clearTimeout(state.healthTimer)
  state.consecutiveFailures = 0
  const tick = async (): Promise<void> => {
    if (state.shuttingDown || !state.client) return
    const ok = await healthPing()
    if (state.shuttingDown || !state.client) return
    if (ok) {
      state.consecutiveFailures = 0
    } else {
      state.consecutiveFailures++
      if (state.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD) {
        console.warn(`[codegraph-supervisor] health ping failed ${state.consecutiveFailures}× (~${Math.round(state.consecutiveFailures * HEALTH_INTERVAL_MS / 60000)}min) — restarting`)
        void restart('health_ping_failure')
        return
      }
    }
    state.healthTimer = setTimeout(() => void tick(), HEALTH_INTERVAL_MS)
  }
  state.healthTimer = setTimeout(() => void tick(), HEALTH_INTERVAL_MS)
}

function computeBackoffMs(): number {
  if (state.restartCount < MAX_RAPID_RESTARTS) return 0
  const idx = Math.min(state.backoffIndex, BACKOFF_STEPS_MS.length - 1)
  return BACKOFF_STEPS_MS[idx] ?? BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]!
}

async function spawn(reason: string): Promise<void> {
  if (state.shuttingDown) return
  // Reap the previous child FIRST so respawns never accumulate orphans.
  killPreviousChild()
  let conn: CodegraphConnection | null = null
  try {
    console.log(`[codegraph-supervisor] spawning codegraph (reason=${reason})`)
    conn = await connectCodegraph()
    const client = conn.client
    state.client = client
    state.pid = extractChildPid(client)
    state.healthError = null
    state.lastStderr = conn.stderrChunks.join('')
    console.log(`[codegraph-supervisor] codegraph connected (pid=${state.pid})`)

    const transport = (client as unknown as {
      transport?: {
        onclose?: (() => void) | null
        onerror?: ((err: Error) => void) | null
      }
    }).transport

    if (transport) {
      transport.onclose = () => {
        if (!state.shuttingDown) {
          if (state.lastStderr && ABI_ERROR_RE.test(state.lastStderr)) {
            const diag = state.lastStderr.trim().split('\n').slice(-6).join('\n')
            const healthMsg =
              `[codegraph] FATAL: native module (better-sqlite3 / tree-sitter) ABI/DLOPEN ` +
              `mismatch — the daemon is running under Node ${process.version} but the native ` +
              `binaries were built for a different Node ABI.\n` +
              `Fix: rebuild native modules for the daemon's Node, or run the daemon under the ` +
              `Node version the binaries target.\n` +
              `Child stderr:\n${diag}`
            state.healthError = healthMsg
            state.client = null
            state.pid = null
            console.error('\n' + healthMsg + '\n')
            return
          }
          console.warn('[codegraph-supervisor] codegraph transport closed')
          state.client = null
          state.pid = null
          void restart('transport_closed')
        }
      }
      transport.onerror = (err: Error) => {
        console.warn('[codegraph-supervisor] codegraph transport error:', err.message)
      }
    }

    state.restartCount = 0
    state.backoffIndex = 0
    startHealthCheck()
  } catch (err) {
    const stderr = conn?.stderrChunks.join('') ?? ''
    const baseMsg = err instanceof Error ? err.message : String(err)

    if (ABI_ERROR_RE.test(stderr) || ABI_ERROR_RE.test(baseMsg)) {
      // Native-module / ABI crash — not recoverable by restarting. Surface a
      // clear, actionable health error and STOP the restart loop (no silent loop).
      const diag = stderr.trim().split('\n').slice(-6).join('\n')
      const healthMsg =
        `[codegraph] FATAL: native module (better-sqlite3 / tree-sitter) ABI/DLOPEN ` +
        `mismatch — the daemon is running under Node ${process.version} but the native ` +
        `binaries were built for a different Node ABI.\n` +
        `Fix: rebuild native modules for the daemon's Node, or run the daemon under the ` +
        `Node version the binaries target.\n` +
        `Child stderr:\n${diag}`
      state.healthError = healthMsg
      state.client = null
      state.pid = null
      state.lastStderr = stderr
      console.error('\n' + healthMsg + '\n')
      return
    }

    console.error('[codegraph-supervisor] spawn failed:', baseMsg)
    state.client = null
    state.pid = null
    state.lastStderr = stderr
    if (!state.shuttingDown) {
      void restart('spawn_error')
    }
  }
}

async function restart(reason: string): Promise<void> {
  if (state.shuttingDown) return

  state.restartCount++
  const backoffMs = computeBackoffMs()

  if (state.restartCount > MAX_RAPID_RESTARTS + BACKOFF_STEPS_MS.length) {
    console.error(`[codegraph-supervisor] giving up after ${state.restartCount} restarts — codegraph unavailable (daemon continues)`)
    state.client = null
    state.pid = null
    return
  }

  if (backoffMs > 0) {
    state.backoffIndex++
    console.log(`[codegraph-supervisor] backoff ${backoffMs}ms before restart #${state.restartCount} (${reason})`)
    await new Promise<void>(r => setTimeout(r, backoffMs))
  }

  await spawn(reason)
}

export async function startSupervisor(): Promise<void> {
  try {
    await spawn('daemon_startup')
  } catch (err) {
    console.error('[codegraph-supervisor] initial spawn failed (daemon continues):', String(err))
  }
}

export function markShuttingDown(): void {
  state.shuttingDown = true
  if (state.healthTimer) {
    clearTimeout(state.healthTimer)
    state.healthTimer = null
  }
}

export async function shutdownSupervisor(): Promise<void> {
  state.shuttingDown = true
  if (state.healthTimer) {
    clearTimeout(state.healthTimer)
    state.healthTimer = null
  }

  const pid = state.pid
  if (!pid) {
    state.client = null
    return
  }

  console.log(`[codegraph-supervisor] shutting down codegraph (pid=${pid})`)

  try {
    process.kill(-pid, 'SIGTERM')
  } catch { try { process.kill(pid, 'SIGTERM') } catch {} }

  const deadline = Date.now() + SHUTDOWN_GRACE_MS
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      state.client = null
      state.pid = null
      console.log(`[codegraph-supervisor] codegraph terminated (pid=${pid})`)
      return
    }
    await new Promise<void>(r => setTimeout(r, 200))
  }

  try {
    process.kill(-pid, 'SIGKILL')
    console.log(`[codegraph-supervisor] SIGKILL sent to codegraph (pid=${pid})`)
  } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
  state.client = null
  state.pid = null
}
