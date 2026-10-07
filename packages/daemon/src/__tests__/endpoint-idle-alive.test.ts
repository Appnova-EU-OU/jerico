/**
 * The promise that a refused endpoint does not become a respawn loop (#571,
 * review B4 item 4 — idle-alive mode had no test at all).
 *
 * The plist that runs this daemon is `KeepAlive { SuccessfulExit false }` with
 * `ThrottleInterval 30`. If a rejected settings.json made the daemon exit
 * non-zero, launchd would restart it every thirty seconds forever, on a machine
 * that worked yesterday, with nothing on screen — the daemon has no UI. So the
 * contract is: refuse to connect, STAY ALIVE, and say why.
 *
 * This runs the real bundled daemon in the foreground (`BRIDGE_DAEMON=1`, which
 * bypasses launchd entirely) against a throwaway profile, and asserts the three
 * things that make the promise: still running, exit status never 1, and
 * /health naming the cause. No token exists for this profile, so nothing can
 * authenticate anywhere even if the refusal failed; the endpoint used is
 * 192.0.2.10 (RFC 5737), which routes nowhere.
 *
 * Named in .github/workflows/ci.yml, which builds dist before running it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const PROFILE = 'jerico-idle-571'
const ENTRY = path.join(path.dirname(path.dirname(import.meta.dir)), 'dist', 'index.js')

let testHome: string
let profileDir: string
let flag: string
let lock: string
let child: ChildProcess | null = null
let output = ''
let healthPort = 0
let exited: { code: number | null; signal: string | null } | null = null

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

beforeAll(async () => {
  if (!fs.existsSync(ENTRY)) {
    throw new Error(`daemon bundle missing at ${ENTRY} — run \`bun run build\` in packages/daemon first`)
  }
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-idle-home-'))
  profileDir = path.join(testHome, '.jerico', 'profiles', PROFILE)
  flag = path.join(testHome, '.bridge', `endpoint-rejected-${PROFILE}`)
  lock = path.join(testHome, '.bridge', `${PROFILE}.daemon.lock`)
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(
    path.join(profileDir, 'settings.json'),
    JSON.stringify({ server: 'ws://192.0.2.10:8080/ws/daemon', name: 'idle-alive-test' }, null, 2),
    { mode: 0o600 },
  )
  fs.rmSync(flag, { force: true })

  healthPort = await freePort()
  // HOME isolates filesystem state only. The child still reaches the macOS
  // login Keychain; the unique profile/account name below is what makes that
  // lookup miss without touching a real credential.
  child = spawn(process.execPath, [ENTRY, 'start'], {
    env: {
      ...process.env,
      HOME: testHome,
      BRIDGE_DAEMON: '1',
      BRIDGE_PROFILE: PROFILE,
      HEALTH_PORT: String(healthPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d: Buffer) => { output += d.toString() })
  child.stderr?.on('data', (d: Buffer) => { output += d.toString() })
  child.on('exit', (code, signal) => { exited = { code, signal } })

  // Long enough for the refusal, the flag write and the health listener to bind.
  await sleep(6_000)
}, 30_000)

afterAll(async () => {
  if (child && exited === null) {
    child.kill('SIGTERM')
    await sleep(1_000)
    if (exited === null) child.kill('SIGKILL')
  }
  fs.rmSync(testHome, { recursive: true, force: true })
})

describe('idle-alive mode', () => {
  test('the daemon is still running after refusing its endpoint', () => {
    expect({ exited, alive: child !== null && exited === null }).toEqual({ exited: null, alive: true })
  })

  test('it has not exited non-zero — launchd has nothing to respawn', () => {
    // Stated separately from "alive" because these fail for different reasons:
    // an exit(0) would also be wrong here, but an exit(1) is the one that loops.
    expect(exited === null || exited.code !== 1).toBe(true)
  })

  test('it never dialed the refused endpoint', () => {
    expect(output).not.toContain('"event":"ws.connecting"')
  })

  test('/health names the cause and the remedy that works', async () => {
    const res = await fetch(`http://127.0.0.1:${String(healthPort)}/health`)
    const body = await res.json() as Record<string, unknown>
    expect(body['status']).toBe('endpoint_rejected')
    expect(body['endpointRejected']).toBe(true)
    expect(body['endpointRejectedCode']).toBe('plaintext_remote')
    expect(String(body['endpointRejectedReason'])).toContain('loopback')
    // The remedy has to be the one that actually repairs it: plain `auth` exits
    // 1 on an invalid configured value and writes nothing (review B2).
    expect(String(body['endpointRepairCommand'])).toContain('--daemon-server')
    expect(String(body['endpointRepairCommand'])).toContain(`--profile ${PROFILE}`)
  })

  test('the flag on disk carries the same reason, for readers that arrive later', () => {
    const flagBody = JSON.parse(fs.readFileSync(flag, 'utf-8')) as Record<string, unknown>
    expect(flagBody['code']).toBe('plaintext_remote')
    expect(String(flagBody['remedy'])).toContain('--daemon-server')
  })

  test('no credential is written into anything it leaves behind', () => {
    expect(fs.readFileSync(flag, 'utf-8')).not.toContain('Bearer')
  })
})
