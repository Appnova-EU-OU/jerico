#!/usr/bin/env bun

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

export type ProofOutcome =
  | 'never_installed'
  | 'installed_not_executing'
  | 'installed_executing'

export interface ManagedClaudeHookInspection {
  installed: boolean
  command?: string
  reason: 'missing_managed_command' | 'one_managed_command' | 'duplicate_managed_commands' | 'invalid_settings'
}

const MANAGED_TOKEN = /(?:^|\s)--managed-by=jerico\.tier1(?=\s|$)/
const PRODUCT_LABEL = 'com.jerico.bridge-agent.smoke'
const PROFILE = 'smoke'
const PROD_HEALTH = 'http://127.0.0.1:3101/health'

export function inspectClaudeSettings(raw: string): ManagedClaudeHookInspection {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { installed: false, reason: 'invalid_settings' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { installed: false, reason: 'invalid_settings' }
  }

  const hooks = (parsed as Record<string, unknown>)['hooks']
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { installed: false, reason: 'missing_managed_command' }
  }
  const stop = (hooks as Record<string, unknown>)['Stop']
  if (!Array.isArray(stop)) return { installed: false, reason: 'missing_managed_command' }

  const commands: string[] = []
  for (const group of stop) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue
    const entries = (group as Record<string, unknown>)['hooks']
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const command = (entry as Record<string, unknown>)['command']
      if (typeof command === 'string' && MANAGED_TOKEN.test(command)) commands.push(command)
    }
  }

  if (commands.length === 0) return { installed: false, reason: 'missing_managed_command' }
  if (commands.length > 1) return { installed: true, reason: 'duplicate_managed_commands' }
  return { installed: true, command: commands[0], reason: 'one_managed_command' }
}

export function receiverAcceptedForAgent(logDelta: string, agentId: string): boolean {
  const suffix = agentId.slice(-8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const plain = logDelta.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  return new RegExp(`\\[daemon\\] hook\\.turn_ended\\.accepted[\\s\\S]{0,400}agentId: ["']${suffix}["']`).test(plain)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function run(program: string, args: string[], allowFailure = false): string {
  const result = spawnSync(program, args, { encoding: 'utf8' })
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function hasArg(name: string): boolean {
  return process.argv.includes(name)
}

function processParent(pid: number): number {
  const raw = run('/bin/ps', ['-o', 'ppid=', '-p', String(pid)]).trim()
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`could not parse parent PID for ${pid}: ${raw}`)
  return parsed
}

function processTable(): Map<number, { ppid: number; command: string }> {
  const rows = run('/bin/ps', ['-axo', 'pid=,ppid=,command='])
  const table = new Map<number, { ppid: number; command: string }>()
  for (const line of rows.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] })
  }
  return table
}

function ancestry(pid: number, table: Map<number, { ppid: number; command: string }>): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  let current = pid
  while (current > 0 && !seen.has(current)) {
    seen.add(current)
    out.push(current)
    current = table.get(current)?.ppid ?? 0
  }
  return out
}

function processEnvironment(pid: number): Record<string, string> {
  const raw = run('/bin/ps', ['eww', '-p', String(pid), '-o', 'command='])
  const result: Record<string, string> = {}
  for (const key of ['PATH', 'BRIDGE_PANEL_ID', 'BRIDGE_PANEL_INSTANCE_ID', 'BRIDGE_HOOK_DESCRIPTOR']) {
    const match = raw.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`))
    if (match) result[key] = match[1]
  }
  return result
}

function findProviderProcess(daemonPid: number, agentId: string): {
  pid: number
  env: Record<string, string>
  ancestry: number[]
  command: string
} {
  const table = processTable()
  for (const pid of table.keys()) {
    const chain = ancestry(pid, table)
    if (!chain.includes(daemonPid) || pid === daemonPid) continue
    const env = processEnvironment(pid)
    if (env['BRIDGE_PANEL_ID'] === agentId) return { pid, env, ancestry: chain, command: table.get(pid)?.command ?? '' }
  }
  throw new Error(`no live provider descendant of daemon ${daemonPid} carries BRIDGE_PANEL_ID=${agentId}`)
}

function launchctlPrint(label: string): string {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('process.getuid is unavailable')
  return run('/bin/launchctl', ['print', `gui/${uid}/${label}`])
}

function launchdPid(output: string): number {
  const match = output.match(/^\s*pid = (\d+)\s*$/m)
  if (!match) throw new Error('launchctl print did not report a running pid')
  return Number(match[1])
}

function plistValue(plist: string, keyPath: string): string {
  return run('/usr/bin/plutil', ['-extract', keyPath, 'raw', '-o', '-', plist]).trim()
}

function processStdoutPath(pid: number): string {
  const raw = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', '1', '-Fn'])
  const name = raw.split('\n').find(line => line.startsWith('n'))?.slice(1)
  if (!name || !path.isAbsolute(name)) throw new Error(`could not resolve stdout path for daemon ${pid}`)
  return name
}

async function healthStatus(url: string): Promise<number> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return response.status
  } catch {
    return 0
  }
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await Bun.sleep(25)
  }
  return existsSync(file)
}

async function waitForAcceptance(logFile: string, offset: number, agentId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logFile)) {
      const bytes = readFileSync(logFile)
      const delta = bytes.subarray(Math.min(offset, bytes.length)).toString('utf8')
      if (receiverAcceptedForAgent(delta, agentId)) return true
    }
    await Bun.sleep(50)
  }
  return false
}

interface Receipt {
  version: 1
  startedAt: string
  finishedAt?: string
  profile: 'smoke'
  productLabel: string
  probeLabel?: string
  settingsPath: string
  settingsHash: string
  managedCommandHash?: string
  negativeControl: boolean
  mode: 'release' | 'diagnostic_equivalent'
  descriptorInheritedFromProvider?: boolean
  productDaemonPid?: number
  providerPid?: number
  providerAncestry?: number[]
  providerPathHash?: string
  plistPathHash?: string
  providerPathMatchesPlist?: boolean
  providerUsesSettingsFixture?: boolean
  jobParentPid?: number
  receiverAccepted?: boolean
  outcome?: ProofOutcome | 'harness_error'
  reason?: string
  prodHealthBefore?: number
  prodHealthAfter?: number
  cleanup?: 'not_needed' | 'probe_booted_out' | 'probe_bootout_failed'
}

async function main(): Promise<number> {
  if (process.platform !== 'darwin') throw new Error('launchd proof only runs on macOS')
  const profile = readArg('--profile')
  if (profile !== PROFILE) throw new Error('refusing non-smoke profile; pass exactly --profile smoke')

  const settingsPathArg = readArg('--settings')
  if (!settingsPathArg) throw new Error('--settings <fixture path> is required')
  const settingsPath = path.resolve(settingsPathArg)
  if (settingsPath === path.join(os.homedir(), '.claude', 'settings.json')) {
    throw new Error('refusing the real ~/.claude/settings.json; use an isolated fixture')
  }
  const expected = readArg('--expect') as ProofOutcome | undefined
  if (expected && !['never_installed', 'installed_not_executing', 'installed_executing'].includes(expected)) {
    throw new Error(`invalid --expect value: ${expected}`)
  }
  const negativeControl = hasArg('--negative-control')
  const diagnosticEquivalent = hasArg('--diagnostic-equivalent')
  const timeoutMs = Number(readArg('--timeout-ms') ?? '5000')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
    throw new Error('--timeout-ms must be an integer from 500 to 30000')
  }

  const rawSettings = readFileSync(settingsPath, 'utf8')
  const inspection = inspectClaudeSettings(rawSettings)
  const receiptPath = path.resolve(readArg('--receipt') ?? `/tmp/jerico-hook/launchd-proof-receipt-${Date.now()}.json`)
  const receipt: Receipt = {
    version: 1,
    startedAt: new Date().toISOString(),
    profile: PROFILE,
    productLabel: PRODUCT_LABEL,
    settingsPath,
    settingsHash: sha256(rawSettings),
    negativeControl,
    mode: diagnosticEquivalent ? 'diagnostic_equivalent' : 'release',
    cleanup: 'not_needed',
  }

  let probeLabel: string | undefined
  let finalOutcome: ProofOutcome | 'harness_error' = 'harness_error'
  let finalReason = 'uninitialized'

  try {
    receipt.prodHealthBefore = await healthStatus(PROD_HEALTH)
    if (receipt.prodHealthBefore !== 200) throw new Error(`production health preflight is ${receipt.prodHealthBefore}, expected 200`)

    if (!inspection.installed) {
      finalOutcome = 'never_installed'
      finalReason = inspection.reason
      return expected === undefined || expected === finalOutcome ? 0 : 1
    }
    if (!inspection.command || inspection.reason === 'duplicate_managed_commands') {
      finalOutcome = 'installed_not_executing'
      finalReason = inspection.reason
      return expected === finalOutcome ? 0 : 1
    }
    receipt.managedCommandHash = sha256(inspection.command)

    const agentId = readArg('--agent-id')
    if (!agentId) throw new Error('--agent-id is required when the fixture is installed')

    const productPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PRODUCT_LABEL}.plist`)
    if (!existsSync(productPlist)) throw new Error(`smoke product plist is missing: ${productPlist}`)
    const descriptorDefault = path.join(os.homedir(), '.bridge', 'agent-hook-endpoint-smoke.json')
    const descriptor = JSON.parse(readFileSync(descriptorDefault, 'utf8')) as Record<string, unknown>
    let daemonPid: number
    if (diagnosticEquivalent) {
      daemonPid = Number(descriptor['daemonPid'])
      if (!Number.isSafeInteger(daemonPid) || daemonPid < 2) throw new Error('smoke descriptor has no valid daemonPid')
    } else {
      const launchState = launchctlPrint(PRODUCT_LABEL)
      daemonPid = launchdPid(launchState)
    }
    receipt.productDaemonPid = daemonPid
    if (descriptor['profile'] !== PROFILE || descriptor['daemonPid'] !== daemonPid) {
      throw new Error('smoke descriptor is not owned by the running smoke LaunchAgent pid')
    }
    if (processParent(daemonPid) !== 1) throw new Error(`smoke daemon ${daemonPid} is not parented by launchd pid 1`)

    const wrapper = plistValue(productPlist, 'ProgramArguments.0')
    if (!existsSync(wrapper)) throw new Error(`product wrapper from plist is unreadable: ${wrapper}`)
    const plistPath = plistValue(productPlist, 'EnvironmentVariables.PATH')
    receipt.plistPathHash = sha256(plistPath)

    const provider = findProviderProcess(daemonPid, agentId)
    receipt.providerPid = provider.pid
    receipt.providerAncestry = provider.ancestry
    receipt.providerUsesSettingsFixture = provider.command.includes('--settings') && provider.command.includes(settingsPath)
    if (!receipt.providerUsesSettingsFixture && !diagnosticEquivalent) {
      finalOutcome = 'installed_not_executing'
      finalReason = 'provider_not_using_settings_fixture'
      return expected === finalOutcome ? 0 : 1
    }
    const panelId = provider.env['BRIDGE_PANEL_ID']
    const instanceId = provider.env['BRIDGE_PANEL_INSTANCE_ID']
    const descriptorPath = provider.env['BRIDGE_HOOK_DESCRIPTOR'] ?? (diagnosticEquivalent ? descriptorDefault : undefined)
    const providerPath = provider.env['PATH']
    if (!panelId || !instanceId || !descriptorPath) {
      finalOutcome = 'installed_not_executing'
      finalReason = 'provider_missing_required_hook_environment'
      return expected === finalOutcome ? 0 : 1
    }
    receipt.descriptorInheritedFromProvider = provider.env['BRIDGE_HOOK_DESCRIPTOR'] === descriptorPath
    if (!/^\d+$/.test(instanceId)) throw new Error(`provider has invalid BRIDGE_PANEL_INSTANCE_ID=${instanceId}`)
    if (!existsSync(descriptorPath)) {
      finalOutcome = 'installed_not_executing'
      finalReason = 'provider_descriptor_unreadable'
      return expected === finalOutcome ? 0 : 1
    }
    receipt.providerPathMatchesPlist = providerPath === plistPath
    if (providerPath !== plistPath && !diagnosticEquivalent) {
      finalOutcome = 'installed_not_executing'
      finalReason = 'provider_path_differs_from_smoke_plist'
      return expected === finalOutcome ? 0 : 1
    }
    receipt.providerPathHash = sha256(providerPath)

    const nonce = `${process.pid}-${randomBytes(4).toString('hex')}`
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'jerico-launchd-hook-proof-'))
    const commandFile = path.join(tempDir, 'command')
    const payloadFile = path.join(tempDir, 'payload.json')
    const runnerFile = path.join(tempDir, 'runner.sh')
    const doneFile = path.join(tempDir, 'done')
    const parentFile = path.join(tempDir, 'parent')
    const jobPlist = path.join(tempDir, 'probe.plist')
    const jobOut = path.join(tempDir, 'stdout.log')
    const jobErr = path.join(tempDir, 'stderr.log')
    probeLabel = `${PRODUCT_LABEL}-hook-proof.${nonce}`
    receipt.probeLabel = probeLabel

    let command = inspection.command
    if (negativeControl) {
      const loginOnlyDir = path.join(tempDir, 'login-only-bin')
      const bareName = `jerico-hook-rc-only-${nonce}`
      const barePath = path.join(loginOnlyDir, bareName)
      run('/bin/mkdir', ['-p', loginOnlyDir])
      writeFileSync(barePath, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
      const loginPath = `${loginOnlyDir}:${process.env['PATH'] ?? ''}`
      execFileSync('/usr/bin/env', ['which', bareName], { env: { ...process.env, PATH: loginPath }, stdio: 'ignore' })
      if (plistPath.split(':').includes(loginOnlyDir)) throw new Error('negative-control directory unexpectedly exists in launchd PATH')
      command = `${bareName} --managed-by=jerico.tier1 --v=1 >/dev/null 2>&1 || :`
    }

    writeFileSync(commandFile, command, { mode: 0o600 })
    writeFileSync(payloadFile, JSON.stringify({ hook_event_name: 'Stop', session_id: `launchd-proof-${nonce}` }), { mode: 0o600 })
    writeFileSync(runnerFile, `#!/bin/sh\nset -u\nprintf '%s %s\\n' "$$" "$PPID" > ${shellQuote(parentFile)}\ncommand=$(cat ${shellQuote(commandFile)})\n/bin/sh -c "$command" < ${shellQuote(payloadFile)} > /dev/null 2>&1\nprintf 'done\\n' > ${shellQuote(doneFile)}\n`, { mode: 0o700 })
    chmodSync(runnerFile, 0o700)

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(probeLabel)}</string>
  <key>ProgramArguments</key><array><string>${xml(runnerFile)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(jobOut)}</string>
  <key>StandardErrorPath</key><string>${xml(jobErr)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(plistPath)}</string>
    <key>BRIDGE_PANEL_ID</key><string>${xml(panelId)}</string>
    <key>BRIDGE_PANEL_INSTANCE_ID</key><string>${xml(instanceId)}</string>
    <key>BRIDGE_HOOK_DESCRIPTOR</key><string>${xml(descriptorPath)}</string>
  </dict>
</dict></plist>
`
    writeFileSync(jobPlist, plist, { mode: 0o600 })

    const daemonLog = diagnosticEquivalent
      ? processStdoutPath(daemonPid)
      : plistValue(productPlist, 'StandardOutPath')
    const logOffset = existsSync(daemonLog) ? statSync(daemonLog).size : 0
    const uid = process.getuid!()
    run('/bin/launchctl', ['bootstrap', `gui/${uid}`, jobPlist])
    receipt.cleanup = 'probe_bootout_failed'
    const completed = await waitForFile(doneFile, timeoutMs)
    if (!completed) {
      finalOutcome = 'installed_not_executing'
      finalReason = 'launchd_probe_timeout'
      return expected === finalOutcome ? 0 : 1
    }

    const [runnerPidRaw, runnerParentRaw] = readFileSync(parentFile, 'utf8').trim().split(/\s+/)
    const runnerPid = Number(runnerPidRaw)
    const runnerParent = Number(runnerParentRaw)
    if (!Number.isSafeInteger(runnerPid) || runnerParent !== 1) {
      throw new Error(`probe was not directly parented by launchd: pid=${runnerPidRaw} ppid=${runnerParentRaw}`)
    }
    receipt.jobParentPid = runnerParent

    const accepted = await waitForAcceptance(daemonLog, logOffset, agentId, timeoutMs)
    receipt.receiverAccepted = accepted
    finalOutcome = accepted ? 'installed_executing' : 'installed_not_executing'
    finalReason = accepted ? 'receiver_recorded_accepted' : (negativeControl ? 'negative_control_not_resolvable' : 'receiver_did_not_record_acceptance')
    return expected === undefined
      ? (finalOutcome === 'installed_executing' ? 0 : 1)
      : (expected === finalOutcome ? 0 : 1)
  } catch (error) {
    finalOutcome = 'harness_error'
    finalReason = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    if (probeLabel) {
      const uid = process.getuid!()
      const result = spawnSync('/bin/launchctl', ['bootout', `gui/${uid}/${probeLabel}`], { encoding: 'utf8' })
      receipt.cleanup = result.status === 0 ? 'probe_booted_out' : 'probe_bootout_failed'
    }
    receipt.prodHealthAfter = await healthStatus(PROD_HEALTH)
    if (receipt.prodHealthAfter !== 200) {
      finalOutcome = 'harness_error'
      finalReason = `production health postflight is ${receipt.prodHealthAfter}, expected 200`
    }
    receipt.outcome = finalOutcome
    receipt.reason = finalReason
    receipt.finishedAt = new Date().toISOString()
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify({ outcome: finalOutcome, reason: finalReason, receipt: receiptPath }))
  }
}

if (import.meta.main) {
  main().then(
    code => process.exit(code),
    async error => {
      const prodAfter = await healthStatus(PROD_HEALTH)
      console.error(JSON.stringify({ outcome: 'harness_error', reason: error instanceof Error ? error.message : String(error), prodHealthAfter: prodAfter }))
      process.exit(2)
    },
  )
}
