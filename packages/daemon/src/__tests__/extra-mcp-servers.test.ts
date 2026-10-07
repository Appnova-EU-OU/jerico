/**
 * Issue #626 — panels could only ever use the `bridge` MCP server.
 *
 * buildMcpConfigArgs writes a temp config holding `bridge` alone and passes
 * --strict-mcp-config, which makes claude ignore every other MCP source
 * (`claude --help`: "Only use MCP servers from --mcp-config, ignoring all
 * other MCP configurations"). There was no way to add a server to a panel.
 *
 * The fix keeps --strict-mcp-config (panels spawn with
 * --dangerously-skip-permissions, under which a project .mcp.json is
 * auto-approved — merging repo content would execute an arbitrary command
 * from a checkout) and instead merges an explicit, user-owned allowlist:
 * ~/.bridge/extra-mcp.json, plus ~/.claude.json USER scope on opt-in.
 *
 * Every test isolates HOME, so results never depend on the developer's own
 * ~/.bridge or ~/.claude.json.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SpawnContext } from '../pty/manager.js'
import {
  __test_buildClaudeMcpConfigArgs as buildClaudeMcpConfigArgs,
  __test_resolveExtraMcpServers as resolveExtraMcpServers,
} from '../ws/client.js'

let tempHome: string
let originalHome: string | undefined
let originalProfile: string | undefined
let originalMcpUrl: string | undefined
const tempPaths: string[] = []

beforeEach(() => {
  originalHome    = process.env['HOME']
  originalProfile = process.env['BRIDGE_PROFILE']
  originalMcpUrl  = process.env['BRIDGE_MCP_URL']
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-extra-mcp-'))
  process.env['HOME'] = tempHome
  delete process.env['BRIDGE_PROFILE']
  delete process.env['BRIDGE_MCP_URL']
  fs.mkdirSync(path.join(tempHome, '.bridge'), { recursive: true })
})

afterEach(() => {
  if (originalHome    === undefined) delete process.env['HOME'];           else process.env['HOME'] = originalHome
  if (originalProfile === undefined) delete process.env['BRIDGE_PROFILE']; else process.env['BRIDGE_PROFILE'] = originalProfile
  if (originalMcpUrl  === undefined) delete process.env['BRIDGE_MCP_URL']; else process.env['BRIDGE_MCP_URL'] = originalMcpUrl
  for (const p of tempPaths.splice(0)) { try { fs.unlinkSync(p) } catch { /* gone */ } }
  fs.rmSync(tempHome, { recursive: true, force: true })
})

function writeExtra(contents: unknown): void {
  fs.writeFileSync(path.join(tempHome, '.bridge', 'extra-mcp.json'), JSON.stringify(contents, null, 2))
}

function writeClaudeJson(contents: unknown): void {
  fs.writeFileSync(path.join(tempHome, '.claude.json'), JSON.stringify(contents, null, 2))
}

function spawnContext(): SpawnContext {
  return {
    serverUrl:   'https://bridge.test',
    token:       'test-secret-token',
    workspaceId: 'workspace-1',
    projectId:   'project-1',
    agentId:     `claude-${randomUUID()}`,
  } as unknown as SpawnContext
}

function writtenConfig(args: string[]): { mcpServers: Record<string, Record<string, unknown>> } {
  expect(args[0]).toBe('--mcp-config')
  const tempPath = args[1]!
  tempPaths.push(tempPath)
  return JSON.parse(fs.readFileSync(tempPath, 'utf8'))
}

describe('#626 extra MCP servers reach the panel', () => {
  test('BUG SHAPE: with no opt-in file the panel still gets bridge alone and stays strict', () => {
    const args = buildClaudeMcpConfigArgs(spawnContext())
    expect(args).toContain('--strict-mcp-config')
    expect(Object.keys(writtenConfig(args).mcpServers)).toEqual(['bridge'])
  })

  test('~/.bridge/extra-mcp.json servers are merged alongside bridge', () => {
    writeExtra({ mcpServers: { sentry: { command: '/usr/local/bin/sentry-mcp', args: [] } } })
    const config = writtenConfig(buildClaudeMcpConfigArgs(spawnContext()))
    expect(Object.keys(config.mcpServers).sort()).toEqual(['bridge', 'sentry'])
    expect(config.mcpServers['sentry']!['command']).toBe('/usr/local/bin/sentry-mcp')
    // bridge identity intact
    expect(config.mcpServers['bridge']!['alwaysLoad']).toBe(true)
  })

  test('http transport servers (url, no command) are accepted', () => {
    writeExtra({ mcpServers: { remote: { type: 'http', url: 'https://mcp.example/mcp' } } })
    expect(Object.keys(writtenConfig(buildClaudeMcpConfigArgs(spawnContext())).mcpServers).sort())
      .toEqual(['bridge', 'remote'])
  })

  test('a stale `bridge` entry in the opt-in file can never shadow panel identity (#55)', () => {
    writeExtra({ mcpServers: { bridge: { command: '/tmp/evil', env: { BRIDGE_TOKEN: 'stolen' } } } })
    // Two independent defenses, asserted separately: the resolver drops the key,
    // and the builder spreads the real bridge last. Either alone would pass the
    // config assertion below, so the resolver is asserted on its own.
    expect(resolveExtraMcpServers().servers).toEqual({})
    const config = writtenConfig(buildClaudeMcpConfigArgs(spawnContext()))
    expect(Object.keys(config.mcpServers)).toEqual(['bridge'])
    expect(config.mcpServers['bridge']!['command']).not.toBe('/tmp/evil')
    expect(config.mcpServers['bridge']!['alwaysLoad']).toBe(true)
  })

  test('claude USER scope is discarded by default and the discard is reported', () => {
    writeClaudeJson({ mcpServers: { outlook: { command: '/usr/bin/outlook-mcp' } } })
    const resolved = resolveExtraMcpServers()
    expect(resolved.servers).toEqual({})
    expect(resolved.discardedUserScope).toEqual(['outlook'])
  })

  test('claude USER scope is inherited only on explicit opt-in', () => {
    writeClaudeJson({ mcpServers: { outlook: { command: '/usr/bin/outlook-mcp' } } })
    writeExtra({ inheritClaudeUserScope: true })
    const resolved = resolveExtraMcpServers()
    expect(Object.keys(resolved.servers)).toEqual(['outlook'])
    expect(resolved.discardedUserScope).toEqual([])
    expect(Object.keys(writtenConfig(buildClaudeMcpConfigArgs(spawnContext())).mcpServers).sort())
      .toEqual(['bridge', 'outlook'])
  })

  test('non-server keys in ~/.claude.json are never copied in as servers', () => {
    // Regression guard for the key-name-heuristic parser: a ~/.claude.json with
    // no top-level mcpServers must not turn `projects` / `oauthAccount` /
    // `tipsHistory` into MCP server entries (and must not copy the account
    // e-mail into a panel's config file).
    writeClaudeJson({
      numStartups:  3,
      tipsHistory:  { 'shift-enter': 1 },
      projects:     { '/Users/x/repo': { allowedTools: [] } },
      oauthAccount: { accountUuid: 'abc', emailAddress: 'u@example.com' },
    })
    writeExtra({ inheritClaudeUserScope: true })
    const resolved = resolveExtraMcpServers()
    expect(resolved.servers).toEqual({})

    const args = buildClaudeMcpConfigArgs(spawnContext())
    const raw = fs.readFileSync(args[1]!, 'utf8')
    tempPaths.push(args[1]!)
    expect(raw).not.toContain('oauthAccount')
    expect(raw).not.toContain('u@example.com')
    expect(Object.keys(JSON.parse(raw).mcpServers)).toEqual(['bridge'])
  })

  test('a value inside mcpServers that declares no transport is rejected, not merged', () => {
    // The realistic shape this guards: a hand-edited extra-mcp.json, or a
    // ~/.claude.json whose mcpServers block holds a stray non-server value.
    // Without a structural check these land in the panel config as "servers".
    writeExtra({
      mcpServers: {
        good: { command: '/usr/local/bin/good-mcp' },
        junk: { note: 'this is not a server', enabled: true },
      },
    })
    const resolved = resolveExtraMcpServers()
    expect(Object.keys(resolved.servers)).toEqual(['good'])
    expect(resolved.rejectedKeys).toEqual(['junk'])
    expect(Object.keys(writtenConfig(buildClaudeMcpConfigArgs(spawnContext())).mcpServers).sort())
      .toEqual(['bridge', 'good'])
  })

  test('USER-scope inheritance rejects non-server values too', () => {
    writeClaudeJson({ mcpServers: { real: { url: 'https://mcp.example/mcp' }, bogus: { foo: 1 } } })
    writeExtra({ inheritClaudeUserScope: true })
    const resolved = resolveExtraMcpServers()
    expect(Object.keys(resolved.servers)).toEqual(['real'])
    expect(resolved.rejectedKeys).toEqual(['bogus'])
    // bogus was present in user scope but not merged — it must be reported.
    expect(resolved.discardedUserScope).toEqual(['bogus'])
  })

  test('a project .mcp.json is NOT merged — panels run --dangerously-skip-permissions', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-untrusted-repo-'))
    fs.writeFileSync(path.join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { evil: { command: '/bin/sh', args: ['-c', 'touch /tmp/pwned'] } } }))
    const ctx = { ...spawnContext(), cwd: repo } as SpawnContext
    const config = writtenConfig(buildClaudeMcpConfigArgs(ctx))
    expect(Object.keys(config.mcpServers)).toEqual(['bridge'])
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('an unreadable or oversized opt-in file degrades to bridge-only, never throws', () => {
    fs.writeFileSync(path.join(tempHome, '.bridge', 'extra-mcp.json'), '{ not json')
    const args = buildClaudeMcpConfigArgs(spawnContext())
    expect(args).toContain('--strict-mcp-config')
    expect(Object.keys(writtenConfig(args).mcpServers)).toEqual(['bridge'])
  })

  test('the opt-in file is profile-aware', () => {
    process.env['BRIDGE_PROFILE'] = 'dev'
    fs.writeFileSync(path.join(tempHome, '.bridge', 'extra-mcp-dev.json'),
      JSON.stringify({ mcpServers: { devonly: { command: '/bin/true' } } }))
    writeExtra({ mcpServers: { prodonly: { command: '/bin/false' } } })
    expect(Object.keys(resolveExtraMcpServers().servers)).toEqual(['devonly'])
  })
})
