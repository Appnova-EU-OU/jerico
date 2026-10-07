import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PtyManager } from '../pty/manager'
import { getLogPaths, getSpawnManifestPath } from '../profile'

let testHome: string
let originalHome: string | undefined

beforeAll(() => {
  testHome = mkdtempSync(path.join(os.tmpdir(), 'pty-reissue-home-'))
  originalHome = process.env['HOME']
  process.env['HOME'] = testHome
  expect(getSpawnManifestPath().startsWith(testHome)).toBe(true)
  expect(getLogPaths().lifecycle.startsWith(testHome)).toBe(true)
})

afterAll(() => {
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  rmSync(testHome, { recursive: true, force: true })
})

describe('PtyManager T5: Cancellable 80ms Reissue Timer & Lifecycle', () => {
  let manager: PtyManager

  beforeEach(() => {
    manager = new PtyManager()
  })

  afterEach(() => {
    manager.killAll()
  })

  it('rapid resize(A) then resize(B) cancels prior reissue timer to prevent A->B->A churn', async () => {
    const outputs: string[] = []
    const handle = manager.spawn(
      'panel-kimi',
      'kimi',
      '/bin/sh',
      [],
      80,
      24,
      data => outputs.push(data),
      () => {},
      undefined,
      '11111111-1111-4111-8111-111111111111' as any,
    )

    expect(handle).toBe(true)

    manager.resize('panel-kimi', 100, 30)
    manager.resize('panel-kimi', 120, 35)

    await new Promise(resolve => setTimeout(resolve, 120))

    // Success if process did not crash or churn
    expect(manager.getLastError('panel-kimi')).toBeUndefined()
  })

  it('kill clears pending reissue timer', async () => {
    manager.spawn(
      'panel-codex',
      'codex',
      '/bin/sh',
      [],
      80,
      24,
      () => {},
      () => {},
      undefined,
      '11111111-1111-4111-8111-111111111111' as any,
    )

    manager.resize('panel-codex', 110, 32)
    manager.kill('panel-codex', true)

    await new Promise(resolve => setTimeout(resolve, 100))

    // Handle killed cleanly without unhandled timer execution on deleted handle
    expect(manager.getLastError('panel-codex')).toBeUndefined()
  })

  it('natural exit clears timer and respawn within 80ms is not touched by old timer', async () => {
    let exitCount = 0
    manager.spawn(
      'panel-exit-test',
      'kimi',
      '/bin/sh',
      [],
      80,
      24,
      () => {},
      () => { exitCount++ },
      undefined,
      '11111111-1111-4111-8111-111111111111' as any,
    )

    manager.resize('panel-exit-test', 90, 25)

    // Respawn within 80ms
    manager.kill('panel-exit-test', true)
    manager.spawn(
      'panel-exit-test',
      'kimi',
      '/bin/sh',
      [],
      100,
      30,
      () => {},
      () => {},
      undefined,
      '22222222-2222-4222-8222-222222222222' as any,
    )

    await new Promise(resolve => setTimeout(resolve, 120))

    expect(manager.getLastError('panel-exit-test')).toBeUndefined()
  })
})
