import { describe, it, expect, spyOn } from 'bun:test'
import { HOOK_TARGETS } from '../hooks/targets.js'
import { __test_handleMessage, __test_setCachedAgents } from '../ws/client.js'
import * as installMod from '../hooks/install.js'
import { PtyManager } from '../pty/manager.js'
import { SimulatorManager } from '../simulator/manager.js'

import { lastHookInstallRefusal, setHookInstallRefusal } from '../hooks/state.js'

describe('hook install is driven by HOOK_TARGETS', () => {
  it('attempts to install for a fake target in the list', async () => {
    (HOOK_TARGETS as any).push('fake-agent')
    setHookInstallRefusal(null)
    __test_setCachedAgents([{ key: 'fake-agent' } as any])

    const manager = new PtyManager()
    // prevent actual spawn
    spyOn(manager, 'spawn').mockReturnValue(true)

    const msg: any = {
      type: 'spawn',
      spawnAttemptId: '11111111-1111-4111-8111-111111111111',
      agentId: 'test-agent',
      agentKey: 'fake-agent',
      sessionId: 's',
      projectId: 'p',
      workspaceId: 'w',
      cols: 80,
      rows: 24,
      cwd: '/'
    }

    const ws: any = { send: () => {}, readyState: 1 }
    const config: any = {}
    const simManager = new SimulatorManager('daemon-1')

    try {
      await __test_handleMessage(msg, ws, manager, config, simManager)
      
      // wait for promise chain to settle
      await new Promise(r => setTimeout(r, 500))
      
      expect(lastHookInstallRefusal?.status).toBe('refused-malformed')
    } finally {
      // cleanup
      const idx = (HOOK_TARGETS as any).indexOf('fake-agent')
      if (idx !== -1) (HOOK_TARGETS as any).splice(idx, 1)
      setHookInstallRefusal(null, 'fake-agent')
    }
  })

  it('does NOT install for a target removed from HOOK_TARGETS', async () => {
    setHookInstallRefusal(null)
    __test_setCachedAgents([{ key: 'claude' } as any])
    
    const manager = new PtyManager()
    spyOn(manager, 'spawn').mockReturnValue(true)

    // Remove 'claude' from the list
    const originalClaudeIndex = (HOOK_TARGETS as any).indexOf('claude')
    if (originalClaudeIndex !== -1) {
      ;(HOOK_TARGETS as any).splice(originalClaudeIndex, 1)
    }

    const msg: any = {
      type: 'spawn',
      spawnAttemptId: '22222222-2222-4222-8222-222222222222',
      agentId: 'test-agent2',
      agentKey: 'claude',
      sessionId: 's',
      projectId: 'p',
      workspaceId: 'w',
      cols: 80,
      rows: 24,
      cwd: '/'
    }

    const ws: any = { send: () => {}, readyState: 1 }
    const config: any = {}
    const simManager = new SimulatorManager('daemon-1')

    try {
      await __test_handleMessage(msg, ws, manager, config, simManager)
      
      await new Promise(r => setTimeout(r, 10))
      expect(lastHookInstallRefusal).toBe(null)
    } finally {
      // restore
      if (originalClaudeIndex !== -1 && !(HOOK_TARGETS as any).includes('claude')) {
        ;(HOOK_TARGETS as any).splice(originalClaudeIndex, 0, 'claude')
      }
    }
  })
})
