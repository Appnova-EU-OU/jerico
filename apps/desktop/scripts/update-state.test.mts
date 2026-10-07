import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canPublishReady, clearDownload, markDownloaded, planDownload, planInstall,
  reconcileAvailable, shortFailureMessage, shouldClearPendingCache, shouldFailDownload, shouldShowDiscoveryNotification,
} from '../src/main/utils/update-state.ts'

test('same-version update-available preserves downloaded state', () => {
  const result = reconcileAvailable({ version: '1.2.3', state: 'downloaded' }, '1.2.3')
  assert.deepEqual(result.state, { version: '1.2.3', state: 'downloaded' })
  assert.equal(result.downgradePrevented, true)
})

test('a newer available version invalidates the staged state', () => {
  const result = reconcileAvailable({ version: '1.2.3', state: 'downloaded' }, '1.2.4')
  assert.equal(result.state, null)
  assert.equal(result.downgradePrevented, false)
})

test('a check error during download does not fail the transfer state', () => {
  assert.equal(shouldFailDownload('check'), false)
  assert.deepEqual(
    reconcileAvailable({ version: '1.2.3', state: 'downloading' }, '1.2.3').state,
    { version: '1.2.3', state: 'downloading' },
  )
})

test('a second download attaches while the first is in flight', () => {
  const result = planDownload({ version: '1.2.3', state: 'downloading' }, '1.2.3')
  assert.equal(result.plan, 'attach')
  assert.deepEqual(result.state, { version: '1.2.3', state: 'downloading' })
})

test('Retry during a live transfer never plans a pending-cache clear', () => {
  const retry = planDownload(null, '1.2.3', '1.2.3')
  assert.equal(retry.plan, 'attach')
  assert.equal(shouldClearPendingCache(retry.plan), false)
})

test('a newer feed version during a transfer is deferred until its owner settles', () => {
  const result = planDownload({ version: '1.2.3', state: 'downloading' }, '1.2.4', '1.2.3')
  assert.equal(result.plan, 'defer')
  assert.deepEqual(result.state, { version: '1.2.3', state: 'downloading' })
})

test('a downloaded version is not downloaded again', () => {
  const result = planDownload({ version: '1.2.3', state: 'downloaded' }, '1.2.3')
  assert.equal(result.plan, 'already-downloaded')
  assert.deepEqual(result.state, { version: '1.2.3', state: 'downloaded' })
})

test('a failed download clears its in-flight state so the banner can retry', () => {
  const failed = clearDownload()
  assert.equal(failed, null)
  const retry = planDownload(failed, '1.2.3')
  assert.equal(retry.plan, 'start')
  assert.deepEqual(markDownloaded(retry.state, '1.2.3'), { version: '1.2.3', state: 'downloaded' })
})

test('readiness waits for native staging success', () => {
  assert.equal(canPublishReady(false), false)
  assert.equal(canPublishReady(true), true)
})

test('a stale staged version with a newer feed opens Updates instead of installing', () => {
  assert.equal(planInstall('1.2.3', '1.2.4'), 'open-update')
  assert.equal(planInstall('1.2.3', '1.2.3'), 'install')
})

test('a discovery notification is emitted once per undisplayed version', () => {
  const shown = new Set<string>()
  assert.equal(shouldShowDiscoveryNotification(shown, '1.2.4', null, null), true)
  shown.add('1.2.4')
  assert.equal(shouldShowDiscoveryNotification(shown, '1.2.4', null, null), false)
  assert.equal(shouldShowDiscoveryNotification(new Set(), '1.2.3', '1.2.3', null), false)
})

test('popover failure detail is one concise capped line', () => {
  assert.equal(shortFailureMessage(`  ${'x'.repeat(140)}\nnext line  `), `${'x'.repeat(120)}`)
})
