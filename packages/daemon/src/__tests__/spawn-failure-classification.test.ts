import { describe, test, expect } from 'bun:test'
import { classifySpawnFailure } from '../pty/spawn-helper-health.js'

const executable = () => true
const notExecutable = () => false

describe('classifySpawnFailure', () => {
  test('an exhausted machine is NOT reported as a broken helper', () => {
    // The field case this exists for: the daemon had loaded a perfectly good signed
    // helper and four agents had just spawned successfully, yet every later spawn
    // failed. It told the user "spawn-helper is not executable. Upgrade
    // bridge-agent" — advice that could not have helped.
    expect(classifySpawnFailure('posix_spawnp failed.', executable)).toBe('exhausted')
  })

  test('a genuinely non-executable helper is reported as such', () => {
    expect(classifySpawnFailure('posix_spawnp failed.', notExecutable)).toBe('helper_broken')
  })

  test('names the cause on the FIRST failure, without needing a second agent key', () => {
    // The old detector required two DIFFERENT agentKeys to fail within 30s, so a
    // user retrying one orchestrator never learned anything.
    expect(classifySpawnFailure('posix_spawnp failed.', notExecutable)).toBe('helper_broken')
    expect(classifySpawnFailure('posix_spawnp failed.', notExecutable)).toBe('helper_broken')
  })

  test('unrelated spawn errors are left alone', () => {
    expect(classifySpawnFailure('Error: cwd does not exist', executable)).toBe('other')
    expect(classifySpawnFailure('ENOENT: no such file or directory', notExecutable)).toBe('other')
  })

  test('a missing error string is not a diagnosis', () => {
    expect(classifySpawnFailure(undefined, notExecutable)).toBe('other')
    expect(classifySpawnFailure(null, notExecutable)).toBe('other')
    expect(classifySpawnFailure('', notExecutable)).toBe('other')
  })
})
