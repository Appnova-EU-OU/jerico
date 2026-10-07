import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

interface AuthResult {
  code: number
  stdout: string
  stderr: string
  settings: Record<string, unknown> | undefined
  configPath: string
}

let server: http.Server
let authServerUrl = ''
let daemonServerUrl = ''
const testHomes: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.statusCode = req.headers.authorization === 'Bearer rejected-token' ? 401 : 200
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('auth test server has no TCP address')
  authServerUrl = `http://127.0.0.1:${String(address.port)}`
  daemonServerUrl = `ws://127.0.0.1:${String(address.port)}/ws/daemon`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  for (const home of testHomes) fs.rmSync(home, { recursive: true, force: true })
})

async function runScenario(name: string, options: {
  tty: boolean
  input?: string
  token?: string
}): Promise<AuthResult> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `jerico-565-${name}-`))
  testHomes.push(home)
  const profile = `r565-${name}`
  const configPath = path.join(home, '.jerico', 'profiles', profile, 'settings.json')
  const child = spawn(process.execPath, [
    path.join(import.meta.dir, 'fixtures', 'auth-consent-scenario.ts'),
  ], {
    env: {
      ...process.env,
      HOME: home,
      BRIDGE_PROFILE: profile,
      HOSTNAME: 'Matrix Machine',
      AUTH_SCENARIO_TTY: options.tty ? '1' : '0',
      AUTH_SCENARIO_SERVER: authServerUrl,
      AUTH_SCENARIO_DAEMON_SERVER: daemonServerUrl,
      AUTH_SCENARIO_TOKEN: options.token ?? 'accepted-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  child.stdin.end(options.input ?? '')
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode) => resolve(exitCode ?? -1))
  })
  const settings = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    : undefined
  return { code, stdout, stderr, settings, configPath }
}

describe('auth consent persistence matrix', () => {
  test('non-TTY success discloses on stderr without recording consent', async () => {
    const result = await runScenario('non-tty', { tty: false })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('capability & data-access disclosure')
    expect(result.stdout).toContain('consent.skipped')
    expect(result.stdout).toContain('non_interactive')
    expect(result.settings?.['name']).toBe('Matrix Machine')
    expect(result.settings?.['server']).toBe(daemonServerUrl)
    expect(result.settings?.['consentVersion']).toBeUndefined()
  })

  test('TTY acceptance records the current consent version', async () => {
    const result = await runScenario('accept', { tty: true, input: 'yes\n' })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('consent.accepted')
    expect(result.settings?.['consentVersion']).toBe(1)
  })

  test('TTY decline exits 1 and writes no settings', async () => {
    const result = await runScenario('decline', { tty: true, input: 'no\n' })

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('auth.consent_declined')
    expect(result.settings).toBeUndefined()
    expect(fs.existsSync(result.configPath)).toBe(false)
  })

  test('a failure after TTY acceptance exits 1 without recording consent', async () => {
    const result = await runScenario('post-accept-failure', {
      tty: true,
      input: 'yes\n',
      token: 'rejected-token',
    })

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('consent.accepted')
    expect(result.stderr).toContain('Token validation failed')
    expect(result.settings).toBeUndefined()
    expect(fs.existsSync(result.configPath)).toBe(false)
  })
})
