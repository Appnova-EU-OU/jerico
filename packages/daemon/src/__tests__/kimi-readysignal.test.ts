import { describe, it, expect, beforeEach, afterEach, jest, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AGENT_SPECS } from '../pty/agents'
import {
  __test_deliverOrchestratorCommand,
  __test_observeTuiReadinessOutput,
  resetOrchTestState,
} from '../ws/client'

// Issue #91: Kimi's agent config previously targeted the old Python `kimi-cli`
// (readySignal 'kimi-for-coding', checkAuth ~/.kimi, versionDirGlobs pointing at a
// `uv tool install` layout) instead of the current `kimi-code` runtime. The dead
// readySignal meant the TUI-readiness gate (shipped in #529 to fix stuck injection)
// never opened for Kimi, so every dispatch stalled the full readyTimeoutMs.
//
// Captured from the live 0.38.0 panel. The previous footer literal disappeared,
// while the prompt was fully interactive — readiness must not depend on this copy.
const KIMI_038_REAL_OUTPUT_EXCERPT = [
  'yolo  K2.7 Coding thinking  …/smoke/work',
  'Try /dance for a hidden Easter egg',
  'context: 0% (0/256k)',
].join('\r\n')

describe('Kimi agent config (issue #91)', () => {
  const kimi = AGENT_SPECS.find(s => s.key === 'kimi')

  it('is declared', () => {
    expect(kimi).toBeDefined()
  })

  it('uses output quiescence instead of decorative 0.38.0 footer copy', () => {
    expect(KIMI_038_REAL_OUTPUT_EXCERPT).not.toContain('ctrl+c')
    expect(kimi?.tui?.readySignals ?? []).toEqual([])
    expect(kimi?.tui?.readyQuiescenceMs).toBe(3_000)
  })

  it('does NOT use the dead old-kimi-cli readySignal', () => {
    expect(kimi?.tui?.readySignals ?? []).not.toContain('kimi-for-coding')
  })

  it('opens the queued-input gate after three quiet seconds and reports ready', () => {
    jest.useFakeTimers()
    const agentId = 'kimi-038-quiescent'
    const writes: string[] = []
    const states: unknown[] = []
    const ws = { readyState: 1, send: mock(() => {}) }
    const observation = { startupGateDetected: false }
    const output = Buffer.from(KIMI_038_REAL_OUTPUT_EXCERPT).toString('base64')
    const manager = {
      getAgentKey: () => 'kimi',
      getPanelInstanceId: () => 7,
      getCurrentWs: () => ws,
      setPanelStartupGateState: (_id: string, state: unknown) => states.push(state),
      write: (_id: string, data: string) => {
        writes.push(Buffer.from(data, 'base64').toString('utf8'))
        return true
      },
    }

    try {
      __test_deliverOrchestratorCommand(agentId, 'kimi', 'live smoke turn', manager as never, ws as never)
      __test_observeTuiReadinessOutput(agentId, 'kimi', output, manager as never, observation)
      jest.advanceTimersByTime(2_500)
      // A redraw is output too: readiness is three seconds from the latest byte,
      // not three seconds from whichever chunk happened to arm the first timer.
      __test_observeTuiReadinessOutput(agentId, 'kimi', output, manager as never, observation)
      jest.advanceTimersByTime(500)
      expect(writes).toEqual([])
      jest.advanceTimersByTime(2_499)
      expect(writes).toEqual([])
      jest.advanceTimersByTime(1)
      expect(writes).toEqual(['\x1b[200~live smoke turn\x1b[201~\r'])
      expect(states).toHaveLength(1)
      expect(states[0]).toMatchObject({ phase: 'ready', gate: 'workspace_trust' })
    } finally {
      resetOrchTestState(agentId)
      jest.useRealTimers()
    }
  })

  it('never turns a detected trust prompt into ready merely because it is quiet', () => {
    jest.useFakeTimers()
    const agentId = 'kimi-038-trust-gate'
    const observation = { startupGateDetected: false }
    const manager = {
      getAgentKey: () => 'kimi',
      getPanelInstanceId: () => 7,
      getCurrentWs: () => ({ readyState: 1, send: mock(() => {}) }),
      setPanelStartupGateState: mock(() => {}),
      write: mock(() => true),
    }

    try {
      const prompt = "Trust this folder\nDon't trust\nEnable project MCP servers\nExit Kimi Code"
      __test_observeTuiReadinessOutput(
        agentId, 'kimi', Buffer.from(prompt).toString('base64'), manager as never, observation,
      )
      jest.advanceTimersByTime(3_000)
      expect(manager.setPanelStartupGateState).toHaveBeenCalledTimes(1)
      expect(manager.setPanelStartupGateState).toHaveBeenCalledWith(agentId, expect.objectContaining({
        phase: 'blocked', reason: 'prompt_observed',
      }))
      expect(manager.write).not.toHaveBeenCalled()
    } finally {
      resetOrchTestState(agentId)
      jest.useRealTimers()
    }
  })

  it('never treats unrelated silent outputs as ready (quiet-but-not-ready negative cases)', () => {
    jest.useFakeTimers()
    const agentId = 'kimi-038-false-ready'
    const writes: string[] = []
    const observation = { startupGateDetected: false }
    const manager = {
      getAgentKey: () => 'kimi',
      getPanelInstanceId: () => 7,
      getCurrentWs: () => ({ readyState: 1, send: mock(() => {}) }),
      setPanelStartupGateState: mock(() => {}),
      write: (_id: string, data: string) => { writes.push(data); return true },
    }

    try {
      const cases = [
        'Downloading Kimi update: 42%',
        'Connecting to MCP server…',
        'Trust this project directory (y/N)?', // a localized/changed trust prompt
      ]
      for (const output of cases) {
        __test_deliverOrchestratorCommand(agentId, 'kimi', 'cmd', manager as never, manager.getCurrentWs() as never)
        __test_observeTuiReadinessOutput(agentId, 'kimi', Buffer.from(output).toString('base64'), manager as never, observation)
        jest.advanceTimersByTime(3_500)
        expect(writes).toEqual([])
      }
    } finally {
      resetOrchTestState(agentId)
      jest.useRealTimers()
    }
  })

  it('cannot mark a replacement PTY ready from the previous instance timer', () => {
    jest.useFakeTimers()
    const agentId = 'kimi-038-replaced'
    let instanceId = 7
    const observation = { startupGateDetected: false }
    const manager = {
      getAgentKey: () => 'kimi',
      getPanelInstanceId: () => instanceId,
      getCurrentWs: () => ({ readyState: 1, send: mock(() => {}) }),
      setPanelStartupGateState: mock(() => {}),
      write: mock(() => true),
    }

    try {
      __test_observeTuiReadinessOutput(
        agentId, 'kimi', Buffer.from(KIMI_038_REAL_OUTPUT_EXCERPT).toString('base64'), manager as never, observation,
      )
      instanceId = 8
      jest.advanceTimersByTime(3_000)
      expect(manager.setPanelStartupGateState).not.toHaveBeenCalled()
      expect(manager.write).not.toHaveBeenCalled()
    } finally {
      resetOrchTestState(agentId)
      jest.useRealTimers()
    }
  })

  describe('checkAuth targets kimi-code credentials, not the legacy ~/.kimi dir', () => {
    let fakeHome: string
    let originalHome: string | undefined
    let originalApiKey: string | undefined

    beforeEach(() => {
      fakeHome = mkdtempSync(path.join(os.tmpdir(), 'kimi-auth-test-'))
      originalHome = process.env['HOME']
      originalApiKey = process.env['KIMI_API_KEY']
      process.env['HOME'] = fakeHome
      delete process.env['KIMI_API_KEY']
    })

    afterEach(() => {
      process.env['HOME'] = originalHome
      if (originalApiKey !== undefined) process.env['KIMI_API_KEY'] = originalApiKey
      rmSync(fakeHome, { recursive: true, force: true })
    })

    it('reports authenticated when ~/.kimi-code/credentials/kimi-code.json exists', async () => {
      mkdirSync(path.join(fakeHome, '.kimi-code', 'credentials'), { recursive: true })
      writeFileSync(path.join(fakeHome, '.kimi-code', 'credentials', 'kimi-code.json'), '{"token":"x"}')
      expect(await kimi?.checkAuth?.()).toBe(true)
    })

    it('reports NOT authenticated on a fresh machine with only the legacy ~/.kimi dir (the exact #91 bug)', async () => {
      // A machine that has kimi-code installed and authenticated, but ALSO happens to
      // have a leftover ~/.kimi dir from the old Python CLI, must not be misreported —
      // and conversely, a bare ~/.kimi with no kimi-code credentials must not read as
      // authenticated (the old checkDir('.kimi') bug in reverse).
      mkdirSync(path.join(fakeHome, '.kimi'), { recursive: true })
      expect(await kimi?.checkAuth?.()).toBe(false)
    })
  })

  it('versionDirGlobs point at the kimi-code install layout, not the old kimi-cli uv-tool path', () => {
    expect(kimi?.versionDirGlobs).toEqual(['.kimi-code/bin'])
  })
})
