import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { waitForDaemonReadiness } from '../commands/start.js'

const source = readFileSync(path.join(import.meta.dir, '..', 'commands', 'start.ts'), 'utf8')

test('all launchd success paths pass through daemon-lock readiness', () => {
  const loadedRunning = source.slice(
    source.indexOf("if (jobState === 'loaded_running')"),
    source.indexOf('// ── For stopped/not-loaded'),
  )
  expect(loadedRunning).toContain('waitForDaemonReadiness')
  expect(loadedRunning.indexOf('waitForDaemonReadiness')).toBeLessThan(loadedRunning.indexOf("reason: 'already_running'"))

  const loadedStopped = source.slice(
    source.indexOf("if (jobState === 'loaded_stopped')"),
    source.indexOf('// ── Not loaded'),
  )
  expect(loadedStopped).toContain('settleAfterTimeout()')

  const concurrent = source.slice(source.indexOf('function waitForConcurrentStart'), source.indexOf('/**\n * The one line'))
  expect(concurrent).toContain('waitForDaemonReadiness')
})

test('health bind conflicts become an observed terminal lock state', () => {
  expect(source).toContain("raw['healthError'] === 'EADDRINUSE'")
  expect(source).toContain("writeDaemonLock(version, binaryPath, false, 'EADDRINUSE')")
  expect(source).toContain("return 'health_port_in_use'")
})

for (const prefix of ['settle', 'concurrent'] as const) {
  test(`shared waiter drives the ${prefix} call-site telemetry and deadline`, () => {
    let now = 0
    const events: string[] = []
    const result = waitForDaemonReadiness('com.jerico.test', prefix, null, 2_500, 0, {
      probe: () => ({ state: 'probe_failed', error: 'EMFILE' }),
      tickMs: 1_000,
      now: () => now,
      sleep: (ms) => { now += ms },
      emit: (event) => events.push(event),
    })

    expect(result).toEqual({
      ready: false,
      elapsedMs: 2_500,
      probeAttempts: 3,
      probeFailures: 3,
      lastProbeError: 'EMFILE',
    })
    expect(events).toEqual([
      `lifecycle.start.${prefix}_probe_failed`,
      `lifecycle.start.${prefix}_probe_failed`,
      `lifecycle.start.${prefix}_probe_failed`,
      `lifecycle.start.${prefix}_exhausted`,
    ])
  })
}
