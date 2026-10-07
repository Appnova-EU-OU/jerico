import { describe, test, expect, mock, beforeEach, afterEach, afterAll, jest } from 'bun:test'
import WebSocket from 'ws'
import {
  __test_recordOutput as recordOutput,
  __test_flushOrchPendingInput as flushOrchPendingInput,
  __test_deliverOrchestratorCommand as deliverOrchestratorCommand,
  resetOrchTestState,
  checkSubmitFailedOnExit,
  emitOrchSubmitState
} from '../ws/client.js'

// Need same mocks as orch-submit.test.ts
const realClaudeUsage      = { ...require('../pty/claude-usage.js') }
const realClaudeQuota      = { ...require('../pty/claude-quota.js') }
const realQwenQuota        = { ...require('../pty/qwen-quota.js') }
const realOpenCodeUsage    = { ...require('../pty/opencode-usage.js') }
const realKimiUsage        = { ...require('../pty/kimi-usage.js') }
const realMetrics          = { ...require('../metrics.js') }
const realLifecycleLog     = { ...require('../lifecycle-log.js') }
const realSpawnHelperHealth = { ...require('../pty/spawn-helper-health.js') }

mock.module('../pty/claude-usage.js', () => ({
  ...realClaudeUsage,
  startClaudeUsageWatcher: mock(() => () => {}),
}))
mock.module('../pty/claude-quota.js', () => ({
  ...realClaudeQuota,
  startClaudeQuotaWatcher: mock(() => {}),
  readTier: mock(() => 'pro'),
  triggerTick: mock(() => {}),
  __internalSetTickRef: mock(() => {}),
}))
mock.module('../pty/qwen-quota.js', () => ({
  ...realQwenQuota,
  startQwenQuotaWatcher: mock(() => {}),
}))
mock.module('../pty/opencode-usage.js', () => ({
  ...realOpenCodeUsage,
  startOpenCodeUsageWatcher: mock(() => {}),
}))
mock.module('../pty/kimi-usage.js', () => ({
  ...realKimiUsage,
  startKimiUsageWatcher: mock(() => {}),
}))
mock.module('../metrics.js', () => ({
  ...realMetrics,
  startMetricsRelay: mock(() => {}),
}))
mock.module('../lifecycle-log.js', () => ({
  ...realLifecycleLog,
  logLifecycle: mock(() => {}),
}))
mock.module('../pty/spawn-helper-health.js', () => ({
  ...realSpawnHelperHealth,
  isSpawnHelperHealthy: mock(() => true),
}))

afterAll(() => {
  mock.module('../pty/claude-usage.js', () => ({ ...realClaudeUsage }))
  mock.module('../pty/claude-quota.js', () => ({ ...realClaudeQuota }))
  mock.module('../pty/qwen-quota.js', () => ({ ...realQwenQuota }))
  mock.module('../pty/opencode-usage.js', () => ({ ...realOpenCodeUsage }))
  mock.module('../pty/kimi-usage.js', () => ({ ...realKimiUsage }))
  mock.module('../metrics.js', () => ({ ...realMetrics }))
  mock.module('../lifecycle-log.js', () => ({ ...realLifecycleLog }))
  mock.module('../pty/spawn-helper-health.js', () => ({ ...realSpawnHelperHealth }))
})

const originalWarn = console.warn
const originalLog = console.log

beforeEach(() => {
  console.warn = mock(() => {})
  console.log = mock(() => {})
})

afterEach(() => {
  console.warn = originalWarn
  console.log = originalLog
})

function makeMockWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: mock((data: unknown) => {}),
  } as unknown as WebSocket
}

function makeMockManager(ws: WebSocket) {
  const writes: { agentId: string, data: string, source: string }[] = []
  return {
    getAgentKey: () => undefined,
    getPanelInstanceId: () => 1,
    getCurrentWs: () => ws,
    write: (agentId: string, data: string, source: string, opts?: { raw?: boolean }) => {
      writes.push({ agentId, data, source })
      return true
    },
    _writes: writes
  } as any
}

const TUI_SUBMIT_DELAY_MS = 1000
const IDLE_THRESHOLD_MS = 3000

describe('orch submit event driven', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    resetOrchTestState('test-agent')
    jest.useRealTimers()
  })

  test('quiet panel -> idle at flush, nothing echoes, submit fires at the settle timer', () => {
    const ws = makeMockWs()
    const manager = makeMockManager(ws)
    const agentId = 'test-agent'

    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS + 100)
    manager._writes.length = 0

    checkSubmitFailedOnExit(agentId, { queued: ['bW9jaw=='] })
    flushOrchPendingInput(agentId, manager, ws)
    
    // The text was written immediately
    expect(manager._writes).toHaveLength(1)
    
    // Should fire settle timer exactly at TUI_SUBMIT_DELAY_MS
    jest.advanceTimersByTime(TUI_SUBMIT_DELAY_MS - 100)
    expect(manager._writes).toHaveLength(1)
    
    jest.advanceTimersByTime(150)
    // CR should be sent
    expect(manager._writes).toHaveLength(2)
    expect(manager._writes[1].data).toBe(Buffer.from('\r').toString('base64'))
  })

  test('echoing panel -> text written, echo makes it working, submit fires on the next idle transition and not before', () => {
    const ws = makeMockWs()
    const manager = makeMockManager(ws)
    const agentId = 'test-agent'

    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS + 100)
    manager._writes.length = 0

    checkSubmitFailedOnExit(agentId, { queued: ['bW9jaw=='] })
    flushOrchPendingInput(agentId, manager, ws)
    
    // Echo arrives quickly, making panel working
    recordOutput(agentId, () => ws, manager)

    // Settle timer fires but panel is working, should do nothing
    jest.advanceTimersByTime(TUI_SUBMIT_DELAY_MS + 100)
    expect(manager._writes).toHaveLength(1) // only text written

    // 3 seconds later, panel goes idle, should trigger event path
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS)
    expect(manager._writes).toHaveLength(2)
    expect(manager._writes[1].data).toBe(Buffer.from('\r').toString('base64'))
  })

  test('chunked echo -> two output chunks arriving 1s apart, each re-arming idle; submit must still fire exactly once, after the last one', () => {
    const ws = makeMockWs()
    const manager = makeMockManager(ws)
    const agentId = 'test-agent'

    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS + 100)
    manager._writes.length = 0

    checkSubmitFailedOnExit(agentId, { queued: ['bW9jaw=='] })
    flushOrchPendingInput(agentId, manager, ws)

    // Chunk 1
    recordOutput(agentId, () => ws, manager)

    jest.advanceTimersByTime(1000)
    
    // Chunk 2
    recordOutput(agentId, () => ws, manager)

    // Still working because IDLE_THRESHOLD_MS (3000) from Chunk 2 hasn't elapsed
    jest.advanceTimersByTime(2000)
    expect(manager._writes).toHaveLength(1)

    // After remaining 1000ms, it goes idle and fires CR
    jest.advanceTimersByTime(1100)
    expect(manager._writes).toHaveLength(2)
    expect(manager._writes[1].data).toBe(Buffer.from('\r').toString('base64'))
  })

  test('never-quiet panel -> continuous output; the force deadline fires exactly once', () => {
    const ws = makeMockWs()
    const manager = makeMockManager(ws)
    const agentId = 'test-agent'

    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS + 100)
    manager._writes.length = 0

    checkSubmitFailedOnExit(agentId, { queued: ['bW9jaw=='] })
    flushOrchPendingInput(agentId, manager, ws)

    // continuous echo every 1s, preventing idle
    for(let i=0; i<31; i++){
      recordOutput(agentId, () => ws, manager)
      jest.advanceTimersByTime(1000)
    }

    // After 30s force timer should have fired
    const crWrites = manager._writes.filter(w => w.data === Buffer.from('\r').toString('base64'))
    expect(crWrites).toHaveLength(1)
  })

  test('two queued CR dispatches stay FIFO and become two distinct turns', () => {
    const ws = makeMockWs()
    const manager = makeMockManager(ws)
    const agentId = 'test-agent'

    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS + 100)
    manager._writes.length = 0

    checkSubmitFailedOnExit(agentId, { queued: ['YmF0Y2gx', 'YmF0Y2gy'] })
    flushOrchPendingInput(agentId, manager, ws)
    
    // Single-flight: only batch 1 is written before its submit.
    expect(manager._writes).toHaveLength(1)
    expect(manager._writes[0].data).toBe('YmF0Y2gx')

    // First distinct submit.
    jest.advanceTimersByTime(TUI_SUBMIT_DELAY_MS + 100)
    expect(manager._writes).toHaveLength(2)
    expect(manager._writes[1].data).toBe(Buffer.from('\r').toString('base64'))

    // Provider output for turn 1 drives the next idle edge, which advances
    // batch 2 only after batch 1 has already been submitted.
    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS)
    expect(manager._writes).toHaveLength(3)
    expect(manager._writes[2].data).toBe('YmF0Y2gy')
    jest.advanceTimersByTime(TUI_SUBMIT_DELAY_MS)
    expect(manager._writes).toHaveLength(4)
    expect(manager._writes[3].data).toBe(Buffer.from('\r').toString('base64'))
  })

  test('idle edge that consumes turn 1 submit cannot also advance queued turn 2', () => {
    const ws = makeMockWs()
    const manager = makeMockManager(ws)
    const agentId = 'test-agent'

    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS)
    manager._writes.length = 0

    checkSubmitFailedOnExit(agentId, { queued: ['dHVybjE=', 'dHVybjI='] })
    flushOrchPendingInput(agentId, manager, ws)
    expect(manager._writes.map((write: { data: string }) => write.data)).toEqual(['dHVybjE='])

    // Turn 1 echoes, so its pending submit is consumed by the next idle edge.
    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS)
    expect(manager._writes.map((write: { data: string }) => write.data)).toEqual([
      'dHVybjE=', Buffer.from('\r').toString('base64'),
    ])

    // Only a later post-submit working→idle cycle may advance turn 2.
    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS)
    expect(manager._writes.map((write: { data: string }) => write.data)).toEqual([
      'dHVybjE=', Buffer.from('\r').toString('base64'), 'dHVybjI=',
    ])
  })

  test('arrival after turn 1 CR cannot overtake an already queued turn 2', () => {
    const ws = makeMockWs()
    const manager = makeMockManager(ws)
    const agentId = 'test-agent'

    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS)
    manager._writes.length = 0

    checkSubmitFailedOnExit(agentId, { queued: ['dHVybjE=', 'dHVybjI='] })
    flushOrchPendingInput(agentId, manager, ws)
    jest.advanceTimersByTime(TUI_SUBMIT_DELAY_MS)
    expect(manager._writes.map((write: { data: string }) => write.data)).toEqual([
      'dHVybjE=', Buffer.from('\r').toString('base64'),
    ])

    // The panel is still recorded idle and the submit marker is gone, but
    // turn 2 is older. Turn 3 must join its tail instead of writing directly.
    deliverOrchestratorCommand(agentId, 'qwen', 'turn3', manager, ws)
    expect(manager._writes.map((write: { data: string }) => write.data)).toEqual([
      'dHVybjE=', Buffer.from('\r').toString('base64'),
    ])

    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS)
    expect(manager._writes.at(-1)?.data).toBe('dHVybjI=')
  })

  test('panel exits mid-pending -> marker cleared, no CR written to a dead handle, and checkSubmitFailedOnExit still reports the pending state', () => {
    const ws = makeMockWs()
    const manager = makeMockManager(ws)
    const agentId = 'test-agent'

    recordOutput(agentId, () => ws, manager)
    jest.advanceTimersByTime(IDLE_THRESHOLD_MS + 100)
    manager._writes.length = 0

    checkSubmitFailedOnExit(agentId, { queued: ['bW9jaw=='] })
    flushOrchPendingInput(agentId, manager, ws)
    recordOutput(agentId, () => ws, manager)

    // Pending CR submit...
    // Now simulate exit check
    const failedPayload = checkSubmitFailedOnExit(agentId)
    expect(failedPayload).not.toBeNull()
    expect(failedPayload?.retryActive).toBe(true)
    
    resetOrchTestState(agentId)
    // No more marker
    const newPayload = checkSubmitFailedOnExit(agentId)
    expect(newPayload).toBeNull()
  })
})
