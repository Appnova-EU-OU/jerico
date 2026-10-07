import { promises as fsp } from 'fs'
import path from 'path'
import os from 'os'
import { fileUsageCache, safeStat, yieldTick } from './usage-cache.js'

const WINDOW_MS = 5 * 60 * 60 * 1000 // 5 hours in ms

/** Qwen Coding Plan limits when a plan is declared.
 *  https://www.alibabacloud.com/help/en/model-studio/coding-plan
 *  Coding Plan: 6000 requests per 5h. */
const QWEN_PLAN_LIMITS: Record<string, number> = {
  coding_plan: 6_000,
}

export interface QwenQuotaInfo {
  prompts5h: number
  limit5h:   number
  resetAt:   number   // epoch ms — when the oldest counted entry expires
  tokensSpent5h?: number
  contextPct?:    number
}

export function readQwenTier(): string {
  const configPath = path.join(os.homedir(), '.jerico', 'settings.json')
  try {
    // Keep readTier sync — it reads a tiny config file, negligible impact
    const { statSync, readFileSync } = require('fs') as typeof import('fs')
    if (!statSync(configPath, { throwIfNoEntry: false })) return 'default'
    const obj = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    const plan = obj['qwenPlan']
    if (typeof plan === 'string' && plan in QWEN_PLAN_LIMITS) return plan
  } catch { /* ignore */ }
  return 'default'
}

/** Per-event data stored in cache to support re-filtering against advancing window cutoff. */
interface QwenFileEvent {
  epoch: number
  totalTokenCount: number
  contextWindowSize?: number
}

interface QwenFileCache {
  events: Array<QwenFileEvent>
}

const KEY_PREFIX = 'qwen:'

async function countQwenUsageInWindow(): Promise<{
  prompts5h: number
  tokensSpent5h: number
  contextPct: number
  resetAt: number
}> {
  const base = path.join(os.homedir(), '.qwen', 'projects')
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  let oldestInWindow = Infinity
  let requestCount = 0
  let tokensSpent5h = 0
  let latestContextPct = 0
  let latestContextTs = 0
  const seenKeys = new Set<string>()

  try {
    const dirs = await fsp.readdir(base, { withFileTypes: true })
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue

      const chatsDir = path.join(base, dir.name, 'chats')
      let files: string[]
      try {
        const entries = await fsp.readdir(chatsDir, { withFileTypes: true })
        files = entries.filter(f => f.isFile() && f.name.endsWith('.jsonl')).map(f => f.name)
      } catch { continue }

      for (const file of files) {
        const filePath = path.join(chatsDir, file)
        const stat = await safeStat(filePath)
        if (!stat) continue

        // Yield between files to keep event loop responsive
        await yieldTick()

        const cacheKey = KEY_PREFIX + filePath
        seenKeys.add(cacheKey)

        const cached = fileUsageCache.get(cacheKey, stat) as QwenFileCache | undefined
        if (cached !== undefined) {
          // Re-filter cached events against current window cutoff.
          for (const ev of cached.events) {
            if (ev.epoch >= cutoff) {
              requestCount++
              tokensSpent5h += ev.totalTokenCount
              if (ev.epoch < oldestInWindow) oldestInWindow = ev.epoch
            }
            // Context percentage is always from the latest entry (not window-limited)
            if (ev.epoch > latestContextTs) {
              latestContextTs = ev.epoch
              if (typeof ev.contextWindowSize === 'number' && ev.contextWindowSize > 0) {
                latestContextPct = Math.round((ev.totalTokenCount / ev.contextWindowSize) * 100)
              }
            }
          }
          continue
        }

        let content: string
        try {
          if (stat.size > 20 * 1024 * 1024) {
            const tailSize = 10 * 1024 * 1024
            const readStart = Math.max(0, stat.size - tailSize)
            const fd = await fsp.open(filePath, 'r')
            try {
              const buf = Buffer.alloc(stat.size - readStart)
              await fd.read(buf, 0, buf.length, readStart)
              const raw = buf.toString('utf-8')
              const firstNl = raw.indexOf('\n')
              content = firstNl >= 0 ? raw.slice(firstNl + 1) : raw
            } finally { await fd.close() }
          } else {
            content = await fsp.readFile(filePath, 'utf-8')
          }
        } catch { continue }

        const fileEvents: Array<QwenFileEvent> = []

        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const entry = JSON.parse(trimmed) as Record<string, unknown>
            if (entry['type'] !== 'assistant') continue

            const ts = entry['timestamp']
            if (typeof ts !== 'string') continue
            const epoch = Date.parse(ts)
            if (isNaN(epoch)) continue

            const usageMeta = (entry as any)['usageMetadata'] as Record<string, number> | undefined
            if (!usageMeta || typeof usageMeta.totalTokenCount !== 'number') continue

            const cws = usageMeta.contextWindowSize
            fileEvents.push({
              epoch,
              totalTokenCount: usageMeta.totalTokenCount,
              contextWindowSize: typeof cws === 'number' ? cws : undefined,
            })

            if (epoch >= cutoff) {
              requestCount++
              tokensSpent5h += usageMeta.totalTokenCount
              if (epoch < oldestInWindow) oldestInWindow = epoch
            }

            if (epoch > latestContextTs) {
              latestContextTs = epoch
              if (typeof cws === 'number' && cws > 0) {
                latestContextPct = Math.round((usageMeta.totalTokenCount / cws) * 100)
              }
            }
          } catch { continue }
        }

        fileUsageCache.set(cacheKey, stat, { events: fileEvents })
      }
    }
  } catch { /* base dir may not exist */ }

  fileUsageCache.prunePrefix(KEY_PREFIX, seenKeys)

  const resetAt = isFinite(oldestInWindow) ? oldestInWindow + WINDOW_MS : 0
  return { prompts5h: requestCount, tokensSpent5h, contextPct: latestContextPct, resetAt }
}

/**
 * Start a global watcher that polls Qwen CLI JSONL files every 60s
 * to count assistant requests + token spend within the rolling 5-hour window.
 * All I/O is async (fs.promises) with yields between files to keep the event loop responsive.
 * Returns a cleanup function.
 */
export function startQwenQuotaWatcher(
  onQuota: (info: QwenQuotaInfo) => void,
): () => void {
  let running = true

  const tick = async (): Promise<void> => {
    if (!running) return
    try {
      const plan = readQwenTier()
      const limit5h = QWEN_PLAN_LIMITS[plan] ?? 0
      const { prompts5h, tokensSpent5h, contextPct, resetAt } = await countQwenUsageInWindow()
      if (running) onQuota({ prompts5h, limit5h, resetAt, tokensSpent5h, contextPct })
    } catch (err) {
      console.warn('[qwen-quota] poll failed', err)
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
