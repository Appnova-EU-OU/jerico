import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-popover-endpoints-'))
process.env['HOME'] = isolatedHome

const profileUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../src/main/utils/profile.ts'),
).href
const { getWebEndpointConfig } = await import(`${profileUrl}?test=${String(Date.now())}`)

function seed(profile: string, settings: Record<string, unknown>): void {
  const file = path.join(isolatedHome, '.jerico', 'profiles', profile, 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(settings), { mode: 0o600 })
}

after(() => {
  delete process.env['BRIDGE_PROFILE']
  fs.rmSync(isolatedHome, { recursive: true, force: true })
})

test('popover browser destinations and identity use the resolved profile endpoints', () => {
  seed('customer-a', {
    server: 'wss://relay.customer.test/ws/daemon',
    authServer: 'https://auth.customer.test',
    connectPage: 'https://console.customer.test/connect/new',
  })
  process.env['BRIDGE_PROFILE'] = 'customer-a'

  assert.deepEqual(getWebEndpointConfig(), {
    homeUrl: 'https://console.customer.test/',
    connectPageUrl: 'https://console.customer.test/connect/new',
    privacyUrl: 'https://console.customer.test/privacy',
    serverHost: 'relay.customer.test',
  })
})

test('a named profile with no valid endpoint contract has no browser fallback', () => {
  process.env['BRIDGE_PROFILE'] = 'missing-profile'
  assert.throws(
    () => getWebEndpointConfig(),
    /has no readable endpoint configuration/,
  )
})
