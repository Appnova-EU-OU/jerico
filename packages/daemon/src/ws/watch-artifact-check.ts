import fs from 'node:fs'
import path from 'node:path'

const MAX_TAIL_BYTES = 64 * 1024
export const MAX_CHANGED_ENTRY_RESULTS = 5
export const MAX_CHANGED_ENTRIES_SCANNED = 256
export const MAX_CHANGED_ENTRY_DEPTH = 2

export interface WatchArtifactCheckInput {
  cwd: string
  path: string
  taskSuffix?: string
  // Issue #84: a duration ("artifact must be no older than this many ms"),
  // not a server epoch — comparing a server Date.now() against this host's
  // filesystem mtime was a genuine cross-machine clock-skew bug. Evaluated
  // entirely with this host's own clocks (Date.now() and fs.statSync both
  // read here), so skew between hosts cannot affect the result.
  notBeforeAgeMs?: number
}

export interface WatchArtifactCheckResult {
  verified: boolean
  sentinel?: string
  error?: 'invalid_cwd' | 'path_denied' | 'not_found' | 'stale' | 'settling' | 'read_failed'
}

export interface RecentProjectChanges {
  changedEntries: Array<{ path: string; ageMs: number }>
  changedEntryCount: number
  changedEntryScanTruncated: boolean
}

interface ArtifactIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

interface ArtifactObservation {
  result: WatchArtifactCheckResult
  identity?: ArtifactIdentity
}

const DEFAULT_STABILITY_INTERVAL_MS = 250
const REQUIRED_STABLE_CONFIRMATIONS = 2

function scanSentinelLine(line: string, taskSuffix?: string): string | null {
  const trimmed = line.trim()
  const stripped = trimmed.replace(/^[^A-Za-z0-9_]+/, '')
  if (!stripped) return null

  if (taskSuffix) {
    for (const sentinel of [`${taskSuffix}_DONE`, `JERICO_DONE_${taskSuffix}`]) {
      const after = stripped.slice(sentinel.length)
      if (stripped.startsWith(sentinel) && (after === '' || !/^[A-Za-z0-9_]/.test(after))) {
        return sentinel
      }
    }
    return null
  }

  if (!stripped.includes('verdict=')) return null
  return /^JERICO_DONE_[A-Za-z0-9_]+\b/.exec(stripped)?.[0]
    ?? /^[A-Z0-9_-]{3,}_DONE\b/.exec(stripped)?.[0]
    ?? null
}

function readTail(filePath: string): string {
  const size = fs.statSync(filePath).size
  const start = Math.max(0, size - MAX_TAIL_BYTES)
  const length = size - start
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, start)
    let tail = buffer.toString('utf8')
    if (start > 0) {
      const firstNewline = tail.indexOf('\n')
      tail = firstNewline === -1 ? '' : tail.slice(firstNewline + 1)
    }
    return tail
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Verify a completion sentinel on the daemon host without returning artifact
 * contents to the server. Both the configured cwd and the target are
 * realpath-jailed so a symlink created after watcher registration cannot
 * escape the project directory.
 */
function sameIdentity(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

function identityOf(stat: fs.Stats): ArtifactIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
}

function isContained(root: string, candidate: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return candidate === root || candidate.startsWith(prefix)
}

/**
 * Return a bounded, names-only view of entries changed since dispatch. The
 * walk never follows symlinks, never leaves the real project cwd, stops after
 * a fixed number of lstat calls, and descends only two directory levels.
 */
export function listRecentProjectChanges(cwd: string, changedSinceAgeMs: number): RecentProjectChanges | undefined {
  if (!cwd || !path.isAbsolute(cwd) || !Number.isFinite(changedSinceAgeMs) || changedSinceAgeMs < 0) return undefined

  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return undefined
    const root = fs.realpathSync(cwd)
    const pendingDirectories: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }]
    const changed: Array<{ path: string; ageMs: number }> = []
    let scanned = 0
    let truncated = false

    while (pendingDirectories.length > 0 && scanned < MAX_CHANGED_ENTRIES_SCANNED) {
      const current = pendingDirectories.shift()!
      let directory: fs.Dir
      try {
        directory = fs.opendirSync(current.directory)
      } catch {
        truncated = true
        continue
      }
      try {
        let entry: fs.Dirent | null
        while ((entry = directory.readSync()) !== null) {
          if (scanned >= MAX_CHANGED_ENTRIES_SCANNED) {
            truncated = true
            break
          }
          scanned++

          const candidate = path.join(current.directory, entry.name)
          const relative = path.relative(root, candidate)
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue

          let stat: fs.Stats
          try {
            stat = fs.lstatSync(candidate)
          } catch {
            continue
          }

          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            if (current.depth >= MAX_CHANGED_ENTRY_DEPTH) {
              truncated = true
              continue
            }
            try {
              const realDirectory = fs.realpathSync(candidate)
              if (isContained(root, realDirectory)) {
                pendingDirectories.push({ directory: realDirectory, depth: current.depth + 1 })
              }
            } catch {
              // A disappearing or unreadable directory consumes its bounded
              // scan slot but contributes no potentially misleading name.
            }
            continue
          }

          const ageMs = Math.max(0, Date.now() - stat.mtimeMs)
          if (ageMs <= changedSinceAgeMs) changed.push({ path: relative, ageMs })
        }
      } finally {
        directory.closeSync()
      }
    }

    if (pendingDirectories.length > 0) truncated = true
    changed.sort((a, b) => a.ageMs - b.ageMs || a.path.localeCompare(b.path))
    return {
      changedEntries: changed.slice(0, MAX_CHANGED_ENTRY_RESULTS),
      changedEntryCount: changed.length,
      changedEntryScanTruncated: truncated,
    }
  } catch {
    return undefined
  }
}

function observeWatchArtifact(input: WatchArtifactCheckInput): ArtifactObservation {
  try {
    if (!input.cwd || !path.isAbsolute(input.cwd) || !fs.existsSync(input.cwd) || !fs.statSync(input.cwd).isDirectory()) {
      return { result: { verified: false, error: 'invalid_cwd' } }
    }
    if (!input.path || path.isAbsolute(input.path)) {
      return { result: { verified: false, error: 'path_denied' } }
    }

    const root = fs.realpathSync(input.cwd)
    const target = path.resolve(root, input.path)
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    if (target !== root && !target.startsWith(prefix)) {
      return { result: { verified: false, error: 'path_denied' } }
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return { result: { verified: false, error: 'not_found' } }
    }

    const realTarget = fs.realpathSync(target)
    if (realTarget !== root && !realTarget.startsWith(prefix)) {
      return { result: { verified: false, error: 'path_denied' } }
    }
    const before = identityOf(fs.statSync(realTarget))
    const notBeforeAgeMs = input.notBeforeAgeMs
    if (typeof notBeforeAgeMs === 'number' && Number.isFinite(notBeforeAgeMs) && notBeforeAgeMs >= 0) {
      const ageMs = Date.now() - before.mtimeMs
      if (ageMs > notBeforeAgeMs) {
        return { result: { verified: false, error: 'stale' }, identity: before }
      }
    }

    // Completion markers are a final-line contract. Accepting a marker anywhere
    // in the tail lets a slow writer look complete during the quiet gap between
    // appends, even when metadata is unchanged for the full stability interval.
    const lines = readTail(realTarget).split(/\r?\n/).filter((line) => line.trim())
    const lastNonEmptyLine = lines.at(-1)
    const sentinel = lastNonEmptyLine ? scanSentinelLine(lastNonEmptyLine, input.taskSuffix) : null
    const after = identityOf(fs.statSync(realTarget))
    if (!sameIdentity(before, after)) {
      return { result: { verified: false, error: 'settling' }, identity: after }
    }
    return {
      result: sentinel ? { verified: true, sentinel } : { verified: false },
      identity: after,
    }
  } catch {
    return { result: { verified: false, error: 'read_failed' } }
  }
}

export function checkWatchArtifact(input: WatchArtifactCheckInput): WatchArtifactCheckResult {
  return observeWatchArtifact(input).result
}

/**
 * Confirm the final-line marker by re-statting and re-reading the same file
 * after two consecutive short intervals. `(dev, ino)` catches same-path atomic
 * replacement even when size/mtime are preserved; size/mtime catch ordinary
 * in-place growth. The final-line rule is the primary slow-writer guard; the
 * confirmations protect marker-last files that are still rewritten in place.
 */
export async function checkWatchArtifactStable(
  input: WatchArtifactCheckInput,
  stabilityIntervalMs = DEFAULT_STABILITY_INTERVAL_MS,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<WatchArtifactCheckResult> {
  const first = observeWatchArtifact(input)
  if (!first.result.verified || !first.identity) return first.result

  let previousIdentity = first.identity
  let confirmed = first
  for (let observation = 0; observation < REQUIRED_STABLE_CONFIRMATIONS; observation++) {
    await wait(Math.max(0, stabilityIntervalMs))
    confirmed = observeWatchArtifact(input)
    if (!confirmed.result.verified || !confirmed.identity) return confirmed.result
    if (!sameIdentity(previousIdentity, confirmed.identity)) {
      return { verified: false, error: 'settling' }
    }
    previousIdentity = confirmed.identity
  }
  return confirmed.result
}
