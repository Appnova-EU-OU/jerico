import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import {
  renderAgyBlock,
  renderAgyCommand,
  renderClaudeBlock,
  spliceBlock,
  stripBlock,
  findBlock
} from '../hooks/block.js'
import { assertHookBlock, removeHookBlock } from '../hooks/install.js'
import { getHookConfig } from '../hooks/state.js'
import { normalizeProviderHookEvent } from '../hooks/receiver.js'
import { HOOK_SCRIPT_V1 } from '../hooks/script.js'
import {
  HEADER_EVENT_NAME,
  HOOK_ENV_EVENT_NAME,
  HOOK_ENV_STDOUT,
  DESCRIPTOR_ENV_VAR
} from '../hooks/protocol.js'

/** The Stop payload agy 1.1.21 actually posts, captured from a real
 *  turn (identifiers replaced with synthetic values). Note: no `hook_event_name`, and `terminationReason` is NO_TOOL_CALL,
 *  not the `model_stop` the bundled docs claim. */
const AGY_STOP_PAYLOAD = {
  artifactDirectoryPath: '/Users/owner/.gemini/antigravity-cli/brain/0a9e0a9e-...',
  conversationId: '0a9e0a9e-0000-4000-8000-00000000a9e1',
  error: '',
  executionNum: 0,
  fullyIdle: true,
  modelName: 'gemini-3.7-flash-low',
  terminationReason: 'NO_TOOL_CALL',
  transcriptPath: '...',
  workspacePaths: [] as string[]
}

const FOREIGN_HOOK = {
  someOtherTool: {
    PreToolUse: [{ type: 'command', command: '/opt/other/tool.sh', timeout: 5 }]
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

describe('agy hook target', () => {
  let tempDir: string
  let hooksPath: string
  let scriptPath: string
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jerico-agy-hook-'))
    hooksPath = path.join(tempDir, 'hooks.json')
    scriptPath = path.join(tempDir, 'jerico-hook.sh')
    for (const key of ['JERICO_AGY_HOOKS_PATH', 'JERICO_HOOK_SCRIPT_PATH_OVERRIDE']) {
      savedEnv[key] = process.env[key]
    }
    process.env.JERICO_AGY_HOOKS_PATH = hooksPath
    process.env.JERICO_HOOK_SCRIPT_PATH_OVERRIDE = scriptPath
    await fs.writeFile(scriptPath, HOOK_SCRIPT_V1, { mode: 0o755 })
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  /* --- 1. cold-read state. Caught by state.ts:44, which returned
     `unsupported_different_contract` for every one of these. --- */

  it('reports absent when the hooks file does not exist', () => {
    expect(getHookConfig('agy')).toBe('absent')
  })

  it('reports present_ok once our block is installed', async () => {
    await fs.writeFile(hooksPath, canonical(FOREIGN_HOOK), 'utf-8')
    expect(await assertHookBlock('agy')).toBe('installed')
    expect(getHookConfig('agy')).toBe('present_ok')
  })

  it('reports absent when the file exists without our block', async () => {
    await fs.writeFile(hooksPath, canonical(FOREIGN_HOOK), 'utf-8')
    expect(getHookConfig('agy')).toBe('absent')
  })

  it('reports malformed on unparseable JSON', async () => {
    await fs.writeFile(hooksPath, '{ this is not json', 'utf-8')
    expect(getHookConfig('agy')).toBe('malformed')
  })

  it('reports malformed when Stop is not an array', async () => {
    await fs.writeFile(hooksPath, canonical({ jerico: { Stop: 'nope' } }), 'utf-8')
    expect(getHookConfig('agy')).toBe('malformed')
  })

  /* --- 2. install/strip round trip. Caught by the missing registry entry:
     before the change `spliceBlock('agy', ...)` returned refused-malformed and
     no hooks.json was ever written. --- */

  it('installs the flat Stop shape and leaves foreign named hooks byte-for-byte', async () => {
    const original = canonical(FOREIGN_HOOK)
    await fs.writeFile(hooksPath, original, 'utf-8')

    expect(await assertHookBlock('agy')).toBe('installed')

    const installed = JSON.parse(await fs.readFile(hooksPath, 'utf-8'))
    expect(installed.someOtherTool).toEqual(FOREIGN_HOOK.someOtherTool)
    expect(installed.jerico).toEqual({
      Stop: [{ type: 'command', command: renderAgyCommand(), timeout: 10 }]
    })
    // Not the codex shape: no matcher, no nested `hooks` wrapper.
    expect(installed.jerico.Stop[0].matcher).toBeUndefined()
    expect(installed.jerico.Stop[0].hooks).toBeUndefined()

    expect(await assertHookBlock('agy')).toBe('already-present')

    expect(await removeHookBlock('agy')).toBe('installed')
    expect(await fs.readFile(hooksPath, 'utf-8')).toBe(original)
    expect(getHookConfig('agy')).toBe('absent')
  })

  it('preserves a foreign handler that sits inside our own hook name', () => {
    const foreignHandler = { type: 'command', command: '/opt/other/stop.sh', timeout: 3 }
    const start = canonical({ jerico: { Stop: [foreignHandler] } })
    const spliced = spliceBlock('agy', start)
    expect(spliced.status).toBe('installed')
    expect(findBlock('agy', spliced.content)).not.toBeNull()

    const stripped = stripBlock('agy', spliced.content)
    expect(stripped.status).toBe('installed')
    expect(JSON.parse(stripped.content).jerico.Stop).toEqual([foreignHandler])
  })

  it('collapses duplicate managed handlers to exactly one', () => {
    const stale = { type: 'command', command: renderAgyCommand(), timeout: 99 }
    const start = canonical({ jerico: { Stop: [stale, renderAgyBlock().Stop[0]] } })
    const spliced = spliceBlock('agy', start)
    expect(spliced.status).toBe('installed')
    expect(JSON.parse(spliced.content).jerico.Stop).toEqual([
      { type: 'command', command: renderAgyCommand(), timeout: 10 }
    ])
  })

  it('refuses to touch a malformed file', async () => {
    await fs.writeFile(hooksPath, '{ not json', 'utf-8')
    expect(await assertHookBlock('agy')).toBe('refused-malformed')
    expect(await fs.readFile(hooksPath, 'utf-8')).toBe('{ not json')
  })

  /* --- R50b: seeding a hooks.json that does not exist yet. Every one of these
     catches install.ts, where the missing-file branch was an unconditional
     `if (!fileInfo) return 'target-missing'` — the line that made the live
     smoke log `hook install refused: target-missing` and left the panel chip
     reading `hook !`. --- */

  it('creates the file and its parent directory when neither exists', async () => {
    const nestedDir = path.join(tempDir, 'gemini', 'config')
    const nestedPath = path.join(nestedDir, 'hooks.json')
    process.env.JERICO_AGY_HOOKS_PATH = nestedPath

    await expect(fs.access(nestedDir)).rejects.toThrow()

    expect(await assertHookBlock('agy')).toBe('installed')

    const stat = await fs.stat(nestedPath)
    expect(stat.mode & 0o777).toBe(0o600)
    const dirStat = await fs.stat(nestedDir)
    expect(dirStat.mode & 0o777).toBe(0o700)

    expect(await fs.readFile(nestedPath, 'utf-8')).toBe(
      canonical({ jerico: { Stop: [{ type: 'command', command: renderAgyCommand(), timeout: 10 }] } })
    )
  })

  it('reports present_ok after seeding and strips back to the seed, not to nothing', async () => {
    const nestedPath = path.join(tempDir, 'gemini', 'config', 'hooks.json')
    process.env.JERICO_AGY_HOOKS_PATH = nestedPath

    expect(await assertHookBlock('agy')).toBe('installed')
    expect(getHookConfig('agy')).toBe('present_ok')
    expect(await assertHookBlock('agy')).toBe('already-present')

    expect(await removeHookBlock('agy')).toBe('installed')
    expect(await fs.readFile(nestedPath, 'utf-8')).toBe('{}\n')
    expect(getHookConfig('agy')).toBe('absent')
    expect((await fs.stat(nestedPath)).mode & 0o777).toBe(0o600)
  })

  it('does not seed a target that declares no seed content', async () => {
    const claudePath = path.join(tempDir, 'claude', 'settings.json')
    const savedClaude = process.env.JERICO_CLAUDE_SETTINGS_PATH
    process.env.JERICO_CLAUDE_SETTINGS_PATH = claudePath
    try {
      expect(await assertHookBlock('claude')).toBe('target-missing')
      await expect(fs.access(claudePath)).rejects.toThrow()
      await expect(fs.access(path.dirname(claudePath))).rejects.toThrow()
    } finally {
      if (savedClaude === undefined) delete process.env.JERICO_CLAUDE_SETTINGS_PATH
      else process.env.JERICO_CLAUDE_SETTINGS_PATH = savedClaude
    }
  })

  it('refuses a symlinked target rather than creating through it', async () => {
    const linkPath = path.join(tempDir, 'linked-hooks.json')
    const linkDestination = path.join(tempDir, 'elsewhere.json')
    await fs.symlink(linkDestination, linkPath)
    process.env.JERICO_AGY_HOOKS_PATH = linkPath

    expect(await assertHookBlock('agy')).toBe('refused-unsafe-target')
    await expect(fs.access(linkDestination)).rejects.toThrow()
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true)
  })

  it('splices into the file a racing process created instead of overwriting it', async () => {
    const nestedPath = path.join(tempDir, 'gemini', 'config', 'hooks.json')
    process.env.JERICO_AGY_HOOKS_PATH = nestedPath
    await fs.mkdir(path.dirname(nestedPath), { recursive: true })
    await fs.writeFile(nestedPath, canonical(FOREIGN_HOOK), { mode: 0o600 })

    expect(await assertHookBlock('agy')).toBe('installed')
    const installed = JSON.parse(await fs.readFile(nestedPath, 'utf-8'))
    expect(installed.someOtherTool).toEqual(FOREIGN_HOOK.someOtherTool)
    expect(installed.jerico.Stop).toHaveLength(1)
  })

  /* --- 3-4. event normalisation. Caught by receiver.ts:88, which required
     body.hook_event_name === 'Stop' and dropped the real payload. --- */

  it('accepts the captured agy payload via the header fallback', () => {
    const norm = normalizeProviderHookEvent(AGY_STOP_PAYLOAD, 'agy', 'Stop')
    expect(norm).toEqual({
      event: 'turn_ended',
      providerSessionId: '0a9e0a9e-0000-4000-8000-00000000a9e1'
    })
  })

  it('still drops the payload when no header and no body event name is present', () => {
    expect(normalizeProviderHookEvent(AGY_STOP_PAYLOAD, 'agy')).toBeNull()
  })

  it('rejects an unknown header event name', () => {
    expect(normalizeProviderHookEvent(AGY_STOP_PAYLOAD, 'agy', 'PreToolUse')).toBeNull()
  })

  it('rejects an agent key outside HOOK_TARGETS even with a valid header', () => {
    expect(normalizeProviderHookEvent(AGY_STOP_PAYLOAD, 'gemini', 'Stop')).toBeNull()
  })

  it('lets the body event name win over the header', () => {
    const norm = normalizeProviderHookEvent(
      { ...AGY_STOP_PAYLOAD, hook_event_name: 'Error' },
      'agy',
      'Stop'
    )
    expect(norm?.event).toBe('turn_failed')
  })

  it('maps a non-empty error to turn_failed', () => {
    const norm = normalizeProviderHookEvent({ ...AGY_STOP_PAYLOAD, error: 'boom' }, 'agy', 'Stop')
    expect(norm?.event).toBe('turn_failed')
  })

  it('maps an error-flavoured terminationReason to turn_failed, case-insensitively', () => {
    for (const reason of ['ERROR', 'error', 'TOOL_ERROR']) {
      const norm = normalizeProviderHookEvent(
        { ...AGY_STOP_PAYLOAD, terminationReason: reason },
        'agy',
        'Stop'
      )
      expect(norm?.event).toBe('turn_failed')
    }
  })

  it('does not depend on an exact success string', () => {
    for (const reason of ['NO_TOOL_CALL', 'model_stop', 'anything_else']) {
      const norm = normalizeProviderHookEvent(
        { ...AGY_STOP_PAYLOAD, terminationReason: reason },
        'agy',
        'Stop'
      )
      expect(norm?.event).toBe('turn_ended')
    }
  })

  it('rejects an over-long conversationId rather than forwarding it', () => {
    const norm = normalizeProviderHookEvent(
      { ...AGY_STOP_PAYLOAD, conversationId: 'x'.repeat(129) },
      'agy',
      'Stop'
    )
    expect(norm).toEqual({ event: 'turn_ended' })
  })

  /* --- 5. the shared script stays a no-op for every other target. Caught by
     script.ts, which had no stdout write and no event-name header at all. --- */

  async function runScript(env: Record<string, string>): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', [scriptPath], {
        env: { PATH: process.env.PATH ?? '', HOME: tempDir, ...env },
        stdio: ['pipe', 'pipe', 'ignore']
      })
      let stdout = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.on('error', reject)
      child.stdin.end('{}')
      child.on('close', code => resolve({ stdout, code: code ?? -1 }))
    })
  }

  it('writes nothing to stdout when the opt-in vars are unset', async () => {
    const claudeCommand = renderClaudeBlock().hooks[0]!.command
    expect(claudeCommand).not.toContain(HOOK_ENV_STDOUT)
    expect(claudeCommand).not.toContain(HOOK_ENV_EVENT_NAME)

    const result = await runScript({})
    expect(result.stdout).toBe('')
    expect(result.code).toBe(0)
  })

  it('writes the declared decision on an early bail-out path', async () => {
    const result = await runScript({ [HOOK_ENV_STDOUT]: '{"decision":""}' })
    expect(result.stdout).toBe('{"decision":""}\n')
    expect(result.code).toBe(0)
  })

  it('carries the event name as a header and still writes the decision on the post path', async () => {
    const received: { headers: IncomingMessage['headers'] | null } = { headers: null }
    const server: Server = createServer((req, res) => {
      received.headers = req.headers
      req.resume()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    const descriptorPath = path.join(tempDir, 'descriptor.json')
    await fs.writeFile(
      descriptorPath,
      JSON.stringify({ url: `http://127.0.0.1:${address.port}/v1/agent-hooks/events`, hookToken: 'tok' }),
      'utf-8'
    )

    try {
      const result = await runScript({
        BRIDGE_PANEL_ID: 'panel-1',
        BRIDGE_PANEL_INSTANCE_ID: '1',
        [DESCRIPTOR_ENV_VAR]: descriptorPath,
        [HOOK_ENV_EVENT_NAME]: 'Stop',
        [HOOK_ENV_STDOUT]: '{"decision":""}'
      })
      expect(result.stdout).toBe('{"decision":""}\n')
      expect(received.headers?.[HEADER_EVENT_NAME]).toBe('Stop')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    }
  })

  it('sends no event-name header when the var is unset', async () => {
    const received: { headers: IncomingMessage['headers'] | null } = { headers: null }
    const server: Server = createServer((req, res) => {
      received.headers = req.headers
      req.resume()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    const descriptorPath = path.join(tempDir, 'descriptor.json')
    await fs.writeFile(
      descriptorPath,
      JSON.stringify({ url: `http://127.0.0.1:${address.port}/v1/agent-hooks/events`, hookToken: 'tok' }),
      'utf-8'
    )

    try {
      const result = await runScript({
        BRIDGE_PANEL_ID: 'panel-1',
        BRIDGE_PANEL_INSTANCE_ID: '1',
        [DESCRIPTOR_ENV_VAR]: descriptorPath
      })
      expect(result.stdout).toBe('')
      expect(received.headers?.[HEADER_EVENT_NAME]).toBeUndefined()
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    }
  })
})
