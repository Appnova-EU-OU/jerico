/**
 * The freshness line, whose only interesting case is a reading from the future.
 *
 * Observed live in the popover right after a refresh: `updated -1s ago`. The daemon
 * stamps `fetchedAt` with its own clock and the component's `now` moves in
 * one-second steps, so a reading that has just landed can be a few hundred
 * milliseconds ahead of it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ago } from '../src/renderer/src/lib/freshness.ts'

const NOW = 1_786_522_000_000

test('a reading from the FUTURE never prints a negative age', () => {
  // The measured case: fetched 300ms after `now` was last sampled.
  assert.equal(ago(NOW + 300, NOW), 'just now')
  // And a grossly skewed clock still says something rather than nonsense.
  assert.equal(ago(NOW + 90_000, NOW), 'just now')
  for (const skew of [1, 300, 999, 1000, 60_000]) {
    assert.ok(!ago(NOW + skew, NOW).includes('-'), `skew ${String(skew)}ms printed a negative age`)
  }
})

test('a reading taken this second reads as fresh, not as zero', () => {
  assert.equal(ago(NOW, NOW), 'just now')
  assert.equal(ago(NOW - 999, NOW), 'just now')
})

test('seconds, minutes and hours', () => {
  assert.equal(ago(NOW - 1_000, NOW), '1s ago')
  assert.equal(ago(NOW - 41_000, NOW), '41s ago')
  assert.equal(ago(NOW - 59_999, NOW), '59s ago')
  assert.equal(ago(NOW - 60_000, NOW), '1m ago')
  assert.equal(ago(NOW - 12 * 60_000, NOW), '12m ago')
  assert.equal(ago(NOW - 59 * 60_000, NOW), '59m ago')
  assert.equal(ago(NOW - 60 * 60_000, NOW), '1h 00m ago')
  assert.equal(ago(NOW - (3 * 60 + 4) * 60_000, NOW), '3h 04m ago')
})

test('no reading is "never", which is not the same as old', () => {
  assert.equal(ago(null, NOW), 'never')
})
