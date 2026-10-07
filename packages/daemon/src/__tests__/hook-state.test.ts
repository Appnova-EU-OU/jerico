import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getHookConfig } from '../hooks/state.js'
import { spliceBlock } from '../hooks/block.js'

describe('Hook State', () => {
  let tempDir: string
  let originalEnv: string | undefined
  // agy reads a real user config now, so point it at the temp dir instead of
  // letting this suite depend on whether ~/.gemini/config/hooks.json exists.
  let originalAgyEnv: string | undefined

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'jerico-hook-state-test-'))
    originalEnv = process.env.JERICO_CLAUDE_SETTINGS_PATH
    process.env.JERICO_CLAUDE_SETTINGS_PATH = path.join(tempDir, 'settings.json')
    originalAgyEnv = process.env.JERICO_AGY_HOOKS_PATH
    process.env.JERICO_AGY_HOOKS_PATH = path.join(tempDir, 'agy-hooks.json')
  })

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.JERICO_CLAUDE_SETTINGS_PATH
    } else {
      process.env.JERICO_CLAUDE_SETTINGS_PATH = originalEnv
    }
    if (originalAgyEnv === undefined) {
      delete process.env.JERICO_AGY_HOOKS_PATH
    } else {
      process.env.JERICO_AGY_HOOKS_PATH = originalAgyEnv
    }
    await fsPromises.rm(tempDir, { recursive: true, force: true })
  })

  it('config is derived, not remembered', async () => {
    const targetPath = process.env.JERICO_CLAUDE_SETTINGS_PATH!
    
    // Install into temp config
    const initialConfig = JSON.stringify({ hooks: { Stop: [] } })
    const { content: spliced } = spliceBlock('claude', initialConfig)
    await fsPromises.writeFile(targetPath, spliced, 'utf-8')

    // Read the state -> present
    expect(getHookConfig('claude')).toBe('present_ok')

    // Delete our block behind the state module's back
    await fsPromises.writeFile(targetPath, initialConfig, 'utf-8')

    // Read again -> absent
    expect(getHookConfig('claude')).toBe('absent')
  })

  it('never unsupported for claude', async () => {
    // No config file at all
    const state = getHookConfig('claude')
    expect(state).toBe('absent')
    expect(state).not.toBe('unsupported' as any)
  })

  it('each unsupported target reports its own reason', () => {
    const reasons = new Set([
      getHookConfig('gemini'),
      getHookConfig('qwen'),
      getHookConfig('agy'),
      getHookConfig('random_unknown_agent')
    ])
    expect(reasons.size).toBe(4)
    
    for (const reason of reasons) {
      expect(reason).not.toBe('present_ok')
      expect(reason).not.toBe('configured' as any)
    }

    expect(getHookConfig('gemini')).toBe('unsupported_not_a_jerico_agent')
    expect(getHookConfig('qwen')).toBe('unsupported_runtime_unverified')
    // agy is a real hook target now (R50): it reads its own hooks.json rather
    // than reporting a contract it does not have. See hook-agy.test.ts.
    expect(getHookConfig('agy')).toBe('absent')
    expect(getHookConfig('random_unknown_agent')).toBe('unknown')
  })

  it('opencode is a supported cold-read target', () => {
    expect(getHookConfig('opencode')).toBe('absent')
  })

  it('malformed config is not absent', async () => {
    const targetPath = process.env.JERICO_CLAUDE_SETTINGS_PATH!
    await fsPromises.writeFile(targetPath, JSON.stringify({ hooks: { Stop: "not an array" } }), 'utf-8')
    
    expect(getHookConfig('claude')).toBe('malformed')
    expect(getHookConfig('claude')).not.toBe('absent')
  })
})
