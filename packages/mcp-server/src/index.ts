/**
 * Bridge MCP Server
 *
 * HTTP mode (default — HTTP_MODE=false to disable):
 *   POST|GET|DELETE /mcp/:workspaceId/:projectId  — MCP Streamable HTTP
 *   GET  /health                                  — health check
 *
 *   Required env vars:
 *     BRIDGE_SERVER_URL   HTTP base URL of Bridge server (e.g. https://bridge.example.com)
 *     PORT                Listening port (default: 3200)
 *   Auth: Authorization: Bearer <daemon_token> on every MCP request.
 *
 * Stdio mode (HTTP_MODE=false):
 *   Requires BRIDGE_SERVER_URL, BRIDGE_TOKEN, BRIDGE_WORKSPACE_ID, BRIDGE_PROJECT_ID.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerPlanTools } from './tools/plan.js'
import { registerTodoTools } from './tools/todos.js'
import { registerOrchestrationTools } from './tools/orchestration.js'
import { registerMessagingTools } from './tools/messaging.js'
import { registerWorkspaceTools } from './tools/workspace.js'
import { registerPersonaTools } from './tools/personas.js'
import { registerPersonaScheduleTools } from './tools/persona-schedules.js'
import { registerRolePromptTools } from './tools/role-prompts.js'
import { registerGroupSchemaTools } from './tools/group-schemas.js'
import { registerCodegraphTools } from './tools/codegraph.js'
import { codegraphToolsEnabled } from './codegraph-toggle.js'
import type { BridgeContext } from './api.js'
import { preflightWorkspaceMembership } from './preflight.js'
import { createTodoRunSessionState } from './todo-run-session.js'

// ── Session registry ──────────────────────────────────────────────────────────

interface Session {
  transport: StreamableHTTPServerTransport
}

const sessions = new Map<string, Session>()

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildMcpServer(ctx: BridgeContext): Promise<McpServer> {
  const srv = new McpServer({ name: 'bridge', version: '0.1.0' })
  const todoRunState = createTodoRunSessionState()
  registerPlanTools(srv, ctx)
  registerTodoTools(srv, ctx, todoRunState)
  registerOrchestrationTools(srv, ctx, todoRunState)
  registerMessagingTools(srv, ctx)
  registerWorkspaceTools(srv, ctx)
  registerPersonaTools(srv, ctx)
  registerPersonaScheduleTools(srv, ctx)
  registerRolePromptTools(srv, ctx)
  registerGroupSchemaTools(srv, ctx)
  // #521 Step 4b: A/B off-arm — no bridge_codegraph_* tools when disabled.
  if (await codegraphToolsEnabled(ctx)) {
    registerCodegraphTools(srv, ctx)
  }
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

// ── HTTP mode ─────────────────────────────────────────────────────────────────

function startHttpServer(): void {
  const bridgeServerUrl = (process.env['BRIDGE_SERVER_URL'] ?? '').trim()
  if (!bridgeServerUrl) {
    console.error('[bridge-mcp] BRIDGE_SERVER_URL is required for HTTP mode')
    process.exit(1)
  }
  const port = parseInt(process.env['PORT'] ?? '3200', 10)

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url    = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      // Health check
      if (method === 'GET' && (url === '/health' || url === '/health/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sessions: sessions.size }))
        return
      }

      // MCP route: /mcp/:workspaceId/:projectId
      const match = url.match(/^\/mcp\/([^/?#]+)\/([^/?#]+)/)
      if (!match || !['GET', 'POST', 'DELETE'].includes(method)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
        return
      }

      const workspaceId = match[1]!
      const projectId   = match[2]!
      const auth        = (req.headers['authorization'] ?? '') as string
      const token       = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''

      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Authorization: Bearer <token> required' }))
        return
      }

      const sessionId = (req.headers['mcp-session-id'] ?? '') as string
      const body      = await parseBody(req)

      // Existing session: route to its transport
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

      // New session: validate active workspace membership before allocating it.
      // Project and other resource bindings are enforced by each server route.
      const preflight = await preflightWorkspaceMembership(bridgeServerUrl, workspaceId, token)
      if (!preflight.ok) {
        res.writeHead(preflight.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(preflight.body))
        return
      }

      const agentId = (req.headers['x-panel-id'] ?? '') as string || undefined
      const personaId = (req.headers['x-panel-persona-id'] ?? '') as string || undefined
      const ctx: BridgeContext = { serverUrl: bridgeServerUrl, token, workspaceId, projectId, agentId, personaId }
      const sid = randomUUID()
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator:   () => sid,
        onsessioninitialized: (id) => { sessions.set(id, { transport }) },
        onsessionclosed:      (id) => { sessions.delete(id) },
      })
      const mcpServer = await buildMcpServer(ctx)
      await mcpServer.connect(transport)
      await transport.handleRequest(req, res, body)

    } catch (err) {
      console.error('[bridge-mcp] request error:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    }
  })

  httpServer.listen(port, () => {
    console.error(`[bridge-mcp] HTTP MCP server listening on :${port}`)
    console.error(`[bridge-mcp] Bridge API: ${bridgeServerUrl}`)
  })
}

// ── Stdio mode (legacy / monorepo dev) ────────────────────────────────────────

const PARENT_POLL_MS = 5_000

/**
 * Issue #24: in stdio mode this process is spawned by the owning CLI
 * (claude/opencode/kimi/etc via a daemon-written --mcp-config), never by the
 * daemon itself — the daemon only resolves a binary path into that config
 * (`resolveMcpBin` in packages/daemon/src/ws/client.ts), so it has no handle
 * to reap this process when the CLI dies. The installed MCP SDK's
 * StdioServerTransport only listens for stdin 'data'/'error', never 'end' —
 * it does not notice EOF at all — and even where EOF does propagate, a fd
 * inherited by one of the CLI's own descendants can prevent it from ever
 * arriving. Either way, the process is silently reparented to launchd/init
 * and runs forever (observed: orphans surviving 4+ days and daemon
 * restarts). Stdin close is the fast path; the ppid poll is the guarantee,
 * since it does not depend on EOF ever arriving.
 *
 * HTTP mode is deliberately excluded: it's a shared, multi-session server
 * (packages/mcp-server/src/index.ts's `sessions` map) whose lifecycle
 * belongs to its own service manager, not to any one client.
 */
function armParentDeathWatchdog(ownerPid: number): void {
  let shuttingDown = false
  let watchdog: ReturnType<typeof setInterval> | null = null

  const shutdown = (reason: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    if (watchdog) clearInterval(watchdog)
    console.error(JSON.stringify({ event: 'mcp.exit', reason, pid: process.pid, ownerPid }))
    process.exit(0)
  }

  process.stdin.on('end', () => shutdown('stdin_eof'))
  process.stdin.on('close', () => shutdown('stdin_closed'))
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => shutdown(sig))
  }

  // Reparent check (process.ppid, live per access) is the primary signal;
  // kill(ownerPid, 0) is a fallback for platforms where the OS doesn't
  // reparent orphans to a fixed pid (e.g. a Linux subreaper isn't always
  // pid 1). EPERM means the owner is alive under another user — never
  // treat that as death; only ESRCH (no such process) counts.
  watchdog = setInterval(() => {
    if (process.ppid !== ownerPid || process.ppid <= 1) {
      shutdown('parent_died')
      return
    }
    try {
      process.kill(ownerPid, 0)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') shutdown('parent_died')
    }
  }, PARENT_POLL_MS)
  // Must never itself keep the event loop alive once the server would
  // otherwise have nothing left to do.
  watchdog.unref()
}

async function startStdioServer(): Promise<void> {
  const required = ['BRIDGE_SERVER_URL', 'BRIDGE_TOKEN', 'BRIDGE_WORKSPACE_ID', 'BRIDGE_PROJECT_ID']
  const missing  = required.filter(k => !process.env[k])
  if (missing.length > 0) {
    console.error(`[bridge-mcp] Missing env vars for stdio mode: ${missing.join(', ')}`)
    process.exit(1)
  }

  // Orphaned before we even started (the owning CLI died in the milliseconds
  // between spawn and this check) — don't bother connecting a transport
  // nothing will ever read.
  if (process.ppid <= 1) {
    console.error(JSON.stringify({ event: 'mcp.exit', reason: 'orphaned_at_startup', pid: process.pid, ownerPid: process.ppid }))
    process.exit(0)
  }

  const ctx: BridgeContext = {
    serverUrl:   process.env['BRIDGE_SERVER_URL']!,
    token:       process.env['BRIDGE_TOKEN']!,
    workspaceId: process.env['BRIDGE_WORKSPACE_ID']!,
    projectId:   process.env['BRIDGE_PROJECT_ID']!,
    agentId:     process.env['BRIDGE_PANEL_ID'] || undefined,
    personaId:   process.env['BRIDGE_PERSONA_ID'] || undefined,
  }

  const ownerPid  = process.ppid
  const srv       = await buildMcpServer(ctx)
  const transport = new StdioServerTransport()
  await srv.connect(transport)
  armParentDeathWatchdog(ownerPid)
  console.error(JSON.stringify({ event: 'mcp.start', pid: process.pid, ownerPid, agentId: ctx.agentId ?? null }))
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (process.env['HTTP_MODE'] !== 'false') {
  startHttpServer()
} else {
  startStdioServer().catch(err => {
    console.error('[bridge-mcp] fatal:', err)
    process.exit(1)
  })
}
