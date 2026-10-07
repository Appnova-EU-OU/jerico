/**
 * Transport for `bridge-agent events --follow` (#616, slice 2).
 *
 * Discovery reuses jerico's existing hook descriptor rather than inventing a
 * second one. `hooks/endpoint.ts` already writes it atomically (temp file,
 * 0o600, rename) with protocol, version, url, token and daemon pid, and the
 * hook installer already exports its path as BRIDGE_HOOK_DESCRIPTOR. Orca solves
 * the same problem with an `endpoint.env` key/value file; adopting that shape
 * here would break the installer to gain nothing.
 *
 * Kept separate from the subscriber loop so the loop stays testable without a
 * socket, and this stays testable without a subprocess.
 */

import { readFileSync, statSync } from 'node:fs'
import {
  HOOK_PROTOCOL,
  EVENTS_PROTOCOL_VERSION,
  HEADER_TOKEN,
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_VERSION,
  HEADER_AGENT_ID,
  HEADER_INSTANCE_ID,
  HEADER_EVENT_TOKEN,
  EVENT_TOKEN_ENV_VAR,
} from '../hooks/protocol.js'
import { EVENTS_ROUTE_PATH, EVENTS_ACK_PATH } from './route.js'
import { EXIT, type ExitCode } from './subscriber.js'
import type { PollResult } from './poller.js'

export interface Descriptor {
  /** Exactly what the daemon wrote: the full hook route, not a base. */
  url: string
  /** Scheme + host + port, which is what every other route hangs off. */
  origin: string
  token: string
}

export type DescriptorResult =
  | { ok: true; descriptor: Descriptor }
  | { ok: false; exit: ExitCode; reason: string }

/**
 * Read and validate the descriptor.
 *
 * Refusals are deliberately specific: an operator debugging a silent stream
 * needs to know whether the file was missing, unreadable, wrongly permissioned,
 * or simply from a different protocol generation.
 */
export function loadDescriptor(path: string | undefined): DescriptorResult {
  if (!path || path.trim() === '') {
    return { ok: false, exit: EXIT.usage_or_identity, reason: 'descriptor_path_missing' }
  }

  let raw: string
  try {
    const st = statSync(path)
    // A descriptor readable by other users is a token leak, and the daemon
    // writes it 0o600 — so anything wider means something rewrote it.
    if ((st.mode & 0o077) !== 0) {
      return { ok: false, exit: EXIT.unsafe_descriptor, reason: 'descriptor_permissions_too_open' }
    }
    raw = readFileSync(path, 'utf-8')
  } catch {
    return { ok: false, exit: EXIT.unsafe_descriptor, reason: 'descriptor_unreadable' }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { ok: false, exit: EXIT.unsafe_descriptor, reason: 'descriptor_malformed' }
  }

  if (parsed['protocol'] !== HOOK_PROTOCOL || parsed['protocolVersion'] !== EVENTS_PROTOCOL_VERSION) {
    return { ok: false, exit: EXIT.protocol_mismatch, reason: 'descriptor_protocol_mismatch' }
  }

  const url   = parsed['url']
  const token = parsed['hookToken']
  if (typeof url !== 'string' || typeof token !== 'string' || token === '') {
    return { ok: false, exit: EXIT.unsafe_descriptor, reason: 'descriptor_incomplete' }
  }

  // Loopback only. A descriptor naming a remote host would send the daemon's
  // shared secret off the machine, so it is refused rather than followed.
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return { ok: false, exit: EXIT.unsafe_descriptor, reason: 'descriptor_url_malformed' }
  }
  // `new URL('http://[::1]:3101').hostname` yields '[::1]' WITH brackets, so a
  // bare '::1' comparison never matches and the IPv6 branch was dead. Strip them.
  const bare = host.replace(/^\[|\]$/g, '')
  if (bare !== '127.0.0.1' && bare !== 'localhost' && bare !== '::1') {
    return { ok: false, exit: EXIT.unsafe_descriptor, reason: 'descriptor_url_not_loopback' }
  }

  // The descriptor's `url` is the full HOOK route
  // (`start.ts:1958` writes `http://127.0.0.1:<port>${HOOK_EVENT_PATH}`), not a
  // base. Treating it as one appends the events path onto the hook path and
  // produces a URL that does not exist — the CLI would 404 forever, silently,
  // which is this repo's most repeated defect class. Keep the origin instead.
  return { ok: true, descriptor: { url, origin: new URL(url).origin, token } }
}

export interface Identity {
  agentId: string
  instanceId: number
}

export function loadIdentity(env: Record<string, string | undefined>): Identity | null {
  const agentId = env['BRIDGE_PANEL_ID']
  const instRaw = env['BRIDGE_PANEL_INSTANCE_ID']
  if (!agentId || agentId.trim() === '' || !instRaw) return null
  // Same canonical-decimal rule the surface enforces, so the client cannot send
  // a value the server will refuse and then puzzle over a 422.
  if (!/^[1-9][0-9]*$/.test(instRaw)) return null
  const instanceId = Number.parseInt(instRaw, 10)
  if (!Number.isSafeInteger(instanceId) || instanceId <= 0) return null
  return { agentId, instanceId }
}

export function loadEventToken(env: Record<string, string | undefined>): string | undefined {
  const t = env[EVENT_TOKEN_ENV_VAR]
  return t && t.trim() !== '' ? t : undefined
}

export function eventHeaders(descriptor: Descriptor, identity: Identity, eventToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    [HEADER_TOKEN]: descriptor.token,
    [HEADER_PROTOCOL]: HOOK_PROTOCOL,
    [HEADER_PROTOCOL_VERSION]: String(EVENTS_PROTOCOL_VERSION),
    [HEADER_AGENT_ID]: identity.agentId,
    [HEADER_INSTANCE_ID]: String(identity.instanceId),
  }
  if (eventToken) h[HEADER_EVENT_TOKEN] = eventToken
  return h
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number
  json: () => Promise<unknown>
}>

export interface TransportOptions {
  descriptor: Descriptor
  identity: Identity
  waitMs: number
  fetchImpl: FetchLike
  /** Backoff for a transient failure, injected so tests do not wait. */
  sleep: (ms: number) => Promise<void>
  log?: (event: string, detail?: Record<string, unknown>) => void
  /** Per-panel event token for Fix 2 — bound to generation. */
  eventToken?: string
}

/** Backoff for transient local failures. Capped, and never terminal: exiting is
 *  what costs liveness, so the client keeps trying rather than giving up. */
export const BACKOFF_MS = [250, 1_000, 2_000, 5_000, 15_000, 30_000] as const

export class EventsTransport {
  private consecutiveFailures = 0
  /** Set when the server answers with a condition retrying cannot fix. */
  private terminal: ExitCode | null = null

  constructor(private readonly opts: TransportOptions) {}

  terminalExit(): ExitCode | null {
    return this.terminal
  }

  /**
   * One long-poll round trip.
   *
   * A refusal the server considers permanent — bad token, protocol skew, dead
   * panel — is recorded as terminal so the caller stops rather than hammering a
   * door that will not open. Anything else backs off and returns idle, because a
   * transport hiccup must not end the stream.
   */
  async poll(): Promise<PollResult> {
    const url = `${this.opts.descriptor.origin}${EVENTS_ROUTE_PATH}?waitMs=${this.opts.waitMs}`
    const log = this.opts.log ?? (() => {})

    let status: number
    let body: unknown
    try {
      const res = await this.opts.fetchImpl(url, {
        method: 'POST',
        headers: eventHeaders(this.opts.descriptor, this.opts.identity, this.opts.eventToken),
      })
      status = res.status
      body = status === 200 ? await res.json() : null
    } catch (error) {
      await this.backoff()
      log('transport.poll_failed', { error: String(error), consecutiveFailures: this.consecutiveFailures })
      return { records: [], throughSeq: null, idle: true }
    }

    if (status === 403) { this.terminal = EXIT.auth_invariant;      log('transport.refused', { status }) }
    else if (status === 422) { this.terminal = EXIT.protocol_mismatch; log('transport.refused', { status }) }
    else if (status === 409) { this.terminal = EXIT.panel_gone;        log('transport.refused', { status }) }
    else if (status !== 200) {
      // An unexpected status is transient until proven otherwise.
      await this.backoff()
      log('transport.unexpected_status', { status })
      return { records: [], throughSeq: null, idle: true }
    }

    if (this.terminal !== null) return { records: [], throughSeq: null, idle: true }

    this.consecutiveFailures = 0
    const result = body as PollResult | null
    if (!result || !Array.isArray(result.records)) {
      log('transport.bad_body')
      return { records: [], throughSeq: null, idle: true }
    }
    return result
  }

  /** Acknowledge. A failed ack is not terminal: the records are re-delivered and
   *  re-acknowledged, which costs a duplicate rather than a loss. */
  async ack(throughSeq: number): Promise<void> {
    const url = `${this.opts.descriptor.origin}${EVENTS_ACK_PATH}?through=${throughSeq}`
    try {
      await this.opts.fetchImpl(url, {
        method: 'POST',
        headers: eventHeaders(this.opts.descriptor, this.opts.identity, this.opts.eventToken),
      })
    } catch (error) {
      (this.opts.log ?? (() => {}))('transport.ack_failed', { error: String(error), throughSeq })
    }
  }

  private async backoff(): Promise<void> {
    const idx = Math.min(this.consecutiveFailures, BACKOFF_MS.length - 1)
    this.consecutiveFailures++
    await this.opts.sleep(BACKOFF_MS[idx]!)
  }
}
