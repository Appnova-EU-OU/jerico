import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isRealUsageFault } from '../commands/usage.js'
import { __test_resetAgyCliUsage, __test_setAgyCliLastStartedAt, __test_setAgyCliSnapshotAge, __test_setAskRunningAgyOverride, fetchAgyUsage, parseAgyCliUsage } from '../usage/providers/agy.js'

const SUCCESS = JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
  { name: 'Gemini Models', items: [{ id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.75, reset_time: '2026-10-05T00:00:00Z' }] },
  { name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-10-09T00:00:00Z' }] },
] } } })

let root = ''
let oldHome: string | undefined
let oldBin: string | undefined
let oldTimeout: string | undefined

function stub(body: string): string {
  const file = path.join(root, `agy-${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  chmodSync(file, 0o700)
  return file
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jerico-agy-cli-'))
  oldHome = process.env.HOME; oldBin = process.env.JERICO_TEST_AGY_BIN; oldTimeout = process.env.JERICO_TEST_AGY_TIMEOUT_MS
  process.env.HOME = root
  __test_setAskRunningAgyOverride(async () => null)
  __test_resetAgyCliUsage()
})
afterEach(() => {
  __test_setAskRunningAgyOverride(null); __test_resetAgyCliUsage()
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
  if (oldBin === undefined) delete process.env.JERICO_TEST_AGY_BIN; else process.env.JERICO_TEST_AGY_BIN = oldBin
  if (oldTimeout === undefined) delete process.env.JERICO_TEST_AGY_TIMEOUT_MS; else process.env.JERICO_TEST_AGY_TIMEOUT_MS = oldTimeout
  rmSync(root, { recursive: true, force: true })
})

describe('agy /usage CLI lane', () => {
  test('strictly maps both accepted group item keys and marks agent_cli provenance', async () => {
    process.env.JERICO_TEST_AGY_BIN = stub(`printf '%s' '${SUCCESS}'`)
    const result = await fetchAgyUsage({ allowInteractive: true })
    expect(result).toMatchObject({ ok: true, snapshot: { source: 'agy /usage', credentialSource: 'agent_cli' } })
    if (result.ok) {
      expect(result.snapshot.windows.find((w) => w.id === 'group:gemini-models:gemini-5h')?.usedPercent).toBe(25)
      expect(result.snapshot.windows.find((w) => w.id === 'group:claude-and-gpt-models:3p-weekly')?.usedPercent).toBe(50)
      expect(result.snapshot.windows.find((w) => w.id === 'group:gemini-models:gemini-5h')?.title).toBe('5h used')
    }
  })

  test('rejects non-success and malformed shapes rather than inventing a quota', () => {
    expect('error' in parseAgyCliUsage({ status: 'ERROR', command: { name: 'usage', data: {} } })).toBe(true)
    expect('error' in parseAgyCliUsage({ status: 'SUCCESS', command: { name: 'other', data: {} } })).toBe(true)
    expect('error' in parseAgyCliUsage({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [] } } })).toBe(true)
    expect('error' in parseAgyCliUsage({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', items: [{ id: 'bad', window: '5h', remaining_fraction: 2 }] }] } } })).toBe(true)
  })

  test('an auth rejection from a non-SUCCESS CLI result is unauthorized, not OAuth fallback', async () => {
    process.env.JERICO_TEST_AGY_BIN = stub(`printf '%s' '{"status":"ERROR","message":"authentication required","command":{"name":"usage","data":{}}}'`)
    expect(await fetchAgyUsage({ allowInteractive: true })).toMatchObject({ ok: false, code: 'unauthorized' })
  })

  test('background refresh never executes the CLI', async () => {
    const marker = path.join(root, 'executed')
    process.env.JERICO_TEST_AGY_BIN = stub(`touch '${marker}'\nprintf '%s' '${SUCCESS}'`)
    const result = await fetchAgyUsage({ allowInteractive: false })
    expect(result.ok).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  test('concurrent refreshes attach to one CLI run and the ten-minute throttle avoids a second run', async () => {
    const marker = path.join(root, 'count')
    process.env.JERICO_TEST_AGY_BIN = stub(`echo x >> '${marker}'\nsleep 0.05\nprintf '%s' '${SUCCESS}'`)
    const [a, b] = await Promise.all([fetchAgyUsage({ allowInteractive: true }), fetchAgyUsage({ allowInteractive: true })])
    expect(a.ok).toBe(true); expect(b.ok).toBe(true)
    const c = await fetchAgyUsage({ allowInteractive: true })
    expect(c).toMatchObject({ ok: true, snapshot: { source: 'agy /usage' } })
    expect((await Bun.file(marker).text()).trim().split('\n')).toHaveLength(1)
  })

  test('a failed reread never returns the old CLI snapshot as fresh, and snapshots expire after six hours', async () => {
    process.env.JERICO_TEST_AGY_BIN = stub(`printf '%s' '${SUCCESS}'`)
    expect((await fetchAgyUsage({ allowInteractive: true })).ok).toBe(true)
    __test_setAgyCliLastStartedAt(0)
    process.env.JERICO_TEST_AGY_BIN = stub('exit 3')
    const reread = await fetchAgyUsage({ allowInteractive: true })
    expect(reread.ok).toBe(false)
    __test_setAgyCliSnapshotAge(6 * 60 * 60_000 + 1)
    __test_setAgyCliLastStartedAt(Date.now())
    const expired = await fetchAgyUsage({ allowInteractive: true })
    expect(expired.ok).toBe(false)
  })

  test('oversized and timed-out output fall back without exposing stdout', async () => {
    process.env.JERICO_TEST_AGY_BIN = stub('head -c 70000 /dev/zero')
    expect((await fetchAgyUsage({ allowInteractive: true })).ok).toBe(false)
    __test_resetAgyCliUsage()
    process.env.JERICO_TEST_AGY_TIMEOUT_MS = '25'
    process.env.JERICO_TEST_AGY_BIN = stub('sleep 1')
    expect((await fetchAgyUsage({ allowInteractive: true })).ok).toBe(false)
  })

  test('a spawn error logs bounded metadata once and settles without waiting for the timeout', async () => {
    process.env.JERICO_TEST_AGY_BIN = path.join(root, 'missing-agy')
    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      const started = Date.now()
      expect((await fetchAgyUsage({ allowInteractive: true })).ok).toBe(false)
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(warnings.filter((args) => args[0] === '[daemon] usage.agy.cli_failed')).toHaveLength(1)
    } finally { console.warn = original }
  })

  test('deferred states are neutral CLI outcomes', () => {
    expect(isRealUsageFault({ ok: false, code: 'interactive_deferred', detail: 'open usage', at: Date.now() })).toBe(false)
    expect(isRealUsageFault({ ok: false, code: 'keychain_deferred', detail: 'open usage', at: Date.now() })).toBe(false)
    expect(isRealUsageFault({ ok: false, code: 'unauthorized', detail: 'bad token', at: Date.now() })).toBe(true)
  })
})
