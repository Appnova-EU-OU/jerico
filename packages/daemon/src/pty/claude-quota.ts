import { promises as fsp } from 'fs'
import path from 'path'
import os from 'os'
import { getConfigPath } from '../profile.js'
import { fileUsageCache, safeStat, yieldTick } from './usage-cache.js'

const WINDOW_MS = 5 * 60 * 60 * 1000 // 5 hours in ms

const TIER_LIMITS: Record<string, number> = {
  free:    10,
  pro:     40,
  max_5x:  200,
  max_20x: 200,
}

export interface QuotaInfo {
  prompts5h: number
  limit5h:   number
  resetAt:   number  // epoch ms — when the oldest prompt in window expires
  tier:      string
}

export function readTier(): string {
  const configPath = getConfigPath()
  try {
    // readTier remains sync — reads a tiny config file, negligible impact
    const { statSync, readFileSync } = require('fs') as typeof import('fs')
    if (!statSync(configPath, { throwIfNoEntry: false })) return 'pro'
    const obj = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    const tier = obj['claudeTier']
    if (typeof tier === 'string' && tier in TIER_LIMITS) return tier
  } catch { /* ignore */ }
  return 'pro'
}

function hasToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block && typeof block === 'object' && (block as any).type === 'tool_result') {
      return true
    }
  }
  return false
}

interface ClaudeFileCache {
  events: Array<{ epoch: number }>
}

/** Prefix cache keys to avoid collision with claude-usage watcher (same files, different value shape). */
const KEY_PREFIX = 'quota:'

interface CountResult {
  prompts5h: number
  resetAt: number
  rawEntries: number
  uniquePromptIds: number
  dedupActive: boolean
}

async function countPromptsInWindow(): Promise<CountResult> {
  const base = path.join(os.homedir(), '.claude', 'projects')
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  let oldestInWindow = Infinity
  let count = 0
  let rawEntries = 0
  let uniquePromptIds = 0
  let dedupActive = false
  const seenKeys = new Set<string>()
  const seenPromptIds = new Set<string>()

  try {
    const dirs = await fsp.readdir(base, { withFileTypes: true })
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue

      const dirPath = path.join(base, dir.name)
      let files: string[]
      try {
        const entries = await fsp.readdir(dirPath, { withFileTypes: true })
        files = entries.filter(f => f.isFile() && f.name.endsWith('.jsonl')).map(f => f.name)
      } catch { continue }

      for (const file of files) {
        const filePath = path.join(dirPath, file)
        const stat = await safeStat(filePath)
        if (!stat) continue

        // Yield between files to keep event loop responsive
        await yieldTick()

        const cacheKey = KEY_PREFIX + filePath
        seenKeys.add(cacheKey)

        const cached = fileUsageCache.get(cacheKey, stat) as ClaudeFileCache | undefined
        if (cached !== undefined) {
          // Re-filter cached events against current window cutoff.
          // Events can only age out (never in), so this is exact.
          for (const ev of cached.events) {
            if (ev.epoch >= cutoff) {
              count++
              if (ev.epoch < oldestInWindow) oldestInWindow = ev.epoch
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

        let fileCount = 0
        let fileOldest = Infinity
        const fileEvents: Array<{ epoch: number }> = []

        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const entry = JSON.parse(trimmed) as Record<string, unknown>
            if (entry['type'] !== 'user') continue
            const msg = entry['message'] as Record<string, unknown> | undefined
            if (msg?.['role'] !== 'user') continue
            if (entry['userType'] !== undefined && entry['userType'] !== 'external') continue
            if (hasToolResultContent(msg?.['content'])) continue
            if (entry['isSidechain'] === true) continue
            if (entry['isMeta'] === true) continue

            const ts = entry['timestamp']
            if (typeof ts !== 'string') continue
            const epoch = Date.parse(ts)
            if (isNaN(epoch) || epoch < cutoff) continue

            rawEntries++

            // P0: promptId dedup — Claude Code rewrites the same prompt 2–80× across
            // tool-call iterations sharing one top-level promptId.
            const promptId = entry['promptId']
            if (typeof promptId === 'string' && promptId.length > 0) {
              dedupActive = true
              if (seenPromptIds.has(promptId)) continue
              seenPromptIds.add(promptId)
            }
            uniquePromptIds++

            fileCount++
            fileEvents.push({ epoch })
            if (epoch < fileOldest) fileOldest = epoch
          } catch { continue }
        }

        count += fileCount
        if (fileOldest < oldestInWindow) oldestInWindow = fileOldest
        fileUsageCache.set(cacheKey, stat, { events: fileEvents })
      }
    }
  } catch { /* base dir may not exist */ }

  // Prune stale cache entries (deleted files) to prevent unbounded Map growth.
  fileUsageCache.prunePrefix(KEY_PREFIX, seenKeys)

  const resetAt = isFinite(oldestInWindow) ? oldestInWindow + WINDOW_MS : 0
  return { prompts5h: count, resetAt, rawEntries, uniquePromptIds, dedupActive }
}

/**
 * Start a global watcher that polls Claude Code JSONL files every 60s
 * to count user prompts within the rolling 5-hour window.
 * NOTE: This is a HEURISTIC local counter. The authoritative Claude usage API
 * (api.anthropic.com/api/oauth/usage) will supersede this in a later phase.
 * All I/O is async (fs.promises) with yields between files to keep the event loop responsive.
 * Returns a cleanup function.
 */
export function startClaudeQuotaWatcher(
  onQuota: (info: QuotaInfo) => void,
): () => void {
  let running = true

  let startupCheckDone = false

  const tick = async (): Promise<void> => {
    if (!running) return
    try {
      const tier = readTier()
      const limit5h = TIER_LIMITS[tier] ?? 40
      const result = await countPromptsInWindow()
      if (!running) return

      // P0: startup promptId check — if no JSONL entry has a promptId, the
      // format may have changed and dedup is silently disabled.
      if (!startupCheckDone) {
        startupCheckDone = true
        if (!result.dedupActive) {
          console.warn('[claude-quota] dedup_disabled — no promptId found in any JSONL user entry; counts may overstate by 2–80×')
        }
      }

      // P0: Log dedup ratio each poll so format regressions are detectable.
      // ratio = rawEntries / uniquePromptIds; < 1.1 means dedup is barely effective.
      if (result.rawEntries > 0 && result.dedupActive) {
        const ratio = result.uniquePromptIds > 0
          ? (result.rawEntries / result.uniquePromptIds).toFixed(2)
          : '∞'
        if (result.uniquePromptIds > 0 && result.rawEntries / result.uniquePromptIds < 1.1) {
          console.warn('[claude-quota] dedup_ratio_low', {
            rawEntries: result.rawEntries,
            uniquePromptIds: result.uniquePromptIds,
            ratio,
            msg: 'promptId dedup barely effective — possible format regression',
          })
        }
      }

      if (running) onQuota({ prompts5h: result.prompts5h, limit5h, resetAt: result.resetAt, tier })
    } catch (err) {
      console.warn('[claude-quota] poll failed', err)
    }
  }

  __internalSetTickRef(async () => {
    if (!running) return
    try {
      const tier = readTier()
      const limit5h = TIER_LIMITS[tier] ?? 40
      const result = await countPromptsInWindow()
      if (running) onQuota({ prompts5h: result.prompts5h, limit5h, resetAt: result.resetAt, tier })
    } catch { /* manual trigger — silent */ }
  })

  // Defer first scan: run after 5s grace period. Longest deferral because
  // Claude projects are the most likely to have huge JSONL files (the 663MB case).
  const initialTimer = setTimeout(() => { void tick() }, 5000)
  const interval = setInterval(() => { void tick() }, 60_000)

  return () => {
    running = false
    clearTimeout(initialTimer)
    clearInterval(interval)
  }
}

let _tickRef: (() => void) | null = null

export function triggerTick(): void {
  if (_tickRef) { try { _tickRef() } catch { /* silent */ } }
}

export function __internalSetTickRef(fn: () => void): void {
  _tickRef = fn
}
