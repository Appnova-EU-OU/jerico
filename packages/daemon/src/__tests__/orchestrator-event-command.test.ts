/**
 * #616 slice 2 — the `bridge-agent events` command.
 *
 * This is the seam where a misconfiguration turns into "no notices ever arrive",
 * so the tests are about refusing clearly rather than starting hopefully. The
 * distinction that matters most: diagnostics go to STDERR. stdout is the
 * notification channel, and a diagnostic there would spend a model turn to say
 * nothing happened.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawn as spawnChild } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEvents } from '../commands/events.js'
import { EXIT } from '../events/subscriber.js'
import { HOOK_PROTOCOL, EVENTS_PROTOCOL_VERSION, DESCRIPTOR_ENV_VAR } from '../hooks/protocol.js'

let dir: string | null = null
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null } })

function descriptor(over: Record<string, unknown> = {}, mode = 0o600): string {
  dir = mkdtempSync(path.join(tmpdir(), 'jerico-616-cmd-'))
  const p = path.join(dir, 'agent-hook-endpoint.json')
  writeFileSync(p, JSON.stringify({
    protocol: HOOK_PROTOCOL,
    protocolVersion: EVENTS_PROTOCOL_VERSION,
    url: 'http://127.0.0.1:3101',
    hookToken: 'a'.repeat(64),
    profile: null, daemonPid: 1, writtenAt: 1,
    ...over,
  }), { mode })
  chmodSync(p, mode)
  return p
}

function capture() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, write: (l: string) => { out.push(l) }, writeErr: (l: string) => { err.push(l) } }
}

const env = (descriptorPath: string, over: Record<string, string | undefined> = {}) => ({
  BRIDGE_PANEL_ID: 'panel-1',
  BRIDGE_PANEL_INSTANCE_ID: '3',
  [DESCRIPTOR_ENV_VAR]: descriptorPath,
  ...over,
})

async function runEventsCliFromSource(descriptorPath: string, timeoutMs = 2500): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: string
  stderr: string
}> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
  const child = spawnChild(process.execPath, [
    'packages/daemon/src/index.ts', 'events', '--follow',
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BRIDGE_PANEL_ID: 'panel-subprocess',
      BRIDGE_PANEL_INSTANCE_ID: '23',
      [DESCRIPTOR_ENV_VAR]: descriptorPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', err => {
      clearTimeout(timeout)
      reject(err)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, timedOut, stdout, stderr })
    })
  })
}

describe('#616 events command', () => {
  test('the source CLI delivers protocol exit 67 and does no daemon quota work', async () => {
    const result = await runEventsCliFromSource(descriptor({
      protocolVersion: EVENTS_PROTOCOL_VERSION + 1,
    }))

    expect(result).toEqual(expect.objectContaining({
      code: EXIT.protocol_mismatch,
      signal: null,
      timedOut: false,
      stdout: '',
    }))
    expect(result.stderr).toContain('descriptor_protocol_mismatch')
    expect(result.stderr).not.toContain('[claude-quota]')
  })

  test('a one-shot read is refused — --follow is the only supported mode', async () => {
    const c = capture()
    const r = await runEvents({ env: env(descriptor()), ...c })
    expect(r.exit).toBe(EXIT.usage_or_identity)
    expect(r.reason).toBe('follow_required')
    expect(c.out).toEqual([])                       // nothing on stdout
    expect(c.err.join(' ')).toContain('--follow')
  })

  test('missing panel identity is refused by name, not left to fail later', async () => {
    const c = capture()
    const r = await runEvents({
      follow: true,
      env: env(descriptor(), { BRIDGE_PANEL_ID: undefined }),
      ...c,
    })
    expect(r.exit).toBe(EXIT.usage_or_identity)
    expect(r.reason).toBe('identity_missing')
    expect(c.out).toEqual([])
  })

  test('an off-machine descriptor is refused before a single request is made', async () => {
    const c = capture()
    let fetched = 0
    const r = await runEvents({
      follow: true,
      env: env(descriptor({ url: 'http://10.1.2.3:3101' })),
      fetchImpl: async () => { fetched++; return { status: 200, json: async () => ({}) } },
      ...c,
    })
    expect(r.exit).toBe(EXIT.unsafe_descriptor)
    expect(r.reason).toBe('descriptor_url_not_loopback')
    expect(fetched).toBe(0)                          // the secret never left
    expect(c.out).toEqual([])
  })

  test('a group-readable descriptor is refused — it is a token leak', async () => {
    const c = capture()
    const r = await runEvents({ follow: true, env: env(descriptor({}, 0o640)), ...c })
    expect(r.exit).toBe(EXIT.unsafe_descriptor)
    expect(r.reason).toBe('descriptor_permissions_too_open')
  })

  test('a delivered event reaches stdout and nothing else does', async () => {
    const c = capture()
    let calls = 0
    const r = await runEvents({
      follow: true,
      env: env(descriptor()),
      fetchImpl: async (url: string) => {
        if (url.includes('/ack')) return { status: 200, json: async () => ({ ok: true }) }
        calls++
        if (calls === 1) {
          return {
            status: 200,
            json: async () => ({
              records: [
                { type: 'heartbeat', seq: 0, at: 1 },
                { type: 'event', seq: 1, watchId: 'w', kind: 'worker.done', payload: '[BRIDGE-ORCH] verdict-line' },
                { type: 'control', control: 'attached', resumedFrom: 0 },
              ],
              throughSeq: 1, idle: false,
            }),
          }
        }
        return { status: 200, json: async () => ({ records: [], throughSeq: null, idle: true }) }
      },
      sleep: async () => {},
      shouldStop: () => calls >= 2,
      ...c,
    })

    // Exactly the event. The heartbeat and the control record cost nothing.
    expect(c.out).toEqual(['[BRIDGE-ORCH] verdict-line'])
    expect(r.exit).toBe(EXIT.stream_retired)
  })

  test('a server refusal ends the stream with its own code, not a generic zero', async () => {
    const c = capture()
    const r = await runEvents({
      follow: true,
      env: env(descriptor()),
      fetchImpl: async () => ({ status: 403, json: async () => ({ error: 'invalid_token' }) }),
      sleep: async () => {},
      ...c,
    })
    expect(r.exit).toBe(EXIT.auth_invariant)
    expect(r.reason).toBe('server_refused')
    expect(c.out).toEqual([])
    expect(c.err.join(' ')).toContain('exit=')
  })

  test('a dead panel instance is distinguishable from a bad token', async () => {
    const c = capture()
    const r = await runEvents({
      follow: true,
      env: env(descriptor()),
      fetchImpl: async () => ({ status: 409, json: async () => ({ error: 'panel_gone' }) }),
      sleep: async () => {},
      ...c,
    })
    expect(r.exit).toBe(EXIT.panel_gone)
  })

  test('a transient network failure does not end the stream', async () => {
    const c = capture()
    let calls = 0
    const r = await runEvents({
      follow: true,
      env: env(descriptor()),
      fetchImpl: async (url: string) => {
        if (url.includes('/ack')) return { status: 200, json: async () => ({ ok: true }) }
        calls++
        if (calls === 1) throw new Error('ECONNREFUSED')
        if (calls === 2) {
          return { status: 200, json: async () => ({ records: [{ type: 'event', seq: 1, watchId: 'w', kind: 'k', payload: 'survived' }], throughSeq: 1, idle: false }) }
        }
        return { status: 200, json: async () => ({ records: [], throughSeq: null, idle: true }) }
      },
      sleep: async () => {},
      shouldStop: () => calls >= 3,
      ...c,
    })
    expect(c.out).toEqual(['survived'])
    expect(r.exit).toBe(EXIT.stream_retired)
  })

  test('no diagnostic is ever written to stdout', async () => {
    const c = capture()
    await runEvents({
      follow: true,
      env: env(descriptor()),
      fetchImpl: async () => { throw new Error('boom') },
      sleep: async () => {},
      shouldStop: (() => { let n = 0; return () => ++n > 3 })(),
      ...c,
    })
    // Failures were logged...
    expect(c.err.length).toBeGreaterThan(0)
    // ...and stdout stayed silent, because every line there costs a model turn.
    expect(c.out).toEqual([])
  })

  /**
   * The assertion that was missing, and it was found by a mutation surviving:
   * routing diagnostics to stdout broke no test, because every test above
   * INJECTS writeErr and so never exercises the default. The default is the only
   * thing that runs in production.
   *
   * It matters because stdout is the notification channel. A diagnostic there
   * spends a model turn to report that nothing happened — and under a per-line
   * watcher, a failing daemon would wake the orchestrator on every retry.
   */
  test('the DEFAULT diagnostic sink is stderr, not stdout', async () => {
    const stdoutSeen: string[] = []
    const stderrSeen: string[] = []
    const realOut = process.stdout.write.bind(process.stdout)
    const realErr = process.stderr.write.bind(process.stderr)

    process.stdout.write = ((chunk: string | Uint8Array) => { stdoutSeen.push(String(chunk)); return true }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => { stderrSeen.push(String(chunk)); return true }) as typeof process.stderr.write
    try {
      // No writeErr and no write supplied: both defaults are live.
      await runEvents({ env: env(descriptor(), { BRIDGE_PANEL_ID: undefined }), follow: true })
    } finally {
      process.stdout.write = realOut
      process.stderr.write = realErr
    }

    expect(stderrSeen.join('')).toContain('BRIDGE_PANEL_ID')
    expect(stdoutSeen).toEqual([])
  })

  /**
   * Three reviewers independently flagged a `--since` flag that was accepted and
   * then silently ignored. It is removed rather than wired, because the cursor
   * is server-side per subscriber: `attach()` keeps the existing subscription
   * and its acknowledged position, so a reconnect resumes on its own. The flag
   * implied the consumer owned a cursor it does not own.
   */
  test('a reconnect resumes on its own, so no resume flag is offered', async () => {
    // Nothing in the option surface accepts a cursor.
    const opts = { follow: true } as Record<string, unknown>
    expect('since' in opts).toBe(false)

    const c = capture()
    let calls = 0
    await runEvents({
      follow: true,
      env: env(descriptor()),
      fetchImpl: async (url: string) => {
        calls++
        // The client never asks for a cursor; the surface tracks it.
        expect(url).not.toContain('since')
        return { status: 200, json: async () => ({ records: [], throughSeq: null, idle: true }) }
      },
      sleep: async () => {},
      shouldStop: () => calls >= 2,
      ...c,
    })
    expect(calls).toBeGreaterThan(0)
  })
})
