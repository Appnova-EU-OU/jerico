import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'

let openSyncCalls: any[] = []
let openSyncResult: any = 42
let openSyncError: any = null

let mkdirSyncCalls: any[] = []
let mkdirSyncError: any = null

let warnCalls: string[] = []
let unlinkCalls: string[] = []
let readFileResult: string = '{}'
let existsResult: boolean = false
let processKillError: any = null

const mockOpenSync = mock((...args: any[]) => {
  openSyncCalls.push(args)
  if (openSyncError) throw openSyncError
  return openSyncResult
})

const mockMkdirSync = mock((...args: any[]) => {
  mkdirSyncCalls.push(args)
  if (mkdirSyncError) throw mkdirSyncError
  return undefined
})

const mockExistsSync = mock(() => existsResult)
const mockWriteSync = mock(() => {})
const mockCloseSync = mock(() => {})
const mockUnlinkSync = mock((p: string) => { unlinkCalls.push(p) })
const mockReadFileSync = mock(() => readFileResult)
const mockProcessKill = mock((pid: number, signal: string | number) => {
  if (processKillError) throw processKillError
})

// #505: require() bypasses Bun's mock.module registry for builtins and always
// returns the real module, even after mocking is active — the only reliable
// way to both build the mock AND later restore it. A captured `import * as fs`
// namespace object is NOT safe for this: mock.module writes onto that same
// live namespace, so a restore using it would just re-register the
// (already mocked) namespace.
const realFsSnapshot = { ...require('node:fs') }

mock.module('node:fs', () => ({
  ...realFsSnapshot,
  default: realFsSnapshot, // preserve `import fs from 'fs'` default-importers
  openSync: mockOpenSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
  writeSync: mockWriteSync,
  closeSync: mockCloseSync,
  unlinkSync: mockUnlinkSync,
  readFileSync: mockReadFileSync,
}))

const realConsole = { log: console.log, warn: console.warn, error: console.error }
global.console.warn = mock((msg: string) => {
  warnCalls.push(msg)
}) as any

global.console.log = mock(() => {}) as any

global.console.error = mock(() => {}) as any

const originalKill = process.kill
process.kill = mockProcessKill as any

import { acquireDaemonLock } from '../commands/start.js'
import { __setDaemonIdentity, __resetDaemonIdentity } from '../version.js'

const CURRENT_VERSION = '0.15.2'
const CURRENT_BINARY_PATH = '/current/daemon/binary'

describe('acquireDaemonLock identity-reclaim decisions (cleanupStaleLock)', () => {
  // Bun's mock.module is process-global with no unmock API — re-registering
  // the pristine snapshot is the only way to stop this file's fs/console/
  // process.kill mocks from leaking into every other test file that runs
  // afterward in the same `bun test` process. (The previous restore attempt
  // at the bottom of this file — `process.kill = originalKill;
  // __resetDaemonIdentity()` at module top level — ran during module
  // evaluation, i.e. BEFORE any test ran, not after; it was dead code.)
  afterAll(() => {
    mock.module('node:fs', () => ({ ...realFsSnapshot, default: realFsSnapshot }))
    console.log = realConsole.log
    console.warn = realConsole.warn
    console.error = realConsole.error
    process.kill = originalKill
    __resetDaemonIdentity()
  })

  beforeEach(() => {
    openSyncCalls = []
    openSyncResult = 42
    openSyncError = { code: 'EEXIST' }
    mkdirSyncCalls = []
    mkdirSyncError = null
    warnCalls = []
    unlinkCalls = []
    readFileResult = '{}'
    existsResult = true
    processKillError = null

    // Reset module-level kill state between tests
    process.kill = mockProcessKill as any
    __setDaemonIdentity(CURRENT_VERSION, CURRENT_BINARY_PATH)

    mockOpenSync.mockClear()
    mockMkdirSync.mockClear()
    mockExistsSync.mockClear()
    mockUnlinkSync.mockClear()
    mockReadFileSync.mockClear()
    mockProcessKill.mockClear()
  })

  test('daemon lock, different version, ALIVE -> NOT reclaimed (R1 regression guard)', () => {
    __setDaemonIdentity('0.15.2', '/current/daemon/binary')
    readFileResult = JSON.stringify({
      pid: 12345,
      shutdownToken: 'daemon-token',
      version: '9.9.9',
      binaryPath: '/old/binary',
    })

    const result = acquireDaemonLock()
    expect(result.ok).toBe(false)
    expect(unlinkCalls.length).toBe(0)
  })

  test('CLI lock, different version -> reclaimed (F30-B3)', () => {
    __setDaemonIdentity('0.15.2', '/current/daemon/binary')
    readFileResult = JSON.stringify({
      pid: 12345,
      version: '9.9.9',
      binaryPath: '/old/binary',
    })
    acquireDaemonLock()
    expect(unlinkCalls.length).toBe(1)
  })

  test('CLI lock, matching version but different binaryPath -> reclaimed (binaryPath dimension)', () => {
    __setDaemonIdentity('0.15.2', '/current/daemon/binary')
    readFileResult = JSON.stringify({
      pid: 12345,
      version: '0.15.2',
      binaryPath: '/different/binary',
    })
    acquireDaemonLock()
    expect(unlinkCalls.length).toBe(1)
  })

  test('daemon lock, matching version but different binaryPath, ALIVE -> NOT reclaimed (R1 regression guard)', () => {
    __setDaemonIdentity('0.15.2', '/current/daemon/binary')
    readFileResult = JSON.stringify({
      pid: 12345,
      shutdownToken: 'daemon-token',
      version: '0.15.2',
      binaryPath: '/different/binary',
    })

    const result = acquireDaemonLock()
    expect(result.ok).toBe(false)
    expect(unlinkCalls.length).toBe(0)
  })

  test('daemon lock, matching identity, dead pid (ESRCH) -> reclaimed', () => {
    __setDaemonIdentity('0.15.2', '/current/daemon/binary')
    processKillError = Object.assign(new Error('No such process'), { code: 'ESRCH' })
    readFileResult = JSON.stringify({
      pid: 12345,
      shutdownToken: 'daemon-token',
      version: '0.15.2',
      binaryPath: '/current/daemon/binary',
    })

    const result = acquireDaemonLock()
    expect(result.ok).toBe(false)
    expect(unlinkCalls.length).toBe(1)
  })

  test('daemon lock, matching identity, ALIVE -> kept', () => {
    __setDaemonIdentity('0.15.2', '/current/daemon/binary')
    readFileResult = JSON.stringify({
      pid: 12345,
      shutdownToken: 'daemon-token',
      version: '0.15.2',
      binaryPath: '/current/daemon/binary',
    })

    const result = acquireDaemonLock()
    expect(result.ok).toBe(false)
    expect(unlinkCalls.length).toBe(0)
  })
})
