import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createProxyMiddleware, responseInterceptor, type RequestHandler } from 'http-proxy-middleware'
import type { IncomingMessage, ServerResponse } from 'node:http'

// ─────────────────────────────────────────────────────────────────────────────
// Snippet-free injecting proxy (jerico-design item 1, #538)
//
// A per-pane loopback HTTP(+WS) listener on 127.0.0.1:<OS-ephemeral-port>. It
// proxies a dev-server URL, auto-injects `jerico-inspect.js` into HTML, strips
// CSP (header + <meta>), rewrites Set-Cookie (Secure/Domain) for http loopback,
// and tunnels HMR websockets. ONE dedicated ephemeral port per preview session
// is the session boundary (no path-token — Vite/webpack request root-relative
// assets, so a token-in-path breaks them). Loopback-bound; NOT Jerico's origin.
// ─────────────────────────────────────────────────────────────────────────────

const INSPECT_SCRIPT_TAG = '<script src="/__jerico/inspect.js"></script>'
const MAX_CONCURRENT_PROXIES = 16

/**
 * Resolve the inspect-runtime JS source.
 *
 * Preferred: `globalThis.__JERICO_INSPECT_RUNTIME__` is INLINED into the bundle
 * at build time (scripts/build.mjs reads packages/inspect-runtime/dist/
 * jerico-inspect.js and injects it via esbuild `define`). This survives the
 * single-file CJS build AND the pkg-binary distribution — no runtime path
 * resolution, and no `import.meta.url` (undefined in CJS/pkg).
 *
 * Fallback: if the global is absent (e.g. running raw `tsc` output that wasn't
 * run through the esbuild define), read the file at runtime. Uses CJS __dirname
 * (available in the bundle) with candidate locations and a pkg-binary fallback
 * (process.execPath-based). Returns '' if unavailable (proxy logs + serves 500).
 */
function loadInspectRuntime(): string {
  const inlined = (globalThis as { __JERICO_INSPECT_RUNTIME__?: string }).__JERICO_INSPECT_RUNTIME__
  if (inlined && inlined.length > 0) return inlined

  // CJS __dirname is available in the bundled daemon (dist/index.js).
  const cwd = typeof __dirname !== 'undefined' ? __dirname : path.dirname(process.execPath)
  const candidates = [
    path.resolve(cwd, '..', '..', 'inspect-runtime', 'dist', 'jerico-inspect.js'),
    path.resolve(cwd, '..', 'inspect-runtime', 'dist', 'jerico-inspect.js'),
    path.resolve(cwd, 'inspect-runtime', 'dist', 'jerico-inspect.js'),
    path.resolve(process.cwd(), 'packages', 'inspect-runtime', 'dist', 'jerico-inspect.js'),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf-8')
    } catch { /* try next */ }
  }
  return ''
}

let INSPECT_RUNTIME_JS: string | null = null
function getInspectRuntime(): string {
  if (INSPECT_RUNTIME_JS === null) INSPECT_RUNTIME_JS = loadInspectRuntime()
  return INSPECT_RUNTIME_JS
}

interface ActiveProxy {
  server: http.Server
  port: number
  devUrl: string
  targetHost: string
  middleware: RequestHandler
}

// paneId → active proxy. The browser drives lifecycle via preview_proxy_start /
// preview_proxy_stop; we also tear down on pane-close / daemon-disconnect.
const activeProxies = new Map<string, ActiveProxy>()

/**
 * Normalize a host to a canonical loopback/origin form so aliases that resolve
 * to the same machine cannot bypass the self-origin check:
 *   - [::1] / ::1      → 127.0.0.1
 *   - localhost        → 127.0.0.1
 *   - 0.0.0.0          → 127.0.0.1
 *   - 127.x / 127.0.0.1→ 127.0.0.1
 * Returns the normalized host (lowercased), or the original host if it doesn't
 * match a known loopback alias.
 */
function normalizeLoopbackHost(host: string): string {
  const h = host.toLowerCase()
  if (h === 'localhost') return '127.0.0.1'
  if (h === '[::1]' || h === '::1') return '127.0.0.1'
  if (h === '0.0.0.0') return '127.0.0.1'
  if (h === '127.0.0.1' || h.startsWith('127.')) return '127.0.0.1'
  return h
}

/**
 * SINGLE robust self-origin check (used for BOTH the initial target URL AND any
 * redirect Location). A target must be refused if its normalized origin equals
 * any denied origin's normalized origin. This closes the IPv6/host-literal alias
 * bypass ([::1], 0.0.0.0, localhost vs hostname all resolve to loopback/Jerico)
 * and the redirect-Location bypass.
 */
function isSelfOriginNormalized(targetUrl: string, denyOrigins: string[]): boolean {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return false
  }
  const targetOrigin = `${normalizeLoopbackHost(target.hostname)}:${target.port || (target.protocol === 'https:' ? 443 : 80)}`
  return denyOrigins.some(deny => {
    try {
      const d = new URL(deny)
      const denyOrigin = `${normalizeLoopbackHost(d.hostname)}:${d.port || (d.protocol === 'https:' ? 443 : 80)}`
      return denyOrigin === targetOrigin
    } catch {
      return false
    }
  })
}

/** Hand-rolled Set-Cookie rewrite (HPM@4 has NO cookieDomainRewrite): drop
 *  Secure, rewrite Domain→127.0.0.1 so login-gated apps stay logged-in over
 *  the http loopback (browsers refuse Secure cookies on http://127.0.0.1). */
function rewriteSetCookie(cookie: string): string {
  const [core, ...attrs] = cookie.split(';').map(s => s.trim())
  const out = [core]
  for (const attr of attrs) {
    const lower = attr.toLowerCase()
    if (lower === 'secure') continue
    if (lower.startsWith('domain=')) {
      out.push('Domain=127.0.0.1')
      continue
    }
    out.push(attr)
  }
  return out.join('; ')
}

/**
 * Inject the inspect script before </head>; fall back to before </body>, then
 * prepend. Also strip <meta http-equiv="Content-Security-Policy"> (header strip
 * alone leaves a meta CSP that blocks the injected script) and any <base href>
 * (a base href would make the injected /__jerico/inspect.js resolve relative to
 * the upstream origin, not the proxy). Both regexes are attribute-order- and
 * case-insensitive so `<meta content="…" http-equiv="…">` and
 * `<BASE HREF="…">` are caught too.
 */
function injectIntoHtml(html: string): string {
  let out = html.replace(
    /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,
    '',
  )
  out = out.replace(/<base\b[^>]*\bhref\s*=\s*["'][^"']*["'][^>]*>/gi, '')
  if (out.includes('</head>')) {
    return out.replace('</head>', `${INSPECT_SCRIPT_TAG}\n</head>`)
  }
  if (out.includes('</body>')) {
    return out.replace('</body>', `${INSPECT_SCRIPT_TAG}\n</body>`)
  }
  return INSPECT_SCRIPT_TAG + out
}

/** Decompress (if needed), inject/rewrite, recompress to match inbound. */
function transformBody(
  buf: Buffer,
  proxyRes: IncomingMessage,
  req: IncomingMessage,
): Buffer {
  const contentType = String(proxyRes.headers['content-type'] ?? '').toLowerCase()
  // UNVERIFIED (agy2): gzip/br-encoded HTML — responseInterceptor auto-decompresses
  // into the buffer we receive, but the RE-compress branch (to match an inbound
  // `content-encoding`) is NOT yet exercised against a compressed dev server.
  if (!contentType.includes('text/html')) return buf
  const reqPath = req.url ? req.url.split('?')[0] : ''
  if (reqPath === '/__jerico/inspect.js') return buf
  try {
    const decoded = buf.toString('utf-8')
    return Buffer.from(injectIntoHtml(decoded), 'utf-8')
  } catch {
    return buf
  }
}

export interface StartPreviewProxyResult {
  ok: boolean
  proxyUrl?: string
  error?: string
}

/**
 * Start (or replace) a preview-injecting proxy for `paneId`.
 *
 * @param devUrl     Upstream dev-server URL (e.g. http://127.0.0.1:5173).
 * @param denyOrigins Origins the proxy must REFUSE to proxy (Jerico's own).
 * @returns proxy URL on 127.0.0.1:<ephemeral-port>, or an error.
 */
export function startPreviewProxy(
  paneId: string,
  devUrl: string,
  denyOrigins: string[] = [],
): Promise<StartPreviewProxyResult> {
  if (activeProxies.has(paneId)) {
    stopPreviewProxy(paneId)
  }
  if (activeProxies.size >= MAX_CONCURRENT_PROXIES) {
    return Promise.resolve({ ok: false, error: 'concurrent-proxy-limit-reached' })
  }
  if (isSelfOriginNormalized(devUrl, denyOrigins)) {
    return Promise.resolve({ ok: false, error: 'refused-self-origin' })
  }

  let parsed: URL
  try {
    parsed = new URL(devUrl)
  } catch {
    return Promise.resolve({ ok: false, error: 'invalid-dev-url' })
  }
  // Force an explicit non-`localhost` host so the proxy targets 127.0.0.1,
  // avoiding the wrong-app collision agy2 reproduced with bare `localhost`.
  const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname
  const targetHost = `${host}:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}`
  const target = `${parsed.protocol}//${targetHost}`

  // Normalized self-origin guard reused for the initial target AND redirects.
  const refuseSelfOrigin = (url: string): boolean => isSelfOriginNormalized(url, denyOrigins)

  const middleware = createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: true,
    secure: false,
    // UNVERIFIED (consensus): https upstream with self-signed certs needs
    // `secure:false` — set above; full TLS-upstream test matrix still TODO.
    selfHandleResponse: true,
    on: {
      // Force identity encoding so the interceptor never receives br/gzip it
      // would have to decompress (P0/P1 — eliminates the encoding-mismatch class;
      // the gzip branch stays as belt-and-suspenders).
      proxyReq: (proxyReq) => {
        proxyReq.setHeader('accept-encoding', 'identity')
      },
      proxyRes: responseInterceptor((buf, proxyRes, req, res) => {
        // responseInterceptor finalizes the response AFTER this callback returns
        // (it calls res.removeHeader/setHeader/write/end itself). We must therefore
        // only set res.statusCode + staged headers and RETURN the body buffer — never
        // call res.end()/write() here, or headers flush early → ERR_HTTP_HEADERS_SENT
        // (an unhandled rejection that can crash the daemon). Caught by re-smoke.
        const sres = res as ServerResponse
        // Serve the built inspect runtime from the proxy itself (same-origin).
        // Match by pathname so ?t=… cache-busting query strings don't break it.
        const reqPath = req.url ? req.url.split('?')[0] : ''
        if (reqPath === '/__jerico/inspect.js') {
          const body = Buffer.from(getInspectRuntime(), 'utf-8')
          if (body.length === 0) {
            sres.statusCode = 500
            sres.setHeader('content-type', 'text/plain')
            return Promise.resolve(Buffer.from('inspect runtime unavailable'))
          }
          sres.statusCode = 200
          sres.setHeader('content-type', 'application/javascript')
          return Promise.resolve(body)
        }

        // Redirect guard: a Location pointing at a denied (Jerico) origin must
        // be refused — the iframe runs allow-same-origin, so a proxied Jerico
        // page = session theft. Validate against the SAME normalized denylist.
        const status = proxyRes.statusCode ?? 0
        if (status >= 300 && status < 400) {
          const location = proxyRes.headers['location']
          if (typeof location === 'string' && refuseSelfOrigin(location)) {
            sres.statusCode = 403
            sres.removeHeader('location')
            sres.setHeader('content-type', 'text/plain')
            return Promise.resolve(Buffer.from('preview proxy refused redirect to a blocked origin'))
          }
        }

        const ct = String(proxyRes.headers['content-type'] ?? '').toLowerCase()
        const isHtml = ct.includes('text/html')

        // Strip CSP + frame-ancestors headers + X-Frame-Options.
        delete proxyRes.headers['content-security-policy']
        delete proxyRes.headers['content-security-policy-report-only']
        delete proxyRes.headers['x-frame-options']

        // Hand-rolled Set-Cookie rewrite (Secure drop, Domain→127.0.0.1).
        const cookies = proxyRes.headers['set-cookie']
        if (Array.isArray(cookies) && cookies.length > 0) {
          proxyRes.headers['set-cookie'] = cookies.map(rewriteSetCookie)
        }

        if (!isHtml) {
          return Promise.resolve(buf)
        }

        const transformed = transformBody(buf, proxyRes, req)
        // Drop content-length — body changed; let the server recompute.
        delete proxyRes.headers['content-length']
        delete proxyRes.headers['content-encoding']
        return Promise.resolve(transformed)
      }),
    },
  })

  const server = http.createServer((req, res) => {
    const reqPath = req.url ? req.url.split('?')[0] : ''
    if (reqPath === '/__jerico/inspect.js') {
      try {
        const body = Buffer.from(getInspectRuntime(), 'utf-8')
        if (body.length === 0) throw new Error('inspect runtime empty')
        res.setHeader('content-type', 'application/javascript')
        res.setHeader('content-length', String(body.length))
        res.end(body)
        return
      } catch (err) {
        res.statusCode = 500
        res.end('inspect runtime missing')
        console.error('[proxy] inspect.js serve failed', { paneId, error: String(err) })
        return
      }
    }
    middleware(req, res, (err?: unknown) => {
      if (err) {
        res.statusCode = 502
        res.end('preview proxy upstream unavailable')
        console.warn('[proxy] upstream error', { paneId, error: String(err) })
        return
      }
      res.statusCode = 404
      res.end()
    })
  })

  server.on('upgrade', (req, socket, head) => {
    // UNVERIFIED (consensus): dev-server restart → upstream 502 during HMR
    // upgrade. Auto-retry matrix still TODO. ws:true handles the normal path.
    ;(middleware as unknown as { upgrade: (r: IncomingMessage, s: unknown, h: Buffer) => void })
      .upgrade(req, socket, head)
  })

  return new Promise<StartPreviewProxyResult>(resolve => {
    server.on('error', (err) => {
      console.error('[proxy] server error', { paneId, error: String(err) })
      resolve({ ok: false, error: 'proxy-server-error' })
    })
    // OS-ephemeral port: bind to 0, read back the assigned port. NEVER hardcode.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        resolve({ ok: false, error: 'no-ephemeral-port' })
        return
      }
      const port = addr.port
      activeProxies.set(paneId, {
        server,
        port,
        devUrl,
        targetHost,
        middleware,
      })
      // Preserve the dev-URL PATH (+query) in the proxyUrl so the iframe opens the
      // page the user actually asked for (e.g. /quiz-v3.html), not just the dev-server
      // root. The proxy target is origin-only, and HPM forwards the incoming request
      // path verbatim → iframe loading /quiz-v3.html reaches <target>/quiz-v3.html.
      const initialPath = `${parsed.pathname}${parsed.search}`
      console.log('[proxy] started', { paneId, port, target, initialPath })
      resolve({ ok: true, proxyUrl: `http://127.0.0.1:${port}${initialPath}` })
    })
  })
}

/** Stop and fully tear down a pane's proxy (closes server + frees the port). */
export function stopPreviewProxy(paneId: string): boolean {
  const entry = activeProxies.get(paneId)
  if (!entry) return false
  activeProxies.delete(paneId)
  try {
    entry.server.close(() => {})
    entry.server.unref()
  } catch (err) {
    console.warn('[proxy] close error', { paneId, error: String(err) })
  }
  console.log('[proxy] stopped', { paneId, port: entry.port })
  return true
}

/** Tear down EVERY active proxy — called on daemon disconnect / shutdown. */
export function teardownAllPreviewProxies(): void {
  const ids = [...activeProxies.keys()]
  for (const id of ids) stopPreviewProxy(id)
  console.log('[proxy] teardown_all', { count: ids.length })
}

export function activePreviewProxyCount(): number {
  return activeProxies.size
}

/** Narrow discovery seam: Jerico's own HTML proxy listeners must never be
 * returned as local dev servers. Keeping the registry private prevents callers
 * from mutating proxy lifecycle state. */
export function isPreviewProxyPort(port: number): boolean {
  for (const proxy of activeProxies.values()) {
    if (proxy.port === port) return true
  }
  return false
}
