import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertHookBlock, removeHookBlock } from '../hooks/install.js'
import { getOpenCodePluginPath, renderOpenCodePlugin } from '../hooks/opencode.js'
import { handleAgentHookRequest } from '../hooks/receiver.js'
import {
  DESCRIPTOR_FIELD_TOKEN,
  DESCRIPTOR_FIELD_URL,
  HOOK_ROUTE_PATH,
} from '../hooks/protocol.js'
import { getHookEndpointPath, getHookScriptPath, getOpenCodeConfigDir } from '../profile.js'

let tempHome: string
let originalHome: string | undefined
let originalProfile: string | undefined
let server: Server | null = null

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), 'jerico-opencode-hook-'))
  originalHome = process.env.HOME
  originalProfile = process.env.BRIDGE_PROFILE
  process.env.HOME = tempHome
  process.env.BRIDGE_PROFILE = 'r14-test'
})

afterEach(async () => {
  const current = server
  server = null
  if (current) await new Promise<void>(resolve => current.close(() => resolve()))
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalProfile === undefined) delete process.env.BRIDGE_PROFILE
  else process.env.BRIDGE_PROFILE = originalProfile
  await rm(tempHome, { recursive: true, force: true })
})

async function loadInstalledPlugin(): Promise<any> {
  const url = `${pathToFileURL(getOpenCodePluginPath()).href}?test=${Math.random()}`
  return import(url)
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for hook callback')
}

describe('OpenCode plugin-file hook target', () => {
  test('install writes the exact plugin under the profile-owned config and nowhere user/project-owned', async () => {
    const projectDir = path.join(tempHome, 'project')
    await mkdir(projectDir)

    expect(await assertHookBlock('opencode')).toBe('installed')
    expect(getOpenCodeConfigDir()).toBe(path.join(tempHome, '.jerico', 'profiles', 'r14-test', 'opencode'))
    expect(getOpenCodePluginPath()).toBe(path.join(tempHome, '.jerico', 'profiles', 'r14-test', 'opencode', 'plugin', 'jerico-hook.js'))
    expect(await readFile(getOpenCodePluginPath(), 'utf8')).toBe(renderOpenCodePlugin())
    expect((await stat(getOpenCodePluginPath())).mode & 0o777).toBe(0o600)
    expect(existsSync(path.join(projectDir, '.opencode'))).toBe(false)
    expect(existsSync(path.join(tempHome, '.config', 'opencode'))).toBe(false)
    expect(existsSync(path.join(tempHome, '.opencode'))).toBe(false)
    expect(existsSync(getHookScriptPath())).toBe(false)
    expect(await assertHookBlock('opencode')).toBe('already-present')
  })

  test('uninstall removes only the plugin file', async () => {
    await assertHookBlock('opencode')
    const sibling = path.join(getOpenCodeConfigDir(), 'keep.txt')
    await writeFile(sibling, 'foreign-sibling')

    expect(await removeHookBlock('opencode')).toBe('installed')
    expect(existsSync(getOpenCodePluginPath())).toBe(false)
    expect(await readFile(sibling, 'utf8')).toBe('foreign-sibling')
    expect(existsSync(getOpenCodeConfigDir())).toBe(true)
    expect(await removeHookBlock('opencode')).toBe('target-missing')
  })

  test('session.idle and session.error cross the real daemon protocol as distinct events', async () => {
    const forwarded: any[] = []
    const token = 'opencode-test-token'
    server = createServer((req, res) => {
      void handleAgentHookRequest(req, res, {
        manager: {
          getLiveHookTarget: () => ({ agentId: 'oc-panel', instanceId: 41, agentKey: 'opencode' }),
        } as any,
        expectedToken: token,
        ws: {
          readyState: 1,
          send: (data: string, callback: (error?: Error) => void) => {
            forwarded.push(JSON.parse(data))
            callback()
          },
        } as any,
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')

    const descriptorPath = getHookEndpointPath()
    await mkdir(path.dirname(descriptorPath), { recursive: true })
    await writeFile(descriptorPath, JSON.stringify({
      [DESCRIPTOR_FIELD_URL]: `http://127.0.0.1:${address.port}${HOOK_ROUTE_PATH}`,
      [DESCRIPTOR_FIELD_TOKEN]: token,
    }))
    process.env.BRIDGE_HOOK_DESCRIPTOR = descriptorPath
    process.env.BRIDGE_PANEL_ID = 'oc-panel'
    process.env.BRIDGE_PANEL_INSTANCE_ID = '41'

    try {
      await assertHookBlock('opencode')
      const pluginModule = await loadInstalledPlugin()
      const hooks = await pluginModule.default({})

      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'oc-session-1' } } })
      const idle = await waitFor(() => forwarded[0])
      expect(idle.event).toBe('turn_ended')
      expect(idle.providerSessionId).toBe('oc-session-1')

      await hooks.event({ event: { type: 'session.error', properties: { sessionID: 'oc-session-2' } } })
      const failed = await waitFor(() => forwarded[1])
      expect(failed.event).toBe('turn_failed')
      expect(failed.providerSessionId).toBe('oc-session-2')
    } finally {
      delete process.env.BRIDGE_HOOK_DESCRIPTOR
      delete process.env.BRIDGE_PANEL_ID
      delete process.env.BRIDGE_PANEL_INSTANCE_ID
    }
  })

  test('an unreachable endpoint cannot delay the OpenCode event callback', async () => {
    const descriptorPath = getHookEndpointPath()
    await mkdir(path.dirname(descriptorPath), { recursive: true })
    await writeFile(descriptorPath, JSON.stringify({
      [DESCRIPTOR_FIELD_URL]: `http://127.0.0.1:1${HOOK_ROUTE_PATH}`,
      [DESCRIPTOR_FIELD_TOKEN]: 'unreachable-token',
    }))
    process.env.BRIDGE_HOOK_DESCRIPTOR = descriptorPath
    process.env.BRIDGE_PANEL_ID = 'oc-panel'
    process.env.BRIDGE_PANEL_INSTANCE_ID = '42'

    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch
    try {
      await assertHookBlock('opencode')
      const hooks = await (await loadInstalledPlugin()).default({})
      const returned = await Promise.race([
        hooks.event({ event: { type: 'session.idle', properties: {} } }).then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
      ])
      expect(returned).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.BRIDGE_HOOK_DESCRIPTOR
      delete process.env.BRIDGE_PANEL_ID
      delete process.env.BRIDGE_PANEL_INSTANCE_ID
    }
  })
})
