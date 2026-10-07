/** Provider hook HTTP and daemon-to-server `agent_hook_event` generation. */
export const HOOK_PROTOCOL_VERSION = 1 as const

/** Descriptor handshake and `/v1/orchestrator-events/*` transport generation. */
export const EVENTS_PROTOCOL_VERSION = 2 as const

export type HookProtocolVersion = typeof HOOK_PROTOCOL_VERSION
export type EventsProtocolVersion = typeof EVENTS_PROTOCOL_VERSION
