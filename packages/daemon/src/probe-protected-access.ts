import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const PROTECTED_ACCESS_CACHE_TTL_MS = 60_000
export const FORCED_REFRESH_COALESCE_MS = 1_000

export type TccProtectedService =
  | 'documents'
  | 'desktop'
  | 'downloads'
  | 'icloud-drive'
  | 'app-data'

export interface ProbeResult {
  readable: boolean
  probedPath: string
  service: TccProtectedService
}

export interface TccPathClassification {
  service: TccProtectedService
  root: string
}

interface ProbeOptions {
  home?: string
  now?: () => number
  readdirSync?: (candidate: string) => unknown
  ttlMs?: number
}

export interface ProbeReadOptions {
  forceRefresh?: boolean
}

export interface ProtectedAccessProbe {
  probeDocuments(options?: ProbeReadOptions): ProbeResult
  probePath(cwd: string, options?: ProbeReadOptions): ProbeResult | null
  clear(): void
}

function protectedRoots(home: string): TccPathClassification[] {
  return [
    { service: 'documents', root: path.join(home, 'Documents') },
    { service: 'desktop', root: path.join(home, 'Desktop') },
    { service: 'downloads', root: path.join(home, 'Downloads') },
    { service: 'icloud-drive', root: path.join(home, 'Library', 'Mobile Documents') },
    { service: 'app-data', root: path.join(home, 'Library', 'Containers') },
  ]
}

function isAtOrBelow(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Return the macOS privacy service whose protected root contains `cwd`.
 * Component-aware `path.relative` checks deliberately reject lookalikes such
 * as `Documents-old` and `Containers-old`.
 */
export function classifyTccProtectedPath(cwd: string, home = os.homedir()): TccPathClassification | null {
  const normalized = path.resolve(cwd)
  for (const entry of protectedRoots(path.resolve(home))) {
    if (isAtOrBelow(normalized, entry.root)) return entry
  }
  return null
}

/** True when `cwd` lies at or below a macOS TCC-protected volume root. */
export function isTccProtectedPath(cwd: string, home = os.homedir()): boolean {
  return classifyTccProtectedPath(cwd, home) !== null
}

/**
 * Build a service-aware probe. Results are cached independently per TCC
 * service: a Documents result must never answer an App Data diagnosis.
 */
export function createProtectedAccessProbe(options: ProbeOptions = {}): ProtectedAccessProbe {
  const home = path.resolve(options.home ?? os.homedir())
  const now = options.now ?? Date.now
  const readdirSync = options.readdirSync ?? ((candidate: string) => fs.readdirSync(candidate))
  const ttlMs = options.ttlMs ?? PROTECTED_ACCESS_CACHE_TTL_MS
  const cache = new Map<TccProtectedService, { expiresAt: number; result: ProbeResult }>()
  const lastForcedRefresh = new Map<TccProtectedService, number>()

  function probe(classification: TccPathClassification, readOptions: ProbeReadOptions = {}): ProbeResult {
    const cached = cache.get(classification.service)
    const sampledAt = now()
    if (!readOptions.forceRefresh && cached && sampledAt < cached.expiresAt) return cached.result
    const lastForcedAt = lastForcedRefresh.get(classification.service)
    if (
      readOptions.forceRefresh
      && cached
      && lastForcedAt !== undefined
      && sampledAt - lastForcedAt < FORCED_REFRESH_COALESCE_MS
    ) {
      return cached.result
    }

    let readable = true
    try {
      readdirSync(classification.root)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'EPERM') readable = false
    }

    const result: ProbeResult = {
      readable,
      probedPath: classification.root,
      service: classification.service,
    }
    cache.set(classification.service, { expiresAt: sampledAt + ttlMs, result })
    if (readOptions.forceRefresh) lastForcedRefresh.set(classification.service, sampledAt)
    return result
  }

  return {
    probeDocuments(readOptions?: ProbeReadOptions): ProbeResult {
      return probe({ service: 'documents', root: path.join(home, 'Documents') }, readOptions)
    },
    probePath(cwd: string, readOptions?: ProbeReadOptions): ProbeResult | null {
      const classification = classifyTccProtectedPath(cwd, home)
      return classification ? probe(classification, readOptions) : null
    },
    clear(): void {
      cache.clear()
      lastForcedRefresh.clear()
    },
  }
}

const protectedAccessProbe = createProtectedAccessProbe()

/** Cached Documents-folder observation used by ready and local /health. */
export function probeProtectedAccess(readOptions?: ProbeReadOptions): ProbeResult {
  return protectedAccessProbe.probeDocuments(readOptions)
}

/**
 * The second half of issue #43's double-gate. The caller establishes that the
 * early exit resembles TCC; this function requires a denial from the one
 * service protecting that cwd before the UI is notified.
 */
export function diagnoseTccAccessBlock(
  isTccCandidate: boolean,
  cwd: string | undefined,
  probe: ProtectedAccessProbe = protectedAccessProbe,
): ProbeResult | null {
  if (!isTccCandidate || !cwd) return null
  const result = probe.probePath(cwd)
  return result?.readable === false ? result : null
}
