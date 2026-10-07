import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const routePath = path.join(here, '../src/renderer/src/routes/ServiceConsent.svelte')

function loadRoute(recordConsent, serviceAction) {
  const source = fs.readFileSync(routePath, 'utf8')
  const instanceScript = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(instanceScript, 'ServiceConsent instance script exists')

  let onMountCallback
  const advancedSteps = []
  const context = {
    console,
    Promise,
    window: {
      bridge: {
        getConsentStatus: async () => ({ consented: false }),
        getServerEndpoints: async () => ({ ok: true, wsUrl: 'ws://127.0.0.1/ws/daemon' }),
        recordConsent,
        installDaemon: serviceAction,
        runNow: serviceAction,
      },
    },
    onMount: (callback) => { onMountCallback = callback },
    currentStep: { set: (step) => advancedSteps.push(step) },
    WizardStep: { Permissions: 'permissions' },
  }
  context.globalThis = context

  const executable = instanceScript
    .replace(/^\s*import[^\n]+\n/gm, '')
    .replace(/^\s*\$:\s*busy[^\n]+\n/gm, '')
    + `\n;globalThis.__serviceConsent = {
      handleInstallService,
      handleRunNow,
      state: () => ({ status, errorMessage }),
    }\n`
  const js = ts.transpileModule(executable, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  vm.runInNewContext(js, context, { filename: routePath })

  return {
    async mount() {
      assert.ok(onMountCallback, 'onMount callback registered')
      await onMountCallback()
    },
    handlers: context.__serviceConsent,
    advancedSteps,
  }
}

test('record failure does not install the daemon or advance', async () => {
  let installCalls = 0
  const route = loadRoute(
    async () => ({ ok: false }),
    async () => { installCalls += 1; return { ok: true } },
  )
  await route.mount()

  await route.handlers.handleInstallService()

  assert.equal(installCalls, 0)
  assert.deepEqual(route.advancedSteps, [])
  assert.equal(route.handlers.state().status, 'error')
  assert.match(route.handlers.state().errorMessage, /consent/i)
})

test('record failure does not run the daemon or advance', async () => {
  let runCalls = 0
  const route = loadRoute(
    async () => ({ ok: false }),
    async () => { runCalls += 1; return { ok: true } },
  )
  await route.mount()

  await route.handlers.handleRunNow()

  assert.equal(runCalls, 0)
  assert.deepEqual(route.advancedSteps, [])
  assert.equal(route.handlers.state().status, 'error')
  assert.match(route.handlers.state().errorMessage, /consent/i)
})
