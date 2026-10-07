/**
 * #616 Fix 3 — wake-cohort gated publish helper.
 *
 * Extracted so the production gate (`isWakeCapable`) and the poller publish
 * are exercised through ONE function that both `ws/client.ts` and its test
 * import. A mutation that disables the real gate (`false && !isWakeCapable`)
 * breaks the helper and therefore the execution test — a source-text grep
 * cannot be silenced by mutating the cohort set alone.
 */
import { isWakeCapable } from './wake-cohort.js'
import { orchestratorPoller } from './instance.js'
import type { PublishInput, PublishOutcome } from './broker.js'

export type WakeGatedPublishOutcome =
  | PublishOutcome
  | { published: false; reason: 'wake_cohort_mismatch' }

export function tryPublishOrchestratorNotice(
  agentKey: string | undefined,
  subscriberId: string,
  input: PublishInput,
): WakeGatedPublishOutcome {
  if (!isWakeCapable(agentKey)) {
    return { published: false, reason: 'wake_cohort_mismatch' }
  }
  return orchestratorPoller.publish(subscriberId, input)
}
