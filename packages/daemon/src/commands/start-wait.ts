export type ReadinessProbe<T> =
  | { state: 'ready'; value: T }
  | { state: 'waiting' }
  | { state: 'probe_failed'; error: string }

export type WaitEvent =
  | { event: 'probe_failed'; elapsedMs: number; afterSeconds: number; error: string }
  | { event: 'ready'; elapsedMs: number; afterSeconds: number }
  | { event: 'exhausted'; elapsedMs: number; afterSeconds: number; probeAttempts: number; probeFailures: number; lastProbeError?: string }

export interface WaitForReadinessOptions<T> {
  budgetMs: number
  probe: () => ReadinessProbe<T>
  onEvent: (event: WaitEvent) => void
  tickMs?: number
  now?: () => number
  sleep?: (ms: number) => void
}

export interface WaitForReadinessResult<T> {
  ready: boolean
  value?: T
  elapsedMs: number
  probeAttempts: number
  probeFailures: number
  lastProbeError?: string
}

function monotonicNow(): number {
  return performance.now()
}

function inProcessSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Spend a real monotonic wall-clock budget while synchronously polling.
 *
 * The CLI is synchronous by design, so the pacing primitive is synchronous too.
 * Chunking keeps the deadline precise when a wait is interrupted or returns
 * early; it does not yield to Node's event loop, so signals cannot be delivered
 * until this synchronous loop returns. Fixing that requires making the launchd
 * lifecycle asynchronous (or moving this wait to a worker), which is wider than
 * this repair and would change every synchronous caller.
 */
export function waitForReadiness<T>(options: WaitForReadinessOptions<T>): WaitForReadinessResult<T> {
  const budgetMs = Math.max(0, options.budgetMs)
  const tickMs = Math.min(1_000, Math.max(1, options.tickMs ?? 1_000))
  const now = options.now ?? monotonicNow
  const sleep = options.sleep ?? inProcessSleep
  const startedAt = now()
  const deadline = startedAt + budgetMs
  let probeAttempts = 0
  let probeFailures = 0
  let lastProbeError: string | undefined

  while (now() < deadline) {
    const probe = options.probe()
    probeAttempts++
    const afterProbeMs = now() - startedAt
    const afterSeconds = afterProbeMs / 1_000
    if (probe.state === 'ready') {
      options.onEvent({ event: 'ready', elapsedMs: afterProbeMs, afterSeconds })
      return { ready: true, value: probe.value, elapsedMs: afterProbeMs, probeAttempts, probeFailures, ...(lastProbeError ? { lastProbeError } : {}) }
    }
    if (probe.state === 'probe_failed') {
      probeFailures++
      lastProbeError = probe.error
      options.onEvent({
        event: 'probe_failed',
        elapsedMs: afterProbeMs,
        afterSeconds,
        error: probe.error,
      })
    }

    const remainingMs = deadline - now()
    if (remainingMs <= 0) break
    sleep(Math.min(tickMs, remainingMs))
  }

  const elapsedMs = now() - startedAt
  options.onEvent({
    event: 'exhausted',
    elapsedMs,
    afterSeconds: elapsedMs / 1_000,
    probeAttempts,
    probeFailures,
    ...(lastProbeError ? { lastProbeError } : {}),
  })
  return { ready: false, elapsedMs, probeAttempts, probeFailures, ...(lastProbeError ? { lastProbeError } : {}) }
}
