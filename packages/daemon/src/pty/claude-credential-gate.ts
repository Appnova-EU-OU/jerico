import { execFile, type ExecFileException } from 'node:child_process'

export const CLAUDE_AUTH_CHECK_TIMEOUT_MS = 5_000
export const CLAUDE_AUTH_CHECK_MAX_BYTES = 16 * 1024
export const CLAUDE_AUTH_RECHECK_MIN_MS = 2_000

export type ClaudeCredentialOutcome =
  | { status: 'authenticated' }
  | { status: 'unauthenticated' }
  | { status: 'unknown'; reason: 'command_missing' | 'timeout' | 'nonzero_exit' | 'malformed_json' | 'unsupported_shape' }

type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void
export type ClaudeAuthCommandRunner = (
  binary: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: 'utf8'; windowsHide: true },
  callback: ExecFileCallback,
) => void

// The four fields the verdict is derived from. Claude Code adds fields over
// time — 2.1.247 also returns email/orgId/orgName/subscriptionType on team
// plans — so an unknown extra key is normal API evolution, not a suspicious
// document. Requiring an exact key set made every team-plan user fail the
// preflight with "credential check could not be verified" while their CLI was
// perfectly logged in. Missing or wrongly-typed required fields are still
// refused; that is what this check is for.
const CLAUDE_AUTH_KEYS = ['analyticsDisabled', 'apiProvider', 'authMethod', 'loggedIn'] as const
const SAFE_STATUS_VALUE = /^[A-Za-z0-9._+-]{1,64}$/

export function parseClaudeAuthStatusJson(stdout: string): ClaudeCredentialOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { status: 'unknown', reason: 'malformed_json' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unknown', reason: 'unsupported_shape' }
  }
  const record = parsed as Record<string, unknown>
  if (CLAUDE_AUTH_KEYS.some(key => !(key in record))
    || typeof record.loggedIn !== 'boolean'
    || typeof record.analyticsDisabled !== 'boolean'
    || typeof record.apiProvider !== 'string' || !SAFE_STATUS_VALUE.test(record.apiProvider)
    || typeof record.authMethod !== 'string' || !SAFE_STATUS_VALUE.test(record.authMethod)) {
    return { status: 'unknown', reason: 'unsupported_shape' }
  }
  return record.loggedIn ? { status: 'authenticated' } : { status: 'unauthenticated' }
}

const defaultRunner: ClaudeAuthCommandRunner = (binary, args, options, callback) => {
  execFile(binary, [...args], options, callback)
}

export function checkClaudeCredentialStatus(
  binary: string,
  env: Record<string, string>,
  runner: ClaudeAuthCommandRunner = defaultRunner,
): Promise<ClaudeCredentialOutcome> {
  return new Promise(resolve => {
    runner(binary, ['auth', 'status', '--json'], {
      env,
      timeout: CLAUDE_AUTH_CHECK_TIMEOUT_MS,
      maxBuffer: CLAUDE_AUTH_CHECK_MAX_BYTES,
      encoding: 'utf8',
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        // Fatal/abnormal runner outcomes have precedence and must never trust
        // partial or complete-looking stdout.
        if (error.code === 'ENOENT') {
          resolve({ status: 'unknown', reason: 'command_missing' })
          return
        }
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ status: 'unknown', reason: 'nonzero_exit' })
          return
        }
        if (error.killed === true && error.signal === 'SIGTERM') {
          resolve({ status: 'unknown', reason: 'timeout' })
          return
        }
        if (error.signal) {
          resolve({ status: 'unknown', reason: 'nonzero_exit' })
          return
        }

        // Claude Code 2.1.246 uses ordinary exit 1 for its exact supported
        // logged-out document. This is the sole nonzero exception: never accept
        // a positive, malformed, arbitrary, missing, extra, or unsupported shape.
        if (typeof error.code === 'number' && error.code !== 0 && error.killed === false) {
          const parsed = parseClaudeAuthStatusJson(stdout)
          if (parsed.status === 'unauthenticated') {
            resolve(parsed)
            return
          }
        }
        resolve({ status: 'unknown', reason: 'nonzero_exit' })
        return
      }
      resolve(parseClaudeAuthStatusJson(stdout))
    })
  })
}

export interface ClaudeCredentialBinding {
  agentId: string
  panelInstanceId: number
  binary: string
  env: Record<string, string>
}

export interface ClaudeCredentialCallbacks {
  onChecking(): void
  onBlocked(outcome: Extract<ClaudeCredentialOutcome, { status: 'unauthenticated' | 'unknown' }>): void
  onAwaitingFreshProtocol(): void
  onReady(): void
}

interface ClaudeCredentialState {
  binding: ClaudeCredentialBinding
  callbacks: ClaudeCredentialCallbacks
  status: 'checking' | 'authenticated' | 'unauthenticated' | 'unknown'
  checkSerial: number
  inFlight: boolean
  lastCheckStartedAt: number
  protocolObservedAt?: number
  readyReleased: boolean
  retryTimer: ReturnType<typeof setTimeout> | null
}

export interface ClaudeCredentialGateOptions {
  check?: (binary: string, env: Record<string, string>) => Promise<ClaudeCredentialOutcome>
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  recheckMinMs?: number
}

export class ClaudeCredentialGate {
  private readonly states = new Map<string, ClaudeCredentialState>()
  private readonly check: (binary: string, env: Record<string, string>) => Promise<ClaudeCredentialOutcome>
  private readonly now: () => number
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly recheckMinMs: number

  constructor(options: ClaudeCredentialGateOptions = {}) {
    this.check = options.check ?? checkClaudeCredentialStatus
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.recheckMinMs = options.recheckMinMs ?? CLAUDE_AUTH_RECHECK_MIN_MS
  }

  bind(binding: ClaudeCredentialBinding, callbacks: ClaudeCredentialCallbacks): void {
    this.remove(binding.agentId)
    const state: ClaudeCredentialState = {
      binding: { ...binding, env: { ...binding.env } },
      callbacks,
      status: 'checking',
      checkSerial: 0,
      inFlight: false,
      lastCheckStartedAt: Number.NEGATIVE_INFINITY,
      readyReleased: false,
      retryTimer: null,
    }
    this.states.set(binding.agentId, state)
    callbacks.onChecking()
    this.runCheck(state, true)
  }

  observeProtocolReady(agentId: string, panelInstanceId: number): boolean {
    const state = this.states.get(agentId)
    if (!state || state.binding.panelInstanceId !== panelInstanceId || state.readyReleased) return false
    state.protocolObservedAt = this.now()
    if (state.status !== 'authenticated') return false
    state.readyReleased = true
    state.callbacks.onReady()
    return true
  }

  noteActivity(agentId: string, panelInstanceId: number): void {
    const state = this.states.get(agentId)
    if (!state || state.binding.panelInstanceId !== panelInstanceId || state.readyReleased
      || (state.status !== 'unauthenticated' && state.status !== 'unknown')) return
    const waitMs = Math.max(0, state.lastCheckStartedAt + this.recheckMinMs - this.now())
    if (waitMs === 0) {
      this.runCheck(state, false)
      return
    }
    if (state.retryTimer) return
    state.retryTimer = this.setTimer(() => {
      state.retryTimer = null
      if (this.states.get(agentId) === state) this.runCheck(state, false)
    }, waitMs)
  }

  remove(agentId: string): void {
    const state = this.states.get(agentId)
    if (state?.retryTimer) this.clearTimer(state.retryTimer)
    this.states.delete(agentId)
  }

  isAutomationReady(agentId: string, panelInstanceId: number): boolean {
    const state = this.states.get(agentId)
    return state?.binding.panelInstanceId === panelInstanceId && state.readyReleased
  }

  hasBinding(agentId: string, panelInstanceId: number): boolean {
    return this.states.get(agentId)?.binding.panelInstanceId === panelInstanceId
  }

  getStateForTest(agentId: string): { status: string; inFlight: boolean; readyReleased: boolean; checkSerial: number } | undefined {
    const state = this.states.get(agentId)
    return state ? {
      status: state.status,
      inFlight: state.inFlight,
      readyReleased: state.readyReleased,
      checkSerial: state.checkSerial,
    } : undefined
  }

  private runCheck(state: ClaudeCredentialState, initial: boolean): void {
    if (state.inFlight || this.states.get(state.binding.agentId) !== state) return
    state.inFlight = true
    state.lastCheckStartedAt = this.now()
    const startedAt = state.lastCheckStartedAt
    const serial = ++state.checkSerial
    void this.check(state.binding.binary, { ...state.binding.env }).then(outcome => {
      const current = this.states.get(state.binding.agentId)
      if (current !== state || current.binding.panelInstanceId !== state.binding.panelInstanceId
        || current.checkSerial !== serial) return
      state.inFlight = false
      if (outcome.status === 'authenticated') {
        state.status = 'authenticated'
        if (initial && state.protocolObservedAt !== undefined && state.protocolObservedAt >= startedAt) {
          if (!state.readyReleased) {
            state.readyReleased = true
            state.callbacks.onReady()
          }
          return
        }
        // Recovery is intentionally two-factor: a positive structured result
        // invalidates every old terminal marker and requires a new conjunction.
        state.protocolObservedAt = undefined
        state.callbacks.onAwaitingFreshProtocol()
        return
      }
      state.status = outcome.status
      state.protocolObservedAt = undefined
      state.callbacks.onBlocked(outcome)
    }).catch(() => {
      const current = this.states.get(state.binding.agentId)
      if (current !== state || current.checkSerial !== serial) return
      state.inFlight = false
      state.status = 'unknown'
      state.protocolObservedAt = undefined
      state.callbacks.onBlocked({ status: 'unknown', reason: 'nonzero_exit' })
    })
  }
}
