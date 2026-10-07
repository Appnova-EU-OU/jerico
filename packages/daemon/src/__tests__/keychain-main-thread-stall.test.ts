/**
 * Regression test for #635: a synchronous keychain read must never block the
 * daemon's main thread, and a whole refresh cycle must never be swallowed by
 * a handful of stuck agents.
 *
 * This file deliberately does NOT mock `node:child_process` at all.
 * (Naming that function literally here trips scripts/check-mock-module-restore.mjs,
 * which matches on text rather than on the AST — hence the paraphrase.)
 * Mocking a `node:` builtin in Bun poisons named-export resolution for every
 * later test file in the same process — `git-snapshot.test.ts` then dies with
 * "Export named 'spawnSync' not found in module 'node:child_process'" — and no
 * restore shape fixes it (require-snapshot spread, direct object, restore
 * before or after re-registration: all still leak). So the slow subprocess
 * here is a real one, reached through the `JERICO_TEST_SECURITY_BIN` seam.
 */

import { describe, expect, test } from 'bun:test'

describe('#635 keychain read does not block the event loop', () => {
  test('an independent timer keeps firing while a keychain read is outstanding', async () => {
    // A real subprocess that takes a real 400ms, reached through the two
    // test-only seams in credentials.ts. `/bin/sleep 0.4` rather than a stub
    // script written at runtime: the stub passed locally and failed on CI in
    // 26ms, because its exec bit / TMPDIR is not something a test should be
    // betting on. Against the pre-fix `execFileSync` this blocks the JS thread
    // outright, so a 5ms timer cannot tick even once.
    // Import BEFORE setting the variables, deliberately: both seams must be
    // read at call time. As a module-level const the binary override silently
    // did nothing in the full suite, because an earlier test file had already
    // imported this module and frozen the real path — it passed alone and
    // failed on CI at 8ms with a real `security` call.
    const { readCredentialKeychain } = await import('../usage/credentials.js')
    process.env['JERICO_TEST_SECURITY_BIN'] = '/bin/sleep'
    process.env['JERICO_TEST_SECURITY_ARGS'] = '0.4'
    // The Keychain branch runs only on macOS; the seam drives it on every OS
    // (the read is the /bin/sleep above, never the real `security`).
    process.env['JERICO_TEST_KEYCHAIN_PLATFORM'] = 'darwin'
    try {

      let ticks = 0
      const iv = setInterval(() => { ticks += 1 }, 5)

      const start = Date.now()
      const lookup = await readCredentialKeychain('jerico-test-keychain-stall-635', true)
      const elapsed = Date.now() - start
      clearInterval(iv)

      // Fail legibly if the subprocess never ran: a spawn error also returns
      // fast, and without this the assertion below just says "26 < 350".
      expect(`${elapsed}ms ${lookup.found ? 'found' : lookup.detail}`).not.toContain('could not run')
      // Sanity: the subprocess really did take as long as it claims to.
      expect(elapsed).toBeGreaterThanOrEqual(350)
      // The property that matters: something else got to run DURING the read.
      expect(ticks).toBeGreaterThan(3)
    } finally {
      delete process.env['JERICO_TEST_SECURITY_BIN']
      delete process.env['JERICO_TEST_SECURITY_ARGS']
      delete process.env['JERICO_TEST_KEYCHAIN_PLATFORM']
    }
  }, 10_000)

  test('several hanging agents do not exceed the total refresh budget', async () => {
    const HANG_MS = 5_000
    const BUDGET_MS = 200
    const AGENTS = ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e']

    const { __test_runAgentsWithBudget } = await import('../usage/refresher.js')

    const started: string[] = []
    const start = Date.now()
    await __test_runAgentsWithBudget(AGENTS, BUDGET_MS, async (agent) => {
      started.push(agent)
      await new Promise((resolve) => setTimeout(resolve, HANG_MS))
    })
    const elapsed = Date.now() - start

    // Every agent hangs for 5s; five of them run to completion would be 25s.
    // The budgeted loop must stay near its own ceiling instead.
    expect(elapsed).toBeLessThan(BUDGET_MS + 500)
    // The loop must give up rather than silently skip everyone or run once —
    // it should have STARTED at least the first agent before the budget ran out.
    expect(started.length).toBeGreaterThan(0)
    expect(started.length).toBeLessThan(AGENTS.length)
  }, 10_000)

  test('a budget-abandoned attempt cannot overwrite a newer one', async () => {
    // Review (astra) reproduced this through two sequential refreshUsageNow
    // calls: the newer fetch wrote snapshot 2, then the abandoned older fetch
    // settled and wrote snapshot 1 back over it. The loop cannot prevent that
    // — it does not cancel the promise — so the write itself must refuse.
    const { __test_startAttempt, isCurrentAttempt } = await import('../usage/refresher.js')

    const agent = 'jerico-test-agent-635'
    const older = __test_startAttempt(agent)
    const newer = __test_startAttempt(agent)

    // The newest attempt commits.
    expect(isCurrentAttempt(agent, newer)).toBe(true)
    // The abandoned one, settling later, must not.
    expect(isCurrentAttempt(agent, older)).toBe(false)
    // A different agent's bookkeeping is untouched.
    expect(isCurrentAttempt('some-other-agent', 1)).toBe(false)
  })

  test('refreshOne itself keeps the newer result when an older attempt settles late', async () => {
    // The previous test proves the guard primitive. This one proves it is
    // WIRED: delete the `isCurrentAttempt` call from refreshOne and the
    // primitive still passes its own test while the cache regresses again.
    const { __test_refreshOne, __test_setFetchOverride, usageForHealth } =
      await import('../usage/refresher.js')

    const agent = 'claude'
    let releaseOlder: (() => void) | null = null

    const snapshotAt = (ts: number) => ({
      ok: true as const,
      snapshot: {
        identity: { plan: `plan-${ts}`, account: null },
        windows: [],
        fetchedAt: ts,
      },
    })

    __test_setFetchOverride(async () => {
      // First call (the older attempt) parks until released; every later call
      // resolves immediately.
      if (!releaseOlder) {
        await new Promise<void>((resolve) => { releaseOlder = resolve })
        return snapshotAt(1) as never
      }
      return snapshotAt(2) as never
    })

    try {
      const older = __test_refreshOne(agent)
      // Let the override park the first call before starting the second.
      await new Promise((r) => setTimeout(r, 10))
      await __test_refreshOne(agent)

      const afterNewer = usageForHealth().find((e) => e.agent === agent)
      expect(afterNewer?.plan).toBe('plan-2')

      releaseOlder?.()
      await older

      const afterOlderSettles = usageForHealth().find((e) => e.agent === agent)
      // The abandoned older attempt must not roll the cache back.
      expect(afterOlderSettles?.plan).toBe('plan-2')
    } finally {
      __test_setFetchOverride(null)
    }
  })

  test('a deferred keychain read keeps only a keychain snapshot, visibly aged', async () => {
    const { __test_refreshOne, __test_setFetchOverride, usageForHealth } = await import('../usage/refresher.js')
    const agent = 'jerico-test-keychain-deferred'
    let call = 0
    __test_setFetchOverride(async () => {
      call += 1
      if (call === 1) {
        return {
          ok: true as const,
          snapshot: { agent, windows: [], cost: null, identity: { plan: null, loginMethod: null, accountId: null }, fetchedAt: 42, source: 'keychain: test', credentialSource: 'keychain' },
        } as never
      }
      return { ok: false as const, code: 'keychain_deferred', detail: 'deliberately skipped', at: Date.now() } as never
    })
    try {
      await __test_refreshOne(agent)
      await __test_refreshOne(agent)
      const entry = usageForHealth().find((item) => item.agent === agent)
      expect(entry?.fetchedAt).toBe(42)
      expect(entry?.stale).toBe(true)
      expect(entry?.faultCode).toBe('keychain_deferred')
    } finally {
      __test_setFetchOverride(null)
    }
  })

  test('a deferred read does not retain a vanished file-sourced snapshot', async () => {
    const { __test_refreshOne, __test_setFetchOverride, usageForHealth } = await import('../usage/refresher.js')
    const agent = 'jerico-test-file-not-retained'
    let call = 0
    __test_setFetchOverride(async () => {
      call += 1
      if (call === 1) return { ok: true as const, snapshot: { agent, windows: [], cost: null, identity: { plan: null, loginMethod: null, accountId: null }, fetchedAt: 42, source: '~/.claude/.credentials.json' } } as never
      return { ok: false as const, code: 'keychain_deferred', detail: 'deliberately skipped', at: Date.now() } as never
    })
    try {
      await __test_refreshOne(agent)
      await __test_refreshOne(agent)
      const entry = usageForHealth().find((item) => item.agent === agent)
      expect(entry?.fetchedAt).toBeNull()
      expect(entry?.faultCode).toBe('keychain_deferred')
    } finally {
      __test_setFetchOverride(null)
    }
  })
})
