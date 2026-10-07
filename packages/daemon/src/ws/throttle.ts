export interface RttState {
  rttEma: number | null
  rollingBaseline: number | null
  history: number[]
}

const state: RttState = {
  rttEma: null,
  rollingBaseline: null,
  history: [],
}

const ALPHA = 0.125
const BETA = 0.05

export function resetRttState(): void {
  state.rttEma = null
  state.rollingBaseline = null
  state.history = []
}

export function updateRtt(rttMs: number): void {
  state.history.push(rttMs)
  if (state.history.length > 30) state.history.shift()

  if (state.rttEma === null) {
    state.rttEma = rttMs
    state.rollingBaseline = rttMs
  } else {
    state.rttEma = ALPHA * rttMs + (1 - ALPHA) * state.rttEma
    state.rollingBaseline = BETA * rttMs + (1 - BETA) * state.rollingBaseline!
  }
}

export function getRttState(): RttState {
  return { ...state }
}

/**
 * Returns the threshold to use for throttling.
 * Returns null if throttling is disabled.
 */
export function getThrottleThreshold(envValue: string | undefined): number | null {
  if (envValue === undefined || envValue === '') {
    return null
  }

  const parsed = parseInt(envValue, 10)
  if (!isNaN(parsed) && parsed > 0) {
    return parsed
  }

  // If set but not a number (e.g. "auto" or "true"), use default per verdict: max(250ms, 3 * rollingBaseline)
  const baseline = state.rollingBaseline ?? 80 // fallback baseline if not yet measured
  return Math.max(250, 3 * baseline)
}

/**
 * Pure helper to decide whether to throttle.
 * Returns true if we should drop/throttle PTY output.
 */
export function shouldThrottlePty(
  rttEma: number | null,
  threshold: number | null
): boolean {
  if (threshold === null || rttEma === null) {
    return false
  }
  return rttEma > threshold
}
