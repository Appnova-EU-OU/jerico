import os from 'os'
import fs from 'fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface SystemMetrics {
  cpu:         number
  ramUsedMb:   number
  ramTotalMb:  number
  ramCachedMb: number
  battery?:    { percent: number; charging: boolean }
}

// ── CPU delta tracking ───────────────────────────────────────────────────────

interface CpuSnapshot { idle: number; total: number }

function cpuSnapshot(): CpuSnapshot {
  let idle = 0, total = 0
  for (const cpu of os.cpus()) {
    idle  += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + (cpu.times.irq ?? 0)
  }
  return { idle, total }
}

let lastSnapshot: CpuSnapshot = cpuSnapshot()

function cpuPercent(): number {
  const now   = cpuSnapshot()
  const dIdle  = now.idle  - lastSnapshot.idle
  const dTotal = now.total - lastSnapshot.total
  lastSnapshot = now
  if (dTotal === 0) return 0
  return Math.round((1 - dIdle / dTotal) * 100)
}

// ── RAM ─────────────────────────────────────────────────────────────────────

async function ramStatsMacos(): Promise<{ usedMb: number; totalMb: number; cachedMb: number }> {
  const total = os.totalmem()
  const free  = os.freemem()

  // Parse vm_stat to get cached pages
  // "Cached" = (Pages speculative + Pages inactive) * page_size
  // These are file-backed pages that can be reclaimed by the system
  let cachedPages = 0
  try {
    const { stdout } = await execFileAsync('vm_stat', ['-c', '10'], { encoding: 'utf-8', timeout: 2000 })
    if (stdout) {
      // vm_stat reports page size at top: "page size of 16384 bytes"
      const pgSizeMatch = stdout.match(/page size of (\d+) bytes/)
      const speccMatch = stdout.match(/Pages speculative:\s*(\d+)/)
      const inactMatch = stdout.match(/Pages inactive:\s*(\d+)/)
      if (speccMatch && inactMatch) {
        const PAGE_SIZE = pgSizeMatch ? parseInt(pgSizeMatch[1]!, 10) : 4096
        cachedPages = (parseInt(speccMatch[1]!, 10) + parseInt(inactMatch[1]!, 10)) * PAGE_SIZE
      }
    }
  } catch { /* ignore */ }

  return {
    totalMb:  Math.round(total / 1024 / 1024),
    usedMb:   Math.round((total - free) / 1024 / 1024),
    cachedMb: Math.round(cachedPages / 1024 / 1024),
  }
}

async function ramStats(): Promise<{ usedMb: number; totalMb: number; cachedMb: number }> {
  if (process.platform === 'darwin') return ramStatsMacos()
  // Linux: cached is included in free per os.freemem() docs, so cached ~= 0
  const total = os.totalmem()
  const free  = os.freemem()
  return {
    totalMb:  Math.round(total / 1024 / 1024),
    usedMb:   Math.round((total - free) / 1024 / 1024),
    cachedMb: 0,
  }
}

// ── Battery ─────────────────────────────────────────────────────────────────

async function batteryMacos(): Promise<{ percent: number; charging: boolean } | undefined> {
  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'batt'], { encoding: 'utf-8', timeout: 2000 })
    if (!stdout) return undefined
    const m = stdout.match(/(\d+)%;\s*(charging|discharging|charged|finishing charge)/i)
    if (!m) return undefined
    const percent  = parseInt(m[1]!, 10)
    const charging = /charging|charged|finishing/i.test(m[2]!)
    return { percent, charging }
  } catch {
    return undefined
  }
}

function batteryLinux(): { percent: number; charging: boolean } | undefined {
  try {
    const base = '/sys/class/power_supply'
    const dirs = fs.readdirSync(base).filter(d => /^BAT/i.test(d))
    if (dirs.length === 0) return undefined
    const bat      = `${base}/${dirs[0]}`
    const percent  = parseInt(fs.readFileSync(`${bat}/capacity`, 'utf-8').trim(), 10)
    const status   = fs.readFileSync(`${bat}/status`, 'utf-8').trim().toLowerCase()
    const charging = status === 'charging' || status === 'full'
    return { percent, charging }
  } catch {
    return undefined
  }
}

async function battery(): Promise<{ percent: number; charging: boolean } | undefined> {
  const p = process.platform
  if (p === 'darwin') return batteryMacos()
  if (p === 'linux')  return batteryLinux()
  return undefined
}

// ── Relay ────────────────────────────────────────────────────────────────────

const METRICS_INTERVAL_MS = 10_000
const BATTERY_EVERY_N     = 3   // battery checked every 3rd tick (30s)

export function startMetricsRelay(
  sendFn: (metrics: SystemMetrics) => void,
): () => void {
  let tick = 0
  let cachedBattery: { percent: number; charging: boolean } | undefined
  let stopped = false
  let timer: NodeJS.Timeout | undefined

  // Delay starting the interval until the initial battery read settles, so the
  // first tick always sends a real battery value (matching the pre-async-conversion
  // guarantee) instead of racing an unresolved promise.
  void battery().then(b => {
    cachedBattery = b
    if (stopped) return
    timer = setInterval(() => {
      void (async () => {
        tick++
        if (tick % BATTERY_EVERY_N === 0) cachedBattery = await battery()

        const ram = await ramStats()
        sendFn({
          cpu:         cpuPercent(),
          ramUsedMb:   ram.usedMb,
          ramTotalMb:  ram.totalMb,
          ramCachedMb: ram.cachedMb,
          battery:     cachedBattery,
        })
      })()
    }, METRICS_INTERVAL_MS)
  })

  return () => {
    stopped = true
    if (timer) clearInterval(timer)
  }
}
