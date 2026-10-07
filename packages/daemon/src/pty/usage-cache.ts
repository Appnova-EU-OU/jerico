import { promises as fsp, type Stats } from 'node:fs'

/**
 * Multi-key cache that stores computed values keyed by (mtime, size).
 * Unchanged files return cached results instantly — no re-read, no parse.
 *
 * Thread-safe: no. Single-threaded daemon, no concurrent tickers.
 */
class UsageCache<K extends string> {
  private cache = new Map<K, { mtimeMs: number; size: number; value: any }>()

  get(key: K, stat: { mtimeMs: number; size: number }): any | undefined {
    const entry = this.cache.get(key)
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
      return entry.value
    }
    return undefined
  }

  set(key: K, stat: { mtimeMs: number; size: number }, value: any): void {
    this.cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, value })
  }

  invalidate(key: K): void {
    this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  /**
   * Prune entries whose keys are not in `keepKeys`. Call after a full scan.
   * NOTE: prefers prunePrefix for multi-scanner safety — see below.
   */
  prune(keepKeys: Set<K>): void {
    for (const key of this.cache.keys()) {
      if (!keepKeys.has(key)) this.cache.delete(key)
    }
  }

  /**
   * Prune only entries whose keys start with `keyPrefix` and are not in `keepKeys`.
   * USE THIS when multiple scanners share one UsageCache (e.g. fileUsageCache).
   * Ensures scanner A's tick does not evict scanner B's cached entries.
   */
  prunePrefix(keyPrefix: string, keepKeys: Set<K>): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(keyPrefix) && !keepKeys.has(key)) {
        this.cache.delete(key)
      }
    }
  }

  get size(): number {
    return this.cache.size
  }
}

/** File-level cache: path → (mtime, size) → parsed result */
export const fileUsageCache = new UsageCache<string>()

/** Directory scan cache: dir path → (mtime of dir listing) → file list */
export const dirListCache = new UsageCache<string>()

/**
 * Async stat helper. Returns { mtimeMs, size } or null if file doesn't exist.
 * Intentionally uses fs.promises to yield the event loop.
 */
export async function safeStat(filePath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s: Stats = await fsp.stat(filePath)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

/**
 * Async read of a file from a byte offset (incremental), returned as the RAW
 * bytes. The claude-usage sampler needs the Buffer (not a decoded string) so
 * its byte-offset bookkeeping stays exact even when the chunk boundary splits
 * a multi-byte UTF-8 character (a decoded string would bake in U+FFFD and
 * drift the offset by up to 2 bytes per occurrence).
 */
export async function readFileChunkBuffer(
  filePath: string,
  startByte: number,
): Promise<Buffer> {
  const fd = await fsp.open(filePath, 'r')
  try {
    const stat = await fd.stat()
    const size = stat.size - startByte
    if (size <= 0) return Buffer.alloc(0)
    const buf = Buffer.alloc(size)
    await fd.read(buf, 0, size, startByte)
    return buf
  } finally {
    await fd.close()
  }
}

/**
 * Async read of a file, optionally from a byte offset (incremental).
 * Yields to the event loop via fs.promises.
 */
export async function readFileChunk(
  filePath: string,
  startByte: number,
): Promise<string> {
  const buf = await readFileChunkBuffer(filePath, startByte)
  return buf.toString('utf-8')
}

/**
 * Yield a tick to the event loop.
 * Call between batches of work to keep the loop responsive.
 */
export function yieldTick(): Promise<void> {
  return new Promise(r => setImmediate(r))
}
