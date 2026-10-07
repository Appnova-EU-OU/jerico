import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnAttemptId } from '../shared/types.js'

class FakePty extends EventEmitter {
  pid = 2_147_483_646
  write(): void {}
  resize(): void {}
  destroy(): void {}
  kill(): void { this.emit('exit', { exitCode: null, signal: 'SIGTERM' }) }
  onData(handler: (data: string) => void): void { this.on('data', handler) }
  onExit(handler: (event: { exitCode: number | null; signal: number | string | null }) => void): void {
    this.on('exit', handler)
  }
  exitNaturally(): void { this.emit('exit', { exitCode: 0, signal: null }) }
}

const spawnedPtys: FakePty[] = []
const realNodePty = { ...require('node-pty') }
mock.module('node-pty', () => ({
  ...realNodePty,
  spawn: mock(() => {
    const proc = new FakePty()
    spawnedPtys.push(proc)
    return proc
  }),
}))

const { PtyManager } = await import('../pty/manager.js')
const { SimulatorManager } = await import('../simulator/manager.js')
const { __test_handleMessage, __test_setCachedAgents } = await import('../ws/client.js')

const attemptA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as SpawnAttemptId
const attemptB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SpawnAttemptId
const originalHome = process.env['HOME']
let testHome = ''

beforeEach(() => {
  spawnedPtys.length = 0
  testHome = mkdtempSync(join(tmpdir(), 'jerico-617-r2-'))
  process.env['HOME'] = testHome
})

afterEach(() => {
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  rmSync(testHome, { recursive: true, force: true })
})

afterAll(() => {
  mock.module('node-pty', () => ({ ...realNodePty }))
})

function spawn(manager: InstanceType<typeof PtyManager>, spawnAttemptId: SpawnAttemptId): boolean {
  return manager.spawn(
    'panel-r2', 'agy', '/bin/agy', [], 80, 24,
    () => {}, () => {}, undefined, spawnAttemptId,
  )
}

describe('#617 round 2 — generation-safe retention', () => {
  test('same-agentId respawn preserves generation B metadata and settled MCP state', () => {
    const manager = new PtyManager()
    expect(spawn(manager, attemptA)).toBe(true)
    manager.setPanelMeta('panel-r2', {
      agentId: 'panel-r2', spawnAttemptId: attemptA, agentKey: 'agy',
    })

    // Production order: client.ts caches B before manager.spawn replaces A.
    manager.setPanelMeta('panel-r2', {
      agentId: 'panel-r2', spawnAttemptId: attemptB, agentKey: 'agy',
    })
    expect(spawn(manager, attemptB)).toBe(true)
    manager.setPanelMcpConfigured('panel-r2', attemptB, true)

    expect(manager.getLivePanels()).toEqual([
      expect.objectContaining({
        agentId: 'panel-r2', spawnAttemptId: attemptB, mcpConfigured: true,
      }),
    ])
  })

  test('generation A natural exit cannot delete prefetched generation B metadata', () => {
    const manager = new PtyManager()
    expect(spawn(manager, attemptA)).toBe(true)
    manager.setPanelMeta('panel-r2', {
      agentId: 'panel-r2', spawnAttemptId: attemptA, agentKey: 'agy',
    })

    manager.setPanelMeta('panel-r2', {
      agentId: 'panel-r2', spawnAttemptId: attemptB, agentKey: 'agy',
    })
    spawnedPtys[0]?.exitNaturally()
    expect(spawn(manager, attemptB)).toBe(true)
    manager.setPanelMcpConfigured('panel-r2', attemptB, false)

    expect(manager.getLivePanels()).toEqual([
      expect.objectContaining({
        agentId: 'panel-r2', spawnAttemptId: attemptB, mcpConfigured: false,
      }),
    ])
  })

  test('the production spawn handler retains the settled MCP verdict', async () => {
    __test_setCachedAgents([{
      key: 'sh', displayName: 'Shell', binaryPath: '/bin/sh', authStatus: 'authenticated',
    }])
    const manager = new PtyManager()
    spyOn(manager, 'spawn').mockReturnValue(true)
    const retain = spyOn(manager, 'setPanelMcpConfigured')
    const ws = {
      readyState: 1,
      send: (_value: string): void => {},
    } as unknown as WebSocket

    await __test_handleMessage({
      type: 'spawn', agentId: 'panel-wiring', daemonId: 'daemon-1',
      spawnAttemptId: attemptA, agentKey: 'sh', cols: 80, rows: 24,
    }, ws, manager, {
      token: 'test', projectPaths: {}, projectPathSources: {},
    }, new SimulatorManager('daemon-1'))

    expect(retain).toHaveBeenCalledWith('panel-wiring', attemptA, false)
  })
})
