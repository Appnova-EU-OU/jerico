import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { HOOK_SCRIPT_V1 } from '../hooks/script.js'
import { handleAgentHookRequest } from '../hooks/receiver.js'
import {
  HOOK_ROUTE_PATH,
  HEADER_TOKEN,
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_VERSION,
  HEADER_AGENT_ID,
  HEADER_INSTANCE_ID,
  DESCRIPTOR_ENV_VAR,
  DESCRIPTOR_FIELD_URL,
  DESCRIPTOR_FIELD_TOKEN,
  HOOK_PROTOCOL,
  HOOK_PROTOCOL_VERSION
} from '../hooks/protocol.js'

let server: Server | null = null
let tempDir: string | null = null

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'hook-test-'))
})

afterEach(async () => {
  const current = server
  server = null
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()))
  
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

function createTestDescriptor(port: number, token: string): string {
  const descPath = join(tempDir!, 'descriptor.json')
  writeFileSync(descPath, JSON.stringify({
    [DESCRIPTOR_FIELD_URL]: `http://127.0.0.1:${port}${HOOK_ROUTE_PATH}`,
    [DESCRIPTOR_FIELD_TOKEN]: token
  }))
  return descPath
}

async function runScript(env: Record<string, string>, payload: string): Promise<{ code: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(tempDir!, 'hook.sh')
    writeFileSync(scriptPath, HOOK_SCRIPT_V1, { mode: 0o755 })
    
    const cleanEnv = { ...process.env }
    delete cleanEnv[DESCRIPTOR_ENV_VAR]
    delete cleanEnv.JERICO_HOOK_DIAG
    delete cleanEnv.BRIDGE_HOOK_DEBUG
    const child = spawn(scriptPath, [], { env: { ...cleanEnv, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', b => stdout += b.toString())
    child.stderr.on('data', b => stderr += b.toString())

    child.stdin.write(payload)
    child.stdin.end()
    
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.on('error', reject)
  })
}

function setupReceiverServer(opts: { 
  expectedToken: string, 
  target?: any, 
  onReq?: (req: any, res: any) => void 
}): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)
      if (req.method !== 'POST' || url.pathname !== HOOK_ROUTE_PATH) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not_found' }))
        return
      }

      if (opts.onReq) {
        opts.onReq(req, res)
        return
      }
      
      const mockManager = {
        getLiveHookTarget: (agentId: string, instanceId: number) => opts.target
      } as any
      
      const mockWs = {
        readyState: 1,
        send: (data: string, cb: (err?: any) => void) => cb()
      }
      
      await handleAgentHookRequest(req, res, { 
        manager: mockManager, 
        expectedToken: opts.expectedToken, 
        ws: mockWs 
      })
    })
    
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (address && typeof address === 'object') {
        resolve(address.port)
      } else {
        reject(new Error('Failed to bind'))
      }
    })
  })
}

describe('Slice 0', () => {
  test('1. The generated script actually works', async () => {
    let reqReceived = false
    let resStatus = 0
    const expectedToken = 'test-token'
    
    const port = await setupReceiverServer({
      expectedToken,
      target: { agentId: 'test-agent', instanceId: 123, agentKey: 'claude' },
      onReq: async (req, res) => {
        reqReceived = true
        // Let handleAgentHookRequest handle it
        const mockManager = {
          getLiveHookTarget: () => ({ agentId: 'test-agent', instanceId: 123, agentKey: 'claude' })
        } as any
        const mockWs = {
          readyState: 1,
          send: (data: string, cb: (err?: any) => void) => cb()
        }
        
        // intercept res.writeHead
        const originalWriteHead = res.writeHead.bind(res)
        res.writeHead = (statusCode: number, ...args: any[]) => {
          resStatus = statusCode
          return originalWriteHead(statusCode, ...args)
        }
        
        await handleAgentHookRequest(req, res, { manager: mockManager, expectedToken, ws: mockWs })
      }
    })
    
    const descPath = createTestDescriptor(port, expectedToken)
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' })
    
    const result = await runScript({
      HOME: tempDir!,
      BRIDGE_PANEL_ID: 'test-agent',
      BRIDGE_PANEL_INSTANCE_ID: '123',
      JERICO_HOOK_DIAG: '1',
      [DESCRIPTOR_ENV_VAR]: descPath
    }, payload)
    
    expect(result.code).toBe(0)
    expect(reqReceived).toBe(true)
    expect(resStatus).toBe(202)
    expect(result.stdout.trim()).toBe('')
    expect(result.stderr.trim()).toBe('')
    const diagnostic = readFileSync(join(tempDir!, '.jerico', 'hook-debug.log'), 'utf-8')
    expect(diagnostic).toContain('stage=enter')
    expect(diagnostic).toContain('stage=post')
    expect(diagnostic).toContain('stage=done')
    expect(diagnostic).toContain('http=202')
  })
  
  test('2. Drift fails', () => {
    expect(HOOK_SCRIPT_V1).toContain(HEADER_TOKEN)
    expect(HOOK_SCRIPT_V1).toContain(HEADER_PROTOCOL)
    expect(HOOK_SCRIPT_V1).toContain(HEADER_PROTOCOL_VERSION)
    expect(HOOK_SCRIPT_V1).toContain(HEADER_AGENT_ID)
    expect(HOOK_SCRIPT_V1).toContain(HEADER_INSTANCE_ID)
    expect(HOOK_SCRIPT_V1).toContain(DESCRIPTOR_ENV_VAR)
  })
  
  test('3. Empty identity does not POST', async () => {
    let called = false
    const port = await setupReceiverServer({
      expectedToken: 't1',
      onReq: () => { called = true }
    })
    const descPath = createTestDescriptor(port, 't1')
    
    const result = await runScript({
      HOME: tempDir!,
      BRIDGE_PANEL_ID: '', // empty identity
      BRIDGE_PANEL_INSTANCE_ID: '123',
      [DESCRIPTOR_ENV_VAR]: descPath
    }, '{}')
    
    expect(result.code).toBe(0)
    expect(called).toBe(false)
    expect(result.stdout).toBe('')
    expect(existsSync(join(tempDir!, '.jerico', 'hook-debug.log'))).toBe(false)
  })
  
  test('4. Missing descriptor exits quietly and fast', async () => {
    let called = false
    const port = await setupReceiverServer({
      expectedToken: 't1',
      onReq: () => { called = true }
    })
    
    const result = await runScript({
      HOME: tempDir!,
      BRIDGE_PANEL_ID: 'test-agent',
      BRIDGE_PANEL_INSTANCE_ID: '123'
      // missing DESCRIPTOR_ENV_VAR
    }, '{}')
    
    expect(result.code).toBe(0)
    expect(called).toBe(false)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(existsSync(join(tempDir!, '.jerico', 'hook-debug.log'))).toBe(false)
  })
  
  test('5. Invalid agent key gets 409', async () => {
    const port = await setupReceiverServer({
      expectedToken: 't1',
      target: { agentId: 'test-agent', instanceId: 123, agentKey: 'invalid-key' }
    })
    
    const descPath = createTestDescriptor(port, 't1')
    const result = await runScript({
      HOME: tempDir!,
      BRIDGE_PANEL_ID: 'test-agent',
      BRIDGE_PANEL_INSTANCE_ID: '123',
      JERICO_HOOK_DIAG: '1',
      [DESCRIPTOR_ENV_VAR]: descPath
    }, '{}')
    
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('')
    expect(result.stderr.trim()).toBe('')
    const diagnostic = readFileSync(join(tempDir!, '.jerico', 'hook-debug.log'), 'utf-8')
    expect(diagnostic).toContain('stage=done')
    expect(diagnostic).toContain('http=409')
  })
  
  test('6. Reject paths drain', async () => {
    const port = await setupReceiverServer({
      expectedToken: 't1',
      target: { agentId: 'test-agent', instanceId: 123, agentKey: 'claude' }
    })
    
    const res = await fetch(`http://127.0.0.1:${port}${HOOK_ROUTE_PATH}`, {
      method: 'POST',
      headers: {
        [HEADER_TOKEN]: 'wrong-token',
        [HEADER_PROTOCOL]: HOOK_PROTOCOL,
        [HEADER_PROTOCOL_VERSION]: String(HOOK_PROTOCOL_VERSION),
        [HEADER_AGENT_ID]: 'test-agent',
        [HEADER_INSTANCE_ID]: '123'
      },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toEqual({ error: 'invalid_token' })
  })

  test('7. diagnostics are off by default and the old BRIDGE flag cannot arm them', async () => {
    const port = await setupReceiverServer({
      expectedToken: 't1',
      target: { agentId: 'test-agent', instanceId: 123, agentKey: 'claude' }
    })
    const descPath = createTestDescriptor(port, 't1')

    const result = await runScript({
      HOME: tempDir!,
      BRIDGE_PANEL_ID: 'test-agent',
      BRIDGE_PANEL_INSTANCE_ID: '123',
      BRIDGE_HOOK_DEBUG: '1',
      [DESCRIPTOR_ENV_VAR]: descPath
    }, '{}')

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(existsSync(join(tempDir!, '.jerico', 'hook-debug.log'))).toBe(false)
    expect(existsSync(descPath.replace(/\.json$/, '.debug.log'))).toBe(false)
  })

  test('8. the regular flag arms diagnostics without panel injection', async () => {
    const hooksDir = join(tempDir!, '.jerico', 'hooks')
    mkdirSync(hooksDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(hooksDir, 'DIAG'), '', { mode: 0o600 })

    const result = await runScript({ HOME: tempDir! }, '{}')

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
    const diagnostic = readFileSync(join(tempDir!, '.jerico', 'hook-debug.log'), 'utf-8')
    expect(diagnostic).toContain('stage=enter')
    expect(diagnostic).toContain('stage=no_panel_id')
  })

  test('9. each invocation has one stable, distinct correlation id', async () => {
    await runScript({ HOME: tempDir!, JERICO_HOOK_DIAG: '1' }, '{}')
    const lines1 = readFileSync(join(tempDir!, '.jerico', 'hook-debug.log'), 'utf-8').trim().split('\n')
    const ids1 = lines1.map(line => line.match(/\binv=([^ ]+)/)?.[1]).filter(Boolean)
    
    await runScript({ HOME: tempDir!, JERICO_HOOK_DIAG: '1' }, '{}')
    const lines2 = readFileSync(join(tempDir!, '.jerico', 'hook-debug.log'), 'utf-8').trim().split('\n')
    const ids2 = lines2.map(line => line.match(/\binv=([^ ]+)/)?.[1]).filter(Boolean)
    
    expect(ids1.length).toBeGreaterThanOrEqual(2)
    expect(ids2.length).toBeGreaterThanOrEqual(2)
    expect(new Set(ids1).size).toBe(1)
    expect(new Set(ids2).size).toBe(1)
    expect(ids1[0]).not.toEqual(ids2[0])
  })

  test('10. diagnostic records identify the invocation without leaking descriptor data', async () => {
    const descriptor = join(tempDir!, 'empty-secret-canary-descriptor.json')
    writeFileSync(descriptor, JSON.stringify({ url: '', hookToken: 'secret-canary' }))
    await runScript({
      HOME: tempDir!,
      JERICO_HOOK_DIAG: '1',
      BRIDGE_PANEL_ID: 'panel-7',
      BRIDGE_PANEL_INSTANCE_ID: '11',
      [DESCRIPTOR_ENV_VAR]: descriptor
    }, JSON.stringify({ cwd: '/secret/cwd-canary', prompt: 'prompt-canary' }))

    const lines = readFileSync(join(tempDir!, '.jerico', 'hook-debug.log'), 'utf8').trim().split('\n')
    expect(lines[0]).toMatch(/^ts=\S+ inv=\S+ pid=\d+ profile=\S+ panel=panel-7 inst=11 stage=enter$/)
    expect(lines.at(-1)).toContain('stage=no_fields detail=url=empty')
    const evidence = lines.join('\n')
    expect(evidence).not.toContain('secret-canary')
    expect(evidence).not.toContain('cwd-canary')
    expect(evidence).not.toContain('prompt-canary')
    expect(evidence).not.toContain(descriptor)
  })
})
