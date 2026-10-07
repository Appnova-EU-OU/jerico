import { describe, it, expect, spyOn } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __test_handleMessage, __test_setCachedAgents } from '../ws/client.js'
import { PtyManager } from '../pty/manager.js'
import { SimulatorManager } from '../simulator/manager.js'
import * as workspaceTrust from '../workspace-trust.js'

describe('two-spawn regression', () => {
  it('does not seed trust for auto-promoted server paths', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'jerico-test-')))
    // 1. First spawn comes from server with setVia: 'auto'
    const msg1: any = {
      type: 'spawn',
      spawnAttemptId: '11111111-1111-4111-8111-111111111111',
      agentId: 'a1',
      agentKey: 'kimi',
      sessionId: 's',
      projectId: 'p',
      workspaceId: 'w',
      cols: 80,
      rows: 24,
      cwd: cwd,
      daemonLocalPath: cwd,
      daemonBindingSetVia: 'auto'
    }

    const config: any = { token: 'tok', projectPaths: {}, projectPathSources: {} }
    const ws: any = { send: () => {}, readyState: 1 }
    const manager = new PtyManager()
    const simManager = new SimulatorManager('daemon-1')
    spyOn(manager, 'spawn').mockReturnValue(true)

    __test_setCachedAgents([{ key: 'kimi' } as any])

    const seedSpy = spyOn(workspaceTrust, 'seedWorkspaceTrust')
    
    await __test_handleMessage(msg1, ws, manager, config, simManager)
    expect(seedSpy.mock.calls[0][0].setVia).toBe('auto')

    // We simulate phase2a.auto_register having run by modifying config directly
    // since mocking node:child_process across ESM boundaries in bun test can be flaky.
    config.projectPaths = { p: cwd }
    config.projectPathSources = { p: 'auto' }

    // 2. Second spawn uses local_override (since it was auto-registered)
    // The server provides no daemonLocalPath now, it uses local_override
    const msg2: any = {
      type: 'spawn',
      spawnAttemptId: '22222222-2222-4222-8222-222222222222',
      agentId: 'a2',
      agentKey: 'kimi',
      sessionId: 's2',
      projectId: 'p',
      workspaceId: 'w',
      cols: 80,
      rows: 24,
      cwd: cwd
    }

    seedSpy.mockClear()
    await __test_handleMessage(msg2, ws, manager, config, simManager)
    
    // The setVia should be 'auto' read from config.projectPathSources
    expect(seedSpy.mock.calls[0][0].setVia).toBe('auto')
  })
})
