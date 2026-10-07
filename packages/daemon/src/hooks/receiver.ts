import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PtyManager } from '../pty/manager.js'
import type { ServerMessage } from '../shared/types.js'
import {
  HOOK_PROTOCOL_VERSION,
  HOOK_PROTOCOL,
  HEADER_TOKEN,
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_VERSION,
  HEADER_AGENT_ID,
  HEADER_INSTANCE_ID,
  HEADER_EVENT_NAME,
  PROVIDER_EVENT_FIELD,
  PROVIDER_EVENT_TURN_ENDED,
  PROVIDER_EVENT_TURN_FAILED,
  PROVIDER_SESSION_FIELD,
  PROVIDER_CONVERSATION_FIELD,
  PROVIDER_ERROR_FIELD,
  PROVIDER_TERMINATION_FIELD,
  type AgentHookTurnEvent,
} from './protocol.js'
export { HOOK_ROUTE_PATH as HOOK_EVENT_PATH } from './protocol.js'
import { AI_AGENT_KEYS, type AgentKey } from '../shared/types.js'
import type { WebSocket } from 'ws'
export const HOOK_BODY_MAX_BYTES = 16 * 1024
export const HOOK_BODY_TIMEOUT_MS = 5_000

function safeTokenEqual(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  let mismatch = 0
  for (let i = 0; i < actual.length; ++i) {
    mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return mismatch === 0
}

async function readBoundedJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type'] !== 'application/json') {
    throw new Error('415')
  }

  const cl = req.headers['content-length']
  if (cl) {
    const len = parseInt(cl, 10)
    if (isNaN(len) || len > HOOK_BODY_MAX_BYTES) {
      throw new Error('413')
    }
  }

  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks: Buffer[] = []
    
    const timeout = setTimeout(() => {
      req.destroy()
      reject(new Error('408'))
    }, HOOK_BODY_TIMEOUT_MS)

    req.on('data', chunk => {
      bytes += chunk.length
      if (bytes > HOOK_BODY_MAX_BYTES) {
        clearTimeout(timeout)
        req.destroy()
        reject(new Error('413'))
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      clearTimeout(timeout)
      try {
        const body = Buffer.concat(chunks).toString('utf-8')
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('422'))
      }
    })

    req.on('error', () => {
      clearTimeout(timeout)
      reject(new Error('400'))
    })
  })
}

import { HOOK_TARGETS } from './targets.js'

const PROVIDER_SESSION_MAX_LEN = 128

function readSessionId(b: Record<string, unknown>, field: string): string | null {
  const value = b[field]
  if (typeof value !== 'string' || value.length > PROVIDER_SESSION_MAX_LEN) return null
  return value
}

/** agy reports the outcome in its payload rather than in the event name: a
 *  non-empty `error`, or a `terminationReason` that mentions an error, is a
 *  failed turn. Measured on agy 1.1.21 — a clean turn reports
 *  `terminationReason: "NO_TOOL_CALL"`, not the `model_stop` its docs claim, so
 *  nothing here may depend on an exact success string. Providers that send
 *  neither field (claude/kimi/codex) are unaffected. */
function carriesFailure(b: Record<string, unknown>): boolean {
  const error = b[PROVIDER_ERROR_FIELD]
  if (typeof error === 'string' && error.length > 0) return true
  const termination = b[PROVIDER_TERMINATION_FIELD]
  return typeof termination === 'string' && termination.toLowerCase().includes('error')
}

/** `headerEventName` is the fallback for providers whose payload carries no
 *  event-name field (agy). The body always wins when both are present. */
export function normalizeProviderHookEvent(
  body: unknown,
  derivedAgentKey: string,
  headerEventName?: string
): { event: AgentHookTurnEvent; providerSessionId?: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const rawEvent = b[PROVIDER_EVENT_FIELD] !== undefined ? b[PROVIDER_EVENT_FIELD] : headerEventName
  const event = rawEvent === PROVIDER_EVENT_TURN_ENDED
    ? 'turn_ended'
    : rawEvent === PROVIDER_EVENT_TURN_FAILED
      ? 'turn_failed'
      : null
  if (!event) return null

  if (!(HOOK_TARGETS as readonly string[]).includes(derivedAgentKey)) return null

  const out: { event: AgentHookTurnEvent; providerSessionId?: string } = {
    event: event === 'turn_ended' && carriesFailure(b) ? 'turn_failed' : event
  }
  const sessionId = readSessionId(b, PROVIDER_SESSION_FIELD) ?? readSessionId(b, PROVIDER_CONVERSATION_FIELD)
  if (sessionId !== null) out.providerSessionId = sessionId
  return out
}

export async function handleAgentHookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { manager: PtyManager; expectedToken: string; ws: WebSocket | null }
): Promise<void> {
  const token = req.headers[HEADER_TOKEN] as string | undefined
  const protocol = req.headers[HEADER_PROTOCOL] as string | undefined
  const protocolVersion = req.headers[HEADER_PROTOCOL_VERSION] as string | undefined
  const agentId = req.headers[HEADER_AGENT_ID] as string | undefined
  const instanceIdStr = req.headers[HEADER_INSTANCE_ID] as string | undefined

  if (!safeTokenEqual(token, deps.expectedToken)) {
    req.resume()
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid_token' }))
    console.warn('[daemon] hook.receiver.rejected', { reason: 'invalid_token' })
    return
  }

  if (protocol !== HOOK_PROTOCOL || protocolVersion !== String(HOOK_PROTOCOL_VERSION)) {
    req.resume()
    res.writeHead(422, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'protocol_mismatch' }))
    console.warn('[daemon] hook.receiver.rejected', { reason: 'protocol_mismatch' })
    return
  }

  if (!agentId || agentId.trim() === '' || !instanceIdStr) {
    req.resume()
    res.writeHead(422, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'missing_identity' }))
    console.warn('[daemon] hook.receiver.rejected', { reason: 'missing_identity' })
    return
  }

  const instanceId = parseInt(instanceIdStr, 10)
  if (isNaN(instanceId)) {
    req.resume()
    res.writeHead(422, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid_instance' }))
    console.warn('[daemon] hook.receiver.rejected', { reason: 'invalid_instance' })
    return
  }

  const target = deps.manager.getLiveHookTarget(agentId, instanceId)
  if (!target) {
    req.resume()
    res.writeHead(409, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'panel_gone' }))
    console.warn('[daemon] hook.receiver.rejected', { reason: 'panel_gone', agentId: agentId.slice(-8) })
    return
  }

  const validAgentKey = (AI_AGENT_KEYS as readonly string[]).find(k => k === target.agentKey) as AgentKey | undefined
  if (!validAgentKey) {
    req.resume()
    res.writeHead(409, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid_agent_key' }))
    console.warn('[daemon] hook.receiver.rejected', { reason: 'invalid_agent_key', agentId: agentId.slice(-8) })
    return
  }

  let body: unknown
  try {
    body = await readBoundedJsonBody(req)
  } catch (err: unknown) {
    const code = err instanceof Error ? parseInt(err.message, 10) || 400 : 400
    req.resume()
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'body_error', code }))
    console.warn('[daemon] hook.receiver.rejected', { reason: 'body_error', code, agentId: agentId.slice(-8) })
    return
  }

  const headerEventName = req.headers[HEADER_EVENT_NAME] as string | undefined
  const norm = normalizeProviderHookEvent(body, target.agentKey, headerEventName)
  if (!norm) {
    req.resume()
    res.writeHead(422, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid_event' }))
    console.warn('[daemon] hook.receiver.rejected', { reason: 'invalid_event', agentId: agentId.slice(-8) })
    return
  }

  const eventId = Math.random().toString(36).substring(2, 10)

  // Use the canonical type: agent_hook_event
  const eventPayload: Extract<ServerMessage, { type: "agent_hook_event" }> = {
    type: "agent_hook_event",
    protocolVersion: HOOK_PROTOCOL_VERSION,
    eventId,
    agentId: target.agentId,
    panelInstanceId: target.instanceId,
    agentKey: validAgentKey,
    event: norm.event,
    providerSessionId: norm.providerSessionId
  }

  const ws = deps.ws
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) {
    req.resume()
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'server_unreachable' }))
    console.warn('[daemon] hook.receiver.rejected', { reason: 'server_unreachable', agentId: agentId.slice(-8) })
    return
  }

  ws.send(JSON.stringify(eventPayload), (err: unknown) => {
    if (err) {
      if (!res.headersSent) {
        req.resume()
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'send_failed' }))
      }
      console.warn(`[daemon] hook.${norm.event}.rejected`, { reason: 'send_failed', agentId: agentId.slice(-8), eventId })
      return
    }

    res.writeHead(202, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      protocol: HOOK_PROTOCOL,
      protocolVersion: HOOK_PROTOCOL_VERSION,
      accepted: norm.event,
      eventId
    }))
    console.log(`[daemon] hook.${norm.event}.accepted`, { agentId: agentId.slice(-8), eventId })
  })
}
