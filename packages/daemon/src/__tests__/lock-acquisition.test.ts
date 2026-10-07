import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'

let openSyncCalls: any[] = []
let openSyncResult: any = 42
let openSyncError: any = null

let mkdirSyncCalls: any[] = []
let mkdirSyncError: any = null

let warnCalls: string[] = []

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

const mockExistsSync = mock(() => false)
const mockWriteSync = mock(() => {})
const mockCloseSync = mock(() => {})
const mockUnlinkSync = mock(() => {})
const mockReadFileSync = mock(() => '{}')

// #505: require() bypasses Bun's mock.module registry for builtins and always
// returns the real module, even after mocking is active — this is the only
// reliable way to both build the mock AND later restore it. A captured
// `import * as fs` namespace object is NOT safe for this: mock.module writes
// onto that same live namespace, so by the time a restore ran it would just
// be re-registering the (already mocked) namespace.
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

const realConsoleWarn = console.warn
global.console.warn = mock((msg: string) => {
  warnCalls.push(msg)
}) as any

import { acquireDaemonLock } from '../commands/start.js'

describe('acquireDaemonLock and mkdirSync error handling', () => {
  // Bun's mock.module is process-global with no unmock API — re-registering
  // the pristine snapshot is the only way to stop this file's fs/console
  // mocks from leaking into every other test file that runs afterward in
  // the same `bun test` process.
  afterAll(() => {
    mock.module('node:fs', () => ({ ...realFsSnapshot, default: realFsSnapshot }))
    console.warn = realConsoleWarn
  })

  beforeEach(() => {
    openSyncCalls = []
    openSyncResult = 42
    openSyncError = null
    mkdirSyncCalls = []
    mkdirSyncError = null
    warnCalls = []
    
    mockOpenSync.mockClear()
    mockMkdirSync.mockClear()
    mockExistsSync.mockClear()
  })

  test('returns ok: true on successful lock acquisition', () => {
    const result = acquireDaemonLock()
    expect(result.ok).toBe(true)
    expect(openSyncCalls.length).toBe(1)
  })

  test('returns ok: false and err with EEXIST code', () => {
    const error: any = new Error('File exists')
    error.code = 'EEXIST'
    openSyncError = error
    
    const result = acquireDaemonLock()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.err?.code).toBe('EEXIST')
    }
  })

  test('returns ok: false and err with EACCES code', () => {
    const error: any = new Error('Permission denied')
    error.code = 'EACCES'
    openSyncError = error
    
    const result = acquireDaemonLock()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.err?.code).toBe('EACCES')
    }
  })

  test('returns ok: false and err with ENOENT code', () => {
    const error: any = new Error('No such file or directory')
    error.code = 'ENOENT'
    openSyncError = error
    
    const result = acquireDaemonLock()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.err?.code).toBe('ENOENT')
    }
  })

  test('mkdirSync swallows EEXIST silently', () => {
    const error: any = new Error('File exists')
    error.code = 'EEXIST'
    mkdirSyncError = error

    const result = acquireDaemonLock()
    expect(result.ok).toBe(true)
    expect(warnCalls.length).toBe(0)
  })

  test('mkdirSync swallows EISDIR silently', () => {
    const error: any = new Error('Is a directory')
    error.code = 'EISDIR'
    mkdirSyncError = error

    const result = acquireDaemonLock()
    expect(result.ok).toBe(true)
    expect(warnCalls.length).toBe(0)
  })

  test('mkdirSync logs warning for other errors (e.g. EACCES)', () => {
    const error: any = new Error('Permission denied')
    error.code = 'EACCES'
    mkdirSyncError = error

    const result = acquireDaemonLock()
    expect(result.ok).toBe(true)
    expect(warnCalls.length).toBe(1)
    const msg = warnCalls[0] || ''
    expect(msg.includes('warning: mkdirSync failed')).toBe(true)
    expect(msg.includes('EACCES')).toBe(true)
  })
})
