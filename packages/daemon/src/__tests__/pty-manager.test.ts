import { describe, test, expect, mock, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getLogPaths, getOpenCodeConfigDir, getSpawnManifestPath } from '../profile'
import { AGENT_SPECS } from '../pty/agents'

let testHome: string
let originalHome: string | undefined

beforeAll(() => {
  testHome = mkdtempSync(path.join(os.tmpdir(), 'pty-manager-home-'))
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

const killCalls: Array<{ pid: number; signal?: string }> = []
const spawned: FakePty[] = []
const spawnOptsList: Array<{ binary: string; args: string[]; opts: Record<string, unknown> }> = []

class FakePty extends EventEmitter {
  pid: number
  writes: string[] = []
  resizes: Array<{ cols: number; rows: number }> = []

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }

  destroyed = 0

  kill(): void {
    this.emit('exit', { exitCode: null, signal: 'SIGTERM' })
  }

  /** node-pty's UnixTerminal exposes this at runtime; it is what frees the master fd. */
  destroy(): void {
    this.destroyed++
  }

  onData(handler: (data: string) => void): void {
    this.on('data', handler)
  }

  onExit(handler: (event: { exitCode: number | null; signal: number | string | null }) => void): void {
    this.on('exit', handler)
  }
}

// #505/#552: require() bypasses Bun's mock.module registry and always
// returns the real module, even after mocking is active — the only safe
// snapshot source both for filling in a partial mock and for undoing it
// later. A bare mock like the one below (only `spawn`) would otherwise
// permanently shadow every other node-pty export for any test file that
// runs later in the same `bun test` process.
const realNodePty = { ...require('node-pty') }

mock.module('node-pty', () => ({
  ...realNodePty,
  spawn: mock((binary: string, args: string[], opts: Record<string, unknown>) => {
    spawnOptsList.push({ binary, args, opts })
    const pty = new FakePty(1000 + spawned.length)
    spawned.push(pty)
    return pty
  }),
}))

afterAll(() => {
  mock.module('node-pty', () => ({ ...realNodePty }))
})

const realKill = process.kill
const killMock = mock((pid: number, signal?: string) => {
  killCalls.push({ pid, signal })
})

const { PtyManager, GRACEFUL_KILL_GRACE_MS } = await import('../pty/manager.js')

describe('PtyManager duplicate spawn recovery', () => {
  beforeEach(() => {
    spawned.length = 0
    spawnOptsList.length = 0
    killCalls.length = 0
    process.kill = killMock as unknown as typeof process.kill
  })

  afterEach(() => {
    process.kill = realKill
    killMock.mockClear()
  })

  test('a retired generation is tombstoned so its straggler spawn cannot clobber the replacement', () => {
    const manager = new PtyManager()
    const A = '11111111-1111-4111-8111-111111111111' as any
    const B = '22222222-2222-4222-8222-222222222222' as any

    expect(manager.spawn('panel-tomb', 'claude', '/bin/claude', [], 80, 24, () => {}, () => {}, undefined, A)).toBe(true)
    // B supersedes A: A's handle is killed and A is retired.
    expect(manager.spawn('panel-tomb', 'claude', '/bin/claude', [], 80, 24, () => {}, () => {}, undefined, B)).toBe(true)
    expect(manager.isSpawnAttemptCancelled('panel-tomb', A)).toBe(true)

    const spawnCountBeforeStraggler = spawned.length
    // A late duplicate delivery of A must be refused, not allowed to replace B.
    expect(manager.spawn('panel-tomb', 'claude', '/bin/claude', [], 80, 24, () => {}, () => {}, undefined, A)).toBe(false)
    expect(spawned.length).toBe(spawnCountBeforeStraggler)
    expect(manager.isSpawnAttemptCancelled('panel-tomb', B)).toBe(false)
  })

  test('replaces an existing handle instead of rejecting the second spawn', () => {
    const manager = new PtyManager()
    const outputs: string[] = []
    const exits: Array<{ exitCode: number | null; signal: string | null }> = []

    const first = manager.spawn('panel-1', 'claude', '/bin/claude', [], 80, 24,
      data => outputs.push(`first:${data}`),
      (exitCode, signal) => exits.push({ exitCode, signal }),
      undefined,
      '11111111-1111-4111-8111-111111111111' as any,
    )
    const second = manager.spawn('panel-1', 'claude', '/bin/claude', [], 100, 30,
      data => outputs.push(`second:${data}`),
      (exitCode, signal) => exits.push({ exitCode, signal }),
      undefined,
      '22222222-2222-4222-8222-222222222222' as any,
    )

    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(spawned.length).toBe(2)
    expect(killCalls.length).toBeGreaterThan(0)
    expect(killCalls[0]?.pid).toBe(-1000)

    spawned[0]!.emit('data', 'old-output')
    spawned[0]!.emit('exit', { exitCode: 0, signal: null })
    spawned[1]!.emit('data', 'new-output')

    expect(outputs).toEqual([Buffer.from('new-output').toString('base64')].map(v => `second:${v}`))
    // Replacing the old handle is an explicit kill. Since 1bf710d8, kill()
    // deliberately reports that exit so the server drops the superseded agent;
    // the guarded native exit above must not report it a second time.
    expect(exits).toEqual([{ exitCode: null, signal: 'SIGTERM' }])
  })

  test('kill removes the active handle so a later spawn stays clean', () => {
    const manager = new PtyManager()

    expect(manager.spawn('panel-2', 'sh', '/bin/sh', [], 80, 24, () => {}, () => {}, undefined, '11111111-1111-4111-8111-111111111111' as any)).toBe(true)
    manager.kill('panel-2', true)
    expect(manager.spawn('panel-2', 'sh', '/bin/sh', [], 80, 24, () => {}, () => {}, undefined, '22222222-2222-4222-8222-222222222222' as any)).toBe(true)
    expect(spawned.length).toBe(2)
  })

  test('spawn without ctx yields positional non-empty BRIDGE_PANEL_ID and assigns instance id', () => {
    const manager = new PtyManager()
    manager.spawn('panel-3', 'claude', '/bin/claude', [], 80, 24, () => {}, () => {}, undefined, '11111111-1111-4111-8111-111111111111' as any)
    const env = spawnOptsList[0]!.opts.env as Record<string, string>
    expect(env['BRIDGE_PANEL_ID']).toBe('panel-3')
    expect(Number(env['BRIDGE_PANEL_INSTANCE_ID'])).toBeGreaterThan(0)
  })

  test('mismatched ctx.agentId cannot override positional BRIDGE_PANEL_ID', () => {
    const manager = new PtyManager()
    manager.spawn('panel-4', 'claude', '/bin/claude', [], 80, 24, () => {}, () => {},
      { serverUrl: 'http://localhost:3100', token: 'tok', workspaceId: 'ws-1', projectId: 'proj-1', agentId: 'agent-77' } as any,
      '11111111-1111-4111-8111-111111111111' as any,
    )
    const env = spawnOptsList[0]!.opts.env as Record<string, string>
    expect(env['BRIDGE_PANEL_ID']).toBe('panel-4')
  })

  test('project env cannot override identity variables', () => {
    const manager = new PtyManager()
    manager.spawn('panel-5', 'claude', '/bin/claude', [], 80, 24, () => {}, () => {},
      { serverUrl: 'http://localhost:3100', token: 'tok', workspaceId: 'ws-1', agentId: 'panel-5', projectEnv: { BRIDGE_PANEL_ID: 'fake-id', BRIDGE_PANEL_INSTANCE_ID: '999' } } as any,
      '11111111-1111-4111-8111-111111111111' as any,
    )
    const env = spawnOptsList[0]!.opts.env as Record<string, string>
    expect(env['BRIDGE_PANEL_ID']).toBe('panel-5')
    expect(env['BRIDGE_PANEL_INSTANCE_ID']).not.toBe('999')
  })

  test('OPENCODE_CONFIG_DIR is registry-owned for opencode and absent from every other agent spawn', () => {
    const manager = new PtyManager()
    const original = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = '/tmp/must-not-leak'

    try {
      for (const spec of AGENT_SPECS) {
        manager.spawn(`env-${spec.key}`, spec.key, `/bin/${spec.key}`, [], 80, 24, () => {}, () => {}, {
          serverUrl: 'http://localhost:3100',
          token: 'tok',
          workspaceId: 'ws-1',
          agentId: `env-${spec.key}`,
          projectEnv: { OPENCODE_CONFIG_DIR: '/tmp/project-override' },
          agentEnv: { OPENCODE_CONFIG_DIR: '/tmp/agent-override' },
        } as any, '11111111-1111-4111-8111-111111111111' as any)
        const env = spawnOptsList.at(-1)!.opts.env as Record<string, string>
        if (spec.key === 'opencode') {
          expect(env.OPENCODE_CONFIG_DIR).toBe(getOpenCodeConfigDir())
        } else {
          expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
        }
      }
    } finally {
      if (original === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = original
    }
  })

  test('respawns get different instance ids and old instance is dead to getLiveHookTarget', () => {
    const manager = new PtyManager()
    manager.spawn('panel-6', 'claude', '/bin/claude', [], 80, 24, () => {}, () => {}, undefined, '11111111-1111-4111-8111-111111111111' as any)
    const env1 = spawnOptsList[0]!.opts.env as Record<string, string>
    const id1 = Number(env1['BRIDGE_PANEL_INSTANCE_ID'])
    
    expect(manager.getLiveHookTarget('panel-6', id1)).toEqual({ agentId: 'panel-6', agentKey: 'claude', instanceId: id1 })

    manager.spawn('panel-6', 'claude', '/bin/claude', [], 80, 24, () => {}, () => {}, undefined, '22222222-2222-4222-8222-222222222222' as any)
    const env2 = spawnOptsList[1]!.opts.env as Record<string, string>
    const id2 = Number(env2['BRIDGE_PANEL_INSTANCE_ID'])

    expect(id2).not.toBe(id1)
    expect(manager.getLiveHookTarget('panel-6', id2)).toEqual({ agentId: 'panel-6', agentKey: 'claude', instanceId: id2 })
    expect(manager.getLiveHookTarget('panel-6', id1)).toBeNull()
  })
})

describe('PtyManager.kill releases the pty', () => {
  beforeEach(() => {
    spawned.length = 0
    spawnOptsList.length = 0
    killCalls.length = 0
    process.kill = killMock as unknown as typeof process.kill
  })

  afterEach(() => {
    process.kill = realKill
    killMock.mockClear()
  })

  test('destroys the terminal so the master fd is not leaked', () => {
    const manager = new PtyManager()
    manager.spawn('panel-leak', 'claude', '/bin/claude', [], 80, 24, () => {}, () => {}, undefined, '11111111-1111-4111-8111-111111111111' as any)
    const term = spawned[0]!
    expect(term.destroyed).toBe(0)

    manager.kill('panel-leak')

    // Without this the fd stays open for the life of the daemon: kill() drops the
    // handle and short-circuits node-pty's own exit path, so nothing else ever
    // closes it. Measured 2 leaked /dev/ptmx per killed panel before the fix, 1 after
    // (the remaining one is node-pty 1.1.0's own native leak).
    expect(term.destroyed).toBe(1)
  })

  test('a non-force kill still escalates to SIGKILL', () => {
    // Capture the escalation instead of waiting for it: asserting the schedule is
    // both deterministic and immune to the grace window being retuned later.
    const scheduled: Array<{ fn: () => void; ms: number }> = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      scheduled.push({ fn, ms: ms ?? 0 })
      return { unref: () => {} } as unknown as ReturnType<typeof realSetTimeout>
    }) as unknown as typeof globalThis.setTimeout

    try {
      const manager = new PtyManager()
      manager.spawn('panel-stubborn', 'claude', '/bin/claude', [], 80, 24, () => {}, () => {}, undefined, '11111111-1111-4111-8111-111111111111' as any)
      const pid = spawned[0]!.pid

      manager.kill('panel-stubborn')   // force defaults to false

      expect(killCalls.some(c => c.pid === -pid && c.signal === 'SIGTERM')).toBe(true)
      expect(killCalls.some(c => c.signal === 'SIGKILL')).toBe(false)

      // The graceful path used to stop at SIGTERM entirely. An agent that traps it
      // survived forever holding its pty, and the handle was already gone so
      // nothing could kill it again.
      const escalation = scheduled.find(s => s.ms === GRACEFUL_KILL_GRACE_MS)
      expect(escalation).toBeDefined()

      escalation!.fn()
      expect(killCalls.some(c => c.pid === -pid && c.signal === 'SIGKILL')).toBe(true)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  test('graceful gets at least as long as force — never less', () => {
    // A shorter graceful window than the force window would be backwards: force
    // means "gone now", graceful means "flush your session first".
    expect(GRACEFUL_KILL_GRACE_MS).toBeGreaterThanOrEqual(2000)
  })

  test('pre-spawn resize is buffered and applied when spawn completes', () => {
    const manager = new PtyManager()
    // Resize arrives before spawn (e.g. while hook assertion is awaited)
    const resizeResult = manager.resize('panel-pre-resize', 79, 23)
    expect(resizeResult).toEqual({ cols: 79, rows: 23 })

    // Spawn arrives with initial/stale cols 160, 45
    manager.spawn(
      'panel-pre-resize',
      'claude',
      '/bin/claude',
      [],
      160,
      45,
      () => {},
      () => {},
      undefined,
      '33333333-3333-4333-8333-333333333333' as any
    )

    const lastSpawnOpts = spawnOptsList[spawnOptsList.length - 1]
    expect(lastSpawnOpts).toBeDefined()
    expect(lastSpawnOpts!.opts.cols).toBe(79)
    expect(lastSpawnOpts!.opts.rows).toBe(23)
  })
})
