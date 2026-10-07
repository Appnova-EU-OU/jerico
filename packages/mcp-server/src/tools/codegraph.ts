import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { type BridgeContext, getProject } from '../api.js'

// ── Adoption measurement (Phase 1-D, spec §11) ───────────────────────────────
// The SINGLE adoption counter lives in codegraph's OWN server
// (packages/codegraph/src/index.ts) — the proxy does NOT record (it would
// double-count: proxied calls flow through the own-server handler anyway).
// Instead the proxy forwards the join keys (agentId/projectId from ctx) in the
// call arguments so the own-server row carries them.
// NOTE: native Read/Grep are Claude-Code built-ins, NOT visible to this MCP
// server — so the Phase-1 denominator proxy is "codegraph tool calls per
// task/session". Full native-tool attribution (find_symbol vs Grep split) needs
// transcript parsing and is deferred to Phase-2 tightening (see ADOPTION doc).

// ── Codegraph HTTP door client (persistent, lazy) ─────────────────────────────
// Codegraph already names its tools `bridge_codegraph_*` and exposes them on its
// StreamableHTTP MCP door at 127.0.0.1:CODEGRAPH_PORT/mcp. We keep ONE MCP client
// session to that door and forward calls — the simplest correct proxy path.

const CODEGRAPH_PORT = parseInt(process.env['CODEGRAPH_PORT'] ?? '3201', 10)

let clientPromise: Promise<Client> | null = null

function getCodegraphClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new Client(
        { name: 'bridge-mcp-codegraph-proxy', version: '0.1.0' },
        { capabilities: {} },
      )
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${CODEGRAPH_PORT}/mcp`),
      )
      await client.connect(transport)
      return client
    })().catch((err) => {
      clientPromise = null // allow retry on next call
      throw err
    })
  }
  return clientPromise
}

async function resolveCwd(ctx: BridgeContext, cwd?: string): Promise<string> {
  if (cwd && cwd.trim()) return cwd
  try {
    const p = await getProject(ctx)
    if (p.cwd) return p.cwd
  } catch { /* fall through */ }
  return process.cwd()
}

type ProxyResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

async function proxy(
  ctx: BridgeContext,
  toolName: string,
  rawArgs: Record<string, unknown>,
): Promise<ProxyResult> {
  const cwd = await resolveCwd(ctx, rawArgs['cwd'] as string | undefined)
  try {
    const client = await getCodegraphClient()
    // Forward the join keys from ctx (undefined keys are dropped by JSON
    // serialization) — the own-server's recordAdoption is the single counter.
    const res = await client.callTool({
      name: toolName,
      arguments: { ...rawArgs, cwd, agentId: ctx.agentId, projectId: ctx.projectId },
    })
    return {
      content: res.content as ProxyResult['content'],
      isError: res.isError === true,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Codegraph proxy error: ${msg}` }) }],
      isError: true,
    }
  }
}

export function registerCodegraphTools(server: McpServer, ctx: BridgeContext): void {
  const P = (name: string, args: Record<string, unknown>) => proxy(ctx, name, args)

  // status ───────────────────────────────────────────────────────────────────
  server.tool(
    'bridge_codegraph_status',
    'Codegraph index status + resolution coverage for a project (health/coverage probe). Prefer over reading whole files for structural questions. Returns {indexed, total, coverage:{resolved,unresolved}, unsupportedLanguages}. If unsupportedLanguages is non-empty and total is 0 (or the project is polyglot and a language you care about is listed), codegraph has no grammar for that code — fall back to Grep/Read for it instead of trusting empty structural results.',
    { cwd: z.string().optional().describe('Project root. Defaults to the bridge project cwd.') },
    ({ cwd }) => P('bridge_codegraph_status', { cwd }),
  )

  // index ────────────────────────────────────────────────────────────────────
  server.tool(
    'bridge_codegraph_index',
    'Index (or refresh) a project for codegraph structural queries. Call before find_symbol etc. if status shows not-indexed. Prefer over broad Grep for structural discovery. Response includes unsupportedLanguages: string[] — if your language of interest appears there, codegraph cannot see that code (no grammar); use Grep/Read for it instead.',
    {
      cwd: z.string().optional().describe('Project root. Defaults to the bridge project cwd.'),
      force: z.boolean().optional().describe('Re-index from scratch'),
      wait: z.boolean().optional().describe('Wait for indexing to finish (default true)'),
    },
    ({ cwd, force, wait }) => P('bridge_codegraph_index', { cwd, force, wait }),
  )

  // find_symbol ──────────────────────────────────────────────────────────────
  server.tool(
    'bridge_codegraph_find_symbol',
    'Find a symbol by name (and optional kind) in the indexed project. PREFER over Read/Grep for "where is X defined". Limits/offset supported for pagination.',
    {
      name: z.string().min(1).describe('Symbol name to find (substring match, ranked exact > prefix > contains). Response includes truncated:true + totalMatches when there are more matches than the limit — refine the query rather than raising limit for a very short/common substring.'),
      kind: z.string().optional().describe('Optional symbol kind filter (function, class, method, ...)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50, capped at 200)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
      cwd: z.string().optional().describe('Project root. Defaults to the bridge project cwd.'),
    },
    ({ name, kind, limit, offset, cwd }) =>
      P('bridge_codegraph_find_symbol', { name, kind, limit, offset, cwd }),
  )

  // file_outline ─────────────────────────────────────────────────────────────
  server.tool(
    'bridge_codegraph_file_outline',
    'Return the structural outline (symbols + signatures) of a single file. PREFER over reading the whole file when you only need its shape.',
    {
      file: z.string().describe('Path to the file to outline'),
      cwd: z.string().optional().describe('Project root. Defaults to the bridge project cwd.'),
    },
    ({ file, cwd }) => P('bridge_codegraph_file_outline', { file, cwd }),
  )

  // find_references ──────────────────────────────────────────────────────────
  server.tool(
    'bridge_codegraph_find_references',
    'Find all call/reference sites of a symbol ("who calls X") by qualified name, bare name, or dotted qualified suffix (for example, `packages/daemon/src/pty/manager.PtyManager`, `PtyManager`, or `PtyManager.spawn`). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.',
    {
      qualifiedName: z
        .string()
        .min(1)
        .refine((s) => !s.includes('\0'), { message: 'NUL characters not allowed' })
        .describe('Symbol identifier: qualified name, bare name, or dotted qualified suffix (e.g. packages/daemon/src/pty/manager.PtyManager, PtyManager, or PtyManager.spawn). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.'),
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default 200)'),
      offset: z.number().int().min(0).safe().optional().describe('Pagination offset (default 0)'),
      cwd: z.string().optional().describe('Project root. Defaults to the bridge project cwd.'),
    },
    ({ qualifiedName, limit, offset, cwd }) =>
      P('bridge_codegraph_find_references', { qualifiedName, limit, offset, cwd }),
  )

  // call_graph ───────────────────────────────────────────────────────────────
  server.tool(
    'bridge_codegraph_call_graph',
    'Get the call graph (in/out/both) around a symbol by qualified name, bare name, or dotted qualified suffix (for example, `packages/daemon/src/pty/manager.PtyManager`, `PtyManager`, or `PtyManager.spawn`). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.',
    {
      qualifiedName: z
        .string()
        .min(1)
        .refine((s) => !s.includes('\0'), { message: 'NUL characters not allowed' })
        .describe('Symbol identifier: qualified name, bare name, or dotted qualified suffix (e.g. packages/daemon/src/pty/manager.PtyManager, PtyManager, or PtyManager.spawn). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.'),
      direction: z.enum(['in', 'out', 'both']).optional().describe('Edge direction (default out)'),
      depth: z.number().int().min(1).max(3).optional().describe('Traversal depth 1-3 (default 2)'),
      cwd: z.string().optional().describe('Project root. Defaults to the bridge project cwd.'),
    },
    ({ qualifiedName, direction, depth, cwd }) =>
      P('bridge_codegraph_call_graph', { qualifiedName, direction, depth, cwd }),
  )

  // get_symbol_source ────────────────────────────────────────────────────────
  server.tool(
    'bridge_codegraph_get_symbol_source',
    'Return the source snippet of a symbol by qualified name, bare name, or dotted qualified suffix (for example, `packages/daemon/src/pty/manager.PtyManager`, `PtyManager`, or `PtyManager.spawn`). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.',
    {
      qualifiedName: z
        .string()
        .min(1)
        .refine((s) => !s.includes('\0'), { message: 'NUL characters not allowed' })
        .describe('Symbol identifier: qualified name, bare name, or dotted qualified suffix (e.g. packages/daemon/src/pty/manager.PtyManager, PtyManager, or PtyManager.spawn). Ambiguous input returns up to 20 distinct candidates with totalCandidates count.'),
      cwd: z.string().optional().describe('Project root. Defaults to the bridge project cwd.'),
    },
    ({ qualifiedName, cwd }) =>
      P('bridge_codegraph_get_symbol_source', { qualifiedName, cwd }),
  )

  // diff_impact ─────────────────────────────────────────────────────────────
  server.tool(
    'bridge_codegraph_diff_impact',
    'Blast-radius of a git diff: exported symbols changed in modified files + every transitive caller (depth ≤ 3) of those symbols. PREFER over manual Grep when reviewing what a change touches. Returns {changedFiles, changedSymbols, impactedSymbols:[{qualifiedName,file,line,depth}], truncated}.',
    {
      cwd: z.string().optional().describe('Project root. Defaults to the bridge project cwd.'),
      base: z.string().optional().describe('Git diff base ref (default HEAD — working tree vs HEAD)'),
    },
    ({ cwd, base }) =>
      P('bridge_codegraph_diff_impact', { cwd, base }),
  )
}
