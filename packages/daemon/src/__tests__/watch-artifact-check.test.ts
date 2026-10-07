import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  checkWatchArtifact,
  checkWatchArtifactStable,
  listRecentProjectChanges,
  MAX_CHANGED_ENTRIES_SCANNED,
  MAX_CHANGED_ENTRY_RESULTS,
} from '../ws/watch-artifact-check.js'

const roots: string[] = []

function fixture(content: string): { cwd: string; file: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-watch-artifact-'))
  roots.push(cwd)
  const file = path.join(cwd, 'report.md')
  fs.writeFileSync(file, content)
  return { cwd, file }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('daemon watch artifact check (#80)', () => {
  test('pinned check accepts a verdict-less sentinel in the last non-empty line', () => {
    const { cwd } = fixture('work log\nVERIFY_DONE\n')
    expect(checkWatchArtifact({ cwd, path: 'report.md', taskSuffix: 'VERIFY' })).toEqual({
      verified: true,
      sentinel: 'VERIFY_DONE',
    })
  })

  test('pinned check rejects a sentinel before the last non-empty line', () => {
    const { cwd } = fixture('## Report\nVERIFY_DONE\n## Summary\nall good, no issues found\n')
    expect(checkWatchArtifact({ cwd, path: 'report.md', taskSuffix: 'VERIFY' })).toEqual({ verified: false })
  })

  test('unpinned check retains the verdict= noise gate', () => {
    const { cwd } = fixture('work log\nBUILD_DONE\n')
    expect(checkWatchArtifact({ cwd, path: 'report.md' }).verified).toBe(false)
    fs.writeFileSync(path.join(cwd, 'report.md'), 'BUILD_DONE verdict=ok\n')
    expect(checkWatchArtifact({ cwd, path: 'report.md' })).toEqual({
      verified: true,
      sentinel: 'BUILD_DONE',
    })
  })

  // Issue #84: notBeforeAgeMs is a duration evaluated entirely with this
  // process's own Date.now()/fs.statSync — no server timestamp crosses the
  // wire, so cross-machine clock skew cannot affect the result. These cases
  // replace the old absolute-epoch test.
  test('a fresh artifact is accepted regardless of any server-side clock offset', () => {
    const { cwd } = fixture('VERIFY_DONE\n')
    // Old behavior: an absolute `notBeforeMs` even 1s in the future (simulating
    // a server clock ahead of this host) would reject a just-written file as
    // stale. The relative form has no such term — a generous age window on a
    // file written moments ago must verify.
    const result = checkWatchArtifact({
      cwd,
      path: 'report.md',
      taskSuffix: 'VERIFY',
      notBeforeAgeMs: 60_000,
    })
    expect(result).toEqual({ verified: true, sentinel: 'VERIFY_DONE' })
  })

  test('an artifact older than notBeforeAgeMs is rejected as stale (same-task-retry regression guard)', () => {
    const { cwd, file } = fixture('FIX_LOGIN_DONE\n')
    const tenMinAgo = (Date.now() - 10 * 60_000) / 1000
    fs.utimesSync(file, tenMinAgo, tenMinAgo)
    const result = checkWatchArtifact({
      cwd,
      path: 'report.md',
      taskSuffix: 'FIX_LOGIN',
      notBeforeAgeMs: 60_000,
    })
    expect(result.verified).toBe(false)
    expect(result.error).toBe('stale')
  })

  test('boundary: age exactly equal to notBeforeAgeMs is accepted (> not >=)', () => {
    const { cwd, file } = fixture('VERIFY_DONE\n')
    const fiveSecAgo = (Date.now() - 5_000) / 1000
    fs.utimesSync(file, fiveSecAgo, fiveSecAgo)
    const result = checkWatchArtifact({
      cwd,
      path: 'report.md',
      taskSuffix: 'VERIFY',
      notBeforeAgeMs: 60_000,
    })
    expect(result.verified).toBe(true)
  })

  test('an invalid notBeforeAgeMs (negative/NaN) disables the staleness guard rather than throwing', () => {
    const { cwd } = fixture('VERIFY_DONE\n')
    for (const bad of [-1, NaN, Infinity]) {
      const result = checkWatchArtifact({
        cwd,
        path: 'report.md',
        taskSuffix: 'VERIFY',
        notBeforeAgeMs: bad,
      })
      expect(result.verified).toBe(true)
    }
  })

  test('realpath containment rejects a symlink escaping cwd', () => {
    const { cwd } = fixture('safe\n')
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-watch-outside-'))
    roots.push(outside)
    const secret = path.join(outside, 'secret.md')
    fs.writeFileSync(secret, 'VERIFY_DONE\n')
    fs.symlinkSync(secret, path.join(cwd, 'escape.md'))

    const result = checkWatchArtifact({ cwd, path: 'escape.md', taskSuffix: 'VERIFY' })
    expect(result.verified).toBe(false)
    expect(result.error).toBe('path_denied')
    expect(result).not.toHaveProperty('content')
  })

  test('recent project changes are names-only, newest-first, and do not follow an escaping symlink', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-watch-artifact-'))
    roots.push(cwd)
    const now = Date.now()
    const older = path.join(cwd, 'my-summary.md')
    const newer = path.join(cwd, 'notes.txt')
    const stale = path.join(cwd, 'old.log')
    fs.writeFileSync(older, 'wrong filename\n')
    fs.writeFileSync(newer, 'newer\n')
    fs.writeFileSync(stale, 'old\n')
    fs.utimesSync(older, (now - 110_000) / 1000, (now - 110_000) / 1000)
    fs.utimesSync(newer, (now - 20_000) / 1000, (now - 20_000) / 1000)
    fs.utimesSync(stale, (now - 300_000) / 1000, (now - 300_000) / 1000)

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-watch-outside-'))
    roots.push(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'must not be named\n')
    fs.symlinkSync(outside, path.join(cwd, 'outside-link'))

    const result = listRecentProjectChanges(cwd, 120_000)!
    expect(result.changedEntries.map(entry => entry.path).slice(0, 2)).toEqual(['outside-link', 'notes.txt'])
    expect(result.changedEntries.map(entry => entry.path)).toContain('my-summary.md')
    expect(result.changedEntries.map(entry => entry.path)).not.toContain('old.log')
    expect(result.changedEntries.some(entry => entry.path.includes('secret.txt'))).toBe(false)
    expect(result.changedEntries.every(entry => !path.isAbsolute(entry.path))).toBe(true)
  })

  test('recent project change scan caps both filesystem cost and delivered names', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-watch-artifact-'))
    roots.push(cwd)
    for (let index = 0; index < MAX_CHANGED_ENTRIES_SCANNED + 20; index++) {
      fs.writeFileSync(path.join(cwd, `entry-${String(index).padStart(3, '0')}.txt`), 'x')
    }

    const result = listRecentProjectChanges(cwd, 60_000)!
    expect(result.changedEntries).toHaveLength(MAX_CHANGED_ENTRY_RESULTS)
    expect(result.changedEntryCount).toBe(MAX_CHANGED_ENTRIES_SCANNED)
    expect(result.changedEntryScanTruncated).toBe(true)
  })

  test('slow drip with marker first does not complete while 12 appends arrive at 500ms', async () => {
    const { cwd, file } = fixture('GROWCASE_DONE v=OK\n')
    let appends = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const writer = new Promise<void>((resolve) => {
      const append = () => {
        appends++
        fs.appendFileSync(file, `still writing ${appends}\n`)
        if (appends === 12) resolve()
        else timer = setTimeout(append, 500)
      }
      append()
    })

    try {
      const result = await checkWatchArtifactStable({ cwd, path: 'report.md', taskSuffix: 'GROWCASE' })
      expect(result.verified).toBe(false)
      expect(appends).toBeLessThan(12)
      await writer
    } finally {
      if (timer) clearTimeout(timer)
    }
  }, 8_000)

  test('marker last in a settled report verifies after exactly two confirming intervals', async () => {
    const { cwd } = fixture('SETTLED_DONE\n')
    let waits = 0
    const result = await checkWatchArtifactStable(
      { cwd, path: 'report.md', taskSuffix: 'SETTLED' },
      10,
      async (ms) => {
        waits++
        await new Promise(resolve => setTimeout(resolve, ms))
      },
    )
    expect(result).toEqual({ verified: true, sentinel: 'SETTLED_DONE' })
    expect(waits).toBe(2)
  })

  test('a file placed atomically by rename verifies after two intervals without a spurious third', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-watch-artifact-'))
    roots.push(cwd)
    const staged = path.join(cwd, '.report.md.tmp')
    fs.writeFileSync(staged, 'ATOMIC_DONE\n')
    fs.renameSync(staged, path.join(cwd, 'report.md'))

    let waits = 0
    const result = await checkWatchArtifactStable(
      { cwd, path: 'report.md', taskSuffix: 'ATOMIC' },
      10,
      async (ms) => {
        waits++
        await new Promise(resolve => setTimeout(resolve, ms))
      },
    )
    expect(result).toEqual({ verified: true, sentinel: 'ATOMIC_DONE' })
    expect(waits).toBe(2)
  })
})
