/**
 * Issue #55 — cross-project Bridge identity bleed.
 *
 * opencode, qwen, forge, and agy used to write per-panel Bridge identity
 * (including BRIDGE_TOKEN) into a file SHARED by every concurrent panel of
 * that CLI on the machine — a global per-user config (opencode, agy), or a
 * per-cwd file that collides across projects mapped to the same directory
 * and across sibling panels of the same project (forge, qwen). A second
 * spawn's write could clobber a first panel's identity before its process
 * finished reading the file, causing bridge_send_message/task assignment to
 * silently cross projects — plus, for forge specifically, a live token
 * landing in a file inside a git-tracked working directory.
 *
 * These tests exercise the deterministic, CI-testable invariants identified
 * during the diagnosis round: opencode/qwen now build fully per-panel
 * artifacts (a per-process env var / a per-panel tmp file) with no shared
 * file involved at all, forge refuses to write into an already-tracked
 * .mcp.json, and agy refuses a second concurrent spawn for a different
 * project rather than silently clobbering identity. Real-CLI-binary
 * behavior (does opencode's OPENCODE_CONFIG_CONTENT precedence hold on the
 * next release, does forge's `FORGE_CONFIG` env var exist) is not
 * CI-testable and was verified empirically against the installed binaries
 * during the diagnosis round instead — see issue #55.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  __test_buildOpencodeConfigContent as buildOpencodeConfigContent,
  __test_buildQwenMcpConfigArgs as buildQwenMcpConfigArgs,
  __test_hardenForgeGitTree as hardenForgeGitTree,
  __test_ensureAgyMcpConfig as ensureAgyMcpConfig,
} from '../ws/client.js'
import type { SpawnContext } from '../pty/manager.js'
import type { PanelMeta } from '@jerico/shared'

function ctx(over: Partial<SpawnContext>): SpawnContext {
  return {
    serverUrl: 'https://bridge.test',
    token: 'test-daemon-token',
    workspaceId: 'ws-1',
    ...over,
  } as unknown as SpawnContext
}

describe('#55 opencode — per-process config, no shared file', () => {
  test('two panels for different projects produce distinct OPENCODE_CONFIG_CONTENT values', () => {
    const a = buildOpencodeConfigContent(ctx({ projectId: 'proj-A', agentId: 'panel-A' }))
    const b = buildOpencodeConfigContent(ctx({ projectId: 'proj-B', agentId: 'panel-B' }))
    expect(a).not.toBe(b)
    const parsedA = JSON.parse(a)
    const parsedB = JSON.parse(b)
    expect(parsedA.mcp.bridge.environment.BRIDGE_PROJECT_ID).toBe('proj-A')
    expect(parsedB.mcp.bridge.environment.BRIDGE_PROJECT_ID).toBe('proj-B')
    expect(parsedA.mcp.bridge.environment.BRIDGE_PANEL_ID).toBe('panel-A')
    expect(parsedB.mcp.bridge.environment.BRIDGE_PANEL_ID).toBe('panel-B')
  })

  test('preserves the permission:allow behavior the static AgentSpec used to carry', () => {
    const content = JSON.parse(buildOpencodeConfigContent(ctx({ projectId: 'proj-A', agentId: 'panel-A' })))
    expect(content.permission).toBe('allow')
  })

  test('stdio-mode content never includes BRIDGE_TOKEN (relies on inherited PTY env, matching claude)', () => {
    const content = JSON.parse(buildOpencodeConfigContent(ctx({ projectId: 'proj-A', agentId: 'panel-A' })))
    expect(JSON.stringify(content)).not.toContain('test-daemon-token')
  })
})

describe('#55 qwen — per-panel tmp file, no shared project/home settings.json', () => {
  const writtenPaths: string[] = []
  afterEach(() => {
    for (const p of writtenPaths.splice(0)) { try { fs.unlinkSync(p) } catch { /* already gone */ } }
  })

  test('two panels for different projects get distinct config files, neither under cwd or $HOME', () => {
    const cwdA = '/tmp/fake-project-A'
    const argsA = buildQwenMcpConfigArgs(ctx({ projectId: 'proj-A', agentId: 'panel-A', cwd: cwdA }))
    const argsB = buildQwenMcpConfigArgs(ctx({ projectId: 'proj-B', agentId: 'panel-B', cwd: cwdA })) // same cwd, different project

    expect(argsA[0]).toBe('--mcp-config')
    expect(argsB[0]).toBe('--mcp-config')
    const pathA = argsA[1]!
    const pathB = argsB[1]!
    writtenPaths.push(pathA, pathB)

    expect(pathA).not.toBe(pathB)
    expect(path.dirname(pathA)).toBe(os.tmpdir())
    expect(path.dirname(pathB)).toBe(os.tmpdir())
    expect(pathA.startsWith(cwdA)).toBe(false)
    expect(pathA.startsWith(os.homedir())).toBe(false)

    const configA = JSON.parse(fs.readFileSync(pathA, 'utf-8'))
    const configB = JSON.parse(fs.readFileSync(pathB, 'utf-8'))
    expect(configA.mcpServers.bridge.env.BRIDGE_PROJECT_ID).toBe('proj-A')
    expect(configB.mcpServers.bridge.env.BRIDGE_PROJECT_ID).toBe('proj-B')
  })

  test('config file is written 0600 (contains BRIDGE_TOKEN)', () => {
    const args = buildQwenMcpConfigArgs(ctx({ projectId: 'proj-A', agentId: 'panel-mode-check' }))
    const p = args[1]!
    writtenPaths.push(p)
    const mode = fs.statSync(p).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('#55 forge — git-tree protection for the confirmed leak vector', () => {
  let repoDir: string
  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-forge-git-test-'))
    execFileSync('git', ['init', '-q'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir })
  })
  afterEach(() => { fs.rmSync(repoDir, { recursive: true, force: true }) })

  test('refuses (does not proceed to write) when .mcp.json is already tracked — the exact incident this issue reports', () => {
    fs.writeFileSync(path.join(repoDir, '.mcp.json'), '{"mcpServers":{}}\n')
    execFileSync('git', ['add', '.mcp.json'], { cwd: repoDir })
    execFileSync('git', ['commit', '-q', '-m', 'accidental commit'], { cwd: repoDir })

    const result = hardenForgeGitTree(repoDir)
    expect(result.safe).toBe(false)
    expect(result.reason).toBe('mcp_json_already_tracked')
  })

  test('adds .mcp.json to .git/info/exclude (never the tracked .gitignore) when untracked', () => {
    const result = hardenForgeGitTree(repoDir)
    expect(result.safe).toBe(true)
    const exclude = fs.readFileSync(path.join(repoDir, '.git', 'info', 'exclude'), 'utf-8')
    expect(exclude).toContain('.mcp.json')
    // Never touches the user's own .gitignore.
    expect(fs.existsSync(path.join(repoDir, '.gitignore'))).toBe(false)
  })

  test('is a no-op (safe) outside a git repo', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-forge-nogit-test-'))
    try {
      const result = hardenForgeGitTree(nonRepo)
      expect(result.safe).toBe(true)
      expect(fs.existsSync(path.join(nonRepo, '.git'))).toBe(false)
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true })
    }
  })
})

describe('#55 agy — refuse concurrent cross-project spawn instead of silently clobbering identity', () => {
  let testHome: string
  let agyConfig: string
  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-mcp-test-'))
    agyConfig = path.join(testHome, '.gemini', 'antigravity-cli', 'mcp_config.json')
    expect(agyConfig.startsWith(os.homedir())).toBe(false)
  })
  afterEach(() => {
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  function fakeManager(livePanels: Partial<PanelMeta>[]): { getLivePanels: () => PanelMeta[] } {
    return { getLivePanels: () => livePanels as PanelMeta[] }
  }

  test('refuses a second agy spawn for a different project while one is live', async () => {
    const manager = fakeManager([{ agentId: 'agy-1', agentKey: 'agy', projectId: 'proj-A' }])
    const ok = await ensureAgyMcpConfig(ctx({ projectId: 'proj-B', agentId: 'agy-2' }), manager as never, agyConfig)
    expect(ok).toBe(false)
    expect(fs.existsSync(agyConfig)).toBe(false)
  })

  test('allows a second agy spawn for the SAME project (not a cross-project conflict)', async () => {
    const manager = fakeManager([{ agentId: 'agy-1', agentKey: 'agy', projectId: 'proj-A' }])
    const ok = await ensureAgyMcpConfig(ctx({ projectId: 'proj-A', agentId: 'agy-2' }), manager as never, agyConfig)
    expect(ok).toBe(true)
    expect(fs.existsSync(agyConfig)).toBe(true)
  })

  test('allows the first agy spawn when no other agy panel is live', async () => {
    const manager = fakeManager([{ agentId: 'other', agentKey: 'claude', projectId: 'proj-X' }])
    const ok = await ensureAgyMcpConfig(ctx({ projectId: 'proj-A', agentId: 'agy-1' }), manager as never, agyConfig)
    expect(ok).toBe(true)
    expect(fs.existsSync(agyConfig)).toBe(true)
  })
})
