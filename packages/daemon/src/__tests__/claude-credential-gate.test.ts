import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CLAUDE_AUTH_CHECK_MAX_BYTES,
  CLAUDE_AUTH_CHECK_TIMEOUT_MS,
  ClaudeCredentialGate,
  checkClaudeCredentialStatus,
  parseClaudeAuthStatusJson,
  type ClaudeCredentialOutcome,
} from '../pty/claude-credential-gate'

const positiveJson = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'anthropic',
  analyticsDisabled: false,
})
const negativeJson = JSON.stringify({
  loggedIn: false,
  authMethod: 'none',
  apiProvider: 'none',
  analyticsDisabled: true,
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Claude structured credential check', () => {
  test('parses positive and negative closed JSON shapes', () => {
    expect(parseClaudeAuthStatusJson(positiveJson)).toEqual({ status: 'authenticated' })
    expect(parseClaudeAuthStatusJson(negativeJson)).toEqual({ status: 'unauthenticated' })
  })

  test('maps malformed and missing-field shapes to unknown', () => {
    expect(parseClaudeAuthStatusJson('{')).toEqual({ status: 'unknown', reason: 'malformed_json' })
    // A required field missing is still refused — that is what the check is for.
    expect(parseClaudeAuthStatusJson(JSON.stringify({ loggedIn: true }))).toEqual({ status: 'unknown', reason: 'unsupported_shape' })
    // A required field present but wrongly typed is still refused.
    expect(parseClaudeAuthStatusJson(JSON.stringify({
      ...JSON.parse(positiveJson), loggedIn: 'yes',
    }))).toEqual({ status: 'unknown', reason: 'unsupported_shape' })
  })

  test('accepts additive fields — the real 2.1.247 team-plan document', () => {
    // Verbatim shape from `claude auth status --json` on Claude Code 2.1.247,
    // team plan (identifying values replaced with synthetic ones). Requiring an exact key set here blocked every such user with
    // "credential check could not be verified" while they were logged in.
    const teamPlan = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      analyticsDisabled: false,
      email: 'someone@example.com',
      orgId: '00000000-0000-4000-8000-0000000000c1',
      orgName: 'Example Org',
      subscriptionType: 'team',
    })
    expect(parseClaudeAuthStatusJson(teamPlan)).toEqual({ status: 'authenticated' })
    expect(parseClaudeAuthStatusJson(JSON.stringify({
      ...JSON.parse(teamPlan), loggedIn: false,
    }))).toEqual({ status: 'unauthenticated' })
  })

  test('uses the exact binary/env, no shell, bounded time, and bounded output', async () => {
    const exactEnv = { HOME: '/isolated/home', PATH: '/bin', ANTHROPIC_API_KEY: 'private' }
    let invocation: any
    const outcome = await checkClaudeCredentialStatus('/exact/claude', exactEnv, (binary, args, options, callback) => {
      invocation = { binary, args, options }
      callback(null, positiveJson, 'ignored stderr')
    })
    expect(outcome).toEqual({ status: 'authenticated' })
    expect(invocation.binary).toBe('/exact/claude')
    expect(invocation.args).toEqual(['auth', 'status', '--json'])
    expect(invocation.options.env).toEqual(exactEnv)
    expect(invocation.options.timeout).toBe(CLAUDE_AUTH_CHECK_TIMEOUT_MS)
    expect(invocation.options.maxBuffer).toBe(CLAUDE_AUTH_CHECK_MAX_BYTES)
    expect(invocation.options).not.toHaveProperty('shell')
  })

  test('classifies the callback outcome matrix without trusting stderr or abnormal-process stdout', async () => {
    const extraKeyJson = JSON.stringify({ ...JSON.parse(negativeJson), extra: true })
    const cases: Array<{
      name: string
      error: any
      stdout: string
      stderr?: string
      expected: ClaudeCredentialOutcome
    }> = [
      { name: 'exit 0 exact false', error: null, stdout: negativeJson, expected: { status: 'unauthenticated' } },
      { name: 'exit 0 exact true with stderr', error: null, stdout: positiveJson, stderr: 'warning', expected: { status: 'authenticated' } },
      { name: 'exit 0 malformed', error: null, stdout: '{', expected: { status: 'unknown', reason: 'malformed_json' } },
      { name: 'exit 0 additive fields still classify', error: null, stdout: extraKeyJson, expected: { status: 'unauthenticated' } },
      { name: 'numeric nonzero exact false with stderr', error: Object.assign(new Error('exit'), { code: 1, killed: false, signal: null }), stdout: negativeJson, stderr: 'warning', expected: { status: 'unauthenticated' } },
      { name: 'numeric nonzero exact true', error: Object.assign(new Error('exit'), { code: 1, killed: false, signal: null }), stdout: positiveJson, expected: { status: 'unknown', reason: 'nonzero_exit' } },
      { name: 'numeric nonzero malformed', error: Object.assign(new Error('exit'), { code: 2, killed: false, signal: null }), stdout: '{', expected: { status: 'unknown', reason: 'nonzero_exit' } },
      { name: 'numeric nonzero arbitrary', error: Object.assign(new Error('exit'), { code: 2, killed: false, signal: null }), stdout: 'arbitrary', expected: { status: 'unknown', reason: 'nonzero_exit' } },
      { name: 'numeric nonzero additive-field logged-out doc is accepted', error: Object.assign(new Error('exit'), { code: 2, killed: false, signal: null }), stdout: extraKeyJson, expected: { status: 'unauthenticated' } },
      { name: 'numeric nonzero additive-field POSITIVE doc is still refused', error: Object.assign(new Error('exit'), { code: 2, killed: false, signal: null }), stdout: JSON.stringify({ ...JSON.parse(positiveJson), orgName: 'Example Org' }), expected: { status: 'unknown', reason: 'nonzero_exit' } },
      { name: 'missing command ignores exact false', error: Object.assign(new Error('missing'), { code: 'ENOENT' }), stdout: negativeJson, expected: { status: 'unknown', reason: 'command_missing' } },
      { name: 'configured timeout ignores exact false', error: Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }), stdout: negativeJson, expected: { status: 'unknown', reason: 'timeout' } },
      { name: 'external timeout signal is not timeout', error: Object.assign(new Error('signal'), { killed: false, signal: 'SIGTERM' }), stdout: negativeJson, expected: { status: 'unknown', reason: 'nonzero_exit' } },
      { name: 'other signal ignores exact false', error: Object.assign(new Error('signal'), { killed: false, signal: 'SIGKILL' }), stdout: negativeJson, expected: { status: 'unknown', reason: 'nonzero_exit' } },
      { name: 'max buffer ignores complete-looking false', error: Object.assign(new Error('max buffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: false, signal: null }), stdout: negativeJson, expected: { status: 'unknown', reason: 'nonzero_exit' } },
      { name: 'runner failure ignores complete-looking false', error: Object.assign(new Error('runner'), { code: 'EACCES', killed: false, signal: null }), stdout: negativeJson, expected: { status: 'unknown', reason: 'nonzero_exit' } },
      { name: 'partial oversized-looking output is ignored', error: Object.assign(new Error('max buffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), stdout: `${negativeJson.slice(0, -1)},`, expected: { status: 'unknown', reason: 'nonzero_exit' } },
    ]

    for (const entry of cases) {
      const outcome = await checkClaudeCredentialStatus('/exact/claude', { HOME: '/h' }, (_b, _a, _o, cb) => {
        cb(entry.error, entry.stdout, entry.stderr ?? '')
      })
      expect(outcome, entry.name).toEqual(entry.expected)
    }
  })
})

describe('Claude credential/protocol conjunction', () => {
  test('positive credentials alone do not ready; a same-instance protocol handshake does exactly once', async () => {
    const events: string[] = []
    const gate = new ClaudeCredentialGate({ check: async () => ({ status: 'authenticated' }) })
    gate.bind({ agentId: 'a', panelInstanceId: 1, binary: '/claude', env: { HOME: '/h' } }, {
      onChecking: () => events.push('checking'),
      onBlocked: () => events.push('blocked'),
      onAwaitingFreshProtocol: () => events.push('awaiting'),
      onReady: () => events.push('ready'),
    })
    await flushPromises()
    expect(events).toEqual(['checking', 'awaiting'])
    expect(gate.isAutomationReady('a', 1)).toBe(false)
    expect(gate.observeProtocolReady('a', 1)).toBe(true)
    expect(gate.observeProtocolReady('a', 1)).toBe(false)
    expect(events).toEqual(['checking', 'awaiting', 'ready'])
  })

  test('an initial protocol handshake may wait for the in-flight positive structured result', async () => {
    let resolve!: (outcome: ClaudeCredentialOutcome) => void
    const events: string[] = []
    const gate = new ClaudeCredentialGate({ check: () => new Promise(r => { resolve = r }) })
    gate.bind({ agentId: 'a', panelInstanceId: 1, binary: '/claude', env: { HOME: '/h' } }, {
      onChecking: () => events.push('checking'), onBlocked: () => events.push('blocked'),
      onAwaitingFreshProtocol: () => events.push('awaiting'), onReady: () => events.push('ready'),
    })
    expect(gate.observeProtocolReady('a', 1)).toBe(false)
    resolve({ status: 'authenticated' })
    await flushPromises()
    expect(events).toEqual(['checking', 'ready'])
  })

  test('negative and unknown retain automation while recovery requires positive then a fresh handshake', async () => {
    let now = 0
    const pending: Array<(outcome: ClaudeCredentialOutcome) => void> = []
    const events: string[] = []
    const gate = new ClaudeCredentialGate({
      now: () => now,
      recheckMinMs: 2_000,
      check: () => new Promise(resolve => pending.push(resolve)),
    })
    gate.bind({ agentId: 'a', panelInstanceId: 1, binary: '/claude', env: { HOME: '/h' } }, {
      onChecking: () => events.push('checking'),
      onBlocked: outcome => events.push(`blocked:${outcome.status}`),
      onAwaitingFreshProtocol: () => events.push('awaiting'),
      onReady: () => events.push('ready'),
    })
    pending.shift()!({ status: 'unauthenticated' })
    await flushPromises()
    expect(gate.isAutomationReady('a', 1)).toBe(false)
    expect(gate.observeProtocolReady('a', 1)).toBe(false)

    now = 2_000
    gate.noteActivity('a', 1)
    pending.shift()!({ status: 'authenticated' })
    await flushPromises()
    expect(events).toEqual(['checking', 'blocked:unauthenticated', 'awaiting'])
    expect(gate.isAutomationReady('a', 1)).toBe(false)
    expect(gate.observeProtocolReady('a', 1)).toBe(true)
    expect(events.at(-1)).toBe('ready')
  })

  test('rejects stale results and wrong-instance readiness', async () => {
    const pending: Array<(outcome: ClaudeCredentialOutcome) => void> = []
    const events: string[] = []
    const gate = new ClaudeCredentialGate({ check: () => new Promise(resolve => pending.push(resolve)) })
    const callbacks = {
      onChecking: () => events.push('checking'), onBlocked: () => events.push('blocked'),
      onAwaitingFreshProtocol: () => events.push('awaiting'), onReady: () => events.push('ready'),
    }
    gate.bind({ agentId: 'a', panelInstanceId: 1, binary: '/old', env: { HOME: '/old' } }, callbacks)
    gate.bind({ agentId: 'a', panelInstanceId: 2, binary: '/new', env: { HOME: '/new' } }, callbacks)
    pending.shift()!({ status: 'authenticated' })
    await flushPromises()
    expect(gate.getStateForTest('a')?.status).toBe('checking')
    expect(gate.observeProtocolReady('a', 1)).toBe(false)
    pending.shift()!({ status: 'authenticated' })
    await flushPromises()
    expect(gate.observeProtocolReady('a', 2)).toBe(true)
  })

  test('coalesces activity into a rate-limited recheck', async () => {
    let now = 0
    const pending: Array<(outcome: ClaudeCredentialOutcome) => void> = []
    const timers: Array<() => void> = []
    const gate = new ClaudeCredentialGate({
      now: () => now,
      recheckMinMs: 2_000,
      check: () => new Promise(resolve => pending.push(resolve)),
      setTimer: ((callback: () => void) => { timers.push(callback); return 1 as any }) as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    })
    gate.bind({ agentId: 'a', panelInstanceId: 1, binary: '/claude', env: { HOME: '/h' } }, {
      onChecking: () => {}, onBlocked: () => {}, onAwaitingFreshProtocol: () => {}, onReady: () => {},
    })
    pending.shift()!({ status: 'unknown', reason: 'malformed_json' })
    await flushPromises()
    gate.noteActivity('a', 1)
    gate.noteActivity('a', 1)
    expect(timers).toHaveLength(1)
    expect(pending).toHaveLength(0)
    now = 2_000
    timers.shift()!()
    expect(pending).toHaveLength(1)
  })

  test('client keeps the human input path direct while only orchestrator input enters startup buffering', () => {
    const source = readFileSync(path.join(import.meta.dir, '..', 'ws', 'client.ts'), 'utf8')
    const inputBranch = source.slice(source.indexOf("case 'input':"), source.indexOf("case 'kill':"))
    expect(inputBranch).toContain("if (msg.source === 'orchestrator')")
    expect(inputBranch).toContain('// Non-orchestrator (user) input.')
    expect(inputBranch).toContain('manager.write(msg.agentId, msg.data, msg.source)')
    expect(inputBranch.indexOf('// Non-orchestrator (user) input.')).toBeGreaterThan(inputBranch.indexOf("if (msg.source === 'orchestrator')"))
  })

  test('client reads the exact current PTY environment and never relays terminal snippets as startup diagnostics', () => {
    const clientSource = readFileSync(path.join(import.meta.dir, '..', 'ws', 'client.ts'), 'utf8')
    const managerSource = readFileSync(path.join(import.meta.dir, '..', 'pty', 'manager.ts'), 'utf8')
    expect(managerSource).toContain('spawnEnv: { ...env }')
    expect(managerSource).toContain('getPanelSpawnEnvironment')
    expect(clientSource).toContain('const env = manager.getPanelSpawnEnvironment(agentId)')
    expect(clientSource).not.toContain('firstOutputSnippet: firstOutputSnippet')
    expect(clientSource).not.toContain('snippet="${firstOutputSnippet')
  })
})
