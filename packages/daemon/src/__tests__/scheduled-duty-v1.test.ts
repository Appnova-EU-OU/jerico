import { describe, expect, test } from 'bun:test'
import { parse } from 'smol-toml'
import { __test_effectiveSpawnArgsForPrompts, resolveSpawnCwd, buildScheduledDutyAdvertisement } from '../ws/client.js'

const context = '[Scheduled duty acknowledgement]\nbridge_ack_scheduled_duty receiptId="test"\n[Bridge completion contract]\nbridge_complete_free_task receiptId="test"\n<jerico_server_owned_guardrails>Never touch prod.</jerico_server_owned_guardrails>'
const contract = { version: 1, providerRevision: 1 } as const

describe('Codex scheduledDutyV1 context', () => {
  test('role omitted delivers complete context exactly once with TOML escaping', () => {
    const prompt = context + '\n"quoted" \\ path\tend'
    const args = __test_effectiveSpawnArgsForPrompts('codex', undefined, prompt, 'scheduled-test', contract)
    const values = args.filter(arg => arg.startsWith('developer_instructions='))
    expect(values).toHaveLength(1)
    expect(parse(values[0]!).developer_instructions).toContain(prompt)
  })
  test('scheduled role cannot double inject; ordinary roles retain single delivery', () => {
    for (const scheduled of [undefined, contract]) {
      const args = __test_effectiveSpawnArgsForPrompts('codex', 'developer', context, 'scheduled-test', scheduled)
      expect(args.filter(arg => arg.startsWith('developer_instructions='))).toHaveLength(1)
    }
  })
  test('empty, malformed, oversized context refuses', () => {
    for (const prompt of [undefined, '', '  ', 'not a contract', context.repeat(200), context.replace('</jerico_server_owned_guardrails>', ''), {} as string]) {
      expect(() => __test_effectiveSpawnArgsForPrompts('codex', undefined, prompt, 'scheduled-test', contract)).toThrow()
    }
  })
  test('mandatory cwd wins without trust provenance; missing/relative paths refuse', () => {
    expect(resolveSpawnCwd('p', '/repo', '/worktree', { p: '/repo' }, () => true, undefined, true)).toEqual({ kind: 'resolved', path: '/worktree', source: 'daemon_override' })
    for (const cwd of [undefined, 'relative', '/missing']) {
      expect(resolveSpawnCwd('p', '/repo', cwd, { p: '/repo' }, p => p === '/repo', undefined, true).kind).toBe('refused')
    }
  })
})


test('wire capability is exact, provider-specific, and restricted to local implemented adapters', () => {
  expect(buildScheduledDutyAdvertisement([{ key: 'codex' }, { key: 'qwen' }, { key: 'sh' }])).toEqual({ version: 1, providers: { codex: 1 } })
  expect(buildScheduledDutyAdvertisement([])).toEqual({ version: 1, providers: {} })
  expect(buildScheduledDutyAdvertisement([{ key: 'claude' }, { key: 'codex' }])).toEqual({ version: 1, providers: { claude: 1, codex: 1 } })
})


test('unknown launch revision and provider cannot use the scheduled adapter', () => {
  for (const candidate of [{ version: 2, providerRevision: 1 }, { version: 1, providerRevision: 2 }, null]) {
    expect(() => __test_effectiveSpawnArgsForPrompts('codex', undefined, context, 'test', candidate as never)).toThrow()
  }
  expect(() => __test_effectiveSpawnArgsForPrompts('qwen', undefined, context, 'test', contract)).toThrow()
})
