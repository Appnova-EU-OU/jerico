import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { Engine } from './engine.js'
import { computeTranscriptStats, locateSessionFiles, locateSessionFilesFromPath } from './transcript-stats.js'

const CODEGRAPH_PORT = parseInt(process.env['CODEGRAPH_PORT'] ?? '3201', 10)
const engine = Engine.get()

// ── Adoption measurement — SINGLE WRITER (Step 2) ───────────────────────────
// ALL codegraph calls are counted HERE in the own server: proxied calls flow
// proxy → callTool → these handlers (the bridge-mcp proxy no longer records —
// it forwards agentId/projectId in the arguments), and Path-B HTTP / CLI calls
// hit the same handlers directly. Row = {ts, tool, cwd, agentId, projectId}
// (join keys nullable — third-party clients don't send them). Append-only
// JSONL; O_APPEND writes under PIPE_BUF are atomic on Unix. Windows can throw
// EBUSY/EPERM on concurrent appends → small randomized retry (implplan §0.5).
const ADOPTION_DIR = process.env['CODEGRAPH_ADOPTION_DIR'] ?? path.join(os.homedir(), '.jerico', 'codegraph')
const ADOPTION_FILE = path.join(ADOPTION_DIR, 'adoption.jsonl')
let adoptionDirCreated = false

function appendLineSyncRetry(file: string, line: string, attempts = 3): void {
  for (let i = 0; ; i++) {
    try {
      fs.appendFileSync(file, line)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if ((code === 'EBUSY' || code === 'EPERM') && i < attempts - 1) {
        // Synchronous randomized backoff (5–25ms) — Atomics.wait is the only
        // sync sleep; fine at this call rate (hook/CLI/MCP, not hot path).
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 20))
        continue
      }
      throw err
    }
  }
}

interface AdoptionExtra {
  eventId: string
  referencedFiles: string[]
  referencedBytes: number
  resultBytes: number
}

/**
 * Per-session dedupe of claimed files. The engine process lifetime IS the
 * session boundary; a restart clears the map, which is conservative (never
 * over-claims). Key = agent::project fallback to cwd for CLI/agentless calls.
 */
const claimedFilesPerSession = new Map<string, Set<string>>()

function sessionKey(agentId: string | null | undefined, projectId: string | null | undefined, cwd: string | null | undefined): string {
  return `${agentId ?? cwd ?? 'unknown'}::${projectId ?? cwd ?? 'unknown'}`
}

function dedupeReferencedFiles(key: string, files: string[]): string[] {
  let set = claimedFilesPerSession.get(key)
  if (!set) {
    set = new Set<string>()
    claimedFilesPerSession.set(key, set)
  }
  const newFiles: string[] = []
  for (const f of files) {
    if (!set.has(f)) {
      set.add(f)
      newFiles.push(f)
    }
  }
  return newFiles
}

function recordAdoption(tool: string, cwd: string | null, agentId?: string | null, projectId?: string | null, extra?: AdoptionExtra): void {
  try {
    if (!adoptionDirCreated) {
      fs.mkdirSync(ADOPTION_DIR, { recursive: true })
      adoptionDirCreated = true
    }
    const row: Record<string, unknown> = {
      ts: new Date().toISOString(),
      tool,
      cwd: cwd ?? null,
      agentId: agentId ?? null,
      projectId: projectId ?? null,
    }
    if (extra) {
      row.eventId = extra.eventId
      row.referencedFiles = extra.referencedFiles
      row.referencedBytes = extra.referencedBytes
      row.resultBytes = extra.resultBytes
    }
    const line = JSON.stringify(row) + '\n'
    appendLineSyncRetry(ADOPTION_FILE, line)
  } catch (err) {
    console.error('[codegraph] adoption log write failed', String(err))
  }
}

// ── Adoption stats CLI (Phase 1-D, spec §11) ────────────────────────────────
// `jerico-codegraph adoption-stats` prints the adoption counter tallies from
// ~/.jerico/codegraph/adoption.jsonl (written by THIS server on every
// bridge_codegraph_* call — proxy, Path-B HTTP, and CLI all land here).
// Kept in the codegraph bin so the measurement lives next to the tool it
// counts. Early-exits before any server starts so it never contends with a
// running codegraph instance.
function runAdoptionStats(): void {
  const dir = ADOPTION_DIR
  const file = path.join(dir, 'adoption.jsonl')
  if (!fs.existsSync(file)) {
    console.log('No adoption data yet. The bridge-mcp server writes ~/.jerico/codegraph/adoption.jsonl on every bridge_codegraph_* call.')
    return
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const perTool = new Map<string, number>()
  let withCwd = 0
  let withAgentId = 0
  for (const l of lines) {
    try {
      const rec = JSON.parse(l) as { tool?: string; cwd?: string | null; agentId?: string | null; projectId?: string | null }
      if (!rec.tool) continue
      perTool.set(rec.tool, (perTool.get(rec.tool) ?? 0) + 1)
      if (rec.cwd) withCwd++
      if (rec.agentId) withAgentId++
    } catch { /* skip malformed line */ }
  }
  const total = [...perTool.values()].reduce((a, b) => a + b, 0)
  console.log(`Codegraph adoption (Phase 1-D proxy) — ${total} total bridge_codegraph_* calls`)
  if (total === 0) {
    console.log('  (no calls recorded yet)')
    return
  }
  const max = Math.max(...[...perTool.keys()].map(k => k.length))
  for (const [tool, n] of [...perTool.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tool.padEnd(max)}  ${String(n).padStart(4)}`)
  }
  console.log(`  calls with cwd resolved: ${withCwd}/${total}`)
  console.log(`  calls with agentId join key: ${withAgentId}/${total} (rows pre-Step-2 lack it)`)
  console.log('NOTE: native Read/Grep are Claude-Code built-ins not visible to the mcp-server,')
  console.log('      so this is a codegraph-call proxy, not a find_symbol-vs-Grep split (Phase-2 tightening).')
}

if (process.argv[2] === 'adoption-stats') {
  runAdoptionStats()
  process.exit(0)
}

// ── PreToolUse structural lookup (Phase 3, Layer 3) ─────────────────────────
// `jerico-codegraph structural --pattern X --cwd Y [--limit N]` returns the
// structural equivalent of a Grep/Glob textual search: the symbols whose name
// matches X in project Y. Early-exits before any server starts so it never
// contends with a running codegraph instance and can be safely spawned by a
// PreToolUse hook hundreds of times per session. Output is JSON on stdout so the
// hook can parse it; `--quiet` suppresses the trailing note lines AND the
// adoption log row — the hook spawns `structural --quiet`
// (codegraph-discovery-gate.mjs), and logging hook-triggered lookups would
// inflate the adoption numerator (~50% false adoption — implplan §0.3).
function runStructural(): void {
  const argv = process.argv.slice(3)
  let pattern = ''
  let cwd = process.cwd()
  let limit = 20
  let quiet = false
  let agentId: string | undefined
  let projectId: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pattern') pattern = argv[++i] ?? ''
    else if (argv[i] === '--cwd') cwd = argv[++i] ?? process.cwd()
    else if (argv[i] === '--limit') limit = parseInt(argv[++i] ?? '20', 10) || 20
    else if (argv[i] === '--quiet') quiet = true
    else if (argv[i] === '--agentId') agentId = argv[++i]
    else if (argv[i] === '--projectId') projectId = argv[++i]
  }
  if (!pattern) {
    console.log(JSON.stringify({ ok: false, error: 'no --pattern provided' }))
    process.exit(0)
  }
  ;(async () => {
    try {
      const engine = Engine.get()
      const project = await engine.getProject(cwd)
      // Ensure the project is indexed (no-op if already indexed). The hook can't
      // assume a prior bridge_codegraph_index call — Grep/Glob can fire on any
      // project at any time. force:false means this is a cheap incremental refresh.
      project.index(false)
      await engine.withFreshSnapshot(cwd, snapshot => {
        const res = snapshot.structuralLookup(pattern, limit)
        const out = {
          ok: true,
          pattern,
          cwd,
          strategy: res.strategy,
          results: res.results,
          indexed: res.results.length,
          resolutionCoverage: res.resolutionCoverage,
        }
        const outText = JSON.stringify(out)
        console.log(outText)
        if (!quiet) {
          // Interactive/CLI usage only — hook-triggered (--quiet) lookups are NOT
          // adoption. Join keys: flags, else the panel env the daemon injects.
          const extractedFiles = extractReferencedFiles('bridge_codegraph_structural', out)
          const resolvedAgentId = agentId ?? process.env['BRIDGE_PANEL_ID'] ?? process.env['AGENT_ID'] ?? null
          const resolvedProjectId = projectId ?? process.env['BRIDGE_PROJECT_ID'] ?? process.env['PROJECT_ID'] ?? null
          const key = sessionKey(resolvedAgentId, resolvedProjectId, cwd)
          const referencedFiles = dedupeReferencedFiles(key, extractedFiles)
          const referencedBytes = snapshot.bytesForFiles(referencedFiles)
          const resultBytes = Buffer.byteLength(outText)
          recordAdoption(
            'bridge_codegraph_structural',
            cwd,
            resolvedAgentId,
            resolvedProjectId,
            { eventId: randomUUID(), referencedFiles, referencedBytes, resultBytes },
          )
          console.error(`[codegraph] structural lookup "${pattern}" -> ${res.results.length} symbol(s) (${res.strategy})`)
        }
      })
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    }
    process.exit(0)
  })()
}

if (process.argv[2] === 'structural') {
  runStructural()
}

// `jerico-codegraph index --cwd Y [--force]` runs a full/incremental index to
// completion IN THIS PROCESS and exits. The MCP server spawns this as a child
// (CODEGRAPH_INDEX_CHILD=1) so the synchronous index never blocks the engine loop.
function runIndex(): void {
  const argv = process.argv.slice(3)
  let cwd = process.cwd()
  let force = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') cwd = argv[++i] ?? process.cwd()
    else if (argv[i] === '--force') force = true
  }
  ;(async () => {
    try {
      const engine = Engine.get()
      const project = await engine.getProject(cwd)
      const res = project.index(force)
      console.log(JSON.stringify({ ok: true, cwd, ...res }))
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    }
    process.exit(0)
  })()
}

if (process.argv[2] === 'index') {
  runIndex()
}

// ── Adoption-gate evaluator (spec §11) ──────────────────────────────────────
// `jerico-codegraph adoption-gate` reads ~/.jerico/codegraph/adoption.jsonl and
// computes the Phase-3 adoption metrics against the ASSUMED targets
// (≥15% adoption / ≥30% token reduction). Prints a PASS / FAIL / KILL / PENDING
// verdict. Real adoption needs weeks of live agent use — NOT produced here — so
// the default verdict is PENDING (mechanism ready, adoption UNMEASURED).
const ASSUMED_TARGETS = {
  adoption: 0.15,
  tokenReduction: 0.30,
  hookGraceWeeks: 2,
}

function runAdoptionGate(): void {
  const dir = ADOPTION_DIR
  const file = path.join(dir, 'adoption.jsonl')
  const grepFile = path.join(dir, 'grep-counts.jsonl')

  let lines: string[] = []
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  }
  const recs = lines.map(l => {
    try { return JSON.parse(l) as { ts?: number | string; tool?: string; cwd?: string | null; pattern?: string; agentId?: string | null; projectId?: string | null } }
    catch { return null }
  }).filter((r): r is NonNullable<typeof r> => r !== null && !!r.tool)

  const perTool = new Map<string, number>()
  const perProject = new Map<string, number>()
  let hookInjects = 0
  for (const r of recs) {
    perTool.set(r.tool!, (perTool.get(r.tool!) ?? 0) + 1)
    if (r.cwd) perProject.set(r.cwd, (perProject.get(r.cwd) ?? 0) + 1)
    if (r.tool === 'codegraph_hook_inject') hookInjects++
  }

  const codegraphCalls = [...perTool.entries()]
    .filter(([t]) => t.startsWith('bridge_codegraph_'))
    .reduce((a, [, n]) => a + n, 0)

  // Denominator proxy: native Grep is a Claude-Code built-in NOT visible to the
  // mcp server, so adoption.jsonl has no Grep rows. Optionally a side-channel
  // (grep-counts.jsonl, e.g. parsed from session transcripts) supplies the
  // Grep denominator; if absent we fall back to reporting codegraph calls per
  // session/project and flag the ratio as UNMEASURED.
  let grepCalls = 0
  let grepSource = 'unavailable'
  if (fs.existsSync(grepFile)) {
    const g = fs.readFileSync(grepFile, 'utf8').split('\n').filter(Boolean)
    grepCalls = g.reduce((acc, l) => {
      try { const o = JSON.parse(l) as { count?: number }; return acc + (o.count ?? 1) } catch { return acc + 1 }
    }, 0)
    grepSource = 'grep-counts.jsonl'
  }

  // Only compute a real proxy when we actually have a Grep denominator. With
  // native Grep unlogged (the default), codegraphCalls/(codegraphCalls+0) would
  // falsely read 100% — so the proxy is UNMEASURED until a Grep source exists.
  const adoptionProxy = grepSource !== 'unavailable'
    ? (codegraphCalls + grepCalls) > 0 ? codegraphCalls / (codegraphCalls + grepCalls) : undefined
    : undefined
  const hookActive = hookInjects > 0

  // Token delta is only measurable with per-turn token logs; not collected here.
  const tokenReduction: number | undefined = undefined

  // ── Verdict logic ──
  let verdict: string
  let rationale: string
  if (adoptionProxy === undefined) {
    verdict = 'PENDING'
    rationale = 'adoption proxy UNMEASURED — Grep denominator unavailable (native Grep not logged). Mechanism ready; decision deferred to live data.'
  } else if (adoptionProxy >= ASSUMED_TARGETS.adoption && (tokenReduction === undefined || tokenReduction >= ASSUMED_TARGETS.tokenReduction)) {
    verdict = 'PASS'
    rationale = `adoption proxy ${(adoptionProxy * 100).toFixed(1)}% ≥ assumed target 15%.`
  } else if (adoptionProxy < 0.05 && !hookActive) {
    verdict = 'FAIL'
    rationale = `adoption proxy ${(adoptionProxy * 100).toFixed(1)}% < 5% — cheap lever failed. Activate the opt-in PreToolUse hook before decommissioning.`
  } else if (hookActive && adoptionProxy < ASSUMED_TARGETS.adoption) {
    verdict = 'KILL'
    rationale = `opt-in hook active (${hookInjects} injects) but adoption proxy ${(adoptionProxy * 100).toFixed(1)}% still < 15% — decommission codegraph.`
  } else {
    verdict = 'PENDING'
    rationale = `adoption proxy ${(adoptionProxy * 100).toFixed(1)}% in 5–15% band or data insufficient — observe ${ASSUMED_TARGETS.hookGraceWeeks} weeks of live use, then re-evaluate.`
  }

  console.log('=== Codegraph Adoption Gate (spec §11) ===')
  console.log(`codegraph tool calls : ${codegraphCalls}`)
  console.log(`  per tool          : ${[...perTool.entries()].map(([t, n]) => `${t}=${n}`).join(', ') || '(none)'}`)
  console.log(`Grep calls (denom) : ${grepCalls} (source: ${grepSource})`)
  console.log(`adoption proxy      : ${adoptionProxy === undefined ? 'UNMEASURED' : (adoptionProxy * 100).toFixed(1) + '%'}`)
  console.log(`  target            : ≥${(ASSUMED_TARGETS.adoption * 100).toFixed(0)}% (ASSUMED — recalibrate after 2 weeks live data)`)
  console.log(`hook injects       : ${hookInjects} ${hookActive ? '(hook ACTIVE)' : '(hook not engaged / not opt-in)'}`)
  console.log(`token reduction     : ${tokenReduction === undefined ? 'UNMEASURED (no per-turn token logs)' : (tokenReduction * 100).toFixed(1) + '% (target ≥30%, ASSUMED)'}`)
  console.log(`projects indexed    : ${perProject.size}`)
  console.log(`VERDICT            : ${verdict}`)
  console.log(`  ${rationale}`)
}

if (process.argv[2] === 'adoption-gate') {
  runAdoptionGate()
  process.exit(0)
}

// ── Transcript stats CLI (Step 4a, implplan §3.5) ───────────────────────────
// `jerico-codegraph transcript-stats (--session <uuid|path> | --file <path>) [--json]`
// parses a Claude Code session transcript (main + subagents/*.jsonl) into the
// per-run token/tool stats JSON. Dedupes usage by message.id (naive per-line
// summing overcounts ~2.28×). Early-exits before any server starts. The parser
// module itself (transcript-stats.ts) is pure — no engine import.
async function runTranscriptStats(): Promise<void> {
  const argv = process.argv.slice(3)
  let session = ''
  let file = ''
  let asJson = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') session = argv[++i] ?? ''
    else if (argv[i] === '--file') file = argv[++i] ?? ''
    else if (argv[i] === '--json') asJson = true
  }
  if (!session && !file) {
    console.error('usage: jerico-codegraph transcript-stats (--session <uuid|path> | --file <path>) [--json]')
    process.exit(1)
  }
  try {
    let files
    let sessionId: string
    if (file || session.endsWith('.jsonl') || session.includes('/')) {
      const p = file || session
      files = await locateSessionFilesFromPath(p)
      sessionId = path.basename(p).replace(/\.jsonl$/, '')
    } else {
      const found = await locateSessionFiles(session)
      if (!found) {
        console.error(JSON.stringify({ ok: false, error: `session not found under ~/.claude/projects: ${session}` }))
        process.exit(1)
      }
      files = found
      sessionId = session
    }
    const stats = await computeTranscriptStats(files, sessionId)
    if (asJson) {
      console.log(JSON.stringify(stats, null, 2))
    } else {
      const t = stats.totals
      console.log(`session ${stats.sessionId} (${stats.projectSlug ?? '?'})`)
      console.log(`  turns            : ${stats.turns} (unique message.id, deduped)`)
      console.log(`  tokens           : input=${t.input} cacheCreation=${t.cacheCreation} cacheRead=${t.cacheRead} output=${t.output}`)
      console.log(`  subagent tokens  : input=${stats.subagentTotals.input} cacheCreation=${stats.subagentTotals.cacheCreation} cacheRead=${stats.subagentTotals.cacheRead} output=${stats.subagentTotals.output} (${stats.files.subagents.length} files)`)
      console.log(`  attributed turns : ${stats.attributed.turns} (codegraph|nativeSearch) → cacheRead=${stats.attributed.tokens.cacheRead} output=${stats.attributed.tokens.output}`)
      console.log(`  residual tokens  : cacheRead=${stats.residual.tokens.cacheRead} output=${stats.residual.tokens.output}`)
      console.log(`  tool buckets     : codegraph=${stats.buckets.codegraph} nativeSearch=${stats.buckets.nativeSearch} other=${stats.buckets.other}`)
      console.log(`  result bytes     : codegraph=${stats.resultBytes.codegraph} nativeSearch=${stats.resultBytes.nativeSearch} other=${stats.resultBytes.other}`)
      const top = Object.entries(stats.tools).slice(0, 10).map(([n, c]) => `${n}=${c}`).join(', ')
      console.log(`  top tools        : ${top || '(none)'}`)
      console.log(`  anomalyCount=${stats.anomalyCount} hadCompaction=${stats.hadCompaction} truncatedTail=${stats.truncatedTail}`)
    }
    process.exit(0)
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    process.exit(1)
  }
}

if (process.argv[2] === 'transcript-stats') {
  void runTranscriptStats()
}

// The A/B harness (ab-run / ab-report) is private tooling and is no longer part
// of this package. Refuse explicitly and synchronously — falling through would
// start the MCP server and hang a caller expecting a measurement run.
if (process.argv[2] === 'ab-run' || process.argv[2] === 'ab-report') {
  console.error(
    `[codegraph] '${process.argv[2]}' is not part of jerico-codegraph. ` +
    `The A/B harness is private repo tooling: bun scripts/codegraph-ab/cli.ts ${process.argv[2]} …`,
  )
  process.exit(2)
}

let httpServerRef: ReturnType<typeof createServer> | null = null
let shuttingDown = false

/**
 * F6: when codegraph is launched in daemon (stdio) mode its stdin is the pipe to
 * the parent daemon. If the daemon dies — including SIGKILL, which can't be
 * caught by the daemon so it never gets to SIGTERM us — that pipe closes and
 * stdin emits 'end'/'close'. The HTTP server otherwise keeps our event loop
 * alive forever, leaving an orphaned codegraph process. On EOF we close the HTTP
 * server and exit so the parent's death always reaps us.
 */
function selfExitOnParentDeath(reason: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.error(`[codegraph] parent stdio closed (${reason}) — self-exiting`)
  try { httpServerRef?.close() } catch {}
  for (const s of sessions.values()) {
    try { s.transport.close?.() } catch {}
  }
  // Give close() a beat; force-exit regardless so we never linger.
  setTimeout(() => process.exit(0), 100).unref()
}

interface Session {
  transport: StreamableHTTPServerTransport
}
const sessions = new Map<string, Session>()

type CodegraphProject = Awaited<ReturnType<Engine['getProject']>>

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  [key: string]: unknown
}

/**
 * Every codegraph tool result (success AND error) MUST be valid JSON so that the
 * daemon relay + any MCP client can JSON.parse it. Errors are returned as
 * `{ "error": "..." }` content with `isError: true` instead of throwing, because
 * a thrown error becomes a raw, non-JSON string that breaks JSON.parse upstream.
 */
function okContent(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

function errorContent(cwd: string, err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err)
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: `Codegraph error for ${cwd}: ${msg}` }) }],
    isError: true,
  }
}

interface ReferencedFileResult {
  ok: true
  referencedFiles: string[]
  data: unknown
}
interface ReferencedFileError {
  ok: false
  error: ToolResult
}
type ReferencedFileOutcome = ReferencedFileResult | ReferencedFileError

/** Extract distinct `file` values from a tool result for the savings counter. */
function extractReferencedFiles(tool: string, data: unknown): string[] {
  const files = new Set<string>()
  if (!data || typeof data !== 'object') return []
  const d = data as Record<string, unknown>
  switch (tool) {
    case 'bridge_codegraph_find_symbol':
    case 'bridge_codegraph_file_outline': {
      const results = Array.isArray(d['results']) ? d['results'] : []
      for (const r of results) {
        if (r && typeof r === 'object' && typeof (r as Record<string, unknown>)['file'] === 'string') {
          files.add((r as Record<string, unknown>)['file'] as string)
        }
      }
      break
    }
    case 'bridge_codegraph_find_references': {
      const refs = Array.isArray(d['references']) ? d['references'] : []
      for (const r of refs) {
        if (r && typeof r === 'object' && typeof (r as Record<string, unknown>)['callerFile'] === 'string') {
          files.add((r as Record<string, unknown>)['callerFile'] as string)
        }
      }
      break
    }
    case 'bridge_codegraph_call_graph': {
      const nodes = Array.isArray(d['nodes']) ? d['nodes'] : []
      for (const n of nodes) {
        if (n && typeof n === 'object' && typeof (n as Record<string, unknown>)['file'] === 'string') {
          files.add((n as Record<string, unknown>)['file'] as string)
        }
      }
      break
    }
    case 'bridge_codegraph_get_symbol_source': {
      const source = d['source']
      if (typeof source === 'string' && source.length > 0) {
        const file = d['file']
        if (typeof file === 'string' && file.length > 0) {
          files.add(file)
        }
      }
      break
    }
    case 'bridge_codegraph_diff_impact': {
      const changed = Array.isArray(d['changedFiles']) ? d['changedFiles'] : []
      for (const f of changed) if (typeof f === 'string') files.add(f)
      const impacted = Array.isArray(d['impactedSymbols']) ? d['impactedSymbols'] : []
      for (const s of impacted) {
        if (s && typeof s === 'object' && typeof (s as Record<string, unknown>)['file'] === 'string') {
          files.add((s as Record<string, unknown>)['file'] as string)
        }
      }
      break
    }
    case 'bridge_codegraph_structural': {
      const results = Array.isArray(d['results']) ? d['results'] : []
      for (const r of results) {
        if (r && typeof r === 'object' && typeof (r as Record<string, unknown>)['file'] === 'string') {
          files.add((r as Record<string, unknown>)['file'] as string)
        }
      }
      break
    }
  }
  return [...files]
}

async function runToolWithRefs(
  tool: string,
  cwd: string,
  agentId: string | null | undefined,
  projectId: string | null | undefined,
  fn: (p: CodegraphProject) => unknown,
  extraReferencedFiles?: string[],
): Promise<ToolResult> {
  try {
    return await engine.withFreshSnapshot(cwd, project => {
      const data = fn(project)
      if (data && typeof (data as { then?: unknown }).then === 'function') throw new Error('Codegraph query callback must be synchronous')
      const resultText = JSON.stringify(data)
      const extractedFiles = extractReferencedFiles(tool, data)
      const allReferencedFiles = [...new Set([...extractedFiles, ...(extraReferencedFiles ?? [])])]
      const key = sessionKey(agentId, projectId, cwd)
      const referencedFiles = dedupeReferencedFiles(key, allReferencedFiles)
      const referencedBytes = project.bytesForFiles(referencedFiles)
      const resultBytes = Buffer.byteLength(resultText)
      recordAdoption(tool, cwd, agentId ?? null, projectId ?? null, { eventId: randomUUID(), referencedFiles, referencedBytes, resultBytes })
      return okContent(data)
    })
  } catch (err) {
    return errorContent(cwd, err)
  }
}

async function runTool<T>(
  cwd: string,
  fn: (p: CodegraphProject) => Promise<T>,
): Promise<ToolResult> {
  try {
    const project = await engine.getProject(cwd)
    return okContent(await fn(project))
  } catch (err) {
    return errorContent(cwd, err)
  }
}

// ── Child-process indexer (fix for the respawn loop) ───────────────────────────
// A full index blocks the engine's single event loop (better-sqlite3 + tree-sitter
// are synchronous) long enough to trip the daemon health-ping → the supervisor kills
// and respawns the engine → the index restarts from scratch → infinite loop (observed
// 461% CPU on a real Mac). The SAME index() runs fine standalone (~2.5s), so the MCP
// server offloads indexing to a child process (the `index` CLI subcommand, re-entered
// with CODEGRAPH_INDEX_CHILD=1) and stays responsive to pings/status/queries.
const activeIndexChildren = new Map<string, ChildProcess>()

function isPkg(): boolean {
  return 'pkg' in process && typeof (process as { pkg?: unknown }).pkg !== 'undefined'
}

function selfEntry(): string {
  // dev/npm: the running dist entry (process.argv[1]); the child re-enters as `index`.
  return process.argv[1] ?? path.join(__dirname, 'index.cjs')
}

interface IndexChildResult {
  status: 'indexed'
  total: number
  unsupportedLanguages: string[]
}

function spawnIndexChild(cwd: string, force: boolean): Promise<IndexChildResult> {
  return new Promise<IndexChildResult>((resolve, reject) => {
    // pkg binary: re-enter via the daemon's `codegraph` carrier subcommand (which
    // forwards to codegraph.cjs). A bare `index` would hit the daemon Commander that
    // has no top-level `index` → "unknown command 'index'". Dev keeps selfEntry().
    // win32 pkg has no codegraph build yet (mirrors client.ts win32 deferral) → dev branch.
    let command: string
    let args: string[]
    if (isPkg() && process.platform !== 'win32') {
      // pkg re-injects PKG_EXECPATH when spawn command === execPath; the shell wrapper
      // avoids that so the child boots in app mode and routes `codegraph index` correctly.
      command = '/bin/sh'
      args = ['-c', 'unset PKG_EXECPATH; exec "$0" "$@"', process.execPath, 'codegraph', 'index', '--cwd', cwd]
    } else {
      command = process.execPath
      args = [selfEntry(), 'index', '--cwd', cwd]
    }
    if (force) args.push('--force')

    // Strip PKG_EXECPATH (pkg re-bootstraps in node-compat mode otherwise) and flag the
    // child so it never starts the stdio/HTTP servers.
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'PKG_EXECPATH') childEnv[k] = v
    }
    childEnv['CODEGRAPH_INDEX_CHILD'] = '1'
    childEnv['CODEGRAPH_STDIO'] = '0'

    // Generous timeout: full jerico-scale index takes ~2.5-3s (per d73993cc commit
    // message); 10 minutes covers legitimately slow hardware/large repos while still
    // catching a genuine hang. Override via CODEGRAPH_INDEX_CHILD_TIMEOUT_MS (tests use
    // a short value; production always uses the default).
    const timeoutMs = Number(process.env['CODEGRAPH_INDEX_CHILD_TIMEOUT_MS'] ?? 600_000)

    let stderrBuf = ''
    let stdoutBuf = ''
    const child = spawn(command, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    activeIndexChildren.set(cwd, child)

    // Reap the child if it hangs. detached:false so we kill the PID directly.
    const reapTimer = setTimeout(() => {
      process.stderr.write(`[codegraph] index child for ${cwd} timed out after ${timeoutMs}ms, killing pid ${child.pid}\n`)
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      activeIndexChildren.delete(cwd)
      reject(new Error(`[codegraph] index child for ${cwd} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stdoutBuf += text
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderrBuf = (stderrBuf + text).slice(-4000)
      process.stderr.write(text)
    })
    child.on('exit', (code) => {
      clearTimeout(reapTimer)
      activeIndexChildren.delete(cwd)
      if (code === 0) {
        // The child prints `{ ok:true, cwd, status, total, ... }` (runIndex:251). Parse
        // the last non-empty JSON line; fall back to a bare success if parse misses so a
        // successful index never fails on a formatting quirk.
        const lines = stdoutBuf.split('\n').filter(l => l.trim().length > 0)
        const result: IndexChildResult = { status: 'indexed', total: 0, unsupportedLanguages: [] }
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]) as { ok?: boolean; total?: number; unsupportedLanguages?: unknown }
            if (parsed && parsed.ok === true) {
              if (typeof parsed.total === 'number') result.total = parsed.total
              if (Array.isArray(parsed.unsupportedLanguages)) {
                result.unsupportedLanguages = parsed.unsupportedLanguages.filter((l): l is string => typeof l === 'string')
              }
              break
            }
          } catch { /* keep scanning earlier lines */ }
        }
        resolve(result)
      } else {
        const tail = stderrBuf.trim().slice(-2000)
        reject(new Error(`index child exited with code ${code}${tail ? `: ${tail}` : ''}`))
      }
    })
    child.on('error', (err) => { clearTimeout(reapTimer); activeIndexChildren.delete(cwd); reject(err) })
  })
}

function buildMcpServer(): McpServer {
  const srv = new McpServer({ name: 'codegraph', version: '0.1.0' })

  srv.tool(
    'bridge_codegraph_status',
    {
      cwd: z.string().default(process.cwd()),
      agentId: z.string().nullish(),
      projectId: z.string().nullish(),
    },
    async ({ cwd, agentId, projectId }) => {
      recordAdoption('bridge_codegraph_status', cwd, agentId, projectId)
      return runTool(cwd, async (p) => p.status(engine.getOpenDbCount()))
    },
  )

  srv.tool(
    'bridge_codegraph_index',
    {
      cwd: z.string().default(process.cwd()),
      force: z.boolean().optional().default(false),
      wait: z.boolean().optional().default(true),
      agentId: z.string().nullish(),
      projectId: z.string().nullish(),
    },
    async ({ cwd, force, wait, agentId, projectId }) => {
      recordAdoption('bridge_codegraph_index', cwd, agentId, projectId)
      // Offload the (blocking) index to a child process; the engine stays responsive.
      // unsupportedLanguages comes from the (memoized, cheap) cached inventory so the
      // signal is present on every response shape, not just the completed-index one.
      if (activeIndexChildren.has(cwd)) {
        const project = await engine.getProject(cwd)
        return okContent({ status: 'indexing', total: 0, unsupportedLanguages: project.status().unsupportedLanguages })
      }
      if (wait) {
        try {
          const res = await spawnIndexChild(cwd, force ?? false)
          return okContent({ status: res.status, total: res.total, unsupportedLanguages: res.unsupportedLanguages })
        } catch (e) {
          return errorContent(cwd, e)
        }
      }
      spawnIndexChild(cwd, force ?? false).catch(() => { /* fire-and-forget */ })
      const project = await engine.getProject(cwd)
      return okContent({ status: 'indexing', total: 0, unsupportedLanguages: project.status().unsupportedLanguages })
    },
  )

  srv.tool(
    'bridge_codegraph_find_symbol',
    {
      cwd: z.string().default(process.cwd()),
      name: z.string().min(1),
      kind: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().default(50),
      offset: z.number().int().min(0).optional().default(0),
      agentId: z.string().nullish(),
      projectId: z.string().nullish(),
    },
    async ({ cwd, name, kind, limit, offset, agentId, projectId }) => {
      return runToolWithRefs('bridge_codegraph_find_symbol', cwd, agentId, projectId, (p) => p.findSymbol(name, kind, limit, offset))
    },
  )

  srv.tool(
    'bridge_codegraph_file_outline',
    {
      cwd: z.string().default(process.cwd()),
      file: z.string(),
      agentId: z.string().nullish(),
      projectId: z.string().nullish(),
    },
    async ({ cwd, file, agentId, projectId }) => {
      return runToolWithRefs('bridge_codegraph_file_outline', cwd, agentId, projectId, (p) => p.fileOutline(file), [file])
    },
  )

  srv.tool(
    'bridge_codegraph_find_references',
    'Find all call/reference sites of a symbol ("who calls X") by qualified name, bare name, or dotted qualified suffix (for example, `packages/daemon/src/pty/manager.PtyManager`, `PtyManager`, or `PtyManager.spawn`). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.',
    {
      cwd: z.string().default(process.cwd()),
      qualifiedName: z
        .string()
        .min(1)
        .refine((s) => !s.includes('\0'), { message: 'NUL characters not allowed' })
        .describe('Symbol identifier: qualified name, bare name, or dotted qualified suffix (e.g. packages/daemon/src/pty/manager.PtyManager, PtyManager, or PtyManager.spawn). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.'),
      limit: z.number().int().min(1).max(200).optional().default(200),
      offset: z.number().int().min(0).safe().optional().default(0),
      agentId: z.string().nullish(),
      projectId: z.string().nullish(),
    },
    async ({ cwd, qualifiedName, limit, offset, agentId, projectId }) => {
      return runToolWithRefs('bridge_codegraph_find_references', cwd, agentId, projectId, (p) => p.findReferences(qualifiedName, limit, offset))
    },
  )

  srv.tool(
    'bridge_codegraph_call_graph',
    'Get the call graph (in/out/both) around a symbol by qualified name, bare name, or dotted qualified suffix (for example, `packages/daemon/src/pty/manager.PtyManager`, `PtyManager`, or `PtyManager.spawn`). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.',
    {
      cwd: z.string().default(process.cwd()),
      qualifiedName: z
        .string()
        .min(1)
        .refine((s) => !s.includes('\0'), { message: 'NUL characters not allowed' })
        .describe('Symbol identifier: qualified name, bare name, or dotted qualified suffix (e.g. packages/daemon/src/pty/manager.PtyManager, PtyManager, or PtyManager.spawn). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.'),
      direction: z.enum(['in', 'out', 'both']).optional().default('out'),
      depth: z.number().int().min(1).max(3).optional().default(2),
      agentId: z.string().nullish(),
      projectId: z.string().nullish(),
    },
    async ({ cwd, qualifiedName, direction, depth, agentId, projectId }) => {
      return runToolWithRefs('bridge_codegraph_call_graph', cwd, agentId, projectId, (p) => p.callGraph(qualifiedName, direction, depth))
    },
  )

  srv.tool(
    'bridge_codegraph_get_symbol_source',
    'Return the source snippet of a symbol by qualified name, bare name, or dotted qualified suffix (for example, `packages/daemon/src/pty/manager.PtyManager`, `PtyManager`, or `PtyManager.spawn`). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.',
    {
      cwd: z.string().default(process.cwd()),
      qualifiedName: z
        .string()
        .min(1)
        .refine((s) => !s.includes('\0'), { message: 'NUL characters not allowed' })
        .describe('Symbol identifier: qualified name, bare name, or dotted qualified suffix (e.g. packages/daemon/src/pty/manager.PtyManager, PtyManager, or PtyManager.spawn). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.'),
      agentId: z.string().nullish(),
      projectId: z.string().nullish(),
    },
    async ({ cwd, qualifiedName, agentId, projectId }) => {
      return runToolWithRefs('bridge_codegraph_get_symbol_source', cwd, agentId, projectId, (p) => p.getSymbolSource(qualifiedName))
    },
  )

  srv.tool(
    'bridge_codegraph_diff_impact',
    {
      cwd: z.string().default(process.cwd()),
      base: z.string().optional().describe('Git diff base ref (default HEAD — working tree vs HEAD)'),
      agentId: z.string().nullish(),
      projectId: z.string().nullish(),
    },
    async ({ cwd, base, agentId, projectId }) => {
      return runToolWithRefs('bridge_codegraph_diff_impact', cwd, agentId, projectId, (p) => p.diffImpact(base))
    },
  )

  return srv
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined
  return new Promise<unknown>((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: unknown) => { raw += String(chunk) })
    req.on('end', () => {
      try { resolve(JSON.parse(raw)) }
      catch { resolve(undefined) }
    })
    req.on('error', reject)
  })
}

async function startHttpServer(): Promise<void> {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && (url === '/health' || url === '/health/')) {
        const initError = engine.getInitError()
        const status = initError ? 'error' : 'ok'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: status === 'ok', status, sessions: sessions.size, initError: initError?.message ?? null }))
        return
      }

      if (url === '/mcp' && ['GET', 'POST', 'DELETE'].includes(method)) {
        const sessionId = (req.headers['mcp-session-id'] ?? '') as string
        const body = await parseBody(req)

        if (sessionId) {
          const session = sessions.get(sessionId)
          if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Session not found or expired' }))
            return
          }
          await session.transport.handleRequest(req, res, body)
          return
        }

        const sid = randomUUID()
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator:   () => sid,
          onsessioninitialized: (id) => { sessions.set(id, { transport }) },
          onsessionclosed:      (id) => { sessions.delete(id) },
        })
        const srv = buildMcpServer()
        await srv.connect(transport)
        await transport.handleRequest(req, res, body)
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    } catch (err) {
      console.error('[codegraph] request error:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    }
  })

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[codegraph] HTTP port ${CODEGRAPH_PORT} already in use — skipping HTTP door`)
    } else {
      console.error('[codegraph] HTTP server error:', err)
    }
  })

  httpServerRef = httpServer

  httpServer.listen(CODEGRAPH_PORT, '127.0.0.1', () => {
    console.error(`[codegraph] HTTP MCP server listening on 127.0.0.1:${CODEGRAPH_PORT}`)
  })
}

async function startStdioServer(): Promise<void> {
  const srv = buildMcpServer()
  const transport = new StdioServerTransport()

  // F6: self-exit when the parent daemon dies. stdin EOF is the reliable signal
  // for a SIGKILLed parent (no SIGTERM reaches us). This MUST only be armed
  // when codegraph is daemon-managed (the supervisor sets CODEGRAPH_MANAGED=1
  // and connects over the stdio pipe). In standalone / HTTP-only mode (external
  // tools on Path B, or any background launch with stdin closed) we must NOT
  // exit on stdin EOF — the HTTP server is the lifeline there, not the daemon.
  const managed = process.env['CODEGRAPH_MANAGED'] === '1'

  const prevOnClose = transport.onclose?.bind(transport)
  transport.onclose = () => {
    try { prevOnClose?.() } catch {}
    if (managed) selfExitOnParentDeath('transport_closed')
  }
  if (managed) {
    process.stdin.on('end', () => selfExitOnParentDeath('stdin_end'))
    process.stdin.on('close', () => selfExitOnParentDeath('stdin_close'))
  }

  await srv.connect(transport)
  console.error('[codegraph] connected via stdio')
}

// CLI subcommands (adoption-stats / structural / adoption-gate / transcript-stats)
// are self-contained and early-exit; never start the
// stdio/HTTP servers for them or they would bind a port / open a stdio pipe on
// every invocation (the hook spawns `structural` hundreds of times per session).
const CLI_SUBCOMMANDS = new Set(['adoption-stats', 'structural', 'index', 'adoption-gate', 'transcript-stats'])
const isCliInvocation = CLI_SUBCOMMANDS.has(process.argv[2] ?? '')

if (!isCliInvocation && process.env['CODEGRAPH_STDIO'] !== '0') {
  startStdioServer().catch(err => {
    console.error('[codegraph] stdio fatal:', err)
    process.exit(1)
  })
}

if (!isCliInvocation) {
  startHttpServer().catch(err => {
    console.error('[codegraph] HTTP startup fatal:', err)
  })
}
