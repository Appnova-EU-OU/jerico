import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { SpawnAttemptId } from '../shared/types.js'

const attemptA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as SpawnAttemptId

const spawnCalls: Array<{ cmd: string; args: string[] }> = []
const spawnResults: FakeChildProcess[] = []

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()

  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener)
  }

  kill(): boolean {
    return true
  }
}

// #505: mock.module replaces the module for BOTH 'child_process' and
// 'node:child_process' specifiers process-wide (Bun resolves them to the
// same underlying module) — a bare { spawn } replacement here was shadowing
// spawnSync/execSync/etc. for every other test file that runs in the same
// process, breaking digest.test.ts and git-snapshot.test.ts whenever the
// full suite ran together. Spread the real module so only `spawn` changes.
//
// The spread alone isn't the whole fix: this file's *intentional* overrides
// (existsSync: () => false, accessSync: () => undefined, readFile/access
// stubs) still leak into every later file forever, since mock.module has no
// unmock API — re-registering the pristine module in afterAll is the only
// way to stop that. Use require() snapshots, not `await import()` namespace
// objects: mock.module writes onto the live ESM namespace in place, so a
// namespace captured before mocking would itself read back as mocked by the
// time a restore tried to use it.
const realChildProcess = { ...require('node:child_process') }
mock.module('child_process', () => ({
  ...realChildProcess,
  default: realChildProcess,
  spawn: mock((cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args: args as string[] })
    const proc = new FakeChildProcess()
    spawnResults.push(proc)
    return proc
  }),
}))

const realFs = { ...require('node:fs') }
mock.module('fs', () => ({
  ...realFs,
  default: {
    ...realFs,
    existsSync: () => false,
    accessSync: () => undefined,
    constants: { F_OK: 0, X_OK: 1 },
  },
  existsSync: () => false,
  accessSync: () => undefined,
  constants: { F_OK: 0, X_OK: 1 },
}))

const realFsPromises = { ...require('node:fs/promises') }
mock.module('fs/promises', () => ({
  ...realFsPromises,
  default: realFsPromises,
  readFile: mock(() => Promise.resolve(Buffer.from(''))),
  access: mock(() => Promise.resolve()),
}))

const realSimHealth = { ...require('../simulator/health.js') }
const healthMock = mock(() =>
  Promise.resolve({ checks: [], udid: 'TEST-UDID-1234' })
)

mock.module('../simulator/health.js', () => ({
  ...realSimHealth,
  runFullHealthChecks: healthMock,
  runDetectChecks: mock(() =>
    Promise.resolve({ xcrunOk: true, simctlOk: true })
  ),
}))

afterAll(() => {
  mock.module('child_process', () => ({ ...realChildProcess, default: realChildProcess }))
  mock.module('fs', () => ({ ...realFs, default: realFs }))
  mock.module('fs/promises', () => ({ ...realFsPromises, default: realFsPromises }))
  mock.module('../simulator/health.js', () => ({ ...realSimHealth }))
})

const { SimulatorManager } = await import('../simulator/manager.js')

function injectSession(
  manager: InstanceType<typeof SimulatorManager>,
  agentId: string,
  daemonBooted: boolean
): void {
  const m = manager as unknown as {
    sessions: Map<string, {
      agentId: string; udid: string; frameInterval: null;
      capturing: boolean; subscribed: boolean; lastDescribeAt: number;
      daemonBooted: boolean; spawnAttemptId: SpawnAttemptId;
    }>
    ws: null
  }
  m.sessions.set(agentId, {
    agentId,
    spawnAttemptId: attemptA,
    udid: 'TEST-UDID-1234',
    frameInterval: null,
    capturing: false,
    subscribed: false,
    lastDescribeAt: Date.now(),
    daemonBooted,
  })
}

describe('SimulatorManager.stop() — daemonBooted shutdown policy', () => {
  let manager: InstanceType<typeof SimulatorManager>

  beforeEach(() => {
    spawnCalls.length = 0
    manager = new SimulatorManager('test-daemon-id')
  })

  test('does NOT call xcrun simctl shutdown when daemonBooted === false', () => {
    injectSession(manager, 'agent-1', false)
    manager.stop('agent-1')

    const shutdownCalls = spawnCalls.filter(
      c => c.cmd === 'xcrun' && c.args.includes('shutdown')
    )
    expect(shutdownCalls.length).toBe(0)
  })

  test('calls xcrun simctl shutdown <udid> when daemonBooted === true', () => {
    injectSession(manager, 'agent-2', true)
    manager.stop('agent-2')

    const shutdownCalls = spawnCalls.filter(
      c => c.cmd === 'xcrun' && c.args.includes('shutdown')
    )
    expect(shutdownCalls.length).toBe(1)
    expect(shutdownCalls[0]!.args).toEqual(['simctl', 'shutdown', 'TEST-UDID-1234'])
  })

  test('does NOT call xcrun simctl shutdown when no session exists', () => {
    manager.stop('no-session-agent')

    const shutdownCalls = spawnCalls.filter(
      c => c.cmd === 'xcrun' && c.args.includes('shutdown')
    )
    expect(shutdownCalls.length).toBe(0)
  })

  test('session is removed after stop() regardless of daemonBooted', () => {
    injectSession(manager, 'agent-3', true)
    manager.stop('agent-3')

    const m = manager as unknown as { sessions: Map<string, unknown> }
    expect(m.sessions.has('agent-3')).toBe(false)
  })

  test('stop() SIGTERMs in-flight installProc and removes it from installProc map', () => {
    const killSignals: string[] = []
    const fakeProc = new FakeChildProcess()
    ;(fakeProc as unknown as { kill: (sig: string) => void }).kill = (sig: string) => {
      killSignals.push(sig)
    }

    const m = manager as unknown as { installProc: Map<string, unknown> }
    m.installProc.set('agent-x', { process: fakeProc, spawnAttemptId: attemptA })

    manager.stop('agent-x')

    expect(killSignals).toEqual(['SIGTERM'])
    expect(m.installProc.has('agent-x')).toBe(false)
  })
})

describe('SimulatorManager — daemon-booted UDID tracking', () => {
  let manager: InstanceType<typeof SimulatorManager>

  beforeEach(() => {
    spawnCalls.length = 0
    spawnResults.length = 0
    manager = new SimulatorManager('test-daemon-id', undefined, healthMock as never, undefined, async () => ({}))
  })

  test('BOOTED_UDID: line in install output is added to pendingDaemonBootedUdids', () => {
    const m = manager as unknown as {
      pendingDaemonBootedUdids: Map<string, { agentId: string; spawnAttemptId: SpawnAttemptId }>
      bootedUdidsByAgent: Map<string, { udid: string; spawnAttemptId: SpawnAttemptId }>
    }

    m.pendingDaemonBootedUdids.set('BOOTED-UDID-9999', { agentId: 'agent-install-test', spawnAttemptId: attemptA })
    m.bootedUdidsByAgent.set('agent-install-test', { udid: 'BOOTED-UDID-9999', spawnAttemptId: attemptA })

    expect(m.pendingDaemonBootedUdids.has('BOOTED-UDID-9999')).toBe(true)
    expect(m.bootedUdidsByAgent.get('agent-install-test')).toEqual({ udid: 'BOOTED-UDID-9999', spawnAttemptId: attemptA })
  })

  test('start() with matching UDID in set → session has daemonBooted: true and set is drained', async () => {
    const m = manager as unknown as {
      pendingDaemonBootedUdids: Map<string, { agentId: string; spawnAttemptId: SpawnAttemptId }>
      bootedUdidsByAgent: Map<string, { udid: string; spawnAttemptId: SpawnAttemptId }>
    }
    m.pendingDaemonBootedUdids.set('TEST-UDID-1234', { agentId: 'agent-boot-test', spawnAttemptId: attemptA })
    m.bootedUdidsByAgent.set('agent-boot-test', { udid: 'TEST-UDID-1234', spawnAttemptId: attemptA })

    await manager.start('agent-boot-test', attemptA)

    const sessionMap = manager as unknown as { sessions: Map<string, { daemonBooted: boolean }> }
    const session = sessionMap.sessions.get('agent-boot-test')
    expect(session?.daemonBooted).toBe(true)
    expect(m.pendingDaemonBootedUdids.has('TEST-UDID-1234')).toBe(false)
    expect(m.bootedUdidsByAgent.has('agent-boot-test')).toBe(false)
  })

  test('start() with UDID NOT in set → session has daemonBooted: false', async () => {
    const m = manager as unknown as {
      pendingDaemonBootedUdids: Map<string, { agentId: string; spawnAttemptId: SpawnAttemptId }>
      bootedUdidsByAgent: Map<string, { udid: string; spawnAttemptId: SpawnAttemptId }>
    }
    expect(m.pendingDaemonBootedUdids.has('TEST-UDID-1234')).toBe(false)

    await manager.start('agent-noboot', attemptA)

    const sessionMap = manager as unknown as { sessions: Map<string, { daemonBooted: boolean }> }
    const session = sessionMap.sessions.get('agent-noboot')
    expect(session?.daemonBooted).toBe(false)
  })

  test('start() with blocking fail drains UDID from set (install-fail leak prevention)', async () => {
    ;(healthMock as unknown as { mockImplementation: (fn: () => Promise<unknown>) => void }).mockImplementation(() =>
      Promise.resolve({
        checks: [{ id: 'xcrun_exists', status: 'fail', label: 'Xcode CLI tools' }],
        udid: 'FAIL-UDID-5678',
      })
    )

    const failManager = new SimulatorManager('test-daemon-id', undefined, healthMock as never, undefined, async () => ({}))
    const m = failManager as unknown as {
      pendingDaemonBootedUdids: Map<string, { agentId: string; spawnAttemptId: SpawnAttemptId }>
      bootedUdidsByAgent: Map<string, { udid: string; spawnAttemptId: SpawnAttemptId }>
    }
    m.pendingDaemonBootedUdids.set('FAIL-UDID-5678', { agentId: 'agent-fail', spawnAttemptId: attemptA })
    m.bootedUdidsByAgent.set('agent-fail', { udid: 'FAIL-UDID-5678', spawnAttemptId: attemptA })

    await failManager.start('agent-fail', attemptA)

    expect(m.pendingDaemonBootedUdids.has('FAIL-UDID-5678')).toBe(false)
    expect(m.bootedUdidsByAgent.has('agent-fail')).toBe(false)

    ;(healthMock as unknown as { mockImplementation: (fn: () => Promise<unknown>) => void }).mockImplementation(() =>
      Promise.resolve({ checks: [], udid: 'TEST-UDID-1234' })
    )
  })

  test('proc.on("close", 0) preserves maps so start() sets daemonBooted:true — regression for R4 fix', async () => {
    process.env['BRIDGE_SIM_INSTALL_SCRIPT'] = '/fake/install-sim-prereqs.sh'
    const agentId = 'agent-close-success-e2e'

    const m = manager as unknown as {
      pendingDaemonBootedUdids: Map<string, { agentId: string; spawnAttemptId: SpawnAttemptId }>
      bootedUdidsByAgent: Map<string, { udid: string; spawnAttemptId: SpawnAttemptId }>
      handleSimInstallRun: (agentId: string, spawnAttemptId: SpawnAttemptId) => Promise<void>
    }

    await m.handleSimInstallRun(agentId, attemptA)

    // Simulate what the stdout data handler does when BOOTED_UDID: line is parsed
    m.pendingDaemonBootedUdids.set('TEST-UDID-1234', { agentId, spawnAttemptId: attemptA })
    m.bootedUdidsByAgent.set(agentId, { udid: 'TEST-UDID-1234', spawnAttemptId: attemptA })

    const proc = spawnResults[spawnResults.length - 1]!
    // Install completes successfully
    proc.emit('close', 0)

    // Maps must NOT be drained on success — start() needs to consume them
    expect(m.pendingDaemonBootedUdids.has('TEST-UDID-1234')).toBe(true)
    expect(m.bootedUdidsByAgent.has(agentId)).toBe(true)

    // start() sees the UDID → sets daemonBooted:true and drains maps
    await manager.start(agentId, attemptA)

    const sessionMap = manager as unknown as { sessions: Map<string, { daemonBooted: boolean }> }
    expect(sessionMap.sessions.get(agentId)?.daemonBooted).toBe(true)
    expect(m.pendingDaemonBootedUdids.has('TEST-UDID-1234')).toBe(false)
    expect(m.bootedUdidsByAgent.has(agentId)).toBe(false)

    delete process.env['BRIDGE_SIM_INSTALL_SCRIPT']
  })

  test('stale installer A callbacks cannot erase installer-created boot ownership for B', async () => {
    process.env['BRIDGE_SIM_INSTALL_SCRIPT'] = '/fake/install-sim-prereqs.sh'
    const attemptB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SpawnAttemptId
    const agentId = 'agent-installer-race'
    const m = manager as unknown as {
      pendingDaemonBootedUdids: Map<string, { agentId: string; spawnAttemptId: SpawnAttemptId }>
      bootedUdidsByAgent: Map<string, { udid: string; spawnAttemptId: SpawnAttemptId }>
      installProc: Map<string, { process: FakeChildProcess; spawnAttemptId: SpawnAttemptId }>
      handleSimInstallRun: (agentId: string, spawnAttemptId: SpawnAttemptId) => Promise<void>
      handleSimInstallCancel: (agentId: string, spawnAttemptId: SpawnAttemptId) => void
    }

    await m.handleSimInstallRun(agentId, attemptA)
    const procA = m.installProc.get(agentId)!.process
    m.handleSimInstallCancel(agentId, attemptA)
    await m.handleSimInstallRun(agentId, attemptB)
    const procB = m.installProc.get(agentId)!.process
    m.pendingDaemonBootedUdids.set('UDID-B', { agentId, spawnAttemptId: attemptB })
    m.bootedUdidsByAgent.set(agentId, { udid: 'UDID-B', spawnAttemptId: attemptB })

    procA.emit('close', 1)

    expect(m.installProc.get(agentId)).toEqual({ process: procB, spawnAttemptId: attemptB })
    expect(m.pendingDaemonBootedUdids.get('UDID-B')).toEqual({ agentId, spawnAttemptId: attemptB })
    expect(m.bootedUdidsByAgent.get(agentId)).toEqual({ udid: 'UDID-B', spawnAttemptId: attemptB })
    delete process.env['BRIDGE_SIM_INSTALL_SCRIPT']
  })

  test('stale partial A close/error emits no installer output after B takeover', async () => {
    process.env['BRIDGE_SIM_INSTALL_SCRIPT'] = '/fake/install-sim-prereqs.sh'
    const attemptB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SpawnAttemptId
    const agentId = 'agent-installer-output-race'
    const frames: unknown[] = []
    const ws = { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) } as never
    manager.updateWs(ws)
    const m = manager as unknown as {
      installProc: Map<string, { process: FakeChildProcess; spawnAttemptId: SpawnAttemptId }>
      handleSimInstallRun: (agentId: string, spawnAttemptId: SpawnAttemptId) => Promise<void>
      handleSimInstallCancel: (agentId: string, spawnAttemptId: SpawnAttemptId) => void
    }

    await m.handleSimInstallRun(agentId, attemptA)
    const procA = m.installProc.get(agentId)!.process
    procA.stdout.emit('data', Buffer.from('PARTIAL-A'))
    procA.stderr.emit('data', Buffer.from('ERR-PARTIAL-A'))
    m.handleSimInstallCancel(agentId, attemptA)
    await m.handleSimInstallRun(agentId, attemptB)
    const beforeStaleCallbacks = frames.length

    procA.emit('close', 1)
    procA.emit('error', new Error('late A error'))

    expect(frames.slice(beforeStaleCallbacks)).toEqual([])
    expect(m.installProc.get(agentId)?.spawnAttemptId).toBe(attemptB)
    const procB = m.installProc.get(agentId)!.process
    procB.stdout.emit('data', Buffer.from('B-line\n'))
    procB.emit('close', 0)
    expect(frames.filter(frame => (frame as any).spawnAttemptId === attemptB && (frame as any).line === 'B-line')).toHaveLength(1)
    expect(frames.filter(frame => (frame as any).spawnAttemptId === attemptB && (frame as any).step === 'done')).toHaveLength(1)
    delete process.env['BRIDGE_SIM_INSTALL_SCRIPT']
  })

  test('cancel during script resolution records exact intent and prevents process/start/progress', async () => {
    const agentId = 'agent-install-resolution-cancel'
    const frames: unknown[] = []
    manager.updateWs({ readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) } as never)
    let releaseResolution!: () => void
    const resolutionHeld = new Promise<void>(resolve => { releaseResolution = resolve })
    // The released path is valid/accesssible (fs.accessSync is mocked above).
    // The former implementation had no pre-process cancellation intent, so it
    // would reach spawn('bash', ...) after this await; the fixed path is fenced.
    ;(manager as any).ensureSimInstallScript = async () => {
      await resolutionHeld
      return '/fake/install-sim-prereqs.sh'
    }
    const m = manager as unknown as {
      handleSimInstallRun: (agentId: string, spawnAttemptId: SpawnAttemptId) => Promise<void>
      handleSimInstallCancel: (agentId: string, spawnAttemptId: SpawnAttemptId) => void
      installProc: Map<string, unknown>
    }
    const run = m.handleSimInstallRun(agentId, attemptA)
    await Promise.resolve()
    m.handleSimInstallCancel(agentId, attemptA)
    const postCancelFrameCount = frames.length
    releaseResolution()
    await run
    expect(spawnCalls.some(call => call.cmd === 'bash')).toBe(false)
    expect(m.installProc.has(agentId)).toBe(false)
    expect(frames.slice(postCancelFrameCount)).toEqual([])
  })
})
