import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getActiveProfile, getStartupDiagnosticsDir } from '../profile.js'

export const AGY_STARTUP_DIAGNOSTIC_ENV = 'JERICO_AGY_STARTUP_DIAGNOSTIC'
export const AGY_STARTUP_DIAGNOSTIC_MAX_BYTES = 32 * 1024
export const AGY_STARTUP_DIAGNOSTIC_MAX_MS = 30_000

export type AgyStartupDiagnosticStopReason =
  | 'blocker'
  | 'ready'
  | 'ready_timeout'
  | 'exit'
  | 'duration_cap'
  | 'byte_cap'

type RedactionCounts = {
  email: number
  url: number
  bearerOrApiToken: number
  uuid: number
  absolutePath: number
  highEntropy: number
}

export interface AgyStartupDiagnosticBinding {
  agentId: string
  panelInstanceId: number
  providerVersion?: string
  rows: number
  cols: number
}

interface ChunkBoundary {
  offset: number
  length: number
}

interface ActiveCapture extends AgyStartupDiagnosticBinding {
  correlationId: string
  artifactPath: string
  startedAt: number
  chunks: Buffer[]
  chunkBoundaries: ChunkBoundary[]
  totalBytes: number
  timer: ReturnType<typeof setTimeout>
}

export interface AgyStartupDiagnosticOptions {
  enabled: boolean
  artifactDir: string
  homePath: string
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  makeCorrelationId?: () => string
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, '')
}

function escapeControls(value: string): string {
  let result = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x0a) result += '\\n\n'
    else if (code === 0x0d) result += '\\r'
    else if (code === 0x09) result += '\\t'
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      result += `\\x${code.toString(16).padStart(2, '0')}`
    } else result += character
  }
  return result
}

function replaceCount(value: string, pattern: RegExp, replacement: string): { value: string; count: number } {
  let count = 0
  return {
    value: value.replace(pattern, () => {
      count += 1
      return replacement
    }),
    count,
  }
}

export function redactAgyStartupDiagnosticView(value: string, homePath: string): {
  value: string
  counts: RedactionCounts
} {
  const counts: RedactionCounts = {
    email: 0,
    url: 0,
    bearerOrApiToken: 0,
    uuid: 0,
    absolutePath: 0,
    highEntropy: 0,
  }
  let redacted = value
  const rules: Array<[keyof RedactionCounts, RegExp, string]> = [
    ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]'],
    ['url', /\bhttps?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]'],
    ['bearerOrApiToken', /\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:api[_-]?key|token|secret)\s*[:=]\s*[A-Za-z0-9._~+\/-]{8,}=*|\b(?:sk-(?:ant-|proj-)?|AIza|gh[pousr]_|xox[baprs]-)[A-Za-z0-9._~+\/-]{12,}=*/gi, '[REDACTED_TOKEN]'],
    ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[REDACTED_UUID]'],
  ]
  for (const [key, pattern, replacement] of rules) {
    const result = replaceCount(redacted, pattern, replacement)
    redacted = result.value
    counts[key] += result.count
  }

  if (homePath) {
    const escapedHome = homePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const result = replaceCount(redacted, new RegExp(`${escapedHome}(?:[/\\\\][^\\s"'<>]*)?`, 'g'), '[REDACTED_HOME_PATH]')
    redacted = result.value
    counts.absolutePath += result.count
  }
  for (const pattern of [
    /(?<![A-Za-z0-9._~-])\/(?:[^\s"'<>/]+\/)*[^\s"'<>/]+/g,
    /\b[A-Za-z]:\\[^\s"'<>]+/g,
  ]) {
    const result = replaceCount(redacted, pattern, '[REDACTED_ABSOLUTE_PATH]')
    redacted = result.value
    counts.absolutePath += result.count
  }
  const entropy = replaceCount(redacted, /\b(?=[A-Za-z0-9_+\/-]{32,}\b)(?=[A-Za-z0-9_+\/-]*[A-Za-z])(?=[A-Za-z0-9_+\/-]*\d)[A-Za-z0-9_+\/-]+={0,2}\b/g, '[REDACTED_HIGH_ENTROPY]')
  redacted = entropy.value
  counts.highEntropy += entropy.count
  return { value: redacted, counts }
}

function mergeCounts(left: RedactionCounts, right: RedactionCounts): RedactionCounts {
  return {
    email: left.email + right.email,
    url: left.url + right.url,
    bearerOrApiToken: left.bearerOrApiToken + right.bearerOrApiToken,
    uuid: left.uuid + right.uuid,
    absolutePath: left.absolutePath + right.absolutePath,
    highEntropy: left.highEntropy + right.highEntropy,
  }
}

export class AgyStartupDiagnostic {
  private readonly now: () => number
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly makeCorrelationId: () => string
  private consumed = false
  private active: ActiveCapture | null = null
  private lastArtifactPath: string | null = null

  constructor(private readonly options: AgyStartupDiagnosticOptions) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.makeCorrelationId = options.makeCorrelationId ?? randomUUID
  }

  bind(binding: AgyStartupDiagnosticBinding): boolean {
    if (!this.options.enabled || this.consumed || this.active) return false
    this.consumed = true
    const correlationId = this.makeCorrelationId()
    const artifactPath = path.join(this.options.artifactDir, `agy-startup-${correlationId}.json`)
    const timer = this.setTimer(() => this.stop('duration_cap'), AGY_STARTUP_DIAGNOSTIC_MAX_MS)
    this.active = {
      ...binding,
      correlationId,
      artifactPath,
      startedAt: this.now(),
      chunks: [],
      chunkBoundaries: [],
      totalBytes: 0,
      timer,
    }
    return true
  }

  observe(agentId: string, panelInstanceId: number, chunk: Buffer): void {
    const active = this.active
    if (!active || active.agentId !== agentId || active.panelInstanceId !== panelInstanceId || chunk.length === 0) return
    const available = AGY_STARTUP_DIAGNOSTIC_MAX_BYTES - active.totalBytes
    if (available <= 0) {
      this.stop('byte_cap')
      return
    }
    const retained = chunk.subarray(0, available)
    active.chunkBoundaries.push({ offset: active.totalBytes, length: retained.length })
    active.chunks.push(Buffer.from(retained))
    active.totalBytes += retained.length
    if (retained.length < chunk.length || active.totalBytes >= AGY_STARTUP_DIAGNOSTIC_MAX_BYTES) {
      this.stop('byte_cap')
    }
  }

  stop(reason: AgyStartupDiagnosticStopReason, agentId?: string, panelInstanceId?: number): string | null {
    const active = this.active
    if (!active) return null
    if (agentId !== undefined && active.agentId !== agentId) return null
    if (panelInstanceId !== undefined && active.panelInstanceId !== panelInstanceId) return null
    this.active = null
    this.clearTimer(active.timer)

    const raw = Buffer.concat(active.chunks, active.totalBytes)
    const escaped = redactAgyStartupDiagnosticView(escapeControls(raw.toString('utf8')), this.options.homePath)
    const normalized = redactAgyStartupDiagnosticView(
      stripAnsi(raw.toString('utf8'))
        .replace(/\r\n?/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ''),
      this.options.homePath,
    )
    const artifact = {
      schemaVersion: 1,
      sensitive: true,
      sensitivityNotice: 'Contains local raw provider startup output in rawBase64. Never upload, relay, log, or commit this artifact.',
      provider: 'agy',
      providerVersion: active.providerVersion,
      agentId: active.agentId,
      panelInstanceId: active.panelInstanceId,
      rows: active.rows,
      cols: active.cols,
      startedAt: active.startedAt,
      stoppedAt: this.now(),
      stopReason: reason,
      byteLength: raw.length,
      chunkBoundaries: active.chunkBoundaries,
      rawSha256: createHash('sha256').update(raw).digest('hex'),
      rawBase64: raw.toString('base64'),
      escapedControlView: escaped.value,
      ansiStrippedNormalizedView: normalized.value,
      redactionCounts: mergeCounts(escaped.counts, normalized.counts),
    }
    try {
      mkdirSync(this.options.artifactDir, { recursive: true, mode: 0o700 })
      writeFileSync(active.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      chmodSync(active.artifactPath, 0o600)
      this.lastArtifactPath = active.artifactPath
      return active.artifactPath
    } catch {
      // Diagnostics are observational only. A local filesystem failure must not
      // affect PTY lifecycle, readiness, input, or shared telemetry.
      return null
    }
  }

  getStateForTest(): { consumed: boolean; activeBinding: AgyStartupDiagnosticBinding | null; lastArtifactPath: string | null } {
    return {
      consumed: this.consumed,
      activeBinding: this.active === null ? null : {
        agentId: this.active.agentId,
        panelInstanceId: this.active.panelInstanceId,
        providerVersion: this.active.providerVersion,
        rows: this.active.rows,
        cols: this.active.cols,
      },
      lastArtifactPath: this.lastArtifactPath,
    }
  }
}

let processDiagnostic: AgyStartupDiagnostic | null = null

export function isAgyStartupDiagnosticEnabled(profile: string | null, optIn: string | undefined): boolean {
  return profile !== null && optIn === '1'
}

export function getProcessAgyStartupDiagnostic(): AgyStartupDiagnostic {
  if (!processDiagnostic) {
    const enabled = isAgyStartupDiagnosticEnabled(
      getActiveProfile(),
      process.env[AGY_STARTUP_DIAGNOSTIC_ENV],
    )
    processDiagnostic = new AgyStartupDiagnostic({
      enabled,
      artifactDir: getStartupDiagnosticsDir(),
      homePath: process.env['HOME'] ?? '',
    })
  }
  return processDiagnostic
}
