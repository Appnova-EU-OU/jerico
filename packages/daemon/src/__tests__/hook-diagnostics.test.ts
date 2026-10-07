import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DIAG_FLAG_MAX_AGE_MS,
  DIAG_LOG_MAX_BYTES,
  diagnosticPaths,
  maintainHookDiagnostics,
  readHookDiagnosticLines,
  setHookDiagnosticsEnabled
} from '../hooks/diagnostics.js'
import { runHookDiag } from '../commands/hook-diag.js'
import { readFileSync as readSource } from 'node:fs'
import { spawnSync } from 'node:child_process'

describe('hook diagnostics maintenance and discovery', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jerico-hook-diag-'))
  })

  afterEach(() => rmSync(home, { recursive: true, force: true }))

  test('rotates one bounded log and removes an expired regular flag', () => {
    const paths = diagnosticPaths(home)
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.log, 'x'.repeat(DIAG_LOG_MAX_BYTES + 1), { mode: 0o600 })
    writeFileSync(paths.flag, '', { mode: 0o600 })
    const old = new Date(Date.now() - DIAG_FLAG_MAX_AGE_MS - 1_000)
    utimesSync(paths.flag, old, old)

    maintainHookDiagnostics({ home, nowMs: Date.now() })

    expect(readFileSync(paths.rotatedLog, 'utf8').length).toBe(DIAG_LOG_MAX_BYTES + 1)
    expect(lstatSync(paths.rotatedLog).isFile()).toBe(true)
    expect(existsSync(paths.log)).toBe(true)
    expect(readFileSync(paths.log, 'utf8')).toBe('')
    expect(existsSync(paths.flag)).toBe(false)
  })

  test('does not follow symlink flag or log paths', () => {
    const paths = diagnosticPaths(home)
    mkdirSync(paths.dir, { recursive: true })
    const outside = join(home, 'outside')
    writeFileSync(outside, 'unchanged')
    symlinkSync(outside, paths.flag)
    symlinkSync(outside, paths.log)

    expect(() => setHookDiagnosticsEnabled(true, home)).toThrow()
    maintainHookDiagnostics({ home })
    expect(readFileSync(outside, 'utf8')).toBe('unchanged')
  })

  test('bridge-agent hook-diag explicitly enables, reports, tails, and disables the channel', () => {
    const output: string[] = []
    const paths = diagnosticPaths(home)

    runHookDiag({ enable: true, home, write: line => output.push(line) })
    expect(lstatSync(paths.flag).isFile()).toBe(true)
    expect(output.join('\n')).toContain('enabled for 30 minutes')

    output.length = 0
    runHookDiag({ home, write: line => output.push(line) })
    expect(output.join('\n')).toContain('gate: on (flag)')

    writeFileSync(paths.log, 'ts=1 inv=a profile=dev stage=enter\nts=1 inv=a profile=dev stage=done http=202\n', { mode: 0o600 })
    output.length = 0
    runHookDiag({ home, tail: 1, write: line => output.push(line) })
    expect(output.join('\n')).toContain('stage=done http=202')
    expect(output.join('\n')).not.toContain('stage=enter')

    runHookDiag({ disable: true, home, write: line => output.push(line) })
    expect(existsSync(paths.flag)).toBe(false)
    expect(readHookDiagnosticLines(home, 10)).toHaveLength(2)

    output.length = 0
    runHookDiag({ home, write: line => output.push(line) })
    expect(output.join('\n')).toContain('gate: off')
    expect(output.join('\n')).toContain('bridge-agent hook-diag --enable')
  })

  test('the shipped CLI and daemon request path retain their diagnostic wiring', () => {
    const indexSource = readSource(join(import.meta.dir, '..', 'index.ts'), 'utf8')
    const startSource = readSource(join(import.meta.dir, '..', 'commands', 'start.ts'), 'utf8')
    expect(indexSource).toContain(".command('hook-diag')")
    expect(indexSource).toContain('runHookDiag(')
    expect(startSource).toContain('maintainHookDiagnostics()')
  })

  test('bridge-agent hook-diag exits zero on its own without hanging', () => {
    const entrypoint = join(import.meta.dir, '..', 'index.ts')
    const result = spawnSync(process.execPath, [entrypoint, 'hook-diag'], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      // Guards against open handles keeping the loop alive, not startup speed:
      // a cold transpile on a shared runner can exceed 1 s, a real hang never exits.
      timeout: 15_000
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Hook diagnostics gate: off')
  })
})
