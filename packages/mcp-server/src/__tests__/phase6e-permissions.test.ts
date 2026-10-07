import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { BridgeApiError, resolveSessionContext, type BridgeContext } from '../api.js'
import { safeTool } from '../tool-result.js'
import { BRIDGE_TOOL_CAPABILITIES } from '../tool-capabilities.js'
import { preflightWorkspaceMembership } from '../preflight.js'
import { registerPlanTools } from '../tools/plan.js'
import { registerTodoTools } from '../tools/todos.js'
import { registerOrchestrationTools } from '../tools/orchestration.js'
import { registerMessagingTools } from '../tools/messaging.js'
import { registerWorkspaceTools } from '../tools/workspace.js'
import { registerPersonaTools } from '../tools/personas.js'
import { registerRolePromptTools } from '../tools/role-prompts.js'
import { registerGroupSchemaTools } from '../tools/group-schemas.js'
import { createTodoRunSessionState } from '../todo-run-session.js'

const sourceDir = path.join(process.cwd(), 'src')
const toolsDir = path.join(sourceDir, 'tools')
const ctx: BridgeContext = {
  serverUrl: 'http://bridge.test',
  token: 'token',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  agentId: 'panel-1',
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

class FakeMcpServer {
  handlers = new Map<string, Handler>()
  tool(name: string, ...args: unknown[]): void {
    this.handlers.set(name, args.at(-1) as Handler)
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Phase 6E MCP permission contract', () => {
  it('classifies exactly every bridge tool registration', () => {
    const declared = readdirSync(toolsDir)
      .filter(file => file.endsWith('.ts'))
      .flatMap(file => {
        const source = readFileSync(`${toolsDir}/${file}`, 'utf8')
        return [...source.matchAll(/server\.tool\(\s*['"](bridge_[^'"]+)/g)].map(match => match[1]!)
      })
      .sort()
    assert.equal(declared.length, 78)
    assert.deepEqual(Object.keys(BRIDGE_TOOL_CAPABILITIES).sort(), declared)
  })

  it('preserves the server denial body and marks it as an MCP error', async () => {
    const denial = {
      ok: false,
      error: 'permission_denied',
      required: 'orchestration.execute',
      current: { workspaceRole: 'viewer', eventAccess: 'read' },
      requestId: 'request-1',
    }
    const result = await safeTool(async () => { throw new BridgeApiError(403, denial) })
    assert.equal(result.isError, true)
    assert.deepEqual(JSON.parse(result.content[0]!.text), denial)
  })

  it('routes every HTTP-backed tool denial through the shared failed-result contract', async () => {
    const fake = new FakeMcpServer()
    const server = fake as never
    const todoRunState = createTodoRunSessionState()
    registerPlanTools(server, ctx)
    registerTodoTools(server, ctx, todoRunState)
    registerOrchestrationTools(server, ctx, todoRunState)
    registerMessagingTools(server, ctx)
    registerWorkspaceTools(server, ctx)
    registerPersonaTools(server, ctx)
    registerRolePromptTools(server, ctx)
    registerGroupSchemaTools(server, ctx)

    const denial = {
      ok: false,
      error: 'permission_denied',
      required: 'workspace.read',
      current: { workspaceRole: 'viewer', eventAccess: 'read' },
      requestId: 'all-tools-denied',
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => jsonResponse(denial, 403)
    try {
      assert.equal(fake.handlers.size, 69)
      for (const [name, handler] of fake.handlers) {
        if (name === 'bridge_get_todo_run_instructions') continue // static, no HTTP authorization hop
        const result = await handler({})
        assert.equal(result.isError, true, name)
        assert.deepEqual(JSON.parse(result.content[0]!.text), denial, name)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('preflights the membership-aware workspace route, never the project route', async () => {
    let requestedUrl = ''
    let authorization = ''
    const result = await preflightWorkspaceMembership(
      'http://bridge.test/',
      'workspace-1',
      'token-1',
      async (input, init) => {
        requestedUrl = String(input)
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        return jsonResponse({ workspace: { id: 'workspace-1' } })
      },
    )
    assert.deepEqual(result, { ok: true })
    assert.equal(requestedUrl, 'http://bridge.test/api/workspaces/workspace-1')
    assert.equal(authorization, 'Bearer token-1')
    assert.ok(!requestedUrl.includes('/projects/'))
  })

  it('returns server-authored capability discovery in session context', async () => {
    const originalFetch = globalThis.fetch
    const capabilities = { 'workspace.read': true, 'orchestration.execute': false }
    globalThis.fetch = async input => String(input).endsWith('/api/workspaces/workspace-1')
      ? jsonResponse({ access: { workspaceRole: 'viewer', eventAccess: 'read', capabilities, capabilitiesVersion: 7 } })
      : jsonResponse({ id: 'project-1', name: 'Project One', description: '' })
    try {
      const result = await resolveSessionContext(ctx)
      assert.equal(result.workspaceRole, 'viewer')
      assert.equal(result.eventAccess, 'read')
      assert.deepEqual(result.capabilities, capabilities)
      assert.equal(result.capabilitiesVersion, 7)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps project memory on the audience-filtered event API path', () => {
    const orchestration = readFileSync(`${toolsDir}/orchestration.ts`, 'utf8')
    const api = readFileSync(path.join(sourceDir, 'api.ts'), 'utf8')
    assert.match(orchestration, /bridge_get_project_memory[\s\S]*?getProjectMemory\(ctx/)
    assert.doesNotMatch(orchestration, /\bprojectEvents\b|queryDurableProjectGuardrail|\.from\(projectEvents\)/)
    assert.match(api, /export async function getProjectEvents[\s\S]*?projectPath\(ctx, `\/events/)
    assert.match(api, /export async function getProjectMemory[\s\S]*?projectPath\(ctx, `\/events\/memory/)
  })

  it('routes guarded brief dispatch through the workspace-scoped server endpoint', async () => {
    const fake = new FakeMcpServer()
    registerOrchestrationTools(fake as never, ctx, createTodoRunSessionState())
    const originalFetch = globalThis.fetch
    let requestUrl = ''
    let requestBody = ''
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input)
      requestBody = String(init?.body ?? '')
      return jsonResponse({
        ok: true,
        projectId: 'project-1',
        guardrailsIncluded: true,
        guardrailsTruncated: false,
        watcherArmed: true,
      })
    }
    try {
      const result = await fake.handlers.get('bridge_dispatch_brief')!({
        agentId: 'worker-1',
        text: 'Read docs/brief.md',
        taskSuffix: 'DISPATCH_TEST',
      })
      assert.equal(result.isError, undefined)
      assert.equal(requestUrl, 'http://bridge.test/api/workspaces/workspace-1/agents/worker-1/dispatch-brief')
      assert.deepEqual(JSON.parse(requestBody), {
        text: 'Read docs/brief.md',
        taskSuffix: 'DISPATCH_TEST',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
