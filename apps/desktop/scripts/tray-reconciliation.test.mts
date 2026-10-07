import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const tray = fs.readFileSync(
  path.resolve(import.meta.dirname, '../src/main/tray.ts'),
  'utf-8',
)

test('the popover action latch uses the derived daemon lifecycle contract', () => {
  assert.match(tray, /import \{ DAEMON_ACTION_LATCH_TIMEOUT_MS \} from '\.\/utils\/spawn\.js'/)
  assert.match(tray, /}, DAEMON_ACTION_LATCH_TIMEOUT_MS\)/)
  assert.doesNotMatch(tray, /}, 25_000\)/)
})

test('restart progress feeds main popover state and event log, not the deleted window', () => {
  assert.match(tray, /showLifecycleProgress\(progress: LifecycleProgress\)/)
  assert.match(tray, /lifecycle\.restart\.\$\{progress\.stage\}/)
  assert.match(tray, /this\.applyViewState\('stopping'\)/)
  assert.match(tray, /this\.applyViewState\('starting'\)/)
  assert.doesNotMatch(tray, /ActionWindow|actionWindow/)
})
