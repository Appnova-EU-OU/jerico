import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PtyManager } from '../pty/manager.js'
import { getHookConfig, setHookInstallRefusal } from '../hooks/state.js'

describe('panel_hook_state daemon emitter', () => {
  let home: string
  let oldHome: string | undefined
  let oldClaudePath: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jerico-hook-state-'))
    oldHome = process.env.HOME
    oldClaudePath = process.env.JERICO_CLAUDE_SETTINGS_PATH
    process.env.HOME = home
    process.env.JERICO_CLAUDE_SETTINGS_PATH = join(home, 'settings.json')
    mkdirSync(join(home, '.jerico', 'hooks'), { recursive: true })
  })

  afterEach(() => {
    setHookInstallRefusal(null)
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldClaudePath === undefined) delete process.env.JERICO_CLAUDE_SETTINGS_PATH
    else process.env.JERICO_CLAUDE_SETTINGS_PATH = oldClaudePath
    rmSync(home, { recursive: true, force: true })
  })

  test('configState is a cold read and refusal is a separate dated fact', () => {
    writeFileSync(process.env.JERICO_CLAUDE_SETTINGS_PATH!, '{}\n')
    setHookInstallRefusal('refused-malformed', 'claude', 1234)
    expect(getHookConfig('claude')).toBe('absent')

    const manager = new PtyManager()
    ;(manager as any).handles.set('panel-1', {
      agentId: 'panel-1', agentKey: 'claude', instanceId: 7, cwd: home, usagePct: 0, killed: false
    })
    const report = manager.getLivePanelsReport()[0]!
    expect(report.hook).toEqual({
      configState: 'absent',
      hookInstallRefused: { status: 'refused-malformed', at: 1234 }
    })
  })

  test('emits the same cold observation to the server with no daemon-owned counters', () => {
    writeFileSync(process.env.JERICO_CLAUDE_SETTINGS_PATH!, '{}\n')
    const sent: string[] = []
    const manager = new PtyManager()
    manager.setCurrentWs({ readyState: 1, send: (value: string) => sent.push(value) } as any)
    ;(manager as any).handles.set('panel-1', {
      agentId: 'panel-1', agentKey: 'claude', instanceId: 7, cwd: home, killed: false
    })

    manager.emitPanelHookState('panel-1')
    expect(JSON.parse(sent[0]!)).toEqual({
      type: 'panel_hook_state',
      agentId: 'panel-1',
      panelInstanceId: 7,
      configState: 'absent'
    })
  })

  test('spawn and reconnect paths retain the state emitter wiring', () => {
    const managerSource = readFileSync(join(import.meta.dir, '..', 'pty', 'manager.ts'), 'utf8')
    const clientSource = readFileSync(join(import.meta.dir, '..', 'ws', 'client.ts'), 'utf8')
    expect(managerSource).not.toContain('this.handles.set(agentId, handle)\n    this.emitPanelHookState(agentId)')
    expect(clientSource).toContain('hookAssertion.finally(() => manager.emitPanelHookState(msg.agentId))')
    expect(clientSource).toContain('else manager.emitPanelHookState(msg.agentId)')
    expect(clientSource).toContain('manager.emitAllPanelHookStates()')
  })
})
