import { CleanupRetirements } from './cleanup-retirements.js'
import { ScheduledProcessGroupLedger, type ScheduledProcessGroupReport } from './scheduled-process-groups.js'
import { ScheduledRemovalReservations } from './scheduled-removal.js'
import { getScheduledRemovalJournalPath } from '../profile.js'
import * as pty from 'node-pty'
import { writeFileSync, mkdirSync, readFileSync, renameSync, existsSync } from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { AGENT_SPECS, isTuiStartupMonitored } from './agents.js'
import { filterEnv } from './env-filter.js'
import { isSpawnAttemptId, type WorkspaceId, type ProjectId, type AgentId, type PanelMeta, type SpawnAttemptId } from '../shared/types.js'
import { getSpawnManifestPath } from '../profile.js'
import { randomBytes } from 'node:crypto'
import { getHookEnvPairs, EVENT_TOKEN_ENV_VAR } from '../hooks/protocol.js'
import { applyHookTargetSpawnEnv } from '../hooks/targets.js'
import { logLifecycle } from '../lifecycle-log.js'
import { getHookConfig, getHookInstallRefusal } from '../hooks/state.js'

/**
 * How long a panel gets to honour SIGTERM before SIGKILL follows on the ordinary
 * (non-force) path. Deliberately LONGER than the force path's 2s: force means the
 * caller wants it gone, graceful means the agent should get a fair chance to flush
 * its session state first. An agent that has not exited after this has stopped
 * responding to SIGTERM, and leaving it alive only leaks its pty — nothing can
 * kill it later because the handle is already gone.
 */
export const GRACEFUL_KILL_GRACE_MS = 5000

/**
 * Close a pty's master fd.
 *
 * node-pty releases the master only from its own `onexit` path. `kill()` bypasses
 * that path on purpose — it signals the process group directly and sets
 * `handle.killed` so our own onExit/onData callbacks are short-circuited — so the
 * fd would otherwise stay open until the daemon process dies. Over a long-lived
 * daemon this is what exhausts the pty/fd budget and turns every later spawn into
 * node-pty's opaque `posix_spawnp failed`.
 *
 * `destroy()` exists on node-pty's UnixTerminal at runtime but is absent from the
 * public `IPty` typing, hence the cast. It is a no-op on an already-torn-down
 * terminal and must never take the daemon down, so every failure is swallowed.
 *
 * Known residual: node-pty 1.1.0's native fork() leaves ONE extra /dev/ptmx fd open
 * that JavaScript never receives a handle to (the master it reports is a different
 * descriptor). That one cannot be closed from here — closing a raw fd number we do
 * not own would be worse than leaking it. Measured 1 leaked fd per pty even for a
 * panel that exits naturally with no teardown at all. Fixing it needs a node-pty
 * upgrade or patch; this function removes the second, avoidable leak.
 */
function disposePty(proc: pty.IPty, agentId: string): void {
  try {
    const disposable = proc as pty.IPty & { destroy?: () => void }
    if (typeof disposable.destroy === 'function') disposable.destroy()
  } catch (err) {
    console.warn('[daemon] pty.dispose.failed', { agentId, error: String(err) })
  }
}

export interface SpawnContext {
  serverUrl:   string
  token:       string
  workspaceId: WorkspaceId
  projectId?:  ProjectId
  agentId:     AgentId
  personaId?:  string
  cwd?:        string
  /** Extra env vars from .jerico/settings.json — merged over process.env */
  projectEnv?: Record<string, string>
  /** Per-agent env vars injected after spec.env but before BRIDGE_ identity */
  agentEnv?:   Record<string, string>
}

/** Single entry in the spawn manifest (persisted to ~/.bridge/). */
export interface ManifestEntry {
  agentId: string
  agentKey: string
  pid: number
  pgid: number
  startedAt: number
  daemonPid: number
}

interface PtyHandle {
  agentId:  string
  spawnAttemptId: SpawnAttemptId
  agentKey: string
  process:  pty.IPty
  pid:      number
  killed:   boolean
  instanceId: number
  cwd?:     string
  usagePct?: number
  startupGate?: import('@jerico/shared').PanelStartupGateState
  /** Exact environment passed to node-pty. Kept private to the daemon and
   * exposed only as a defensive clone for same-env provider preflights. */
  spawnEnv: Record<string, string>
  reissueTimer?: ReturnType<typeof setTimeout> | null
  onExit:   (exitCode: number | null, signal: string | null) => void
}

export class PtyManager {
  scheduledRemovals = new ScheduledRemovalReservations(getScheduledRemovalJournalPath)
  private pendingScheduledRosterSpawns = new Map<string, number>()
  trackPendingCleanupSpawn(agentId: string): void {
    this.pendingScheduledRosterSpawns.set(agentId, (this.pendingScheduledRosterSpawns.get(agentId) ?? 0) + 1)
  }
  finishPendingCleanupSpawn(agentId: string): void {
    const count = (this.pendingScheduledRosterSpawns.get(agentId) ?? 1) - 1
    if (count) this.pendingScheduledRosterSpawns.set(agentId, count)
    else this.pendingScheduledRosterSpawns.delete(agentId)
  }
  private handles = new Map<string, PtyHandle>()
  private cleanupRetirements = new CleanupRetirements()
  /** Every sched-* PTY group this daemon spawned, for the harness-gated
   * descendant proof. Never evicted: a killed group must still be proven gone. */
  private scheduledGroups = new ScheduledProcessGroupLedger()

  getScheduledProcessGroups(): ScheduledProcessGroupReport {
    return this.scheduledGroups.report(entry => {
      const handle = this.handles.get(entry.agentId)
      return !!handle && !handle.killed && handle.pid === entry.pid
    })
  }

  /** Complete handle/retirement roster, including handles without PanelMeta. */
  getScheduledCleanupRoster(): Array<{ agentId: string }> {
    return [...new Set([...this.handles.keys(), ...this.panelMetaMap.keys(),
      ...this.pendingScheduledRosterSpawns.keys(), ...this.cleanupRetirements.present()])]
      .map(agentId => ({ agentId }))
  }
  private panelMetaMap = new Map<string, PanelMeta>()
  private nextInstanceId = 1
  private lastErrors = new Map<string, string>()
  private livenessTimer: NodeJS.Timeout | null = null
  /** Mutable WS reference — updated on each daemon reconnect.
   *  PTY callbacks read this instead of capturing a stale WS closure. */
  private currentWs: WebSocket | null = null
  /** Recently-killed agentIds — suppresses repetitive pty.write.no_handle warns for them. */
  private tombstone = new Set<string>()
  private cancelledSpawnAttempts = new Map<string, number>()
  private static readonly SPAWN_CANCEL_TTL_MS = 30 * 60_000
  private static readonly MAX_SPAWN_CANCEL_TOMBSTONES = 2048
  /** Count of write() calls rejected because agentId is tombstoned. */
  public tombstoneRejected = 0
  /** sessionId → agentId map for lock-guard (kill stale resume processes). */
  private sessionIdToAgentId = new Map<string, string>()
  /** Pending resize dimensions received before spawn completes (e.g. during async hook assertion). */
  private pendingResizes = new Map<string, { cols: number; rows: number }>()
  /** Per-panel event-stream token: one random secret per PTY generation, bound
   *  to the panel's stream so a sibling cannot read/ACK another panel's events
   *  even though they share the daemon-wide hook token (Fix 2). */
  private panelEventTokens = new Map<string, string>()
  /** Composition-root hook for releasing state owned by an exact PTY generation. */
  public onGenerationRetired?: (agentId: string, instanceId: number, reason: string) => void

  setCurrentWs(ws: WebSocket): void { this.currentWs = ws }
  getCurrentWs(): WebSocket | null { return this.currentWs }

  /** Start periodic PTY liveness check (default 60s). Catches dead processes
   *  that exited without firing node-pty onExit (e.g. SIGKILL from outside). */
  startLivenessCheck(intervalMs = 60_000): void {
    if (this.livenessTimer) return
    this.livenessTimer = setInterval(() => {
      for (const [agentId, handle] of this.handles.entries()) {
        if (handle.killed) continue
        let alive = false
        try {
          alive = process.kill(handle.pid, 0)
        } catch {
          alive = false
        }
        if (!alive) {
          console.warn('[daemon] pty.liveness.dead', { agentId, pid: handle.pid })
          if (!this.retireGeneration(handle, 'liveness')) continue
          handle.onExit(137, 'SIGKILL')
        }
      }
    }, intervalMs)
    console.log('[daemon] pty.liveness.started', { intervalMs })
  }

  stopLivenessCheck(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
      console.log('[daemon] pty.liveness.stopped')
    }
  }

  spawn(
    agentId:  string,
    agentKey: string,
    binary:   string,
    args:     string[],
    cols:     number,
    rows:     number,
    onData:   (data: string) => void,
    onExit:   (exitCode: number | null, signal: string | null) => void,
    ctx?:     SpawnContext,
    spawnAttemptId?: SpawnAttemptId,
  ): boolean {
    if (this.scheduledRemovals.blocked(agentId)) return false
    if (!agentId || agentId.trim().length === 0 || agentId.length > 256 || /[\x00-\x1F\x7F]/.test(agentId)) {
      console.error('[daemon] pty.spawn.invalid_agent_id', { agentId, agentKey })
      return false
    }
    if (!isSpawnAttemptId(spawnAttemptId) || this.isSpawnAttemptCancelled(agentId, spawnAttemptId)) {
      console.warn('[daemon] pty.spawn.cancelled_or_legacy', { agentId, hasAttempt: isSpawnAttemptId(spawnAttemptId) })
      return false
    }

    const instanceId = this.nextInstanceId++

    // Same logical panel may be re-spawned after reconnect/remount while the old PTY
    // is still registered locally. This happens when a new spawn is processed before
    // a prior kill message reaches the daemon. Replace the old handle in-process
    // instead of surfacing SPAWN_DUPLICATE back to the server.
    const existing = this.handles.get(agentId)
    if (existing && existing.spawnAttemptId === spawnAttemptId) {
      console.warn('[daemon] pty.spawn.exact_generation_conflict', {
        agentId,
        currentSpawnAttemptId: existing.spawnAttemptId,
        requestedSpawnAttemptId: spawnAttemptId,
      })
      return false
    }
    if (existing) {
      // A different generation for the same panel. The daemon has no way to order
      // two spawnAttemptIds on its own — they are UUIDs, and arrival order is the
      // only ordering that exists here; the server is the authority on which
      // generation is current. An incoming attempt that the server already
      // cancelled is refused above, so reaching this point means the server still
      // considers this attempt live. Replace, and tombstone the generation we are
      // retiring so a straggler for it can never come back and clobber the
      // replacement.
      console.warn('[daemon] pty.spawn.replace_existing', {
        agentId,
        oldPid: existing.pid,
        retiredSpawnAttemptId: existing.spawnAttemptId,
        requestedSpawnAttemptId: spawnAttemptId,
        newAgentKey: agentKey,
      })
      const retired = existing.spawnAttemptId
      this.kill(agentId, true)
      this.cancelledSpawnAttempts.set(this.spawnCancelKey(agentId, retired), Date.now() + PtyManager.SPAWN_CANCEL_TTL_MS)
    }

    const pending = this.pendingResizes.get(agentId)
    const effectiveCols = pending !== undefined ? pending.cols : cols
    const effectiveRows = pending !== undefined ? pending.rows : rows
    this.pendingResizes.delete(agentId)

    const clampedCols = Math.max(1, Math.min(500, effectiveCols))
    const clampedRows = Math.max(1, Math.min(500, effectiveRows))

    // ── Env scoping (feature toggle BRIDGE_ENV_WHITELIST) ──
    // Default ON: filter unless explicitly opted out with BRIDGE_ENV_WHITELIST=0.
    const scopingOn = process.env['BRIDGE_ENV_WHITELIST'] !== '0'
    let base: Record<string, string>
    let dropped: string[] = []

    if (scopingOn) {
      const r = filterEnv(process.env, agentKey)
      base = r.env
      dropped = r.dropped
      if (dropped.length) {
        console.debug('[daemon] env.filter', { agentId, droppedCount: dropped.length, dropped })
      }
      if (base.HOME === undefined) {
        console.warn('[daemon] env.filter.no_home', { agentId })
      }
    } else {
      // Shadow mode: compute what WOULD drop, log it, but pass through unfiltered.
      const r = filterEnv(process.env, agentKey)
      if (r.dropped.length) {
        console.debug('[daemon] env.filter.shadow', { agentId, wouldDrop: r.dropped })
      }
      base = { ...(process.env as Record<string, string>) }
    }

    const env: Record<string, string> = {
      ...base,
      TERM:      'xterm-256color',
      COLORTERM: 'truecolor',
    }

    // User/project escape hatch first (adds tooling vars; must NOT win over identity).
    if (ctx?.projectEnv) Object.assign(env, ctx.projectEnv)

    // Merge agent-specific env vars from AgentSpec (e.g. opencode OPENCODE_CONFIG_CONTENT)
    const spec = AGENT_SPECS.find(s => s.key === agentKey)
    if (spec?.env) Object.assign(env, spec.env)

    // Per-agent env from SpawnContext (e.g. Kimi KIMI_CODE_HOME). Applied after spec.env
    // but before BRIDGE_ identity — agent env must not clobber the daemon's identity.
    if (ctx?.agentEnv) Object.assign(env, ctx.agentEnv)

    // Registry-owned provider configuration is applied after all inherited and
    // caller-provided env so it is both authoritative and target-isolated.
    applyHookTargetSpawnEnv(agentKey, env)

    // ── BRIDGE_ identity asserted LAST: nothing can clobber it. ──
    if (ctx) {
      env['BRIDGE_SERVER_URL']   = ctx.serverUrl
      env['BRIDGE_TOKEN']        = ctx.token
      env['BRIDGE_WORKSPACE_ID'] = ctx.workspaceId
      env['BRIDGE_PROJECT_ID']   = ctx.projectId || ''
    }
    Object.assign(env, getHookEnvPairs(agentId, instanceId))
    // Fix 2: per-panel event token — one random secret per PTY generation so a
    // sibling cannot poll/ACK another panel's stream with the shared hook token.
    const eventToken = randomBytes(32).toString('hex')
    this.panelEventTokens.set(`${encodeURIComponent(agentId)}#${instanceId}`, eventToken)
    env[EVENT_TOKEN_ENV_VAR] = eventToken
    // BRIDGE_MCP_URL — deterministic; projectEnv cannot define or override it.
    const bridgeMcpUrl = process.env['BRIDGE_MCP_URL']
    if (bridgeMcpUrl) {
      env['BRIDGE_MCP_URL'] = bridgeMcpUrl
    } else {
      delete env['BRIDGE_MCP_URL']
    }

    const spawnOpts = {
      name: 'xterm-256color',
      cols: clampedCols,
      rows: clampedRows,
      cwd:  ctx?.cwd,
      env,
    }

    let proc: pty.IPty
    // Final synchronous compare immediately before handle creation. No await
    // exists between this check, pty.spawn, and publishing the handle.
    if (this.isSpawnAttemptCancelled(agentId, spawnAttemptId)) return false
    try {
      proc = pty.spawn(binary, args, spawnOpts)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.lastErrors.set(agentId, msg)
      console.error('[daemon] pty.spawn.failed', { agentId, agentKey, error: msg })
      return false
    }

    const handle: PtyHandle = {
      agentId,
      spawnAttemptId,
      agentKey,
      process: proc,
      pid: proc.pid,
      killed: false,
      instanceId,
      onExit,
      cwd: ctx?.cwd,
      spawnEnv: { ...env },
    }

    proc.onData(data => {
      const current = this.handles.get(agentId)
      if (!current || current.instanceId !== instanceId || handle.killed) return
      onData(Buffer.from(data).toString('base64'))
    })

    proc.onExit(({ exitCode, signal }) => {
      const current = this.handles.get(agentId)
      if (!current || current.instanceId !== instanceId || handle.killed) return
      if (!this.retireGeneration(handle, 'exit')) return
      console.log('[daemon] pty.exit', { agentId, exitCode, signal })
      onExit(exitCode ?? null, signal ? String(signal) : null)
    })

    this.lastErrors.delete(agentId)
    this.handles.set(agentId, handle)
    // Recorded in the same synchronous step that publishes the handle, so no
    // scheduled group can exist without appearing in the proof ledger.
    this.scheduledGroups.record(agentId, spawnAttemptId, proc.pid)

    // ── Persist spawn manifest entry (Phase8: PGID-based orphan reaping) ──
    try {
      const manifestPath = getSpawnManifestPath()
      mkdirSync(path.dirname(manifestPath), { recursive: true })
      // node-pty child IS its own session leader: pid == pgid.
      // Node has no process.getpgid API — using pid as the group id is correct.
      const pgid = proc.pid

      // Read existing entries (if any), append new one, write atomically.
      let entries: ManifestEntry[] = []
      if (existsSync(manifestPath)) {
        try {
          const raw = readFileSync(manifestPath, 'utf8')
          if (raw.trim()) entries = JSON.parse(raw)
          if (!Array.isArray(entries)) entries = []
        } catch { entries = [] }
      }
      entries.push({
        agentId, agentKey,
        pid: proc.pid,
        pgid,
        startedAt: Date.now(),
        daemonPid: process.pid,
      })

      const tmp = manifestPath + '.tmp'
      writeFileSync(tmp, JSON.stringify(entries), 'utf-8')
      renameSync(tmp, manifestPath)
    } catch {
      // Best effort — never block spawn on manifest errors
    }

    console.log('[daemon] pty.spawn.success', { agentId, agentKey, argCount: args.length, cwd: ctx?.cwd })
    return true
  }

  /** Same effective filtered environment used for the current PTY instance.
   * Values must never be logged or relayed. */
  getPanelSpawnEnvironment(agentId: string): Record<string, string> | undefined {
    const env = this.handles.get(agentId)?.spawnEnv
    return env ? { ...env } : undefined
  }

  write(agentId: string, data: string, source?: string, opts?: { raw?: boolean }): boolean {
    const handle = this.handles.get(agentId)
    if (!handle) {
      if (this.tombstone.has(agentId)) {
        this.tombstoneRejected++
        return false
      }
      console.warn('[daemon] pty.write.no_handle', { agentId: agentId.slice(-8), source, dataLength: data.length })
      return false
    }
    const decoded = Buffer.from(data, 'base64').toString()
    // Only apply agent-specific formatInput for orchestrator injections.
    // User keystrokes from xterm already carry the correct terminators —
    // appending \n/\r to every character would submit each keystroke immediately.
    // The `raw` option skips formatInput entirely — used by the TUI idle-gated
    // submit path so the text write carries no trailing \r (the standalone \r
    // after TUI_SUBMIT_DELAY_MS is the sole submit action).
    const spec = AGENT_SPECS.find(s => s.key === handle.agentKey)
    const formatted = (source === 'orchestrator' && spec?.formatInput && !opts?.raw)
      ? spec.formatInput(decoded)
      : decoded
    handle.process.write(formatted)
    return true
  }

  kill(agentId: string, force: boolean = false): void {
    const handle = this.handles.get(agentId)
    if (!handle) return
    handle.killed = true
    if (agentId.startsWith('sched-')) this.cleanupRetirements.record(agentId, handle.pid)
    if (!this.retireGeneration(handle, 'kill')) return
    this.pendingResizes.delete(agentId)
    // Tombstone: suppress repetitive pty.write.no_handle warns for recently-killed agents
    this.tombstone.add(agentId)
    const pid = handle.pid
    // SIGKILL escalation applies to BOTH paths. A non-force kill used to send only
    // SIGTERM, so any agent that traps or ignores it survived forever — and because
    // the handle is already out of `this.handles` above, nothing could ever kill it
    // again. That orphan keeps the pty slave open for the life of the daemon.
    try { process.kill(-pid, 'SIGTERM') } catch { handle.process.kill() }
    // unref: a pending escalation must never be the reason the daemon takes an
    // extra two seconds to shut down.
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL') } catch { /* already dead */ }
    }, force ? 2000 : GRACEFUL_KILL_GRACE_MS).unref?.()

    // Release the pty master. node-pty only closes it from its own exit path, which
    // this kill deliberately bypasses (handle.killed short-circuits our callbacks and
    // we signal the process group directly), so without this the fd stays open for
    // the life of the daemon. Measured: 2 leaked /dev/ptmx fds per killed panel
    // without it, 1 with it — see disposePty for the residual one.
    disposePty(handle.process, agentId)

    // Notify server of exit. proc.onExit is guarded by handle.killed (which is now true)
    // so the real process exit skips the callback — we must fire it explicitly.
    handle.onExit(null, 'SIGTERM')
    console.log('[daemon] pty.kill', { agentId, force })
  }

  private spawnCancelKey(agentId: string, spawnAttemptId: SpawnAttemptId): string {
    return `${agentId}\0${spawnAttemptId}`
  }

  private sweepSpawnCancelTombstones(now = Date.now()): void {
    for (const [key, expiresAt] of this.cancelledSpawnAttempts) {
      if (expiresAt <= now) this.cancelledSpawnAttempts.delete(key)
    }
    while (this.cancelledSpawnAttempts.size > PtyManager.MAX_SPAWN_CANCEL_TOMBSTONES) {
      const oldest = this.cancelledSpawnAttempts.keys().next().value as string | undefined
      if (!oldest) break
      this.cancelledSpawnAttempts.delete(oldest)
    }
  }

  isSpawnAttemptCancelled(agentId: string, spawnAttemptId: SpawnAttemptId): boolean {
    this.sweepSpawnCancelTombstones()
    return (this.cancelledSpawnAttempts.get(this.spawnCancelKey(agentId, spawnAttemptId)) ?? 0) > Date.now()
  }

  /** Parse-time exact-generation cancellation. A matching live handle is
   * detached and signalled once; a different generation is never touched. */
  cancelSpawnAttempt(
    agentId: string,
    spawnAttemptId: SpawnAttemptId,
    force = true,
  ): 'prevented' | 'killed' | 'already_cancelled' {
    if (!isSpawnAttemptId(spawnAttemptId)) return 'already_cancelled'
    const key = this.spawnCancelKey(agentId, spawnAttemptId)
    this.sweepSpawnCancelTombstones()
    if (this.cancelledSpawnAttempts.has(key)) return 'already_cancelled'
    this.cancelledSpawnAttempts.set(key, Date.now() + PtyManager.SPAWN_CANCEL_TTL_MS)

    const handle = this.handles.get(agentId)
    if (!handle || handle.spawnAttemptId !== spawnAttemptId) {
      const meta = this.panelMetaMap.get(agentId)
      if (meta?.spawnAttemptId === spawnAttemptId) this.panelMetaMap.delete(agentId)
      return 'prevented'
    }

    handle.killed = true
    if (agentId.startsWith('sched-')) this.cleanupRetirements.record(agentId, handle.pid)
    if (!this.retireGeneration(handle, 'spawn_cancel')) return 'prevented'
    this.pendingResizes.delete(agentId)
    this.tombstone.add(agentId)
    const pid = handle.pid
    if (force) {
      try { process.kill(-pid, 'SIGTERM') } catch { handle.process.kill() }
      setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL') } catch { /* already dead */ }
      }, 2000)
    } else {
      try { process.kill(-pid, 'SIGTERM') } catch { handle.process.kill() }
    }
    handle.onExit(null, 'SIGTERM')
    console.log('[daemon] pty.spawn_cancel', { agentId, spawnAttemptId, force })
    return 'killed'
  }

  /**
   * Permanently retire one exact PTY generation and all generation-owned state.
   * The live-handle identity check makes repeated/stale retirement idempotent.
   * External cleanup is isolated so it can never break the PTY lifecycle path.
   */
  private retireGeneration(handle: PtyHandle, reason: string): boolean {
    const current = this.handles.get(handle.agentId)
    if (!current || current.instanceId !== handle.instanceId) return false

    if (handle.reissueTimer) {
      clearTimeout(handle.reissueTimer)
      handle.reissueTimer = null
    }
    this.panelEventTokens.delete(`${encodeURIComponent(handle.agentId)}#${handle.instanceId}`)
    this.handles.delete(handle.agentId)
    this.clearPanelMeta(handle.agentId, handle.spawnAttemptId)
    this.unregisterSessionId(handle.agentId)

    try {
      this.onGenerationRetired?.(handle.agentId, handle.instanceId, reason)
    } catch (err) {
      console.warn('[daemon] pty.generation_retirement.failed', {
        agentId: handle.agentId,
        instanceId: handle.instanceId,
        reason,
        error: String(err),
      })
    }
    return true
  }

  resize(agentId: string, cols: number, rows: number): { cols: number; rows: number } | null {
    const clampedCols = Math.max(1, Math.min(500, cols))
    const clampedRows = Math.max(1, Math.min(500, rows))
    const handle = this.handles.get(agentId)
    if (!handle) {
      this.pendingResizes.set(agentId, { cols: clampedCols, rows: clampedRows })
      return { cols: clampedCols, rows: clampedRows }
    }
    if (handle.reissueTimer) {
      clearTimeout(handle.reissueTimer)
      handle.reissueTimer = null
    }
    handle.process.resize(clampedCols, clampedRows)
    // ioctl(TIOCSWINSZ) only sends SIGWINCH when dimensions change. Explicitly
    // signaling the process group ensures TUI agents (copilot, codex) always
    // redraw — including force-redraw calls that send unchanged dimensions.
    try { process.kill(-handle.process.pid, 'SIGWINCH') } catch {}
    logLifecycle('pty.sigwinch.sent', { agentId, agentKey: handle.agentKey, cols: clampedCols, rows: clampedRows })
    // TUI agents (kimi, copilot, codex) use differential rendering that may
    // miss the initial SIGWINCH if there's a winsize read race. Re-issue
    // after 80ms to ensure pi-tui's widthChanged fires correctly on shrink.
    // OpenCode Caveat: opencode is excluded because its PTY wrapper handles resize events natively without needing an 80ms reissue delay.
    if (handle.agentKey === 'kimi' || handle.agentKey === 'copilot' || handle.agentKey === 'codex') {
      const targetInstanceId = handle.instanceId
      handle.reissueTimer = setTimeout(() => {
        const h = this.handles.get(agentId)
        if (!h || h.killed || h.instanceId !== targetInstanceId) return
        h.reissueTimer = null
        try { h.process.resize(clampedCols, clampedRows) } catch {}
        try { process.kill(-h.process.pid, 'SIGWINCH') } catch {}
        logLifecycle('pty.sigwinch.sent.reissue', { agentId, agentKey: h.agentKey, cols: clampedCols, rows: clampedRows })
      }, 80)
    }
    return { cols: clampedCols, rows: clampedRows }
  }

  getLastError(agentId: string): string | undefined {
    return this.lastErrors.get(agentId)
  }

  killAll(): void {
    // ── Clear spawn manifest (Phase9: next daemon won't try to reap already-killed agents) ──
    try { writeFileSync(getSpawnManifestPath(), '', 'utf-8') } catch { /* best effort */ }

    for (const handle of this.handles.values()) {
      if (handle.reissueTimer) {
        clearTimeout(handle.reissueTimer)
        handle.reissueTimer = null
      }
      try { process.kill(-handle.pid, 'SIGTERM') } catch { handle.process.kill() }
    }
    this.handles.clear()
    this.panelMetaMap.clear()
    this.pendingResizes.clear()
    this.sessionIdToAgentId.clear()
    logLifecycle('lifecycle.killAll.complete', { component: 'daemon' })
  }

  /** Single source of truth for live handles */
  private getLiveHandles(): PtyHandle[] {
    return Array.from(this.handles.values()).filter(h => !h.killed)
  }

  /** Return IDs of all currently live PTY handles */
  getLiveAgentIds(): string[] {
    return this.getLiveHandles().map(h => h.agentId)
  }

  /** Cache panel metadata from the inbound spawn message. */
  setPanelMeta(agentId: string, meta: PanelMeta): void {
    this.panelMetaMap.set(agentId, meta)
  }

  /** Clear panel metadata (e.g. on spawn failure). */
  clearPanelMeta(agentId: string, spawnAttemptId?: SpawnAttemptId): void {
    const current = this.panelMetaMap.get(agentId)
    if (!spawnAttemptId || current?.spawnAttemptId === spawnAttemptId) this.panelMetaMap.delete(agentId)
  }

  /** Retain the settled MCP-configured verdict onto the cached spawn metadata
   *  (Issue #617), so a `daemon_resync` after reconnect or server restart
   *  restores it instead of the roster silently going back to unknown/false.
   *  Callers must only invoke this once `mcpConfigured` has settled past all
   *  async spawn-time resolution (e.g. agy's config-write await) — attaching
   *  it earlier publishes a placeholder value forever. Guarded by
   *  spawnAttemptId so a superseded spawn can never patch a newer one's meta. */
  setPanelMcpConfigured(agentId: string, spawnAttemptId: SpawnAttemptId, mcpConfigured: boolean): void {
    const current = this.panelMetaMap.get(agentId)
    if (current?.spawnAttemptId === spawnAttemptId) current.mcpConfigured = mcpConfigured
  }

  /** Return metadata for all currently live panels. */
  getLivePanels(): PanelMeta[] {
    const result: PanelMeta[] = []
    for (const handle of this.getLiveHandles()) {
      const meta = this.panelMetaMap.get(handle.agentId)
      if (meta) result.push({
        ...meta,
        panelInstanceId: handle.instanceId,
        startupGate: handle.startupGate ?? null,
        startupGatePanelInstanceId: handle.instanceId,
      })
    }
    return result
  }

  private coldPanelHookState(handle: PtyHandle): { configState: import('@jerico/shared').PanelHookConfigState; hookInstallRefused?: import('@jerico/shared').HookInstallRefusal } {
    const hookInstallRefused = getHookInstallRefusal(handle.agentKey)
    return {
      configState: getHookConfig(handle.agentKey),
      ...(hookInstallRefused ? { hookInstallRefused } : {})
    }
  }

  emitPanelHookState(agentId: string): void {
    const handle = this.handles.get(agentId)
    const ws = this.currentWs
    if (!handle || !ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'panel_hook_state',
      agentId: handle.agentId,
      panelInstanceId: handle.instanceId,
      ...this.coldPanelHookState(handle)
    } satisfies import('../shared/types.js').ServerMessage))
  }

  emitAllPanelHookStates(): void {
    for (const handle of this.getLiveHandles()) this.emitPanelHookState(handle.agentId)
  }

  setPanelStartupGateState(agentId: string, state: import('@jerico/shared').PanelStartupGateState): void {
    const handle = this.handles.get(agentId)
    if (!handle) return
    handle.startupGate = state
    this.emitPanelStartupGateState(agentId)
  }

  emitPanelStartupGateState(agentId: string): void {
    const handle = this.handles.get(agentId)
    const ws = this.currentWs
    if (!handle?.startupGate || !ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'panel_startup_gate_state',
      agentId: handle.agentId,
      panelInstanceId: handle.instanceId,
      state: handle.startupGate,
    } satisfies import('../shared/types.js').ServerMessage))
  }

  emitAllPanelStartupGateStates(): void {
    for (const handle of this.getLiveHandles()) {
      if (handle.startupGate) this.emitPanelStartupGateState(handle.agentId)
    }
  }

  /**
   * Whether a missing startup gate means "not watched" or "not yet reported".
   *
   * `startupGate` is absent for two unrelated reasons: the daemon does not watch
   * one for this agent — a shell has no startup to gate — or it does and has not
   * reported yet. A reader that cannot tell them apart has to call both unknown,
   * which is how every project holding a shell panel grew a permanent
   * un-actionable "gate unknown".
   *
   * This rides on the /health PANEL entry, deliberately not inside
   * `PanelStartupGateState`: the server rejects a gate state carrying any key
   * outside `STARTUP_GATE_STATE_KEYS` (relay.ts) — and rejects the WHOLE state,
   * not the stray field — so a new key in there would delete real blocked gates
   * on any daemon/server version skew. Nothing but the desktop reads this
   * endpoint, so a field here costs no validator anywhere.
   */
  private startupGateSupport(handle: PtyHandle): 'monitored' | 'not_applicable' {
    return isTuiStartupMonitored(handle.agentKey) ? 'monitored' : 'not_applicable'
  }

  getLivePanelsReport(): { agentId: string; agentKey: string; cwd?: string; usagePct?: number; startupGate?: import('@jerico/shared').PanelStartupGateState; startupGateSupport: 'monitored' | 'not_applicable'; hook: { configState: import('@jerico/shared').PanelHookConfigState; hookInstallRefused?: import('@jerico/shared').HookInstallRefusal } }[] {
    return this.getLiveHandles().map(handle => ({
      agentId: handle.agentId,
      agentKey: handle.agentKey,
      ...(handle.cwd !== undefined ? { cwd: handle.cwd } : {}),
      ...(handle.usagePct !== undefined ? { usagePct: handle.usagePct } : {}),
      ...(handle.startupGate !== undefined ? { startupGate: handle.startupGate } : {}),
      startupGateSupport: this.startupGateSupport(handle),
      hook: this.coldPanelHookState(handle)
    }))
  }

  setUsagePct(agentId: string, pct: number): void {
    const handle = this.handles.get(agentId)
    if (handle) {
      handle.usagePct = pct
    }
  }

  /** Return the agentKey for a live PTY handle, or undefined if not found */
  getAgentKey(agentId: string): string | undefined {
    return this.handles.get(agentId)?.agentKey
  }

  /** Return the immutable process-instance id for a live PTY handle. */
  getPanelInstanceId(agentId: string): number | undefined {
    return this.handles.get(agentId)?.instanceId
  }

  getSpawnAttemptId(agentId: string): SpawnAttemptId | undefined {
    return this.handles.get(agentId)?.spawnAttemptId
  }

  /** Used by the hook receiver to find the target handle. Must match instance exactly. */
  getLiveHookTarget(agentId: string, instanceId: number): { agentId: string; agentKey: string; instanceId: number } | null {
    const handle = this.handles.get(agentId)
    if (!handle || handle.killed || handle.instanceId !== instanceId) return null
    return { agentId: handle.agentId, agentKey: handle.agentKey, instanceId: handle.instanceId }
  }

  /** Per-panel event token for Fix 2. Scoped to generation; null if never spawned. */
  getPanelEventToken(agentId: string, instanceId: number): string | undefined {
    return this.panelEventTokens.get(`${encodeURIComponent(agentId)}#${instanceId}`)
  }

  pause(agentId: string): void {
    const h = this.handles.get(agentId)
    if (h && !h.killed) h.process.pause()
  }

  resume(agentId: string): void {
    const h = this.handles.get(agentId)
    if (h && !h.killed) h.process.resume()
  }

  /** Kill any existing process registered for sessionId (stale dual-spawn lock guard). */
  killBySessionId(sessionId: string): boolean {
    const agentId = this.sessionIdToAgentId.get(sessionId)
    if (agentId && this.handles.has(agentId)) {
      console.log('[daemon] pty.kill_by_session', { sessionId, existingAgentId: agentId })
      this.kill(agentId, true)
      this.sessionIdToAgentId.delete(sessionId)
      return true
    }
    return false
  }

  /** Register sessionId → agentId mapping for lock-guard bookkeeping. */
  registerSessionId(agentId: string, sessionId: string): void {
    this.sessionIdToAgentId.set(sessionId, agentId)
  }

  /** Remove sessionId mapping for agentId. */
  unregisterSessionId(agentId: string): void {
    for (const [sid, aid] of this.sessionIdToAgentId) {
      if (aid === agentId) {
        this.sessionIdToAgentId.delete(sid)
        return
      }
    }
  }
}
