import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { PtyManager } from '../pty/manager.js'

const names = ['CLAUDE_CODE_OAUTH_TOKEN', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']

function spawnedEnvironmentNames(agentKey: string): string[] {
  const manager = new PtyManager()
  const agentId = `env-probe-${randomUUID()}`
  const started = manager.spawn(agentId, agentKey, '/usr/bin/true', [], 80, 24,
    () => {}, () => {}, undefined, randomUUID())
  expect(started).toBe(true)
  // spawnEnv is cloned from the exact env object passed to pty.spawn above.
  const env = manager.getPanelSpawnEnvironment(agentId)
  expect(env).toBeDefined()
  return names.filter(name => Object.hasOwn(env!, name)).sort()
}

test('managed PTY spawn passes Claude startup names only to Claude with whitelist enabled', () => {
  const saved = Object.fromEntries([...names, 'BRIDGE_ENV_WHITELIST'].map(name => [name, process.env[name]]))
  try {
    process.env.BRIDGE_ENV_WHITELIST = '1'
    for (const name of names) process.env[name] = 'fixture'
    expect(spawnedEnvironmentNames('claude')).toEqual([...names].sort())
    expect(spawnedEnvironmentNames('codex')).toEqual([])
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
