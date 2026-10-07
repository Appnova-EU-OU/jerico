import { test, expect, spyOn, mock, afterEach, afterAll, beforeEach } from 'bun:test'
import * as realFs from 'node:fs'
import * as realChildProcess from 'node:child_process'
import { userInfo } from 'node:os'
import path from 'node:path'
import { runUninstall } from '../commands/uninstall.js'
import * as installHooks from '../hooks/install.js'

// runUninstall-level behaviour against a REAL filesystem inside a throwaway
// HOME. Only the machine-touching edges are stubbed: launchctl (execSync),
// process.kill/exit, the Claude hook block, the token store (its Keychain path
// runs /usr/bin/security by absolute path, so a PATH shim cannot intercept it)
// and the recursive rmSync of the evidence root. Paths are spelled out literally
// rather than read from profile.ts so the assertions do not depend on the code
// under test.

const ENV_KEYS = ['HOME', 'BRIDGE_PROFILE'] as const
let savedEnv: Record<string, string | undefined>
let home: string
const spies: Array<{ mockRestore(): void }> = []

const realTokenStore = { ...require('../token-store.js') }
afterAll(() => {
  mock.module('../token-store.js', () => ({ ...realTokenStore, default: realTokenStore }))
})

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  home = realFs.realpathSync(realFs.mkdtempSync('/tmp/jerico-uninstall-residue-'))
  process.env['HOME'] = home

  spies.push(
    spyOn(realChildProcess, 'execSync').mockImplementation(() => Buffer.from('')),
    spyOn(realFs, 'rmSync').mockImplementation(() => {}),
    spyOn(process, 'kill').mockImplementation(() => true),
    spyOn(process, 'exit').mockImplementation(() => undefined as never),
    spyOn(installHooks, 'removeHookBlock').mockImplementation(async () => 'installed'),
  )
  mock.module('../token-store.js', () => ({ deleteToken: () => {}, deleteAllTokens: () => {} }))
})

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore()
  mock.restore()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  realFs.rmSync(home, { recursive: true, force: true })
})

function touch(rel: string): string {
  const p = path.join(home, rel)
  realFs.mkdirSync(path.dirname(p), { recursive: true })
  realFs.writeFileSync(p, 'x')
  return p
}

async function uninstall(profile: string | undefined): Promise<void> {
  if (profile) process.env['BRIDGE_PROFILE'] = profile
  else delete process.env['BRIDGE_PROFILE']
  // Last line of defence: never run a real uninstall against the real home.
  expect(process.env['HOME']).toBe(home)
  expect(home).not.toBe(userInfo().homedir)
  await runUninstall({ dryRun: false, force: true })
}

const SHARED_MCP = '.bridge/bin/bridge-mcp'

test('dev uninstall unlinks its lifecycle log, spawn manifest and intro marker', async () => {
  const residue = [
    touch('bridge-daemon-dev.lifecycle.log'),
    touch('.bridge/spawn-manifest-dev.json'),
    touch('.jerico/profiles/dev/intro-seen'),
  ]
  await uninstall('dev')
  for (const p of residue) expect({ p, exists: realFs.existsSync(p) }).toEqual({ p, exists: false })
})

test('default-profile uninstall unlinks its lifecycle log, spawn manifest and intro marker', async () => {
  const residue = [
    touch('bridge-daemon.lifecycle.log'),
    touch('.bridge/spawn-manifest.json'),
    touch('.jerico/intro-seen'),
  ]
  await uninstall(undefined)
  for (const p of residue) expect({ p, exists: realFs.existsSync(p) }).toEqual({ p, exists: false })
})

test('dev uninstall keeps the shared bridge-mcp wrapper while the prod profile is installed', async () => {
  const wrapper = touch(SHARED_MCP)
  touch('.jerico/settings.json')
  const manifest = touch('.bridge/spawn-manifest-dev.json')
  await uninstall('dev')
  expect(realFs.existsSync(manifest)).toBe(false) // the dev residue step did run
  expect(realFs.existsSync(wrapper)).toBe(true)
})

test('dev uninstall keeps the shared bridge-mcp wrapper while another named profile is installed', async () => {
  const wrapper = touch(SHARED_MCP)
  touch('.jerico/profiles/other/settings.json')
  const manifest = touch('.bridge/spawn-manifest-dev.json')
  await uninstall('dev')
  expect(realFs.existsSync(manifest)).toBe(false)
  expect(realFs.existsSync(wrapper)).toBe(true)
})

test('default-profile uninstall keeps the shared bridge-mcp wrapper while a named profile is installed', async () => {
  const wrapper = touch(SHARED_MCP)
  touch('.jerico/profiles/dev/settings.json')
  const manifest = touch('.bridge/spawn-manifest.json')
  await uninstall(undefined)
  expect(realFs.existsSync(manifest)).toBe(false)
  expect(realFs.existsSync(wrapper)).toBe(true)
})

test('dev uninstall removes the shared bridge-mcp wrapper when no other profile remains', async () => {
  const wrapper = touch(SHARED_MCP)
  touch('.jerico/profiles/dev/settings.json')
  await uninstall('dev')
  expect(realFs.existsSync(wrapper)).toBe(false)
})

test('default-profile uninstall removes the shared bridge-mcp wrapper when no other profile remains', async () => {
  const wrapper = touch(SHARED_MCP)
  touch('.jerico/settings.json')
  await uninstall(undefined)
  expect(realFs.existsSync(wrapper)).toBe(false)
})
