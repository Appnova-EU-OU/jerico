/**
 * Unit tests — Phase 2A daemon features (fingerprint, auto-register readiness)
 */

import { describe, test, expect, mock, afterAll } from 'bun:test'
import { captureLogs } from '@jerico/shared/test-utils'

let mockHostname = 'test-host'
let mockUsername = 'test-user'
let mockHashResult = 'deadbeef1234'
let throwHostname = false
let throwUserInfo = false

const osMock = {
  hostname: () => { if (throwHostname) throw new Error('EIO'); return mockHostname },
  userInfo: () => { if (throwUserInfo) throw new Error('EACCES'); return { username: mockUsername } },
  homedir: () => '/home/test',
  tmpdir: () => '/tmp',
  cpus: () => [{ times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }],
  totalmem: () => 16_000_000_000,
  freemem: () => 8_000_000_000,
}

// #505/#552: require() bypasses Bun's mock.module registry and always
// returns the real module, even after mocking is active — the only safe
// snapshot source both for filling in a partial mock and for undoing it
// later. Bare mocks like these (missing platform/arch/release/EOL/
// networkInterfaces from os, and most of crypto) permanently shadow the
// rest for any test file that runs later in the same `bun test` process.
const realOs = { ...require('node:os') }
const realCrypto = { ...require('node:crypto') }

// Mock both 'os' (default import) and 'node:os' (named imports like profile.ts's `homedir`)
mock.module('os', () => ({ ...realOs, default: { ...realOs, ...osMock }, ...osMock }))
mock.module('node:os', () => ({ ...realOs, default: { ...realOs, ...osMock }, ...osMock }))

mock.module('node:crypto', () => ({
  ...realCrypto,
  createHash: () => ({
    update: () => ({ digest: () => mockHashResult }),
  }),
  randomBytes: (size: number) => Buffer.alloc(size, 1),
  randomUUID: () => 'mock-uuid-1234',
}))

afterAll(() => {
  mock.module('os', () => ({ ...realOs, default: realOs }))
  mock.module('node:os', () => ({ ...realOs, default: realOs }))
  mock.module('node:crypto', () => ({ ...realCrypto, default: realCrypto }))
})

const { computeFingerprint, __test_buildCodexMcpConfigArgs } = await import('../ws/client.js')

describe('computeFingerprint', () => {
  test('is deterministic for same host:user', () => {
    mockHostname = 'macbook-pro'
    mockUsername = 'alice'
    const a = computeFingerprint()
    const b = computeFingerprint()
    expect(a).toBe(b)
  })

  test('returns expected hash result', () => {
    mockHashResult = 'abc123def456'
    const fp = computeFingerprint()
    expect(fp).toBe('abc123def456')
  })

  test('fallback to unknown when userInfo throws', () => {
    throwUserInfo = true
    const capture = captureLogs()
    const fp = computeFingerprint()
    capture.restore()
    expect(fp).toBe('unknown')
    throwUserInfo = false
  })

  test('fallback to unknown when hostname throws', () => {
    throwHostname = true
    const capture = captureLogs()
    const fp = computeFingerprint()
    capture.restore()
    expect(fp).toBe('unknown')
    throwHostname = false
  })
})

describe('property: computeFingerprint', () => {
  test('never crashes with random hostnames/usernames', () => {
    const chars = 'abcABC123_-.:/?#@!%'
    for (let i = 0; i < 200; i++) {
      mockHostname = Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
      mockUsername = Array.from({ length: 15 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
      let threw = false
      try { computeFingerprint() } catch { threw = true }
      expect(threw).toBe(false)
    }
  })
})

describe('Codex MCP panel identity', () => {
  test('passes panel and persona identity through the explicit MCP env map', () => {
    const args = __test_buildCodexMcpConfigArgs({
      serverUrl: 'http://localhost:3100',
      token: 'test-token',
      workspaceId: 'workspace-1' as never,
      projectId: 'project-1' as never,
      agentId: 'panel-1' as never,
      personaId: 'persona-1',
      cwd: '/tmp',
    }).join('\n')

    expect(args).toContain('BRIDGE_PANEL_ID="panel-1"')
    expect(args).toContain('BRIDGE_PERSONA_ID="persona-1"')
  })
})
