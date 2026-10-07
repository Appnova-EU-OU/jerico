import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIRST_RUN_INTRO_END_SECONDS,
  FIRST_RUN_REDUCED_INTRO_HOLD_MS,
  canSkipFirstRun,
  firstRunMinimumVisibleMs,
} from '../src/main/first-run-policy.ts'

test('the brand intro cannot be skipped before its lockup has held', () => {
  assert.equal(canSkipFirstRun(0), false)
  assert.equal(canSkipFirstRun(FIRST_RUN_INTRO_END_SECONDS - 0.01), false)
})

test('the remaining first-run tour can be skipped once the intro ends', () => {
  assert.equal(canSkipFirstRun(FIRST_RUN_INTRO_END_SECONDS), true)
  assert.equal(canSkipFirstRun(FIRST_RUN_INTRO_END_SECONDS + 20), true)
})

test('invalid clocks never unlock the tour early', () => {
  assert.equal(canSkipFirstRun(Number.NaN), false)
  assert.equal(canSkipFirstRun(Number.NEGATIVE_INFINITY), false)
})

test('main owns the minimum visible interval for normal and reduced motion', () => {
  assert.equal(firstRunMinimumVisibleMs(false), FIRST_RUN_INTRO_END_SECONDS * 1_000)
  assert.equal(firstRunMinimumVisibleMs(true), FIRST_RUN_REDUCED_INTRO_HOLD_MS)
})
