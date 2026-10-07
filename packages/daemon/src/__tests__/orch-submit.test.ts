import { describe, test, expect, mock, beforeEach, afterEach, afterAll, jest } from 'bun:test'
import WebSocket from 'ws'

// Mock heavy module-level side effects in client.ts so the module can be imported in unit tests
// without spinning up filesystem watchers, global singletons, etc.
//
// #505/#552: require() bypasses Bun's mock.module registry and always
// returns the real module, even after mocking is active — the only safe
// snapshot source both for filling in a partial mock and for undoing it
// later. Every module below has more real exports than this file supplies
// (e.g. claude-usage.js has 7, only 1 is mocked here), so a bare
// replacement permanently shadows the rest for any test file that runs
// later in the same `bun test` process.
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
  // Both probes are stubbed: the point is that the ready path must not open a real
  // pty during tests. isSpawnHelperHealthy is the old name kept for compatibility;
  // canSpawnPty is what the daemon calls now, and it really spawns.
  isSpawnHelperHealthy: mock(() => true),
  canSpawnPty: mock(() => true),
  isSpawnHelperExecutable: mock(() => true),
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

import {
  emitOrchSubmitState,
  checkSubmitFailedOnExit,
  buildSubmitFailedPayload,
  buildPermissionsChangedNudge,
  injectApplyNotice,
  resetOrchTestState,
  __test_rolePromptDeliveryAtSpawn,
  __test_deliverOrchestratorCommand,
  __test_scheduleTuiReadyFlush,
} from '../ws/client.js'
import { AGENT_SPECS } from '../pty/agents.js'

function makeMockWs(readyState = WebSocket.OPEN): WebSocket {
  const sent: unknown[] = []
  const ws = {
    readyState,
    send: mock((data: unknown) => { sent.push(data) }),
    _sent: sent,
  } as unknown as WebSocket
  return ws
}

describe('emitOrchSubmitState', () => {
  test("emits 'buffering' payload when ws is OPEN", () => {
    const ws = makeMockWs()
    emitOrchSubmitState(ws, 'agent-a', 'buffering')
    expect((ws as any)._sent).toEqual([
      JSON.stringify({ type: 'orch_submit_state', agentId: 'agent-a', state: 'buffering' }),
    ])
  })

  test("emits 'pending' payload", () => {
    const ws = makeMockWs()
    emitOrchSubmitState(ws, 'agent-b', 'pending')
    expect((ws as any)._sent).toEqual([
      JSON.stringify({ type: 'orch_submit_state', agentId: 'agent-b', state: 'pending' }),
    ])
  })

  test('does not send when ws is not OPEN', () => {
    const ws = makeMockWs(WebSocket.CLOSED)
    emitOrchSubmitState(ws, 'agent-c', 'forced')
    expect((ws as any)._sent).toEqual([])
  })

  test('does not throw when ws is undefined', () => {
    expect(() => emitOrchSubmitState(undefined, 'agent-d', 'submitted')).not.toThrow()
  })
})

describe('Phase 6F permission-change nudge', () => {
  test('builds the required trusted notice with the new capability version', () => {
    const notice = buildPermissionsChangedNudge(9)
    expect(notice).toStartWith('[BRIDGE-ORCH] Permissions changed')
    expect(notice).toContain('capabilitiesVersion=9')
    expect(notice).toContain('bridge_get_session_context')
    expect(notice).toContain('do not retry or attempt to work around it')
  })

  test('uses the same apply-notice TUI delivery path as role_apply', () => {
    const writes: unknown[][] = []
    const manager = {
      getAgentKey: () => 'ollama',
      write: (...args: unknown[]) => { writes.push(args) },
    }
    const notice = buildPermissionsChangedNudge(4)

    expect(injectApplyNotice('panel-1', notice, manager as never)).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[0]).toBe('panel-1')
    expect(Buffer.from(String(writes[0]?.[1]), 'base64').toString()).toBe(notice)
    expect(writes[0]?.[2]).toBe('orchestrator')
  })
})

describe('Issue #83 role trust delivery', () => {
  test('every affected agent receives BRIDGE_ORCH_TRUST through a readiness-aware spawn-time channel', () => {
    const affected = ['opencode', 'agy', 'forge', 'ollama', 'copilot']
    const uncovered = affected.filter(agentKey => {
      const delivery = __test_rolePromptDeliveryAtSpawn(agentKey)
      if (delivery.args.join('\n').includes('[Bridge orchestration]')) return false
      if (!delivery.postSpawnInput?.includes('[Bridge orchestration]')) return true

      const tui = AGENT_SPECS.find(spec => spec.key === agentKey)?.tui
      return !(tui?.protocolReadyProvider || tui?.readySignals?.length || tui?.submitMode === 'cr')
    })

    expect(uncovered).toEqual([])
  })

  test('a dispatch during the readiness settle window stays behind the trust turn', () => {
    jest.useFakeTimers()
    const agentId = 'test-ollama-ready-fifo'
    const writes: string[] = []
    const ws = makeMockWs()
    const manager = {
      getAgentKey: () => 'ollama',
      getPanelInstanceId: () => 1,
      getCurrentWs: () => ws,
      setPanelStartupGateState: mock(() => {}),
      write: (_agentId: string, data: string) => {
        writes.push(Buffer.from(data, 'base64').toString('utf8'))
        return true
      },
    }

    try {
      __test_deliverOrchestratorCommand(agentId, 'ollama', 'trust turn', manager as never, ws)
      __test_scheduleTuiReadyFlush(agentId, 'ollama', manager as never)
      __test_deliverOrchestratorCommand(agentId, 'ollama', 'later dispatch', manager as never, ws)

      expect(writes).toEqual([])
      jest.advanceTimersByTime(500)
      expect(writes).toEqual(['trust turn', 'later dispatch'])
    } finally {
      resetOrchTestState(agentId)
      jest.useRealTimers()
    }
  })

  test.each([
    ['agy', 'cr-inline'],
    ['ollama', 'lf'],
  ])('readiness-gated %s/%s dispatch acknowledges its dispatchId after the queue drains', (agentKey) => {
    jest.useFakeTimers()
    const agentId = `test-${agentKey}-dispatch-ack`
    const dispatchId = `dispatch-${agentKey}`
    const ws = makeMockWs()
    const manager = {
      getAgentKey: () => agentKey,
      getPanelInstanceId: () => 1,
      getCurrentWs: () => ws,
      setPanelStartupGateState: mock(() => {}),
      write: mock(() => true),
    }

    try {
      __test_deliverOrchestratorCommand(agentId, agentKey, 'queued turn', manager as never, ws, dispatchId)
      expect((ws as any)._sent.map((raw: string) => JSON.parse(raw))).toContainEqual({
        type: 'orch_submit_state',
        agentId,
        state: 'buffering',
        dispatchId,
      })

      __test_scheduleTuiReadyFlush(agentId, agentKey, manager as never)
      jest.advanceTimersByTime(500)

      expect(manager.write).toHaveBeenCalledTimes(1)
      expect((ws as any)._sent.map((raw: string) => JSON.parse(raw))).toContainEqual({
        type: 'orch_submit_state',
        agentId,
        state: 'submitted',
        dispatchId,
      })
    } finally {
      resetOrchTestState(agentId)
      jest.useRealTimers()
    }
  })

  test('readiness-gated terminal write failure answers the same dispatchId with pty_dead', () => {
    jest.useFakeTimers()
    const agentId = 'test-agy-dispatch-failed'
    const dispatchId = 'dispatch-failed'
    const ws = makeMockWs()
    const manager = {
      getAgentKey: () => 'agy',
      getPanelInstanceId: () => 1,
      getCurrentWs: () => ws,
      setPanelStartupGateState: mock(() => {}),
      write: mock(() => false),
    }

    try {
      __test_deliverOrchestratorCommand(agentId, 'agy', 'queued turn', manager as never, ws, dispatchId)
      __test_scheduleTuiReadyFlush(agentId, 'agy', manager as never)
      jest.advanceTimersByTime(500)

      expect((ws as any)._sent.map((raw: string) => JSON.parse(raw))).toContainEqual({
        type: 'pty_dead',
        agentId,
        dispatchId,
      })
    } finally {
      resetOrchTestState(agentId)
      jest.useRealTimers()
    }
  })
})

describe('buildSubmitFailedPayload', () => {
  test('returns the expected schema', () => {
    const payload = buildSubmitFailedPayload('agent-x', 2, true, ['id-1'])
    expect(payload).toEqual({
      type: 'submit_failed',
      agentId: 'agent-x',
      reason: 'agent_exited',
      queuedCount: 2,
      retryActive: true,
      dispatchIds: ['id-1'],
    })
  })
})

describe('checkSubmitFailedOnExit', () => {
  afterEach(() => {
    resetOrchTestState('agent-queued')
    resetOrchTestState('agent-retry-only')
    resetOrchTestState('agent-clean')
  })

  test('returns payload when orchPendingInput has entries', () => {
    const payload = checkSubmitFailedOnExit('agent-queued', { queued: [{ data: 'a', dispatchId: 'id-a' }, { data: 'b' }] })
    expect(payload).not.toBeNull()
    expect(payload?.type).toBe('submit_failed')
    expect(payload?.reason).toBe('agent_exited')
    expect(payload?.queuedCount).toBe(2)
    expect(payload?.retryActive).toBe(false)
    expect(payload?.dispatchIds).toEqual(['id-a'])
  })

  test('returns payload when only retry timer is active (no queued input)', () => {
    const payload = checkSubmitFailedOnExit('agent-retry-only', { retryActive: true, dispatchIds: ['id-r'] })
    expect(payload).not.toBeNull()
    expect(payload?.queuedCount).toBe(0)
    expect(payload?.retryActive).toBe(true)
    expect(payload?.dispatchIds).toEqual(['id-r'])
  })

  test('returns null when nothing is buffered or retrying', () => {
    const payload = checkSubmitFailedOnExit('agent-clean')
    expect(payload).toBeNull()
  })
})
