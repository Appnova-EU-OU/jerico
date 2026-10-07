import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnAttemptId } from '../shared/types.js'

class FakePty extends EventEmitter {
  pid: number

  constructor(pid: number) {
    super()
    this.pid = pid
  }

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
    const proc = new FakePty(2_000_000_000 + spawnedPtys.length)
    spawnedPtys.push(proc)
    return proc
  }),
}))

const { PtyManager } = await import('../pty/manager.js')
const { OrchestratorEventBroker } = await import('../events/broker.js')
const { OrchestratorEventPoller } = await import('../events/poller.js')
const { subscriberIdFor } = await import('../events/route.js')

type Manager = InstanceType<typeof PtyManager>
type Broker = InstanceType<typeof OrchestratorEventBroker>
type Poller = InstanceType<typeof OrchestratorEventPoller>
type RetirementReason = 'exit' | 'kill' | 'liveness' | 'spawn_cancel'

const ATTEMPT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as SpawnAttemptId
const ATTEMPT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SpawnAttemptId
const originalHome = process.env['HOME']
const realKill = process.kill
let testHome = ''

beforeEach(() => {
  spawnedPtys.length = 0
  testHome = mkdtempSync(join(tmpdir(), 'jerico-619-'))
  process.env['HOME'] = testHome
  process.kill = mock(() => true) as unknown as typeof process.kill
})

afterEach(() => {
  process.kill = realKill
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  rmSync(testHome, { recursive: true, force: true })
})

afterAll(() => {
  mock.module('node-pty', () => ({ ...realNodePty }))
})

function spawn(manager: Manager, agentId: string, attempt: SpawnAttemptId = ATTEMPT_A): FakePty {
  expect(manager.spawn(
    agentId, 'claude', '/bin/claude', [], 80, 24,
    () => {}, () => {}, undefined, attempt,
  )).toBe(true)
  return spawnedPtys.at(-1)!
}

function runLivenessSweep(manager: Manager): void {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  let sweep: (() => void) | undefined
  globalThis.setInterval = ((fn: () => void) => {
    sweep = fn
    return { unref() {} }
  }) as unknown as typeof setInterval
  globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval
  process.kill = mock(() => false) as unknown as typeof process.kill
  try {
    manager.startLivenessCheck()
    expect(sweep).toBeDefined()
    sweep!()
    manager.stopLivenessCheck()
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

function retire(manager: Manager, proc: FakePty, agentId: string, reason: RetirementReason): void {
  switch (reason) {
    case 'exit':
      proc.exitNaturally()
      break
    case 'kill':
      manager.kill(agentId, true)
      break
    case 'liveness':
      runLivenessSweep(manager)
      break
    case 'spawn_cancel':
      expect(manager.cancelSpawnAttempt(agentId, ATTEMPT_A)).toBe('killed')
      break
  }
}

function bindGenerationRelease(manager: Manager): {
  broker: Broker
  poller: Poller
  leases: Map<string, symbol>
  retired: Array<{ agentId: string; instanceId: number; reason: string }>
} {
  const broker = new OrchestratorEventBroker()
  const poller = new OrchestratorEventPoller(broker, {
    setTimeout: () => Symbol('timer'),
    clearTimeout: () => {},
  })
  const leases = new Map<string, symbol>()
  const retired: Array<{ agentId: string; instanceId: number; reason: string }> = []

  ;(manager as Manager & {
    onGenerationRetired?: (agentId: string, instanceId: number, reason: string) => void
  }).onGenerationRetired = (agentId, instanceId, reason) => {
    retired.push({ agentId, instanceId, reason })
    const subscriberId = subscriberIdFor(agentId, instanceId)
    poller.releaseWaiter(subscriberId)
    leases.delete(subscriberId)
    broker.forget(subscriberId)
  }

  return { broker, poller, leases, retired }
}

function attachAndPark(
  broker: Broker,
  poller: Poller,
  leases: Map<string, symbol>,
  agentId: string,
  instanceId: number,
): string {
  const subscriberId = subscriberIdFor(agentId, instanceId)
  const { lease } = broker.attach(subscriberId)
  leases.set(subscriberId, lease)
  void poller.poll(subscriberId, lease)
  expect(poller.waitingCount()).toBe(1)
  expect(broker.heartbeat(subscriberId)).not.toBeNull()
  return subscriberId
}

function expectGenerationReleased(
  manager: Manager,
  reason: RetirementReason,
  agentId: string,
): void {
  const { broker, poller, leases, retired } = bindGenerationRelease(manager)
  const proc = spawn(manager, agentId)
  const instanceId = manager.getPanelInstanceId(agentId)!
  const subscriberId = attachAndPark(broker, poller, leases, agentId, instanceId)

  retire(manager, proc, agentId, reason)

  expect(retired).toEqual([{ agentId, instanceId, reason }])
  expect(poller.waitingCount()).toBe(0)
  expect(leases.has(subscriberId)).toBe(false)
  expect(broker.heartbeat(subscriberId)).toBeNull()
  expect(manager.getPanelInstanceId(agentId)).toBeUndefined()
  expect(manager.getPanelEventToken(agentId, instanceId)).toBeUndefined()
}

describe('#619 generation-owned event retirement', () => {
  test('natural PTY exit releases the exact generation subscription', () => {
    expectGenerationReleased(new PtyManager(), 'exit', 'panel-natural')
  })

  test('explicit kill releases the exact generation subscription', () => {
    expectGenerationReleased(new PtyManager(), 'kill', 'panel-kill')
  })

  test('liveness reap releases the exact generation subscription', () => {
    expectGenerationReleased(new PtyManager(), 'liveness', 'panel-liveness')
  })

  test('spawn cancellation releases the exact generation subscription', () => {
    expectGenerationReleased(new PtyManager(), 'spawn_cancel', 'panel-cancel')
  })

  test('a consumer restart on a live generation replays its unacked verdict', () => {
    const broker = new OrchestratorEventBroker()
    const subscriberId = subscriberIdFor('panel-live', 17)
    const first = broker.attach(subscriberId)
    expect(broker.publish(subscriberId, {
      watchId: 'watch-live',
      idempotencyKey: 'verdict-live',
      kind: 'worker.done',
      closure: 'verdict',
      payload: '[BRIDGE-ORCH] live verdict',
    })).toEqual({ published: true, seq: 1 })

    expect(broker.detach(subscriberId, first.lease)).toBe(true)
    const restarted = broker.attach(subscriberId)
    expect(restarted.records).toContainEqual(expect.objectContaining({
      type: 'event',
      seq: 1,
      payload: '[BRIDGE-ORCH] live verdict',
    }))
  })

  test('retiring A forgets its unacked state and B starts fresh on the reused agentId', () => {
    const manager = new PtyManager()
    const { broker, poller, leases } = bindGenerationRelease(manager)
    const agentId = 'panel-reused'
    const procA = spawn(manager, agentId, ATTEMPT_A)
    const instanceA = manager.getPanelInstanceId(agentId)!
    const subscriberA = subscriberIdFor(agentId, instanceA)
    const { lease: leaseA } = broker.attach(subscriberA)
    leases.set(subscriberA, leaseA)
    expect(poller.publish(subscriberA, {
      watchId: 'watch-a',
      idempotencyKey: 'verdict-a',
      kind: 'worker.done',
      closure: 'verdict',
      payload: '[BRIDGE-ORCH] verdict A',
    })).toEqual({ published: true, seq: 1 })

    procA.exitNaturally()
    expect(broker.heartbeat(subscriberA)).toBeNull()

    spawn(manager, agentId, ATTEMPT_B)
    const instanceB = manager.getPanelInstanceId(agentId)!
    expect(instanceB).not.toBe(instanceA)
    const subscriberB = subscriberIdFor(agentId, instanceB)
    const attachedB = broker.attach(subscriberB)
    expect(attachedB.records).toEqual([
      { type: 'control', control: 'attached', resumedFrom: 0 },
    ])
    expect(broker.heartbeat(subscriberB)).toEqual(expect.objectContaining({ seq: 0 }))
  })

  test('a throwing retirement callback cannot break natural exit or explicit kill', () => {
    const manager = new PtyManager()
    let callbackCalls = 0
    ;(manager as Manager & {
      onGenerationRetired?: (agentId: string, instanceId: number, reason: string) => void
    }).onGenerationRetired = () => {
      callbackCalls++
      throw new Error('injected retirement failure')
    }

    const natural = spawn(manager, 'panel-throw-natural', ATTEMPT_A)
    expect(() => natural.exitNaturally()).not.toThrow()
    expect(manager.getPanelInstanceId('panel-throw-natural')).toBeUndefined()

    spawn(manager, 'panel-throw-kill', ATTEMPT_B)
    expect(() => manager.kill('panel-throw-kill', true)).not.toThrow()
    expect(manager.getPanelInstanceId('panel-throw-kill')).toBeUndefined()
    expect(callbackCalls).toBe(2)
  })

  test('duplicate exit notifications retire a generation exactly once', () => {
    const manager = new PtyManager()
    const retired: string[] = []
    ;(manager as Manager & {
      onGenerationRetired?: (agentId: string, instanceId: number, reason: string) => void
    }).onGenerationRetired = (agentId, instanceId, reason) => {
      retired.push(`${agentId}#${instanceId}:${reason}`)
    }

    const proc = spawn(manager, 'panel-idempotent')
    proc.exitNaturally()
    proc.exitNaturally()

    expect(retired).toEqual(['panel-idempotent#1:exit'])
  })

  test('a stale A retirement cannot disturb live generation B under the same agentId', () => {
    const manager = new PtyManager()
    const internals = manager as unknown as {
      handles: Map<string, unknown>
      panelMetaMap: Map<string, { spawnAttemptId: SpawnAttemptId }>
      sessionIdToAgentId: Map<string, string>
      retireGeneration: (handle: unknown, reason: string) => boolean
    }
    const retired: Array<{ agentId: string; instanceId: number; reason: string }> = []
    manager.onGenerationRetired = (agentId, instanceId, reason) => {
      retired.push({ agentId, instanceId, reason })
    }

    const agentId = 'panel-stale-a-live-b'
    spawn(manager, agentId, ATTEMPT_A)
    const instanceA = manager.getPanelInstanceId(agentId)!
    const staleHandleA = internals.handles.get(agentId)!

    spawn(manager, agentId, ATTEMPT_B)
    const instanceB = manager.getPanelInstanceId(agentId)!
    manager.setPanelMeta(agentId, {
      agentId,
      agentKey: 'claude',
      spawnAttemptId: ATTEMPT_B,
    })
    manager.registerSessionId(agentId, 'session-b')
    retired.length = 0 // Ignore A's legitimate retirement during replacement.

    const result = internals.retireGeneration(staleHandleA, 'stale_exit_probe')

    expect({
      result,
      liveInstance: manager.getPanelInstanceId(agentId),
      metadataAttempt: internals.panelMetaMap.get(agentId)?.spawnAttemptId,
      sessionOwner: internals.sessionIdToAgentId.get('session-b'),
      retired,
    }).toEqual({
      result: false,
      liveInstance: instanceB,
      metadataAttempt: ATTEMPT_B,
      sessionOwner: agentId,
      retired: [],
    })
    expect(instanceB).not.toBe(instanceA)
  })

  test('panel event tokens are deleted by all four handle-retirement paths', () => {
    const tokenAfterRetirement: Record<RetirementReason, string | undefined> = {
      exit: undefined,
      kill: undefined,
      liveness: undefined,
      spawn_cancel: undefined,
    }

    for (const reason of Object.keys(tokenAfterRetirement) as RetirementReason[]) {
      const manager = new PtyManager()
      const agentId = `panel-token-${reason}`
      const proc = spawn(manager, agentId)
      const instanceId = manager.getPanelInstanceId(agentId)!
      expect(manager.getPanelEventToken(agentId, instanceId)).toHaveLength(64)
      retire(manager, proc, agentId, reason)
      tokenAfterRetirement[reason] = manager.getPanelEventToken(agentId, instanceId)
    }

    expect(tokenAfterRetirement).toEqual({
      exit: undefined,
      kill: undefined,
      liveness: undefined,
      spawn_cancel: undefined,
    })
  })

  test('the production composition root registers the required release sequence', () => {
    const source = readFileSync(new URL('../commands/start.ts', import.meta.url), 'utf8')
    const start = source.indexOf('manager.onGenerationRetired')
    const end = source.indexOf('// #616 Fix 1', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const registration = source.slice(start, end)
    const subscriber = registration.indexOf('subscriberIdFor(agentId, instanceId)')
    const waiter = registration.indexOf('orchestratorPoller.releaseWaiter(subscriberId)')
    const lease = registration.indexOf('orchestratorLeases.delete(subscriberId)')
    const forget = registration.indexOf('orchestratorBroker.forget(subscriberId)')
    expect(subscriber).toBeGreaterThan(-1)
    expect(waiter).toBeGreaterThan(subscriber)
    expect(lease).toBeGreaterThan(waiter)
    expect(forget).toBeGreaterThan(lease)
  })
})
