import { expect, test, spyOn } from 'bun:test'
import { CleanupRetirements } from '../pty/cleanup-retirements.js'
import { PtyManager } from '../pty/manager.js'
import { __test_handleMessage } from '../ws/client.js'

test('retired process groups remain authoritative roster members until absence', () => {
  const retired = new CleanupRetirements(() => true)
  retired.record('provision', 101)
  retired.record('provision', 102)
  retired.record('worker', 201)
  expect(retired.present(() => true)).toEqual(['provision', 'worker'])
  expect(retired.present(pid => pid === 102)).toEqual(['provision'])
  expect(retired.present(() => false)).toEqual([])
  expect(retired.present(() => true)).toEqual([])
})

test('fresh cleanup probe tombstones exact attempts before returning complete roster', async () => {
  const manager = new PtyManager()
  const cancel = spyOn(manager, 'cancelSpawnAttempt')
  const roster = spyOn(manager, 'getScheduledCleanupRoster').mockReturnValue([{ agentId: 'still-retiring' }])
  const frames: any[] = []
  const ws = { readyState: 1, send(s: string) { frames.push(JSON.parse(s)) } }
  const attempt = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  await __test_handleMessage({ type: 'scheduled_cleanup_probe', daemonId: 'd', requestId: 'fresh',
    attempts: [{ agentId: 'worker', spawnAttemptId: attempt }] }, ws as never, manager, {} as never,
  { getLivePanels: () => [{ agentId: 'other' }] } as never)
  expect(cancel).toHaveBeenCalledWith('worker', attempt, true)
  expect(manager.isSpawnAttemptCancelled('worker', attempt as never)).toBe(true)
  expect(frames).toEqual([{ type: 'scheduled_cleanup_roster', requestId: 'fresh',
    panels: [{ agentId: 'still-retiring' }, { agentId: 'other' }] }])
  roster.mockRestore()
  cancel.mockRestore()
})

test('a suspended replacement spawn remains in the roster even before it owns a PTY', () => {
  const manager = new PtyManager()
  const original = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as never
  const replacement = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as never
  manager.setPanelMeta('sched-worker', { agentId: 'sched-worker', agentKey: 'codex', spawnAttemptId: replacement })
  manager.cancelSpawnAttempt('sched-worker', original, true)
  expect(manager.getScheduledCleanupRoster()).toEqual([{ agentId: 'sched-worker' }])
  expect(manager.isSpawnAttemptCancelled('sched-worker', replacement)).toBe(false)
  manager.cancelSpawnAttempt('sched-worker', replacement, true)
  expect(manager.getScheduledCleanupRoster()).toEqual([])
})
