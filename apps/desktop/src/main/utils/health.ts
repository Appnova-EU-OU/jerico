import * as http from 'node:http'
import { getProfileName } from './profile.js'
import {
  classifyHealth,
  NO_ANSWER,
  type HealthPayload,
  type HealthResult,
  type TrayState,
} from './health-classify.js'

export type { TrayState, HealthResult } from './health-classify.js'
const POLL_TIMEOUT_MS = 4000

/** A real /health payload is a few hundred bytes. Anything past this is not a
 *  daemon answering, and both pollers used to accumulate whatever arrived into
 *  a string every few seconds — a 50MB body was measured going straight into
 *  the main process. Whoever can squat the port is already a modelled threat
 *  here (that is what the profile check is for); this stops them feeding it. */
const MAX_BODY_BYTES = 64 * 1024

/** Accumulate a response body, giving up if it stops looking like one. */
function readCapped(
  res: NodeJS.ReadableStream,
  req: { destroy(): void },
  onBody: (body: string) => void,
  onTooBig: () => void,
): void {
  let body = ''
  let over = false
  res.on('data', (chunk: Buffer) => {
    if (over) return
    if (body.length + chunk.length > MAX_BODY_BYTES) {
      over = true
      req.destroy()
      console.warn('[jerico-desktop] health: response over 64KB — not a daemon, discarding')
      onTooBig()
      return
    }
    body += chunk.toString()
  })
  res.on('end', () => { if (!over) onBody(body) })
}

export function pollOnce(port: number, options: { freshProbe?: boolean } = {}): Promise<HealthResult> {
  return new Promise((resolve) => {
    const onNoResponse = (): void => resolve(NO_ANSWER)
    const probeQuery = options.freshProbe ? '?probe=fresh' : ''
    const req = http.get(
      `http://127.0.0.1:${port}/health${probeQuery}`,
      { timeout: POLL_TIMEOUT_MS },
      (res) => {
        readCapped(res, req, (body) => {
          try {
            const payload = JSON.parse(body) as HealthPayload
            const result = classifyHealth(payload, getProfileName(), res.statusCode ?? 0)
            if (result.foreign) {
              console.warn('[jerico-desktop] health: a different profile answered on this port', {
                expected: getProfileName(), got: payload.profile, port,
              })
            }
            resolve(result)
          } catch {
            resolve({ ...NO_ANSWER, state: 'yellow' })
          }
        }, () => resolve(NO_ANSWER))
      },
    )
    req.on('error', onNoResponse)
    req.on('timeout', () => { req.destroy(); onNoResponse() })
  })
}

export interface HealthPoller {
  stop(): void
}

/**
 * Starts a repeating health poll against the daemon health endpoint.
 * G3 graft: requires 2 consecutive no-response polls before flipping to red,
 * to avoid single-dropped-poll flicker. Yellow (503/not-connected) transitions immediately.
 * Callback fires on every non-suppressed tick so activePanels stays current.
 */
/**
 * Poll the daemon /health endpoint and return the running daemon version
 * (or null if unreachable / parse failure). Used during app launch to
 * detect a stale daemon that needs restarting after an update.
 */
export function pollVersion(port: number, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    const onNoResponse = (): void => resolve(null)
    const req = http.get(
      `http://127.0.0.1:${port}/health`,
      { timeout: timeoutMs },
      (res) => {
        readCapped(res, req, (body) => {
          try {
            const payload = JSON.parse(body) as HealthPayload
            resolve(payload.version ?? null)
          } catch {
            resolve(null)
          }
        }, () => resolve(null))
      },
    )
    req.on('error', onNoResponse)
    req.on('timeout', () => { req.destroy(); onNoResponse() })
  })
}

export function startHealthPoller(
  port: number,
  onResult: (result: HealthResult) => void,
  intervalMs = 5000,
): HealthPoller {
  let consecutiveNoResponse = 0

  async function tick(): Promise<void> {
    const result = await pollOnce(port)

    if (result.state === 'red') {
      consecutiveNoResponse++
      if (consecutiveNoResponse < 2) return  // hold until threshold (G3)
    } else {
      consecutiveNoResponse = 0
    }

    onResult(result)
  }

  void tick()
  const timer = setInterval(() => { void tick() }, intervalMs)

  return {
    stop(): void { clearInterval(timer) },
  }
}
