import { describe, it, expect } from 'bun:test'
import { ALL_AGENT_KEYS, HOOK_CAPABLE_AGENT_KEYS } from '@jerico/shared'
import { getHookConfig } from '../hooks/state.js'

/**
 * `getHookConfig` used to answer `'unknown'` for every agent that was not a hook
 * target — six real keys — so "a shell has nothing to configure" and "I have
 * never heard of this agent" arrived at every reader under one word. These
 * tests pin the distinction, because it is the whole point of the change.
 */
describe('hook surface classification', () => {
  it('every agent key gets a definite answer, and none of them is "unknown"', () => {
    // The load-bearing sweep: a key that falls through to 'unknown' is a key
    // nobody classified, and this is what catches it.
    const unclassified = ALL_AGENT_KEYS.filter(k => getHookConfig(k) === 'unknown')
    expect(unclassified).toEqual([])
  })

  it('a key the daemon has never seen is still "unknown"', () => {
    // The honest unknown has to survive. Widening the table to "anything that is
    // not a target has no surface" would turn this into a confident lie.
    expect(getHookConfig('random_unknown_agent')).toBe('unknown')
    expect(getHookConfig('')).toBe('unknown')
    expect(getHookConfig('claudee')).toBe('unknown')
  })

  it('a shell reports no hook surface, not an unknown one', () => {
    expect(getHookConfig('sh')).toBe('unsupported_no_config_hook_surface')
  })

  it('sim_ios reports no hook surface — it has no pty agent spec at all', () => {
    expect(getHookConfig('sim_ios')).toBe('unsupported_no_config_hook_surface')
  })

  it('ollama reports no hook surface', () => {
    expect(getHookConfig('ollama')).toBe('unsupported_no_config_hook_surface')
  })

  it('aider reports a DIFFERENT contract, not an absent surface', () => {
    // --auto-test / --test-cmd / --auto-lint are a config-driven post-turn
    // action. Calling that "no surface" was the round-1 error.
    expect(getHookConfig('aider')).toBe('unsupported_different_contract')
  })

  it('agents with a real but unverified surface are not called surfaceless', () => {
    // qwen has a first-class hooks subsystem; forge and copilot have event and
    // plugin surfaces. What is unverified is whether they can carry Jerico's
    // turn-end contract — a different claim from "there is nothing here".
    for (const key of ['qwen', 'forge', 'copilot']) {
      expect(getHookConfig(key)).toBe('unsupported_runtime_unverified')
    }
  })

  it('gemini keeps its named diagnostic even though it is not an agent key', () => {
    expect(ALL_AGENT_KEYS as readonly string[]).not.toContain('gemini')
    expect(getHookConfig('gemini')).toBe('unsupported_not_a_jerico_agent')
  })

  it('hook targets are never given a table answer — they are probed', () => {
    // A target's state depends on the filesystem, so the only safe assertion is
    // that it is one of the probe outcomes and never one of the table's words.
    const TABLE_WORDS = [
      'unsupported_no_config_hook_surface',
      'unsupported_runtime_unverified',
      'unsupported_different_contract',
    ]
    for (const key of HOOK_CAPABLE_AGENT_KEYS) {
      expect(TABLE_WORDS).not.toContain(getHookConfig(key))
    }
  })

  it('no agent key is classified as not-a-jerico-agent', () => {
    // That word means "this key does not belong to this product". Applying it to
    // a member of AgentKey would be self-contradictory.
    for (const key of ALL_AGENT_KEYS) {
      expect(getHookConfig(key)).not.toBe('unsupported_not_a_jerico_agent')
    }
  })
})
