import { expect, test, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ScheduledRemovalReservations, validScheduledRemoval, type ScheduledRemoval } from '../pty/scheduled-removal.js'
import { PtyManager } from '../pty/manager.js'
import { __test_handleMessage } from '../ws/client.js'

const attempt = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const request: ScheduledRemoval = { operationId: 'cleanup-operation', attempts: [
  { agentId: 'sched-worker', spawnAttemptId: attempt }, { agentId: 'sched-wt-provision', spawnAttemptId: attempt },
], projectCwd: '/tmp/project', worktreePath: '/tmp/project/.jerico/sched/schedule/slot', scheduleId: 'schedule', slotKey: 'slot' }

test('after removal acceptance daemon rejects replacement execution, persists across restart, then releases', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'reservation-'))
  let release!: () => void
  let alive = true
  let executions = 0
  const accepted = new Promise<void>(resolve => { release = resolve })
  const reservations = new ScheduledRemovalReservations(() => join(temp, 'state.json'), async (_req, recordPid) => {
    executions++; recordPid(12345); await accepted; return true
  }, () => alive)
  const manager = new PtyManager()
  manager.scheduledRemovals = reservations
  try {
    const running = reservations.remove(request, () => [])
    expect(reservations.blocked('sched-worker')).toBe(true)
    expect(reservations.blocked('unrelated')).toBe(false)
    expect(reservations.remove(request, () => [])).toBe(running)
    expect(executions).toBe(1)
    const restarted = new ScheduledRemovalReservations(() => join(temp, 'state.json'), undefined, () => alive)
    expect(restarted.blocked('sched-worker')).toBe(true)
    expect(restarted.quiescent(request.operationId)).toBe(false)
    const frames: any[] = []
    const spawn = spyOn(manager, 'spawn')
    await __test_handleMessage({ type: 'spawn', agentId: 'sched-worker', daemonId: 'daemon', agentKey: 'sh',
      spawnAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as never, cols: 80, rows: 24 },
    { readyState: 1, send(s: string) { frames.push(JSON.parse(s)) } } as never, manager, {} as never, {} as never)
    expect(spawn).not.toHaveBeenCalled()
    expect(frames[0].message).toBe('scheduled_cleanup_in_progress')
    spawn.mockRestore()
    // The final manager boundary also refuses an already-suspended handler.
    expect(manager.spawn('sched-worker', 'sh', '/must-not-execute', [], 80, 24, () => {}, () => {},
      undefined, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as never)).toBe(false)
    alive = false
    release()
    expect(await running).toEqual({ ok: true, quiescent: true })
    expect(reservations.blocked('sched-worker')).toBe(false)
    expect(restarted.blocked('sched-worker')).toBe(false)
    expect(reservations.snapshot()).toEqual([])
  } finally { alive = false; release(); rmSync(temp, { recursive: true, force: true }) }
})

test('exception/timeout cannot release a possible live removal group; absent group safely reaps', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'reservation-failure-'))
  let alive = true
  try {
    const reservations = new ScheduledRemovalReservations(() => join(temp, 'state.json'), async (_req, recordPid) => {
      recordPid(12345); throw new Error('simulated executor timeout/exception')
    }, () => alive)
    expect(await reservations.remove(request, () => [])).toEqual({ ok: false, quiescent: false })
    expect(reservations.blocked('sched-worker')).toBe(true)
    alive = false
    expect(reservations.quiescent(request.operationId)).toBe(true)
    expect(reservations.blocked('sched-worker')).toBe(false)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('live or pending replacement roster prevents command execution under exclusion', async () => {
  let executions = 0
  const reservations = new ScheduledRemovalReservations(undefined, async () => { executions++; return true })
  expect(await reservations.remove(request, () => [{ agentId: 'sched-worker' }])).toEqual({ ok: false, quiescent: true })
  expect(executions).toBe(0)
  expect(reservations.blocked('sched-worker')).toBe(false)
})

test('a pre-existing async spawn with no metadata cannot slip through the removal roster', async () => {
  const manager = new PtyManager()
  let executions = 0
  manager.scheduledRemovals = new ScheduledRemovalReservations(undefined, async () => { executions++; return true })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const spawning = __test_handleMessage({ type: 'spawn', agentId: 'sched-worker', daemonId: 'daemon',
    agentKey: 'sim_ios', spawnAttemptId: attempt as never, cols: 80, rows: 24 },
  { readyState: 1, send() {} } as never, manager, {} as never,
  { isSpawnAttemptCancelled: () => false, start: () => held } as never)
  try {
    expect(manager.getScheduledCleanupRoster()).toEqual([{ agentId: 'sched-worker' }])
    expect(await manager.scheduledRemovals.remove(request, () => manager.getScheduledCleanupRoster()))
      .toEqual({ ok: false, quiescent: true })
    expect(executions).toBe(0)
  } finally { release(); await spawning }
  expect(manager.getScheduledCleanupRoster()).toEqual([])
})

test('real scratch git removal is exact and idempotent and removes its reservation', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'reservation-git-'))
  const cwd = join(temp, 'repo')
  mkdirSync(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  try {
    git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'test')
    const path = join(cwd, '.jerico/sched/schedule/2026-09-23T0900')
    const sibling = join(cwd, '.jerico/sched/schedule/sibling')
    git('worktree', 'add', '--detach', path); git('worktree', 'add', '--detach', sibling)
    const req = { ...request, projectCwd: cwd, slotKey: '2026-09-23T09:00', worktreePath: path }
    const reservations = new ScheduledRemovalReservations(() => join(temp, 'state.json'))
    expect(validScheduledRemoval(req)).toBe(true)
    expect(validScheduledRemoval({ ...req, worktreePath: sibling })).toBe(false)
    expect(await reservations.remove(req, () => [])).toEqual({ ok: true, quiescent: true })
    expect(existsSync(path)).toBe(false)
    expect(existsSync(sibling)).toBe(true)
    expect(await reservations.remove(req, () => [])).toEqual({ ok: true, quiescent: true })
    expect(reservations.snapshot()).toEqual([])
    // Fail the PID journal commit: the real child must never pass its stdin
    // execution gate, even though it has already been spawned.
    git('worktree', 'add', '--detach', path)
    const failing = new ScheduledRemovalReservations(() => join(temp, 'failed-state.json'))
    const save = (failing as any).save.bind(failing)
    let saves = 0
    const saveSpy = spyOn(failing as any, 'save').mockImplementation(() => {
      if (++saves === 2) throw new Error('PID persistence failed')
      save()
    })
    expect(await failing.remove(req, () => [])).toEqual({ ok: false, quiescent: true })
    expect(existsSync(path)).toBe(true)
    expect(failing.snapshot()).toEqual([])
    saveSpy.mockRestore()
    const corrupt = join(temp, 'corrupt.json')
    writeFileSync(corrupt, 'invalid')
    expect(new ScheduledRemovalReservations(() => corrupt).blocked('sched-worker')).toBe(true)
    expect(new ScheduledRemovalReservations(() => corrupt).snapshot()).toBeUndefined()
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
