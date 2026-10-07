import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import WebSocket from 'ws'

const realClaudeUsage = { ...require('../pty/claude-usage.js') }
const realClaudeQuota = { ...require('../pty/claude-quota.js') }
const realQwenQuota = { ...require('../pty/qwen-quota.js') }
const realOpenCodeUsage = { ...require('../pty/opencode-usage.js') }
const realKimiUsage = { ...require('../pty/kimi-usage.js') }
const realMetrics = { ...require('../metrics.js') }
const realLifecycleLog = { ...require('../lifecycle-log.js') }
const realSpawnHelperHealth = { ...require('../pty/spawn-helper-health.js') }

mock.module('../pty/claude-usage.js', () => ({ ...realClaudeUsage, startClaudeUsageWatcher: mock(() => () => {}) }))
mock.module('../pty/claude-quota.js', () => ({
  ...realClaudeQuota,
  startClaudeQuotaWatcher: mock(() => {}),
  readTier: mock(() => 'pro'),
  triggerTick: mock(() => {}),
  __internalSetTickRef: mock(() => {}),
}))
mock.module('../pty/qwen-quota.js', () => ({ ...realQwenQuota, startQwenQuotaWatcher: mock(() => {}) }))
mock.module('../pty/opencode-usage.js', () => ({ ...realOpenCodeUsage, startOpenCodeUsageWatcher: mock(() => {}) }))
mock.module('../pty/kimi-usage.js', () => ({ ...realKimiUsage, startKimiUsageWatcher: mock(() => {}) }))
mock.module('../metrics.js', () => ({ ...realMetrics, startMetricsRelay: mock(() => {}) }))
mock.module('../lifecycle-log.js', () => ({ ...realLifecycleLog, logLifecycle: mock(() => {}) }))
mock.module('../pty/spawn-helper-health.js', () => ({ ...realSpawnHelperHealth, isSpawnHelperHealthy: mock(() => true) }))

afterAll(() => {
  mock.module('../pty/claude-usage.js', () => ({ ...realClaudeUsage }))
  mock.module('../pty/claude-quota.js', () => ({ ...realClaudeQuota }))
  mock.module('../pty/qwen-quota.js', () => ({ ...realQwenQuota }))
  mock.module('../pty/opencode-usage.js', () => ({ ...realOpenCodeUsage }))
  mock.module('../pty/kimi-usage.js', () => ({ ...realKimiUsage }))
  mock.module('../metrics.js', () => ({ ...realMetrics }))
  mock.module('../lifecycle-log.js', () => ({ ...realLifecycleLog }))
  mock.module('../pty/spawn-helper-health.js', () => ({ ...realSpawnHelperHealth }))
})

import type { StartupGateReason } from '@jerico/shared'
import { AGENT_SPECS } from '../pty/agents.js'
import {
  QWEN_V0244_INITIALIZING_TRANSCRIPT,
  QWEN_V0244_INTERACTIVE_TRANSCRIPT,
} from '../__fixtures__/qwen-v0.24.4-ready-transcript.js'
import {
  checkSubmitFailedOnExit,
  __test_deliverOrchestratorCommand,
  __test_getReplayEpochRaw,
  __test_getTuiPendingInputCount,
  __test_getAgyCaptureState,
  __test_handleMessage,
  __test_hasReplayEpoch,
  __test_hasTuiObservation,
  __test_initAgyCaptureState,
  __test_observeTuiReadinessOutput,
  __test_observeSubmittedAgyUserInput,
  __test_recordOutput,
  __test_resetAgyCaptureState,
  __test_resetTuiStartupState,
  __test_retryReadyTuiPendingInput,
  __test_scheduleTuiReadyTimeout,
  __test_stripAnsi,
  resetOrchTestState,
} from '../ws/client.js'
import {
  checkCompletionEvidence,
  prepareCompletionEvidence,
  releaseCompletionEvidence,
} from '../ws/completion-evidence.js'

interface Harness {
  agentId: string
  agentKey: string
  instanceId: number
  states: Array<Record<string, unknown>>
  writes: string[]
  sent: string[]
  manager: any
  ws: WebSocket
  observation: { startupGateDetected: boolean; seedReason?: StartupGateReason }
}

const activeAgents = new Set<string>()

function harness(agentKey: string, suffix = '', seedReason?: StartupGateReason): Harness {
  const agentId = `r32-${agentKey}${suffix}`
  const states: Array<Record<string, unknown>> = []
  const writes: string[] = []
  const sent: string[] = []
  const ws = { readyState: WebSocket.OPEN, send: mock((data: string) => sent.push(data)) } as unknown as WebSocket
  const value: Harness = {
    agentId,
    agentKey,
    instanceId: 1,
    states,
    writes,
    sent,
    ws,
    observation: { startupGateDetected: false, ...(seedReason ? { seedReason } : {}) },
    manager: undefined,
  }
  value.manager = {
    getAgentKey: () => value.agentKey,
    getPanelInstanceId: () => value.instanceId,
    getCurrentWs: () => ws,
    setPanelStartupGateState: (_agentId: string, state: Record<string, unknown>) => states.push(state),
    write: (_agentId: string, data: string) => {
      writes.push(Buffer.from(data, 'base64').toString('utf8'))
      return true
    },
    resize: (_agentId: string, cols: number, rows: number) => ({ cols, rows }),
    getLivePanels: () => [],
    unregisterSessionId: () => {},
    kill: () => {},
  }
  activeAgents.add(agentId)
  return value
}

function output(h: Harness, raw: string | Buffer): void {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  __test_observeTuiReadinessOutput(
    h.agentId, h.agentKey, bytes.toString('base64'), h.manager, h.observation,
  )
}

function queue(h: Harness, text = 'queued turn'): void {
  __test_deliverOrchestratorCommand(h.agentId, h.agentKey, text, h.manager, h.ws)
}

const protocolReadyBytes: Record<string, string> = {
  claude: '\x1b[?2004h❯',
  codex: '\x1b[?2004h›',
  opencode: '\x1b[?2004h\x1b[?25h',
  qwen: '\x1b[?2004hType your message or @path/to/file',
}

function settleReady(agentKey: string): void {
  jest.advanceTimersByTime(agentKey === 'codex' ? 2_000 : 500)
}

function commandWrites(h: Harness): string[] {
  return h.writes.filter(write => write !== '\r')
}

function advanceCrTurn(h: Harness, response: string): void {
  jest.advanceTimersByTime(1_000)
  output(h, response)
  __test_recordOutput(h.agentId, () => h.ws, h.manager)
  jest.advanceTimersByTime(3_000)
}

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  for (const agentId of activeAgents) resetOrchTestState(agentId)
  activeAgents.clear()
  jest.useRealTimers()
})

describe('raw provider readiness integration', () => {
  test('split raw marker reaches READY and releases only after ordered provider conjunction', () => {
    const h = harness('opencode', '-split')
    queue(h)
    output(h, '\x1b[?2')
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    output(h, '004h\x1b[?25h')
    __test_recordOutput(h.agentId, () => h.ws, h.manager)

    jest.advanceTimersByTime(499)
    expect(h.states).toEqual([])
    expect(h.writes).toEqual([])
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready', gate: 'unknown_startup' })
    expect(h.writes).toEqual([])

    jest.advanceTimersByTime(2_500)
    expect(h.writes).toEqual(['queued turn'])
  })

  test.each([
    ['2004 alone', '\x1b[?2004h'],
    ['bare provider marker', '\x1b[?25h'],
  ])('%s never readies or flushes', (_label, raw) => {
    const h = harness('opencode', `-${_label}`)
    queue(h)
    output(h, raw)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(60_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
  })

  test('same-chunk blocker dominates positive readiness bytes with zero writes', () => {
    const h = harness('claude', '-same-chunk')
    queue(h)
    output(h, '\x1b[?2004h❯\nChoose the text style that looks best with your terminal')
    jest.advanceTimersByTime(1_000)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'unknown_startup', reason: 'prompt_observed' })
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
  })

  test('blocker during the 500 ms settle cancels readiness and retains input', () => {
    const h = harness('claude', '-settle-blocker')
    queue(h)
    output(h, '\x1b[?2004h❯')
    jest.advanceTimersByTime(200)
    output(h, 'WARNING: Claude Code running in Bypass Permissions mode')
    jest.advanceTimersByTime(1_000)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked' })
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
  })

  test('the workspace trust menu blocks instead of readying on its own cursor', () => {
    // Verbatim from Claude Code 2.1.250 in an untrusted folder, ANSI-stripped.
    // Claude draws the menu with cursor motion, not spaces, so the words run
    // together in the tail the matcher sees. Its selection cursor is the same
    // U+276F the composer uses: without a blocker signature the panel readies
    // on the dialog and the queued greeting is typed into it, where Enter
    // lands on the default "No, exit" and the session dies with code 1.
    const h = harness('claude', '-workspace-trust')
    queue(h)
    output(h, '\x1b[?2004hAccessingworkspace:/tmp/untrusted'
      + "Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?(Likeyourowncode,awell-knownopensourceproject,orworkfromyourteam).If"
      + " not,takeamomenttoreviewwhat'sinthisfolderfirst. ClaudeCode'llbeabletoread,edit,andexecutefileshere."
      + ' ❯No,exit Yes,Itrustthisfolder Entertoconfirm·Esctocancel')
    jest.advanceTimersByTime(1_000)

    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust' })
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    // Nothing may reach the PTY — a keystroke here answers the menu.
    expect(h.writes).toEqual([])
  })

  test('manual recovery requires marker after a fresh DECSET 2004', () => {
    const h = harness('claude', '-recovery')
    queue(h)
    output(h, '\x1b[?2004h❯\nNew MCP server found in this project')
    output(h, '❯')
    jest.advanceTimersByTime(500)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)

    output(h, '\x1b[?2004h')
    output(h, '❯')
    jest.advanceTimersByTime(500)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
  })

  test('unique Codex heading immediately dominates its real 2004 and selection-glyph false positive', () => {
    const h = harness('codex', '-auth-menu')
    queue(h)
    output(h, [
      '\x1b[?2004h›\n',
      '\x1b[>4;2mWelcome to ',
      '\x1b[<0;10;20MCodex, OpenAI\'s ',
      '\x1b[=1hcommand-line coding agent\x1b[?25h',
    ].join(''))

    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
    jest.advanceTimersByTime(1_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
  })

  test('cursor-position CSI between every Codex auth word still blocks compacted raw capture', () => {
    const h = harness('codex', '-cursor-compacted-auth')
    queue(h)
    const raw = [
      '\x1b[?2004h›',
      'Welcome\x1b[2;2Hto',
      '\x1b[2;4HCodex-',
      '\x1b[2;6HOpenAI-',
      '\x1b[2;8Hcommand-line-',
      '\x1b[2;10Hcoding-',
      '\x1b[2;12Hagent',
    ].join('')
    expect(__test_stripAnsi(raw)).toBe('›WelcometoCodex-OpenAI-command-line-coding-agent')

    output(h, raw)

    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
    jest.advanceTimersByTime(2_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
  })

  test('Codex auth heading arriving at 750 ms cancels its extended readiness settle', () => {
    const h = harness('codex', '-late-auth-heading')
    queue(h)
    output(h, '\x1b[?2004h›')

    jest.advanceTimersByTime(750)
    expect(h.states).toEqual([])
    output(h, "Welcome to Codex, OpenAI's command-line coding agent")

    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    jest.advanceTimersByTime(2_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('Codex valid composer waits exactly 2,000 ms before READY and queued-input release', () => {
    const h = harness('codex', '-extended-settle')
    queue(h)
    // Establish an idle panel before the handshake so READY can write the held
    // CR turn immediately, making release timing directly observable.
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, '\x1b[?2004h›')

    jest.advanceTimersByTime(500)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    jest.advanceTimersByTime(1_499)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    jest.advanceTimersByTime(1)

    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(h.writes).toEqual(['queued turn'])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)
  })

  test('Provide your own API key alone blocks during Codex settle', () => {
    const h = harness('codex', '-late-api-key')
    queue(h)
    output(h, '\x1b[?2004h›')
    jest.advanceTimersByTime(750)
    output(h, 'Provide your own API key')
    jest.advanceTimersByTime(2_000)

    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('stripAnsi removes private CSI parameter forms with no raw residue', () => {
    const stripped = __test_stripAnsi([
      'a\x1b[<0;10;20Mb',
      'c\x1b[=1hd',
      'e\x1b[>4;2mf',
      'g\x1b[?25hh',
      'i\x1b[1 qj',
    ].join(''))

    expect(stripped).toBe('abcdefghij')
    expect(stripped).not.toContain('\x1b')
    expect(stripped).not.toMatch(/\[(?:<|=|>|\?)/)
  })

  test('stripAnsi still removes ordinary SGR and cursor CSI sequences', () => {
    expect(__test_stripAnsi('\x1b[31mred\x1b[0m\x1b[2Aup\x1b[10;20Hhome'))
      .toBe('reduphome')
  })

  test('unique Codex heading split across decoded PTY chunks still blocks', () => {
    const h = harness('codex', '-split-auth-heading')
    queue(h)
    output(h, "\x1b[?2004h›\nWelcome to Codex, OpenAI's command-")
    expect(h.states).toEqual([])

    output(h, 'line coding agent')
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
    jest.advanceTimersByTime(1_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
  })

  test('generic lone Codex continue copy remains READY and never blocked', () => {
    const h = harness('codex', '-partial-auth-copy')
    output(h, '\x1b[?2004h›\nPress enter to continue')
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    jest.advanceTimersByTime(1)

    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(h.states.some(state => state.phase === 'blocked')).toBe(false)
  })

  test('agy unsigned-in login-method menu blocks immediately and retains input', () => {
    const h = harness('agy', '-auth-menu')
    queue(h)
    __test_scheduleTuiReadyTimeout(h.agentId, h.agentKey, h.manager, h.observation)
    output(h, [
      'Welcome to the Antigravity CLI. You are currently not signed in.',
      'Select login method:',
      'Login with Google',
      'Use API key',
    ].join('\n'))

    expect(h.states).toHaveLength(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
    jest.advanceTimersByTime(30_000)
    expect(h.states).toHaveLength(1)
  })

  test('agy OAuth authentication flow is a blocker', () => {
    const h = harness('agy', '-oauth-flow')
    queue(h)
    output(h, 'Starting OAuth authentication flow')

    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('agy reviewed unsigned conjunction survives chunk splits without broad menu matching', () => {
    const h = harness('agy', '-split-auth')
    queue(h)
    output(h, 'Welcome to the Antigravity CLI. You are currently not ')
    output(h, 'signed in.\nSelect login ')
    expect(h.states).toEqual([])
    output(h, 'method:')
    expect(h.states.at(-1)).toMatchObject({
      phase: 'blocked', gate: 'authentication', reason: 'authentication_required',
    })

    const generic = harness('agy', '-generic-menu')
    output(generic, 'Select login method:')
    expect(generic.states).toEqual([])
  })

  test.each([
    ['claude', '\x1b[?2004h❯'],
    ['agy', '\x1b[?2004h? for shortcuts'],
    ['opencode', '\x1b[?2004h\x1b[?25h'],
  ])('%s successful protocol readiness retains the 500 ms default', (agentKey, raw) => {
    const h = harness(agentKey, '-default-settle')
    output(h, raw)
    jest.advanceTimersByTime(499)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    jest.advanceTimersByTime(1)

    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(h.states.some(state => state.phase === 'blocked')).toBe(false)
  })
})

describe('panel generation and timeout ownership', () => {
  test('respawn during settle makes the old timer a no-op', () => {
    const h = harness('opencode', '-stale-settle')
    queue(h)
    output(h, '\x1b[?2004h\x1b[?25h')
    h.instanceId = 2
    jest.advanceTimersByTime(500)
    expect(h.states).toEqual([])
    expect(h.writes).toEqual([])
  })

  test('raw output callback from an old panel generation is a complete no-op', () => {
    const h = harness('claude', '-stale-output')
    h.instanceId = 2
    __test_observeTuiReadinessOutput(
      h.agentId,
      h.agentKey,
      Buffer.from('\x1b[?2004h❯\ntrust this folder\nno, exit').toString('base64'),
      h.manager,
      h.observation,
      1,
    )
    jest.advanceTimersByTime(500)
    expect(h.states).toEqual([])
    expect(h.observation.startupGateDetected).toBe(false)
  })

  test('stale hard timeout cannot mark a replacement instance', () => {
    const h = harness('codex', '-stale-timeout')
    __test_scheduleTuiReadyTimeout(h.agentId, h.agentKey, h.manager, h.observation)
    h.instanceId = 2
    jest.advanceTimersByTime(30_000)
    expect(h.states).toEqual([])
  })

  test('current unknown protocol instance becomes attention and retains its queue', () => {
    const h = harness('agy', '-attention')
    queue(h)
    __test_scheduleTuiReadyTimeout(h.agentId, h.agentKey, h.manager, h.observation)
    jest.advanceTimersByTime(30_000)
    expect(h.states.at(-1)).toMatchObject({ phase: 'attention', reason: 'ready_timeout' })
    expect(h.writes).toEqual([])
  })

  test('reset across respawn clears scanner tails and startup timers', () => {
    const h = harness('opencode', '-reset')
    output(h, '\x1b[?2004h')
    resetOrchTestState(h.agentId)
    h.instanceId = 2
    output(h, '\x1b[?25h')
    jest.advanceTimersByTime(500)
    expect(h.states).toEqual([])

    output(h, '\x1b[?2004h\x1b[?25h')
    resetOrchTestState(h.agentId)
    jest.advanceTimersByTime(500)
    expect(h.states).toEqual([])
  })

  test('spawn attempt, exit, and failed spawn all invoke startup reset', () => {
    const source = readFileSync(path.join(import.meta.dir, '..', 'ws', 'client.ts'), 'utf8')
    const spawnCall = source.indexOf('const ok = manager.spawn(')
    expect(source.slice(spawnCall - 400, spawnCall)).toContain('resetTuiStartupState(msg.agentId, true)')
    const exitReset = source.indexOf('resetTuiStartupState(msg.agentId, true)', spawnCall)
    expect(exitReset).toBeGreaterThan(spawnCall)
    const failedSpawn = source.indexOf('if (!ok) {', exitReset)
    expect(source.slice(failedSpawn, failedSpawn + 200)).toContain('resetTuiStartupState(msg.agentId, true)')
  })
})

describe('Agy capture scheduling', () => {
  test('pre-READY controls and empty submits never arm; a post-READY non-empty submit does', async () => {
    const h = harness('agy', '-capture-submit')
    __test_initAgyCaptureState(h.agentId, h.instanceId)

    __test_observeSubmittedAgyUserInput(h.agentId, '1\r\x1b[A\r', h.manager)
    expect(__test_getAgyCaptureState(h.agentId)).toMatchObject({ captured: false, draft: '' })

    output(h, '\x1b[?2004h? for shortcuts')
    jest.advanceTimersByTime(500)
    __test_observeSubmittedAgyUserInput(h.agentId, '\x1b[A\r', h.manager)
    expect(__test_getAgyCaptureState(h.agentId)).toMatchObject({ captured: false, draft: '' })

    __test_observeSubmittedAgyUserInput(h.agentId, 'real turn', h.manager)
    expect(__test_getAgyCaptureState(h.agentId)).toMatchObject({ captured: false, draft: 'real turn' })
    __test_observeSubmittedAgyUserInput(h.agentId, '\r', h.manager)
    await Promise.resolve()
    await Promise.resolve()
    expect(__test_getAgyCaptureState(h.agentId)).toMatchObject({ captured: true, leaseHeld: true, draft: '' })

    __test_resetAgyCaptureState(h.agentId)
    jest.advanceTimersByTime(3_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(__test_getAgyCaptureState(h.agentId)).toBeUndefined()
  })
})

describe('startup release authorization and profiles', () => {
  test.each(['claude', 'codex', 'opencode'])(
    '%s readiness without a current websocket retains the full queue and performs zero writes',
    (agentKey) => {
      const h = harness(agentKey, '-no-ws-lossless')
      h.manager.getCurrentWs = () => null
      queue(h, 'turn 1')
      queue(h, 'turn 2')

      output(h, protocolReadyBytes[agentKey]!)
      settleReady(agentKey)

      expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
      expect(__test_getTuiPendingInputCount(h.agentId)).toBe(2)
      expect(h.writes).toEqual([])
    },
  )

  test.each(['claude', 'codex', 'opencode'])(
    '%s websocket recovery releases retained turns FIFO exactly once',
    (agentKey) => {
      const h = harness(agentKey, '-ws-recovery-fifo')
      const recoveredWs = h.ws
      h.manager.getCurrentWs = () => null
      queue(h, 'turn 1')
      queue(h, 'turn 2')
      queue(h, 'turn 3')
      __test_recordOutput(h.agentId, () => recoveredWs, h.manager)
      jest.advanceTimersByTime(3_000)
      output(h, protocolReadyBytes[agentKey]!)
      settleReady(agentKey)

      expect(h.writes).toEqual([])
      expect(__test_getTuiPendingInputCount(h.agentId)).toBe(3)

      h.manager.getCurrentWs = () => recoveredWs
      __test_retryReadyTuiPendingInput(h.manager)
      expect(commandWrites(h)).toEqual(['turn 1'])
      advanceCrTurn(h, 'turn one response')
      expect(commandWrites(h)).toEqual(['turn 1', 'turn 2'])
      advanceCrTurn(h, 'turn two response')
      expect(commandWrites(h)).toEqual(['turn 1', 'turn 2', 'turn 3'])
      expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)
    },
  )

  test.each(['claude', 'codex', 'opencode'])(
    '%s mid-release write failure retains failed and later turns for FIFO recovery',
    (agentKey) => {
      const h = harness(agentKey, '-mid-release-failure')
      const successfulWrite = h.manager.write
      h.manager.write = mock((_agentId: string, data: string) => {
        const decoded = Buffer.from(data, 'base64').toString('utf8')
        if (decoded === 'turn 2') return false
        return successfulWrite(_agentId, data)
      })
      queue(h, 'turn 1')
      queue(h, 'turn 2')
      queue(h, 'turn 3')
      __test_recordOutput(h.agentId, () => h.ws, h.manager)
      jest.advanceTimersByTime(3_000)
      output(h, protocolReadyBytes[agentKey]!)
      settleReady(agentKey)

      expect(commandWrites(h)).toEqual(['turn 1'])
      advanceCrTurn(h, 'turn one response')
      expect(commandWrites(h)).toEqual(['turn 1'])
      expect(__test_getTuiPendingInputCount(h.agentId)).toBe(2)
      expect(h.sent.map(raw => JSON.parse(raw))).toContainEqual({ type: 'pty_dead', agentId: h.agentId })

      h.manager.getCurrentWs = () => null
      h.manager.write = successfulWrite
      h.manager.getCurrentWs = () => h.ws
      __test_retryReadyTuiPendingInput(h.manager)
      expect(commandWrites(h)).toEqual(['turn 1', 'turn 2'])
      advanceCrTurn(h, 'turn two response')
      expect(commandWrites(h)).toEqual(['turn 1', 'turn 2', 'turn 3'])
      expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)
    },
  )

  test('Claude idle edge and 60 second safety horizon stay held while blocked', () => {
    const h = harness('claude', '-idle-blocked')
    queue(h)
    output(h, 'trust this folder\nno, exit')
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(60_000)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked' })
    expect(h.writes).toEqual([])
  })

  test('Ollama literal readiness remains operational', () => {
    const h = harness('ollama', '-literal')
    queue(h)
    output(h, 'model loaded\n>>> ')
    jest.advanceTimersByTime(500)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(h.writes).toEqual(['queued turn'])
  })

  test('agy startup turns are single-flight while unrelated Kimi paste behavior stays distinct', () => {
    const agy = harness('agy', '-fifo')
    queue(agy, 'agy turn 1')
    queue(agy, 'agy turn 2')
    output(agy, '\x1b[?2004h? for shortcuts')
    __test_recordOutput(agy.agentId, () => agy.ws, agy.manager)
    jest.advanceTimersByTime(500)
    expect(agy.writes).toEqual(['\x1b[200~agy turn 1\x1b[201~\r'])

    // Silence and the idle timer armed by startup output cannot release turn 2.
    jest.advanceTimersByTime(2_500)
    expect(agy.writes).toEqual(['\x1b[200~agy turn 1\x1b[201~\r'])

    // Only output after turn 1 was dispatched, followed by its own idle edge,
    // authorizes the next queued turn.
    output(agy, 'turn one response')
    __test_recordOutput(agy.agentId, () => agy.ws, agy.manager)
    jest.advanceTimersByTime(3_000)
    expect(agy.writes).toEqual([
      '\x1b[200~agy turn 1\x1b[201~\r',
      '\x1b[200~agy turn 2\x1b[201~\r',
    ])

    const kimi = harness('kimi', '-fifo')
    queue(kimi, 'kimi turn 1')
    queue(kimi, 'kimi turn 2')
    output(kimi, 'context: 0% (0/256k)')
    jest.advanceTimersByTime(3_000)
    expect(kimi.writes).toEqual([
      '\x1b[200~kimi turn 1\x1b[201~\r',
      '\x1b[200~kimi turn 2\x1b[201~\r',
    ])
  })

  test('agy READY with an empty queue still single-flights later ordinary turns', () => {
    const agy = harness('agy', '-post-ready-fifo')
    output(agy, '\x1b[?2004h? for shortcuts')
    __test_recordOutput(agy.agentId, () => agy.ws, agy.manager)
    jest.advanceTimersByTime(500)
    expect(agy.states.at(-1)).toMatchObject({ phase: 'ready' })

    queue(agy, 'turn 1')
    queue(agy, 'turn 2')
    expect(agy.writes).toEqual(['\x1b[200~turn 1\x1b[201~\r'])

    jest.advanceTimersByTime(2_500)
    expect(agy.writes).toEqual(['\x1b[200~turn 1\x1b[201~\r'])

    output(agy, 'turn one response')
    __test_recordOutput(agy.agentId, () => agy.ws, agy.manager)
    jest.advanceTimersByTime(3_000)
    expect(agy.writes).toEqual([
      '\x1b[200~turn 1\x1b[201~\r',
      '\x1b[200~turn 2\x1b[201~\r',
    ])
  })

  test('failed readiness-queue write retains every turn and emits pty_dead', () => {
    const agy = harness('agy', '-release-failure')
    agy.manager.write = mock(() => false)
    queue(agy, 'turn 1')
    queue(agy, 'turn 2')
    output(agy, '\x1b[?2004h? for shortcuts')
    jest.advanceTimersByTime(500)

    expect(__test_getTuiPendingInputCount(agy.agentId)).toBe(2)
    expect(agy.sent.map(raw => JSON.parse(raw))).toContainEqual({ type: 'pty_dead', agentId: agy.agentId })

    queue(agy, 'turn 3')
    expect(__test_getTuiPendingInputCount(agy.agentId)).toBe(3)
    expect(agy.manager.write).toHaveBeenCalledTimes(1)
  })

  test('readiness release with no current websocket retains the full queue', () => {
    const agy = harness('agy', '-release-no-ws')
    agy.manager.getCurrentWs = () => null
    queue(agy, 'turn 1')
    queue(agy, 'turn 2')
    output(agy, '\x1b[?2004h? for shortcuts')
    jest.advanceTimersByTime(500)

    expect(__test_getTuiPendingInputCount(agy.agentId)).toBe(2)
    expect(agy.writes).toEqual([])

    queue(agy, 'turn 3')
    expect(__test_getTuiPendingInputCount(agy.agentId)).toBe(3)
    expect(agy.writes).toEqual([])
  })

  test('Qwen buffers a scheduled-duty dispatch through the captured rotating Initializing transcript, then submits exactly once', () => {
    const h = harness('qwen', '-scheduled-duty')
    const dispatchId = 'duty-qwen-readiness'
    __test_deliverOrchestratorCommand(h.agentId, h.agentKey, 'scheduled duty', h.manager, h.ws, dispatchId)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)

    // v0.24.4 enables bracketed paste before its rotating startup UI has
    // finished. The captured raw transcript must not release the duty.
    output(h, QWEN_V0244_INITIALIZING_TRANSCRIPT)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(500)
    expect(h.writes).toEqual([])

    output(h, QWEN_V0244_INTERACTIVE_TRANSCRIPT)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(500)
    // The startup transcript itself has made the CR panel working. The first
    // post-startup idle edge authorizes its queued turn.
    jest.advanceTimersByTime(3_000)
    expect(commandWrites(h)).toEqual(['scheduled duty'])
    jest.advanceTimersByTime(1_000)
    expect(h.writes.filter(write => write === '\r')).toHaveLength(1)
    expect(h.sent.map(raw => JSON.parse(raw))).toContainEqual({
      type: 'orch_submit_state', agentId: h.agentId, state: 'submitted', dispatchId,
    })
  })

  test('Qwen exit before readiness reports the queued duty dispatch and does not write it', () => {
    const h = harness('qwen', '-exit-before-ready')
    const dispatchId = 'duty-qwen-exit'
    __test_deliverOrchestratorCommand(h.agentId, h.agentKey, 'must not leak', h.manager, h.ws, dispatchId)
    const failed = checkSubmitFailedOnExit(h.agentId)
    expect(failed).toMatchObject({ agentId: h.agentId, dispatchIds: [dispatchId] })
    expect(h.writes).toEqual([])
    resetOrchTestState(h.agentId)
    h.instanceId = 2
    output(h, QWEN_V0244_INTERACTIVE_TRANSCRIPT)
    jest.advanceTimersByTime(500)
    expect(h.writes).toEqual([])
  })

  test('exactly Claude, Codex, Qwen, agy, and OpenCode use protocol scanners', () => {
    const mappings = AGENT_SPECS.flatMap(spec => spec.tui?.protocolReadyProvider
      ? [[spec.key, spec.tui.protocolReadyProvider] as const]
      : [])
    expect(mappings).toEqual([
      ['claude', 'claude'],
      ['codex', 'codex'],
      ['qwen', 'qwen'],
      ['agy', 'agy'],
      ['opencode', 'opencode'],
    ])
    for (const key of ['claude', 'codex', 'qwen', 'agy', 'opencode']) {
      expect(AGENT_SPECS.find(spec => spec.key === key)?.tui?.readySignals ?? []).toEqual([])
    }
    expect(JSON.stringify(AGENT_SPECS.find(spec => spec.key === 'opencode')?.tui)).not.toContain('ctrl+p commands')
  })

  test('ordinary Qwen launch contract remains --yolo with CR submission', () => {
    const qwen = AGENT_SPECS.find(spec => spec.key === 'qwen')
    expect(qwen?.spawnArgs).toEqual(['--yolo'])
    expect(qwen?.formatInput?.('ordinary turn')).toBe('ordinary turn\r')
  })

  test('Claude declares all reviewed blocker signatures as blockers only', () => {
    const claude = AGENT_SPECS.find(spec => spec.key === 'claude')?.tui
    const source = claude?.blockerSignatures?.flatMap(signature => signature.allOf).map(pattern => pattern.source).join('\n') ?? ''
    expect(source).toContain('Choose the text style')
    expect(source).toContain('Bypass Permissions mode')
    expect(source).toContain('New MCP server found')
    expect(claude?.readySignals ?? []).toEqual([])
  })

  test('Codex and agy declare reviewed auth blockers as blockers only', () => {
    const codex = AGENT_SPECS.find(spec => spec.key === 'codex')?.tui
    const agy = AGENT_SPECS.find(spec => spec.key === 'agy')?.tui
    const codexSource = codex?.blockerSignatures?.flatMap(signature => signature.allOf).map(pattern => pattern.source).join('\n') ?? ''
    const agySource = agy?.blockerSignatures?.flatMap(signature => signature.allOf).map(pattern => pattern.source).join('\n') ?? ''

    expect(codex?.readySettleMs).toBe(2_000)
    expect(codex?.blockerSignatures).toHaveLength(3)
    expect(codex?.blockerSignatures?.slice(0, 2).every(signature => signature.allOf.length === 1)).toBe(true)
    expect(codex?.blockerSignatures?.slice(0, 2).every(signature => signature.gate === 'authentication')).toBe(true)
    expect(codex?.blockerSignatures?.slice(0, 2).every(signature => signature.reason === 'authentication_required')).toBe(true)
    expect(codex?.blockerSignatures?.[2]).toMatchObject({ id: 'codex-workspace-trust-v150', gate: 'workspace_trust', reason: 'prompt_observed' })
    expect(codex?.blockerSignatures?.[2]?.allOf).toHaveLength(2)
    expect(codexSource).toContain('Welcome\\s*to\\s*Codex')
    expect(codexSource).toContain('Provide\\s*your\\s*own\\s*API\\s*key')
    expect(codexSource).toContain('Do\\s*you\\s*trust\\s*the\\s*contents\\s*of\\s*this\\s*directory\\?')
    expect(codexSource).toContain('Yes,?\\s*continue')
    expect(codexSource).not.toContain('Sign in with ChatGPT')
    expect(codexSource).not.toContain('Press enter to continue')
    expect(codexSource).not.toContain('No, quit')
    expect(codex?.blockerSignatures?.[0]?.allOf[0]?.test("Welcome to Codex, OpenAI's command-line coding agent")).toBe(true)
    expect(codex?.blockerSignatures?.[0]?.allOf[0]?.test('WelcometoCodex-OpenAI-command-line-coding-agent')).toBe(true)
    expect(codex?.blockerSignatures?.[1]?.allOf[0]?.test('Provide your own API key')).toBe(true)
    expect(codex?.blockerSignatures?.[1]?.allOf[0]?.test('ProvideyourownAPIkey')).toBe(true)
    expect(agySource).toContain('Welcome to the Antigravity CLI')
    expect(agySource).toContain('Select login method')
    expect(agySource).toContain('Starting OAuth authentication flow')
    expect(codex?.readySignals ?? []).toEqual([])
    expect(agy?.readySignals ?? []).toEqual([])
  })
})

describe('completion authority isolation', () => {
  test('readiness functions contain no completion authority references', () => {
    const clientPath = path.join(import.meta.dir, '..', 'ws', 'client.ts')
    const scannerPath = path.join(import.meta.dir, '..', 'pty', 'tui-ready-scanner.ts')
    const clientSource = readFileSync(clientPath, 'utf8')
    const scannerSource = readFileSync(scannerPath, 'utf8')
    const ast = ts.createSourceFile(clientPath, clientSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const readinessNames = new Set([
      'markTuiReadyAndFlush',
      'scheduleTuiReadyFlush',
      'scheduleTuiQuiescenceReady',
      'observeTuiReadinessOutput',
      'scheduleTuiReadyTimeout',
      'resetTuiStartupState',
      'armReadyTurnFlightAfterWrite',
      'releaseNextReadyTuiTurn',
      'releaseReadyTuiPendingInput',
      'retryReadyTuiPendingInput',
    ])
    const forbidden = /(?:prepare|seal|check|release)CompletionEvidence/
    const violations: string[] = []
    for (const statement of ast.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !readinessNames.has(statement.name.text)) continue
      const body = statement.getText(ast)
      if (forbidden.test(body)) violations.push(statement.name.text)
    }
    expect(violations).toEqual([])
    expect(scannerSource).not.toMatch(/completion-evidence|CompletionEvidence/)
  })

  test('both production CR entry paths refuse to bypass an existing queue', () => {
    const source = readFileSync(path.join(import.meta.dir, '..', 'ws', 'client.ts'), 'utf8')
    expect(source.match(/orchPendingInput\.get\((?:agentId|msg\.agentId)\)\?\.length \?\? 0/g)).toHaveLength(2)
  })

  test('both production cr-inline entry paths arm a successful readiness turn flight', () => {
    const source = readFileSync(path.join(import.meta.dir, '..', 'ws', 'client.ts'), 'utf8')
    expect(source.match(/armReadyTurnFlightAfterWrite\((?:agentId|msg\.agentId), (?:agentKey|inputAgentKey), manager\)/g)).toHaveLength(2)
  })

  test("phase 'ready' creates no completion evidence", async () => {
    const oldHome = process.env.HOME
    const oldProfile = process.env.BRIDGE_PROFILE
    const fakeHome = mkdtempSync(path.join(tmpdir(), 'jerico-r32-completion-'))
    process.env.HOME = fakeHome
    process.env.BRIDGE_PROFILE = 'r32-readiness'
    const completionId = randomUUID()
    const binding = {
      completionId,
      agentId: `evidence-${completionId.slice(0, 8)}`,
      panelInstanceId: 1,
      expectedMarker: `JERICO_${completionId.replaceAll('-', '').toUpperCase()}_DONE`,
      taskKind: 'ai' as const,
    }
    try {
      expect(prepareCompletionEvidence(binding).ok).toBe(true)
      const h = harness('agy', '-completion-isolation')
      output(h, '\x1b[?2004h? for shortcuts')
      jest.advanceTimersByTime(500)
      expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
      expect(await checkCompletionEvidence(binding, 0, async () => {})).toEqual({
        verified: false,
        error: 'not_found',
      })
      expect(releaseCompletionEvidence(binding)).toBe(true)
    } finally {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
      if (oldProfile === undefined) delete process.env.BRIDGE_PROFILE
      else process.env.BRIDGE_PROFILE = oldProfile
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})

// Codex trust_provenance_missing selective supersession (R2 judge decision).
const CODEX_TRUST_MENU_READY_BYTES = '\x1b[?2004h›\n'
// Exact live Codex 0.150.1 workspace trust menu (from DEV_DONE.md fresh-untrusted
// red trace). Cursor-motion (CSI) compaction can run the words together, so the
// matcher may see "Doyoutrustthecontentsofthisdirectory?...Yes,continue". The
// literals are the v0.150.1 pair "Do you trust the contents of this directory?"
// + "Yes, continue" — never the obsolete "Yes, proceed" / "Yes, and allow this".
const CODEX_TRUST_MENU_TEXT_V150 = [
  'Do you trust the contents of this directory?',
  'Working with untrusted contents comes with higher risk of prompt',
  'injection. Trusting the directory allows project-local config, hooks,',
  'and exec policies to load.',
  '› 1. Yes, continue',
  '2. No, quit',
  'Press enter to continue',
].join('\n')
// Legacy Codex menu matched only by the unchanged primary startupGate
// (/Yes, proceed/i AND /Yes, and allow this/i). It must NOT match the new
// v0.150.1 descriptor, which requires the "Do you trust…directory?" question
// plus "Yes, continue".
const CODEX_TRUST_MENU_TEXT_LEGACY = [
  '❯ Yes, proceed',
  '  Yes, and allow this in the future for all projects',
  '  No, exit',
].join('\n')
const CODEX_AUTH_MENU_TEXT = "Welcome to Codex, OpenAI's command-line coding agent\nSign in with ChatGPT\nProvide your own API key"

function publishInitialBlockedSeedState(h: Harness): void {
  h.manager.setPanelStartupGateState(h.agentId, {
    phase: 'blocked', gate: 'workspace_trust', reason: h.observation.seedReason, observedAt: Date.now(),
  })
}

describe('Codex trust_provenance_missing selective supersession', () => {
  test('green: provenance_missing yields only to current-instance ordered DECSET-then-marker at the 2 s settle, releasing the queue exactly once', () => {
    const h = harness('codex', '-supersede-green', 'trust_provenance_missing')
    queue(h)
    // Fully simulate the idle/turn-flight state: startup output arms the idle
    // edge and its 2 s turn timer before the handshake so release is directly
    // observable as a PTY write, not just a gate state.
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    publishInitialBlockedSeedState(h)

    // Split conjunction: DECSET 2004 first, then the provider marker.
    output(h, '\x1b[?2004h')
    output(h, '›')
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)

    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(h.writes).toEqual(['queued turn'])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)

    // Released exactly once: no replay after further timers or duplicate evidence.
    output(h, '\x1b[?2004h›')
    jest.advanceTimersByTime(30_000)
    expect(commandWrites(h)).toEqual(['queued turn'])
    expect(h.writes.filter(write => write === '\r')).toHaveLength(1)
  })

  test('live v0.150.1 same-chunk menu plus composer glyph stays prompt_observed with zero writes', () => {
    const h = harness('codex', '-supersede-menu-same-chunk', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)

    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('same-chunk Codex authentication blocker plus ready-looking bytes stays authentication_required with zero writes', () => {
    const h = harness('codex', '-supersede-auth-same-chunk', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_AUTH_MENU_TEXT)

    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('trust menu split across chunks with CSI boundaries before and during the settle cancels readiness with zero writes', () => {
    const h = harness('codex', '-supersede-split-menu', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, '\x1b[?2')
    output(h, '004h›\nDo you trust the contents of this ')
    output(h, 'directory?\n› 1. Yes, con')
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    expect(h.writes).toEqual([])

    // Blocker conjunction completes at 1,999 ms, one millisecond before settle.
    jest.advanceTimersByTime(1_999)
    output(h, 'tinue\n2. No, quit\nPress enter to continue')
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('auth blocker arriving mid-settle cancels the supersession settle', () => {
    const h = harness('codex', '-supersede-mid-settle-auth', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, '\x1b[?2004h›')
    jest.advanceTimersByTime(750)
    output(h, CODEX_AUTH_MENU_TEXT)
    jest.advanceTimersByTime(30_000)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('after a blocker, only a fresh ordered conjunction recovers; fragments never do', () => {
    const h = harness('codex', '-supersede-recovery', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    publishInitialBlockedSeedState(h)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    jest.advanceTimersByTime(5_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)

    // Bare marker cannot replay readiness.
    output(h, '›')
    jest.advanceTimersByTime(5_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    // DECSET alone leaves the conjunction incomplete.
    output(h, '\x1b[?2004h')
    jest.advanceTimersByTime(5_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])

    // R5 guard: fresh ordered conjunction alone no longer clears active Codex blocker — live Enter required.
    output(h, '›')
    jest.advanceTimersByTime(2_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    expect(h.writes).toEqual([])
  })

  // --- R3: exact Codex 0.150.1 live literals ---------------------------------

  test('legacy Codex menu (Yes, proceed + Yes, and allow this) still blocks via the unchanged primary startupGate, not the v0.150.1 descriptor', () => {
    const codex = AGENT_SPECS.find(spec => spec.key === 'codex')?.tui
    const v150 = codex?.blockerSignatures?.find(sig => sig.id === 'codex-workspace-trust-v150')
    expect(v150?.allOf[0]?.test(CODEX_TRUST_MENU_TEXT_LEGACY)).toBe(false)
    expect(v150?.allOf[1]?.test(CODEX_TRUST_MENU_TEXT_LEGACY)).toBe(false)

    const h = harness('codex', '-legacy-menu', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_LEGACY)

    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('live v0.150.1 menu paints in measured order and blocks before the 2 s settle (DECSET 26ms, composer 132ms, question 141ms, Yes 164ms)', () => {
    const h = harness('codex', '-v150-timing', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    // publishInitialBlockedSeedState already pushed a blocked trust_provenance_missing
    // state, so pre-menu checks only forbid a fresh ready or prompt_observed.
    // DECSET 2004 at 26 ms.
    jest.advanceTimersByTime(26)
    output(h, '\x1b[?2004h')
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    // Composer chrome at 132 ms (26 + 106).
    jest.advanceTimersByTime(106)
    output(h, '›')
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    // Question at 141 ms (132 + 9).
    jest.advanceTimersByTime(9)
    output(h, 'Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection. Trusting the directory allows project-local config, hooks, and exec policies to load.')
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    // Yes anchor at 164 ms (141 + 23), far before the 2,000 ms settle.
    jest.advanceTimersByTime(23)
    output(h, '› 1. Yes, continue\n2. No, quit\nPress enter to continue')
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('live v0.150.1 menu split across question and Yes chunks still blocks', () => {
    const h = harness('codex', '-v150-split-q-yes', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, 'Do you trust the contents of this directory?')
    jest.advanceTimersByTime(500)
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    output(h, ' Yes, continue\n2. No, quit\nPress enter to continue')
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('live v0.150.1 cursor-compacted menu (words run together) still blocks', () => {
    const h = harness('codex', '-v150-compacted', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    const raw = [
      'Do you trust the contents of this directory?',
      '\x1b[2;2H Yes, continue',
      '\x1b[2;4H2. No, quit',
      '\x1b[2;6HPress enter to continue',
    ].join('')
    expect(__test_stripAnsi(raw)).toBe(
      'Do you trust the contents of this directory? Yes, continue2. No, quitPress enter to continue',
    )
    output(h, raw)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('live v0.150.1 blocker conjunction completing at 1,999 ms cancels the 2 s settle', () => {
    const h = harness('codex', '-v150-1999', 'trust_provenance_missing')
    queue(h)
    // Composer glyph primes an ordered-protocol settle at 2,000 ms; the seed
    // reason would otherwise be superseded into ready at the settle deadline.
    output(h, CODEX_TRUST_MENU_READY_BYTES)
    publishInitialBlockedSeedState(h)
    jest.advanceTimersByTime(1_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    output(h, 'Do you trust the contents of this directory?')
    jest.advanceTimersByTime(999)
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    // Yes anchor lands one millisecond before settle, cancelling it.
    output(h, ' Yes, continue\n2. No, quit\nPress enter to continue')
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('exhaustive byte-boundary replay with a CSI inside the menu text detects the blocker at every split (zero misses)', () => {
    // A cursor CSI sits inside the question anchor ("trust" · "the") so that,
    // split mid-CSI, the per-chunk stripAnsi leaves a stray incomplete sequence
    // in the accumulated tail. Only re-normalizing the whole tail (the R3 fix)
    // recovers the anchor; testing the raw tail would miss it.
    const menuText = [
      'Do you trust',
      '\x1b[2;2H',
      ' the contents of this directory?',
      ' Yes, continue',
      '2. No, quit',
      'Press enter to continue',
    ].join('')
    const full = Buffer.from(menuText, 'utf8')
    let detectedEverySplit = true
    let firstMiss: number | null = null
    for (let i = 1; i < full.length; i++) {
      const h = harness('codex', `-v150-bytesplit-${i}`, 'trust_provenance_missing')
      queue(h)
      publishInitialBlockedSeedState(h)
      output(h, full.subarray(0, i))
      output(h, full.subarray(i))
      if (!h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')) {
        detectedEverySplit = false
        firstMiss = i
        break
      }
    }
    expect(detectedEverySplit).toBe(true)
    expect(firstMiss).toBeNull()
  })

  test('composer chrome alone (no menu) is not a workspace-trust blocker and still readies under seed supersession', () => {
    const h = harness('codex', '-v150-composer', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    publishInitialBlockedSeedState(h)
    output(h, '\x1b[?2004h')
    output(h, '›')
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(commandWrites(h)).toEqual(['queued turn'])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)
  })

  test('question-only text does not become prompt_observed and stays held', () => {
    const h = harness('codex', '-v150-q-only', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, 'Do you trust the contents of this directory?')
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('Yes-only text does not become prompt_observed and stays held', () => {
    const h = harness('codex', '-v150-yes-only', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, 'Yes, continue')
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('generic "Press enter to continue" alone does not become a workspace-trust blocker', () => {
    const h = harness('codex', '-v150-press-enter', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, 'Press enter to continue')
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('auth menu stays authentication_required, never prompt_observed, under the v0.150.1 menu scope', () => {
    const h = harness('codex', '-v150-auth', 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_AUTH_MENU_TEXT)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('a model quote containing both v0.150.1 anchors after ready does not downgrade to blocked', () => {
    const h = harness('codex', '-v150-post-ready', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    publishInitialBlockedSeedState(h)
    jest.advanceTimersByTime(2_000)
    output(h, '\x1b[?2004h›')
    jest.advanceTimersByTime(2_000)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    // Model later quotes the entire menu — must not downgrade a ready panel.
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    jest.advanceTimersByTime(5_000)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(h.states.some(state => state.phase === 'blocked' && state.reason === 'prompt_observed')).toBe(false)
    // A delayed submit CR may flush, but no further command is typed.
    expect(commandWrites(h)).toEqual(['queued turn'])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)
  })

  test('stale-instance supersession evidence is a no-op: old callback, old settle, and old hard timeout', () => {
    const h = harness('codex', '-supersede-stale-callback', 'trust_provenance_missing')
    h.instanceId = 2
    __test_observeTuiReadinessOutput(
      h.agentId, h.agentKey, Buffer.from('\x1b[?2004h›').toString('base64'),
      h.manager, h.observation, 1,
    )
    jest.advanceTimersByTime(30_000)
    expect(h.states).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.observation.seedReason).toBe('trust_provenance_missing')
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)

    // Settle scheduled by the current instance goes stale across respawn.
    const settle = harness('codex', '-supersede-stale-settle', 'trust_provenance_missing')
    queue(settle)
    publishInitialBlockedSeedState(settle)
    output(settle, '\x1b[?2004h›')
    settle.instanceId = 2
    jest.advanceTimersByTime(30_000)
    expect(settle.states.filter(state => state.phase === 'ready')).toEqual([])
    expect(settle.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(settle.agentId)).toBe(1)

    // A stale hard timeout cannot flip a supersession-settling panel either.
    const timeout = harness('codex', '-supersede-stale-timeout', 'trust_provenance_missing')
    __test_scheduleTuiReadyTimeout(timeout.agentId, timeout.agentKey, timeout.manager, timeout.observation)
    timeout.instanceId = 2
    jest.advanceTimersByTime(60_000)
    expect(timeout.states).toEqual([])
    expect(timeout.writes).toEqual([])
  })

  test.each([
    'seed_refused_invalid_cwd',
    'seed_refused_unsafe_target',
    'seed_refused_conflict',
    'seed_failed',
  ] as const)('%s is never superseded by valid Codex composer evidence', (seedReason) => {
    const h = harness('codex', `-terminal-${seedReason}`, seedReason)
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, '\x1b[?2004h›')
    output(h, '\x1b[?2004h›')
    jest.advanceTimersByTime(60_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.states.filter(state => state.phase === 'ready')).toEqual([])
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test.each([
    ['DECSET only', ['\x1b[?2004h']],
    ['provider glyph only', ['›']],
    ['reverse order', ['›', '\x1b[?2004h']],
    ['malformed truncated CSI', ['\x1b[?200', 'x›', '\x1b[?2004']],
    ['silence', []],
  ] as const)('no-proof %s never supersedes trust_provenance_missing and writes nothing', (_label, chunks) => {
    const h = harness('codex', `-noproof-${_label.replace(/[^a-z]+/gi, '-')}`, 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    __test_scheduleTuiReadyTimeout(h.agentId, h.agentKey, h.manager, h.observation)
    for (const chunk of chunks) output(h, chunk)
    jest.advanceTimersByTime(60_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    // Rule 5: with the seed reason still held, the unchanged timeout keeps the
    // panel blocked rather than publishing attention.
    expect(h.states.some(state => state.phase === 'attention')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('provenance-approved Codex (no seed reason) behavior is unchanged', () => {
    const h = harness('codex', '-approved-unchanged')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, '\x1b[?2004h›')
    jest.advanceTimersByTime(1_999)
    expect(h.writes).toEqual([])
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(h.writes).toEqual(['queued turn'])
  })

  test.each([
    ['claude', '\x1b[?2004h❯'],
    ['agy', '\x1b[?2004h? for shortcuts'],
    ['opencode', '\x1b[?2004h\x1b[?25h'],
  ] as const)('%s protocol evidence never supersedes trust_provenance_missing', (agentKey, raw) => {
    const h = harness(agentKey, `-no-supersede-${agentKey}`, 'trust_provenance_missing')
    queue(h)
    publishInitialBlockedSeedState(h)
    output(h, raw)
    jest.advanceTimersByTime(60_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('Kimi quiescence behavior remains unchanged under trust_provenance_missing', () => {
    const h = harness('kimi', '-quiescence-unchanged', 'trust_provenance_missing')
    queue(h)
    output(h, 'context: 0% (0/256k)')
    jest.advanceTimersByTime(3_000)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(h.writes).toEqual(['\x1b[200~queued turn\x1b[201~\r'])
  })
})

const CODEX_NORMAL_COMPOSER = '› Ask Codex to do anything'
const CODEX_COMPOSER_ANSI = '\x1b[1m›\x1b[0mAsk Codex to do anything'

function b64(text: string): string {
  return Buffer.from(text).toString('base64')
}

async function userInput(
  h: Harness,
  text: string,
  opts?: {
    panelInstanceId?: number
    omitGeneration?: boolean
    source?: 'user' | 'orchestrator'
    writeOk?: boolean
    replay?: boolean
  },
): Promise<void> {
  const previousWrite = h.manager.write
  if (opts?.writeOk === false) {
    h.manager.write = () => false
  }
  const msg: Record<string, unknown> = {
    type: 'input',
    agentId: h.agentId,
    daemonId: 'd1',
    data: b64(text),
    source: opts?.source ?? 'user',
  }
  if (!opts?.omitGeneration) msg.panelInstanceId = opts?.panelInstanceId ?? h.instanceId
  if (opts?.replay) msg.replay = true
  await __test_handleMessage(msg as any, h.ws, h.manager, {} as any, {} as any)
  h.manager.write = previousWrite
}

describe('Codex EXPLICIT_HUMAN_ENTER trust recovery', () => {
  test('fragmented v0.150.1 menu blocks indefinitely with zero queued writes without Enter', () => {
    const h = harness('codex', '-recovery-no-enter', 'trust_provenance_missing')
    queue(h)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    output(h, '›')
    output(h, CODEX_TRUST_MENU_TEXT_V150)
    output(h, '› 1. Yes, continue')
    jest.advanceTimersByTime(60_000)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(h.writes).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('orchestrator Enter, send_keys Enter, arrows/text, failed write, untagged and stale Enter do not arm', async () => {
    const h = harness('codex', '-recovery-no-arm', 'trust_provenance_missing')
    queue(h)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)

    await userInput(h, '\r', { source: 'orchestrator' })
    await __test_handleMessage({
      type: 'send_keys', requestId: 'sk-enter', agentId: h.agentId, daemonId: 'd1', keys: ['enter'],
    } as any, h.ws, h.manager, {} as any, {} as any)
    await userInput(h, '\x1b[A')
    await userInput(h, '1')
    await userInput(h, '\r', { writeOk: false })
    await userInput(h, '\r', { omitGeneration: true })
    await userInput(h, '\r', { panelInstanceId: 99 })
    output(h, CODEX_NORMAL_COMPOSER)
    jest.advanceTimersByTime(60_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(commandWrites(h).filter(w => w === 'queued turn')).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('current-generation user Enter plus menu redraw, partial placeholder, or auth blocker does not ready', async () => {
    const redraw = harness('codex', '-recovery-menu-redraw', 'trust_provenance_missing')
    queue(redraw)
    output(redraw, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(redraw, '\r')
    output(redraw, '› 1. Yes, continue')
    jest.advanceTimersByTime(60_000)
    expect(redraw.states.some(state => state.phase === 'ready')).toBe(false)

    const partial = harness('codex', '-recovery-partial', 'trust_provenance_missing')
    queue(partial)
    output(partial, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(partial, '\r')
    output(partial, '› Ask Codex')
    jest.advanceTimersByTime(60_000)
    expect(partial.states.some(state => state.phase === 'ready')).toBe(false)

    const auth = harness('codex', '-recovery-auth', 'trust_provenance_missing')
    queue(auth)
    output(auth, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(auth, '\r')
    output(auth, CODEX_AUTH_MENU_TEXT)
    jest.advanceTimersByTime(60_000)
    expect(auth.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    expect(auth.states.some(state => state.phase === 'ready')).toBe(false)
  })

  test('current-generation user Enter plus split ANSI-compacted composer stays blocked at 1999 ms, readies at 2000 ms, flushes once', async () => {
    const h = harness('codex', '-recovery-enter-composer', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(h, '\r')
    output(h, '\x1b[1m›\x1b[0m')
    output(h, 'Ask Codex to do anything')
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(commandWrites(h)).toEqual(['queued turn'])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)
    output(h, CODEX_COMPOSER_ANSI)
    jest.advanceTimersByTime(30_000)
    expect(commandWrites(h)).toEqual(['queued turn'])
  })

  test('blocker at 1999 ms cancels recovery; stale timer after respawn is a no-op', async () => {
    const cancel = harness('codex', '-recovery-settle-cancel', 'trust_provenance_missing')
    queue(cancel)
    output(cancel, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(cancel, '\r')
    output(cancel, CODEX_NORMAL_COMPOSER)
    jest.advanceTimersByTime(1_999)
    output(cancel, CODEX_TRUST_MENU_TEXT_V150)
    jest.advanceTimersByTime(30_000)
    expect(cancel.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    expect(cancel.states.some(state => state.phase === 'ready')).toBe(false)
    expect(commandWrites(cancel)).toEqual([])

    const stale = harness('codex', '-recovery-stale-respawn', 'trust_provenance_missing')
    queue(stale)
    output(stale, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(stale, '\r')
    output(stale, CODEX_NORMAL_COMPOSER)
    stale.instanceId = 2
    jest.advanceTimersByTime(30_000)
    expect(stale.states.filter(state => state.phase === 'ready')).toEqual([])
    expect(commandWrites(stale)).toEqual([])
  })

  test('No, quit / exit after Enter produces no ready', async () => {
    const h = harness('codex', '-recovery-no-quit', 'trust_provenance_missing')
    queue(h)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(h, '\r')
    __test_resetTuiStartupState(h.agentId)
    output(h, CODEX_NORMAL_COMPOSER)
    jest.advanceTimersByTime(60_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
  })

  test('same-current-generation reconnect-replayed CR writes normally but cannot arm/recover', async () => {
    const h = harness('codex', '-recovery-replay-samegen', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    // Replay Enter with same current generation: PTY write succeeds but must not arm.
    await userInput(h, '\r', { replay: true })
    expect(h.writes).toContain('\r')
    output(h, CODEX_NORMAL_COMPOSER)
    jest.advanceTimersByTime(60_000)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    // Live Enter on same generation still arms and recovers.
    await userInput(h, '\r')
    output(h, CODEX_NORMAL_COMPOSER)
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(commandWrites(h)).toEqual(['queued turn'])
  })

  test('live current-generation CR/LF still arms and recovers while untagged/stale/failed/replay do not', async () => {
    for (const bad of [
      { omitGeneration: true },
      { panelInstanceId: 99 },
      { writeOk: false },
      { replay: true },
      { source: 'orchestrator' as const },
    ]) {
      const badH = harness('codex', `-recovery-bad-${JSON.stringify(bad)}`, 'trust_provenance_missing')
      queue(badH)
      output(badH, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
      await userInput(badH, '\r', bad as any)
      output(badH, CODEX_NORMAL_COMPOSER)
      jest.advanceTimersByTime(60_000)
      expect(badH.states.some(state => state.phase === 'ready')).toBe(false)
      expect(commandWrites(badH)).toEqual([])
    }
    const good = harness('codex', '-recovery-live-good', 'trust_provenance_missing')
    queue(good)
    __test_recordOutput(good.agentId, () => good.ws, good.manager)
    jest.advanceTimersByTime(2_000)
    output(good, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(good, '\r')
    output(good, CODEX_NORMAL_COMPOSER)
    jest.advanceTimersByTime(2_000)
    expect(good.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(commandWrites(good)).toEqual(['queued turn'])
  })

  test('exhaustive byte-boundary splits of ANSI-interleaved composer including CSI inside placeholder and split UTF-8 glyph all recover only after 2000 ms', async () => {
    const glyphBytes = Buffer.from('›', 'utf8') // e2 80 9b
    const composerAnsiSplit = Buffer.from('\x1b[1m›\x1b[0mAsk Codex \x1b[', 'utf8')
    const composerRest = Buffer.from('0mto do anything', 'utf8')
    const fullComposer = Buffer.concat([glyphBytes, Buffer.from(' Ask Codex to do anything', 'utf8')])
    // Case A: CSI split inside placeholder
    const fullWithCsi = Buffer.concat([composerAnsiSplit, composerRest])
    // Case B: UTF-8 glyph split
    const fullWithGlyph = fullComposer

    let iter = 0
    for (const full of [fullWithCsi, fullWithGlyph]) {
      for (let split = 1; split < full.length; split++) {
        iter++
        const left = full.subarray(0, split)
        const right = full.subarray(split)
        const suffix = `-recovery-split-${iter}`
        const h = harness('codex', suffix, 'trust_provenance_missing')
        queue(h)
        __test_recordOutput(h.agentId, () => h.ws, h.manager)
        jest.advanceTimersByTime(2_000)
        output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
        await userInput(h, '\r')
        output(h, left)
        output(h, right)
        jest.advanceTimersByTime(1_999)
        expect(h.states.some(state => state.phase === 'ready'), `split ${split} early ready iter ${iter}`).toBe(false)
        jest.advanceTimersByTime(1)
        expect(h.states.at(-1), `split ${split} should ready iter ${iter}`).toMatchObject({ phase: 'ready' })
        expect(commandWrites(h)).toEqual(['queued turn'])
      }
    }
    // Also verify single-chunk still requires settle
    const h = harness('codex', '-recovery-single-chunk-settle', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(h, '\r')
    output(h, '› Ask Codex to do anything')
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(state => state.phase === 'ready')).toBe(false)
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
  })
})

describe('R5 replay-scoped trust evidence epoch', () => {
  test('golden R5: blocker -> same-gen replay bare Enter -> split composer -> remains blocked beyond 2s -> silent live Enter recovers at exactly 2000ms, single flush, no duplicate', async () => {
    const h = harness('codex', '-r5-golden', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    await userInput(h, '\r', { replay: true })
    // Split composer across ANSI/UTF-8 boundaries via raw capture (never tuiOutputTail)
    output(h, Buffer.from('\x1b[1m›\x1b[0m', 'utf8'))
    output(h, Buffer.from('Ask Codex to do anything', 'utf8'))
    jest.advanceTimersByTime(5_000)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
    await userInput(h, '\r')
    // no output afterward
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(commandWrites(h)).toEqual(['queued turn'])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)
    // duplicate composer and 30s produce no second flush
    output(h, CODEX_NORMAL_COMPOSER)
    jest.advanceTimersByTime(30_000)
    expect(commandWrites(h)).toEqual(['queued turn'])
    expect(h.states.filter(s => s.phase === 'ready')).toHaveLength(1)
  })

  test('causal negative: composer after blocker without qualifying replay epoch + silent live Enter never recovers', async () => {
    const h = harness('codex', '-r5-causal-neg', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    output(h, CODEX_NORMAL_COMPOSER)
    jest.advanceTimersByTime(500)
    await userInput(h, '\r')
    // no composer after live
    jest.advanceTimersByTime(60_000)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('pre-blocker and blocker-same-chunk composer never seed evidence', async () => {
    // pre-blocker composer cleared on blocker
    const pre = harness('codex', '-r5-pre-blocker', 'trust_provenance_missing')
    queue(pre)
    __test_recordOutput(pre.agentId, () => pre.ws, pre.manager)
    jest.advanceTimersByTime(2_000)
    output(pre, CODEX_NORMAL_COMPOSER)
    output(pre, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(pre, '\r', { replay: true })
    // no composer after replay
    jest.advanceTimersByTime(500)
    await userInput(pre, '\r')
    jest.advanceTimersByTime(60_000)
    expect(pre.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(pre)).toEqual([])

    // same-chunk blocker+composer: recovery branch dominates, same chunk not captured
    const same = harness('codex', '-r5-same-chunk', 'trust_provenance_missing')
    queue(same)
    __test_recordOutput(same.agentId, () => same.ws, same.manager)
    jest.advanceTimersByTime(2_000)
    output(same, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150 + CODEX_NORMAL_COMPOSER)
    expect(same.states.at(-1)).toMatchObject({ phase: 'blocked' })
    await userInput(same, '\r', { replay: true })
    output(same, Buffer.from('noise', 'utf8'))
    await userInput(same, '\r')
    jest.advanceTimersByTime(60_000)
    expect(same.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(same)).toEqual([])
  })

  test('replay/live mixed text+Enter, repeated submits, arrows, orchestrator, send_keys, failed write, omitted/stale generation never authorize or use cached evidence', async () => {
    const badReplays: Array<{ label: string; input: string; opts?: any }> = [
      { label: 'text+Enter', input: 'hello\r', opts: { replay: true } },
      { label: 'repeated CR', input: '\r\r', opts: { replay: true } },
      { label: 'CRLF repeated', input: '\r\n\r\n', opts: { replay: true } },
      { label: 'arrow', input: '\x1b[A', opts: { replay: true } },
      { label: 'orchestrator', input: '\r', opts: { replay: true, source: 'orchestrator' as const } },
      { label: 'failed write', input: '\r', opts: { replay: true, writeOk: false } },
      { label: 'omitted gen', input: '\r', opts: { replay: true, omitGeneration: true } },
      { label: 'stale gen', input: '\r', opts: { replay: true, panelInstanceId: 99 } },
      { label: 'non-codex', input: '\r', opts: { replay: true } }, // will test with kimi harness separately
    ]
    for (const { label, input, opts } of badReplays) {
      const isNonCodex = label === 'non-codex'
      const h = harness(isNonCodex ? 'kimi' : 'codex', `-r5-bad-replay-${label.replace(/[^a-z0-9]/gi, '-')}`, 'trust_provenance_missing')
      queue(h)
      __test_recordOutput(h.agentId, () => h.ws, h.manager)
      jest.advanceTimersByTime(2_000)
      output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
      await userInput(h, input, opts as any)
      output(h, CODEX_NORMAL_COMPOSER)
      jest.advanceTimersByTime(500)
      await userInput(h, '\r')
      jest.advanceTimersByTime(60_000)
      expect(h.states.some(s => s.phase === 'ready'), `bad replay ${label} should not ready`).toBe(false)
      expect(commandWrites(h).filter(w => w === 'queued turn'), `bad replay ${label} no flush`).toEqual([])
    }

    // Bad live authorizers after valid replay epoch
    const badLives: Array<{ label: string; input: string; opts?: any }> = [
      { label: 'text+Enter', input: 'hello\r' },
      { label: 'repeated CR', input: '\r\r' },
      { label: 'arrow', input: '\x1b[A' },
      { label: 'orchestrator', input: '\r', opts: { source: 'orchestrator' as const } },
      { label: 'failed write', input: '\r', opts: { writeOk: false } },
      { label: 'omitted gen', input: '\r', opts: { omitGeneration: true } },
      { label: 'stale gen', input: '\r', opts: { panelInstanceId: 99 } },
      { label: 'non-pure LF+text', input: 'x\n' },
    ]
    for (const { label, input, opts } of badLives) {
      const h = harness('codex', `-r5-bad-live-${label.replace(/[^a-z0-9]/gi, '-')}`, 'trust_provenance_missing')
      queue(h)
      __test_recordOutput(h.agentId, () => h.ws, h.manager)
      jest.advanceTimersByTime(2_000)
      output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
      await userInput(h, '\r', { replay: true })
      output(h, CODEX_NORMAL_COMPOSER)
      jest.advanceTimersByTime(200)
      await userInput(h, input, opts as any)
      // No composer after bad live
      jest.advanceTimersByTime(60_000)
      expect(h.states.some(s => s.phase === 'ready'), `bad live ${label} should not ready`).toBe(false)
      expect(commandWrites(h).filter(w => w === 'queued turn'), `bad live ${label} no flush`).toEqual([])
    }

    // send_keys invalidator
    const sk = harness('codex', '-r5-bad-live-sendkeys', 'trust_provenance_missing')
    queue(sk)
    __test_recordOutput(sk.agentId, () => sk.ws, sk.manager)
    jest.advanceTimersByTime(2_000)
    output(sk, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(sk, '\r', { replay: true })
    output(sk, CODEX_NORMAL_COMPOSER)
    await __test_handleMessage({ type: 'send_keys', requestId: 'sk-r5', agentId: sk.agentId, daemonId: 'd1', keys: ['enter'] } as any, sk.ws, sk.manager, {} as any, { stop: () => {} } as any)
    await userInput(sk, '\r')
    jest.advanceTimersByTime(60_000)
    expect(sk.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(sk).filter(w => w === 'queued turn')).toEqual([])
  })

  test.each([
    'seed_refused_invalid_cwd',
    'seed_refused_unsafe_target',
    'seed_refused_conflict',
    'seed_failed',
  ] as const)('stronger seed %s blocks cached replay-composer recovery', async (seedReason) => {
    const h = harness('codex', `-r5-strong-${seedReason}`, seedReason)
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(h, '\r', { replay: true })
    output(h, CODEX_NORMAL_COMPOSER)
    jest.advanceTimersByTime(200)
    await userInput(h, '\r')
    jest.advanceTimersByTime(60_000)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('exhaustive pre-auth split UTF-8 glyph and split CSI across every byte boundary', async () => {
    const glyphBytes = Buffer.from('›', 'utf8')
    const composerAnsi = Buffer.from('\x1b[1m›\x1b[0mAsk Codex \x1b[', 'utf8')
    const composerRest = Buffer.from('0mto do anything', 'utf8')
    const fullCsi = Buffer.concat([composerAnsi, composerRest])
    const fullGlyph = Buffer.concat([glyphBytes, Buffer.from(' Ask Codex to do anything', 'utf8')])
    let iter = 0
    for (const full of [fullCsi, fullGlyph]) {
      for (let split = 1; split < full.length; split++) {
        iter++
        const left = full.subarray(0, split)
        const right = full.subarray(split)
        const h = harness('codex', `-r5-preauth-split-${iter}`, 'trust_provenance_missing')
        queue(h)
        __test_recordOutput(h.agentId, () => h.ws, h.manager)
        jest.advanceTimersByTime(2_000)
        output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
        await userInput(h, '\r', { replay: true })
        output(h, left)
        output(h, right)
        jest.advanceTimersByTime(200)
        await userInput(h, '\r')
        jest.advanceTimersByTime(1_999)
        expect(h.states.some(s => s.phase === 'ready'), `preauth split ${split} early`).toBe(false)
        jest.advanceTimersByTime(1)
        expect(h.states.at(-1), `preauth split ${split} ready`).toMatchObject({ phase: 'ready' })
        expect(commandWrites(h)).toEqual(['queued turn'])
      }
    }
  })

  test('blocker at 1999ms cancels recovery; respawn/stale timer/reset/kill cleanup, no duplicate', async () => {
    // blocker at 1999 cancels
    const cancel = harness('codex', '-r5-cancel-1999', 'trust_provenance_missing')
    queue(cancel)
    __test_recordOutput(cancel.agentId, () => cancel.ws, cancel.manager)
    jest.advanceTimersByTime(2_000)
    output(cancel, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(cancel, '\r', { replay: true })
    output(cancel, CODEX_NORMAL_COMPOSER)
    await userInput(cancel, '\r')
    jest.advanceTimersByTime(1_999)
    output(cancel, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    jest.advanceTimersByTime(30_000)
    expect(cancel.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    expect(cancel.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(cancel)).toEqual([])

    // respawn makes old epoch stale
    const respawn = harness('codex', '-r5-respawn', 'trust_provenance_missing')
    queue(respawn)
    __test_recordOutput(respawn.agentId, () => respawn.ws, respawn.manager)
    jest.advanceTimersByTime(2_000)
    output(respawn, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(respawn, '\r', { replay: true })
    output(respawn, CODEX_NORMAL_COMPOSER)
    respawn.instanceId = 2
    // Need to prime new observation for new instance
    output(respawn, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(respawn, '\r')
    jest.advanceTimersByTime(60_000)
    expect(respawn.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(respawn)).toEqual([])

    // stale timer after respawn is no-op
    const stale = harness('codex', '-r5-stale-timer', 'trust_provenance_missing')
    queue(stale)
    __test_recordOutput(stale.agentId, () => stale.ws, stale.manager)
    jest.advanceTimersByTime(2_000)
    output(stale, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(stale, '\r', { replay: true })
    output(stale, CODEX_NORMAL_COMPOSER)
    await userInput(stale, '\r')
    stale.instanceId = 2
    jest.advanceTimersByTime(30_000)
    expect(stale.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(stale)).toEqual([])

    // reset cleanup
    const reset = harness('codex', '-r5-reset', 'trust_provenance_missing')
    queue(reset)
    __test_recordOutput(reset.agentId, () => reset.ws, reset.manager)
    jest.advanceTimersByTime(2_000)
    output(reset, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(reset, '\r', { replay: true })
    output(reset, CODEX_NORMAL_COMPOSER)
    __test_resetTuiStartupState(reset.agentId)
    await userInput(reset, '\r')
    jest.advanceTimersByTime(60_000)
    expect(reset.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(reset)).toEqual([])

    // kill cleanup
    const killed = harness('codex', '-r5-kill', 'trust_provenance_missing')
    queue(killed)
    __test_recordOutput(killed.agentId, () => killed.ws, killed.manager)
    jest.advanceTimersByTime(2_000)
    output(killed, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(killed, '\r', { replay: true })
    output(killed, CODEX_NORMAL_COMPOSER)
    await __test_handleMessage({ type: 'kill', agentId: killed.agentId, daemonId: 'd1' } as any, killed.ws, killed.manager, {} as any, { stop: () => {} } as any)
    // Need fresh blocker after kill? But kill removes panel; subsequent output should be ignored due to no panel. Just check no ready.
    jest.advanceTimersByTime(60_000)
    expect(killed.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(killed)).toEqual([])
  })

  test('kill deletes generation-owned observation and replay epoch — direct lifecycle regression', async () => {
    const h = harness('codex', '-r5-kill-observation', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    expect(__test_hasTuiObservation(h.agentId)).toBe(true)
    await userInput(h, '\r', { replay: true })
    expect(__test_hasReplayEpoch(h.agentId)).toBe(true)
    expect(__test_hasTuiObservation(h.agentId)).toBe(true)
    // composer captured into epoch
    output(h, CODEX_NORMAL_COMPOSER)
    expect(__test_getReplayEpochRaw(h.agentId)?.length).toBeGreaterThan(0)
    await __test_handleMessage({ type: 'kill', agentId: h.agentId, daemonId: 'd1' } as any, h.ws, h.manager, {} as any, { stop: () => {} } as any)
    expect(__test_hasReplayEpoch(h.agentId)).toBe(false)
    expect(__test_hasTuiObservation(h.agentId)).toBe(false)
    expect(__test_getReplayEpochRaw(h.agentId)).toBeUndefined()
    // Subsequent output and live Enter after kill must not reach ready — no dangling epoch/observation reuse
    output(h, CODEX_NORMAL_COMPOSER)
    await userInput(h, '\r')
    jest.advanceTimersByTime(60_000)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('successful intervening PTY mutation invalidates cached evidence', async () => {
    // generic text
    const generic = harness('codex', '-r5-inter-generic', 'trust_provenance_missing')
    queue(generic)
    __test_recordOutput(generic.agentId, () => generic.ws, generic.manager)
    jest.advanceTimersByTime(2_000)
    output(generic, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(generic, '\r', { replay: true })
    output(generic, CODEX_NORMAL_COMPOSER)
    await userInput(generic, 'hello')
    await userInput(generic, '\r')
    jest.advanceTimersByTime(60_000)
    expect(generic.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(generic).filter(w => w === 'queued turn')).toEqual([])

    // arrow
    const arrow = harness('codex', '-r5-inter-arrow', 'trust_provenance_missing')
    queue(arrow)
    __test_recordOutput(arrow.agentId, () => arrow.ws, arrow.manager)
    jest.advanceTimersByTime(2_000)
    output(arrow, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(arrow, '\r', { replay: true })
    output(arrow, CODEX_NORMAL_COMPOSER)
    await userInput(arrow, '\x1b[A')
    await userInput(arrow, '\r')
    jest.advanceTimersByTime(60_000)
    expect(arrow.states.some(s => s.phase === 'ready')).toBe(false)

    // send_keys
    const sk = harness('codex', '-r5-inter-sendkeys', 'trust_provenance_missing')
    queue(sk)
    __test_recordOutput(sk.agentId, () => sk.ws, sk.manager)
    jest.advanceTimersByTime(2_000)
    output(sk, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(sk, '\r', { replay: true })
    output(sk, CODEX_NORMAL_COMPOSER)
    await __test_handleMessage({ type: 'send_keys', requestId: 'sk-inter', agentId: sk.agentId, daemonId: 'd1', keys: ['up'] } as any, sk.ws, sk.manager, {} as any, {} as any)
    await userInput(sk, '\r')
    jest.advanceTimersByTime(60_000)
    expect(sk.states.some(s => s.phase === 'ready')).toBe(false)

    // orchestrator input (generic text via orchestrator path, but while blocked it's buffered not written, so test via direct write after ready? Instead test that orchestrator Enter while blocked is buffered and does not invalidate until flushed? For our case, after replay epoch, orchestrator send_keys already covered.
  })

  test('resize preserves epoch (not invalidator) and still recovers', async () => {
    const h = harness('codex', '-r5-resize-preserve', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(h, '\r', { replay: true })
    output(h, CODEX_NORMAL_COMPOSER)
    await __test_handleMessage({ type: 'resize', agentId: h.agentId, daemonId: 'd1', cols: 80, rows: 24 } as any, h.ws, h.manager, {} as any, {} as any)
    await userInput(h, '\r')
    jest.advanceTimersByTime(2_000)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(commandWrites(h)).toEqual(['queued turn'])
  })

  test('ordinary live Enter -> later composer recovery remains unchanged', async () => {
    const h = harness('codex', '-r5-ordinary', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(h, '\r')
    output(h, CODEX_NORMAL_COMPOSER)
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(commandWrites(h)).toEqual(['queued turn'])
  })
})

describe('R5 generic scanner guard', () => {
  const FRESH_CONJUNCTION = '\x1b[?2004h› Ask Codex to do anything'

  test('replay true + fresh DECSET 2004 -> composer stays blocked beyond settle and 30s', async () => {
    const h = harness('codex', '-r5-guard-replay-conjunction', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed' })
    await userInput(h, '\r', { replay: true })
    output(h, FRESH_CONJUNCTION)
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
    jest.advanceTimersByTime(1)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('resize + fresh conjunction without live Enter stays blocked beyond settle and 30s', async () => {
    const h = harness('codex', '-r5-guard-resize-conjunction', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked' })
    await __test_handleMessage({ type: 'resize', agentId: h.agentId, daemonId: 'd1', cols: 120, rows: 40 } as any, h.ws, h.manager, {} as any, {} as any)
    output(h, FRESH_CONJUNCTION)
    jest.advanceTimersByTime(2_000)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    jest.advanceTimersByTime(30_000)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(1)
  })

  test('replay conjunction then silent live Enter recovers at exactly 2000ms single flush', async () => {
    const h = harness('codex', '-r5-guard-replay-then-live', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(h, '\r', { replay: true })
    output(h, FRESH_CONJUNCTION)
    jest.advanceTimersByTime(5_000)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    await userInput(h, '\r')
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(h.states.filter(s => s.phase === 'ready')).toHaveLength(1)
    expect(commandWrites(h)).toEqual(['queued turn'])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)
    jest.advanceTimersByTime(30_000)
    expect(h.states.filter(s => s.phase === 'ready')).toHaveLength(1)
    expect(commandWrites(h)).toEqual(['queued turn'])
  })

  test('ordinary initial codex startup with no blocker and valid conjunction remains ready', () => {
    const h = harness('codex', '-r5-guard-ordinary-startup')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, '\x1b[?2004h›')
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(commandWrites(h)).toEqual(['queued turn'])
  })

  test('ordinary live-Enter manual trust recovery unchanged', async () => {
    const h = harness('codex', '-r5-guard-ordinary-live', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_TRUST_MENU_TEXT_V150)
    await userInput(h, '\r')
    output(h, FRESH_CONJUNCTION)
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(commandWrites(h)).toEqual(['queued turn'])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)
  })

  test('different Codex blocker (authentication) still recovers via later valid generic conjunction when text is gone', () => {
    const h = harness('codex', '-r5-guard-auth-recovery', 'trust_provenance_missing')
    queue(h)
    __test_recordOutput(h.agentId, () => h.ws, h.manager)
    jest.advanceTimersByTime(2_000)
    // Authentication blocker — not the exact workspace-trust v150 blocker, so
    // tuiMatchedBlocker stays empty and the narrowed guard must not strand it.
    output(h, CODEX_TRUST_MENU_READY_BYTES + CODEX_AUTH_MENU_TEXT)
    expect(h.states.at(-1)).toMatchObject({ phase: 'blocked', gate: 'authentication', reason: 'authentication_required' })
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    // Later valid generic ordered protocol conjunction after the blocker text is gone
    // must still be able to clear the stale trust seed via the generic scanner.
    output(h, FRESH_CONJUNCTION)
    jest.advanceTimersByTime(1_999)
    expect(h.states.some(s => s.phase === 'ready')).toBe(false)
    expect(commandWrites(h)).toEqual([])
    jest.advanceTimersByTime(1)
    expect(h.states.at(-1)).toMatchObject({ phase: 'ready' })
    expect(commandWrites(h)).toEqual(['queued turn'])
    expect(__test_getTuiPendingInputCount(h.agentId)).toBe(0)
    jest.advanceTimersByTime(30_000)
    expect(h.states.filter(s => s.phase === 'ready')).toHaveLength(1)
  })
})
