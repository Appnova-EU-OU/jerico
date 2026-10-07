import type { IncomingMessage, ServerResponse } from 'node:http'
import { HOOK_EVENT_PATH } from '../hooks/receiver.js'
import { EVENTS_ROUTE_PATH, EVENTS_ACK_PATH } from '../events/route.js'

export type AgentHookHttpHandler = (req: IncomingMessage, res: ServerResponse) => void
export type OrchestratorEventsHttpHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void

export interface DaemonHttpDispatchResult {
  handled: boolean
  url: URL
  pathname: string
}

const LOCAL_POST_PATHS = new Set(['/usage/refresh', '/shutdown', '/reconnect'])

/**
 * Route the daemon's loopback HTTP surface before the health handler runs.
 * Unknown method/path pairs are completed here so they cannot fall through to
 * a plausible-looking health response. Known control and health routes remain
 * with start.ts; the hook route is delegated to its bounded receiver.
 */
export function dispatchDaemonHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handleAgentHook: AgentHookHttpHandler,
  baseUrl = 'http://127.0.0.1',
  handleOrchestratorEvents?: OrchestratorEventsHttpHandler,
): DaemonHttpDispatchResult {
  const url = new URL(req.url ?? '/', baseUrl)
  const pathname = url.pathname

  if (req.method === 'POST' && pathname === HOOK_EVENT_PATH) {
    handleAgentHook(req, res)
    return { handled: true, url, pathname }
  }

  // #616: the orchestrator event surface. Optional, so a daemon built without it
  // 404s these paths through the rule below rather than answering something
  // plausible — the router's whole point is that an unknown pair cannot fall
  // through to a health-shaped response.
  if (req.method === 'POST' && (pathname === EVENTS_ROUTE_PATH || pathname === EVENTS_ACK_PATH)) {
    if (!handleOrchestratorEvents) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found' }))
      return { handled: true, url, pathname }
    }
    handleOrchestratorEvents(req, res, url)
    return { handled: true, url, pathname }
  }

  const isHealth = req.method === 'GET' && pathname === '/health'
  const isLocalControl = req.method === 'POST' && LOCAL_POST_PATHS.has(pathname)
  if (isHealth || isLocalControl) return { handled: false, url, pathname }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not_found' }))
  return { handled: true, url, pathname }
}
