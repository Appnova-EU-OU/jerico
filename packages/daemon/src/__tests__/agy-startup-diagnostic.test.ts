import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AGY_STARTUP_DIAGNOSTIC_MAX_BYTES,
  AgyStartupDiagnostic,
  isAgyStartupDiagnosticEnabled,
  type AgyStartupDiagnosticStopReason,
} from '../pty/agy-startup-diagnostic'

const tempDirs: string[] = []

function makeDiagnostic(enabled = true): { diagnostic: AgyStartupDiagnostic; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jerico-agy-startup-'))
  tempDirs.push(root)
  return {
    root,
    diagnostic: new AgyStartupDiagnostic({
      enabled,
      artifactDir: path.join(root, 'diagnostics'),
      homePath: '/Users/private-user',
      makeCorrelationId: () => '11111111-1111-4111-8111-111111111111',
    }),
  }
}

function binding(agentId = 'agy-one', panelInstanceId = 7) {
  return { agentId, panelInstanceId, providerVersion: '1.1.21', rows: 24, cols: 80 }
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('one-shot Agy startup diagnostic', () => {
  test('refuses the unnamed production profile even with the exact opt-in', () => {
    expect(isAgyStartupDiagnosticEnabled(null, '1')).toBe(false)
  })

  test('allows a named testenv profile with the exact opt-in', () => {
    expect(isAgyStartupDiagnosticEnabled('testenv', '1')).toBe(true)
  })

  test('refuses a named profile without the exact opt-in', () => {
    expect(isAgyStartupDiagnosticEnabled('testenv', undefined)).toBe(false)
    expect(isAgyStartupDiagnosticEnabled('testenv', 'true')).toBe(false)
  })

  test('is disabled by default/config and writes no artifact', () => {
    const { diagnostic, root } = makeDiagnostic(false)
    expect(diagnostic.bind(binding())).toBe(false)
    diagnostic.observe('agy-one', 7, Buffer.from('output'))
    expect(diagnostic.stop('exit')).toBeNull()
    expect(statSync(root).isDirectory()).toBe(true)
  })

  test('binds exactly one panel instance and never captures another panel', () => {
    const { diagnostic } = makeDiagnostic()
    expect(diagnostic.bind(binding())).toBe(true)
    expect(diagnostic.bind(binding('agy-two', 8))).toBe(false)
    diagnostic.observe('agy-two', 8, Buffer.from('must-not-appear'))
    diagnostic.observe('agy-one', 6, Buffer.from('stale-instance'))
    diagnostic.observe('agy-one', 7, Buffer.from('captured-output'))
    const artifactPath = diagnostic.stop('exit', 'agy-one', 7)!
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
    expect(Buffer.from(artifact.rawBase64, 'base64').toString()).toBe('captured-output')
    expect(diagnostic.bind(binding('agy-three', 9))).toBe(false)
  })

  test('caps raw output strictly at 32 KiB and preserves chunk boundaries', () => {
    const { diagnostic } = makeDiagnostic()
    diagnostic.bind(binding())
    diagnostic.observe('agy-one', 7, Buffer.alloc(20_000, 0x61))
    diagnostic.observe('agy-one', 7, Buffer.alloc(20_000, 0x62))
    const artifactPath = diagnostic.getStateForTest().lastArtifactPath!
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
    expect(artifact.stopReason).toBe('byte_cap')
    expect(artifact.byteLength).toBe(AGY_STARTUP_DIAGNOSTIC_MAX_BYTES)
    expect(artifact.chunkBoundaries).toEqual([
      { offset: 0, length: 20_000 },
      { offset: 20_000, length: AGY_STARTUP_DIAGNOSTIC_MAX_BYTES - 20_000 },
    ])
  })

  test('closes deterministically for every lifecycle stop reason with mode 0600', () => {
    const reasons: AgyStartupDiagnosticStopReason[] = [
      'blocker', 'ready', 'ready_timeout', 'exit', 'duration_cap', 'byte_cap',
    ]
    for (const [index, reason] of reasons.entries()) {
      const root = mkdtempSync(path.join(os.tmpdir(), 'jerico-agy-stop-'))
      tempDirs.push(root)
      const diagnostic = new AgyStartupDiagnostic({
        enabled: true,
        artifactDir: root,
        homePath: '/Users/private-user',
        makeCorrelationId: () => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
      })
      diagnostic.bind(binding(`agy-${index}`, index + 1))
      diagnostic.observe(`agy-${index}`, index + 1, Buffer.from('x'))
      const artifactPath = diagnostic.stop(reason, `agy-${index}`, index + 1)!
      expect(JSON.parse(readFileSync(artifactPath, 'utf8')).stopReason).toBe(reason)
      expect(statSync(artifactPath).mode & 0o777).toBe(0o600)
      expect(diagnostic.stop(reason)).toBeNull()
    }
  })

  test('keeps raw bytes local while redacting every required shape from human-readable views', () => {
    const { diagnostic } = makeDiagnostic()
    const output = [
      '\u001b[31muser@example.com\u001b[0m',
      'https://example.com/login?code=private',
      'Bearer AbCdEf0123456789.private-token',
      'sk-ant-api03-abcdefghijklmnopqrstuv123456',
      '550e8400-e29b-41d4-a716-446655440000',
      '/Users/private-user/projects/secret',
      '/Volumes/private-disk/startup/evidence',
      'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    ].join(' ')
    diagnostic.bind(binding())
    diagnostic.observe('agy-one', 7, Buffer.from(output))
    const artifactPath = diagnostic.stop('exit')!
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))

    expect(Buffer.from(artifact.rawBase64, 'base64').toString()).toBe(output)
    for (const view of [artifact.escapedControlView, artifact.ansiStrippedNormalizedView]) {
      expect(view).not.toContain('user@example.com')
      expect(view).not.toContain('private-token')
      expect(view).not.toContain('/Users/private-user')
      expect(view).not.toContain('/Volumes/private-disk')
      expect(view).toContain('[REDACTED_')
    }
    expect(artifact.redactionCounts.email).toBeGreaterThan(0)
    expect(artifact.redactionCounts.url).toBeGreaterThan(0)
    expect(artifact.redactionCounts.bearerOrApiToken).toBeGreaterThan(0)
    expect(artifact.redactionCounts.uuid).toBeGreaterThan(0)
    expect(artifact.redactionCounts.absolutePath).toBeGreaterThan(0)
    expect(artifact.redactionCounts.highEntropy).toBeGreaterThan(0)
    expect(artifact).not.toHaveProperty('input')
    expect(artifact).not.toHaveProperty('env')
    expect(artifact).not.toHaveProperty('args')
    expect(artifact).not.toHaveProperty('cwd')
  })

  test('client integration observes capture only in the PTY output path, never the input branch', () => {
    const source = readFileSync(path.join(import.meta.dir, '..', 'ws', 'client.ts'), 'utf8')
    const inputBranch = source.slice(source.indexOf("case 'input':"), source.indexOf("case 'kill':"))
    expect(source).toContain('getProcessAgyStartupDiagnostic().observe')
    expect(inputBranch).not.toContain('getProcessAgyStartupDiagnostic')
  })
})
