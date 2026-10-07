import { promises as fsp } from 'fs'
import path from 'path'
import os from 'os'
import { fileUsageCache, safeStat, yieldTick } from './usage-cache.js'

const WINDOW_MS = 5 * 60 * 60 * 1000 // 5 hours in ms

export interface KimiUsageInfo {
  contextPct:      number
  contextTokens:   number
  maxContextTokens: number
  tokensSpent5h:   number
}

interface KimiStatus {
  context_usage: number
  context_tokens: number
  max_context_tokens: number
  token_usage: Record<string, number>
}

/** Per-event data stored in cache to support re-filtering against advancing window cutoff. */
interface KimiFileEvent {
  epoch: number
  tokens: number
}

interface KimiFileCache {
  events: Array<KimiFileEvent>
  latestStatus: KimiStatus | null
  latestTs: number
}

const KEY_PREFIX = 'kimi:'

async function scanKimiUsage(): Promise<KimiUsageInfo> {
  const base = path.join(os.homedir(), '.kimi', 'sessions')
  let tokensSpent5h = 0

  const now = Date.now()
  const cutoff = now - WINDOW_MS

  let latestStatus: KimiStatus | null = null
  let latestTs = 0
  const seenKeys = new Set<string>()

  try {
    const sessionDirs = await fsp.readdir(base, { withFileTypes: true })
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue

      const sessionPath = path.join(base, sessionDir.name)
      let uuidDirs: string[]
      try {
        const entries = await fsp.readdir(sessionPath, { withFileTypes: true })
        uuidDirs = entries.filter(d => d.isDirectory()).map(d => d.name)
      } catch { continue }

      for (const uuidDir of uuidDirs) {
        const wirePath = path.join(sessionPath, uuidDir, 'wire.jsonl')
        const stat = await safeStat(wirePath)
        if (!stat) continue

        // Yield between directories to keep event loop responsive
        await yieldTick()

        const cacheKey = KEY_PREFIX + wirePath
        seenKeys.add(cacheKey)

        const cached = fileUsageCache.get(cacheKey, stat) as KimiFileCache | undefined
        if (cached !== undefined) {
          // Re-filter cached events against current window cutoff.
          for (const ev of cached.events) {
            if (ev.epoch >= cutoff) {
              tokensSpent5h += ev.tokens
            }
          }
          if (cached.latestStatus && cached.latestTs > latestTs) {
            latestTs = cached.latestTs
            latestStatus = cached.latestStatus
          }
          continue
        }

        let content: string
        try {
          if (stat.size > 20 * 1024 * 1024) {
            // For large files, read last 10 MB only
            const tailSize = 10 * 1024 * 1024
            const readStart = Math.max(0, stat.size - tailSize)
            const fd = await fsp.open(wirePath, 'r')
            try {
              const buf = Buffer.alloc(stat.size - readStart)
              await fd.read(buf, 0, buf.length, readStart)
              const raw = buf.toString('utf-8')
              const firstNl = raw.indexOf('\n')
              content = firstNl >= 0 ? raw.slice(firstNl + 1) : raw
            } finally { await fd.close() }
          } else {
            content = await fsp.readFile(wirePath, 'utf-8')
          }
        } catch { continue }

        let fileSpent5h = 0
        let fileLatestStatus: KimiStatus | null = null
        let fileLatestTs = 0
        let foundTimestamped = false
        const fileEvents: Array<KimiFileEvent> = []

        const lines = content.trim().split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          const trimmed = lines[i]?.trim()
          if (!trimmed) continue
          try {
            const entry = JSON.parse(trimmed) as Record<string, unknown>
            const msg = entry['message'] as Record<string, unknown> | undefined
            if (msg?.['type'] !== 'StatusUpdate') {
              const ts = entry['timestamp']
              if (typeof ts === 'number') {
                const epochMs = ts * 1000
                if (!isNaN(epochMs) && epochMs >= cutoff) {
                  const tu = msg?.['payload'] as Record<string, unknown> | undefined
                  const tok = tu?.['token_usage'] as Record<string, number> | undefined
                  if (tok) {
                    const eventTokens = (tok['input_other'] ?? 0) + (tok['output'] ?? 0) +
                      (tok['input_cache_read'] ?? 0) + (tok['input_cache_creation'] ?? 0)
                    fileSpent5h += eventTokens
                    fileEvents.push({ epoch: epochMs, tokens: eventTokens })
                  }
                }
              }
              continue
            }

            const payload = msg?.['payload'] as Record<string, unknown> | undefined
            const tu = payload?.['token_usage'] as Record<string, number> | undefined
            if (!payload || !tu) continue

            const entryTs = entry['timestamp']
            if (typeof entryTs !== 'number') continue
            const epochMs = entryTs * 1000

            if (epochMs > fileLatestTs) {
              fileLatestTs = epochMs
              fileLatestStatus = {
                context_usage:      payload['context_usage'] as number,
                context_tokens:     payload['context_tokens'] as number,
                max_context_tokens: payload['max_context_tokens'] as number,
                token_usage:        tu,
              }
              foundTimestamped = true
            }
          } catch { continue }
        }

        // Fallback: if no timestamped StatusUpdate, take the first one from end
        if (!foundTimestamped) {
          for (let i = lines.length - 1; i >= 0; i--) {
            const trimmed = lines[i]?.trim()
            if (!trimmed) continue
            try {
              const entry = JSON.parse(trimmed) as Record<string, unknown>
              const msg = entry['message'] as Record<string, unknown> | undefined
              if (msg?.['type'] !== 'StatusUpdate') continue
              const payload = msg?.['payload'] as Record<string, unknown> | undefined
              const tu = payload?.['token_usage'] as Record<string, number> | undefined
              if (!payload || !tu || fileLatestStatus) continue
              fileLatestStatus = {
                context_usage:      payload['context_usage'] as number,
                context_tokens:     payload['context_tokens'] as number,
                max_context_tokens: payload['max_context_tokens'] as number,
                token_usage:        tu,
              }
              break
            } catch { continue }
          }
        }

        tokensSpent5h += fileSpent5h
        fileUsageCache.set(cacheKey, stat, {
          events: fileEvents,
          latestStatus: fileLatestStatus,
          latestTs: fileLatestTs,
        })

        if (fileLatestStatus && fileLatestTs > latestTs) {
          latestTs = fileLatestTs
          latestStatus = fileLatestStatus
        }
      }
    }
  } catch { /* base dir may not exist */ }

  fileUsageCache.prunePrefix(KEY_PREFIX, seenKeys)

  if (latestStatus) {
    return {
      contextPct:      Math.round((latestStatus.context_usage ?? 0) * 100),
      contextTokens:   latestStatus.context_tokens ?? 0,
      maxContextTokens: latestStatus.max_context_tokens ?? 0,
      tokensSpent5h,
    }
  }

  return { contextPct: 0, contextTokens: 0, maxContextTokens: 0, tokensSpent5h }
}

/**
 * Start a global watcher that polls Kimi's wire.jsonl files every 60s
 * for context usage and token totals.
 * All I/O is async (fs.promises) with yields between directories to keep the event loop responsive.
 * Returns a cleanup function.
 */
export function startKimiUsageWatcher(
  onUsage: (info: KimiUsageInfo) => void,
): () => void {
  let running = true

  const tick = async (): Promise<void> => {
    if (!running) return
    try {
      const info = await scanKimiUsage()
      if (running) onUsage(info)
    } catch (err) {
      console.warn('[kimi-usage] poll failed', err)
    }
  }

  // Defer first scan to avoid import-time / WS-open event loop block
  const initialTimer = setTimeout(() => { void tick() }, 2000)
  const interval = setInterval(() => { void tick() }, 60_000)

  return () => {
    running = false
    clearTimeout(initialTimer)
    clearInterval(interval)
  }
}
