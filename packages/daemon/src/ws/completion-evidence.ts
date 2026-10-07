import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { getCompletionEvidenceRoot } from '../profile.js'
import type { CompletionFailureCode, CompletionOutcome } from '@jerico/shared'

export type CompletionEvidenceTaskKind = 'ai' | 'shell'

export interface CompletionEvidenceRecord {
  marker: string
  agent: string
  verdict: string
  exitCode?: number
}

export interface PrepareCompletionEvidenceInput {
  completionId: string
  agentId: string
  panelInstanceId: number
  expectedMarker: string
  taskKind: CompletionEvidenceTaskKind
}

export interface PrepareCompletionEvidenceResult {
  ok: boolean
  path?: string
  error?: 'invalid_request' | 'collision' | 'path_denied' | 'write_failed'
}

export interface CheckCompletionEvidenceInput {
  completionId: string
  agentId: string
  panelInstanceId: number
}

export interface CheckCompletionEvidenceResult {
  verified: boolean
  record?: CompletionEvidenceRecord
  error?: 'invalid_request' | 'panel_instance_mismatch' | 'not_registered' | 'binding_mismatch' | 'not_found' | 'settling' | 'invalid_record' | 'read_failed' | 'consumed' | 'released'
}

export interface ReleaseCompletionEvidenceInput {
  completionId: string
  agentId: string
  panelInstanceId: number
}

export interface SealCompletionEvidenceInput extends CheckCompletionEvidenceInput {
  outcome: CompletionOutcome
  failureCode?: CompletionFailureCode
}

export interface SealCompletionEvidenceResult {
  sealed: boolean
  record?: CompletionEvidenceRecord
  error?: 'invalid_request' | 'panel_instance_mismatch' | 'not_registered' | 'binding_mismatch' | 'wrong_task_kind' | 'already_sealed' | 'released' | 'write_failed'
}

interface ArtifactIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

interface RegisteredEvidence extends PrepareCompletionEvidenceInput {
  evidenceDirectory: string
  resultPath: string
  consumed: boolean
  released: boolean
  sealedRecord?: CompletionEvidenceRecord
}

interface EvidenceObservation {
  result: CheckCompletionEvidenceResult
  identity?: ArtifactIdentity
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MARKER_RE = /^[A-Z0-9][A-Z0-9_-]{0,63}_DONE$/
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const RECORD_RE = /^([A-Z0-9][A-Z0-9_-]{0,63}_DONE) agent=([A-Za-z0-9][A-Za-z0-9_-]{0,127}) verdict=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?: exit_code=(0|[1-9][0-9]{0,2}))?$/
const AGENT_HASH_RE = /^[0-9a-f]{32}$/
const PANEL_INSTANCE_RE = /^[1-9][0-9]*$/
const MAX_RECORD_BYTES = 512
const MAX_TAIL_BYTES = 64 * 1024
const DEFAULT_STABILITY_INTERVAL_MS = 250
const REQUIRED_STABLE_CONFIRMATIONS = 2
const FAILURE_CODES = new Set<CompletionFailureCode>([
  'blocked', 'dependency_missing', 'invalid_result', 'tool_error', 'command_failed', 'unknown',
])
export const COMPLETION_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000

const registeredEvidence = new Map<string, RegisteredEvidence>()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function agentHash(agentId: string): string {
  return createHash('sha256').update(agentId).digest('hex').slice(0, 32)
}

function identityOf(stat: fs.Stats): ArtifactIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
}

function sameIdentity(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function ensureOwnedDirectory(directory: string, recursive = false): string {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('path_denied')
  fs.chmodSync(directory, 0o700)
  return fs.realpathSync(directory)
}

function verifiedEvidenceRoot(create: boolean): string | null {
  const root = getCompletionEvidenceRoot()
  if (!path.isAbsolute(root)) return null
  if (!fs.existsSync(root)) {
    if (!create) return null
    ensureOwnedDirectory(root, true)
  }
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null
  return fs.realpathSync(root)
}

function validPrepareInput(input: PrepareCompletionEvidenceInput): boolean {
  return UUID_RE.test(input.completionId)
    && AGENT_RE.test(input.agentId)
    && Number.isSafeInteger(input.panelInstanceId)
    && input.panelInstanceId > 0
    && MARKER_RE.test(input.expectedMarker)
    && (input.taskKind === 'ai' || input.taskKind === 'shell')
}

function sameBinding(entry: RegisteredEvidence, input: CheckCompletionEvidenceInput | ReleaseCompletionEvidenceInput): boolean {
  return entry.agentId === input.agentId && entry.panelInstanceId === input.panelInstanceId
}

export function parseCompletionEvidenceRecord(
  line: string,
  expected: Pick<PrepareCompletionEvidenceInput, 'agentId' | 'expectedMarker' | 'taskKind'>,
): CompletionEvidenceRecord | null {
  if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) return null
  const match = RECORD_RE.exec(line)
  if (!match) return null
  const [, marker, agent, verdict, rawExitCode] = match
  if (marker !== expected.expectedMarker || agent !== expected.agentId || !verdict) return null
  if (expected.taskKind === 'ai' && rawExitCode !== undefined) return null
  if (expected.taskKind === 'shell' && rawExitCode === undefined) return null
  const exitCode = rawExitCode === undefined ? undefined : Number(rawExitCode)
  if (exitCode !== undefined && (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255)) return null
  if (expected.taskKind === 'shell') {
    if (exitCode === 0 && verdict !== 'complete') return null
    if (exitCode !== 0 && verdict !== 'failed') return null
  }
  return exitCode === undefined ? { marker, agent, verdict } : { marker, agent, verdict, exitCode }
}

function atomicWriteRecord(entry: RegisteredEvidence, record: CompletionEvidenceRecord): void {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const temporaryPath = path.join(entry.evidenceDirectory, `.result-${suffix}.tmp`)
  const line = `${record.marker} agent=${record.agent} verdict=${record.verdict}${record.exitCode === undefined ? '' : ` exit_code=${record.exitCode}`}\n`
  const fd = fs.openSync(temporaryPath, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, line, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(temporaryPath, entry.resultPath)
  } catch (error) {
    try { fs.unlinkSync(temporaryPath) } catch {}
    throw error
  }
}

function readFinalNonEmptyLine(filePath: string): string | null {
  const stat = fs.statSync(filePath)
  const start = Math.max(0, stat.size - MAX_TAIL_BYTES)
  const length = stat.size - start
  const fd = fs.openSync(filePath, 'r')
  try {
    const bytes = Buffer.alloc(length)
    fs.readSync(fd, bytes, 0, length, start)
    let recordBytes = bytes
    if (start > 0) {
      const firstNewline = bytes.indexOf(0x0a)
      if (firstNewline === -1) return null
      recordBytes = bytes.subarray(firstNewline + 1)
    }
    const tail = utf8Decoder.decode(recordBytes)
    const lines = tail.split('\n')
    for (let index = lines.length - 1; index >= 0; index--) {
      const rawLine = lines[index]!.endsWith('\r') ? lines[index]!.slice(0, -1) : lines[index]!
      if (rawLine.trim().length > 0) return rawLine
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}

function observeEvidence(entry: RegisteredEvidence): EvidenceObservation {
  try {
    if (!fs.existsSync(entry.resultPath)) return { result: { verified: false, error: 'not_found' } }
    const root = verifiedEvidenceRoot(false)
    if (!root || !isContained(root, entry.evidenceDirectory)) {
      return { result: { verified: false, error: 'read_failed' } }
    }
    const directoryReal = fs.realpathSync(entry.evidenceDirectory)
    const targetLstat = fs.lstatSync(entry.resultPath)
    if (!targetLstat.isFile() || targetLstat.isSymbolicLink()) {
      return { result: { verified: false, error: 'read_failed' } }
    }
    const targetReal = fs.realpathSync(entry.resultPath)
    if (!isContained(directoryReal, targetReal)) {
      return { result: { verified: false, error: 'read_failed' } }
    }
    const before = identityOf(fs.statSync(targetReal))
    const finalLine = readFinalNonEmptyLine(targetReal)
    const after = identityOf(fs.statSync(targetReal))
    if (!sameIdentity(before, after)) {
      return { result: { verified: false, error: 'settling' }, identity: after }
    }
    const record = finalLine === null ? null : parseCompletionEvidenceRecord(finalLine, entry)
    return {
      result: record ? { verified: true, record } : { verified: false, error: 'invalid_record' },
      identity: after,
    }
  } catch {
    return { result: { verified: false, error: 'read_failed' } }
  }
}

function removeRegisteredDirectory(entry: RegisteredEvidence): void {
  const root = verifiedEvidenceRoot(false)
  if (!root || !isContained(root, entry.evidenceDirectory) || !fs.existsSync(entry.evidenceDirectory)) return
  try {
    const realDirectory = fs.realpathSync(entry.evidenceDirectory)
    if (!isContained(root, realDirectory)) return
    fs.rmSync(entry.evidenceDirectory, { recursive: true, force: true })
  } catch {
    // Release is idempotent and best-effort. A stale directory remains eligible
    // for the bounded 24-hour scavenger on the next daemon start.
  }
}

export function prepareCompletionEvidence(input: PrepareCompletionEvidenceInput): PrepareCompletionEvidenceResult {
  if (!validPrepareInput(input)) return { ok: false, error: 'invalid_request' }
  if (registeredEvidence.has(input.completionId)) return { ok: false, error: 'collision' }

  try {
    const root = verifiedEvidenceRoot(true)
    if (!root) return { ok: false, error: 'path_denied' }
    const hashDirectory = path.join(root, agentHash(input.agentId))
    const instanceDirectory = path.join(hashDirectory, String(input.panelInstanceId))
    const resolvedHashDirectory = ensureOwnedDirectory(hashDirectory)
    const resolvedInstanceDirectory = ensureOwnedDirectory(instanceDirectory)
    if (!isContained(root, resolvedHashDirectory) || !isContained(root, resolvedInstanceDirectory)) {
      return { ok: false, error: 'path_denied' }
    }

    const evidenceDirectory = path.join(resolvedInstanceDirectory, input.completionId)
    try {
      fs.mkdirSync(evidenceDirectory, { recursive: false, mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, error: 'collision' }
      throw error
    }
    fs.chmodSync(evidenceDirectory, 0o700)
    const resolvedEvidenceDirectory = fs.realpathSync(evidenceDirectory)
    if (!isContained(root, resolvedEvidenceDirectory)) {
      fs.rmdirSync(evidenceDirectory)
      return { ok: false, error: 'path_denied' }
    }
    const resultPath = path.join(resolvedEvidenceDirectory, 'result.md')
    registeredEvidence.set(input.completionId, {
      ...input,
      evidenceDirectory: resolvedEvidenceDirectory,
      resultPath,
      consumed: false,
      released: false,
    })
    return { ok: true, path: resultPath }
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message === 'path_denied' ? 'path_denied' : 'write_failed' }
  }
}

/**
 * Seal an AI worker's closed-schema completion intent. Identity fields come
 * only from dispatch-time daemon registration; no worker-authored text is
 * parsed into the authoritative record.
 */
export function sealCompletionEvidence(input: SealCompletionEvidenceInput): SealCompletionEvidenceResult {
  if (!UUID_RE.test(input.completionId)
    || !AGENT_RE.test(input.agentId)
    || !Number.isSafeInteger(input.panelInstanceId)
    || input.panelInstanceId <= 0
    || (input.outcome !== 'complete' && input.outcome !== 'failed')
    || (input.outcome === 'complete' && input.failureCode !== undefined)
    || (input.outcome === 'failed' && (input.failureCode === undefined || !FAILURE_CODES.has(input.failureCode)))) {
    return { sealed: false, error: 'invalid_request' }
  }
  const entry = registeredEvidence.get(input.completionId)
  if (!entry) return { sealed: false, error: 'not_registered' }
  if (!sameBinding(entry, input)) return { sealed: false, error: 'binding_mismatch' }
  if (entry.released) return { sealed: false, error: 'released' }
  if (entry.taskKind !== 'ai') return { sealed: false, error: 'wrong_task_kind' }
  if (entry.sealedRecord) return { sealed: false, error: 'already_sealed', record: entry.sealedRecord }

  const record: CompletionEvidenceRecord = {
    marker: entry.expectedMarker,
    agent: entry.agentId,
    verdict: input.outcome === 'complete' ? 'complete' : `failed:${input.failureCode}`,
  }
  try {
    atomicWriteRecord(entry, record)
    entry.sealedRecord = record
    return { sealed: true, record }
  } catch {
    return { sealed: false, error: 'write_failed' }
  }
}

export async function checkCompletionEvidence(
  input: CheckCompletionEvidenceInput,
  stabilityIntervalMs = DEFAULT_STABILITY_INTERVAL_MS,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  isPanelInstanceCurrent: () => boolean = () => true,
): Promise<CheckCompletionEvidenceResult> {
  if (!UUID_RE.test(input.completionId) || !AGENT_RE.test(input.agentId) || !Number.isSafeInteger(input.panelInstanceId) || input.panelInstanceId <= 0) {
    return { verified: false, error: 'invalid_request' }
  }
  const entry = registeredEvidence.get(input.completionId)
  if (!entry) return { verified: false, error: 'not_registered' }
  if (!sameBinding(entry, input)) return { verified: false, error: 'binding_mismatch' }
  if (!isPanelInstanceCurrent()) return { verified: false, error: 'panel_instance_mismatch' }
  if (entry.released) return { verified: false, error: 'released' }
  if (entry.consumed) return { verified: false, error: 'consumed' }

  const first = observeEvidence(entry)
  if (!first.result.verified || !first.identity) return first.result
  let previousIdentity = first.identity
  let confirmed = first
  for (let observation = 0; observation < REQUIRED_STABLE_CONFIRMATIONS; observation++) {
    await wait(Math.max(0, stabilityIntervalMs))
    if (!isPanelInstanceCurrent()) return { verified: false, error: 'panel_instance_mismatch' }
    confirmed = observeEvidence(entry)
    if (!confirmed.result.verified || !confirmed.identity) return confirmed.result
    if (!sameIdentity(previousIdentity, confirmed.identity)) return { verified: false, error: 'settling' }
    previousIdentity = confirmed.identity
  }
  if (!isPanelInstanceCurrent()) return { verified: false, error: 'panel_instance_mismatch' }
  entry.consumed = true
  return confirmed.result
}

export function releaseCompletionEvidence(input: ReleaseCompletionEvidenceInput): boolean {
  const entry = registeredEvidence.get(input.completionId)
  if (!entry || !sameBinding(entry, input)) return false
  if (!entry.released) {
    entry.released = true
    removeRegisteredDirectory(entry)
  }
  return true
}

export function releaseCompletionEvidenceForPanel(agentId: string, panelInstanceId: number): void {
  for (const [completionId, entry] of registeredEvidence) {
    if (entry.agentId !== agentId || entry.panelInstanceId !== panelInstanceId) continue
    removeRegisteredDirectory(entry)
    registeredEvidence.delete(completionId)
  }
}

export function scavengeStaleCompletionEvidence(
  livePanels: ReadonlyArray<{ agentId: string; panelInstanceId?: number }>,
  now = Date.now(),
): number {
  const root = verifiedEvidenceRoot(false)
  if (!root) return 0
  const livePanelDirectories = new Set(livePanels.flatMap(panel => (
    Number.isSafeInteger(panel.panelInstanceId) && (panel.panelInstanceId ?? 0) > 0
      ? [`${agentHash(panel.agentId)}/${panel.panelInstanceId}`]
      : []
  )))
  let removed = 0

  try {
    for (const hashEntry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!hashEntry.isDirectory() || !AGENT_HASH_RE.test(hashEntry.name)) continue
      const hashDirectory = path.join(root, hashEntry.name)
      for (const instanceEntry of fs.readdirSync(hashDirectory, { withFileTypes: true })) {
        if (!instanceEntry.isDirectory() || !PANEL_INSTANCE_RE.test(instanceEntry.name)) continue
        if (livePanelDirectories.has(`${hashEntry.name}/${instanceEntry.name}`)) continue
        const instanceDirectory = path.join(hashDirectory, instanceEntry.name)
        for (const completionEntry of fs.readdirSync(instanceDirectory, { withFileTypes: true })) {
          if (!completionEntry.isDirectory() || !UUID_RE.test(completionEntry.name) || registeredEvidence.has(completionEntry.name)) continue
          const completionDirectory = path.join(instanceDirectory, completionEntry.name)
          try {
            const realDirectory = fs.realpathSync(completionDirectory)
            if (!isContained(root, realDirectory)) continue
            const directoryStat = fs.statSync(realDirectory)
            const resultPath = path.join(realDirectory, 'result.md')
            const newestMtime = fs.existsSync(resultPath)
              ? Math.max(directoryStat.mtimeMs, fs.statSync(resultPath).mtimeMs)
              : directoryStat.mtimeMs
            if (now - newestMtime <= COMPLETION_EVIDENCE_TTL_MS) continue
            fs.rmSync(completionDirectory, { recursive: true, force: true })
            removed++
          } catch {
            // A racing or unreadable candidate is left untouched.
          }
        }
        try { fs.rmdirSync(instanceDirectory) } catch {}
      }
      try { fs.rmdirSync(hashDirectory) } catch {}
    }
  } catch {
    return removed
  }
  return removed
}
