/**
 * Singleton orchestrator event broker + poller for the daemon process (#616).
 *
 * One instance per daemon run, shared between:
 * - the consumer HTTP handler (start.ts)  — serves poll/ack
 * - the producer path (ws/client.ts)      — publishes notices
 *
 * Extracted so both import the SAME object; constructing separately would
 * create two rings and the consumer would never see the producer's records.
 */
import { OrchestratorEventBroker } from './broker.js'
import { OrchestratorEventPoller } from './poller.js'

export const orchestratorBroker = new OrchestratorEventBroker()
export const orchestratorPoller = new OrchestratorEventPoller(orchestratorBroker)
