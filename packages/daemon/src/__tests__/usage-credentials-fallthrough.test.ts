import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveCredential } from '../usage/credentials.js'
import { fetchClaudeUsage } from '../usage/providers/claude.js'
import { __test_refreshOne, __test_setFetchOverride, usageForHealth } from '../usage/refresher.js'


const previousHome = process.env.HOME
const previousBin = process.env.JERICO_TEST_SECURITY_BIN
const previousArgs = process.env.JERICO_TEST_SECURITY_ARGS
const previousFetch = globalThis.fetch
const previousPlatform = process.env.JERICO_TEST_KEYCHAIN_PLATFORM
const dirs: string[] = []

function fakeHome(file: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-usage-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude/.credentials.json'), file)
  process.env.HOME = dir
  return dir
}

function keychainJson(json: string): void {
  process.env.JERICO_TEST_SECURITY_BIN = process.execPath
  process.env.JERICO_TEST_SECURITY_ARGS = `-e process.stdout.write(${JSON.stringify(json)})`
}

// The Keychain fallback runs only on macOS; the seam drives that branch on every
// OS so these cases also run on Linux. Every read is redirected by
// JERICO_TEST_SECURITY_BIN/ARGS, so the real `security` is never executed.
beforeEach(() => { process.env.JERICO_TEST_KEYCHAIN_PLATFORM = 'darwin' })

afterEach(() => {
  if (previousPlatform === undefined) delete process.env.JERICO_TEST_KEYCHAIN_PLATFORM; else process.env.JERICO_TEST_KEYCHAIN_PLATFORM = previousPlatform
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
  if (previousBin === undefined) delete process.env.JERICO_TEST_SECURITY_BIN; else process.env.JERICO_TEST_SECURITY_BIN = previousBin
  if (previousArgs === undefined) delete process.env.JERICO_TEST_SECURITY_ARGS; else process.env.JERICO_TEST_SECURITY_ARGS = previousArgs
  globalThis.fetch = previousFetch
  __test_setFetchOverride(null)
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('Claude credential eligibility', () => {
  const usable = (data: Record<string, unknown>) => {
    const oauth = data['claudeAiOauth']
    return oauth !== null && typeof oauth === 'object' && !Array.isArray(oauth) && typeof (oauth as Record<string, unknown>)['accessToken'] === 'string' && (oauth as Record<string, unknown>)['accessToken'] !== ''
  }
  test('MCP-only file falls through to a usable keychain credential', async () => {
    fakeHome('{"mcpOAuth":{}}')
    keychainJson('{"claudeAiOauth":{"accessToken":"test-only"}}')
    const result = await resolveCredential({ file: '.claude/.credentials.json', keychainService: 'test', allowInteractive: true, acceptFile: usable })
    expect(result.found).toBe(true)
    if (result.found) expect(result.credential.source).toBe('keychain')
  })

  test('background MCP-only fallback is deferred without executing security', async () => {
    fakeHome('{"mcpOAuth":{}}')
    process.env.JERICO_TEST_SECURITY_BIN = '/definitely-not-executed'
    const result = await resolveCredential({ file: '.claude/.credentials.json', keychainService: 'test', allowInteractive: false, acceptFile: usable })
    expect(result).toMatchObject({ found: false, reason: 'keychain_deferred' })
  })

  test('malformed file does not fall through', async () => {
    fakeHome('{')
    keychainJson('{"claudeAiOauth":{"accessToken":"test-only"}}')
    const result = await resolveCredential({ file: '.claude/.credentials.json', keychainService: 'test', allowInteractive: true, acceptFile: usable })
    expect(result).toMatchObject({ found: false, reason: 'malformed' })
  })

  test('file OAuth wins without running keychain', async () => {
    fakeHome('{"claudeAiOauth":{"accessToken":"test-only"}}')
    process.env.JERICO_TEST_SECURITY_BIN = '/definitely-not-executed'
    const result = await resolveCredential({ file: '.claude/.credentials.json', keychainService: 'test', allowInteractive: true, acceptFile: usable })
    expect(result).toMatchObject({ found: true, credential: { source: 'file' } })
  })

  test('both sources without Claude OAuth are non-blaming', async () => {
    fakeHome('{"mcpOAuth":{}}')
    keychainJson('{"mcpOAuth":{}}')
    const result = await resolveCredential({ file: '.claude/.credentials.json', keychainService: 'test', allowInteractive: true, acceptFile: usable })
    expect(result).toMatchObject({ found: true, credential: { source: 'keychain' } })
  })

  test('empty file OAuth falls through and fetches using the keychain token', async () => {
    fakeHome('{"claudeAiOauth":{"accessToken":""}}')
    keychainJson('{"claudeAiOauth":{"accessToken":"keychain-test"}}')
    let authorization = ''
    globalThis.fetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      return new Response(JSON.stringify({ limits: [{ kind: 'session', group: 'session', percent: 1, severity: 'normal', resets_at: null, scope: null, is_active: true }] }), { status: 200 })
    }
    const result = await fetchClaudeUsage({ allowInteractive: true })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.snapshot.source).toContain('keychain: Claude Code-credentials')
    expect(authorization).toBe('Bearer keychain-test')
  })

  test('usable file OAuth stays ahead of an unavailable keychain', async () => {
    fakeHome('{"claudeAiOauth":{"accessToken":"file-test"}}')
    process.env.JERICO_TEST_SECURITY_BIN = '/definitely-not-executed'
    globalThis.fetch = async () => new Response(JSON.stringify({ limits: [{ kind: 'session', group: 'session', percent: 1, severity: 'normal', resets_at: null, scope: null, is_active: true }] }), { status: 200 })
    const result = await fetchClaudeUsage({ allowInteractive: true })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.snapshot.source).toContain('~/.claude/.credentials.json')
  })

  test('both Claude stores without usable OAuth reach the neutral provider fault', async () => {
    fakeHome('{"claudeAiOauth":{"accessToken":""}}')
    keychainJson('{"claudeAiOauth":{"accessToken":""}}')
    const result = await fetchClaudeUsage({ allowInteractive: true })
    expect(result).toMatchObject({ ok: false, code: 'no_usage_token' })
  })

  test('a real keychain Claude snapshot survives the next deferred refresh', async () => {
    fakeHome('{"mcpOAuth":{}}')
    keychainJson('{"claudeAiOauth":{"accessToken":"keychain-test"}}')
    globalThis.fetch = async () => new Response(JSON.stringify({ limits: [{ kind: 'session', group: 'session', percent: 1, severity: 'normal', resets_at: null, scope: null, is_active: true }] }), { status: 200 })
    __test_setFetchOverride(async (_agent, opts) => fetchClaudeUsage(opts))
    await __test_refreshOne('claude', { allowInteractive: true })
    await __test_refreshOne('claude', { allowInteractive: false })
    const entry = usageForHealth().find((item) => item.agent === 'claude')
    expect(entry).toMatchObject({ source: expect.stringContaining('keychain: Claude Code-credentials'), stale: true, faultCode: 'keychain_deferred' })
  })
})
