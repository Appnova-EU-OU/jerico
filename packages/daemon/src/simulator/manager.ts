import WebSocket from 'ws'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { readFile, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { isSpawnAttemptId, type PanelMeta, type SimHealthCheck, type SpawnAttemptId } from '../shared/types.js'
import type { BridgeConfig } from '../config.js'
import { runFullHealthChecks } from './health.js'
import { emitSpawnTerminal, type SpawnTerminalFailure } from '../ws/spawn-terminal.js'

const IDB_PATH = path.join(os.homedir(), '.local/bin/idb')

const SIM_INSTALL_CACHE_PATH = path.join(os.homedir(), '.bridge/install-sim-prereqs.sh')
const SIM_INSTALL_ETAG_PATH = path.join(os.homedir(), '.bridge/install-sim-prereqs.sh.etag')
const FETCH_TIMEOUT_MS = 10_000

function simulatorHealthFailureMessage(check: SimHealthCheck): string {
  const label = check.label.slice(0, 80)
  const detail = check.detail?.slice(0, 240)
  const fixCmd = check.fixCmd?.slice(0, 150)
  return [
    `Simulator health check failed: ${label}`,
    detail,
    fixCmd ? `Fix: ${fixCmd}` : undefined,
  ].filter((part): part is string => Boolean(part)).join('; ')
}

function shutdownDaemonBootedSimulator(udid: string): void {
  spawn('xcrun', ['simctl', 'shutdown', udid], { stdio: 'ignore' })
    .on('error', (err) => console.warn('[daemon] simulator.shutdown.error', { udid, err: String(err) }))
}

type SimClientMessage =
  | { type: 'sim_tap'; agentId: string; daemonId: string; x: number; y: number }
  | { type: 'sim_swipe'; agentId: string; daemonId: string; x1: number; y1: number; x2: number; y2: number; duration?: number }
  | { type: 'sim_key'; agentId: string; daemonId: string; key: string }
  | { type: 'sim_button'; agentId: string; daemonId: string; button: 'HOME' | 'LOCK' | 'SIDE_BUTTON' | 'SIRI' | 'APPLE_PAY' }
  | { type: 'sim_get_source'; agentId: string; daemonId: string }
  | { type: 'sim_subscribe'; agentId: string; daemonId: string; spawnAttemptId: SpawnAttemptId }
  | { type: 'sim_unsubscribe'; agentId: string; daemonId: string; spawnAttemptId: SpawnAttemptId }
  | { type: 'sim_healthcheck'; agentId: string; daemonId: string }
  | { type: 'sim_install_run'; agentId: string; daemonId: string; spawnAttemptId: SpawnAttemptId }
  | { type: 'sim_install_cancel'; agentId: string; daemonId: string; spawnAttemptId: SpawnAttemptId }

type SimInstallStep = 'pre_check' | 'xcode_install' | 'brew_check' | 'idb_install' | 'sim_boot' | 'done' | 'error'

interface SimSession {
  agentId: string
  spawnAttemptId: SpawnAttemptId
  udid: string
  frameInterval: ReturnType<typeof setInterval> | null
  capturing: boolean
  subscribed: boolean
  logicalWidth?: number
  logicalHeight?: number
  lastDescribeAt: number
  daemonBooted: boolean
}

interface ExactSimulatorOwner {
  agentId: string
  spawnAttemptId: SpawnAttemptId
}

interface ExactBootOwner {
  udid: string
  spawnAttemptId: SpawnAttemptId
}

interface ExactInstallProcess {
  process: ChildProcess
  spawnAttemptId: SpawnAttemptId
}

async function querySimMetadata(udid: string): Promise<{ width?: number; height?: number }> {
  try {
    const info = await new Promise<string>((resolve, reject) => {
      const proc = spawn(IDB_PATH, ['describe', '--udid', udid, '--json'], { timeout: 10000 })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `idb exited ${code}`))
        else resolve(stdout)
      })
      proc.on('error', (err) => reject(err))
    })
    const parsed = JSON.parse(info) as {
      screen_dimensions?: { width_points?: number; height_points?: number }
    }
    const w = parsed.screen_dimensions?.width_points
    const h = parsed.screen_dimensions?.height_points
    if (Number.isFinite(w) && Number.isFinite(h)) {
      return { width: w, height: h }
    }
  } catch (err) {
    console.warn('[daemon] simulator.metadata.error', { udid, error: String(err) })
  }
  return {}
}

/** Binary frame header layout (issue #376):
 *  [u8 agentIdLen] [agentId UTF-8 bytes] [u16 width BE] [u16 height BE] [JPEG payload]
 *  Total header: 1 + agentId.length + 4 = ~41 bytes for UUID agent IDs.
 */
function buildFrameHeader(agentId: string, width: number, height: number): Buffer {
  const agentIdBytes = Buffer.from(agentId, 'utf-8')
  const header = Buffer.allocUnsafe(1 + agentIdBytes.length + 4)
  header.writeUInt8(agentIdBytes.length, 0)
  agentIdBytes.copy(header, 1)
  header.writeUInt16BE(Math.max(0, Math.min(65535, width)), 1 + agentIdBytes.length)
  header.writeUInt16BE(Math.max(0, Math.min(65535, height)), 1 + agentIdBytes.length + 2)
  return header
}

/** Parse a binary frame back into { agentId, width, height, data }. */
export function parseBinaryFrame(buf: Buffer): { agentId: string; width: number; height: number; data: Buffer } | null {
  if (buf.length < 6) return null
  const agentIdLen = buf.readUInt8(0)
  if (buf.length < 1 + agentIdLen + 4) return null
  const agentId = buf.toString('utf-8', 1, 1 + agentIdLen)
  const width   = buf.readUInt16BE(1 + agentIdLen)
  const height  = buf.readUInt16BE(1 + agentIdLen + 2)
  const data    = buf.subarray(1 + agentIdLen + 4)
  return { agentId, width, height, data }
}

/**
 * Capture a single simulator frame as JPEG.
 * Uses xcrun simctl screenshot (PNG) then converts to JPEG via sips (native macOS).
 * Falls back to PNG if the conversion fails.
 */
function captureFrame(udid: string, agentId: string): Promise<Buffer | null> {
  const pngFile = `/tmp/sim_frame_${agentId}.png`
  const jpgFile = `/tmp/sim_frame_${agentId}.jpg`
  return new Promise((resolve) => {
    const proc = spawn('xcrun', ['simctl', 'io', udid, 'screenshot', pngFile], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    proc.on('close', async (code) => {
      if (code !== 0) { resolve(null); return }
      try {
        // Convert PNG → JPEG using sips (native macOS, no external dependencies)
        await new Promise<void>((res, rej) => {
          const sips = spawn('sips', ['-s', 'format', 'jpeg', pngFile, '--out', jpgFile], {
            stdio: ['ignore', 'ignore', 'ignore'],
          })
          sips.on('close', (c) => c === 0 ? res() : rej(new Error(`sips exited ${c}`)))
          sips.on('error', (err) => rej(err))
        })
        resolve(await readFile(jpgFile))
      } catch {
        // Fallback to PNG if sips conversion fails
        try { resolve(await readFile(pngFile)) } catch { resolve(null) }
      }
    })
    proc.on('error', () => resolve(null))
  })
}

/** Encode a sim_frame as a binary WebSocket frame.
 *  Layout: [1B type=0x00][2B agentIdLen BE][agentId UTF-8][4B width f32 BE][4B height f32 BE][JPEG bytes]
 *  Returns null if agentId is too long (> 65535 bytes). */
function encodeSimFrame(agentId: string, imageData: Buffer, width?: number, height?: number): Buffer | null {
  const agentIdBytes = Buffer.from(agentId, 'utf-8')
  if (agentIdBytes.length > 65535) {
    console.warn('[daemon] encodeSimFrame: agentId too long', { length: agentIdBytes.length })
    return null
  }
  const header = Buffer.allocUnsafe(11 + agentIdBytes.length)
  header[0] = 0x00  // frame type: sim_frame
  header.writeUInt16BE(agentIdBytes.length, 1)
  agentIdBytes.copy(header, 3)
  header.writeFloatBE(width ?? 0, 3 + agentIdBytes.length)
  header.writeFloatBE(height ?? 0, 7 + agentIdBytes.length)
  return Buffer.concat([header, imageData])
}

function idbCommand(udid: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(IDB_PATH, [...args, '--udid', udid], { timeout: 15000 })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `idb exited ${code}`))
      } else {
        resolve()
      }
    })
    proc.on('error', (err) => reject(err))
  })
}

export class SimulatorManager {
  private sessions = new Map<string, SimSession>()
  private pendingSubscriptions = new Map<string, SpawnAttemptId>()
  private pendingUdids = new Map<string, { agentId: string; spawnAttemptId: SpawnAttemptId }>()
  private pendingDaemonBootedUdids = new Map<string, ExactSimulatorOwner>()
  private bootedUdidsByAgent = new Map<string, ExactBootOwner>()
  private ws: WebSocket | null = null
  private daemonId: string
  private config: BridgeConfig | null
  private installProc = new Map<string, ExactInstallProcess>()
  // Ownership begins before script resolution so an exact cancel can fence an
  // in-flight await before a child process exists.
  private installRunOwners = new Map<string, SpawnAttemptId>()
  private cancelledInstalls = new Set<string>()
  private cancelledSpawnAttempts = new Map<string, number>()
  private static readonly SPAWN_CANCEL_TTL_MS = 30 * 60_000
  private static readonly MAX_SPAWN_CANCEL_TOMBSTONES = 2_048

  constructor(
    daemonId: string,
    config?: BridgeConfig,
    private readonly runHealthChecks: typeof runFullHealthChecks = runFullHealthChecks,
    private readonly shutdownBootedSimulator: (udid: string) => void = shutdownDaemonBootedSimulator,
    private readonly queryMetadata: typeof querySimMetadata = querySimMetadata,
  ) {
    this.daemonId = daemonId
    this.config = config ?? null
  }

  updateWs(ws: WebSocket): void {
    this.ws = ws
  }

  private spawnCancelKey(agentId: string, spawnAttemptId: SpawnAttemptId): string {
    return `${agentId}\0${spawnAttemptId}`
  }

  private ownsInstallGeneration(agentId: string, spawnAttemptId: SpawnAttemptId): boolean {
    return this.installRunOwners.get(agentId) === spawnAttemptId
      && !this.isSpawnAttemptCancelled(agentId, spawnAttemptId)
  }

  private sweepSpawnCancelTombstones(now = Date.now()): void {
    for (const [key, expiresAt] of this.cancelledSpawnAttempts) {
      if (expiresAt <= now) this.cancelledSpawnAttempts.delete(key)
    }
    while (this.cancelledSpawnAttempts.size > SimulatorManager.MAX_SPAWN_CANCEL_TOMBSTONES) {
      const oldest = this.cancelledSpawnAttempts.keys().next().value as string | undefined
      if (!oldest) break
      this.cancelledSpawnAttempts.delete(oldest)
    }
  }

  isSpawnAttemptCancelled(agentId: string, spawnAttemptId: SpawnAttemptId): boolean {
    this.sweepSpawnCancelTombstones()
    return (this.cancelledSpawnAttempts.get(this.spawnCancelKey(agentId, spawnAttemptId)) ?? 0) > Date.now()
  }

  cancelSpawnAttempt(agentId: string, spawnAttemptId: SpawnAttemptId): 'prevented' | 'killed' | 'already_cancelled' {
    if (!isSpawnAttemptId(spawnAttemptId)) return 'already_cancelled'
    const key = this.spawnCancelKey(agentId, spawnAttemptId)
    this.sweepSpawnCancelTombstones()
    if (this.cancelledSpawnAttempts.has(key)) return 'already_cancelled'
    this.cancelledSpawnAttempts.set(key, Date.now() + SimulatorManager.SPAWN_CANCEL_TTL_MS)
    const session = this.sessions.get(agentId)
    if (!session || session.spawnAttemptId !== spawnAttemptId) {
      this.cleanupSpawnResidue(agentId, spawnAttemptId)
      return 'prevented'
    }
    this.stop(agentId, spawnAttemptId)
    return 'killed'
  }

  getLivePanels(): PanelMeta[] {
    return [...this.sessions.values()].map(session => ({
      agentId: session.agentId,
      spawnAttemptId: session.spawnAttemptId,
      agentKey: 'sim_ios',
    }))
  }

  async start(agentId: string, spawnAttemptId: SpawnAttemptId): Promise<void> {
    if (!isSpawnAttemptId(spawnAttemptId)) return
    if (this.isSpawnAttemptCancelled(agentId, spawnAttemptId)) {
      this.cleanupSpawnResidue(agentId, spawnAttemptId)
      return
    }
    const currentSession = this.sessions.get(agentId)
    if (currentSession) {
      if (currentSession.spawnAttemptId === spawnAttemptId) {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'agent_spawned', agentId, spawnAttemptId, agentKey: 'sim_ios', daemonId: this.daemonId }))
        }
      } else {
        this.failSpawn(agentId, spawnAttemptId, {
          code: 'SPAWN_FAILED', message: 'Simulator panel already has a live generation',
        })
      }
      return
    }

    const { checks, udid } = await this.runHealthChecks(agentId)
    if (this.isSpawnAttemptCancelled(agentId, spawnAttemptId)) {
      this.cleanupSpawnResidue(agentId, spawnAttemptId)
      return
    }

    // Send health immediately so browser can render the panel
    this.sendSimHealth(agentId, checks)

    const blockingFail = checks.find(c => c.status === 'fail')
    if (blockingFail) {
      this.failSpawn(agentId, spawnAttemptId, {
        code: 'SPAWN_FAILED', message: simulatorHealthFailureMessage(blockingFail),
      })
      return
    }

    if (!udid) {
      this.failSpawn(agentId, spawnAttemptId, { code: 'SPAWN_FAILED', message: 'No booted iOS simulator found' })
      return
    }

    // UDID dedup: reject if this UDID already has an active session or is mid-spawn
    const existingSession = [...this.sessions.values()].find(s => s.udid === udid)
    if (existingSession) {
      this.failSpawn(agentId, spawnAttemptId, { code: 'DUPLICATE_SIMULATOR', message: `Simulator already attached as agent ${existingSession.agentId}`,
        existingAgentId: existingSession.agentId,
        udid,
      })
      return
    }
    const pending = this.pendingUdids.get(udid)
    if (pending && (pending.agentId !== agentId || pending.spawnAttemptId !== spawnAttemptId)) {
      this.failSpawn(agentId, spawnAttemptId, { code: 'DUPLICATE_SIMULATOR', message: `Simulator already being attached as agent ${pending.agentId}`,
        existingAgentId: pending.agentId,
        udid,
      })
      return
    }
    this.pendingUdids.set(udid, { agentId, spawnAttemptId })

    const subscribed = this.pendingSubscriptions.get(agentId) === spawnAttemptId

    // Query idb for the simulator's logical viewport size (points, not pixels)
    const meta = await this.queryMetadata(udid)
    if (this.isSpawnAttemptCancelled(agentId, spawnAttemptId)) {
      this.cleanupSpawnResidue(agentId, spawnAttemptId)
      return
    }
    if (meta.width != null && meta.height != null) {
      console.log('[daemon] simulator.metadata', { agentId, udid, logicalWidth: meta.width, logicalHeight: meta.height })
    }

    const bootOwner = this.bootedUdidsByAgent.get(agentId)
    const pendingBootOwner = this.pendingDaemonBootedUdids.get(udid)
    const daemonBooted = bootOwner?.udid === udid
      && bootOwner.spawnAttemptId === spawnAttemptId
      && pendingBootOwner?.agentId === agentId
      && pendingBootOwner.spawnAttemptId === spawnAttemptId
    if (daemonBooted) {
      this.pendingDaemonBootedUdids.delete(udid)
      this.bootedUdidsByAgent.delete(agentId)
    }

    const session: SimSession = {
      agentId,
      spawnAttemptId,
      udid,
      frameInterval: null,
      capturing: false,
      subscribed,
      logicalWidth: meta.width,
      logicalHeight: meta.height,
      lastDescribeAt: Date.now(),
      daemonBooted,
    }

    this.sessions.set(agentId, session)
    this.pendingUdids.delete(udid)
    if (this.pendingSubscriptions.get(agentId) === spawnAttemptId) this.pendingSubscriptions.delete(agentId)

    session.frameInterval = setInterval(async () => {
      if (!session.subscribed || session.capturing) return
      if (!this.ws || this.ws.bufferedAmount > 256 * 1024) return
      session.capturing = true
      try {
        // Re-query metadata periodically to catch simulator rotation
        if (Date.now() - session.lastDescribeAt >= 5000) {
          session.lastDescribeAt = Date.now()
          this.queryMetadata(udid).then((fresh) => {
            if (fresh.width != null && fresh.height != null) {
              if (fresh.width !== session.logicalWidth || fresh.height !== session.logicalHeight) {
                console.log('[daemon] simulator.metadata.update', { agentId, udid, from: { logicalWidth: session.logicalWidth, logicalHeight: session.logicalHeight }, to: fresh })
                session.logicalWidth = fresh.width
                session.logicalHeight = fresh.height
              }
            }
          }).catch(() => { /* keep previous values */ })
        }

        const frameData = await captureFrame(udid, agentId)
        if (frameData && this.ws && this.ws.readyState === WebSocket.OPEN) {
          const width = session.logicalWidth ?? 0
          const height = session.logicalHeight ?? 0
          const header = buildFrameHeader(agentId, width, height)
          this.ws.send(Buffer.concat([header, frameData]), { binary: true })
        }
      } catch (err) {
        console.error('[daemon] simulator.capture.error', { agentId, error: String(err) })
      } finally {
        session.capturing = false
      }
    }, 200)

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const sessionId = randomUUID()
      this.ws.send(JSON.stringify({ type: 'session_started', agentId, spawnAttemptId, sessionId }))
      this.ws.send(JSON.stringify({ type: 'agent_spawned', agentId, spawnAttemptId, agentKey: 'sim_ios', daemonId: this.daemonId }))
    }

    console.log('[daemon] simulator.started', { agentId, udid })
  }

  stop(agentId: string, spawnAttemptId?: SpawnAttemptId): void {
    const session = this.sessions.get(agentId)
    if (session && spawnAttemptId && session.spawnAttemptId !== spawnAttemptId) return
    if (spawnAttemptId && this.installRunOwners.get(agentId) === spawnAttemptId) {
      this.cancelledInstalls.add(this.spawnCancelKey(agentId, spawnAttemptId))
      this.installRunOwners.delete(agentId)
    }
    const installation = this.installProc.get(agentId)
    if (installation && (!spawnAttemptId || installation.spawnAttemptId === spawnAttemptId)) {
      console.log('[daemon] simulator.install.cancelled', { agentId })
      this.cancelledInstalls.add(this.spawnCancelKey(agentId, installation.spawnAttemptId))
      installation.process.kill('SIGTERM')
      this.installProc.delete(agentId)
    }
    if (!session) {
      if (spawnAttemptId) this.cleanupSpawnResidue(agentId, spawnAttemptId)
      else this.cleanupAllAgentResidue(agentId)
      return
    }
    if (session.frameInterval) clearInterval(session.frameInterval)
    const udid = session.udid
    const daemonBooted = session.daemonBooted
    this.sessions.delete(agentId)
    this.pendingUdids.delete(udid)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'exit', agentId, spawnAttemptId: session.spawnAttemptId, exitCode: 0, signal: null }))
    }
    console.log('[daemon] simulator.stop', { agentId, udid, daemonBooted })
    if (daemonBooted) {
      spawn('xcrun', ['simctl', 'shutdown', udid], { stdio: 'ignore' })
        .on('error', (err) => console.warn('[daemon] simulator.shutdown.error', { udid, err: String(err) }))
    }
  }

  stopAll(): void {
    for (const agentId of [...this.installProc.keys()]) {
      this.stop(agentId)
    }
    for (const agentId of [...this.sessions.keys()]) {
      this.stop(agentId)
    }
  }

  subscribe(agentId: string): void {
    const session = this.sessions.get(agentId)
    if (!session) return
    session.subscribed = true
  }

  unsubscribe(agentId: string): void {
    const session = this.sessions.get(agentId)
    if (!session) return
    session.subscribed = false
  }

  async handle(msg: SimClientMessage): Promise<void> {
    const session = this.sessions.get(msg.agentId)

    // subscribe/unsubscribe control stream backpressure
    // Buffer if session not yet created (start() is async; subscribe may arrive first)
    if (msg.type === 'sim_subscribe') {
      if (!isSpawnAttemptId(msg.spawnAttemptId)) return
      if (session) {
        if (session.spawnAttemptId === msg.spawnAttemptId) this.subscribe(msg.agentId)
      } else {
        this.pendingSubscriptions.set(msg.agentId, msg.spawnAttemptId)
      }
      return
    }
    if (msg.type === 'sim_unsubscribe') {
      if (!isSpawnAttemptId(msg.spawnAttemptId)) return
      if (this.pendingSubscriptions.get(msg.agentId) === msg.spawnAttemptId) this.pendingSubscriptions.delete(msg.agentId)
      if (session?.spawnAttemptId === msg.spawnAttemptId) this.unsubscribe(msg.agentId)
      return
    }

    // sim_healthcheck works even when no session exists (pre-session-guard)
    if (msg.type === 'sim_healthcheck') {
      const { checks } = await runFullHealthChecks(msg.agentId)
      this.sendSimHealth(msg.agentId, checks)
      return
    }

    if (msg.type === 'sim_install_run') {
      if (isSpawnAttemptId(msg.spawnAttemptId)) await this.handleSimInstallRun(msg.agentId, msg.spawnAttemptId)
      return
    }

    if (msg.type === 'sim_install_cancel') {
      if (isSpawnAttemptId(msg.spawnAttemptId)) this.handleSimInstallCancel(msg.agentId, msg.spawnAttemptId)
      return
    }

    if (!session) {
      console.warn('[daemon] simulator.handle: no session', { agentId: msg.agentId, type: msg.type })
      return
    }

    try {
      switch (msg.type) {
        case 'sim_tap': {
          await idbCommand(session.udid, ['ui', 'tap', String(msg.x), String(msg.y)])
          break
        }
        case 'sim_swipe': {
          await idbCommand(session.udid, [
            'ui', 'swipe',
            String(msg.x1), String(msg.y1),
            String(msg.x2), String(msg.y2),
            '--duration', String(msg.duration ?? 0.5),
          ])
          break
        }
        case 'sim_key': {
          // Current protocol sends text strings; map to idb ui text
          await idbCommand(session.udid, ['ui', 'text', msg.key])
          break
        }
        case 'sim_button': {
          // System buttons: HOME closes the foreground app, LOCK toggles lock, etc.
          console.log('[daemon] simulator.button.start', { agentId: msg.agentId, button: msg.button, udid: session.udid })
          await idbCommand(session.udid, ['ui', 'button', msg.button])
          console.log('[daemon] simulator.button.done', { agentId: msg.agentId, button: msg.button })
          break
        }
        case 'sim_get_source': {
          const source = await new Promise<string>((resolve, reject) => {
            const proc = spawn(IDB_PATH, ['ui', 'describe-all', '--udid', session.udid], { timeout: 15000 })
            let stdout = ''
            let stderr = ''
            proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
            proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
            proc.on('close', (code) => {
              if (code !== 0) reject(new Error(stderr || `idb exited ${code}`))
              else resolve(stdout)
            })
            proc.on('error', (err) => reject(err))
          })
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'sim_source', agentId: msg.agentId, source }))
          }
          break
        }
      }
    } catch (err) {
      console.error('[daemon] simulator.handle.error', { agentId: msg.agentId, type: msg.type, error: String(err) })
    }
  }

  private cleanupSpawnResidue(agentId: string, spawnAttemptId: SpawnAttemptId): void {
    if (this.installRunOwners.get(agentId) === spawnAttemptId) {
      this.cancelledInstalls.add(this.spawnCancelKey(agentId, spawnAttemptId))
      this.installRunOwners.delete(agentId)
    }
    const installation = this.installProc.get(agentId)
    if (installation?.spawnAttemptId === spawnAttemptId) {
      this.cancelledInstalls.add(this.spawnCancelKey(agentId, spawnAttemptId))
      installation.process.kill('SIGTERM')
      this.installProc.delete(agentId)
    }
    for (const [udid, pending] of this.pendingUdids) {
      if (pending.agentId === agentId && pending.spawnAttemptId === spawnAttemptId) this.pendingUdids.delete(udid)
    }
    if (this.pendingSubscriptions.get(agentId) === spawnAttemptId) this.pendingSubscriptions.delete(agentId)
    const bootOwner = this.bootedUdidsByAgent.get(agentId)
    if (bootOwner?.spawnAttemptId === spawnAttemptId) {
      const pendingOwner = this.pendingDaemonBootedUdids.get(bootOwner.udid)
      if (pendingOwner?.agentId === agentId && pendingOwner.spawnAttemptId === spawnAttemptId) {
        this.pendingDaemonBootedUdids.delete(bootOwner.udid)
        this.bootedUdidsByAgent.delete(agentId)
        this.shutdownBootedSimulator(bootOwner.udid)
      }
    }
  }

  private cleanupAllAgentResidue(agentId: string): void {
    const installOwner = this.installRunOwners.get(agentId)
    if (installOwner) {
      this.cancelledInstalls.add(this.spawnCancelKey(agentId, installOwner))
      this.installRunOwners.delete(agentId)
    }
    this.pendingSubscriptions.delete(agentId)
    for (const [udid, pending] of this.pendingUdids) {
      if (pending.agentId === agentId) this.pendingUdids.delete(udid)
    }
    const bootOwner = this.bootedUdidsByAgent.get(agentId)
    if (bootOwner) {
      const pendingOwner = this.pendingDaemonBootedUdids.get(bootOwner.udid)
      if (pendingOwner?.agentId === agentId && pendingOwner.spawnAttemptId === bootOwner.spawnAttemptId) {
        this.pendingDaemonBootedUdids.delete(bootOwner.udid)
        this.shutdownBootedSimulator(bootOwner.udid)
      }
      this.bootedUdidsByAgent.delete(agentId)
    }
  }

  private failSpawn(agentId: string, spawnAttemptId: SpawnAttemptId, failure: SpawnTerminalFailure): void {
    this.cleanupSpawnResidue(agentId, spawnAttemptId)
    emitSpawnTerminal(this.ws, agentId, spawnAttemptId, failure)
  }

  private sendSimHealth(agentId: string, checks: SimHealthCheck[]): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'sim_health', agentId, checks }))
    }
  }

  private resolveSimInstallScriptSync(): string | null {
    const envPath = process.env['BRIDGE_SIM_INSTALL_SCRIPT']
    if (envPath) return envPath
    if (fs.existsSync(SIM_INSTALL_CACHE_PATH)) return SIM_INSTALL_CACHE_PATH
    const devPath = path.join(__dirname, '../../../scripts/install-sim-prereqs.sh')
    if (fs.existsSync(devPath)) return devPath
    return null
  }

  /**
   * Resolve a usable on-disk install script. Order:
   *  1. BRIDGE_SIM_INSTALL_SCRIPT env override (always wins, real path).
   *  2. Fetch from the backend (daemon-token auth) → cache to ~/.bridge.
   *  3. Existing ~/.bridge copy as an OFFLINE fallback if the fetch fails.
   *  4. Dev fallback ../scripts for monorepo dev.
   * Returns the REAL path to a script bash can execute, or null + sends a clear
   * error when nothing is available (offline + no cache).
   */
  private async ensureSimInstallScript(agentId: string, spawnAttemptId: SpawnAttemptId): Promise<string | null> {
    const envPath = process.env['BRIDGE_SIM_INSTALL_SCRIPT']
    if (envPath) return envPath

    // Try backend fetch first (writes/refreshes the ~/.bridge cache).
    const fetched = await this.fetchSimInstallScript(agentId, spawnAttemptId)
    if (fetched) return fetched

    // Offline fallback: reuse a previously cached copy if present.
    if (fs.existsSync(SIM_INSTALL_CACHE_PATH)) {
      console.warn('[daemon] simulator.install.script: fetch failed, using cached copy', { agentId })
      return SIM_INSTALL_CACHE_PATH
    }

    // Dev fallback.
    const devPath = path.join(__dirname, '../../../scripts/install-sim-prereqs.sh')
    if (fs.existsSync(devPath)) return devPath

    this.sendInstallProgress(agentId, spawnAttemptId, {
      step: 'error',
      error: 'Could not download the simulator install script from the server (offline?). Check your connection and retry.',
    })
    return null
  }

  private async fetchSimInstallScript(agentId: string, spawnAttemptId: SpawnAttemptId): Promise<string | null> {
    if (!this.config?.server || !this.config?.token) {
      console.warn('[daemon] simulator.install.script: no server/token in config', { agentId })
      return null
    }
    const url = `${this.config.server.replace(/\/$/, '')}/api/meta/sim-install-script`
    let cachedEtag: string | null = null
    try {
      if (fs.existsSync(SIM_INSTALL_ETAG_PATH)) {
        cachedEtag = fs.readFileSync(SIM_INSTALL_ETAG_PATH, 'utf8').trim() || null
      }
    } catch { /* ignore */ }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          ...(cachedEtag ? { 'If-None-Match': cachedEtag } : {}),
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      console.warn('[daemon] simulator.install.script: fetch failed', { agentId, error: String(err) })
      return null
    }

    if (res.status === 304) {
      if (fs.existsSync(SIM_INSTALL_CACHE_PATH)) return SIM_INSTALL_CACHE_PATH
      return null
    }

    if (res.status === 401) {
      console.error('[daemon] simulator.install.script: server rejected the daemon token', { agentId })
      this.sendInstallProgress(agentId, spawnAttemptId, {
        step: 'error',
        error: 'Server rejected the daemon token. Re-authenticate the daemon (bridge-agent auth).',
      })
      return null
    }

    if (res.status !== 200) {
      console.warn('[daemon] simulator.install.script: unexpected status', { agentId, status: res.status })
      return null
    }

    const body = await res.text()
    try {
      fs.mkdirSync(path.dirname(SIM_INSTALL_CACHE_PATH), { recursive: true })
      await writeFile(SIM_INSTALL_CACHE_PATH, body, { encoding: 'utf8', mode: 0o755 })
      fs.chmodSync(SIM_INSTALL_CACHE_PATH, 0o755)
      const etag = res.headers.get('etag')
      if (etag) fs.writeFileSync(SIM_INSTALL_ETAG_PATH, etag, 'utf8')
      return SIM_INSTALL_CACHE_PATH
    } catch (err) {
      console.error('[daemon] simulator.install.script: failed to cache', { agentId, error: String(err) })
      return null
    }
  }

  private async handleSimInstallRun(agentId: string, spawnAttemptId: SpawnAttemptId): Promise<void> {
    if (this.installRunOwners.has(agentId)) {
      if (this.ownsInstallGeneration(agentId, spawnAttemptId)) {
        this.sendInstallProgress(agentId, spawnAttemptId, { step: 'error', error: 'already installing' })
      }
      return
    }
    const installKey = this.spawnCancelKey(agentId, spawnAttemptId)
    this.cancelledInstalls.delete(installKey)
    this.installRunOwners.set(agentId, spawnAttemptId)
    const scriptPath = await this.ensureSimInstallScript(agentId, spawnAttemptId)
    if (!scriptPath) {
      // ensureSimInstallScript already sent the error progress.
      if (this.installRunOwners.get(agentId) === spawnAttemptId) this.installRunOwners.delete(agentId)
      return
    }
    if (!this.ownsInstallGeneration(agentId, spawnAttemptId)) return
    if (this.installProc.has(agentId)) {
      this.sendInstallProgress(agentId, spawnAttemptId, { step: 'error', error: 'already installing' })
      return
    }
    try {
      fs.accessSync(scriptPath, fs.constants.F_OK)
    } catch {
      this.sendInstallProgress(agentId, spawnAttemptId, { step: 'error', error: `install script not found at ${scriptPath}` })
      if (this.installRunOwners.get(agentId) === spawnAttemptId) this.installRunOwners.delete(agentId)
      return
    }

    const proc = spawn('bash', ['-lc', scriptPath], { timeout: 600000 })
    this.installProc.set(agentId, { process: proc, spawnAttemptId })
    let currentStep: SimInstallStep = 'pre_check'
    let stdoutBuffer = ''
    let stderrBuffer = ''

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (this.installProc.get(agentId)?.process !== proc
        || this.installProc.get(agentId)?.spawnAttemptId !== spawnAttemptId) return
      stdoutBuffer += chunk.toString('utf8')
      let nlIndex: number
      while ((nlIndex = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, nlIndex)
        stdoutBuffer = stdoutBuffer.slice(nlIndex + 1)
        if (!line) continue
        if (line.startsWith('STEP:')) {
          currentStep = line.slice(5).trim() as SimInstallStep
          this.sendInstallProgress(agentId, spawnAttemptId, { step: currentStep })
        } else if (line.startsWith('BOOTED_UDID:')) {
          const udid = line.slice(12).trim()
          if (this.installProc.get(agentId)?.process !== proc
            || this.installProc.get(agentId)?.spawnAttemptId !== spawnAttemptId) continue
          this.pendingDaemonBootedUdids.set(udid, { agentId, spawnAttemptId })
          this.bootedUdidsByAgent.set(agentId, { udid, spawnAttemptId })
        } else {
          this.sendInstallProgress(agentId, spawnAttemptId, { stream: 'stdout', line })
        }
      }
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (this.installProc.get(agentId)?.process !== proc
        || this.installProc.get(agentId)?.spawnAttemptId !== spawnAttemptId) return
      stderrBuffer += chunk.toString('utf8')
      let nlIndex: number
      while ((nlIndex = stderrBuffer.indexOf('\n')) !== -1) {
        const line = stderrBuffer.slice(0, nlIndex)
        stderrBuffer = stderrBuffer.slice(nlIndex + 1)
        if (!line) continue
        this.sendInstallProgress(agentId, spawnAttemptId, { stream: 'stderr', line })
      }
    })
    proc.on('close', (code) => {
      const ownsProcess = this.installProc.get(agentId)?.process === proc
        && this.installProc.get(agentId)?.spawnAttemptId === spawnAttemptId
      const ownsGeneration = this.ownsInstallGeneration(agentId, spawnAttemptId)
      const wasCancelled = this.cancelledInstalls.has(installKey)
      if (!ownsProcess || wasCancelled || !ownsGeneration) {
        if (ownsProcess) this.installProc.delete(agentId)
        if (this.installRunOwners.get(agentId) === spawnAttemptId) this.installRunOwners.delete(agentId)
        this.cancelledInstalls.delete(installKey)
        return
      }
      if (ownsProcess) this.installProc.delete(agentId)
      if (code !== 0) {
        // On success (code === 0) the entry stays until start() consumes it.
        // Only drain here on failure so pendingDaemonBootedUdids doesn't leak.
        const bootOwner = this.bootedUdidsByAgent.get(agentId)
        if (bootOwner?.spawnAttemptId === spawnAttemptId) {
          this.pendingDaemonBootedUdids.delete(bootOwner.udid)
          this.bootedUdidsByAgent.delete(agentId)
        }
      }
      if (stdoutBuffer) {
        const line = stdoutBuffer
        stdoutBuffer = ''
        if (line.startsWith('STEP:')) {
          currentStep = line.slice(5).trim() as SimInstallStep
          this.sendInstallProgress(agentId, spawnAttemptId, { step: currentStep })
        } else {
          this.sendInstallProgress(agentId, spawnAttemptId, { stream: 'stdout', line })
        }
      }
      if (stderrBuffer) {
        const line = stderrBuffer
        stderrBuffer = ''
        this.sendInstallProgress(agentId, spawnAttemptId, { stream: 'stderr', line })
      }
      this.cancelledInstalls.delete(installKey)
      if (code === 0) {
        this.sendInstallProgress(agentId, spawnAttemptId, { step: 'done', exitCode: 0 })
      } else {
        this.sendInstallProgress(agentId, spawnAttemptId, { step: 'error', exitCode: code ?? undefined, error: `install script exited with code ${code}` })
      }
      if (this.installRunOwners.get(agentId) === spawnAttemptId) this.installRunOwners.delete(agentId)
    })
    proc.on('error', (err) => {
      const ownsProcess = this.installProc.get(agentId)?.process === proc
        && this.installProc.get(agentId)?.spawnAttemptId === spawnAttemptId
      const ownsGeneration = this.ownsInstallGeneration(agentId, spawnAttemptId)
      if (ownsProcess) this.installProc.delete(agentId)
      const bootOwner = this.bootedUdidsByAgent.get(agentId)
      if (bootOwner?.spawnAttemptId === spawnAttemptId) {
        this.pendingDaemonBootedUdids.delete(bootOwner.udid)
        this.bootedUdidsByAgent.delete(agentId)
      }
      const wasCancelled = this.cancelledInstalls.has(installKey)
      this.cancelledInstalls.delete(installKey)
      if (wasCancelled || !ownsProcess || !ownsGeneration) {
        if (this.installRunOwners.get(agentId) === spawnAttemptId) this.installRunOwners.delete(agentId)
        return
      }
      this.sendInstallProgress(agentId, spawnAttemptId, { step: 'error', error: String(err) })
      if (this.installRunOwners.get(agentId) === spawnAttemptId) this.installRunOwners.delete(agentId)
    })
  }

  private handleSimInstallCancel(agentId: string, spawnAttemptId: SpawnAttemptId): void {
    const installation = this.installProc.get(agentId)
    if (this.installRunOwners.get(agentId) !== spawnAttemptId) return
    this.cancelledInstalls.add(this.spawnCancelKey(agentId, spawnAttemptId))
    const bootOwner = this.bootedUdidsByAgent.get(agentId)
    if (bootOwner?.spawnAttemptId === spawnAttemptId) {
      this.pendingDaemonBootedUdids.delete(bootOwner.udid)
      this.bootedUdidsByAgent.delete(agentId)
    }
    if (installation?.spawnAttemptId === spawnAttemptId) {
      installation.process.kill('SIGTERM')
      this.installProc.delete(agentId)
    }
    this.sendInstallProgress(agentId, spawnAttemptId, { step: 'error', error: 'cancelled by user' })
    this.installRunOwners.delete(agentId)
  }

  private sendInstallProgress(agentId: string, spawnAttemptId: SpawnAttemptId, payload: { step?: SimInstallStep; stream?: 'stdout' | 'stderr'; line?: string; exitCode?: number; error?: string }): void {
    if (!this.ownsInstallGeneration(agentId, spawnAttemptId)) return
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'sim_install_progress', agentId, spawnAttemptId, ...payload }))
    }
  }
}
