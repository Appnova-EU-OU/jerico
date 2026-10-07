import { test, expect, spyOn, mock, afterEach, afterAll, beforeEach } from 'bun:test'
import * as realFs from 'node:fs'
import * as realChildProcess from 'node:child_process'
import { runUninstall } from '../commands/uninstall.js'
import { canRemoveSharedMcpWrapper, getAllArtifactPaths } from '../profile.js'
import * as installHooks from '../hooks/install.js'

let unlinkSyncSpy: ReturnType<typeof spyOn>
let rmdirSyncSpy: ReturnType<typeof spyOn>
let rmSyncSpy: ReturnType<typeof spyOn>
let existsSyncSpy: ReturnType<typeof spyOn>
let removeHookBlockSpy: ReturnType<typeof spyOn>
let exitSpy: ReturnType<typeof spyOn>
let execSyncSpy: ReturnType<typeof spyOn>
let processKillSpy: ReturnType<typeof spyOn>
let isolatedHome: string
let homeBeforeTest: string | undefined
let isolatedHarnessBeforeTest: string | undefined
let harnessFileStoreBeforeTest: string | undefined

beforeEach(() => {
  homeBeforeTest = process.env['HOME']
  isolatedHarnessBeforeTest = process.env['JERICO_ISOLATED_HARNESS']
  harnessFileStoreBeforeTest = process.env['JERICO_HARNESS_FILE_TOKEN_STORE']
  isolatedHome = realFs.mkdtempSync('/tmp/jerico-uninstall-test-home-')
  process.env['HOME'] = isolatedHome
  process.env['JERICO_ISOLATED_HARNESS'] = '1'
  process.env['JERICO_HARNESS_FILE_TOKEN_STORE'] = '1'
  rmSyncSpy = spyOn(realFs, 'rmSync').mockImplementation(() => {})
})

afterEach(() => {
  if (unlinkSyncSpy) unlinkSyncSpy.mockRestore()
  if (rmdirSyncSpy) rmdirSyncSpy.mockRestore()
  if (rmSyncSpy) rmSyncSpy.mockRestore()
  if (existsSyncSpy) existsSyncSpy.mockRestore()
  if (removeHookBlockSpy) removeHookBlockSpy.mockRestore()
  if (exitSpy) exitSpy.mockRestore()
  if (execSyncSpy) execSyncSpy.mockRestore()
  if (processKillSpy) processKillSpy.mockRestore()
  mock.restore()
  if (homeBeforeTest) process.env['HOME'] = homeBeforeTest
  else delete process.env['HOME']
  // Restore, never blanket-delete: these markers must not leak to later files
  // in the same bun process, nor erase a value the outer harness set.
  if (isolatedHarnessBeforeTest === undefined) delete process.env['JERICO_ISOLATED_HARNESS']
  else process.env['JERICO_ISOLATED_HARNESS'] = isolatedHarnessBeforeTest
  if (harnessFileStoreBeforeTest === undefined) delete process.env['JERICO_HARNESS_FILE_TOKEN_STORE']
  else process.env['JERICO_HARNESS_FILE_TOKEN_STORE'] = harnessFileStoreBeforeTest
  realFs.rmSync(isolatedHome, { recursive: true, force: true })
})

// The tests below call mock.module('../token-store.js', ...) individually.
// Without this the last one registered leaks into every later test file in the
// same `bun test` process (#505 / #552). Snapshot via require(), never via
// `import * as` — mock.module mutates a namespace object in place.
const realTokenStore = { ...require('../token-store.js') }
afterAll(() => {
  mock.module('../token-store.js', () => ({ ...realTokenStore, default: realTokenStore }))
})

test('profile artifact inventory includes every uninstall residue and preserves a shared MCP wrapper for another profile', () => {
  const originalProfile = process.env['BRIDGE_PROFILE']
  const originalHome = process.env['HOME']
  const testHome = realFs.mkdtempSync('/tmp/jerico-uninstall-artifacts-')
  try {
    process.env['HOME'] = testHome
    process.env['BRIDGE_PROFILE'] = 'dev'
    const artifacts = getAllArtifactPaths()
    expect(artifacts.spawnManifest).toBe(`${testHome}/.bridge/spawn-manifest-dev.json`)
    expect(artifacts.introSeen).toBe(`${testHome}/.jerico/profiles/dev/intro-seen`)
    expect(artifacts.logLifecycle).toBe(`${testHome}/bridge-daemon-dev.lifecycle.log`)
    expect(artifacts.sharedMcpWrapper).toBe(`${testHome}/.bridge/bin/bridge-mcp`)
    expect(canRemoveSharedMcpWrapper()).toBe(true)

    realFs.mkdirSync(`${testHome}/.jerico/profiles/other`, { recursive: true })
    realFs.writeFileSync(`${testHome}/.jerico/profiles/other/settings.json`, '{}')
    expect(canRemoveSharedMcpWrapper()).toBe(false)
  } finally {
    if (originalProfile) process.env['BRIDGE_PROFILE'] = originalProfile
    else delete process.env['BRIDGE_PROFILE']
    if (originalHome) process.env['HOME'] = originalHome
    else delete process.env['HOME']
    realFs.rmSync(testHome, { recursive: true, force: true })
  }
})

test('profile-scoped uninstall does NOT remove the shared script', async () => {
  // Mock profile environment
  const originalProfile = process.env['BRIDGE_PROFILE']
  process.env['BRIDGE_PROFILE'] = 'dev'
  
  unlinkSyncSpy = spyOn(realFs, 'unlinkSync').mockImplementation(() => {})
  rmdirSyncSpy = spyOn(realFs, 'rmdirSync').mockImplementation(() => {})
  existsSyncSpy = spyOn(realFs, 'existsSync').mockImplementation(() => true)
  removeHookBlockSpy = spyOn(installHooks, 'removeHookBlock').mockImplementation(async () => 'installed')
  exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never)
  execSyncSpy = spyOn(realChildProcess, 'execSync').mockImplementation(() => Buffer.from(''))
  processKillSpy = spyOn(process, 'kill').mockImplementation(() => true)

  mock.module('../token-store.js', () => ({
    deleteToken: () => {},
    deleteAllTokens: () => {}
  }))

  const unlinked: string[] = []
  unlinkSyncSpy.mockImplementation((p: string) => { unlinked.push(p) })

  await runUninstall({ dryRun: false, force: true })

  // Ensure bootout was requested
  expect(execSyncSpy).toHaveBeenCalledWith(
    expect.stringContaining('launchctl bootout'),
    expect.any(Object)
  )

  // The hook script should NOT be unlinked
  const scriptRemoved = unlinked.some(p => p.includes('jerico-hook.sh'))
  expect(scriptRemoved).toBe(false)
  
  // The block should NOT be removed
  expect(removeHookBlockSpy).toHaveBeenCalledTimes(0)

  // Restore env
  if (originalProfile) process.env['BRIDGE_PROFILE'] = originalProfile
  else delete process.env['BRIDGE_PROFILE']
})

test('default-profile uninstall removes the block before the script', async () => {
  // Default profile (no BRIDGE_PROFILE env)
  const originalProfile = process.env['BRIDGE_PROFILE']
  delete process.env['BRIDGE_PROFILE']
  
  unlinkSyncSpy = spyOn(realFs, 'unlinkSync').mockImplementation(() => {})
  rmdirSyncSpy = spyOn(realFs, 'rmdirSync').mockImplementation(() => {})
  existsSyncSpy = spyOn(realFs, 'existsSync').mockImplementation(() => true)
  removeHookBlockSpy = spyOn(installHooks, 'removeHookBlock').mockImplementation(async () => 'installed')
  exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never)
  execSyncSpy = spyOn(realChildProcess, 'execSync').mockImplementation(() => Buffer.from(''))
  processKillSpy = spyOn(process, 'kill').mockImplementation(() => true)
  
  const orderOfEvents: string[] = []
  
  removeHookBlockSpy = spyOn(installHooks, 'removeHookBlock').mockImplementation(async () => {
    orderOfEvents.push('removeHookBlock')
    return 'installed'
  })

  unlinkSyncSpy.mockImplementation((p: string) => {
    if (typeof p === 'string' && p.includes('jerico-hook.sh')) {
      orderOfEvents.push('unlinkScript')
    }
  })

  mock.module('../token-store.js', () => ({
    deleteToken: () => {},
    deleteAllTokens: () => {}
  }))

  await runUninstall({ dryRun: false, force: true })

  expect(execSyncSpy).toHaveBeenCalledWith(
    expect.stringContaining('launchctl bootout'),
    expect.any(Object)
  )

  expect(orderOfEvents).toEqual(['removeHookBlock', 'unlinkScript'])

  if (originalProfile) process.env['BRIDGE_PROFILE'] = originalProfile
})

test('default-profile uninstall does NOT remove script when removeHookBlock throws', async () => {
  const originalProfile = process.env['BRIDGE_PROFILE']
  delete process.env['BRIDGE_PROFILE']
  
  unlinkSyncSpy = spyOn(realFs, 'unlinkSync').mockImplementation(() => {})
  rmdirSyncSpy = spyOn(realFs, 'rmdirSync').mockImplementation(() => {})
  existsSyncSpy = spyOn(realFs, 'existsSync').mockImplementation(() => true)
  exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never)
  execSyncSpy = spyOn(realChildProcess, 'execSync').mockImplementation(() => Buffer.from(''))
  processKillSpy = spyOn(process, 'kill').mockImplementation(() => true)
  
  removeHookBlockSpy = spyOn(installHooks, 'removeHookBlock').mockImplementation(async () => {
    throw new Error('mock block error')
  })

  mock.module('../token-store.js', () => ({
    deleteToken: () => {},
    deleteAllTokens: () => {}
  }))

  const unlinked: string[] = []
  unlinkSyncSpy.mockImplementation((p: string) => { unlinked.push(p) })

  let capturedJson: any = null
  const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((data: any) => {
    if (typeof data === 'string' && data.includes('"errors":')) {
      try { capturedJson = JSON.parse(data) } catch (e) {}
    }
    return true
  })

  await runUninstall({ dryRun: false, force: true, json: true })
  stdoutSpy.mockRestore()

  expect(execSyncSpy).toHaveBeenCalledWith(
    expect.stringContaining('launchctl bootout'),
    expect.any(Object)
  )

  const scriptRemoved = unlinked.some(p => p.includes('jerico-hook.sh'))
  expect(scriptRemoved).toBe(false)
  expect(capturedJson).toBeDefined()
  
  const blockError = capturedJson.errors.find((e: any) => e.step === 'hook_block')
  expect(blockError).toBeDefined()
  expect(blockError.error).toContain('mock block error')

  if (originalProfile) process.env['BRIDGE_PROFILE'] = originalProfile
})

test('default-profile uninstall does NOT remove script when removeHookBlock resolves with refusal', async () => {
  const originalProfile = process.env['BRIDGE_PROFILE']
  delete process.env['BRIDGE_PROFILE']
  
  unlinkSyncSpy = spyOn(realFs, 'unlinkSync').mockImplementation(() => {})
  rmdirSyncSpy = spyOn(realFs, 'rmdirSync').mockImplementation(() => {})
  existsSyncSpy = spyOn(realFs, 'existsSync').mockImplementation(() => true)
  exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never)
  execSyncSpy = spyOn(realChildProcess, 'execSync').mockImplementation(() => Buffer.from(''))
  processKillSpy = spyOn(process, 'kill').mockImplementation(() => true)
  
  removeHookBlockSpy = spyOn(installHooks, 'removeHookBlock').mockImplementation(async () => {
    return 'refused-malformed'
  })

  mock.module('../token-store.js', () => ({
    deleteToken: () => {},
    deleteAllTokens: () => {}
  }))

  const unlinked: string[] = []
  unlinkSyncSpy.mockImplementation((p: string) => { unlinked.push(p) })

  let capturedJson: any = null
  const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((data: any) => {
    if (typeof data === 'string' && data.includes('"errors":')) {
      try { capturedJson = JSON.parse(data) } catch (e) {}
    }
    return true
  })

  await runUninstall({ dryRun: false, force: true, json: true })
  stdoutSpy.mockRestore()

  expect(execSyncSpy).toHaveBeenCalledWith(
    expect.stringContaining('launchctl bootout'),
    expect.any(Object)
  )

  const scriptRemoved = unlinked.some(p => p.includes('jerico-hook.sh'))
  expect(scriptRemoved).toBe(false)
  expect(capturedJson).toBeDefined()
  
  const blockError = capturedJson.errors.find((e: any) => e.step === 'hook_block')
  expect(blockError).toBeDefined()
  expect(blockError.error).toContain('refused-malformed')

  if (originalProfile) process.env['BRIDGE_PROFILE'] = originalProfile
})
