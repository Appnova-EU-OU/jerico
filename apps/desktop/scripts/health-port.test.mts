import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Both copies of the rule, read from source rather than re-implemented — the
 *  whole failure mode is the daemon and the desktop disagreeing, so a test that
 *  defines its own version would pass while they drift. */
async function load(path: string) {
  const mod = await import(`${path}?t=${Math.random()}`)
  return mod.getHealthPort as () => number
}

const DESKTOP = '../src/main/utils/profile.ts'
const DAEMON = '../../../packages/daemon/src/profile.ts'

async function portFor(profile: string | undefined, path: string): Promise<number> {
  if (profile === undefined) delete process.env['BRIDGE_PROFILE']
  else process.env['BRIDGE_PROFILE'] = profile
  const fn = await load(path)
  return fn()
}

test('the two fixed points hold — existing installs are not stranded', async () => {
  assert.equal(await portFor(undefined, DESKTOP), 3101)
  assert.equal(await portFor('dev', DESKTOP), 3102)
})

test('the daemon and the desktop agree, profile by profile', async () => {
  for (const p of [undefined, 'dev', 'smoke', 'test', 'live-smoke', 's1', 'staging', 'a']) {
    assert.equal(
      await portFor(p, DESKTOP),
      await portFor(p, DAEMON),
      `desktop and daemon disagree for profile ${String(p)}`,
    )
  }
})

// The actual bug: every named profile answered on 3102, so the desktop polled
// whichever daemon won the bind and acted on a stranger's health.
test('two named profiles never share a port', async () => {
  const names = ['dev', 'smoke', 'test', 'live-smoke', 's1', 'staging', 'ci', 'qa']
  const seen = new Map<number, string>()
  for (const p of names) {
    const port = await portFor(p, DESKTOP)
    assert.equal(seen.has(port), false, `${p} collides with ${seen.get(port)} on ${port}`)
    seen.set(port, p)
  }
})

test('derived ports stay inside the reserved band', async () => {
  for (const p of ['smoke', 'test', 'staging', 'zzzz', 'x']) {
    const port = await portFor(p, DESKTOP)
    assert.ok(port >= 3103 && port <= 3199, `${p} → ${port} is outside 3103..3199`)
  }
})

test('an explicit HEALTH_PORT still wins', async () => {
  process.env['BRIDGE_PROFILE'] = 'smoke'
  process.env['HEALTH_PORT'] = '3999'
  const fn = await load(DESKTOP)
  assert.equal(fn(), 3999)
  delete process.env['HEALTH_PORT']
})
