import { afterEach, describe, expect, test } from 'bun:test'
import type { SpawnAttemptId } from '../shared/types.js'
import { PtyManager } from '../pty/manager.js'
import { SimulatorManager } from '../simulator/manager.js'
import { __test_handleMessage, __test_setCachedAgents } from '../ws/client.js'

const attemptA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as SpawnAttemptId
const attemptB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SpawnAttemptId
const realProcessKill = process.kill

afterEach(() => { process.kill = realProcessKill })

describe('daemon exact-generation spawn cancellation', () => {
  test('production spawn dispatcher cancellation at the pre-handle barrier creates no handle or roster residue', async () => {
    const manager = new PtyManager()
    const simulator = new SimulatorManager('daemon-1')
    const frames: Array<Record<string, unknown>> = []
    const ws = {
      readyState: 1,
      send: (value: string) => { frames.push(JSON.parse(value)) },
    } as never
    __test_setCachedAgents([{
      key: 'sh', displayName: 'Shell', binaryPath: '/bin/sh', authStatus: 'authenticated',
    }])
    let release!: () => void
    let entered!: () => void
    const enteredBarrier = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    let spawnCalls = 0
    const originalSpawn = manager.spawn.bind(manager)
    manager.spawn = ((...args: Parameters<PtyManager['spawn']>) => {
      spawnCalls++
      return originalSpawn(...args)
    }) as PtyManager['spawn']

    const dispatch = __test_handleMessage({
      type: 'spawn', agentId: 'panel-1', daemonId: 'daemon-1', agentKey: 'sh',
      cols: 80, rows: 24, spawnAttemptId: attemptA,
    }, ws, manager, {} as never, simulator, {
      beforeManagerSpawn: async () => { entered(); await barrier },
    })
    await enteredBarrier
    expect(frames.filter(frame => frame.type === 'session_started')).toHaveLength(1)
    expect(manager.cancelSpawnAttempt('panel-1', attemptA, true)).toBe('prevented')
    release()
    await dispatch

    expect(spawnCalls).toBe(0)
    expect(manager.getLiveAgentIds()).toEqual([])
    expect(manager.getLivePanels()).toEqual([])
    expect((manager as any).sessionIdToAgentId.size).toBe(0)
    expect(frames.filter(frame => frame.type === 'agent_spawned')).toEqual([])
  })

  test('fresh Codex spawn does not emit a synthetic session id before native capture', async () => {
    const manager = new PtyManager()
    const simulator = new SimulatorManager('daemon-1')
    const frames: Array<Record<string, unknown>> = []
    const ws = {
      readyState: 1,
      send: (value: string) => { frames.push(JSON.parse(value)) },
    } as never
    __test_setCachedAgents([{
      key: 'codex', displayName: 'Codex', binaryPath: '/bin/sh', authStatus: 'authenticated',
    }])
    let release!: () => void
    let entered!: () => void
    const enteredBarrier = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })

    const dispatch = __test_handleMessage({
      type: 'spawn', agentId: 'codex-panel', daemonId: 'daemon-1', agentKey: 'codex',
      cols: 80, rows: 24, spawnAttemptId: attemptA,
    }, ws, manager, {} as never, simulator, {
      beforeManagerSpawn: async () => { entered(); await barrier },
    })
    await enteredBarrier
    expect(frames.filter(frame => frame.type === 'session_started')).toEqual([])
    expect(manager.cancelSpawnAttempt('codex-panel', attemptA, true)).toBe('prevented')
    release()
    await dispatch
  })

  test('parse-time tombstone prevents a later matching PTY spawn without touching node-pty', () => {
    const manager = new PtyManager()
    expect(manager.cancelSpawnAttempt('panel-1', attemptA)).toBe('prevented')
    expect(manager.cancelSpawnAttempt('panel-1', attemptA)).toBe('already_cancelled')
    expect(manager.spawn('panel-1', 'sh', '/bin/sh', [], 80, 24, () => {}, () => {}, undefined, attemptA)).toBe(false)
  })

  test('an earlier generation tombstone does not block a later generation', () => {
    const manager = new PtyManager()
    manager.cancelSpawnAttempt('panel-1', attemptA)
    expect(manager.isSpawnAttemptCancelled('panel-1', attemptA)).toBe(true)
    expect(manager.isSpawnAttemptCancelled('panel-1', attemptB)).toBe(false)
  })

  test('kills one matching live handle once and excludes it from the roster', () => {
    const manager = new PtyManager()
    let fallbackKills = 0
    let exits = 0
    process.kill = (() => true) as typeof process.kill
    ;(manager as any).handles.set('panel-1', {
      agentId: 'panel-1', spawnAttemptId: attemptA, agentKey: 'sh', pid: 99,
      process: { kill: () => { fallbackKills++ } }, killed: false, instanceId: 1,
      spawnEnv: {}, onExit: () => { exits++ },
    })

    expect(manager.cancelSpawnAttempt('panel-1', attemptA)).toBe('killed')
    expect(manager.cancelSpawnAttempt('panel-1', attemptA)).toBe('already_cancelled')
    expect(exits).toBe(1)
    expect(fallbackKills).toBe(0)
    expect(manager.getLiveAgentIds()).toEqual([])
  })

  test('cancel A cannot kill a current B handle', () => {
    const manager = new PtyManager()
    let exits = 0
    ;(manager as any).handles.set('panel-1', {
      agentId: 'panel-1', spawnAttemptId: attemptB, agentKey: 'sh', pid: 100,
      process: { kill: () => {} }, killed: false, instanceId: 1,
      spawnEnv: {}, onExit: () => { exits++ },
    })
    expect(manager.cancelSpawnAttempt('panel-1', attemptA)).toBe('prevented')
    expect(manager.getSpawnAttemptId('panel-1')).toBe(attemptB)
    expect(exits).toBe(0)
  })

  test('fails safe for a legacy generationless spawn', () => {
    const manager = new PtyManager()
    expect(manager.spawn('panel-legacy', 'sh', '/bin/sh', [], 80, 24, () => {}, () => {})).toBe(false)
  })
})

describe('simulator exact-generation spawn cancellation', () => {
  test('pre-handle cancellation clears exact pending UDID, subscription, and daemon boot ownership', () => {
    const shutdowns: string[] = []
    const manager = new SimulatorManager('daemon-1', undefined, async () => ({ checks: [], udid: null }), udid => shutdowns.push(udid))
    ;(manager as any).pendingUdids.set('udid-a', { agentId: 'sim-a', spawnAttemptId: attemptA })
    ;(manager as any).pendingSubscriptions.set('sim-a', attemptA)
    ;(manager as any).pendingDaemonBootedUdids.set('udid-a', { agentId: 'sim-a', spawnAttemptId: attemptA })
    ;(manager as any).bootedUdidsByAgent.set('sim-a', { udid: 'udid-a', spawnAttemptId: attemptA })

    expect(manager.cancelSpawnAttempt('sim-a', attemptA)).toBe('prevented')
    expect((manager as any).pendingUdids.size).toBe(0)
    expect((manager as any).pendingSubscriptions.has('sim-a')).toBe(false)
    expect((manager as any).pendingDaemonBootedUdids.has('udid-a')).toBe(false)
    expect((manager as any).bootedUdidsByAgent.has('sim-a')).toBe(false)
    expect(shutdowns).toEqual(['udid-a'])
  })

  test('kills a matching simulator once while leaving another generation untouched', () => {
    const manager = new SimulatorManager('daemon-1')
    const sent: string[] = []
    manager.updateWs({ readyState: 1, send: (value: string) => sent.push(value) } as never)
    ;(manager as any).sessions.set('sim-a', {
      agentId: 'sim-a', spawnAttemptId: attemptA, udid: 'udid-a', frameInterval: null,
      capturing: false, subscribed: false, lastDescribeAt: 0, daemonBooted: false,
    })
    ;(manager as any).sessions.set('sim-b', {
      agentId: 'sim-b', spawnAttemptId: attemptB, udid: 'udid-b', frameInterval: null,
      capturing: false, subscribed: false, lastDescribeAt: 0, daemonBooted: false,
    })

    expect(manager.cancelSpawnAttempt('sim-a', attemptA)).toBe('killed')
    expect(manager.cancelSpawnAttempt('sim-a', attemptA)).toBe('already_cancelled')
    expect((manager as any).sessions.has('sim-a')).toBe(false)
    expect((manager as any).sessions.get('sim-b')?.spawnAttemptId).toBe(attemptB)
    expect(sent.map(value => JSON.parse(value))).toEqual([{
      type: 'exit', agentId: 'sim-a', spawnAttemptId: attemptA, exitCode: 0, signal: null,
    }])
  })
})
