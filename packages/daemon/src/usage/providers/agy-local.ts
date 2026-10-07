/**
 * Antigravity usage, asked of the RUNNING `agy` process instead of Google.
 *
 *   POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
 *   Content-Type: application/json
 *   Connect-Protocol-Version: 1
 *   body: { "metadata": { "ideName": "antigravity", "extensionName": "antigravity",
 *                         "ideVersion": "unknown", "locale": "en" } }
 *
 * WHY THIS EXISTS, given `agy.ts` already works. The Google Code Assist path needs
 * an access token, and Antigravity's lasts about an hour; when it lapses the only
 * way to renew it is the OAuth client secret, which lives inside the CLI's own
 * bundle. So that path stops reading roughly an hour after each sign-in, and a
 * user who is genuinely signed in gets told their token expired.
 *
 * The running agent has no such problem: it holds its own session, so asking IT
 * needs no credential at all. The reference implementation prefers these local
 * paths for exactly this reason and keeps OAuth as its LAST fallback — a detail
 * worth having read before building the OAuth path first, which is what happened
 * here.
 *
 * AND THE PAYLOAD IS BETTER, which was not the reason for doing it but is the
 * bigger win. MEASURED live, 2026-08-11, HTTP 200:
 *
 *   { "response": { "groups": [
 *       { "displayName": "Gemini Models", "buckets": [
 *           { "bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 1,
 *             "displayName": "Weekly Limit Remaining", "resetTime": "2026-08-18T18:57:21Z" },
 *           { "bucketId": "gemini-5h", "window": "5h", … } ] },
 *       { "displayName": "Claude and GPT models", "buckets": [ "3p-weekly", "3p-5h" … ] } ] } }
 *
 * Google's `retrieveUserQuota` returns per-model buckets with ONE daily reset. This
 * returns a five-hour window AND a weekly window, per model family, with each
 * one's own reset — which is the difference between "you have quota today" and
 * "your session runs out in two hours".
 *
 * WHAT THIS DOES NOT DO. It never starts `agy`. The reference implementation
 * spawns a warm one with `posix_spawn` purely to have something to ask, then has
 * to manage and eventually kill the process it created. Jerico does not need that
 * — it is an agent orchestrator, so when the number matters there is already an
 * `agy` running. When there is not, this returns null and the OAuth path answers.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus'
const REQUEST_BODY = JSON.stringify({
  metadata: { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: 'unknown', locale: 'en' },
})
/** Localhost, and a process we already believe is on this machine. Short. */
const LOCAL_TIMEOUT_MS = 2_500
const PROBE_TIMEOUT_MS = 4_000
/** A machine with more `agy` processes than this is not a case worth chasing at a
 *  five-minute cadence; the first that answers wins anyway. */
const MAX_PROCESSES = 4
const MAX_PORTS_PER_PROCESS = 6
const ERROR_READ_BYTES = 512
const KNOWN_ERROR_CODES = new Set(['unauthenticated', 'permission_denied', 'unavailable', 'invalid_argument', 'not_found'])

export interface LocalEndpoint {
  pid: number
  port: number
}

/**
 * ASYNC, and the reason is worth stating precisely because the first version was
 * synchronous and a reviewer's severity for it was wrong in the other direction.
 *
 * MEASURED: one `pgrep` plus three `lsof` took **98 ms** in total, not the ~20 s
 * that multiplying the timeout ceiling by the process cap suggests. So this was
 * never manufacturing a `degraded` reading, and the orchestrator's HIGH severity
 * for it was inflation — retracted.
 *
 * It is still async, because ~100 ms of a single-threaded daemon not answering
 * `/health`, not pumping PTY output and not returning WS pongs is ~100 ms it did
 * not need to spend, and the timeout ceiling IS reachable if `lsof` ever hangs on
 * a wedged filesystem. The refresher already awaits.
 */
async function runOrEmpty(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(bin, args, {
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
    })
    return stdout
  } catch {
    // A non-zero exit is the normal answer to "no such process", not a failure
    // worth reporting: it simply means there is nothing running to ask.
    return ''
  }
}

/**
 * PIDs of running `agy` processes.
 *
 * `pgrep -x` matches the executable NAME exactly, so a shell command that merely
 * mentions `agy` — including the very command that looks for it — cannot match.
 * A substring search here would find its own grep and every editor window with
 * the word on screen.
 */
export async function findAgyPids(
  probe: (bin: string, args: string[]) => Promise<string> = runOrEmpty,
): Promise<number[]> {
  const out = await probe('/usr/bin/pgrep', ['-x', 'agy'])
  const pids: number[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!/^\d+$/.test(t)) continue
    pids.push(Number(t))
    if (pids.length >= MAX_PROCESSES) break
  }
  return pids
}

/**
 * The loopback TCP ports a PID is listening on.
 *
 * Parsed from `lsof` rather than guessed: Antigravity picks ephemeral ports, and
 * on this machine one process held 52962 and 52963 while another held 62459 and
 * 62460 — nothing about them is predictable.
 *
 * The pid is re-validated as digits before it reaches the command line even
 * though it came from our own parser. Cheap, and the alternative is a shell
 * injection whose input is "whatever pgrep printed".
 */
export async function findListenPorts(
  pid: number,
  probe: (bin: string, args: string[]) => Promise<string> = runOrEmpty,
): Promise<number[]> {
  if (!Number.isInteger(pid) || pid <= 0) return []
  const out = await probe('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'])
  const ports: number[] = []
  for (const line of out.split('\n')) {
    // `… TCP 127.0.0.1:52963 (LISTEN)` — loopback only. A listener on a routable
    // address is not this CLI's private endpoint and is not ours to poke.
    const m = /\s(?:127\.0\.0\.1|\[?::1\]?):(\d+)\s+\(LISTEN\)/.exec(line)
    const port = m?.[1]
    if (port === undefined) continue
    const n = Number(port)
    if (!ports.includes(n)) ports.push(n)
    if (ports.length >= MAX_PORTS_PER_PROCESS) break
  }
  return ports
}

/**
 * Ask one port. Returns the parsed JSON, or null when this is not the port.
 *
 * Each `agy` process listens on a PAIR: the lower port speaks HTTPS and answers
 * an HTTP request with `400 Client sent an HTTP request to an HTTPS server`, and
 * the higher one speaks plain HTTP. Rather than encode that ordering — an
 * observation about today, not a contract — every port is tried over HTTP and the
 * 400 is read as "wrong port, next".
 */
async function askPort(port: number, path: string, pid: number | null = null): Promise<unknown | null> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
      },
      body: REQUEST_BODY,
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    })
  } catch {
    return null
  }
  if (!response.ok) {
    let code: string | null = null
    let excerpt = ''
    try {
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      while (reader !== undefined && bytes < ERROR_READ_BYTES) {
        const chunk = await reader.read()
        if (chunk.done || chunk.value === undefined) break
        const take = chunk.value.subarray(0, ERROR_READ_BYTES - bytes)
        chunks.push(take)
        bytes += take.byteLength
        if (take.byteLength !== chunk.value.byteLength) break
      }
      await reader?.cancel()
      const joined = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
      excerpt = new TextDecoder().decode(joined)
      const match = /"code"\s*:\s*"([a-z_]+)"/i.exec(excerpt)
      const candidate = match?.[1]?.toLowerCase()
      code = candidate !== undefined && KNOWN_ERROR_CODES.has(candidate) ? candidate : null
    } catch { /* status is enough */ }
    // Only this known TLS listener diagnostic is a routine wrong-port probe.
    if (response.status === 400 && excerpt.startsWith('Client sent an HTTP request to an HTTPS server')) return null
    console.log('[daemon] usage.agy.local_rejected', { pid, port, status: response.status, code })
    return null
  }
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** Test seam for a loopback HTTP stub; it never discovers or contacts a real agy. */
export async function __test_askAgyPort(port: number, path = QUOTA_PATH): Promise<unknown | null> {
  return askPort(port, path)
}

export interface LocalAnswer {
  endpoint: LocalEndpoint
  quota: unknown
  /** `GetUserStatus`, when it answered. Carries the plan; a null here costs the
   *  plan badge and nothing else, so it is never fatal. */
  status: unknown | null
}

/**
 * Find a running `agy` and ask it. Returns null when there is nothing to ask,
 * which is a normal state and not an error — the OAuth path answers then.
 */
export async function askRunningAgy(): Promise<LocalAnswer | null> {
  for (const pid of await findAgyPids()) {
    for (const port of await findListenPorts(pid)) {
      const quota = await askPort(port, QUOTA_PATH, pid)
      if (quota === null) continue
      // The quota is the point; the status is a bonus and must not gate it.
      const status = await askPort(port, STATUS_PATH, pid)
      return { endpoint: { pid, port }, quota, status }
    }
  }
  return null
}
