/**
 * #637 cp5 Q1 — provider-free descendant proof falsifier.
 *
 * Real node-pty, real PtyManager, real daemon shutdown path (killAll), and the
 * exact harness proof module. A sched-* panel whose shell and descendant both
 * ignore SIGTERM must keep the proof not_proven until the group is SIGKILLed
 * and gone. Run this file alone: it must not share a process with node-pty mocks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PtyManager } from '../pty/manager.js'
import { scheduledDescendantFalsifierPanel, scheduledDescendantHealthEnabled, ScheduledProcessGroupLedger, SCHEDULED_GROUP_LEDGER_CAP } from '../pty/scheduled-process-groups.js'
import type { SpawnAttemptId } from '../shared/types.js'

const proofModule = resolve(import.meta.dir, '../../../../scripts/scheduled-duty-v1-descendant-proof.mjs')
const { bindingFailure, captureGroups, createDescendantProof, evaluateDescendantProof, groupAlive, psGroupEmpty, reapCapturedGroups } = await import(proofModule)

const originalHome = process.env['HOME']
let home = ''
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const gateEnv = { JERICO_ISOLATED_HARNESS: '1', JERICO_SDV1_DESCENDANT_PROOF: '1', BRIDGE_PROFILE: 'sdv1-123-456' }

beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'jerico-sdv1-descendant-')); process.env['HOME'] = home })
afterAll(() => {
  if (originalHome === undefined) delete process.env['HOME']; else process.env['HOME'] = originalHome
  rmSync(home, { recursive: true, force: true })
})

describe('harness gate', () => {
  test('field and falsifier panel require every marker', () => {
    expect(scheduledDescendantHealthEnabled(gateEnv)).toBe(true)
    for (const key of Object.keys(gateEnv)) expect(scheduledDescendantHealthEnabled({ ...gateEnv, [key]: undefined })).toBe(false)
    expect(scheduledDescendantHealthEnabled({ ...gateEnv, BRIDGE_PROFILE: 'dev' })).toBe(false)
    expect(scheduledDescendantHealthEnabled({})).toBe(false)
    const agentId = `sched-${randomUUID()}`, attempt = randomUUID()
    expect(scheduledDescendantFalsifierPanel({ ...gateEnv, JERICO_SDV1_FAKE_SCHED_PANEL: agentId, JERICO_SDV1_FAKE_SCHED_ATTEMPT: attempt })?.agentId).toBe(agentId)
    expect(scheduledDescendantFalsifierPanel({ JERICO_SDV1_FAKE_SCHED_PANEL: agentId, JERICO_SDV1_FAKE_SCHED_ATTEMPT: attempt })).toBeNull()
    expect(scheduledDescendantFalsifierPanel({ ...gateEnv, JERICO_SDV1_FAKE_SCHED_PANEL: 'panel-1', JERICO_SDV1_FAKE_SCHED_ATTEMPT: attempt })).toBeNull()
  })

  test('ledger records only sched-* and fails closed on overflow', () => {
    const ledger = new ScheduledProcessGroupLedger()
    ledger.record('panel-x', randomUUID(), 4242)
    expect(ledger.report(() => true).groups).toHaveLength(0)
    for (let n = 0; n <= SCHEDULED_GROUP_LEDGER_CAP; n++) ledger.record(`sched-${randomUUID()}`, randomUUID(), 5000 + n)
    const report = ledger.report(() => false)
    expect(report.overflow).toBe(true)
    expect(report.groups).toHaveLength(SCHEDULED_GROUP_LEDGER_CAP)
  })
})

describe('real PTY descendant falsifier', () => {
  test('SIGTERM-ignoring sched group keeps proof not_proven until SIGKILL and absence', async () => {
    const manager = new PtyManager()
    const falsifier = scheduledDescendantFalsifierPanel({ ...gateEnv, JERICO_SDV1_FAKE_SCHED_PANEL: `sched-${randomUUID()}`, JERICO_SDV1_FAKE_SCHED_ATTEMPT: randomUUID() })!
    const plainAttempt = randomUUID() as SpawnAttemptId
    expect(manager.spawn(falsifier.agentId, 'sh', falsifier.binary, falsifier.args, 80, 24, () => {}, () => {}, undefined, falsifier.spawnAttemptId as SpawnAttemptId)).toBe(true)
    // A non-scheduled panel must never enter the scheduled ledger.
    expect(manager.spawn('panel-plain', 'sh', '/bin/sh', ['-c', 'sleep 30'], 80, 24, () => {}, () => {}, undefined, plainAttempt)).toBe(true)
    let pgid = 0
    try {
      const proof = createDescendantProof()
      let report = manager.getScheduledProcessGroups()
      expect(report.groups).toHaveLength(1)
      pgid = report.groups[0]!.pgid
      expect(report.groups[0]).toMatchObject({ agentId: falsifier.agentId, spawnAttemptId: falsifier.spawnAttemptId, live: true })
      // Wait until the shell has forked its background descendant.
      for (let n = 0; n < 50; n++) { captureGroups(proof, report); if ([...proof.groups.values()][0].members.size >= 3) break; await sleep(50); report = manager.getScheduledProcessGroups() }
      const binding = { agentId: falsifier.agentId, spawnAttemptId: falsifier.spawnAttemptId }
      expect(bindingFailure(proof, binding)).toBeNull()
      expect([...proof.groups.values()][0].members.size).toBeGreaterThanOrEqual(3)

      // The daemon's real shutdown path: SIGTERM-only killAll.
      manager.killAll()
      await sleep(600)
      expect(groupAlive(pgid)).toBe(true)
      const afterShutdown = evaluateDescendantProof(proof, binding)
      expect(afterShutdown.scheduledDescendantProof).toBe('not_proven')
      expect(afterShutdown.reason).toBe('scheduled_group_survives')
      expect(afterShutdown.groups[0].killGroupEsrch).toBe(false)
      expect(psGroupEmpty(pgid)).toBe(false)

      // SIGTERM alone still cannot qualify.
      process.kill(-pgid, 'SIGTERM'); await sleep(300)
      expect(evaluateDescendantProof(proof, binding).scheduledDescendantProof).toBe('not_proven')

      const actions = await reapCapturedGroups(proof, { graceMs: 300 })
      expect(actions.some((a: { action: string }) => a.action === 'sigkill')).toBe(true)
      const afterReap = evaluateDescendantProof(proof, binding)
      expect(afterReap.scheduledDescendantProof).toBe('proven')
      expect(afterReap.groups[0]).toMatchObject({ killGroupEsrch: true, psGroupEmpty: true, tableGroupEmpty: true, capturedDescendantsAbsent: true })

      // Ledger keeps the killed group, reported not live.
      expect(manager.getScheduledProcessGroups().groups[0]).toMatchObject({ pgid, live: false })

      // Binding fails closed on the wrong agent, wrong attempt, or none.
      expect(evaluateDescendantProof(proof, { ...binding, agentId: `sched-${randomUUID()}` }).reason).toBe('scheduled_group_agent_mismatch')
      expect(evaluateDescendantProof(proof, { ...binding, spawnAttemptId: randomUUID() }).reason).toBe('scheduled_group_attempt_mismatch')
      expect(evaluateDescendantProof(proof, null).scheduledDescendantProof).toBe('not_proven')
    } finally {
      if (pgid) try { process.kill(-pgid, 'SIGKILL') } catch {}
      manager.killAll()
    }
  }, 20_000)

  test('zero and multiple scheduled groups fail closed', () => {
    const binding = { agentId: `sched-${randomUUID()}`, spawnAttemptId: randomUUID() }
    const zero = createDescendantProof()
    captureGroups(zero, { version: 1, daemonPid: process.pid, overflow: false, groups: [] })
    expect(evaluateDescendantProof(zero, binding).reason).toBe('scheduled_group_zero')
    const multiple = createDescendantProof()
    captureGroups(multiple, { version: 1, daemonPid: process.pid, overflow: false, groups: [
      { ...binding, pid: 999_991, pgid: 999_991, spawnedAt: 1, live: false },
      { ...binding, pid: 999_992, pgid: 999_992, spawnedAt: 2, live: false },
    ] })
    expect(evaluateDescendantProof(multiple, binding).reason).toBe('scheduled_group_multiple')
    const neverLive = createDescendantProof()
    captureGroups(neverLive, { version: 1, daemonPid: process.pid, overflow: false, groups: [{ ...binding, pid: 999_993, pgid: 999_993, spawnedAt: 3, live: false }] })
    expect(evaluateDescendantProof(neverLive, binding).reason).toBe('scheduled_group_never_verified_live')
    const malformed = createDescendantProof()
    captureGroups(malformed, { version: 1, daemonPid: process.pid, overflow: false, groups: [{ ...binding, pid: 999_994, pgid: 1, spawnedAt: 4, live: true }] })
    expect(evaluateDescendantProof(malformed, binding).reason).toBe('scheduled_group_entry_invalid_pgid')
  })
})
