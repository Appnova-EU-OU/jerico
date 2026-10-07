/**
 * Production HTTP handler factory for the orchestrator event surface (#616 slice 2).
 *
 * Extracted so `commands/start.ts` and `__tests__/616-fix2-cross-panel.test.ts`
 * import the SAME handler — a test-only copy would hide a missing resolver.
 */
import { authorizeEventsRequest, clampPollWait, subscriberIdFor, EVENTS_ACK_PATH, EVENTS_ROUTE_PATH } from './route.js'
import type { OrchestratorEventBroker } from './broker.js'
import type { OrchestratorEventPoller } from './poller.js'

export interface OrchestratorHandlerDeps {
  hookToken: string
  isPanelLive: (agentId: string, instanceId: number) => boolean
  getPanelEventToken: (agentId: string, instanceId: number) => string | undefined
  broker: OrchestratorEventBroker
  poller: OrchestratorEventPoller
  leases: Map<string, symbol>
}

export function createOrchestratorEventsHandler(deps: OrchestratorHandlerDeps) {
  const { hookToken, isPanelLive, getPanelEventToken, broker, poller, leases } = deps
  return (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL): boolean => {
    // Only handle the two orchestrator routes; return false to let caller try next route.
    if (url.pathname !== EVENTS_ROUTE_PATH && url.pathname !== EVENTS_ACK_PATH) return false

    const auth = authorizeEventsRequest(req.headers as Record<string, string | string[] | undefined>, hookToken, isPanelLive, getPanelEventToken)
    if (!auth.ok) {
      req.resume()
      res.writeHead(auth.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: auth.error }))
      return true
    }
    const subscriberId = subscriberIdFor(auth.agentId, auth.instanceId)

    if (url.pathname === EVENTS_ACK_PATH) {
      req.resume()
      const throughRaw = url.searchParams.get('through') ?? ''
      const through = Number.parseInt(throughRaw, 10)
      const lease = leases.get(subscriberId)
      const ok = lease !== undefined && Number.isFinite(through) ? poller.ack(subscriberId, lease, through) : false
      res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok }))
      return true
    }

    const waitMs = clampPollWait(url.searchParams.get('waitMs'), 15_000)
    let lease = leases.get(subscriberId)
    if (!lease || !broker.hasLease(subscriberId, lease)) {
      const attached = broker.attach(subscriberId)
      lease = attached.lease
      leases.set(subscriberId, lease)
    }
    req.resume()
    void poller.poll(subscriberId, lease, waitMs).then(result => {
      if (res.writableEnded) return
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    }).catch(err => {
      if (res.writableEnded) return
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    })
    return true
  }
}
