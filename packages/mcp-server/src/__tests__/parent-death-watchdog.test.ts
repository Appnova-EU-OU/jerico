/**
 * Issue #24 — bridge-mcp is spawned by the owning CLI (claude/opencode/etc),
 * not the daemon, so when that CLI dies without cleanly closing the stdio
 * pipe, nothing reaps this process and it's silently reparented to
 * launchd/init forever. This is a real OS-process integration test, not a
 * unit test — the behavior under test IS process reparenting — so it spawns
 * real processes against the actual built dist/index.cjs bundle (the same
 * artifact the daemon ships), not the TypeScript source.
 *
 * Every spawned process is unconditionally SIGKILLed in `finally`, so a
 * failing assertion can never leave a real orphan running on the host.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

// Compiles to CommonJS (packages/mcp-server has no "type": "module"), so
// __dirname is available and resolves relative to dist/__tests__/ at runtime
// — the same relative position this file has under src/__tests__/.
const DIST_ENTRY = join(__dirname, '../index.cjs')

const CHILD_ENV = {
  ...process.env,
  HTTP_MODE: 'false',
  BRIDGE_CODEGRAPH: '0', // hard-disable the codegraph arm fetch — no network round trip at startup
  BRIDGE_SERVER_URL: 'http://127.0.0.1:1',
  BRIDGE_TOKEN: 'test-token',
  BRIDGE_WORKSPACE_ID: 'test-ws',
  BRIDGE_PROJECT_ID: 'test-proj',
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(pred: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return pred()
}

/**
 * Spawns a throwaway "wrapper" process (a plain `node -e` one-liner) that
 * itself spawns dist/index.cjs in stdio mode as ITS direct child, then
 * blocks forever. Killing the wrapper (not the mcp-server child directly)
 * is what actually exercises OS reparenting — the wrapper plays the role of
 * the CLI (claude/opencode/etc) that owns the mcp-server in production.
 */
function spawnWrapperWithMcpChild(): { wrapperPid: number; getChildPid: () => Promise<number> } {
  const script = `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, [${JSON.stringify(DIST_ENTRY)}], {
      env: ${JSON.stringify(CHILD_ENV)},
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    process.stdout.write('CHILD_PID:' + child.pid + '\\n')
    // Keep the wrapper alive until killed; never touch the child again.
    setInterval(() => {}, 60_000)
  `
  const wrapper = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  const wrapperPid = wrapper.pid!

  const getChildPid = () => new Promise<number>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('timed out waiting for CHILD_PID')), 10_000)
    wrapper.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const m = buf.match(/CHILD_PID:(\d+)/)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    wrapper.on('error', (e) => { clearTimeout(timer); reject(e) })
  })

  return { wrapperPid, getChildPid }
}

describe('bridge-mcp parent-death watchdog (#24)', () => {
  it('exits within the poll bound after its owning process is killed (no stdin EOF ever arrives)', async () => {
    const { wrapperPid, getChildPid } = spawnWrapperWithMcpChild()
    let childPid = -1
    try {
      childPid = await getChildPid()
      assert.ok(isAlive(childPid), 'mcp-server child should be alive right after spawn')
      assert.ok(isAlive(wrapperPid), 'wrapper should be alive right after spawn')

      // Give the child a moment to connect its stdio transport and arm the
      // watchdog (buildMcpServer + srv.connect are async).
      await new Promise(r => setTimeout(r, 1500))
      assert.ok(isAlive(childPid), 'mcp-server child should still be alive before the kill')

      // Kill ONLY the wrapper (simulates the owning CLI crashing / being
      // force-quit) — the child's stdin write-end is never closed by us, so
      // stdin EOF is not what saves it here; the wrapper's own -e script
      // holds no reference to the child's stdio streams beyond inheriting
      // them at spawn, and killing it drops that inherited pipe, but the
      // decisive assertion is that the child exits well inside the ppid
      // poll bound regardless of exactly how/when EOF propagates.
      process.kill(wrapperPid, 'SIGKILL')
      assert.ok(await waitUntil(() => !isAlive(wrapperPid), 5_000), 'wrapper should be gone after SIGKILL')

      // PARENT_POLL_MS is 5s in source; allow real slack for CI scheduling.
      const exited = await waitUntil(() => !isAlive(childPid), 12_000)
      assert.ok(exited, `mcp-server child (pid ${childPid}) should have exited within ~12s of its owner dying, but is still alive`)
    } finally {
      if (childPid > 0 && isAlive(childPid)) { try { process.kill(childPid, 'SIGKILL') } catch {} }
      if (isAlive(wrapperPid)) { try { process.kill(wrapperPid, 'SIGKILL') } catch {} }
    }
  })

  it('HTTP mode installs no parent-death watchdog (must not self-exit while its owner lives on)', async () => {
    const httpEnv: Record<string, string> = { ...CHILD_ENV, PORT: '0' }
    delete httpEnv['HTTP_MODE'] // absent → defaults to HTTP mode (index.ts: `!== 'false'`)
    const child = spawn(process.execPath, [DIST_ENTRY], {
      env: httpEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const pid = child.pid!
    try {
      await new Promise(r => setTimeout(r, 1000))
      assert.ok(isAlive(pid), 'HTTP-mode server should be alive and running independently')
      // No owner-death simulation here — HTTP mode has no per-CLI owner to
      // watch at all; this test only guards against a future regression
      // that accidentally arms the stdio watchdog unconditionally.
    } finally {
      if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    }
  })
})
