import { describe, expect, test } from 'bun:test'
import { filterEnv } from '../pty/env-filter.js'

const claudeVars = {
  CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth-token',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}

describe('Claude-only PTY environment pass-through', () => {
  test('keeps the exact Claude startup variables for Claude', () => {
    const result = filterEnv(claudeVars, 'claude')
    expect(result.env).toMatchObject(claudeVars)
  })

  test('drops them for every other agent key', () => {
    for (const agentKey of ['codex', 'qwen', 'agy', 'opencode']) {
      const result = filterEnv(claudeVars, agentKey)
      expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(result.env.DISABLE_AUTOUPDATER).toBeUndefined()
      expect(result.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined()
    }
  })

  test('still drops unrelated token-shaped variables for Claude', () => {
    const result = filterEnv({ ...claudeVars, UNRELATED_TOKEN: 'must-not-pass' }, 'claude')
    expect(result.env.UNRELATED_TOKEN).toBeUndefined()
    expect(result.dropped).toContain('UNRELATED_TOKEN')
  })

  test('drops the Claude-only names unless the spawned agent is Claude', () => {
    const result = filterEnv(claudeVars)
    for (const name of Object.keys(claudeVars)) {
      expect(result.env[name]).toBeUndefined()
      expect(result.dropped).toContain(name)
    }
  })
})
