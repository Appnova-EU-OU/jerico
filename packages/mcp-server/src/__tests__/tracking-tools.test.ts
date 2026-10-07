import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { registerWorkspaceTools } from '../tools/workspace.js'
import { registerOrchestrationTools } from '../tools/orchestration.js'
import { createTodoRunSessionState } from '../todo-run-session.js'
import { BRIDGE_TOOL_CAPABILITIES } from '../tool-capabilities.js'
import { BRIDGE_TOOL_DOCS, DEFAULT_ROLE_PROMPTS, ORCHESTRATOR_TODO_RUN_WORKFLOW } from '@jerico/shared'
import type { ZodTypeAny } from 'zod'
type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{text:string}>; isError?: boolean }>
const ctx = { serverUrl: 'http://bridge.test', token: 'test', projectId: '', workspaceId: 'workspace-1', agentId: 'orch-1' }
function fixture() {
  const handlers = new Map<string, Handler>()
  const schemas = new Map<string, Record<string,ZodTypeAny>>()
  const fake = { tool(name: string, ...args: unknown[]) { handlers.set(name,args.at(-1) as Handler); schemas.set(name,args.at(-2) as Record<string,ZodTypeAny>) } }
  registerWorkspaceTools(fake as never,ctx)
  registerOrchestrationTools(fake as never,ctx,createTodoRunSessionState())
  return {handlers,schemas}
}
describe('tracking read tools', () => {
  it('preserves exact outcome identity, unresolved state and authorization errors', async () => {
    const {handlers} = fixture()
    const id = '11111111-1111-4111-8111-111111111111'
    const old = globalThis.fetch
    try {
      for (const status of [200,403,503]) {
        const expected = status === 200 ? {status:'unresolved',completionId:id} : {error:'test_denial'}
        globalThis.fetch = async (url,init) => {
          assert.equal(String(url),`http://bridge.test/api/workspaces/workspace-1/completion/free/${id}`)
          assert.equal(new Headers(init?.headers).get('x-bridge-panel-id'),'orch-1')
          return Response.json(expected,{status})
        }
        const result = await handlers.get('bridge_get_free_task_outcome')!({completionId:id})
        assert.deepEqual(JSON.parse(result.content[0]!.text),expected)
        assert.equal(result.isError,status === 200 ? undefined : true)
      }
    } finally { globalThis.fetch = old }
  })
  it('validates optional expected instance and sends it without manufacturing a cursor', async () => {
    const {handlers,schemas} = fixture()
    const schema = schemas.get('bridge_peek_panel')!.expectedPanelInstanceId!
    for (const value of [0,-1,1.2,Number.MAX_SAFE_INTEGER+1,'3']) assert.equal(schema.safeParse(value).success,false)
    assert.equal(schema.safeParse(undefined).success,true)
    const old=globalThis.fetch
    try {
      globalThis.fetch=async url => {
        const parsed=new URL(String(url))
        assert.equal(parsed.searchParams.get('expectedPanelInstanceId'),'3')
        assert.equal(parsed.searchParams.get('lines'),'300')
        assert.equal(parsed.searchParams.has('cursor'),false)
        return Response.json({error:'panel_instance_mismatch'},{status:409})
      }
      const result=await handlers.get('bridge_peek_panel')!({agentId:'worker-1',lines:300,expectedPanelInstanceId:3})
      assert.equal(result.isError,true)
      assert.deepEqual(JSON.parse(result.content[0]!.text),{error:'panel_instance_mismatch'})
    } finally {globalThis.fetch=old}
  })
  it('all registrations have exact capability coverage; outcome tool is in shared role documentation', () => {
    const declared = readdirSync('src/tools').filter(f=>f.endsWith('.ts')).flatMap(f=>
      [...readFileSync(`src/tools/${f}`,'utf8').matchAll(/server\.tool\(\s*['"](bridge_[^'"]+)/g)].map(m=>m[1]!)).sort()
    assert.deepEqual(Object.keys(BRIDGE_TOOL_CAPABILITIES).sort(),declared)
    assert.equal(BRIDGE_TOOL_CAPABILITIES.bridge_get_free_task_outcome,'orchestration.observe')
    assert.ok(BRIDGE_TOOL_DOCS.bridge_get_free_task_outcome)
    for (const prompt of [DEFAULT_ROLE_PROMPTS.orchestrator, ORCHESTRATOR_TODO_RUN_WORKFLOW]) {
      assert.ok(prompt.includes('status:accepted'))
      assert.ok(prompt.includes('evidence:daemon_sealed_receipt'))
      assert.ok(prompt.includes('This retained read is sufficient without a nudge'))
      assert.ok(!prompt.includes('Only an accepted completion envelope is terminal'))
    }
  })
})
