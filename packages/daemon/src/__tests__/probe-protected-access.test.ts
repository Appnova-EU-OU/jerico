import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  PROTECTED_ACCESS_CACHE_TTL_MS,
  classifyTccProtectedPath,
  createProtectedAccessProbe,
  diagnoseTccAccessBlock,
  isTccProtectedPath,
  type TccProtectedService,
} from '../probe-protected-access.js'

const HOME = '/Users/tcc-test'

function eperm(): NodeJS.ErrnoException {
  return Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
}

describe('protected access probe', () => {
  test('reduces a five-minute 3-second poll/reconnect workload to one read per TTL', () => {
    let now = 0
    let reads = 0
    const probe = createProtectedAccessProbe({
      home: HOME,
      now: () => now,
      readdirSync: () => {
        reads++
        throw eperm()
      },
    })

    for (now = 0; now < 5 * 60_000; now += 3_000) {
      expect(probe.probeDocuments().readable).toBe(false)
    }
    expect(reads).toBe(5)
  })

  test('observes a simulated mid-session grant at the 60-second TTL boundary', () => {
    let now = 0
    let granted = false
    let reads = 0
    const probe = createProtectedAccessProbe({
      home: HOME,
      now: () => now,
      readdirSync: () => {
        reads++
        if (!granted) throw eperm()
      },
    })

    expect(probe.probeDocuments().readable).toBe(false)
    granted = true
    now = PROTECTED_ACCESS_CACHE_TTL_MS - 1
    expect(probe.probeDocuments().readable).toBe(false)
    expect(reads).toBe(1)

    now = PROTECTED_ACCESS_CACHE_TTL_MS
    expect(probe.probeDocuments().readable).toBe(true)
    expect(reads).toBe(2)
  })

  test('a normal read keeps a cached denial after a mid-TTL grant', () => {
    let granted = false
    let reads = 0
    const probe = createProtectedAccessProbe({
      home: HOME,
      now: () => 20_000,
      readdirSync: () => {
        reads++
        if (!granted) throw eperm()
      },
    })

    expect(probe.probeDocuments().readable).toBe(false)
    granted = true
    expect(probe.probeDocuments().readable).toBe(false)
    expect(reads).toBe(1)
  })

  test('forceRefresh observes a grant and replaces the cached denial', () => {
    let granted = false
    let reads = 0
    const probe = createProtectedAccessProbe({
      home: HOME,
      now: () => 20_000,
      readdirSync: () => {
        reads++
        if (!granted) throw eperm()
      },
    })

    expect(probe.probeDocuments().readable).toBe(false)
    granted = true
    expect(probe.probeDocuments({ forceRefresh: true }).readable).toBe(true)
    expect(probe.probeDocuments().readable).toBe(true)
    expect(reads).toBe(2)
  })

  test('forceRefresh updates only the selected service cache', () => {
    const denied = new Set<TccProtectedService>(['documents', 'desktop'])
    const reads = new Map<string, number>()
    const probe = createProtectedAccessProbe({
      home: HOME,
      now: () => 20_000,
      readdirSync: (candidate) => {
        reads.set(candidate, (reads.get(candidate) ?? 0) + 1)
        if (candidate.endsWith('/Documents') && denied.has('documents')) throw eperm()
        if (candidate.endsWith('/Desktop') && denied.has('desktop')) throw eperm()
      },
    })

    const documents = path.join(HOME, 'Documents', 'repo')
    const desktop = path.join(HOME, 'Desktop', 'repo')
    expect(probe.probePath(documents)?.readable).toBe(false)
    expect(probe.probePath(desktop)?.readable).toBe(false)

    denied.delete('documents')
    expect(probe.probePath(documents, { forceRefresh: true })?.readable).toBe(true)
    expect(probe.probePath(desktop)?.readable).toBe(false)
    expect(reads.get(path.join(HOME, 'Documents'))).toBe(2)
    expect(reads.get(path.join(HOME, 'Desktop'))).toBe(1)
  })

  test('two forced refreshes inside one second perform one read and return the fresh value', () => {
    let now = 20_000
    let reads = 0
    const probe = createProtectedAccessProbe({
      home: HOME,
      now: () => now,
      readdirSync: () => { reads++ },
    })

    const first = probe.probeDocuments({ forceRefresh: true })
    now += 999
    const second = probe.probeDocuments({ forceRefresh: true })

    expect(first.readable).toBe(true)
    expect(second.readable).toBe(true)
    expect(reads).toBe(1)
  })

  test('a forced refresh at the one-second boundary performs a second read', () => {
    let now = 20_000
    let reads = 0
    const probe = createProtectedAccessProbe({
      home: HOME,
      now: () => now,
      readdirSync: () => { reads++ },
    })

    probe.probeDocuments({ forceRefresh: true })
    now += 1_000
    probe.probeDocuments({ forceRefresh: true })

    expect(reads).toBe(2)
  })

  test('the forced-refresh floor is independent per protected service', () => {
    let now = 20_000
    const reads = new Map<string, number>()
    const probe = createProtectedAccessProbe({
      home: HOME,
      now: () => now,
      readdirSync: (candidate) => {
        reads.set(candidate, (reads.get(candidate) ?? 0) + 1)
      },
    })

    const documents = path.join(HOME, 'Documents', 'repo')
    const desktop = path.join(HOME, 'Desktop', 'repo')
    probe.probePath(documents, { forceRefresh: true })
    now += 500
    probe.probePath(desktop, { forceRefresh: true })
    probe.probePath(documents, { forceRefresh: true })

    expect(reads.get(path.join(HOME, 'Documents'))).toBe(1)
    expect(reads.get(path.join(HOME, 'Desktop'))).toBe(1)
  })

  test('a grant during the floor is visible on the next two-second wizard poll', () => {
    let now = 20_000
    let granted = false
    let reads = 0
    const probe = createProtectedAccessProbe({
      home: HOME,
      now: () => now,
      readdirSync: () => {
        reads++
        if (!granted) throw eperm()
      },
    })

    expect(probe.probeDocuments({ forceRefresh: true }).readable).toBe(false)
    granted = true
    now += 500
    expect(probe.probeDocuments({ forceRefresh: true }).readable).toBe(false)
    expect(reads).toBe(1)

    now += 1_500
    expect(probe.probeDocuments({ forceRefresh: true }).readable).toBe(true)
    expect(reads).toBe(2)
  })

  test('the hot path reads once across repeated normal observations inside the TTL', () => {
    let reads = 0
    const probe = createProtectedAccessProbe({
      home: HOME,
      now: () => 20_000,
      readdirSync: () => { reads++ },
    })

    for (let i = 0; i < 100; i++) probe.probeDocuments()
    expect(reads).toBe(1)
  })

  test('/health defaults to the cache and exposes an explicit fresh-probe path', () => {
    const startSource = fs.readFileSync(path.join(import.meta.dir, '../commands/start.ts'), 'utf8')
    expect(startSource).toContain("healthUrl.searchParams.get('probe') === 'fresh'")
    expect(startSource).toContain('probeProtectedAccess({ forceRefresh: true })')
    expect(startSource).toContain(': probeProtectedAccess()')
    expect(startSource).toContain('documentsFolderReadable: probe.readable')
  })

  const serviceRows: Array<{ service: TccProtectedService; cwd: string; root: string }> = [
    { service: 'documents', cwd: path.join(HOME, 'Documents', 'repo'), root: path.join(HOME, 'Documents') },
    { service: 'desktop', cwd: path.join(HOME, 'Desktop', 'repo'), root: path.join(HOME, 'Desktop') },
    { service: 'downloads', cwd: path.join(HOME, 'Downloads', 'repo'), root: path.join(HOME, 'Downloads') },
    { service: 'icloud-drive', cwd: path.join(HOME, 'Library', 'Mobile Documents', 'repo'), root: path.join(HOME, 'Library', 'Mobile Documents') },
    { service: 'app-data', cwd: path.join(HOME, 'Library', 'Containers', 'com.example.app', 'Data'), root: path.join(HOME, 'Library', 'Containers') },
  ]

  test.each(serviceRows)('fault injection names and probes only the matching $service service', ({ service, cwd, root }) => {
    const reads: string[] = []
    const probe = createProtectedAccessProbe({
      home: HOME,
      readdirSync: (candidate) => {
        reads.push(candidate)
        if (candidate === root) throw eperm()
      },
    })

    const result = probe.probePath(cwd)
    expect(result).toEqual({ readable: false, probedPath: root, service })
    expect(reads).toEqual([root])
  })

  test('issue #43 double-gate still receives a denial for a Documents-path agent', () => {
    const documents = path.join(HOME, 'Documents')
    const probe = createProtectedAccessProbe({
      home: HOME,
      readdirSync: (candidate) => {
        if (candidate === documents) throw eperm()
      },
    })

    const diagnosis = diagnoseTccAccessBlock(true, path.join(documents, 'blocked-project'), probe)
    expect(diagnosis?.service).toBe('documents')
    expect(diagnosis?.readable).toBe(false)
    expect(diagnoseTccAccessBlock(false, path.join(documents, 'blocked-project'), probe)).toBeNull()
  })
})

describe('TCC protected path boundaries', () => {
  test.each([
    [path.join(HOME, 'Documents', 'repo'), true, 'documents'],
    [path.join(HOME, 'Documents-old', 'repo'), false, null],
    [path.join(HOME, 'Library', 'Mobile Documents', 'repo'), true, 'icloud-drive'],
    [path.join(HOME, 'Library', 'Mobile DocumentsBackup', 'repo'), false, null],
    [path.join(HOME, 'Library', 'Containers', 'com.example.app'), true, 'app-data'],
    [path.join(HOME, 'Library', 'Containers-old', 'x'), false, null],
  ] as const)('%s', (cwd, expected, service) => {
    expect(isTccProtectedPath(cwd, HOME)).toBe(expected)
    expect(classifyTccProtectedPath(cwd, HOME)?.service ?? null).toBe(service)
  })
})
