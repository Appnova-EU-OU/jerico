import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { __test_setAskRunningAgyOverride, fetchAgyUsage } from '../usage/providers/agy.js'
import { fetchKimiUsage } from '../usage/providers/kimi.js'

const oldHome = process.env.HOME
const oldFetch = globalThis.fetch
const dirs: string[] = []

function homeWith(relative: string, json: unknown): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-provider-fault-'))
  dirs.push(dir)
  const file = path.join(dir, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(json))
  process.env.HOME = dir
}

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
  globalThis.fetch = oldFetch
  __test_setAskRunningAgyOverride(null)
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test('agy provider reports a locally lapsed token without sending it', async () => {
  homeWith('.gemini/antigravity-cli/antigravity-oauth-token', { token: { access_token: 'test', expiry: '2000-01-01T00:00:00Z' } })
  __test_setAskRunningAgyOverride(async () => null)
  let sent = false
  globalThis.fetch = async () => { sent = true; return new Response('', { status: 401 }) }
  const result = await fetchAgyUsage({ allowInteractive: false })
  expect(result).toMatchObject({ ok: false, code: 'token_lapsed' })
  expect(sent).toBe(false)
})

test('agy provider preserves a real 401 as unauthorized', async () => {
  homeWith('.gemini/antigravity-cli/antigravity-oauth-token', { token: { access_token: 'test', expiry: '2099-01-01T00:00:00Z' } })
  __test_setAskRunningAgyOverride(async () => null)
  globalThis.fetch = async () => new Response('', { status: 401 })
  expect(await fetchAgyUsage({ allowInteractive: false })).toMatchObject({ ok: false, code: 'unauthorized' })
})

test('Kimi provider reports a locally lapsed token without sending it', async () => {
  homeWith('.kimi-code/credentials/kimi-code.json', { access_token: 'test', expires_at: 1 })
  let sent = false
  globalThis.fetch = async () => { sent = true; return new Response('', { status: 401 }) }
  expect(await fetchKimiUsage({ allowInteractive: false })).toMatchObject({ ok: false, code: 'token_lapsed' })
  expect(sent).toBe(false)
})

test('Kimi provider preserves a real 401 as unauthorized', async () => {
  homeWith('.kimi-code/credentials/kimi-code.json', { access_token: 'test', expires_at: 4_000_000_000 })
  globalThis.fetch = async () => new Response('', { status: 401 })
  expect(await fetchKimiUsage({ allowInteractive: false })).toMatchObject({ ok: false, code: 'unauthorized' })
})
