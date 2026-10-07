import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Stats } from 'node:fs'

export const DIAG_LOG_MAX_BYTES = 256 * 1024
export const DIAG_FLAG_MAX_AGE_MS = 30 * 60 * 1000

export interface HookDiagnosticPaths {
  dir: string
  flag: string
  log: string
  rotatedLog: string
}

export function diagnosticPaths(home = process.env.HOME || os.homedir()): HookDiagnosticPaths {
  const dir = path.join(home, '.jerico', 'hooks')
  return { dir, flag: path.join(dir, 'DIAG'), log: path.join(dir, 'diag.log'), rotatedLog: path.join(dir, 'diag.log.1') }
}

function regularFile(file: string): Stats | null {
  try {
    const stat = lstatSync(file)
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

function ensureSafeDirectory(dir: string): void {
  try {
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe diagnostics directory: ${dir}`)
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  chmodSync(dir, 0o700)
}

export function maintainHookDiagnostics(options: { home?: string; nowMs?: number } = {}): void {
  const paths = diagnosticPaths(options.home)
  const nowMs = options.nowMs ?? Date.now()
  try {
    const flag = regularFile(paths.flag)
    if (flag && nowMs - flag.mtimeMs > DIAG_FLAG_MAX_AGE_MS) unlinkSync(paths.flag)

    const log = regularFile(paths.log)
    if (!log || log.size <= DIAG_LOG_MAX_BYTES) return
    const rotated = regularFile(paths.rotatedLog)
    if (existsSync(paths.rotatedLog) && !rotated) return
    if (rotated) unlinkSync(paths.rotatedLog)
    renameSync(paths.log, paths.rotatedLog)
    writeFileSync(paths.log, '', { mode: 0o600 })
  } catch {
    // Maintenance is best-effort and must never break startup or /health.
  }
}

export function setHookDiagnosticsEnabled(enabled: boolean, home?: string): void {
  const paths = diagnosticPaths(home)
  ensureSafeDirectory(paths.dir)
  if (!enabled) {
    if (!existsSync(paths.flag)) return
    if (!regularFile(paths.flag)) throw new Error(`Refusing unsafe diagnostics flag: ${paths.flag}`)
    unlinkSync(paths.flag)
    return
  }
  if (existsSync(paths.flag) && !regularFile(paths.flag)) throw new Error(`Refusing unsafe diagnostics flag: ${paths.flag}`)
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const fd = openSync(paths.flag, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | noFollow, 0o600)
  closeSync(fd)
  chmodSync(paths.flag, 0o600)
}

export function hookDiagnosticsEnabled(home?: string, nowMs = Date.now()): boolean {
  const stat = regularFile(diagnosticPaths(home).flag)
  return stat !== null && nowMs - stat.mtimeMs <= DIAG_FLAG_MAX_AGE_MS
}

export function readHookDiagnosticLines(home?: string, count = 50): string[] {
  const log = diagnosticPaths(home).log
  if (!regularFile(log)) return []
  const boundedCount = Math.max(0, Math.min(Math.floor(count), 500))
  if (boundedCount === 0) return []
  return readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-boundedCount)
}
