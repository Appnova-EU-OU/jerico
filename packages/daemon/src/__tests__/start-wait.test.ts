import { describe, expect, test } from 'bun:test'
import { waitForReadiness, type WaitEvent } from '../commands/start-wait.js'

describe('waitForReadiness', () => {
  test('uses a monotonic deadline and never sleeps in chunks over one second', () => {
    let now = 10_000
    const sleeps: number[] = []
    const events: WaitEvent[] = []
    const result = waitForReadiness({
      budgetMs: 2_500,
      tickMs: 5_000,
      now: () => now,
      sleep: (ms) => { sleeps.push(ms); now += ms },
      probe: () => ({ state: 'probe_failed', error: 'spawn launchctl EAGAIN' }),
      onEvent: (event) => events.push(event),
    })

    expect(result.ready).toBe(false)
    expect(result.elapsedMs).toBe(2_500)
    expect(sleeps).toEqual([1_000, 1_000, 500])
    expect(events.filter((event) => event.event === 'probe_failed')).toHaveLength(3)
    expect(events.at(-1)).toEqual({
      event: 'exhausted',
      elapsedMs: 2_500,
      afterSeconds: 2.5,
      probeAttempts: 3,
      probeFailures: 3,
      lastProbeError: 'spawn launchctl EAGAIN',
    })
  })

  test('reports measured readiness time rather than an iteration index', () => {
    let now = 0
    let probes = 0
    const events: WaitEvent[] = []
    const result = waitForReadiness({
      budgetMs: 5_000,
      tickMs: 400,
      now: () => now,
      sleep: (ms) => { now += ms },
      probe: () => ++probes === 4
        ? { state: 'ready', value: 42 }
        : { state: 'waiting' },
      onEvent: (event) => events.push(event),
    })

    expect(result).toEqual({ ready: true, value: 42, elapsedMs: 1_200, probeAttempts: 4, probeFailures: 0 })
    expect(events).toEqual([{ event: 'ready', elapsedMs: 1_200, afterSeconds: 1.2 }])
  })
})
