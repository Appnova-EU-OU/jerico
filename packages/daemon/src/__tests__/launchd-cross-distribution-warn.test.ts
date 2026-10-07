/**
 * Issue #12 — the app-bundled binary and a standalone `npm install -g
 * bridge-agent` install both register under the identical launchd label
 * (getPlistName() only differentiates on --profile, not distribution), and
 * setupLaunchd used to overwrite the wrapper script + plist unconditionally.
 * Whichever distribution ran `bridge-agent start` last silently won,
 * downgrading the app's daemon with zero log signal.
 *
 * warnIfReplacingDifferentDaemonTarget is the diagnostic guard: it compares
 * the OLD wrapper script content against the NEW one before it gets
 * overwritten and logs loudly on a mismatch. Tested in isolation against
 * throwaway temp files — never the real ~/Library/LaunchAgents or
 * ~/.bridge/bridge-agent-wrapper.sh, which this test machine's own real
 * daemon is genuinely registered under.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { warnIfReplacingDifferentDaemonTarget } from '../commands/start.js'
import { getLogPaths } from '../profile.js'

let testHome: string
let originalHome: string | undefined

// Defensive only: this test's own fixtures live under os.tmpdir(). Keep any
// future home-derived logging added below away from a developer's live state.
beforeAll(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'launchd-warn-home-'))
  originalHome = process.env['HOME']
  process.env['HOME'] = testHome
  expect(getLogPaths().lifecycle.startsWith(testHome)).toBe(true)
})

afterAll(() => {
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  fs.rmSync(testHome, { recursive: true, force: true })
})

describe('#12 warnIfReplacingDifferentDaemonTarget', () => {
  let tmpDir: string
  let wrapperPath: string
  let warnCalls: unknown[][]
  let origWarn: typeof console.warn

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-launchd-warn-test-'))
    wrapperPath = path.join(tmpDir, 'bridge-agent-wrapper.sh')
    warnCalls = []
    origWarn = console.warn
    console.warn = (...args: unknown[]) => { warnCalls.push(args) }
  })
  afterEach(() => {
    console.warn = origWarn
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('no-op when no wrapper exists yet (first-ever install)', () => {
    const newScript = '#!/bin/bash --norc\nexec "/Applications/jerico.app/Contents/Resources/bridge-agent" start\n'
    warnIfReplacingDifferentDaemonTarget(wrapperPath, newScript)
    expect(warnCalls).toHaveLength(0)
  })

  test('no warning when the new content is identical (same distribution, ordinary refresh/version bump)', () => {
    const script = '#!/bin/bash --norc\nexec "/Applications/jerico.app/Contents/Resources/bridge-agent" start\n'
    fs.writeFileSync(wrapperPath, script)
    warnIfReplacingDifferentDaemonTarget(wrapperPath, script)
    expect(warnCalls).toHaveLength(0)
  })

  test('warns loudly when replacing the app-bundled binary with an npm-installed entry (the exact #12 incident)', () => {
    const appScript = '#!/bin/bash --norc\nexec "/Applications/jerico.app/Contents/Resources/bridge-agent" start\n'
    const npmScript = '#!/bin/bash --norc\nexec "$(command -v node)" "/opt/homebrew/lib/node_modules/bridge-agent/dist/index.js" start\n'
    fs.writeFileSync(wrapperPath, appScript)

    warnIfReplacingDifferentDaemonTarget(wrapperPath, npmScript)

    expect(warnCalls).toHaveLength(1)
    const [msg] = warnCalls[0] as [string]
    expect(msg).toContain('launchd.wrapper.replacing_different_target')
    expect(msg).toContain('/Applications/jerico.app/Contents/Resources/bridge-agent')
    expect(msg).toContain('/opt/homebrew/lib/node_modules/bridge-agent/dist/index.js')
    expect(msg).toContain('#12')
  })

  test('warns in the reverse direction too (npm entry being replaced by the app binary)', () => {
    const npmScript = '#!/bin/bash --norc\nexec "$(command -v node)" "/opt/homebrew/lib/node_modules/bridge-agent/dist/index.js" start\n'
    const appScript = '#!/bin/bash --norc\nexec "/Applications/jerico.app/Contents/Resources/bridge-agent" start\n'
    fs.writeFileSync(wrapperPath, npmScript)

    warnIfReplacingDifferentDaemonTarget(wrapperPath, appScript)

    expect(warnCalls).toHaveLength(1)
  })

  test('does not throw if the existing wrapper is unreadable/malformed', () => {
    fs.writeFileSync(wrapperPath, 'not a valid wrapper script at all')
    expect(() => warnIfReplacingDifferentDaemonTarget(wrapperPath, '#!/bin/bash\nexec "/x" start\n')).not.toThrow()
  })
})
