import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHealth } from '../src/main/utils/health-classify.ts'

const alarming = {
  status: 'auth_failed', connected: false, authFailed: true,
  activePanels: 3, reconnectAttempts: 7, protectedFoldersReadable: false,
}

test('our own daemon is believed', () => {
  const r = classifyHealth({ ...alarming, profile: 'smoke' }, 'smoke', 503)
  assert.equal(r.foreign, undefined)
  assert.equal(r.authFailed, true)
  assert.equal(r.activePanels, 3)
  assert.equal(r.state, 'yellow')
})

test('Documents readability prefers the truthful field and accepts the legacy alias', () => {
  const current = classifyHealth({ connected: true, documentsFolderReadable: false, protectedFoldersReadable: true }, null, 200)
  assert.equal(current.documentsFolderReadable, false)

  const legacy = classifyHealth({ connected: true, protectedFoldersReadable: true }, null, 200)
  assert.equal(legacy.documentsFolderReadable, true)
})

// The bug this exists for: two profiles shared port 3102, so the app read
// another daemon's health and threw a working setup back to sign-in.
test("another profile's daemon is refused, and none of its state leaks", () => {
  const r = classifyHealth({ ...alarming, profile: 'dev' }, 'smoke', 503)
  assert.equal(r.foreign, true)
  assert.equal(r.authFailed, false, "must not inherit the stranger's auth_failed")
  assert.equal(r.activePanels, 0, "must not inherit the stranger's panels")
  assert.equal(r.reconnectAttempts, 0)
  assert.equal(r.state, 'red', 'an answer we cannot use is the same as no answer')
})

test('prod (unnamed) and a named profile are not the same daemon', () => {
  assert.equal(classifyHealth({ profile: null }, 'dev', 200).foreign, true)
  assert.equal(classifyHealth({ profile: 'dev' }, null, 200).foreign, true)
  assert.equal(classifyHealth({ profile: null }, null, 200).foreign, undefined)
})

// A version skew must never lock someone out of their own daemon.
test('a daemon too old to report a profile is trusted, as before', () => {
  const r = classifyHealth({ ...alarming }, 'smoke', 503)
  assert.equal(r.foreign, undefined)
  assert.equal(r.authFailed, true)
})

test('green needs both 200 and connected', () => {
  assert.equal(classifyHealth({ profile: null, connected: true }, null, 200).state, 'green')
  assert.equal(classifyHealth({ profile: null, connected: true }, null, 503).state, 'yellow')
  assert.equal(classifyHealth({ profile: null, connected: false }, null, 200).state, 'yellow')
})

// Guarding the 64KB body cap's shape, since the reader that enforces it lives
// in health.ts (which needs Electron's module resolution) and cannot be
// imported here — this at least pins the contract classifyHealth relies on.
test('a body we refused to read is the same as no answer', () => {
  const r = classifyHealth({}, null, 0)
  assert.equal(r.activePanels, 0)
  assert.equal(r.authFailed, false)
})
