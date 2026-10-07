import { describe, expect, it, spyOn } from 'bun:test'
import type { SimHealthCheck, SpawnAttemptId } from '../shared/types.js'
import { SimulatorManager } from '../simulator/manager.js'
import { __test_handleMessage, __test_setCachedAgents } from '../ws/client.js'
import { PtyManager } from '../pty/manager.js'

const attemptA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as SpawnAttemptId
const attemptB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SpawnAttemptId

function socketFrames(): { frames: Array<Record<string, unknown>>; ws: WebSocket } {
  const frames: Array<Record<string, unknown>> = []
  return {
    frames,
    ws: { readyState: 1, send(value: string) { frames.push(JSON.parse(value)) } } as never,
  }
}

function terminalFrames(frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return frames.filter(frame => frame.type === 'error')
}

describe('spawn failure envelope', () => {
  it('returns bounded SPAWN_FAILED with agentId and never infers a helper fault from bare posix_spawnp text', async () => {
    __test_setCachedAgents([
      { key: 'sh', binaryPath: '/bin/sh' } as never,
      { key: 'ollama', binaryPath: '/usr/bin/false' } as never,
    ])

    const manager = new PtyManager()
    spyOn(manager, 'spawn').mockReturnValue(false)
    spyOn(manager, 'getLastError').mockReturnValue('posix_spawnp failed.')
    const startupGateReplay = spyOn(manager, 'emitPanelStartupGateState')
    const sent: string[] = []
    const ws = {
      readyState: 1,
      send(value: string) { sent.push(value) },
    }
    const config = { token: 'test', projectPaths: {}, projectPathSources: {} }

    for (const [agentId, agentKey, spawnAttemptId] of [
      ['shell-failure', 'sh', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['second-failure', 'ollama', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    ] as const) {
      await __test_handleMessage({
        type: 'spawn',
        agentId,
        agentKey,
        spawnAttemptId,
        cols: 80,
        rows: 24,
      } as never, ws as never, manager, config as never, { isSpawnAttemptCancelled: () => false } as never)
    }

    const errors = sent.map(value => JSON.parse(value)).filter(message => message.type === 'error')
    expect(errors).toEqual([
      { type: 'error', code: 'SPAWN_FAILED', agentId: 'shell-failure', spawnAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', message: 'Failed to spawn panel' },
      { type: 'error', code: 'SPAWN_FAILED', agentId: 'second-failure', spawnAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', message: 'Failed to spawn panel' },
    ])
    expect(JSON.stringify(errors)).not.toContain('SPAWN_HELPER_BROKEN')
    expect(JSON.stringify(errors)).not.toContain('spawn-helper')
    expect(JSON.stringify(errors)).not.toContain('posix_spawnp')
    expect(sent.map(value => JSON.parse(value)).some(message => message.type === 'agent_spawned')).toBe(false)
    expect(startupGateReplay).not.toHaveBeenCalled()
  })

  it('emits agent_spawned and replays startup gate state after a successful spawn', async () => {
    __test_setCachedAgents([{ key: 'sh', binaryPath: '/bin/sh' } as never])
    const manager = new PtyManager()
    spyOn(manager, 'spawn').mockReturnValue(true)
    const startupGateReplay = spyOn(manager, 'emitPanelStartupGateState')
    const sent: string[] = []

    await __test_handleMessage({
      type: 'spawn',
      agentId: 'shell-success',
      spawnAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      agentKey: 'sh',
      cols: 80,
      rows: 24,
    } as never, {
      readyState: 1,
      send(value: string) { sent.push(value) },
    } as never, manager, { token: 'test', projectPaths: {}, projectPathSources: {} } as never, { isSpawnAttemptCancelled: () => false } as never)

    expect(sent.map(value => JSON.parse(value)).filter(message => message.type === 'agent_spawned')).toEqual([{
      type: 'agent_spawned',
      agentId: 'shell-success',
      spawnAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      agentKey: 'sh',
    }])
    expect(startupGateReplay).toHaveBeenCalledWith('shell-success')
  })

  it('table-drives PTY dispatcher terminal branches with exact identity and no pre-handle residue', async () => {
    __test_setCachedAgents([
      { key: 'sh', binaryPath: '/bin/sh' } as never,
      { key: 'agy', binaryPath: '/usr/bin/false' } as never,
    ])
    const config = { token: 'test', projectPaths: {}, projectPathSources: {} }

    const cases: Array<{
      name: string
      message: Record<string, unknown>
      prepare?: (manager: PtyManager) => void
      triggerAfter?: () => void
    }> = [
      {
        name: 'missing agent',
        message: { agentKey: 'not-installed' },
      },
      {
        name: 'resume cwd missing',
        message: {
          agentKey: 'agy', sessionId: '11111111-1111-4111-8111-111111111111',
          workspaceId: 'workspace-1', projectId: 'project-1', cwd: '/definitely/missing/r47d',
        },
      },
      {
        name: 'manager spawn failure',
        message: { agentKey: 'sh' },
        prepare: manager => { spyOn(manager, 'spawn').mockReturnValue(false) },
      },
    ]

    for (const testCase of cases) {
      const manager = new PtyManager()
      testCase.prepare?.(manager)
      const { frames, ws } = socketFrames()
      await __test_handleMessage({
        type: 'spawn', agentId: `panel-${testCase.name.replaceAll(' ', '-')}`,
        daemonId: 'daemon-1', cols: 80, rows: 24, spawnAttemptId: attemptA,
        ...testCase.message,
      } as never, ws, manager, config as never, new SimulatorManager('daemon-1'))

      expect(terminalFrames(frames), testCase.name).toHaveLength(1)
      expect(terminalFrames(frames)[0], testCase.name).toMatchObject({
        type: 'error', agentId: `panel-${testCase.name.replaceAll(' ', '-')}`, spawnAttemptId: attemptA,
      })
      expect(manager.getLiveAgentIds(), testCase.name).toEqual([])
      expect(manager.getLivePanels(), testCase.name).toEqual([])
      expect((manager as any).panelMetaMap.size, testCase.name).toBe(0)
      expect((manager as any).sessionIdToAgentId.size, testCase.name).toBe(0)
    }
  })

  it('refuses a fresh scheduled spawn whose worktree is missing on the daemon — no PTY, no writes, one terminal frame', async () => {
    __test_setCachedAgents([
      { key: 'sh', binaryPath: '/bin/sh' } as never,
      { key: 'agy', binaryPath: '/usr/bin/false' } as never,
    ])
    const manager = new PtyManager()
    const spawnSpy = spyOn(manager, 'spawn').mockReturnValue(false)
    const writeSpy = spyOn(manager, 'write')
    const { frames, ws } = socketFrames()
    const config = { token: 'test', projectPaths: {}, projectPathSources: {} }
    const missingWorktree = '/Users/owner/Development/jerico/.jerico/sched/sched-missing/slot0'

    await __test_handleMessage({
      type: 'spawn',
      agentId: 'panel-sched-missing',
      daemonId: 'daemon-1',
      agentKey: 'agy',
      cols: 80,
      rows: 24,
      spawnAttemptId: attemptA,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      cwd: missingWorktree,
      daemonLocalPath: missingWorktree,
      daemonBindingSetVia: 'sched_worktree',
    } as never, ws, manager, config as never, new SimulatorManager('daemon-1'))

    expect(spawnSpy).not.toHaveBeenCalled()
    expect(writeSpy).not.toHaveBeenCalled()
    expect(frames.filter(frame => frame.type === 'agent_spawned')).toEqual([])
    expect(frames.filter(frame => frame.type === 'session_started')).toEqual([])
    const errors = terminalFrames(frames)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      type: 'error',
      code: 'CWD_MISSING_ON_DAEMON',
      agentId: 'panel-sched-missing',
      spawnAttemptId: attemptA,
    })
    expect(String(errors[0]?.message)).toContain('Scheduled worktree')
    expect(manager.getLiveAgentIds()).toEqual([])
    expect(manager.getLivePanels()).toEqual([])
    expect((manager as any).panelMetaMap.size).toBe(0)
    expect((manager as any).sessionIdToAgentId.size).toBe(0)
  })

  it('refuses scheduled claude and qwen spawns whose worktree is missing — before session assignment, session_started, watchers, or capture state', async () => {
    __test_setCachedAgents([
      { key: 'claude', binaryPath: '/bin/sh' } as never,
      { key: 'qwen', binaryPath: '/bin/sh' } as never,
    ])
    const config = { token: 'test', projectPaths: {}, projectPathSources: {} }
    const missingWorktree = '/Users/owner/Development/jerico/.jerico/sched/sched-missing/slot0'

    for (const agentKey of ['claude', 'qwen'] as const) {
      const manager = new PtyManager()
      const spawnSpy = spyOn(manager, 'spawn').mockReturnValue(false)
      const writeSpy = spyOn(manager, 'write')
      const { frames, ws } = socketFrames()
      const agentId = `panel-sched-${agentKey}`

      await __test_handleMessage({
        type: 'spawn',
        agentId,
        daemonId: 'daemon-1',
        agentKey,
        cols: 80,
        rows: 24,
        spawnAttemptId: attemptA,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        cwd: missingWorktree,
        daemonLocalPath: missingWorktree,
        daemonBindingSetVia: 'sched_worktree',
      } as never, ws, manager, config as never, new SimulatorManager('daemon-1'))

      expect(frames.filter(frame => frame.type === 'session_started'), agentKey).toEqual([])
      expect(frames.filter(frame => frame.type === 'agent_spawned'), agentKey).toEqual([])
      expect(spawnSpy, agentKey).not.toHaveBeenCalled()
      expect(writeSpy, agentKey).not.toHaveBeenCalled()
      const errors = terminalFrames(frames)
      expect(errors, agentKey).toHaveLength(1)
      expect(errors[0], agentKey).toMatchObject({
        type: 'error',
        code: 'CWD_MISSING_ON_DAEMON',
        agentId,
        spawnAttemptId: attemptA,
      })
      expect(String(errors[0]?.message), agentKey).toContain('Scheduled worktree')
      expect(manager.getLiveAgentIds(), agentKey).toEqual([])
      expect(manager.getLivePanels(), agentKey).toEqual([])
      expect((manager as any).panelMetaMap.size, agentKey).toBe(0)
      expect((manager as any).sessionIdToAgentId.size, agentKey).toBe(0)
    }
  })

  it('scheduled Codex refuses malformed context/contracts and missing cwd before any session or provider side effects', async () => {
    __test_setCachedAgents([{ key: 'codex', binaryPath: '/usr/bin/false' } as never])
    for (const extra of [
      { systemPrompt: '' }, { systemPrompt: {} }, { systemPrompt: 'receipt-secret-invalid' },
      { scheduledDutyV1: { version: 2, providerRevision: 1 } },
      { scheduledDutyV1: { version: 1, providerRevision: 99 } },
      { workspaceId: undefined }, { daemonLocalPath: '/definitely/missing/scheduled' },
    ]) {
      const manager = new PtyManager()
      const spawn = spyOn(manager, 'spawn').mockReturnValue(false)
      const write = spyOn(manager, 'write')
      const meta = spyOn(manager, 'setPanelMeta')
      const { frames, ws } = socketFrames()
      await __test_handleMessage({
        type: 'spawn', agentId: 'scheduled-codex-refusal', daemonId: 'daemon-1',
        agentKey: 'codex', spawnAttemptId: attemptA, cols: 80, rows: 24,
        workspaceId: 'workspace-1', projectId: 'project-1', daemonLocalPath: process.cwd(),
        scheduledDutyV1: { version: 1, providerRevision: 1 }, ...extra,
      } as never, ws, manager, { token: 'test', projectPaths: { 'project-1': process.cwd() } } as never,
      new SimulatorManager('daemon-1'))
      expect(spawn).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
      expect(meta).not.toHaveBeenCalled()
      expect(terminalFrames(frames)).toHaveLength(1)
      expect(frames.some(frame => frame.type === 'session_started' || frame.type === 'agent_spawned')).toBe(false)
      expect(JSON.stringify(frames)).not.toContain('receipt-secret-invalid')
      expect(manager.getLivePanels()).toEqual([])
    }
  })

  it('emits an exact early-exit terminal frame and clears daemon handle metadata', async () => {
    __test_setCachedAgents([{ key: 'sh', binaryPath: '/bin/sh' } as never])
    const manager = new PtyManager()
    let onExit: ((exitCode: number | null, signal: string | null) => void) | undefined
    spyOn(manager, 'spawn').mockImplementation((...args: Parameters<PtyManager['spawn']>) => {
      onExit = args[7]
      return true
    })
    const { frames, ws } = socketFrames()
    manager.setCurrentWs(ws)
    await __test_handleMessage({
      type: 'spawn', agentId: 'panel-early-exit', daemonId: 'daemon-1', agentKey: 'sh',
      cols: 80, rows: 24, spawnAttemptId: attemptA,
    }, ws, manager, { token: 'test', projectPaths: {}, projectPathSources: {} } as never, new SimulatorManager('daemon-1'))
    onExit?.(1, null)

    expect(terminalFrames(frames)).toEqual([{
      type: 'error', code: 'SPAWN_FAILED', agentId: 'panel-early-exit', spawnAttemptId: attemptA,
      message: 'Agent process exited before startup completed',
    }])
    expect(manager.getLiveAgentIds()).toEqual([])
    expect(manager.getLivePanels()).toEqual([])
  })
})

describe('simulator spawn terminal envelopes', () => {
  const pass = (udid: string | null) => async () => ({
    checks: [{ id: 'xcrun_exists', status: 'pass', label: 'Xcode CLI tools' }] as SimHealthCheck[],
    udid,
  })
  const blocking = async () => ({
    checks: [{ id: 'xcrun_exists', status: 'fail', label: 'Xcode CLI tools', detail: 'missing' }] as SimHealthCheck[],
    udid: null,
  })

  it('includes bounded actionable idb and Xcode health detail in terminal envelopes', async () => {
    const cases: Array<{ name: string; check: SimHealthCheck; expected: string[] }> = [
      {
        name: 'idb',
        check: {
          id: 'idb_present', status: 'fail', label: 'idb',
          detail: 'idb not found at ~/.local/bin/idb. Required for simulator automation.',
          fixCmd: 'pip3 install fb-idb && brew install facebook/fb/idb-companion',
        },
        expected: ['Simulator health check failed: idb', 'idb not found', 'pip3 install fb-idb', 'brew install facebook/fb/idb-companion'],
      },
      {
        name: 'Xcode',
        check: {
          id: 'xcrun_exists', status: 'fail', label: 'Xcode CLI tools',
          detail: `Xcode command-line tools not found.\u0000${'detail'.repeat(100)}`,
          fixCmd: 'xcode-select --install',
        },
        expected: ['Simulator health check failed: Xcode CLI tools', 'Xcode command-line tools not found', 'xcode-select --install'],
      },
    ]

    for (const testCase of cases) {
      const { frames, ws } = socketFrames()
      const simulator = new SimulatorManager('daemon-1', undefined, async () => ({
        checks: [testCase.check],
        udid: null,
      }))
      simulator.updateWs(ws)

      await simulator.start(`sim-${testCase.name}`, attemptA)

      const envelope = terminalFrames(frames)[0]
      expect(envelope).toBeDefined()
      const message = String(envelope!.message)
      for (const expected of testCase.expected) expect(message, testCase.name).toContain(expected)
      expect(message.length, testCase.name).toBeLessThanOrEqual(512)
      expect(message, testCase.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    }
  })

  it('table-drives blocking health, no UDID, and duplicate active/pending UDID through the production dispatcher', async () => {
    const cases = [
      { name: 'blocking health', health: blocking, prepare: (_manager: SimulatorManager) => {} },
      { name: 'no UDID', health: pass(null), prepare: (_manager: SimulatorManager) => {} },
      { name: 'duplicate active UDID', health: pass('udid-1'), prepare: (manager: SimulatorManager) => {
        ;(manager as any).sessions.set('existing', {
          agentId: 'existing', spawnAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', udid: 'udid-1',
          frameInterval: null, capturing: false, subscribed: false, lastDescribeAt: 0, daemonBooted: false,
        })
      } },
      { name: 'duplicate pending UDID', health: pass('udid-1'), prepare: (manager: SimulatorManager) => {
        ;(manager as any).pendingUdids.set('udid-1', {
          agentId: 'existing', spawnAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        })
      } },
    ]

    for (const testCase of cases) {
      const { frames, ws } = socketFrames()
      const shutdowns: string[] = []
      const simulator = new SimulatorManager('daemon-1', undefined, testCase.health, udid => shutdowns.push(udid))
      simulator.updateWs(ws)
      testCase.prepare(simulator)
      const agentId = `sim-${testCase.name.replaceAll(' ', '-')}`
      ;(simulator as any).pendingSubscriptions.set(agentId, attemptA)
      ;(simulator as any).pendingDaemonBootedUdids.set(`boot-${testCase.name}`, { agentId, spawnAttemptId: attemptA })
      ;(simulator as any).bootedUdidsByAgent.set(agentId, { udid: `boot-${testCase.name}`, spawnAttemptId: attemptA })
      await __test_handleMessage({
        type: 'spawn', agentId, daemonId: 'daemon-1',
        agentKey: 'sim_ios', cols: 80, rows: 24, spawnAttemptId: attemptA,
      }, ws, new PtyManager(), {} as never, simulator)

      expect(terminalFrames(frames), testCase.name).toHaveLength(1)
      expect(terminalFrames(frames)[0], testCase.name).toMatchObject({
        type: 'error', agentId: `sim-${testCase.name.replaceAll(' ', '-')}`, spawnAttemptId: attemptA,
      })
      expect(simulator.getLivePanels().some(panel => panel.spawnAttemptId === attemptA), testCase.name).toBe(false)
      expect([...(simulator as any).pendingUdids.values()].some((pending: unknown) =>
        typeof pending === 'object' && pending !== null && (pending as any).spawnAttemptId === attemptA
      ), testCase.name).toBe(false)
      expect((simulator as any).bootedUdidsByAgent.has(agentId), testCase.name).toBe(false)
      expect((simulator as any).pendingDaemonBootedUdids.has(`boot-${testCase.name}`), testCase.name).toBe(false)
      expect((simulator as any).pendingSubscriptions.has(agentId), testCase.name).toBe(false)
      expect(shutdowns, testCase.name).toEqual([`boot-${testCase.name}`])
    }
  })

  it('a refused stale A cannot clear an installed simulator B sharing the logical panel id', async () => {
    const { frames, ws } = socketFrames()
    const shutdowns: string[] = []
    const simulator = new SimulatorManager('daemon-1', undefined, pass('unused'), udid => shutdowns.push(udid))
    simulator.updateWs(ws)
    ;(simulator as any).sessions.set('sim-shared', {
      agentId: 'sim-shared', spawnAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', udid: 'udid-b',
      frameInterval: null, capturing: false, subscribed: true, lastDescribeAt: 0, daemonBooted: true,
    })
    ;(simulator as any).pendingSubscriptions.set('sim-shared', attemptB)
    ;(simulator as any).pendingDaemonBootedUdids.set('udid-b', { agentId: 'sim-shared', spawnAttemptId: attemptB })
    ;(simulator as any).bootedUdidsByAgent.set('sim-shared', { udid: 'udid-b', spawnAttemptId: attemptB })

    await simulator.start('sim-shared', attemptA)

    expect(terminalFrames(frames)[0]).toMatchObject({
      code: 'SPAWN_FAILED', agentId: 'sim-shared', spawnAttemptId: attemptA,
    })
    expect(simulator.getLivePanels()).toEqual([{
      agentId: 'sim-shared', spawnAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', agentKey: 'sim_ios',
    }])
    expect((simulator as any).pendingSubscriptions.has('sim-shared')).toBe(true)
    expect((simulator as any).pendingDaemonBootedUdids.has('udid-b')).toBe(true)
    expect((simulator as any).bootedUdidsByAgent.get('sim-shared')).toEqual({ udid: 'udid-b', spawnAttemptId: attemptB })
    expect(shutdowns).toEqual([])
  })

  it('cancelled A resuming from health cannot erase pending B subscription or boot ownership', async () => {
    type HealthResult = { checks: SimHealthCheck[]; udid: string | null }
    let releaseHealthA!: (value: HealthResult) => void
    let releaseMetadataB!: () => void
    const healthA = new Promise<HealthResult>(resolve => { releaseHealthA = resolve })
    const metadataB = new Promise<Record<string, never>>(resolve => { releaseMetadataB = () => resolve({}) })
    const { frames, ws } = socketFrames()
    const shutdowns: string[] = []
    const simulator = new SimulatorManager(
      'daemon-1',
      undefined,
      agentId => agentId === 'sim-shared' && !(simulator as any).__startedB
        ? healthA
        : Promise.resolve({ checks: [], udid: 'udid-b' }),
      udid => shutdowns.push(udid),
      () => metadataB,
    )
    simulator.updateWs(ws)

    const startA = simulator.start('sim-shared', attemptA)
    expect(simulator.cancelSpawnAttempt('sim-shared', attemptA)).toBe('prevented')

    ;(simulator as any).__startedB = true
    const residue = simulator as any
    await simulator.handle({
      type: 'sim_subscribe', agentId: 'sim-shared', daemonId: 'daemon-1', spawnAttemptId: attemptB,
    })
    if (residue.pendingDaemonBootedUdids instanceof Map) {
      residue.pendingDaemonBootedUdids.set('udid-b', { agentId: 'sim-shared', spawnAttemptId: attemptB })
      residue.bootedUdidsByAgent.set('sim-shared', { udid: 'udid-b', spawnAttemptId: attemptB })
    } else {
      // This compatibility branch makes the regression fail on the former
      // agent-only Set/string implementation at the post-A cleanup assertion.
      residue.pendingDaemonBootedUdids.add('udid-b')
      residue.bootedUdidsByAgent.set('sim-shared', 'udid-b')
    }
    const startB = simulator.start('sim-shared', attemptB)
    await Promise.resolve()
    await Promise.resolve()
    // The old start path consumed its agent-only subscription before the
    // metadata barrier, so deliver the same exact B subscription once more in
    // the actual pre-session window under test.
    await simulator.handle({
      type: 'sim_subscribe', agentId: 'sim-shared', daemonId: 'daemon-1', spawnAttemptId: attemptB,
    })

    const subscriptionOwner = () => residue.pendingSubscriptions instanceof Map
      ? residue.pendingSubscriptions.get('sim-shared')
      : residue.pendingSubscriptions.has('sim-shared') ? attemptB : undefined
    const bootOwner = () => {
      const owner = residue.bootedUdidsByAgent.get('sim-shared')
      return typeof owner === 'string' ? (owner === 'udid-b' ? attemptB : undefined) : owner?.spawnAttemptId
    }

    expect(residue.pendingUdids.get('udid-b')).toEqual({ agentId: 'sim-shared', spawnAttemptId: attemptB })
    expect(subscriptionOwner()).toBe(attemptB)
    expect(bootOwner()).toBe(attemptB)

    releaseHealthA({ checks: [], udid: 'udid-a' })
    await startA

    expect(residue.pendingUdids.get('udid-b')).toEqual({ agentId: 'sim-shared', spawnAttemptId: attemptB })
    expect(subscriptionOwner()).toBe(attemptB)
    expect(bootOwner()).toBe(attemptB)
    expect(shutdowns).toEqual([])

    releaseMetadataB()
    await startB
    expect(frames.filter(frame => frame.type === 'agent_spawned')).toEqual([{
      type: 'agent_spawned', agentId: 'sim-shared', spawnAttemptId: attemptB,
      agentKey: 'sim_ios', daemonId: 'daemon-1',
    }])
    expect(simulator.getLivePanels()).toEqual([{
      agentId: 'sim-shared', spawnAttemptId: attemptB, agentKey: 'sim_ios',
    }])
    expect(shutdowns).toEqual([])
    simulator.stop('sim-shared', attemptB)
  })
})
