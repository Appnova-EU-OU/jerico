/**
 * Antigravity (`agy`) usage, from Google's Code Assist endpoint.
 *
 *   POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
 *   Authorization: Bearer <token.access_token>
 *   body: {}
 *
 * THE CREDENTIAL IS NOT WHERE JERICO CURRENTLY LOOKS, and that is a finding, not
 * a footnote. `pty/agents.ts` `checkAuth` for `agy` reads
 * `~/.gemini/oauth_creds.json` — the **Gemini CLI's** file. On the machine this
 * was written on that file was last touched on 25 June and its token expired on
 * 2026-06-26; the endpoint answers 401 for it. Signing into `agy` did not change
 * it. The real credential is
 *
 *   ~/.gemini/antigravity-cli/antigravity-oauth-token
 *
 * written at the moment of sign-in, shaped `{ auth_method, token: { access_token,
 * token_type, refresh_token, expiry } }`. So `agy` detection has been passing on
 * the strength of an unrelated, six-week-stale file: a false positive that says
 * "this agent can run" for the wrong reason. Filed separately; this file reads the
 * correct one and falls back to the Gemini CLI credential only because a user who
 * signed in with the Gemini CLI genuinely has one.
 *
 * MEASURED live, 2026-08-11, HTTP 200:
 *
 *   { "buckets": [ { "resetTime": "2026-08-12T18:59:02Z", "tokenType": "REQUESTS",
 *                    "modelId": "gemini-2.5-pro", "remainingFraction": 1 }, … ] }
 *
 * FOUR ways this differs from the providers before it:
 *
 *   1. `remainingFraction` is what is **LEFT**, not what is used, and it is a
 *      FRACTION not a percentage. So `usedPercent = (1 - fraction) * 100`. Reading
 *      it as "used" inverts the meaning: a fresh account reporting 1 would be
 *      drawn as 100% spent, which is the single most alarming way to be wrong.
 *   2. There are no windows — there are per-MODEL buckets. Four of them here, one
 *      per Gemini model, each with its own reset.
 *   3. `tokenType` distinguishes what is being counted (`REQUESTS` here). A future
 *      `TOKENS` bucket would be a different unit and must not be averaged in with
 *      requests, so the type is carried and unknown types are dropped.
 *   4. There is no plan and no cost in this payload. `loadCodeAssist` reports a
 *      tier and is deliberately NOT called: one endpoint, one purpose, and a plan
 *      badge is not worth a second request per refresh.
 *
 * ON THE DEPRECATION. Google stopped serving Gemini CLI OAuth for individual, AI
 * Pro and Ultra accounts on 2026-06-18, and the stale Gemini credential above
 * expired eight days later — consistent with that cutoff, though not proof of it.
 * It does NOT apply to this path: the Antigravity token is `auth_method:
 * consumer` and `retrieveUserQuota` answered 200 for it. Measured, not assumed.
 */

import { askRunningAgy } from './agy-local.js'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { detectAgents } from '../../pty/agents.js'
import { readCredentialFile } from '../credentials.js'
import { fault, type IdentitySnapshot, type RateWindow, type UsageResult } from '../model.js'

const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
/** The file Antigravity itself writes on sign-in. */
const AGY_CREDENTIAL = '.gemini/antigravity-cli/antigravity-oauth-token'
/** The Gemini CLI's own credential, for a user who signed in that way instead. */
const GEMINI_CREDENTIAL = '.gemini/oauth_creds.json'
const REQUEST_TIMEOUT_MS = 12_000
/** A token about to expire is not a usable token. */
const EXPIRY_MARGIN_MS = 60_000
const CLI_OUTPUT_MAX_BYTES = 64 * 1024
const CLI_TIMEOUT_MS = 75_000
const CLI_THROTTLE_MS = 10 * 60_000
const CLI_SNAPSHOT_FRESH_MS = 6 * 60 * 60_000

let cliLastStartedAt = 0
let cliInFlight: Promise<UsageResult | null> | null = null
let cliLastSnapshot: UsageResult | null = null

/** Only counted units we understand. A bucket measuring something else is not
 *  comparable and is dropped rather than mixed in. */
const KNOWN_TOKEN_TYPES = new Set(['REQUESTS'])

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function readIso(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

interface Credential {
  accessToken: string
  describe: string
  /** Epoch ms, or null when the file states none. */
  expiresAt: number | null
}

/**
 * The Antigravity token first, the Gemini CLI's second.
 *
 * Order matters and is not arbitrary: a user who has both should be asked about
 * with the credential the agent Jerico actually spawns signed in with.
 */
export function resolveAgyCredential(
  readFile: (rel: string) => ReturnType<typeof readCredentialFile>,
): Credential | { error: string; malformed: boolean } {
  const agy = readFile(AGY_CREDENTIAL)
  if (agy.found) {
    const token = asRecord(agy.credential.data['token'])
    const access = token === null ? null : token['access_token']
    if (typeof access === 'string' && access.length > 0) {
      return {
        accessToken: access,
        describe: agy.credential.describe,
        expiresAt: readIso(token?.['expiry']),
      }
    }
    return { error: `${agy.credential.describe} has no token.access_token`, malformed: true }
  }
  if (agy.reason === 'malformed') return { error: agy.detail, malformed: true }

  const gemini = readFile(GEMINI_CREDENTIAL)
  if (gemini.found) {
    const access = gemini.credential.data['access_token']
    if (typeof access === 'string' && access.length > 0) {
      const expiry = finite(gemini.credential.data['expiry_date'])
      return {
        accessToken: access,
        describe: gemini.credential.describe,
        // The Gemini CLI writes milliseconds here, unlike Antigravity's ISO string.
        expiresAt: expiry === null ? null : expiry > 100_000_000_000 ? expiry : expiry * 1000,
      }
    }
  } else if (gemini.reason === 'malformed') {
    return { error: gemini.detail, malformed: true }
  }

  return {
    error: `no credential at ~/${AGY_CREDENTIAL} or ~/${GEMINI_CREDENTIAL} — sign in with \`agy\` first`,
    malformed: false,
  }
}

/**
 * Parse `retrieveUserQuota`. Exported so every shape is testable without a
 * network call or a credential.
 *
 * One bucket per model becomes one scoped window per model, all nested under a
 * synthetic parent that carries the WORST of them — because the register shows one
 * row per agent and "agy is at 80%" has to mean the model that will stop first,
 * not an average across models the user may not even be using.
 */
export function parseAgyQuota(payload: unknown): { windows: RateWindow[] } | { error: string } {
  const root = asRecord(payload)
  if (root === null) return { error: 'quota response is not a JSON object' }
  const buckets = root['buckets']
  if (!Array.isArray(buckets)) return { error: 'quota response carried no buckets array' }

  const scoped: RateWindow[] = []
  for (const raw of buckets) {
    const rec = asRecord(raw)
    if (rec === null) continue
    const modelId = rec['modelId']
    if (typeof modelId !== 'string' || modelId.length === 0) continue
    const tokenType = rec['tokenType']
    if (typeof tokenType !== 'string' || !KNOWN_TOKEN_TYPES.has(tokenType)) continue
    const fraction = finite(rec['remainingFraction'])
    if (fraction === null) continue

    scoped.push({
      id: `models:${modelId}`,
      title: modelId,
      // REMAINING → USED. Getting this backwards would draw a fresh account as
      // fully spent.
      usedPercent: Math.max(0, Math.min(100, (1 - fraction) * 100)),
      // Google does not grade these.
      severity: null,
      isActive: true,
      resetsAt: readIso(rec['resetTime']),
      // The payload states no window length. Null, so no pace is projected — the
      // reset time is still shown, which is the actionable half.
      windowMinutes: null,
      scopedUnder: 'models',
      counts: null,
    })
  }

  if (scoped.length === 0) return { error: 'no bucket carried a model id, known token type and remaining fraction' }

  // The parent is the worst model, and it says so. A synthetic row that averaged
  // them would be a number no bucket reported.
  // scoped.length > 0 was just checked, so index 0 exists; the assertion is for
  // the compiler rather than a claim about the data.
  let worst: RateWindow = scoped[0] as RateWindow
  for (const w of scoped) if (w.usedPercent > worst.usedPercent) worst = w
  const parent: RateWindow = {
    id: 'models',
    title: 'models',
    usedPercent: worst.usedPercent,
    severity: null,
    isActive: true,
    resetsAt: worst.resetsAt,
    windowMinutes: null,
    scopedUnder: null,
    counts: null,
  }

  scoped.sort((a, b) => b.usedPercent - a.usedPercent || a.title.localeCompare(b.title))
  return { windows: [parent, ...scoped] }
}

/** Strict parser for `agy -p /usage --output-format json`. The CLI uses snake
 * case and nests limits in named groups; neither is interchangeable with the
 * authenticated HTTP quota response above. */
export function parseAgyCliUsage(payload: unknown): { windows: RateWindow[] } | { error: string; code?: 'unauthorized' } {
  const root = asRecord(payload)
  if (root === null) return { error: 'agy /usage response was not an object' }
  if (root['status'] !== 'SUCCESS') {
    const authText = [root['status'], root['error'], root['message'], asRecord(root['command'])?.['error']]
      .filter((value): value is string => typeof value === 'string').join(' ')
    return /unauth|authentication|not signed in|login required|invalid credential|credential expired/i.test(authText)
      ? { error: 'agy /usage rejected the current sign-in', code: 'unauthorized' }
      : { error: 'agy /usage did not report SUCCESS' }
  }
  const command = asRecord(root['command'])
  if (command === null || command['name'] !== 'usage') return { error: 'agy response was not the usage command' }
  const data = asRecord(command['data'])
  const groups = data === null ? null : data['groups']
  if (!Array.isArray(groups)) return { error: 'agy usage response carried no groups array' }

  const windows: RateWindow[] = []
  for (const rawGroup of groups) {
    const group = asRecord(rawGroup)
    if (group === null) continue
    const name = typeof group['name'] === 'string' ? group['name'].trim() : ''
    const isGemini = /gemini/i.test(name)
    const isThirdParty = /claude|gpt/i.test(name)
    if (!isGemini && !isThirdParty) continue
    // CodexBar accepts both historical `buckets` and current `items` keys.
    const items = Array.isArray(group['items']) ? group['items'] : group['buckets']
    if (!Array.isArray(items)) continue
    const groupId = `group:${name.toLowerCase().replace(/\s+/g, '-')}`
    const children: RateWindow[] = []
    for (const rawItem of items) {
      const item = asRecord(rawItem)
      if (item === null) continue
      const id = typeof item['id'] === 'string' ? item['id'] : ''
      const window = item['window']
      const fraction = finite(item['remaining_fraction'])
      if (id === '' || (window !== '5h' && window !== 'weekly') || fraction === null || fraction < 0 || fraction > 1) continue
      children.push({
        id: `${groupId}:${id}`,
        // `remaining_fraction` becomes `usedPercent`; never label that number as
        // remaining even if agy's source text does.
        title: `${String(window)} used`,
        usedPercent: Math.max(0, Math.min(100, (1 - fraction) * 100)), severity: null, isActive: true,
        resetsAt: readIso(item['reset_time']), windowMinutes: localWindowMinutes(window), scopedUnder: groupId, counts: null,
      })
    }
    if (children.length === 0) continue
    const worst = children.reduce((a, b) => a.usedPercent >= b.usedPercent ? a : b)
    windows.push({ id: groupId, title: name, usedPercent: worst.usedPercent, severity: null, isActive: true,
      resetsAt: worst.resetsAt, windowMinutes: worst.windowMinutes, scopedUnder: null, counts: null })
    children.sort((a, b) => b.usedPercent - a.usedPercent || a.title.localeCompare(b.title))
    windows.push(...children)
  }
  return windows.length > 0 ? { windows } : { error: 'agy usage response carried no known quota buckets' }
}

async function resolveAgyCliBinary(): Promise<string | null> {
  if (process.env['NODE_ENV'] === 'test' && process.env['JERICO_TEST_AGY_BIN']) return process.env['JERICO_TEST_AGY_BIN']
  const agent = (await detectAgents()).find((entry) => entry.key === 'agy')
  return agent?.binaryPath ?? null
}

async function runAgyCliUsage(): Promise<UsageResult | null> {
  const binary = await resolveAgyCliBinary()
  if (binary === null) return null
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'jerico-agy-usage-'))
  try {
    return await new Promise<UsageResult | null>((resolve) => {
      let bytes = 0
      let output = ''
      let timedOut = false
      let settled = false
      const child = spawn(binary, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '60s'], {
        cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false,
      })
      const timeoutMs = process.env['NODE_ENV'] === 'test' && process.env['JERICO_TEST_AGY_TIMEOUT_MS']
        ? Number(process.env['JERICO_TEST_AGY_TIMEOUT_MS']) : CLI_TIMEOUT_MS
      const kill = (): void => { try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') } }
      const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
      const fail = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        kill()
        console.warn('[daemon] usage.agy.cli_failed', { exitCode, signal, timedOut, bytes })
        resolve(null)
      }
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > CLI_OUTPUT_MAX_BYTES) { kill(); return }
        output += chunk.toString('utf8')
      })
      child.once('error', () => fail(null, null))
      child.once('close', (exitCode, signal) => {
        if (timedOut || bytes > CLI_OUTPUT_MAX_BYTES || exitCode !== 0) {
          fail(exitCode, signal); return
        }
        try {
          const parsed = parseAgyCliUsage(JSON.parse(output) as unknown)
          if ('error' in parsed) {
            if (parsed.code === 'unauthorized') { if (!settled) { settled = true; clearTimeout(timer); resolve(fault('unauthorized', parsed.error)) }; return }
            fail(exitCode, signal); return
          }
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ ok: true, snapshot: { agent: 'agy', windows: parsed.windows, cost: null,
            identity: { plan: null, loginMethod: 'agy CLI', accountId: null }, fetchedAt: Date.now(), source: 'agy /usage', credentialSource: 'agent_cli' } })
        } catch { fail(exitCode, signal) }
      })
    })
  } finally { await rm(cwd, { recursive: true, force: true }) }
}

async function fetchAgyViaCli(): Promise<UsageResult | null> {
  if (cliInFlight !== null) return cliInFlight
  cliLastStartedAt = Date.now()
  cliInFlight = runAgyCliUsage().then((result) => {
    if (result?.ok) cliLastSnapshot = result
    return result
  }).finally(() => { cliInFlight = null })
  return cliInFlight
}

export function __test_resetAgyCliUsage(): void { cliLastStartedAt = 0; cliInFlight = null; cliLastSnapshot = null }
export function __test_setAgyCliLastStartedAt(value: number): void { cliLastStartedAt = value }
export function __test_setAgyCliSnapshotAge(ageMs: number): void {
  if (cliLastSnapshot?.ok) cliLastSnapshot = { ...cliLastSnapshot, snapshot: { ...cliLastSnapshot.snapshot, fetchedAt: Date.now() - ageMs } }
}

/** `5h` → 300, `weekly` → 10080. The payload names the window; nothing here
 *  converts a number it was not given. An unrecognised name yields null, which
 *  costs the pace projection and keeps the percentage and the reset. */
export function localWindowMinutes(window: unknown): number | null {
  if (window === '5h') return 300
  if (window === 'weekly') return 7 * 24 * 60
  if (window === 'daily') return 24 * 60
  if (window === 'monthly') return null
  return null
}

/** `Gemini Models` → `gemini models`; `gemini-weekly` → `gemini-weekly`. Lowercase
 *  because every other title on this surface is. */
function lower(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v.toLowerCase() : fallback
}

/**
 * Parse `RetrieveUserQuotaSummary`.
 *
 * Each GROUP becomes a parent row carrying its worst bucket, and each bucket a
 * child. That mirrors the payload's own structure and the thing a user asks:
 * "which family of models am I about to run out of, and on which clock".
 */
export function parseLocalQuotaSummary(payload: unknown): { windows: RateWindow[] } | { error: string } {
  const root = asRecord(payload)
  const response = root === null ? null : asRecord(root['response'])
  if (response === null) return { error: 'quota summary carried no response object' }
  const groups = response['groups']
  if (!Array.isArray(groups)) return { error: 'quota summary carried no groups array' }

  const out: RateWindow[] = []
  for (const rawGroup of groups) {
    const group = asRecord(rawGroup)
    if (group === null) continue
    const buckets = group['buckets']
    if (!Array.isArray(buckets)) continue

    const groupTitle = lower(group['displayName'], 'models')
    const groupId = `group:${groupTitle.replace(/\s+/g, '-')}`
    const children: RateWindow[] = []

    for (const rawBucket of buckets) {
      const bucket = asRecord(rawBucket)
      if (bucket === null) continue
      const fraction = finite(bucket['remainingFraction'])
      if (fraction === null) continue
      const bucketId = lower(bucket['bucketId'], '')
      if (bucketId === '') continue
      children.push({
        id: `${groupId}:${bucketId}`,
        // The window, not the bucket id: "5h" and "weekly" are what a user reads,
        // and the id is an implementation detail that happens to contain them.
        title: lower(bucket['window'], bucketId),
        // REMAINING fraction → USED percent. Same inversion as the OAuth path, and
        // the same reason it is spelled out: read the familiar way, a completely
        // fresh account draws as fully spent.
        usedPercent: Math.max(0, Math.min(100, (1 - fraction) * 100)),
        // Antigravity does not grade its own limits.
        severity: null,
        isActive: true,
        resetsAt: readIso(bucket['resetTime']),
        windowMinutes: localWindowMinutes(bucket['window']),
        scopedUnder: groupId,
        counts: null,
      })
    }

    if (children.length === 0) continue
    let worst: RateWindow = children[0] as RateWindow
    for (const c of children) if (c.usedPercent > worst.usedPercent) worst = c
    out.push({
      id: groupId,
      title: groupTitle,
      // The group carries its worst bucket, never an average: an average is a
      // number no bucket reported, and the binding limit is what stops a run.
      usedPercent: worst.usedPercent,
      severity: null,
      isActive: true,
      resetsAt: worst.resetsAt,
      windowMinutes: worst.windowMinutes,
      scopedUnder: null,
      counts: null,
    })
    children.sort((a, b) => b.usedPercent - a.usedPercent || a.title.localeCompare(b.title))
    out.push(...children)
  }

  if (out.length === 0) return { error: 'no group carried a bucket with a remaining fraction' }
  return { windows: out }
}

/** `TEAMS_TIER_PRO` → `pro`. The local status reports a tier the OAuth path does
 *  not, so the plan badge only appears on this route. */
export function parseLocalPlan(status: unknown): string | null {
  const root = asRecord(status)
  const userStatus = root === null ? null : asRecord(root['userStatus'])
  const planStatus = userStatus === null ? null : asRecord(userStatus['planStatus'])
  const planInfo = planStatus === null ? null : asRecord(planStatus['planInfo'])
  if (planInfo === null) return null
  const tier = planInfo['teamsTier']
  if (typeof tier === 'string' && tier.length > 0) {
    return tier.replace(/^TEAMS_TIER_/, '').toLowerCase().replace(/_/g, ' ')
  }
  const name = planInfo['planName']
  return typeof name === 'string' && name.length > 0 ? name.toLowerCase() : null
}

export async function fetchAgyUsage(opts: { allowInteractive: boolean }): Promise<UsageResult> {
  // LOCAL FIRST. A running agent holds its own session, so this needs no
  // credential and cannot expire — and it reports a five-hour window as well as a
  // weekly one, which the OAuth path does not.
  const local = await (askRunningAgyOverride ?? askRunningAgy)()
  if (local !== null) {
    const parsed = parseLocalQuotaSummary(local.quota)
    if ('windows' in parsed) {
      return {
        ok: true,
        snapshot: {
          agent: 'agy',
          windows: parsed.windows,
          cost: null,
          identity: { plan: parseLocalPlan(local.status), loginMethod: 'running agent', accountId: null },
          fetchedAt: Date.now(),
          source: `running agy (pid ${String(local.endpoint.pid)}) · 127.0.0.1:${String(local.endpoint.port)}`,
        },
      }
    }
    // A running agent that answered something unreadable is worth knowing about,
    // but it must not stop the OAuth path from answering — so fall through.
  }
  if (!opts.allowInteractive) {
    // Preserve an interactive CLI reading without spawning another phantom agy
    // session. On a cold daemon there is no such reading, so the older OAuth
    // chain still has a chance to answer.
    if (cliLastSnapshot?.ok && Date.now() - cliLastSnapshot.snapshot.fetchedAt <= CLI_SNAPSHOT_FRESH_MS) {
      return fault('interactive_deferred', 'agy /usage is only run when usage is opened, so background refreshes do not create phantom sessions')
    }
    return fetchAgyViaOAuth()
  }
  if (cliInFlight !== null || Date.now() - cliLastStartedAt >= CLI_THROTTLE_MS) {
    const cli = await fetchAgyViaCli()
    if (cli !== null) return cli
    // A reread was attempted and failed. Do not relabel the old number as a
    // fresh success; the OAuth fallback below gives the refresher a real fault
    // to retain beside that older agent_cli snapshot.
    return fetchAgyViaOAuth()
  }
  if (cliLastSnapshot?.ok && Date.now() - cliLastSnapshot.snapshot.fetchedAt <= CLI_SNAPSHOT_FRESH_MS) return cliLastSnapshot
  return fetchAgyViaOAuth()
}

/** Test-only seam: keeps provider-path tests away from real local processes. */
let askRunningAgyOverride: (() => ReturnType<typeof askRunningAgy>) | null = null
export function __test_setAskRunningAgyOverride(fn: (() => ReturnType<typeof askRunningAgy>) | null): void {
  askRunningAgyOverride = fn
}

async function fetchAgyViaOAuth(): Promise<UsageResult> {
  const resolved = resolveAgyCredential(readCredentialFile)
  if ('error' in resolved) {
    return fault(resolved.malformed ? 'malformed' : 'no_credentials', resolved.error)
  }

  // Checked locally first, for the same reason Claude's scopes are: the answer is
  // already in the file and a request would only confirm it more slowly. The
  // sixty-second margin comes from the reference implementation: a token with
  // four seconds left is not usable, and calling it valid turns a clean "expired"
  // into a confusing "rejected".
  if (resolved.expiresAt !== null && resolved.expiresAt <= Date.now() + EXPIRY_MARGIN_MS) {
    return agyTokenLapsedFault(resolved.describe)
  }

  let response: Response
  try {
    response = await fetch(QUOTA_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${resolved.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      // `{}` means "whatever project this credential resolves to". CodexBar can
      // pass a discovered project id; discovering one costs two more requests
      // (loadCodeAssist, then Cloud Resource Manager) and the empty body answered
      // 200 here, so the extra round trips are not bought.
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return fault('network', `could not reach cloudcode-pa.googleapis.com: ${msg}`)
  }

  if (response.status === 401) {
    return fault('unauthorized', `the token in ${resolved.describe} was rejected — open \`agy\` to sign in again`)
  }
  if (response.status === 403) {
    // Google's own signal for a client it no longer serves. Distinct sentence,
    // because no amount of re-signing-in fixes an ineligible tier.
    let detail = 'quota is forbidden for this account'
    try {
      const text = await response.text()
      if (/UNSUPPORTED_CLIENT|IneligibleTier/i.test(text)) {
        detail = 'Google no longer serves quota for this account tier through this client'
      }
    } catch { /* the status is the finding; the body is a bonus */ }
    return fault('scope_insufficient', detail)
  }
  if (!response.ok) {
    return fault('network', `cloudcode-pa.googleapis.com returned HTTP ${String(response.status)}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return fault('malformed', 'quota response was not valid JSON')
  }

  const parsed = parseAgyQuota(body)
  if ('error' in parsed) return fault('malformed', parsed.error)

  const identity: IdentitySnapshot = {
    // This endpoint reports no plan. `loadCodeAssist` does; it is not called.
    plan: null,
    loginMethod: 'OAuth',
    accountId: null,
  }

  return {
    ok: true,
    snapshot: {
      agent: 'agy',
      windows: parsed.windows,
      cost: null,
      identity,
      fetchedAt: Date.now(),
      source: `cloudcode-pa.googleapis.com · ${resolved.describe}`,
    },
  }
}

export function agyTokenLapsedFault(describe: string): UsageResult {
  return fault(
    'token_lapsed',
    `reading paused: the stored token in ${describe} is old, and the running agy did not answer the local quota request. ` +
      'Jerico will not renew it itself because that needs the OAuth client secret from the CLI bundle.',
  )
}
