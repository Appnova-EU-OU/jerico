// ── BEGIN DAEMON REPLICA SYNC NOTICE ─────────────────────────────────────────
// LOCKSTEP REPLICA of packages/codegraph/src/transcript-stats.ts.
//
// Why a copy: the daemon cannot import the codegraph package source cleanly
// (its tsconfig rootDir=./src rejects cross-package files with TS6059, and the
// package root index.ts pulls engine.ts → better-sqlite3/Node-ABI — forbidden
// in the daemon). The parser below is PURE (node builtins only) and engine-free
// by design, so it is replicated verbatim for the daemon bundle.
//
// EDIT THE ORIGINAL (packages/codegraph/src/transcript-stats.ts), THEN COPY IT
// HERE. Guard: packages/daemon/src/__tests__/transcript-stats-sync.test.ts
// fails when the two drift apart.
// ── END DAEMON REPLICA SYNC NOTICE ───────────────────────────────────────────
/**
 * transcript-stats — Claude Code session transcript (JSONL) → token/tool stats.
 *
 * PURE library: no engine.ts import (stays off the better-sqlite3 / Node-ABI
 * path) so the daemon and unit tests can import it standalone. Only node:
 * builtins are used.
 *
 * Load-bearing rules (codegraph_implplan_CONVERGED §0.1 / kimi §3 + live-smoke
 * fix #1):
 *  - Claude Code writes ONE JSONL LINE PER CONTENT BLOCK of the same assistant
 *    message, each carrying that message's usage tuple. Naive per-line
 *    summation overcounts ~2.28×. All token accumulation MUST dedupe by
 *    message.id. input/cache fields are stable across repeats (a difference
 *    there is real corruption → anomalyCount); output_tokens GROWS
 *    monotonically as the message streams, so per id output = MAX (keep-first
 *    undercounted subagent output by 97.6% — live-smoke finding #1).
 *  - Tool census runs PER LINE (each block is its own line — NOT deduped).
 *  - Attribution is at TURN granularity (per-tool token price is inferential
 *    because the cache entangles the prefix; tool_result BYTES are exact).
 */

import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── Types ────────────────────────────────────────────────────────────────────

export interface TokenTotals {
  input: number
  cacheCreation: number
  cacheRead: number
  output: number
}

export interface SubagentFile {
  path: string
  agentId: string
  agentType?: string
  spawnDepth?: number
}

export interface SessionFiles {
  main: string | undefined
  subagents: SubagentFile[]
  projectSlug: string | undefined
}

export type ToolBucket = 'codegraph' | 'nativeSearch' | 'other'

/** Output schema — codegraph_implplan kimi §3.5 (one JSON per run). */
export interface TranscriptStats {
  sessionId: string
  projectSlug: string | undefined
  files: { main: string | undefined; subagents: string[] }
  totals: TokenTotals
  /** Same 4 fields, summed over subagent files only. */
  subagentTotals: TokenTotals
  /** Unique message.id count across main + subagents. */
  turns: number
  /** Repeats of a message.id whose input/cache fields differed from the first
   *  occurrence (output_tokens growth is expected streaming, NOT an anomaly). */
  anomalyCount: number
  hadCompaction: boolean
  /** Last non-empty line of some file was unparseable (session live mid-write). */
  truncatedTail: boolean
  tools: Record<string, number>
  buckets: Record<ToolBucket, number>
  resultBytes: Record<ToolBucket, number>
  /** Turns whose content has ≥1 codegraph|nativeSearch tool_use. */
  attributed: { turns: number; tokens: TokenTotals }
  /** totals − attributed (orchestration prose, Bash, Edit/Write, thinking). */
  residual: { tokens: TokenTotals }
}

// ── Buckets / markers ────────────────────────────────────────────────────────

const CODEGRAPH_TOOL_RE = /bridge_codegraph_/
const NATIVE_SEARCH_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob'])

function bucketOf(toolName: string): ToolBucket {
  if (CODEGRAPH_TOOL_RE.test(toolName)) return 'codegraph'
  if (NATIVE_SEARCH_TOOLS.has(toolName)) return 'nativeSearch'
  return 'other'
}

/** Line `type` values observed in Claude Code transcripts (census: 14 types). */
const KNOWN_LINE_TYPES: ReadonlySet<string> = new Set([
  'assistant', 'user', 'system', 'summary', 'last-prompt', 'mode',
  'permission-mode', 'attachment', 'file-history-snapshot',
  'file-history-delta', 'ai-title', 'relocated', 'worktree-state',
  'queue-operation',
])

function zeroTotals(): TokenTotals {
  return { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 }
}

function addInto(acc: TokenTotals, t: TokenTotals): void {
  acc.input += t.input
  acc.cacheCreation += t.cacheCreation
  acc.cacheRead += t.cacheRead
  acc.output += t.output
}

// ── Locate ───────────────────────────────────────────────────────────────────

async function listSubagentFiles(sessionDir: string): Promise<SubagentFile[]> {
  const subDir = path.join(sessionDir, 'subagents')
  let entries
  try {
    entries = await fsp.readdir(subDir, { withFileTypes: true })
  } catch {
    return [] // no subagents dir — most sessions
  }
  const out: SubagentFile[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const m = /^agent-(.+)\.jsonl$/.exec(e.name)
    if (!m || !m[1]) continue
    const sub: SubagentFile = { path: path.join(subDir, e.name), agentId: m[1] }
    try {
      const metaRaw = await fsp.readFile(path.join(subDir, `agent-${m[1]}.meta.json`), 'utf-8')
      const meta = JSON.parse(metaRaw) as Record<string, unknown>
      if (typeof meta['agentType'] === 'string') sub.agentType = meta['agentType']
      if (typeof meta['spawnDepth'] === 'number') sub.spawnDepth = meta['spawnDepth']
    } catch { /* meta.json is optional */ }
    out.push(sub)
  }
  out.sort((a, b) => a.path.localeCompare(b.path)) // deterministic output
  return out
}

/**
 * Search ~/.claude/projects/<slug>/<sessionId>.jsonl, then recurse
 * <slug>/<sessionId>/subagents/agent-*.jsonl. Mirrors (and validates) the
 * daemon's findJSONL fix. Returns null when no main file matches.
 */
export async function locateSessionFiles(
  sessionId: string,
  projectsBase?: string,
): Promise<SessionFiles | null> {
  const base = projectsBase ?? path.join(os.homedir(), '.claude', 'projects')
  let dirs
  try {
    dirs = await fsp.readdir(base, { withFileTypes: true })
  } catch {
    return null
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const main = path.join(base, dir.name, `${sessionId}.jsonl`)
    try {
      await fsp.access(main)
    } catch {
      continue
    }
    const subagents = await listSubagentFiles(path.join(base, dir.name, sessionId))
    return { main, subagents, projectSlug: dir.name }
  }
  return null
}

/** Locate from an explicit main-file path; subagents resolved via the sibling dir. */
export async function locateSessionFilesFromPath(filePath: string): Promise<SessionFiles> {
  const dir = path.dirname(filePath)
  const stem = path.basename(filePath).replace(/\.jsonl$/, '')
  const subagents = await listSubagentFiles(path.join(dir, stem))
  return { main: filePath, subagents, projectSlug: path.basename(dir) }
}

// ── Parse ────────────────────────────────────────────────────────────────────

interface UsageTuple extends TokenTotals {}

interface PendingResult {
  toolUseId: string | undefined
  bytes: number
}

interface ParseCtx {
  seen: Map<string, UsageTuple>
  totals: TokenTotals
  subagentTotals: TokenTotals
  anomalyCount: number
  hadCompaction: boolean
  truncatedTail: boolean
  tools: Map<string, number>
  buckets: Record<ToolBucket, number>
  toolUseBucketById: Map<string, ToolBucket>
  /** message.id → set of tool buckets used by that turn (across its block lines). */
  msgBuckets: Map<string, Set<ToolBucket>>
  pendingResults: PendingResult[]
  linesParsed: number
  sawClaudeMarker: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function usageTuple(u: Record<string, unknown>): UsageTuple {
  return {
    input: num(u['input_tokens']),
    cacheCreation: num(u['cache_creation_input_tokens']),
    cacheRead: num(u['cache_read_input_tokens']),
    output: num(u['output_tokens']),
  }
}

function processLine(line: string, isSubagent: boolean, ctx: ParseCtx): boolean {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return false
  }
  ctx.linesParsed++
  if (!isRecord(entry)) return true

  const message = isRecord(entry['message']) ? entry['message'] : undefined
  const type = entry['type']
  if (message || (typeof type === 'string' && KNOWN_LINE_TYPES.has(type))
    || 'parentUuid' in entry || 'sessionId' in entry) {
    ctx.sawClaudeMarker = true
  }

  // Compaction markers (pinned from a real compacted session: type:'system' +
  // subtype:'compact_boundary' with compactMetadata; isCompactSummary also seen).
  if (entry['isCompactSummary'] === true
    || (type === 'system' && (entry['subtype'] === 'compact_boundary' || entry['isCompactSummary'] === true))) {
    ctx.hadCompaction = true
  }

  // ── Token usage — DEDUPE BY message.id (the crux) ──
  if (message && isRecord(message['usage'])) {
    const t = usageTuple(message['usage'])
    const id = message['id']
    if (typeof id === 'string' && id !== '') {
      const prev = ctx.seen.get(id)
      if (prev) {
        // Repeat of the same message (one line per content block). input/cache
        // fields are stable across repeats; a difference there is real
        // corruption / an id collision → anomaly. output_tokens GROWS
        // monotonically as the message streams (verified: subagent files show
        // 8 → 14369 within one id) — that is expected streaming, so keep MAX
        // and accumulate only the growth.
        if (prev.input !== t.input || prev.cacheCreation !== t.cacheCreation || prev.cacheRead !== t.cacheRead) {
          ctx.anomalyCount++
        } else if (t.output > prev.output) {
          const growth = t.output - prev.output
          prev.output = t.output
          ctx.totals.output += growth
          if (isSubagent) ctx.subagentTotals.output += growth
        }
      } else {
        ctx.seen.set(id, t)
        addInto(ctx.totals, t)
        if (isSubagent) addInto(ctx.subagentTotals, t)
      }
    } else {
      // No id to dedupe by — accumulate per line (cannot be verified).
      addInto(ctx.totals, t)
      if (isSubagent) addInto(ctx.subagentTotals, t)
    }
  }

  // ── Tool census — PER LINE (content blocks are NOT deduped) ──
  if (type === 'assistant' && message && Array.isArray(message['content'])) {
    const msgId = typeof message['id'] === 'string' ? message['id'] : undefined
    for (const block of message['content']) {
      if (!isRecord(block) || block['type'] !== 'tool_use') continue
      const name = block['name']
      if (typeof name !== 'string' || name === '') continue
      ctx.tools.set(name, (ctx.tools.get(name) ?? 0) + 1)
      const bucket = bucketOf(name)
      ctx.buckets[bucket]++
      const toolUseId = block['id']
      if (typeof toolUseId === 'string' && toolUseId !== '') {
        ctx.toolUseBucketById.set(toolUseId, bucket)
      }
      if (msgId) {
        let set = ctx.msgBuckets.get(msgId)
        if (!set) {
          set = new Set()
          ctx.msgBuckets.set(msgId, set)
        }
        set.add(bucket)
      }
    }
  }

  // ── tool_result bytes (joined to the calling tool AFTER all files) ──
  if (type === 'user' && message && Array.isArray(message['content'])) {
    for (const block of message['content']) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue
      const content = block['content']
      let bytes = 0
      if (typeof content === 'string') bytes = content.length
      else if (Array.isArray(content) || isRecord(content)) bytes = JSON.stringify(content).length
      ctx.pendingResults.push({
        toolUseId: typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : undefined,
        bytes,
      })
    }
  }
  return true
}

async function parseFile(filePath: string, isSubagent: boolean, ctx: ParseCtx): Promise<void> {
  const content = await fsp.readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  // Trailing partial line: a non-empty final segment that fails JSON.parse
  // means the session was live mid-write — skip it, flag truncatedTail.
  const lastIdx = lines.length - 1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    const ok = processLine(line, isSubagent, ctx)
    if (!ok && i === lastIdx) ctx.truncatedTail = true
  }
}

/**
 * Parse main + subagent transcripts into the §3.5 stats object.
 * Throws when the input has lines but none look like a Claude Code transcript
 * (kimi/opencode sessions have a different format — refuse, don't fabricate).
 */
export async function computeTranscriptStats(
  files: SessionFiles,
  sessionId: string,
): Promise<TranscriptStats> {
  const ctx: ParseCtx = {
    seen: new Map(),
    totals: zeroTotals(),
    subagentTotals: zeroTotals(),
    anomalyCount: 0,
    hadCompaction: false,
    truncatedTail: false,
    tools: new Map(),
    buckets: { codegraph: 0, nativeSearch: 0, other: 0 },
    toolUseBucketById: new Map(),
    msgBuckets: new Map(),
    pendingResults: [],
    linesParsed: 0,
    sawClaudeMarker: false,
  }

  if (files.main) await parseFile(files.main, false, ctx)
  for (const sub of files.subagents) {
    try {
      await parseFile(sub.path, true, ctx)
    } catch { /* subagent file vanished/unreadable — skip, main totals stand */ }
  }

  if (ctx.linesParsed > 0 && !ctx.sawClaudeMarker) {
    throw new Error(
      `not a Claude Code transcript: ${ctx.linesParsed} lines parsed but no message.usage shape found`,
    )
  }

  // tool_result bytes joined to the calling tool via tool_use_id (session-global:
  // a result may reference a call from another file of the same session).
  const resultBytes: Record<ToolBucket, number> = { codegraph: 0, nativeSearch: 0, other: 0 }
  for (const r of ctx.pendingResults) {
    const bucket = (r.toolUseId && ctx.toolUseBucketById.get(r.toolUseId)) || 'other'
    resultBytes[bucket] += r.bytes
  }

  // Attributed vs residual at TURN granularity (unique message ids).
  const attributed = { turns: 0, tokens: zeroTotals() }
  for (const [id, t] of ctx.seen) {
    const bset = ctx.msgBuckets.get(id)
    if (bset && (bset.has('codegraph') || bset.has('nativeSearch'))) {
      attributed.turns++
      addInto(attributed.tokens, t)
    }
  }
  const residual: TokenTotals = {
    input: ctx.totals.input - attributed.tokens.input,
    cacheCreation: ctx.totals.cacheCreation - attributed.tokens.cacheCreation,
    cacheRead: ctx.totals.cacheRead - attributed.tokens.cacheRead,
    output: ctx.totals.output - attributed.tokens.output,
  }

  const tools: Record<string, number> = {}
  for (const [name, n] of [...ctx.tools.entries()].sort((a, b) => b[1] - a[1])) {
    tools[name] = n
  }

  return {
    sessionId,
    projectSlug: files.projectSlug,
    files: {
      main: files.main,
      subagents: files.subagents.map(s => s.path),
    },
    totals: ctx.totals,
    subagentTotals: ctx.subagentTotals,
    turns: ctx.seen.size,
    anomalyCount: ctx.anomalyCount,
    hadCompaction: ctx.hadCompaction,
    truncatedTail: ctx.truncatedTail,
    tools,
    buckets: ctx.buckets,
    resultBytes,
    attributed,
    residual: { tokens: residual },
  }
}
