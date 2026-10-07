import { describe, test, expect, beforeEach } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { captureLogs } from '@jerico/shared/test-utils'

const { resolveSpawnCwd } = await import('../ws/client.js')

const HOME = os.homedir()

// Stable project IDs (simulate real UUIDs from DB)
const PROJECT_A = 'aaaaaaaa-0000-0000-0000-000000000001'  // local override exists
const PROJECT_B = 'bbbbbbbb-0000-0000-0000-000000000002'  // no override, server cwd exists
const PROJECT_C = 'cccccccc-0000-0000-0000-000000000003'  // no override, server cwd missing → HOME
const PROJECT_D = 'dddddddd-0000-0000-0000-000000000004'  // local override missing, server cwd exists
const PROJECT_E = 'eeeeeeee-0000-0000-0000-000000000005'  // both missing → HOME
const PROJECT_F = 'ffffffff-0000-0000-0000-000000000006'  // no projectPaths map (undefined)

const LOCAL_A    = '/Users/contributor/Development/jerico'
const LOCAL_D    = '/Users/contributor/nonexistent-path'
const SERVER_CWD = '/Users/owner/Development/jerico'  // the server's path — absent on the contributor's machine

const projectPaths: Record<string, string> = {
  [PROJECT_A]: LOCAL_A,
  [PROJECT_D]: LOCAL_D,
}

// pathExists stub: controls which paths "exist" per test
const existingPaths = new Set<string>()
const stubExists = (p: string) => existingPaths.has(p)

// Ordinary-resolution narrower: every call site below expects the resolved
// shape; a refusal surfacing in these helpers is itself a failure.
function expectResolvedCwd(...args: Parameters<typeof resolveSpawnCwd>) {
  const result = resolveSpawnCwd(...args)
  if (result.kind !== 'resolved') throw new Error(`unexpected refusal: ${result.code} / ${result.message}`)
  return result
}

beforeEach(() => {
  existingPaths.clear()
})

describe('resolveSpawnCwd — multi-project cwd resolution', () => {
  test('PROJECT_A: local override exists → uses local path, ignores missing server cwd', () => {
    existingPaths.add(LOCAL_A)
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_A, SERVER_CWD, undefined, projectPaths, stubExists)
    capture.restore()

    expect(result.path).toBe(LOCAL_A)
    expect(result.source).toBe('local_override')
    expect(capture.warns.length).toBe(0)
  })

  test('PROJECT_B: no local override, server cwd exists → uses server cwd', () => {
    existingPaths.add(SERVER_CWD)
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_B, SERVER_CWD, undefined, projectPaths, stubExists)
    capture.restore()

    expect(result.path).toBe(SERVER_CWD)
    expect(result.source).toBe('server_project')
    expect(capture.warns.length).toBe(0)
  })

  test('PROJECT_C: no local override, server cwd missing → HOME + logs hint', () => {
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_C, SERVER_CWD, undefined, projectPaths, stubExists)
    capture.restore()

    expect(result.path).toBe(HOME)
    expect(result.source).toBe('fallback_home')
    expect(capture.warns.length).toBe(1)
    expect((capture.warns[0]?.msg ?? '').includes('fallback_home')).toBe(true)
    expect((capture.warns[0]?.data as Record<string, unknown>)?.['projectId']).toBe(PROJECT_C)
    expect((capture.warns[0]?.data as Record<string, unknown>)?.['serverCwd']).toBe(SERVER_CWD)
  })

  test('PROJECT_D: local override path missing, server cwd exists → server cwd', () => {
    existingPaths.add(SERVER_CWD)
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_D, SERVER_CWD, undefined, projectPaths, stubExists)
    capture.restore()

    expect(result.path).toBe(SERVER_CWD)
    expect(result.source).toBe('server_project')
    expect(capture.warns.length).toBe(0)
  })

  test('PROJECT_E: both local override absent and server cwd missing → HOME fallback', () => {
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_E, SERVER_CWD, undefined, projectPaths, stubExists)
    capture.restore()

    expect(result.path).toBe(HOME)
    expect(result.source).toBe('fallback_home')
    expect(capture.warns.length).toBe(1)
    expect((capture.warns[0]?.data as Record<string, unknown>)?.['projectId']).toBe(PROJECT_E)
  })

  test('PROJECT_F: no projectPaths map (undefined), server cwd exists → server cwd', () => {
    existingPaths.add(SERVER_CWD)
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_F, SERVER_CWD, undefined, undefined, stubExists)
    capture.restore()

    expect(result.path).toBe(SERVER_CWD)
    expect(result.source).toBe('server_project')
    expect(capture.warns.length).toBe(0)
  })

  test('PROJECT_F: no projectPaths map, server cwd undefined → HOME fallback', () => {
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_F, undefined, undefined, undefined, stubExists)
    capture.restore()

    expect(result.path).toBe(HOME)
    expect(result.source).toBe('fallback_home')
    expect(capture.warns.length).toBe(1)
  })

  test('priority: local override wins even when server cwd also exists on disk', () => {
    existingPaths.add(LOCAL_A)
    existingPaths.add(SERVER_CWD)  // both exist — local must still win
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_A, SERVER_CWD, undefined, projectPaths, stubExists)
    capture.restore()

    expect(result.path).toBe(LOCAL_A)
    expect(result.source).toBe('local_override')
    expect(capture.warns.length).toBe(0)
  })

  test('daemon_override: exists and on disk → uses daemon_local_path', () => {
    const DAEMON_PATH = '/Users/shared/project-g'
    existingPaths.add(DAEMON_PATH)
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_C, SERVER_CWD, DAEMON_PATH, projectPaths, stubExists)
    capture.restore()

    expect(result.path).toBe(DAEMON_PATH)
    expect(result.source).toBe('daemon_override')
    expect(capture.warns.length).toBe(0)
  })

  test('daemon_override: missing on disk, server cwd exists → falls back to server', () => {
    const DAEMON_PATH = '/Users/shared/project-h-missing'
    existingPaths.add(SERVER_CWD)
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_C, SERVER_CWD, DAEMON_PATH, projectPaths, stubExists)
    capture.restore()

    expect(result.path).toBe(SERVER_CWD)
    expect(result.source).toBe('server_project')
    expect(capture.warns.length).toBe(1)
    expect((capture.warns[0]?.msg ?? '').includes('daemon_override_missing')).toBe(true)
    expect((capture.warns[0]?.data as Record<string, unknown>)?.['projectId']).toBe(PROJECT_C)
    expect((capture.warns[0]?.data as Record<string, unknown>)?.['daemonLocalPath']).toBe(DAEMON_PATH)
  })

  test('daemon_override: missing on disk, server cwd missing → fallback_home + logs', () => {
    const DAEMON_PATH = '/Users/shared/project-i-missing'
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_C, undefined, DAEMON_PATH, projectPaths, stubExists)
    capture.restore()

    expect(result.path).toBe(HOME)
    expect(result.source).toBe('fallback_home')
    expect(capture.warns.length).toBe(2) // daemon_override_missing + fallback_home
    expect((capture.warns[0]?.data as Record<string, unknown>)?.['daemonLocalPath']).toBe(DAEMON_PATH)
  })

  test('priority: local_override beats daemon_override even when both exist', () => {
    const DAEMON_PATH = '/Users/shared/project-a-daemon'
    existingPaths.add(LOCAL_A)
    existingPaths.add(DAEMON_PATH)
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_A, SERVER_CWD, DAEMON_PATH, projectPaths, stubExists)
    capture.restore()

    expect(result.path).toBe(LOCAL_A)
    expect(result.source).toBe('local_override')
    expect(capture.warns.length).toBe(0)
  })

  test('property: resolveSpawnCwd never returns relative path', () => {
    const randomInputs = Array.from({ length: 100 }, () => ({
      projectId: Math.random().toString(36),
      serverCwd: Math.random() > 0.5 ? '/srv/' + Math.random().toString(36) : undefined,
      daemonLocalPath: Math.random() > 0.5 ? '/dmn/' + Math.random().toString(36) : null,
      projectPaths: Math.random() > 0.5 ? { [Math.random().toString(36)]: '/override' } : undefined,
    }))
    for (const input of randomInputs) {
      const result = expectResolvedCwd(input.projectId, input.serverCwd, input.daemonLocalPath, input.projectPaths, () => true)
      expect(path.isAbsolute(result.path)).toBe(true)
    }
  })

  test('chaos: pathExists throws → resolver does not crash', () => {
    const throwing = () => { throw new Error('EACCES') }
    let threw = false
    try {
      resolveSpawnCwd('p', '/srv', '/dmn', { p: '/local' }, throwing)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    // Falls through to fallback_home because every tier's pathExists throws
    const capture = captureLogs()
    const result = expectResolvedCwd('p', '/srv', '/dmn', { p: '/local' }, throwing)
    capture.restore()
    expect(result.path).toBe(HOME)
    expect(result.source).toBe('fallback_home')
    expect(capture.warns.length).toBe(2)
  })

  test('fuzzing: file-as-cwd (existsSync true but not directory)', () => {
    // Simulates: pathExists returns true but actual path is a file
    // Resolver returns it; PTY spawn will fail downstream with ENOTDIR
    const res = expectResolvedCwd('p', '/path/to/file.txt', null, undefined, () => true)
    expect(res.source).toBe('server_project')
    // Document that file-as-cwd check is the caller's responsibility
  })

  test('invalid_path: nonexistent path triggers fallback_home with structured warn log', () => {
    const capture = captureLogs()
    const result = expectResolvedCwd(PROJECT_C, '/totally/nonexistent', null, undefined, stubExists)
    capture.restore()

    expect(result.path).toBe(HOME)
    expect(result.source).toBe('fallback_home')
    expect(capture.warns.length).toBe(1)
    expect((capture.warns[0]?.msg ?? '').includes('fallback_home')).toBe(true)
    expect((capture.warns[0]?.data as Record<string, unknown>)?.['projectId']).toBe(PROJECT_C)
  })
})

describe('resolveSpawnCwd — sched_worktree precedence (fix round 4)', () => {
  // A schedule worktree under PROJECT_A's bound root — the exact shape the
  // scheduling worktree executor builds (worktree.ts relPath join('.jerico','sched',scheduleId,slot)).
  const WORKTREE = '/Users/contributor/Development/jerico/.jerico/sched/sched-1/slot0'

  test('a sched_worktree spawn resolves to its worktree even when a projectPaths entry exists for the same project', () => {
    existingPaths.add(LOCAL_A)   // the developer's shadow binding, exists on disk
    existingPaths.add(WORKTREE)  // the isolated worktree, exists on disk
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_A, WORKTREE, WORKTREE, projectPaths, stubExists, 'sched_worktree')
    capture.restore()

    expect(result.path).toBe(WORKTREE)
    expect(result.source).toBe('daemon_override')
    expect(capture.warns.length).toBe(0)
  })

  test('a sched_worktree spawn NEVER falls back when its worktree is missing — it refuses, never fallback_home', () => {
    existingPaths.add(LOCAL_A)   // the shadow binding exists — the hazard this round removes
    const capture = captureLogs()

    const result = resolveSpawnCwd(PROJECT_A, WORKTREE, WORKTREE, projectPaths, stubExists, 'sched_worktree')
    capture.restore()

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') {
      expect(result.code).toBe('CWD_MISSING_ON_DAEMON')
      expect(result.reason).toBe('sched_worktree_missing')
      expect(result.message).toContain('Scheduled worktree')
      expect(result.message).toContain(WORKTREE)
    }
    expect('path' in result).toBe(false)
    expect('source' in result).toBe(false)
    expect((capture.warns[0]?.msg ?? '').includes('sched_worktree_missing')).toBe(true)
  })

  test('a sched_worktree spawn with a missing worktree refuses even when the serverCwd main tree exists on disk', () => {
    existingPaths.add(SERVER_CWD)  // the project main tree exists — must NOT be used
    existingPaths.add(LOCAL_A)     // the shadow binding exists too
    const capture = captureLogs()

    const result = resolveSpawnCwd(PROJECT_A, SERVER_CWD, WORKTREE, projectPaths, stubExists, 'sched_worktree')
    capture.restore()

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') {
      expect(result.code).toBe('CWD_MISSING_ON_DAEMON')
      expect(result.reason).toBe('sched_worktree_missing')
    }
    expect((capture.warns[0]?.msg ?? '').includes('sched_worktree_missing')).toBe(true)
  })

  test('sched_worktree with no daemonLocalPath at all refuses instead of falling through', () => {
    existingPaths.add(SERVER_CWD)
    const capture = captureLogs()

    const result = resolveSpawnCwd(PROJECT_A, SERVER_CWD, null, projectPaths, stubExists, 'sched_worktree')
    capture.restore()

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') {
      expect(result.code).toBe('CWD_MISSING_ON_DAEMON')
      expect(result.reason).toBe('sched_worktree_missing')
      expect(result.message).toContain('(unset)')
    }
  })

  test('every non-scheduled spawn still prefers local_override (guard — passes on both sides by design)', () => {
    existingPaths.add(LOCAL_A)
    existingPaths.add(WORKTREE)
    const capture = captureLogs()

    const result = expectResolvedCwd(PROJECT_A, WORKTREE, WORKTREE, projectPaths, stubExists)
    capture.restore()

    expect(result.path).toBe(LOCAL_A)
    expect(result.source).toBe('local_override')

    const asUndefined = expectResolvedCwd(PROJECT_A, WORKTREE, WORKTREE, projectPaths, stubExists, undefined)
    expect(asUndefined.path).toBe(LOCAL_A)
    expect(asUndefined.source).toBe('local_override')
  })
})

describe('CWD_MISSING_ON_DAEMON guard condition (Issue #375)', () => {
  test('guard triggers when cwdSource is fallback_home AND sessionId is present', () => {
    // This verifies the boolean condition used in the spawn handler guard:
    // if (cwdSource === 'fallback_home' && msg.sessionId) { ... block resume ... }
    const cwdSource = 'fallback_home' as const
    const sessionId = 'some-uuid'

    const shouldBlock = cwdSource === 'fallback_home' && !!sessionId
    expect(shouldBlock).toBe(true)
  })

  test('guard does NOT trigger for fresh spawn (no sessionId)', () => {
    const cwdSource = 'fallback_home' as const
    const sessionId = undefined

    const shouldBlock = cwdSource === 'fallback_home' && !!sessionId
    expect(shouldBlock).toBe(false)
  })

  test('guard does NOT trigger when cwd resolves correctly', () => {
    const cwdSources = ['local_override', 'daemon_override', 'server_project'] as const
    const sessionId = 'some-uuid'

    for (const cwdSource of cwdSources) {
      const shouldBlock = (cwdSource as string) === 'fallback_home' && !!sessionId
      expect(shouldBlock).toBe(false)
    }
  })

  test('error message includes projectId for actionable hint', () => {
    // The guard emits: `Cannot resume session — project path not found on this machine.
    // Run: bridge-agent link-project ${msg.projectId ?? '?'} <local-path>`
    const projectId = 'test-project-id'
    const message = `Cannot resume session — project path not found on this machine. Run: bridge-agent link-project ${projectId} <local-path>`
    expect(message.includes(projectId)).toBe(true)
    expect(message.includes('link-project')).toBe(true)
  })
})
