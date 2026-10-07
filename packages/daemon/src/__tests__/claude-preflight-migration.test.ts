import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_SPECS } from '../pty/agents.js'
import type { SpawnContext } from '../pty/manager.js'
import { __test_buildClaudeMcpConfigArgs as buildClaudeMcpConfigArgs } from '../ws/client.js'

const originalMcpUrl = process.env['BRIDGE_MCP_URL']
const tempPaths: string[] = []

// #626: buildMcpConfigArgs now merges the user's opt-in extra MCP servers
// (~/.bridge/extra-mcp.json, and ~/.claude.json USER scope on opt-in). Isolate
// HOME so this suite asserts the daemon's own output, not whatever the machine
// running it happens to have configured.
let tempHome: string
let originalHome: string | undefined

beforeEach(() => {
  originalHome = process.env['HOME']
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-preflight-home-'))
  process.env['HOME'] = tempHome
})

afterEach(() => {
  if (originalMcpUrl === undefined) delete process.env['BRIDGE_MCP_URL']
  else process.env['BRIDGE_MCP_URL'] = originalMcpUrl
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  for (const tempPath of tempPaths.splice(0)) {
    try { fs.unlinkSync(tempPath) } catch { /* already removed */ }
  }
  fs.rmSync(tempHome, { recursive: true, force: true })
})

function settingsLayer(args: string[]): Record<string, unknown> {
  expect(args.filter(arg => arg === '--settings')).toHaveLength(1)
  const settingsAt = args.indexOf('--settings')
  expect(settingsAt).toBeGreaterThan(-1)
  return JSON.parse(args[settingsAt + 1]!)
}

describe('Claude per-process settings arguments', () => {
  const claude = AGENT_SPECS.find(spec => spec.key === 'claude')!

  test('fresh args contain exactly one required inline settings layer', () => {
    const args = [...claude.spawnArgs!, '--session-id', 'fresh-session', '--model', 'sonnet']
    expect(settingsLayer(args)).toEqual({ skipDangerousModePermissionPrompt: true })
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).toContain('fresh-session')
    expect(args).toContain('sonnet')
  })

  test('resume args contain exactly one required inline settings layer', () => {
    const args = [...claude.resumeArgs!('resume-session'), '--model', 'opus']
    expect(settingsLayer(args)).toEqual({ skipDangerousModePermissionPrompt: true })
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'resume-session'])
    expect(args).toContain('opus')
  })
})

function spawnContext(): SpawnContext {
  return {
    serverUrl: 'https://bridge.test',
    token: 'test-secret-token',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    agentId: `claude-${randomUUID()}`,
  } as unknown as SpawnContext
}

function verifyMcpConfig(args: string[], transport: 'http' | 'stdio'): void {
  expect(args[0]).toBe('--mcp-config')
  expect(args.filter(arg => arg === '--mcp-config')).toHaveLength(1)
  expect(args.filter(arg => arg === '--strict-mcp-config')).toHaveLength(1)
  const tempPath = args[1]!
  tempPaths.push(tempPath)
  expect(args).toEqual(['--mcp-config', tempPath, '--strict-mcp-config'])
  expect(fs.statSync(tempPath).mode & 0o777).toBe(0o600)

  const config = JSON.parse(fs.readFileSync(tempPath, 'utf8'))
  // #626: extras may be merged; what must always hold is that bridge is present
  // and carries this panel's identity. With HOME isolated there are no extras.
  expect(Object.keys(config.mcpServers)).toEqual(['bridge'])
  expect(config.mcpServers.bridge.alwaysLoad).toBe(true)
  if (transport === 'http') {
    expect(config.mcpServers.bridge.type).toBe('http')
    expect(config.mcpServers.bridge.headers.Authorization).toBe('Bearer test-secret-token')
  } else {
    expect(typeof config.mcpServers.bridge.command).toBe('string')
    expect(config.mcpServers.bridge.args).toEqual([])
  }
  expect(os.tmpdir()).toBe(tempPath.slice(0, tempPath.lastIndexOf('/')))
}

describe('Claude strict per-panel MCP config', () => {
  test('HTTP config marks only bridge alwaysLoad and remains 0600', () => {
    process.env['BRIDGE_MCP_URL'] = 'https://mcp.bridge.test'
    verifyMcpConfig(buildClaudeMcpConfigArgs(spawnContext()), 'http')
  })

  test('stdio config marks only bridge alwaysLoad and remains 0600', () => {
    delete process.env['BRIDGE_MCP_URL']
    verifyMcpConfig(buildClaudeMcpConfigArgs(spawnContext()), 'stdio')
  })
})
