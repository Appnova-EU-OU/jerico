import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assertHookBlock } from '../hooks/install.js'
import { stripBlock } from '../hooks/block.js'
import { handleAgentHookRequest } from '../hooks/receiver.js'
import { DESCRIPTOR_FIELD_TOKEN, DESCRIPTOR_FIELD_URL, DESCRIPTOR_ENV_VAR, HOOK_ROUTE_PATH } from '../hooks/protocol.js'

const runRealKimi = process.env.JERICO_REAL_KIMI_HOOK_TEST === '1'

if (!runRealKimi) {
  test('real Kimi integration remains an explicit opt-in gate in ordinary CI', () => {
    expect(process.env.JERICO_REAL_KIMI_HOOK_TEST).not.toBe('1')
  })
} else test('production Kimi block fires from the real CLI through the receiver', async () => {
  const realKimiHome = process.env.JERICO_REAL_KIMI_HOME || path.join(os.homedir(), '.kimi-code')
  const kimi = path.join(realKimiHome, 'bin', 'kimi')
  expect(existsSync(kimi)).toBe(true)

  const root = mkdtempSync(path.join(os.tmpdir(), 'jerico-real-kimi-hook-'))
  const previousHome = process.env.HOME
  const previousKimiHome = process.env.KIMI_CODE_HOME
  const globalKimiHome = path.join(root, '.kimi-code')
  const panelHome = path.join(root, 'panel-kimi-home')
  let server: ReturnType<typeof createServer> | undefined

  try {
    mkdirSync(globalKimiHome, { recursive: true, mode: 0o700 })
    for (const entry of readdirSync(realKimiHome)) {
      if (entry === 'config.toml' || entry === 'mcp.json') continue
      const source = path.join(realKimiHome, entry)
      const destination = path.join(globalKimiHome, entry)
      symlinkSync(source, destination, lstatSync(source).isDirectory() ? 'dir' : 'file')
    }
    const realConfig = require('node:fs').readFileSync(path.join(realKimiHome, 'config.toml'), 'utf8') as string
    process.env.HOME = path.dirname(realKimiHome)
    const cleanConfig = stripBlock('kimi', realConfig).content
    writeFileSync(path.join(globalKimiHome, 'config.toml'), cleanConfig)
    writeFileSync(path.join(globalKimiHome, 'mcp.json'), '{"mcpServers":{}}\n', { mode: 0o600 })

    mkdirSync(panelHome, { recursive: true, mode: 0o700 })
    for (const entry of readdirSync(globalKimiHome)) {
      if (entry === 'mcp.json') continue
      const source = path.join(globalKimiHome, entry)
      symlinkSync(source, path.join(panelHome, entry), lstatSync(source).isDirectory() ? 'dir' : 'file')
    }
    writeFileSync(path.join(panelHome, 'mcp.json'), '{"mcpServers":{}}\n', { mode: 0o600 })

    process.env.HOME = root
    delete process.env.KIMI_CODE_HOME
    expect(await assertHookBlock('kimi')).toBe('installed')
    expect(lstatSync(path.join(panelHome, 'config.toml')).isSymbolicLink()).toBe(true)

    const accepted: any[] = []
    const token = 'real-kimi-hook-probe-token'
    server = createServer((req, res) => {
      void handleAgentHookRequest(req, res, {
        manager: { getLiveHookTarget: () => ({ agentId: 'kimi-real-panel', instanceId: 17, agentKey: 'kimi' }) } as any,
        expectedToken: token,
        ws: { readyState: 1, send: (data: string, cb: (err?: Error) => void) => { accepted.push(JSON.parse(data)); cb() } } as any
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('probe server did not bind')
    const descriptor = path.join(root, 'descriptor.json')
    writeFileSync(descriptor, JSON.stringify({
      [DESCRIPTOR_FIELD_URL]: `http://127.0.0.1:${address.port}${HOOK_ROUTE_PATH}`,
      [DESCRIPTOR_FIELD_TOKEN]: token
    }), { mode: 0o600 })

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(kimi, ['-p', 'Reply with exactly OK.'], {
        cwd: '/tmp',
        env: {
          ...process.env,
          HOME: root,
          KIMI_CODE_HOME: panelHome,
          BRIDGE_PANEL_ID: 'kimi-real-panel',
          BRIDGE_PANEL_INSTANCE_ID: '17',
          [DESCRIPTOR_ENV_VAR]: descriptor
        }
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.once('error', reject)
      child.once('close', code => resolve({ code, stderr }))
    })

    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain('failed to run prompt')
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({
      type: 'agent_hook_event', agentId: 'kimi-real-panel', panelInstanceId: 17,
      agentKey: 'kimi', event: 'turn_ended'
    })
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME
    else process.env.KIMI_CODE_HOME = previousKimiHome
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
