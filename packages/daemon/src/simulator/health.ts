import { spawn } from 'child_process'
import { access } from 'fs/promises'
import path from 'path'
import os from 'os'
import type { SimHealthCheck } from '../shared/types.js'

export interface DetectChecks {
  xcrunOk: boolean
  simctlOk: boolean
}

export async function runDetectChecks(): Promise<DetectChecks> {
  const xcrunOk = await new Promise<boolean>((resolve) => {
    const proc = spawn('xcrun', ['simctl', 'help'], { timeout: 2000 })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
    proc.stdout?.resume()
    proc.stderr?.resume()
  })

  if (!xcrunOk) return { xcrunOk: false, simctlOk: false }

  const simctlOk = await new Promise<boolean>((resolve) => {
    const proc = spawn('xcrun', ['simctl', 'list', '--json'], { timeout: 3000 })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
    proc.stdout?.resume()
    proc.stderr?.resume()
  })

  return { xcrunOk, simctlOk }
}

async function resolveBootedUdid(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], { timeout: 5000 })
    let stdout = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    proc.on('close', (code) => {
      if (code !== 0) { resolve(null); return }
      try {
        const data = JSON.parse(stdout) as { devices: Record<string, Array<{ udid: string; state: string }>> }
        for (const devices of Object.values(data.devices)) {
          const booted = devices.find(d => d.state === 'Booted')
          if (booted) { resolve(booted.udid); return }
        }
        resolve(null)
      } catch {
        resolve(null)
      }
    })
    proc.on('error', () => resolve(null))
  })
}

async function resolveAvailableSims(): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { timeout: 5000 })
    let stdout = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    proc.on('close', (code) => {
      if (code !== 0) { resolve([]); return }
      try {
        const data = JSON.parse(stdout) as { devices: Record<string, Array<{ name: string; deviceTypeIdentifier?: string; state: string }>> }
        const names: string[] = []
        for (const [runtime, devices] of Object.entries(data.devices)) {
          for (const d of devices) {
            const runtimeName = runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/-/g, '.')
            names.push(`${d.name} (${runtimeName})`)
            if (names.length >= 3) break
          }
          if (names.length >= 3) break
        }
        resolve(names)
      } catch {
        resolve([])
      }
    })
    proc.on('error', () => resolve([]))
  })
}

export async function runFullHealthChecks(agentId: string): Promise<{ checks: SimHealthCheck[]; udid: string | null }> {
  const checks: SimHealthCheck[] = []
  let udid: string | null = null

  // 1. xcrun_exists
  const xcrunOk = await new Promise<boolean>((resolve) => {
    const proc = spawn('xcrun', ['simctl', 'help'], { timeout: 2000 })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
    proc.stdout?.resume()
    proc.stderr?.resume()
  })

  checks.push({
    id: 'xcrun_exists',
    status: xcrunOk ? 'pass' : 'fail',
    label: 'Xcode CLI tools',
    detail: xcrunOk ? undefined : 'Xcode command-line tools not found. Install them to use the iOS Simulator panel.',
    fixCmd: xcrunOk ? undefined : 'xcode-select --install',
  })

  // 2. idb_present
  let idbOk = false
  if (xcrunOk) {
    const idbPath = path.join(os.homedir(), '.local/bin/idb')
    idbOk = await access(idbPath).then(() => true).catch(() => false)
  }
  checks.push({
    id: 'idb_present',
    status: idbOk ? 'pass' : 'fail',
    label: 'idb',
    detail: idbOk ? undefined : 'idb not found at ~/.local/bin/idb. Required for simulator automation.',
    fixCmd: idbOk ? undefined : 'pip3 install fb-idb && brew install facebook/fb/idb-companion',
  })

  // 3. simctl_ok
  if (xcrunOk) {
    const simctlOk = await new Promise<boolean>((resolve) => {
      const proc = spawn('xcrun', ['simctl', 'list', '--json'], { timeout: 5000 })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
      proc.stdout?.resume()
      proc.stderr?.resume()
    })

    checks.push({
      id: 'simctl_ok',
      status: simctlOk ? 'pass' : 'fail',
      label: 'simctl',
      detail: simctlOk ? undefined : 'simctl is not responding. Xcode may not be fully installed.',
      fixCmd: simctlOk ? undefined : 'sudo xcode-select --reset',
    })

    // 3. booted_simulator
    if (simctlOk) {
      udid = await resolveBootedUdid()
      if (udid) {
        checks.push({
          id: 'booted_simulator',
          status: 'pass',
          label: 'Booted simulator',
        })
      } else {
        const available = await resolveAvailableSims()
        checks.push({
          id: 'booted_simulator',
          status: 'fail',
          label: 'Booted simulator',
          detail: available.length > 0
            ? `No simulator is booted. Available: ${available.join(', ')}. Open Simulator.app and boot one.`
            : 'No simulator is booted and no devices found. Open Xcode → Window → Devices and Simulators to add one.',
          fixCmd: 'open -a Simulator',
        })
      }
    } else {
      checks.push({
        id: 'booted_simulator',
        status: 'fail',
        label: 'Booted simulator',
        detail: 'Skipped — previous check failed',
      })
    }
  } else {
    checks.push({
      id: 'simctl_ok',
      status: 'fail',
      label: 'simctl',
      detail: 'Skipped — previous check failed',
    })
    checks.push({
      id: 'booted_simulator',
      status: 'fail',
      label: 'Booted simulator',
      detail: 'Skipped — previous check failed',
    })
  }

  return { checks, udid }
}
