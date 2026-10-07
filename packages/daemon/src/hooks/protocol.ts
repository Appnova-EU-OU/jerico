export const HOOK_PROTOCOL = "jerico-agent-hook"
// These are separate wire generations. Re-export both from the daemon's
// historical protocol module so every daemon consumer reaches the shared
// source of truth used by the server.
export { HOOK_PROTOCOL_VERSION, EVENTS_PROTOCOL_VERSION } from '@jerico/shared'
export const HOOK_ROUTE_PATH = "/v1/agent-hooks/events"

export const HEADER_TOKEN = "x-jerico-hook-token"
export const HEADER_PROTOCOL = "x-jerico-hook-protocol"
export const HEADER_PROTOCOL_VERSION = "x-jerico-hook-protocol-version"
export const HEADER_AGENT_ID = "x-jerico-agent-id"
export const HEADER_INSTANCE_ID = "x-jerico-panel-instance-id"
export const HEADER_EVENT_TOKEN = "x-jerico-event-token"
export const EVENT_TOKEN_ENV_VAR = "BRIDGE_PANEL_EVENT_TOKEN"
/** Providers whose hook payload carries no event-name field (agy) send it here.
 *  The body field still wins when both are present. */
export const HEADER_EVENT_NAME = "x-jerico-hook-event-name"

export const DESCRIPTOR_ENV_VAR = "BRIDGE_HOOK_DESCRIPTOR"
/** Opt-in shared-script vars. Unset for every target but agy. */
export const HOOK_ENV_EVENT_NAME = "JERICO_HOOK_EVENT_NAME"
export const HOOK_ENV_STDOUT = "JERICO_HOOK_STDOUT"
export const DESCRIPTOR_FIELD_URL = "url"
export const DESCRIPTOR_FIELD_TOKEN = "hookToken"

export const PROVIDER_EVENT_FIELD = "hook_event_name"
export const PROVIDER_SESSION_FIELD = "session_id"
/** agy names its session `conversationId`; used only when `session_id` is absent. */
export const PROVIDER_CONVERSATION_FIELD = "conversationId"
export const PROVIDER_ERROR_FIELD = "error"
export const PROVIDER_TERMINATION_FIELD = "terminationReason"
export const PROVIDER_EVENT_TURN_ENDED = "Stop"
export const PROVIDER_EVENT_TURN_FAILED = "Error"

export type AgentHookTurnEvent = "turn_ended" | "turn_failed"

import { getHookEndpointPath } from '../profile.js'

export function getHookEnvPairs(panelId: string, instanceId?: number): { BRIDGE_PANEL_ID: string; BRIDGE_PANEL_INSTANCE_ID?: string; BRIDGE_HOOK_DESCRIPTOR: string } {
  const env: Record<string, string> = {
    BRIDGE_PANEL_ID: panelId,
    [DESCRIPTOR_ENV_VAR]: getHookEndpointPath(),
  }
  if (instanceId !== undefined) {
    env.BRIDGE_PANEL_INSTANCE_ID = String(instanceId)
  }
  return env as any
}
