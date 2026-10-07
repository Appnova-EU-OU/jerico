import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RAIL, railState } from '../src/renderer/src/lib/rail.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

test('the rail is the six setup steps, in order', () => {
  assert.deepEqual(
    RAIL.map((r) => r.key),
    ['welcome', 'migrate', 'auth', 'service-consent', 'permissions', 'done'],
  )
  assert.deepEqual(RAIL.map((r) => r.n), ['01', '02', '03', '04', '05', '06'])
})

test('Jerico disclosure precedes the macOS protected-access action', () => {
  const auth = fs.readFileSync(path.join(here, '../src/renderer/src/routes/Auth.svelte'), 'utf8')
  const migrate = fs.readFileSync(path.join(here, '../src/renderer/src/routes/Migrate.svelte'), 'utf8')
  const consent = fs.readFileSync(path.join(here, '../src/renderer/src/routes/ServiceConsent.svelte'), 'utf8')
  const permissions = fs.readFileSync(path.join(here, '../src/renderer/src/routes/Permissions.svelte'), 'utf8')

  assert.match(auth, /currentStep\.set\(WizardStep\.ServiceConsent\)/)
  assert.match(migrate, /currentStep\.set\(WizardStep\.ServiceConsent\)/)
  assert.match(consent, /currentStep\.set\(WizardStep\.Permissions\)/)
  assert.match(permissions, /currentStep\.set\(WizardStep\.Done\)/)
})

test('consent names other-app data reached by Full Disk Access', () => {
  const consent = fs.readFileSync(path.join(here, '../src/renderer/src/routes/ServiceConsent.svelte'), 'utf8')
  assert.match(consent, /other applications' data/i)
  assert.match(consent, /messages/i)
  assert.match(consent, /mail/i)
  assert.match(consent, /browser history/i)
})

test('Documents readability is not rendered as a Full Disk Access verdict', () => {
  const main = fs.readFileSync(path.join(here, '../src/main/index.ts'), 'utf8')
  const ipc = fs.readFileSync(path.join(here, '../src/main/ipc-handlers.ts'), 'utf8')
  const health = fs.readFileSync(path.join(here, '../src/main/utils/health.ts'), 'utf8')
  const manage = fs.readFileSync(path.join(here, '../src/renderer/src/routes/Manage.svelte'), 'utf8')
  const daemonIndex = fs.readFileSync(path.join(here, '../../../packages/daemon/src/index.ts'), 'utf8')
  const daemonWs = fs.readFileSync(path.join(here, '../../../packages/daemon/src/ws/client.ts'), 'utf8')

  assert.doesNotMatch(main, /Daemon lacks Full Disk Access/)
  assert.doesNotMatch(main, /Full Disk Access granted/)
  assert.doesNotMatch(ipc, /fullDiskAccess: health\?\.protectedFoldersReadable/)
  assert.match(ipc, /pollOnce\(healthPort, \{ freshProbe: true \}\)/)
  assert.match(health, /options\.freshProbe \? '\?probe=fresh' : ''/)
  assert.match(manage, /Documents folder access/)
  assert.doesNotMatch(daemonIndex, /exit 0 = FDA granted/)
  assert.doesNotMatch(daemonIndex, /check-fda: granted/)
  assert.doesNotMatch(daemonWs, /daemon has FDA access/)
})

test('desktop consent status has no hard-coded >= 1 reader', () => {
  const ipc = fs.readFileSync(path.join(here, '../src/main/ipc-handlers.ts'), 'utf8')
  const reader = ipc.split('\n').find((line) => /raw\['consentVersion'\].*>=\s*1/.test(line)) ?? ''
  assert.doesNotMatch(reader, />=\s*1/)
  assert.match(ipc, /consentSatisfied\(raw\['consentVersion'\], CURRENT_CONSENT_VERSION\)/)
})

test('desktop consent recording has no literal consentVersion: 1 writer', () => {
  const ipc = fs.readFileSync(path.join(here, '../src/main/ipc-handlers.ts'), 'utf8')
  const writer = ipc.split('\n').find((line) => /consentVersion:\s*1\b/.test(line)) ?? ''
  assert.doesNotMatch(writer, /consentVersion:\s*1\b/)
  assert.match(ipc, /consentVersion: CURRENT_CONSENT_VERSION/)
})

test('everything before the current step is done, everything after is next', () => {
  const at = (step: string) => RAIL.map((_, i) => railState(i, RAIL.findIndex((r) => r.key === step)))
  assert.deepEqual(at('welcome'), ['current', 'next', 'next', 'next', 'next', 'next'])
  assert.deepEqual(at('auth'), ['done', 'done', 'current', 'next', 'next', 'next'])
  assert.deepEqual(at('done'), ['done', 'done', 'done', 'done', 'done', 'current'])
})

// The off-by-one that would silently mark the step you are ON as finished.
test('the current step is never marked done', () => {
  for (let cur = 0; cur < RAIL.length; cur++) {
    assert.equal(railState(cur, cur), 'current')
  }
})

test('with no step at all there is no rail — index -1 leaves nothing current', () => {
  assert.deepEqual(RAIL.map((_, i) => railState(i, -1)), Array(6).fill('next'))
})
