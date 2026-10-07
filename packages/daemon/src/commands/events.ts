/**
 * `bridge-agent events --follow`.
 *
 * The process an orchestrator runs so notices reach it WITHOUT anything being
 * written to its PTY stdin. Composition of those notices stays on the jerico
 * server; this is only the last hop.
 *
 * ── How this must be launched ──────────────────────────────────────────────
 * Under a watcher that surfaces EACH STDOUT LINE as its own event. Not as a
 * plain background command.
 *
 * This is a contract, not a preference. A live four-harness test found that a
 * background command notifies once, on process EXIT — and `--follow` never
 * exits, so launched that way an orchestrator wakes NEVER, silently, which is
 * the exact failure this design removes.
 *
 * Every line printed here costs the reader a turn, so heartbeats and empty polls
 * print nothing at all.
 */

import { loadDescriptor, loadIdentity, loadEventToken, EventsTransport } from '../events/client.js'
import { runSubscriber, EXIT, type ExitCode } from '../events/subscriber.js'
import { DESCRIPTOR_ENV_VAR } from '../hooks/protocol.js'
import { DEFAULT_POLL_WAIT_MS } from '../events/poller.js'

export interface EventsOptions {
  follow?: boolean
  waitMs?: string
  /** Injected for tests; defaults to process/stdout/fetch. */
  env?: Record<string, string | undefined>
  write?: (line: string) => void | Promise<void>
  writeErr?: (line: string) => void
  fetchImpl?: ConstructorParameters<typeof EventsTransport>[0]['fetchImpl']
  sleep?: (ms: number) => Promise<void>
  /** Stops the loop; tests use it, the real run never sets it. */
  shouldStop?: () => boolean
}

export interface EventsResult {
  exit: ExitCode
  reason?: string
}

/**
 * Diagnostics go to STDERR, never stdout: stdout is the notification channel and
 * a diagnostic there would wake the model to tell it nothing happened. They also
 * never carry the token, a descriptor, an event payload or a completion id.
 */
export async function runEvents(options: EventsOptions = {}): Promise<EventsResult> {
  const env      = options.env ?? (process.env as Record<string, string | undefined>)
  const writeErr = options.writeErr ?? ((line: string) => process.stderr.write(line + '\n'))
  const write    = options.write ?? ((line: string) => new Promise<void>((resolve, reject) => {
    process.stdout.write(line + '\n', (err) => err ? reject(err) : resolve())
  }))

  if (options.follow !== true) {
    writeErr('[bridge] events requires --follow (a one-shot read is not a supported mode)')
    return { exit: EXIT.usage_or_identity, reason: 'follow_required' }
  }

  const identity = loadIdentity(env)
  if (!identity) {
    writeErr(`[bridge] events: no panel identity. Expected BRIDGE_PANEL_ID and BRIDGE_PANEL_INSTANCE_ID.`)
    return { exit: EXIT.usage_or_identity, reason: 'identity_missing' }
  }

  const descriptorPath = env[DESCRIPTOR_ENV_VAR]
  const loaded = loadDescriptor(descriptorPath)
  if (!loaded.ok) {
    writeErr(`[bridge] events: ${loaded.reason}`)
    return { exit: loaded.exit, reason: loaded.reason }
  }

  const waitMs = (() => {
    const n = Number.parseInt(options.waitMs ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_POLL_WAIT_MS
  })()

  const eventToken = loadEventToken(env)

  const transport = new EventsTransport({
    descriptor: loaded.descriptor,
    identity,
    waitMs,
    fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<NonNullable<EventsOptions['fetchImpl']>>),
    sleep: options.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms))),
    log: (event, detail) => writeErr(`[bridge] ${event}${detail ? ' ' + JSON.stringify(detail) : ''}`),
    eventToken,
  })

  const result = await runSubscriber({
    poll: () => transport.poll(),
    ack:  (seq) => transport.ack(seq),
    write,
    log: (event, detail) => writeErr(`[bridge] ${event}${detail ? ' ' + JSON.stringify(detail) : ''}`),
    // A server refusal retrying cannot fix ends the loop; everything else keeps
    // it alive, because exiting is what costs liveness.
    shouldStop: () => options.shouldStop?.() === true || transport.terminalExit() !== null,
  })

  const terminal = transport.terminalExit()
  if (terminal !== null) {
    writeErr(`[bridge] events: stream ended, exit=${terminal}`)
    return { exit: terminal, reason: 'server_refused' }
  }
  return { exit: result.exit }
}
