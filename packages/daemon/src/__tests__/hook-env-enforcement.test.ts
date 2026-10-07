import { test, expect, spyOn, mock, afterEach, afterAll } from 'bun:test'
import fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import path from 'node:path'
import { getHookEndpointPath } from '../profile.js'
import { __test_getAllMcpBuilders } from '../ws/client.js'
import { PtyManager } from '../pty/manager.js'
import { DESCRIPTOR_ENV_VAR } from '../hooks/protocol.js'
import { getHookEnvPairs } from '../hooks/protocol.js'
import * as realCp from 'node:child_process'
import * as realNodePty from 'node-pty'

let writeFileSyncSpy: ReturnType<typeof spyOn>
let writeFileSyncPromisesSpy: ReturnType<typeof spyOn>
let mkdirSyncSpy: ReturnType<typeof spyOn>
let existsSyncSpy: ReturnType<typeof spyOn>
let appendFileSyncSpy: ReturnType<typeof spyOn>
let chmodSyncSpy: ReturnType<typeof spyOn>
let renameSyncSpy: ReturnType<typeof spyOn>

const realCpSnapshot = { ...realCp }
const realNodePtySnapshot = { ...realNodePty }

afterEach(() => {
  if (writeFileSyncSpy) writeFileSyncSpy.mockRestore()
  if (writeFileSyncPromisesSpy) writeFileSyncPromisesSpy.mockRestore()
  if (mkdirSyncSpy) mkdirSyncSpy.mockRestore()
  if (existsSyncSpy) existsSyncSpy.mockRestore()
  if (appendFileSyncSpy) appendFileSyncSpy.mockRestore()
  if (chmodSyncSpy) chmodSyncSpy.mockRestore()
  if (renameSyncSpy) renameSyncSpy.mockRestore()
  mock.module('node:child_process', () => ({ ...realCpSnapshot, default: realCpSnapshot }))
  mock.module('node-pty', () => ({ ...realNodePtySnapshot, default: realNodePtySnapshot }))
  mock.restore()
})

// afterEach already re-registers both specs; this is the belt-and-braces the
// #505 / #552 convention asks for, for the case where the last afterEach never
// runs (a bail-out or a crash inside a test).
afterAll(() => {
  mock.module('node:child_process', () => ({ ...realCpSnapshot, default: realCpSnapshot }))
  mock.module('node-pty', () => ({ ...realNodePtySnapshot, default: realNodePtySnapshot }))
})

test('every spawn site setting BRIDGE_PANEL_ID also sets BRIDGE_HOOK_DESCRIPTOR (behavioral)', async () => {
  const dummyCtx = {
    serverUrl: 'http://test',
    token: 'test',
    workspaceId: 'ws-test',
    projectId: 'proj-test',
    agentId: 'agent-test',
    cwd: '/tmp/test'
  }

  writeFileSyncSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {})
  writeFileSyncPromisesSpy = spyOn(fsPromises, 'writeFile').mockImplementation(async () => {})
  mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
  existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation(() => true)
  appendFileSyncSpy = spyOn(fs, 'appendFileSync').mockImplementation(() => {})
  chmodSyncSpy = spyOn(fs, 'chmodSync').mockImplementation(() => {})
  renameSyncSpy = spyOn(fs, 'renameSync').mockImplementation(() => {})
  let spawnSyncCalls: any[] = []
  mock.module('node:child_process', () => ({
    spawnSync: (...args: any[]) => {
      spawnSyncCalls.push(args)
      return { status: 0, stdout: '' }
    },
    execFile: () => {}
  }))

  const expectedDescriptor = getHookEndpointPath()
  const builders = __test_getAllMcpBuilders()

  for (const builder of builders) {
    writeFileSyncSpy.mockClear()
    
    let result: any
    try {
      const ptyMockManager = { getLivePanels: () => [] }
      result = builder(dummyCtx as any, ptyMockManager as any)
      if (result instanceof Promise) {
        result = await result
      }
    } catch (e) {
      // Some builders might fail due to other missing mocks, just ensure we catch it
    }

    let foundDescriptor = false

    // 1. Check returned object/array
    if (result) {
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
      if (resultStr.includes(expectedDescriptor)) {
        foundDescriptor = true
      }
    }

    // 2. Check fs.writeFileSync calls
    for (const call of writeFileSyncSpy.mock.calls) {
      const writtenData = call[1]
      const dataStr = typeof writtenData === 'string' ? writtenData : JSON.stringify(writtenData)
      if (dataStr.includes(expectedDescriptor)) {
        foundDescriptor = true
      }
    }
    // 3. Check spawnSync calls
    for (const call of spawnSyncCalls) {
      const dataStr = JSON.stringify(call)
      if (dataStr.includes(expectedDescriptor)) {
        foundDescriptor = true
      }
    }
    spawnSyncCalls = []

    if (!foundDescriptor) {
      console.log('writeFileSync calls:', writeFileSyncSpy.mock.calls)
      throw new Error(`Builder failed to include descriptor: ${builder.name}`)
    }
    expect(foundDescriptor).toBe(true)
  }

  // Also test pty/manager.ts
  const ptyMock = {
    onData: mock(),
    onExit: mock(),
    kill: mock(),
    write: mock(),
    resize: mock(),
    pid: 123
  }
  const ptySpy = mock().mockReturnValue(ptyMock)
  mock.module('node-pty', () => ({ spawn: ptySpy }))
  
  // Need to dynamically import PtyManager so the mock applies
  const { PtyManager: MockedPtyManager } = await import('../pty/manager.js')
  const manager = new MockedPtyManager()
  
  manager.spawn('st-agent', 'claude', '/bin/sh', [], 80, 24, () => {}, () => {}, dummyCtx as any, '11111111-1111-4111-8111-111111111111' as any)
  
  const spawnCalls = ptySpy.mock.calls
  expect(spawnCalls.length).toBeGreaterThan(0)
  const spawnEnv = spawnCalls[0][2].env
  expect(spawnEnv[DESCRIPTOR_ENV_VAR]).toBe(expectedDescriptor)
})

test('source scan backstop', async () => {
  const daemonSrc = path.join(import.meta.dir, '..')
  
  async function getFiles(dir: string): Promise<string[]> {
    const dirents = await fsPromises.readdir(dir, { withFileTypes: true })
    const files = await Promise.all(dirents.map(async (dirent) => {
      const res = path.resolve(dir, dirent.name)
      return dirent.isDirectory() ? getFiles(res) : res
    }))
    return Array.prototype.concat(...files)
  }

  const files = await getFiles(daemonSrc)
  const tsFiles = files.filter(f => f.endsWith('.ts') && !f.includes('__tests__'))

  let violations = 0
  const allowedFiles = ['protocol.ts', 'script.ts', 'client.ts'] // client.ts is excluded because we test it behaviorally above

  for (const file of tsFiles) {
    if (allowedFiles.some(af => file.endsWith(af))) continue

    const content = await fsPromises.readFile(file, 'utf-8')
    const lines = content.split('\n')
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.match(/BRIDGE_PANEL_ID['"]?\s*[:=]|\[['"]BRIDGE_PANEL_ID['"]\]\s*=/)) {
        const windowStart = Math.max(0, i - 5)
        const windowEnd = Math.min(lines.length, i + 5)
        const window = lines.slice(windowStart, windowEnd).join('\n')
        
        // As requested by IMPL-19 Defect 0: drop the getHookEnvPairs escape.
        if (!window.includes('BRIDGE_HOOK_DESCRIPTOR')) {
          console.error(`Violation in ${file}:${i + 1} - BRIDGE_PANEL_ID set without BRIDGE_HOOK_DESCRIPTOR`)
          violations++
        }
      }
    }
  }

  expect(violations).toBe(0)
})

test('panel spawn environment never turns hook diagnostics on implicitly', () => {
  const env = getHookEnvPairs('panel-1', 7) as Record<string, string>
  expect(env.JERICO_HOOK_DIAG).toBeUndefined()
  expect(env.BRIDGE_HOOK_DEBUG).toBeUndefined()
})
