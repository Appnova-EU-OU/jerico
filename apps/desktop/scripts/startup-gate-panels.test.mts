import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHealth } from '../src/main/utils/health-classify.ts'

test('desktop health preserves blocked startup state and leaves old-daemon state unreported', () => {
  const blocked = { phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed', observedAt: 1234 }
  const result = classifyHealth({
    connected: true,
    activePanels: 2,
    agentIds: ['new', 'old'],
    panels: [
      { agentId: 'new', agentKey: 'kimi', cwd: '/tmp/project', startupGate: blocked },
      { agentId: 'old', agentKey: 'claude', cwd: '/tmp/other' },
    ],
  }, null, 200)

  assert.deepEqual(result.panels[0]?.startupGate, blocked)
  assert.equal(result.panels[1]?.startupGate, null)
})
