import { execFile } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import type { DevServerDiscoveryError, DevServerInfo } from '../shared/types.js'
import { isPreviewProxyPort } from './proxy.js'

const LSOF_PATH = '/usr/sbin/lsof'
const LSOF_TIMEOUT_MS = 1_000
const LSOF_MAX_BUFFER = 1024 * 1024
const MAX_CANDIDATES = 64
const MAX_RESULTS = 32
const PROBE_CONCURRENCY = 8
const PROBE_TIMEOUT_MS = 350
const MAX_BODY_BYTES = 64 * 1024
const SCAN_TIMEOUT_MS = 2_500
const CACHE_TTL_MS = 5_000
const GENERIC_TITLE = 'Local web server'

export interface ListenerCandidate {
  port: number
  family: 4 | 6
}

interface EnumerationResult {
  candidates: ListenerCandidate[]
  truncated: boolean
}

export interface DevServerDiscoveryResult {
  servers: DevServerInfo[]
  scannedAt: number
  truncated?: boolean
  error?: DevServerDiscoveryError
}

interface ProbeResponse {
  statusCode: number
  contentType: string
  location?: string
  body: string
  url: URL
}

interface ScanOptions {
  platform?: NodeJS.Platform
  enumerate?: (signal: AbortSignal) => Promise<EnumerationResult>
  probe?: (candidate: ListenerCandidate, deadline: number, signal: AbortSignal) => Promise<DevServerInfo | null>
  proxyPort?: (port: number) => boolean
  now?: () => number
}

let cached: { value: DevServerDiscoveryResult; storedAt: number } | null = null
let inFlight: Promise<DevServerDiscoveryResult> | null = null

function parsePort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null
}

function endpointCandidates(endpoint: string, socketType: string): ListenerCandidate[] {
  const bracketed = /^\[([^\]]+)]:(\d{1,5})$/.exec(endpoint)
  const plain = /^(.*):(\d{1,5})$/.exec(endpoint)
  const match = bracketed ?? plain
  if (!match) return []
  const host = (match[1] ?? '').toLowerCase()
  const port = parsePort(match[2] ?? '')
  if (!port) return []

  if (host === '::1') return [{ port, family: 6 }]
  if (host === '::') return [{ port, family: 4 }, { port, family: 6 }]
  if (host === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(host)) {
    return [{ port, family: 4 }]
  }
  if (host === '*') {
    if (socketType.toLowerCase() === 'ipv4') return [{ port, family: 4 }]
    if (socketType.toLowerCase() === 'ipv6') return [{ port, family: 4 }, { port, family: 6 }]
    return [{ port, family: 4 }, { port, family: 6 }]
  }
  return []
}

/** Parse lsof's machine-readable NUL fields. Human-aligned columns are never
 * consumed because spacing and localized command names are not stable. */
export function parseLsofOutput(output: string, proxyPort: (port: number) => boolean = isPreviewProxyPort): EnumerationResult {
  const found = new Map<string, ListenerCandidate>()
  let socketType = ''
  let truncated = false

  for (const rawField of output.split(/[\0\n]+/)) {
    const field = rawField.trim()
    if (field.length < 2) continue
    const tag = field[0]
    const value = field.slice(1)
    if (tag === 'f') {
      socketType = ''
      continue
    }
    if (tag === 't') {
      socketType = value
      continue
    }
    if (tag !== 'n') continue

    for (const candidate of endpointCandidates(value, socketType)) {
      if (proxyPort(candidate.port)) continue
      const key = `${candidate.family}:${candidate.port}`
      if (found.has(key)) continue
      if (found.size >= MAX_CANDIDATES) {
        truncated = true
        continue
      }
      found.set(key, candidate)
    }
  }

  const candidates = [...found.values()].sort((a, b) => a.port - b.port || a.family - b.family)
  return { candidates, truncated }
}

function enumerateDarwinListeners(signal: AbortSignal): Promise<EnumerationResult> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid === null) return Promise.reject(new Error('uid_unavailable'))

  return new Promise((resolve, reject) => {
    execFile(
      LSOF_PATH,
      ['-nP', '-a', '-u', String(uid), '-iTCP', '-sTCP:LISTEN', '-F0pcftn'],
      { encoding: 'utf8', timeout: LSOF_TIMEOUT_MS, maxBuffer: LSOF_MAX_BUFFER, signal },
      (error, stdout) => {
        const text = stdout
        if (!error) {
          resolve(parseLsofOutput(text))
          return
        }
        if (signal.aborted) {
          reject(error)
          return
        }
        const code = (error as { code?: unknown }).code
        if (String(code) === '1' && text.length === 0) {
          resolve({ candidates: [], truncated: false })
          return
        }
        // maxBuffer errors can still carry a safe partial machine-readable prefix.
        if (text.length > 0 && String(code).includes('MAXBUFFER')) {
          const partial = parseLsofOutput(text)
          resolve({ ...partial, truncated: true })
          return
        }
        reject(error)
      },
    )
  })
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos|nbsp);/gi, (entity, decimal: string | undefined, hex: string | undefined) => {
    if (decimal) return String.fromCodePoint(Math.min(Number(decimal), 0x10ffff))
    if (hex) return String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff))
    switch (entity.toLowerCase()) {
      case '&amp;': return '&'
      case '&lt;': return '<'
      case '&gt;': return '>'
      case '&quot;': return '"'
      case '&apos;': return "'"
      case '&nbsp;': return ' '
      default: return ''
    }
  })
}

const SECRET_TITLE_PATTERN = /\b(?:token|secret|api[\s_-]*key|password|passwd|csrf|auth(?:entication|orization)?|bearer|credential|private[\s_-]*key)\b/i
const HIGH_ENTROPY_PATTERN = /(?:[A-Za-z0-9+/_=-]{28,})/

export function sanitizeDevServerTitle(rawTitle: string | null | undefined): string {
  if (!rawTitle) return GENERIC_TITLE
  const decoded = decodeEntities(rawTitle)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const capped = [...decoded].slice(0, 120).join('')
  if (!capped || SECRET_TITLE_PATTERN.test(capped) || HIGH_ENTROPY_PATTERN.test(capped)) return GENERIC_TITLE
  return capped
}

function extractTitle(body: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(body)
  return sanitizeDevServerTitle(match?.[1])
}

function isHtmlContentType(contentType: string): boolean {
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase()
  return mime === 'text/html' || mime === 'application/xhtml+xml'
}

function isGenericContentType(contentType: string): boolean {
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase()
  return !mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream'
}

function hasHtmlPrefix(body: string): boolean {
  return /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(body.replace(/^\uFEFF/, ''))
}

function isUsableStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 400
}

function requestOnce(url: URL, method: 'HEAD' | 'GET', deadline: number, signal: AbortSignal): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted || Date.now() >= deadline) {
      reject(new Error('probe_timeout'))
      return
    }

    const transport = url.protocol === 'https:' ? https : http
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      fn()
    }
    const request = transport.request(url, {
      method,
      headers: {
        Accept: 'text/html, application/xhtml+xml',
        Connection: 'close',
      },
      ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    }, response => {
      const statusCode = response.statusCode ?? 0
      const contentTypeHeader = response.headers['content-type']
      const contentType = Array.isArray(contentTypeHeader) ? (contentTypeHeader[0] ?? '') : (contentTypeHeader ?? '')
      const locationHeader = response.headers.location
      const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader

      if (method === 'HEAD') {
        response.resume()
        finish(() => resolve({ statusCode, contentType, location, body: '', url }))
        return
      }

      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer | string) => {
        if (settled) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const remaining = MAX_BODY_BYTES - bytes
        if (remaining > 0) {
          const slice = buffer.subarray(0, remaining)
          chunks.push(slice)
          bytes += slice.length
        }
        if (bytes >= MAX_BODY_BYTES) {
          const body = Buffer.concat(chunks, bytes).toString('utf8')
          finish(() => resolve({ statusCode, contentType, location, body, url }))
          response.destroy()
        }
      })
      response.on('end', () => {
        const body = Buffer.concat(chunks, bytes).toString('utf8')
        finish(() => resolve({ statusCode, contentType, location, body, url }))
      })
      response.on('error', error => finish(() => reject(error)))
    })

    const abort = (): void => {
      finish(() => reject(new Error('probe_aborted')))
      request.destroy()
    }
    signal.addEventListener('abort', abort, { once: true })
    request.setTimeout(Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())), () => {
      finish(() => reject(new Error('probe_timeout')))
      request.destroy()
    })
    request.on('error', error => finish(() => reject(error)))
    request.end()
  })
}

function isLoopbackUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  return host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

async function requestWithRedirect(url: URL, method: 'HEAD' | 'GET', deadline: number, signal: AbortSignal): Promise<ProbeResponse> {
  const response = await requestOnce(url, method, deadline, signal)
  if (response.statusCode < 300 || response.statusCode >= 400 || !response.location) return response
  let redirected: URL
  try {
    redirected = new URL(response.location, url)
  } catch {
    return response
  }
  if (redirected.origin !== url.origin || !isLoopbackUrl(redirected)) return response
  return requestOnce(redirected, method, deadline, signal)
}

async function probeScheme(candidate: ListenerCandidate, protocol: 'http:' | 'https:', deadline: number, signal: AbortSignal): Promise<DevServerInfo | null | undefined> {
  const host = candidate.family === 6 ? '[::1]' : '127.0.0.1'
  const root = new URL(`${protocol}//${host}:${candidate.port}/`)
  let head: ProbeResponse
  try {
    head = await requestWithRedirect(root, 'HEAD', deadline, signal)
  } catch {
    return undefined
  }
  if (head.statusCode >= 300 && head.statusCode < 400 && head.location) return null

  const headSaysHtml = isUsableStatus(head.statusCode) && isHtmlContentType(head.contentType)
  const shouldGet = headSaysHtml || head.statusCode === 405 || head.statusCode === 501 || isGenericContentType(head.contentType)
  if (!shouldGet) return null

  let get: ProbeResponse
  try {
    get = await requestWithRedirect(root, 'GET', deadline, signal)
  } catch {
    return null
  }
  if (get.statusCode >= 300 && get.statusCode < 400 && get.location) return null
  if (!isUsableStatus(get.statusCode)) return null
  const isHtml = isHtmlContentType(get.contentType) || (isGenericContentType(get.contentType) && hasHtmlPrefix(get.body))
  if (!isHtml) return null
  return { title: extractTitle(get.body), address: root.origin }
}

export async function probeListener(candidate: ListenerCandidate, deadline: number, signal: AbortSignal): Promise<DevServerInfo | null> {
  const httpResult = await probeScheme(candidate, 'http:', deadline, signal)
  if (httpResult !== undefined) return httpResult
  if (signal.aborted || Date.now() >= deadline) return null
  const httpsResult = await probeScheme(candidate, 'https:', deadline, signal)
  return httpsResult ?? null
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item)
    }
  })
  await Promise.all(workers)
  return results
}

function portOf(address: string): number {
  try {
    const url = new URL(address)
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

export async function scanDevServers(options: ScanOptions = {}): Promise<DevServerDiscoveryResult> {
  const now = options.now ?? Date.now
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    return { servers: [], scannedAt: now(), error: 'unsupported_platform' }
  }

  const startedAt = now()
  const deadline = startedAt + SCAN_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS)
  timer.unref?.()
  let candidateCount = 0

  try {
    const enumeration = await (options.enumerate ?? enumerateDarwinListeners)(controller.signal)
    candidateCount = enumeration.candidates.length
    if (controller.signal.aborted || now() >= deadline) {
      return { servers: [], scannedAt: now(), truncated: enumeration.truncated || undefined, error: 'scan_timeout' }
    }

    const proxyPort = options.proxyPort ?? isPreviewProxyPort
    const candidates = enumeration.candidates.filter(candidate => !proxyPort(candidate.port)).slice(0, MAX_CANDIDATES)
    const probe = options.probe ?? probeListener
    const probed = await mapWithConcurrency(candidates, PROBE_CONCURRENCY, candidate => probe(candidate, deadline, controller.signal))
    if (controller.signal.aborted || now() >= deadline) {
      return { servers: [], scannedAt: now(), truncated: enumeration.truncated || undefined, error: 'scan_timeout' }
    }

    // A dual-stack listener is one user-facing server. Prefer IPv4 only when its
    // probe actually succeeded; otherwise preserve the verified IPv6 origin.
    const byPort = new Map<number, { server: DevServerInfo; family: 4 | 6 }>()
    for (let i = 0; i < candidates.length; i++) {
      const server = probed[i]
      const candidate = candidates[i]
      if (!server || !candidate) continue
      const existing = byPort.get(candidate.port)
      if (!existing || (candidate.family === 4 && existing.family === 6)) {
        byPort.set(candidate.port, { server, family: candidate.family })
      }
    }
    const allServers = [...byPort.values()].map(value => value.server)
      .sort((a, b) => portOf(a.address) - portOf(b.address) || a.title.localeCompare(b.title))
    const truncated = enumeration.truncated || allServers.length > MAX_RESULTS
    const servers = allServers.slice(0, MAX_RESULTS)
    const scannedAt = now()
    console.log(JSON.stringify({
      ts: scannedAt,
      level: 'info',
      event: 'dev_servers.scan',
      durationMs: scannedAt - startedAt,
      candidateCount,
      resultCount: servers.length,
      truncated,
    }))
    return { servers, scannedAt, truncated: truncated || undefined }
  } catch {
    const scannedAt = now()
    const error: DevServerDiscoveryError = controller.signal.aborted || scannedAt >= deadline ? 'scan_timeout' : 'enumeration_failed'
    console.warn(JSON.stringify({
      ts: scannedAt,
      level: 'warn',
      event: 'dev_servers.scan_failed',
      durationMs: scannedAt - startedAt,
      candidateCount,
      error,
    }))
    return { servers: [], scannedAt, error }
  } finally {
    clearTimeout(timer)
  }
}

/** Cached on-demand entry point used by the WS handler. No background scan is
 * scheduled; concurrent focus requests share the same promise. */
export function discoverDevServers(): Promise<DevServerDiscoveryResult> {
  const now = Date.now()
  if (cached && now - cached.storedAt < CACHE_TTL_MS) return Promise.resolve(cached.value)
  if (inFlight) return inFlight

  inFlight = scanDevServers()
    .then(result => {
      if (!result.error) cached = { value: result, storedAt: Date.now() }
      return result
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

export function resetDevServerDiscoveryCacheForTests(): void {
  cached = null
  inFlight = null
}
