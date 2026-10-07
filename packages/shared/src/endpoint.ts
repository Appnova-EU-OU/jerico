/**
 * The daemon endpoint contract — one definition, used by the writer and the
 * reader (#571).
 *
 * `bridge-agent auth` has always validated the endpoint it writes into
 * settings.json. The daemon read that field back without checking anything, so
 * a settings file edited by anything other than `auth` — a script, a stale
 * hand-rolled dev config, a typo — could make the daemon deliver a live bearer
 * token in cleartext to a host nobody chose, on every reconnect, silently.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT
 *
 * It is not anti-attacker hardening. #572 measured that the token is readable
 * and overwritable from a plain shell with no prompt: a process running as the
 * user is INSIDE the trust boundary, and nothing here changes that. `wss:` to
 * an arbitrary host is accepted on purpose — refusing it would be a claim this
 * layer cannot honour.
 *
 * What it does buy: the writer and the reader now agree on what a valid
 * endpoint is, an accident or a misconfiguration is caught instead of acted
 * on, and the failure has a name instead of being a silent handshake error.
 *
 * THE CONTRACT
 *   · parseable as a URL
 *   · path is exactly `/ws/daemon`
 *   · no embedded credentials, no query, no fragment
 *   · `wss:` to any host
 *   · `ws:` only to a loopback host (localhost, 127.0.0.1, ::1) — the dev case
 */

/** Why an endpoint was refused. Stable strings: they reach a flag file on disk
 *  and the daemon's /health, and the desktop reads both. */
export type EndpointRejectionCode =
  | 'empty'
  | 'unparseable'
  | 'scheme'
  | 'credentials'
  | 'query'
  | 'fragment'
  | 'path'
  | 'plaintext_remote'

export interface EndpointRejection {
  code: EndpointRejectionCode
  /** One sentence, safe to log and to show. Never contains the credentials it
   *  is complaining about. */
  reason: string
  /** The offending value with any userinfo removed, for diagnostics. */
  serverRedacted: string
}

export type EndpointValidation =
  | { ok: true; url: string }
  | ({ ok: false } & EndpointRejection)

export const DAEMON_ENDPOINT_PATH = '/ws/daemon'

/** Loopback by name or literal, brackets tolerated so `[::1]` matches. */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

/** Strip `user:password@` so a rejection can name the value without repeating
 *  the secret that made it invalid. Falls back to the scheme and host when the
 *  value will not parse at all. */
export function redactEndpoint(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    // Unparseable: keep it short and drop anything that looks like userinfo.
    return raw.replace(/\/\/[^/@\s]*@/, '//').slice(0, 200)
  }
}

function reject(code: EndpointRejectionCode, reason: string, raw: unknown): EndpointValidation {
  return { ok: false, code, reason, serverRedacted: redactEndpoint(raw) }
}

/**
 * Judge a configured daemon endpoint. Returns the normalized URL when it holds
 * to the contract, and a named, quotable reason when it does not.
 */
export function validateDaemonEndpoint(raw: unknown): EndpointValidation {
  if (typeof raw !== 'string' || !raw.trim()) {
    return reject('empty', 'the daemon endpoint is missing — settings.json has no "server" value', raw)
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return reject('unparseable', 'the daemon endpoint is not a valid URL', raw)
  }
  if (url.username || url.password) {
    return reject('credentials', 'the daemon endpoint must not carry embedded credentials', raw)
  }
  if (url.search) {
    return reject('query', 'the daemon endpoint must not carry a query string', raw)
  }
  if (url.hash) {
    return reject('fragment', 'the daemon endpoint must not carry a fragment', raw)
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    return reject('scheme', 'the daemon endpoint must use wss (or ws on a loopback host)', raw)
  }
  if (url.pathname !== DAEMON_ENDPOINT_PATH) {
    return reject('path', `the daemon endpoint must end at ${DAEMON_ENDPOINT_PATH}`, raw)
  }
  if (url.protocol === 'ws:' && !isLoopbackHost(url.hostname)) {
    return reject(
      'plaintext_remote',
      'a plaintext ws daemon endpoint is allowed only on a loopback host — '
      + 'this one would send the daemon token unencrypted to another machine',
      raw,
    )
  }
  return { ok: true, url: url.toString() }
}

/** The same judgement, for callers that would rather have an exception —
 *  `auth` refuses to write a value this throws on. */
export function assertDaemonEndpoint(raw: unknown): string {
  const result = validateDaemonEndpoint(raw)
  if (!result.ok) throw new Error(result.reason)
  return result.url
}

/** One line for a log or a tray sub-line: the reason, then the value it judged. */
export function describeEndpointRejection(rejection: EndpointRejection): string {
  return rejection.serverRedacted
    ? `${rejection.reason} (${rejection.serverRedacted})`
    : rejection.reason
}
