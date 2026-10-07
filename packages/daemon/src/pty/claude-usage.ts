import { promises as fsp } from 'fs'
import path from 'path'
import os from 'os'
import { safeStat, readFileChunkBuffer, yieldTick } from './usage-cache.js'
// Cohort step 3 (Fork 5): the PURE transcript parser — engine-free by design
// (node builtins only, NO better-sqlite3 / Node-ABI). This is a LOCKSTEP
// REPLICA of packages/codegraph/src/transcript-stats.ts (see its header): the
// daemon cannot import the codegraph package cleanly (tsconfig rootDir), and
// the package root pulls engine.ts → better-sqlite3. Guarded against drift by
// src/__tests__/transcript-stats-sync.test.ts.
import { computeTranscriptStats, locateSessionFiles } from './transcript-stats.js'

// All current Claude models have 200k context window
const CONTEXT_WINDOW = 200_000

/**
 * Bounded per-session seen-id set (implplan §0.1/§0.6.1): Claude Code writes
 * ONE JSONL LINE PER CONTENT BLOCK of the same assistant message, each line
 * carrying that message's usage tuple — naive per-line summation overcounts
 * ~2.28× (orchestrator-reproduced). Dedupe by message.id is the crux. The set
 * survives across polls because a message's block lines can straddle a poll
 * boundary; it is cleared iff a reset is emitted (watcher (re)start).
 *
 * CAUTION: an evicted id that later reappears (streaming across a poll, or the
 * whole-file re-read on rotation) is treated as first-seen and its full tuple
 * is re-counted → silent double-count. The cap must therefore stay above any
 * realistic session's unique-message count (largest observed ≈ 3.2k; 100k
 * gives ~30× headroom at ≈ bounded worst-case memory, per-watcher) so
 * eviction never happens mid-session.
 */
const SEEN_ID_CAP = 100_000

/**
 * Tool-census buckets (STEP-3) — mirrors `bucketOf` in the engine-free parser
 * (./transcript-stats.ts, replica of packages/codegraph/src/transcript-stats.ts),
 * the reference for native-vs-codegraph counting. Kept local: `bucketOf` is
 * not exported from the parser and the census needs it on the per-line hot
 * path. The parser IS used for the panel-exit final parse — see
 * computePanelAbStats below.
 */
const CODEGRAPH_TOOL_RE = /bridge_codegraph_/
const NATIVE_SEARCH_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob'])

type ToolBucket = 'codegraph' | 'nativeSearch' | 'other'

function bucketOf(toolName: string): ToolBucket {
  if (CODEGRAPH_TOOL_RE.test(toolName)) return 'codegraph'
  if (NATIVE_SEARCH_TOOLS.has(toolName)) return 'nativeSearch'
  return 'other'
}

/** Σ-delta tool_use counts since the previous poll (per-bucket). */
export interface ToolCensus {
  codegraph: number
  nativeSearch: number
  other: number
}

interface UsageTuple {
  input: number
  cacheCreation: number
  cacheRead: number
  output: number
}

/** Main session file + every subagent transcript of the session. */
interface SessionFiles {
  main: string | undefined
  subagents: string[]
  /** <projectSlug>/<sessionId>/subagents — re-listed each tick for new agents. */
  subagentsDir: string | undefined
}

/**
 * What a stopped watcher hands back to its owner (cohort step 3 / Fork 5):
 * its sessionId plus every transcript path it ever tailed. The caller retains
 * these per panel so the exit-time final parse covers ALL session segments
 * (a panel can rotate/respawn through several sessionIds and subagent files).
 */
export interface ClaudeUsageWatcherRetention {
  sessionId: string
  files: string[]
}

/**
 * Search ~/.claude/projects/ subdirectories for a session's JSONL files:
 * the top-level <sessionId>.jsonl plus <sessionId>/subagents/agent-*.jsonl
 * (subagent turns carry full usage — skipping them undercounts, asymmetrically
 * when the treatment changes subagent fan-out). Uses async I/O.
 */
async function findJSONL(sessionId: string): Promise<SessionFiles | undefined> {
  const base = path.join(os.homedir(), '.claude', 'projects')
  try {
    const dirs = await fsp.readdir(base, { withFileTypes: true })
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const candidate = path.join(base, dir.name, `${sessionId}.jsonl`)
      const stat = await safeStat(candidate)
      if (!stat) continue
      const subagentsDir = path.join(base, dir.name, sessionId, 'subagents')
      return { main: candidate, subagents: await listAgentFiles(subagentsDir), subagentsDir }
    }
  } catch { /* no-op */ }
  return undefined
}

async function listAgentFiles(subagentsDir: string | undefined): Promise<string[]> {
  if (!subagentsDir) return []
  try {
    const entries = await fsp.readdir(subagentsDir, { withFileTypes: true })
    return entries
      .filter(e => e.isFile() && /^agent-.+\.jsonl$/.test(e.name))
      .map(e => path.join(subagentsDir, e.name))
      .sort()
  } catch {
    return []
  }
}

export interface ClaudeUsageTokens {
  inputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  outputTokens: number
}

interface TailState {
  offset: number
  /** Raw bytes of a partial trailing line, held until the next '\n' arrives. */
  pending: Buffer
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Start polling Claude's JSONL session files (main + subagents) for token usage.
 *
 * STEP-1 sampler fix (implplan §1): instead of the old last-entry-only SAMPLE
 * (~20% capture, treatment-biased), each poll offset-tails every session file
 * (O(new bytes) via readFileChunkBuffer), parses only the newly appended lines
 * and accumulates Σ-deltas of {input, cacheCreation, cacheRead, output} over
 * NEWLY-SEEN message.ids (dedupe-by-id is load-bearing). input/cache fields
 * are stable across a message's repeat lines; output_tokens GROWS as the
 * message streams, so repeats contribute only their positive output increment
 * (per-id output watermark = MAX — live-smoke fix #1) and only an input/cache
 * mismatch trips the anomaly counter. A partial trailing line is held in
 * `pending`; `stat.size < offset` means truncation/rotation → re-read from 0.
 *
 * DUAL emission (both via onUsage):
 *  1. gauge: usedPct/usedTokens from the MAIN file's last usage entry — feeds
 *     the UI context ring, semantics unchanged.
 *  2. Σ-delta tokens (incl output) since the previous poll.
 *
 * STEP-3 tool census: the SAME per-line pass additionally counts `tool_use`
 * content blocks per bucket (codegraph / nativeSearch / other). The census is
 * PER-LINE — each content block is its own JSONL line and appears exactly
 * once as the offset advances, so it is NOT deduped by message.id (dedupe is
 * only for token tuples; transcript-stats.ts is the reference). It IS deduped
 * by the tool_use block's unique stable `block.id` (FIX A) so that a
 * truncation/rotation re-read (offset reset to 0, whole file re-presented)
 * does NOT re-count history — mirroring seenIds: the set is kept across
 * rotation and dropped only on watcher (re)start. Emitted as the `census`
 * argument (Σ-delta since the previous poll, null when zero).
 *
 * Baseline×server-clear pairing: the first emit after (re)start is a
 * {reset:true} message (tokens=null, census=null) BEFORE any delta; the
 * server clears the panel's accumulated counters (tokens AND census bucket),
 * then accumulates deltas. The seen-id set is per-watcher, so a (re)start is
 * the only reset point (cleared iff reset).
 */
export function startClaudeUsageWatcher(
  agentId:  string,
  sessionId: string,
  onUsage: (agentId: string, usedPct: number, usedTokens: number, tokens: ClaudeUsageTokens | null, census: ToolCensus | null, reset: boolean) => void,
): () => ClaudeUsageWatcherRetention {
  let files: SessionFiles | undefined
  let running = true
  let pendingReset = true
  let lastUsedTokens = -1
  let lastGaugePct = 0
  let lastGaugeTokens = 0
  let anomalyCount = 0
  let lastAnomalyLogged = 0
  const tails = new Map<string, TailState>()
  const seenIds = new Map<string, UsageTuple>()
  // Cohort step 3 (Fork 5): every transcript path ever tailed — returned by
  // the stop closure for the exit-time whole-file parse. Rotation is in-place
  // (same path re-read from 0), so paths survive; subagent files are added as
  // they appear across ticks.
  const retainedFiles = new Set<string>()
  // FIX A — rotation-safe census dedupe: one entry per tool_use block id
  // (unique + stable). Same lifecycle as seenIds: per-watcher, KEPT across
  // rotation (re-presented blocks are skipped), gone on (re)start — the only
  // reset point. Bounded by the same cap.
  const countedToolUseIds = new Set<string>()

  const gaugeFrom = (t: UsageTuple): void => {
    lastGaugeTokens = t.input + t.cacheCreation + t.cacheRead
    lastGaugePct = Math.min(100, Math.round((lastGaugeTokens / CONTEXT_WINDOW) * 100))
  }

  /** Offset-tail one file; parse new lines; accumulate deltas + census + main gauge. */
  const tailFile = async (filePath: string, isMain: boolean, delta: UsageTuple, census: ToolCensus): Promise<void> => {
    retainedFiles.add(filePath)
    const stat = await safeStat(filePath)
    if (!stat) return
    let tail = tails.get(filePath)
    if (!tail) {
      tail = { offset: 0, pending: Buffer.alloc(0) }
      tails.set(filePath, tail)
    }
    if (stat.size < tail.offset) {
      // Truncation/rotation: re-read the whole current file. The seen-id set is
      // KEPT — a rewritten file re-presents already-counted ids and dedupe
      // absorbs them (clearing here would double-count).
      tail.offset = 0
      tail.pending = Buffer.alloc(0)
      console.log('[daemon] claude-usage.rotate', { agentId, sessionId, filePath })
    }
    if (stat.size === tail.offset && tail.pending.length === 0) return
    const chunk = await readFileChunkBuffer(filePath, tail.offset)
    if (chunk.length === 0) return
    tail.offset += chunk.length // exact raw-byte advance — no UTF-8 drift
    const combined = tail.pending.length > 0 ? Buffer.concat([tail.pending, chunk]) : chunk
    const nl = combined.lastIndexOf(0x0a)
    if (nl === -1) {
      tail.pending = combined
      return
    }
    const complete = combined.subarray(0, nl + 1).toString('utf-8')
    tail.pending = combined.subarray(nl + 1)
    for (const line of complete.split('\n')) {
      if (!line || !line.trim()) continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch { continue }
      if (!isRecord(entry)) continue
      const message = isRecord(entry['message']) ? entry['message'] : undefined
      // ── Tool census — PER LINE (each content block is its own line;
      // transcript-stats.ts is the reference), deduped by the block's unique
      // stable id (FIX A) so rotation re-reads don't re-count history. Runs
      // for every assistant line, independent of whether it carries usage.
      if (entry['type'] === 'assistant' && message) {
        const content = message['content']
        if (Array.isArray(content)) {
          for (const block of content as unknown[]) {
            if (!isRecord(block) || block['type'] !== 'tool_use') continue
            const name = block['name']
            if (typeof name !== 'string' || name === '') continue
            const bid = typeof block['id'] === 'string' ? block['id'] : undefined
            if (bid) {
              if (countedToolUseIds.has(bid)) continue
              countedToolUseIds.add(bid)
              if (countedToolUseIds.size > SEEN_ID_CAP) {
                const oldest = countedToolUseIds.values().next().value
                if (oldest !== undefined) countedToolUseIds.delete(oldest)
              }
            }
            census[bucketOf(name)]++
          }
        }
      }
      const usage = message && isRecord(message['usage']) ? message['usage'] : undefined
      if (!usage) continue
      const t: UsageTuple = {
        input: num(usage['input_tokens']),
        cacheCreation: num(usage['cache_creation_input_tokens']),
        cacheRead: num(usage['cache_read_input_tokens']),
        output: num(usage['output_tokens']),
      }
      // Gauge follows the MAIN file's last usage entry — every usage-bearing
      // line, repeat or not (the ring must track the latest context fill; only
      // output_tokens grows across a message's repeat lines, and the gauge
      // excludes output, so this is exact).
      if (isMain) gaugeFrom(t)
      const id = message && typeof message['id'] === 'string' ? message['id'] : undefined
      if (id) {
        const prev = seenIds.get(id)
        if (prev) {
          // Repeat of the same message. input/cache are stable across repeats —
          // a difference there is real corruption / an id collision → anomaly.
          // output_tokens GROWS monotonically as the message streams (and can
          // straddle a poll boundary), so the stored tuple is a per-id output
          // watermark and only the positive increment is emitted. Net effect:
          // the cumulative counter for the id equals its final MAX output.
          if (prev.input !== t.input || prev.cacheCreation !== t.cacheCreation || prev.cacheRead !== t.cacheRead) {
            anomalyCount++
          } else if (t.output > prev.output) {
            delta.output += t.output - prev.output
            prev.output = t.output
          }
          continue
        }
        seenIds.set(id, t)
        if (seenIds.size > SEEN_ID_CAP) {
          const oldest = seenIds.keys().next().value
          if (oldest !== undefined) seenIds.delete(oldest)
        }
      }
      // No id → cannot dedupe; accumulate per line.
      delta.input += t.input
      delta.cacheCreation += t.cacheCreation
      delta.cacheRead += t.cacheRead
      delta.output += t.output
    }
  }

  const tick = async (): Promise<void> => {
    if (!running) return
    try {
      // Lazily locate the session files (may not exist immediately after spawn)
      if (!files) files = await findJSONL(sessionId)
      if (!files) return
      // Pick up subagent files spawned since the previous tick
      files.subagents = await listAgentFiles(files.subagentsDir)

      const delta: UsageTuple = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 }
      const census: ToolCensus = { codegraph: 0, nativeSearch: 0, other: 0 }
      let filesSeen = 0
      if (files.main) {
        await tailFile(files.main, true, delta, census)
        filesSeen++
        await yieldTick()
      }
      for (const sub of files.subagents) {
        await tailFile(sub, false, delta, census)
        filesSeen++
        await yieldTick()
      }
      if (filesSeen === 0) return
      if (!running) return

      if (anomalyCount !== lastAnomalyLogged) {
        lastAnomalyLogged = anomalyCount
        console.warn('[daemon] claude-usage.anomaly', { agentId, sessionId, anomalyCount })
      }

      // Baseline×server-clear pairing: reset BEFORE the first delta. The
      // server clears BOTH the token accumulator and the census bucket on
      // this signal, so no separate census reset message is needed.
      if (pendingReset) {
        pendingReset = false
        lastUsedTokens = lastGaugeTokens
        onUsage(agentId, lastGaugePct, lastGaugeTokens, null, null, true)
      }

      const deltaNonZero = delta.input > 0 || delta.cacheCreation > 0 || delta.cacheRead > 0 || delta.output > 0
      const censusNonZero = census.codegraph > 0 || census.nativeSearch > 0 || census.other > 0
      // Emit on new tokens OR census movement OR gauge movement (replaces the
      // old usedTokens-only gate, which is wrong under delta mode). Census is
      // in the gate: a repeat block line of an already-seen message adds to
      // the census but not to the token delta — it must not be dropped.
      if (deltaNonZero || censusNonZero || lastGaugeTokens !== lastUsedTokens) {
        lastUsedTokens = lastGaugeTokens
        onUsage(agentId, lastGaugePct, lastGaugeTokens, {
          inputTokens: delta.input,
          cacheCreationTokens: delta.cacheCreation,
          cacheReadTokens: delta.cacheRead,
          outputTokens: delta.output,
        }, censusNonZero ? census : null, false)
      }
    } catch { /* silent — per-session watcher, don't flood logs */ }
  }

  // First poll after 5s (JSONL may not exist yet), then every 60s
  const initial  = setTimeout(() => { void tick() }, 5000)
  const interval = setInterval(() => { void tick() }, 60_000)

  return () => {
    running = false
    clearTimeout(initial)
    clearInterval(interval)
    return { sessionId, files: [...retainedFiles] }
  }
}

// ── Cohort step 3 (Fork 5): exit-time final parse ────────────────────────────

/** `stats` payload of the daemon→server `panel_codegraph_ab_result` message. */
export interface CodegraphAbStats {
  input: number
  cacheCreation: number
  cacheRead: number
  output: number
  turns: number
  codegraphCalls: number
  nativeSearchCalls: number
  otherCalls: number
  hadCompaction: boolean
  anomalyCount: number
  truncatedTail: boolean
}

export interface PanelAbResult {
  /** The panel's most recent sessionId (last of the retained segments). */
  sessionId: string
  stats: CodegraphAbStats
}

/**
 * ONE final whole-transcript parse at panel exit over ALL retained session
 * segments (Fork 5 + kimi §3.4): every sessionId the panel ever ran plus every
 * transcript path its watchers ever tailed. The offset-tail stream is
 * incremental (and, for tokens, unbiased), but this exit parse is the honest
 * reference metric — whole files, dedupe by message.id, per-line tool census,
 * the same rules as the scripted ab-run.
 *
 * Paths are unioned and deduped, so a file reachable via BOTH locateSessionFiles
 * and the retained set is parsed exactly once. Files that no longer exist are
 * skipped (their already-streamed deltas still stand in the live census).
 *
 * Returns null when no segment file survives on disk (e.g. non-Claude panel or
 * reclaimed transcripts). Throws when the files parse but are not Claude Code
 * transcripts — the caller logs and skips the emit.
 */
export async function computePanelAbStats(
  sessionIds: readonly string[],
  retained: readonly string[],
): Promise<PanelAbResult | null> {
  const orderedIds = [...new Set(sessionIds)]
  const paths = new Set<string>()
  let lastMain: string | undefined
  for (const id of orderedIds) {
    const located = await locateSessionFiles(id).catch(() => null)
    if (!located) continue
    if (located.main) {
      paths.add(located.main)
      lastMain = located.main // ids arrive oldest → newest: newest segment's main wins
    }
    for (const sub of located.subagents) paths.add(sub.path)
  }
  for (const f of retained) paths.add(f)

  const existing: string[] = []
  for (const f of paths) {
    try {
      await fsp.access(f)
      existing.push(f)
    } catch { /* vanished since last seen — skip */ }
  }
  const primaryId = orderedIds[orderedIds.length - 1]
  if (!primaryId || existing.length === 0) return null

  // `main` only drives the parser's subagentTotals split (not shipped in the
  // payload) — totals/buckets cover all files regardless. Prefer the newest
  // segment's main when it survives.
  const mainFile = lastMain && existing.includes(lastMain) ? lastMain : existing[0]!
  const stats = await computeTranscriptStats({
    main: mainFile,
    subagents: existing
      .filter(f => f !== mainFile)
      .map(p => ({ path: p, agentId: path.basename(p).replace(/\.jsonl$/, '') })),
    projectSlug: undefined,
  }, primaryId)

  return {
    sessionId: primaryId,
    stats: {
      input:            stats.totals.input,
      cacheCreation:    stats.totals.cacheCreation,
      cacheRead:        stats.totals.cacheRead,
      output:           stats.totals.output,
      turns:            stats.turns,
      codegraphCalls:   stats.buckets.codegraph,
      nativeSearchCalls: stats.buckets.nativeSearch,
      otherCalls:       stats.buckets.other,
      hadCompaction:    stats.hadCompaction,
      anomalyCount:     stats.anomalyCount,
      truncatedTail:    stats.truncatedTail,
    },
  }
}
