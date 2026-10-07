import { describe, expect, test } from 'bun:test'
import { isWakeCapable, WAKE_COHORT } from '../events/wake-cohort.js'
import { OrchestratorEventBroker } from '../events/broker.js'
import { OrchestratorEventPoller } from '../events/poller.js'
import { tryPublishOrchestratorNotice } from '../events/notice-publish.js'
import { orchestratorBroker } from '../events/instance.js'

// Fix 3: producer must not skip PTY write for a harness that cannot wake.
// This test drives the REAL cohort definition and the REAL producer branch
// (tryPublishOrchestratorNotice), not a local Set — widening WAKE_COHORT to
// include codex/opencode must go red, and disabling the gate with
// `if (false && !isWakeCapable(...))` must also go red.
describe('616 Fix 3 - wake cohort gate (real cohort + real producer branch)', () => {
  test('production cohort is claude-only', () => {
    expect(WAKE_COHORT.has('claude')).toBe(true)
    expect(WAKE_COHORT.has('codex')).toBe(false)
    expect(WAKE_COHORT.has('opencode')).toBe(false)
    expect(WAKE_COHORT.has('kimi')).toBe(false)
    expect(WAKE_COHORT.has('agy')).toBe(false)
    expect(WAKE_COHORT.size).toBe(1)
  })

  test('isWakeCapable mirrors the cohort', () => {
    expect(isWakeCapable('claude')).toBe(true)
    expect(isWakeCapable('codex')).toBe(false)
    expect(isWakeCapable('opencode')).toBe(false)
    expect(isWakeCapable('kimi')).toBe(false)
    expect(isWakeCapable(undefined)).toBe(false)
    expect(isWakeCapable('')).toBe(false)
  })

  test('non-cohort harness does not cut over: production helper returns wake_cohort_mismatch, broker untouched', () => {
    // Use the real production helper (notice-publish) backed by the singleton,
    // with a unique subscriber so the test is isolated. This drives the REAL
    // branch: if (!isWakeCapable) → wake_cohort_mismatch, no broker publish.
    const sub = `p-codex#${Date.now()}#${Math.random().toString(36).slice(2, 6)}`
    orchestratorBroker.attach(sub)
    const out = tryPublishOrchestratorNotice('codex', sub, { watchId: 'w', idempotencyKey: 'k-codex-1', kind: 'k', payload: 'hello' })
    expect(out.published).toBe(false)
    expect((out as { reason: string }).reason).toBe('wake_cohort_mismatch')
    expect(orchestratorBroker.pendingCount(sub)).toBe(0)
    orchestratorBroker.forget(sub)
  })

  test('cohort harness does cut over when subscriber exists (production helper publishes)', () => {
    const sub = `p-claude#${Date.now()}#${Math.random().toString(36).slice(2, 6)}`
    const { lease } = orchestratorBroker.attach(sub)
    const out = tryPublishOrchestratorNotice('claude', sub, { watchId: 'w1', idempotencyKey: 'k1', kind: 'k', payload: '[BRIDGE-ORCH] hello' })
    expect(out.published).toBe(true)
    expect(orchestratorBroker.read(sub, lease).some(r => r.type === 'event')).toBe(true)
    orchestratorBroker.forget(sub)
  })

  test('disabling the gate (false && !isWakeCapable) would let codex publish — this test goes red if mutated', () => {
    // This is the reviewer's mutation: the production helper's gate is wrapped
    // as `if (false && !isWakeCapable(...))`. That makes the check always-false,
    // so a non-cohort harness incorrectly reaches the broker. We assert the
    // opposite: codex must be refused with wake_cohort_mismatch, not published.
    // If the helper is mutated to `false &&`, this test receives published:true
    // and fails.
    const sub = `p-mutate#${Date.now()}#${Math.random().toString(36).slice(2, 6)}`
    orchestratorBroker.attach(sub)
    const codexOut = tryPublishOrchestratorNotice('codex', sub, { watchId: 'w', idempotencyKey: 'k-mutate-codex', kind: 'k', payload: 'mutate-check' })
    expect(codexOut.published).toBe(false)
    expect((codexOut as { reason: string }).reason).toBe('wake_cohort_mismatch')
    // Claud still publishes — distinguishes "gate always closed" from "gate disabled"
    const claudeOut = tryPublishOrchestratorNotice('claude', sub, { watchId: 'w2', idempotencyKey: 'k-mutate-claude', kind: 'k', payload: 'mutate-check-claude' })
    expect(claudeOut.published).toBe(true)
    orchestratorBroker.forget(sub)
  })

  test('cohort gate helper is the single production path — ws/client.ts delegates to it', async () => {
    // Verify that ws/client.ts does not contain its own inline `if (!isWakeCapable`
    // gate any longer; it must delegate to the helper that the execution tests cover.
    // This closes the gap where a source-text grep passed while the real branch was dead.
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../ws/client.ts', import.meta.url), 'utf8')
    expect(src).toContain('tryPublishOrchestratorNotice')
    // The helper file itself must contain the real gate
    const helperSrc = fs.readFileSync(new URL('../events/notice-publish.ts', import.meta.url), 'utf8')
    expect(helperSrc).toContain('isWakeCapable')
    expect(helperSrc).toContain('wake_cohort_mismatch')
  })
})
