import { describe, expect, test } from 'bun:test'
import { PtyManager } from '../pty/manager.js'

describe('panel_startup_gate_state daemon emitter', () => {
  test('stores, emits, and health-reports the observation for the current panel instance', () => {
    const sent: string[] = []
    const manager = new PtyManager()
    manager.setCurrentWs({ readyState: 1, send: (value: string) => sent.push(value) } as any)
    ;(manager as any).handles.set('panel-1', {
      agentId: 'panel-1', agentKey: 'kimi', instanceId: 7, cwd: '/tmp/project', killed: false,
    })

    manager.setPanelStartupGateState('panel-1', {
      phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed', observedAt: 1234,
    })

    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'panel_startup_gate_state', agentId: 'panel-1', panelInstanceId: 7,
      state: { phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed', observedAt: 1234 },
    })
    expect(manager.getLivePanelsReport()[0]?.startupGate).toEqual({
      phase: 'blocked', gate: 'workspace_trust', reason: 'prompt_observed', observedAt: 1234,
    })

    manager.emitPanelStartupGateState('panel-1')
    expect(JSON.parse(sent[1]!)).toEqual(JSON.parse(sent[0]!))
  })
})
