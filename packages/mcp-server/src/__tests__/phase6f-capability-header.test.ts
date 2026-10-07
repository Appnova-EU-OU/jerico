import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  getRolePrompt,
  renderActorCapabilitiesHeader,
  type BridgeContext,
  type SessionContext,
} from '../api.js'

const DISPLAY_CAPABILITIES = [
  'project.read',
  'project.write',
  'orchestration.observe',
  'orchestration.execute',
  'events.read',
  'events.write',
  'prompts.write',
  'workspace.members.manage',
] as const

function snapshot(role: string, eventAccess: 'read' | 'write'): Record<string, boolean> {
  const roleAllowed: Record<string, readonly string[]> = {
    viewer: ['project.read', 'orchestration.observe', 'events.read'],
    editor: ['project.read', 'project.write', 'orchestration.observe', 'orchestration.execute', 'events.read'],
    admin: ['project.read', 'project.write', 'orchestration.observe', 'orchestration.execute', 'events.read', 'prompts.write', 'workspace.members.manage'],
    owner: [...DISPLAY_CAPABILITIES.filter(capability => capability !== 'events.write')],
  }
  const allowed = new Set(roleAllowed[role])
  if (eventAccess === 'write') allowed.add('events.write')
  return Object.fromEntries(DISPLAY_CAPABILITIES.map(capability => [capability, allowed.has(capability)]))
}

function session(role: string, eventAccess: 'read' | 'write', version: number): SessionContext {
  return {
    panelId: 'panel-1',
    workspaceId: 'workspace-1',
    projectId: null,
    projectName: null,
    groupId: null,
    scope: 'workspace',
    workspaceRole: role,
    eventAccess,
    capabilities: snapshot(role, eventAccess),
    capabilitiesVersion: version,
  }
}

describe('Phase 6F volatile capability header', () => {
  it('renders the server-provided snapshot for 4 workspace roles × 2 event states', () => {
    for (const role of ['viewer', 'editor', 'admin', 'owner']) {
      for (const eventAccess of ['read', 'write'] as const) {
        const sc = session(role, eventAccess, 17)
        const header = renderActorCapabilitiesHeader(sc)
        const allowed = DISPLAY_CAPABILITIES
          .filter(capability => sc.capabilities[capability])
          .map(capability => capability === 'workspace.members.manage' ? 'members.manage' : capability)
        const denied = DISPLAY_CAPABILITIES
          .filter(capability => !sc.capabilities[capability])
          .map(capability => capability === 'workspace.members.manage' ? 'members.manage' : capability)

        assert.match(header, new RegExp(`workspaceRole: ${role}\\n`))
        assert.match(header, new RegExp(`eventAccess: ${eventAccess}\\n`))
        assert.match(header, /capabilitiesVersion: 17\n/)
        assert.ok(header.includes(`allowed: ${allowed.join(', ') || '(none)'}`))
        assert.ok(header.includes(`denied: ${denied.join(', ') || '(none)'}`))
      }
    }
  })

  it('prepends volatile context for every agent role without changing prompt-body bytes', async () => {
    const stablePrompt = 'STABLE role body\n{{TOOL_TABLE}} is intentionally literal here.\n'
    const ctx: BridgeContext = {
      serverUrl: 'http://bridge.test',
      token: 'token',
      workspaceId: 'workspace-1',
      projectId: 'workspace',
      agentId: 'panel-1',
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/prompts/')) {
        return Response.json({ role: 'developer', content: stablePrompt, source: 'workspace' })
      }
      if (url.endsWith('/api/workspaces/workspace-1')) {
        return Response.json({
          access: {
            workspaceRole: 'viewer',
            eventAccess: 'read',
            capabilities: snapshot('viewer', 'read'),
            capabilitiesVersion: 3,
          },
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    }

    try {
      for (const agentRole of ['orchestrator', 'developer', 'reviewer', 'designer']) {
        const result = await getRolePrompt(ctx, agentRole)
        assert.ok(result.content.startsWith('[BRIDGE SESSION CONTEXT — authoritative, code-built]'))
        assert.ok(result.content.includes('[JERICO ACTOR CAPABILITIES — authoritative snapshot'))
        assert.ok(result.content.endsWith(stablePrompt), agentRole)
        assert.equal(result.content.slice(-stablePrompt.length), stablePrompt, agentRole)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps capability prose out of embedded default prompt sources', () => {
    const repoRoot = path.basename(process.cwd()) === 'mcp-server'
      ? path.resolve(process.cwd(), '../..')
      : process.cwd()
    const defaultPrompts = readFileSync(path.join(repoRoot, 'packages/shared/src/default-role-prompts.ts'), 'utf8')
    const marker = 'JERICO ACTOR CAPABILITIES'
    assert.equal(defaultPrompts.includes(marker), false)
  })
})
