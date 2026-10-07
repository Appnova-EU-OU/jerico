import test from 'node:test'
import assert from 'node:assert/strict'
import { isUsageWindowExpired } from '../src/renderer/src/lib/usage-window-freshness.ts'

test('elapsed parent and scoped windows are expired, null reset remains usable', () => {
  const now = 1_000
  assert.equal(isUsageWindowExpired({ resetsAt: 999 }, now), true)
  assert.equal(isUsageWindowExpired({ resetsAt: 1_000 }, now), true)
  assert.equal(isUsageWindowExpired({ resetsAt: 1_001 }, now), false)
  assert.equal(isUsageWindowExpired({ resetsAt: null }, now), false)
})
