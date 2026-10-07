import { describe, test, expect } from 'vitest'
import { checkPtyHealth, isSpawnHelperHealthy } from '../pty/spawn-helper-health'

describe('checkPtyHealth unit tests with injection', () => {
  test('missing helper yields missing preflight and spawnHelperBroken=true', () => {
    const health = checkPtyHealth({
      resolveHelperPath: () => '/path/to/missing-helper',
      existsSync: () => false,
    })

    expect(health.preflight).toBe('missing')
    expect(health.probe).toBe('skipped')
    expect(health.spawnHelperBroken).toBe(true)
    expect(isSpawnHelperHealthy({
      resolveHelperPath: () => '/path/to/missing-helper',
      existsSync: () => false,
    })).toBe(false)
  })

  test('non-executable helper yields not_executable preflight and spawnHelperBroken=true', () => {
    const health = checkPtyHealth({
      resolveHelperPath: () => '/path/to/non-exec-helper',
      existsSync: () => true,
      accessSync: () => {
        throw new Error('EACCES: permission denied')
      },
    })

    expect(health.preflight).toBe('not_executable')
    expect(health.probe).toBe('skipped')
    expect(health.spawnHelperBroken).toBe(true)
  })

  test('executable helper with successful probe yields ok probe and spawnHelperBroken=false', () => {
    const health = checkPtyHealth({
      resolveHelperPath: () => '/path/to/valid-helper',
      existsSync: () => true,
      accessSync: () => {},
      ptySpawn: () => ({ kill: () => {} }),
    })

    expect(health.preflight).toBe('executable')
    expect(health.probe).toBe('ok')
    expect(health.probeErrorCategory).toBe('none')
    expect(health.spawnHelperBroken).toBe(false)
    expect(isSpawnHelperHealthy({
      resolveHelperPath: () => '/path/to/valid-helper',
      existsSync: () => true,
      accessSync: () => {},
      ptySpawn: () => ({ kill: () => {} }),
    })).toBe(true)
  })

  test('executable helper with bare posix_spawnp failed yields spawn_failed probe and spawn_failed category', () => {
    const health = checkPtyHealth({
      resolveHelperPath: () => '/path/to/executable-helper',
      existsSync: () => true,
      accessSync: () => {},
      ptySpawn: () => {
        throw new Error('posix_spawnp failed.')
      },
    })

    expect(health.preflight).toBe('executable')
    expect(health.probe).toBe('spawn_failed')
    expect(health.probeErrorCategory).toBe('spawn_failed')
    // Helper file itself is executable, so spawnHelperBroken remains false
    expect(health.spawnHelperBroken).toBe(false)
  })

  test('executable helper with concrete EMFILE errno yields resource_limit category', () => {
    const health = checkPtyHealth({
      resolveHelperPath: () => '/path/to/executable-helper',
      existsSync: () => true,
      accessSync: () => {},
      ptySpawn: () => {
        throw Object.assign(new Error('too many open files'), { code: 'EMFILE' })
      },
    })

    expect(health.preflight).toBe('executable')
    expect(health.probe).toBe('spawn_failed')
    expect(health.probeErrorCategory).toBe('resource_limit')
    expect(health.spawnHelperBroken).toBe(false)
  })

  test('errno-like prose without a concrete code remains generic', () => {
    const health = checkPtyHealth({
      resolveHelperPath: () => '/path/to/executable-helper',
      existsSync: () => true,
      accessSync: () => {},
      ptySpawn: () => {
        throw new Error('perhaps EMFILE or a resource limit')
      },
    })

    expect(health.probe).toBe('spawn_failed')
    expect(health.probeErrorCategory).toBe('unknown')
  })

  test('not_applicable preflight (no helper shipped, e.g. Windows) probes directly', () => {
    const health = checkPtyHealth({
      resolveHelperPath: () => undefined,
      ptySpawn: () => ({ kill: () => {} }),
    })

    expect(health.preflight).toBe('not_applicable')
    expect(health.probe).toBe('ok')
    expect(health.spawnHelperBroken).toBe(false)
  })
})
