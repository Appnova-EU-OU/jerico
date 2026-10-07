/**
 * Issue #617 R1 regression — mcpConfigured must be retained on panelMetaMap
 * only AFTER it settles, never at the earlier `setPanelMeta()` spawn-start call.
 *
 * The daemon computes `mcpConfigured` across several branches in
 * `packages/daemon/src/ws/client.ts` (~4300-4434), one of which (agy) awaits
 * an async config write before the value is final. `setPanelMeta()` runs
 * before any of that resolves. Retaining the field at that earlier call site
 * would publish a placeholder forever — this test proves the manager API
 * that fixes it: the value is absent until explicitly settled, and settling
 * it late is exactly what `getLivePanels()` (the payload `daemon_resync`
 * sends) must reflect.
 *
 * RUN (by exact path, with a throw-away HOME as the README describes):
 *   bun test packages/daemon/src/__tests__/panel-meta-mcp-configured.test.ts
 */
import { describe, test, expect, mock, afterAll } from 'bun:test'
import { EventEmitter } from 'node:events'

class FakePty extends EventEmitter {
  pid = 1234
  write(): void {}
  resize(): void {}
  destroy(): void {}
  kill(): void { this.emit('exit', { exitCode: null, signal: 'SIGTERM' }) }
  onData(handler: (data: string) => void): void { this.on('data', handler) }
  onExit(handler: (event: { exitCode: number | null; signal: number | string | null }) => void): void { this.on('exit', handler) }
}

const realNodePty = { ...require('node-pty') }
mock.module('node-pty', () => ({
  ...realNodePty,
  spawn: mock(() => new FakePty()),
}))
afterAll(() => {
  mock.module('node-pty', () => ({ ...realNodePty }))
})

const { PtyManager } = await import('../pty/manager.js')

const A = '11111111-1111-4111-8111-111111111111' as any
const B = '22222222-2222-4222-8222-222222222222' as any

describe('#617 R1 — mcpConfigured retention timing', () => {
  test('omitted at spawn-start cache, present only after explicit settlement', () => {
    const manager = new PtyManager()
    manager.spawn('panel-r1', 'agy', '/bin/agy', [], 80, 24, () => {}, () => {}, undefined, A)

    // This mirrors the real call at client.ts:4174 — happens BEFORE any of the
    // async MCP-config resolution, so mcpConfigured is not part of this object.
    manager.setPanelMeta('panel-r1', {
      agentId: 'panel-r1',
      spawnAttemptId: A,
      agentKey: 'agy',
    })

    const beforeSettle = manager.getLivePanels().find(p => p.agentId === 'panel-r1')
    expect(beforeSettle).toBeDefined()
    expect(beforeSettle!.mcpConfigured).toBeUndefined()

    // Retaining at the setPanelMeta call site (the bug this test guards
    // against) would have published a placeholder `true` for agy here, before
    // ensureAgyMcpConfig's await ever resolves. Nothing in this test has
    // called the retention API yet, so the roster must still omit the field —
    // omission is safe (R2), a premature `false`/`true` is not.
    const stillBeforeSettle = manager.getLivePanels().find(p => p.agentId === 'panel-r1')
    expect(stillBeforeSettle!.mcpConfigured).toBeUndefined()

    // Now the async config write "settles" (mirrors the await at client.ts:4431).
    manager.setPanelMcpConfigured('panel-r1', A, true)

    const afterSettle = manager.getLivePanels().find(p => p.agentId === 'panel-r1')
    expect(afterSettle!.mcpConfigured).toBe(true)
  })

  test('a superseded spawnAttemptId can never patch a newer generation\'s meta', () => {
    const manager = new PtyManager()
    manager.spawn('panel-r1b', 'agy', '/bin/agy', [], 80, 24, () => {}, () => {}, undefined, A)
    manager.setPanelMeta('panel-r1b', { agentId: 'panel-r1b', spawnAttemptId: A, agentKey: 'agy' })

    // Generation A is replaced by generation B before A's async settle lands —
    // a straggler resolve from A must not clobber B's freshly-cached meta.
    manager.spawn('panel-r1b', 'agy', '/bin/agy', [], 80, 24, () => {}, () => {}, undefined, B)
    manager.setPanelMeta('panel-r1b', { agentId: 'panel-r1b', spawnAttemptId: B, agentKey: 'agy' })

    manager.setPanelMcpConfigured('panel-r1b', A, true) // stale generation, must be a no-op

    const panel = manager.getLivePanels().find(p => p.agentId === 'panel-r1b')
    expect(panel!.mcpConfigured).toBeUndefined()

    manager.setPanelMcpConfigured('panel-r1b', B, true) // current generation, must apply
    const settled = manager.getLivePanels().find(p => p.agentId === 'panel-r1b')
    expect(settled!.mcpConfigured).toBe(true)
  })

  test('a spawn failure clears the cached meta before any settlement can land', () => {
    const manager = new PtyManager()
    manager.spawn('panel-r1c', 'agy', '/bin/agy', [], 80, 24, () => {}, () => {}, undefined, A)
    manager.setPanelMeta('panel-r1c', { agentId: 'panel-r1c', spawnAttemptId: A, agentKey: 'agy' })

    manager.clearPanelMeta('panel-r1c', A) // mirrors cleanupPreHandleResidue() on a failed spawn
    manager.setPanelMcpConfigured('panel-r1c', A, true) // late-arriving settle after failure — must not resurrect

    const panel = manager.getLivePanels().find(p => p.agentId === 'panel-r1c')
    expect(panel).toBeUndefined()
  })
})
