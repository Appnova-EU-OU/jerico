import { test } from 'node:test'
import assert from 'node:assert/strict'
import { introDecision } from '../src/main/intro-gate.ts'

const state = (over: Partial<Parameters<typeof introDecision>[0]> = {}) => ({
  seenFlagExists: false,
  setupComplete: false,
  forced: false,
  ...over,
})

test('a genuinely new install plays the intro', () => {
  assert.equal(introDecision(state()), 'play')
})

test('an install that has already seen it does nothing', () => {
  assert.equal(introDecision(state({ seenFlagExists: true })), 'skip')
})

// The regression this file exists for. Shipping the seen-flag means every
// existing install arrives with no flag; gating on the flag alone would play
// the film to all of them, and they land on the tray with no window after it.
test('an existing, already-configured install is settled silently, not played to', () => {
  assert.equal(
    introDecision(state({ seenFlagExists: false, setupComplete: true })),
    'skip-and-record',
  )
})

test('a half-configured install still counts as a first launch', () => {
  assert.equal(introDecision(state({ setupComplete: false })), 'play')
})

test('the dev override replays it regardless of flag or setup', () => {
  assert.equal(
    introDecision(state({ forced: true, seenFlagExists: true, setupComplete: true })),
    'play',
  )
})
