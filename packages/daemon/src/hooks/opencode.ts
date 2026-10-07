import path from 'node:path'
import { getOpenCodeConfigDir } from '../profile.js'
import {
  DESCRIPTOR_ENV_VAR,
  DESCRIPTOR_FIELD_TOKEN,
  DESCRIPTOR_FIELD_URL,
  HEADER_AGENT_ID,
  HEADER_INSTANCE_ID,
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_VERSION,
  HEADER_TOKEN,
  HOOK_PROTOCOL,
  HOOK_PROTOCOL_VERSION,
  PROVIDER_EVENT_FIELD,
  PROVIDER_EVENT_TURN_ENDED,
  PROVIDER_EVENT_TURN_FAILED,
  PROVIDER_SESSION_FIELD,
} from './protocol.js'

export const OPENCODE_HOOK_PLUGIN_FILENAME = 'jerico-hook.js'

export function getOpenCodePluginPath(): string {
  return path.join(getOpenCodeConfigDir(), 'plugin', OPENCODE_HOOK_PLUGIN_FILENAME)
}

/** Render a standalone ESM plugin. All wire names and values are sourced from
 * protocol.ts here instead of being independently duplicated in the artifact. */
export function renderOpenCodePlugin(): string {
  return `import { readFileSync } from "node:fs"

const DESCRIPTOR_ENV_VAR = ${JSON.stringify(DESCRIPTOR_ENV_VAR)}
const DESCRIPTOR_FIELD_URL = ${JSON.stringify(DESCRIPTOR_FIELD_URL)}
const DESCRIPTOR_FIELD_TOKEN = ${JSON.stringify(DESCRIPTOR_FIELD_TOKEN)}
const PROVIDER_EVENT_FIELD = ${JSON.stringify(PROVIDER_EVENT_FIELD)}
const PROVIDER_SESSION_FIELD = ${JSON.stringify(PROVIDER_SESSION_FIELD)}

function sessionIdOf(event) {
  const properties = event && typeof event === "object" && event.properties && typeof event.properties === "object"
    ? event.properties
    : {}
  const value = properties.sessionID ?? properties.sessionId ?? properties.session_id
  return typeof value === "string" && value.length <= 128 ? value : undefined
}

async function postTurn(providerEvent, event) {
  const descriptorPath = process.env[DESCRIPTOR_ENV_VAR]
  const panelId = process.env.BRIDGE_PANEL_ID
  const instanceId = process.env.BRIDGE_PANEL_INSTANCE_ID
  if (!descriptorPath || !panelId || !instanceId) return

  let descriptor
  try {
    descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"))
  } catch {
    return
  }
  const url = descriptor?.[DESCRIPTOR_FIELD_URL]
  const token = descriptor?.[DESCRIPTOR_FIELD_TOKEN]
  if (typeof url !== "string" || typeof token !== "string" || !url || !token) return

  const sessionId = sessionIdOf(event)
  const body = {
    [PROVIDER_EVENT_FIELD]: providerEvent,
    ...(sessionId === undefined ? {} : { [PROVIDER_SESSION_FIELD]: sessionId }),
  }

  // Fire-and-forget by contract: provider/model failure or an unreachable
  // daemon endpoint must never hold OpenCode's event callback or process open.
  await fetch(url, {
    method: "POST",
    headers: {
      ${JSON.stringify(HEADER_TOKEN)}: token,
      ${JSON.stringify(HEADER_PROTOCOL)}: ${JSON.stringify(HOOK_PROTOCOL)},
      ${JSON.stringify(HEADER_PROTOCOL_VERSION)}: ${JSON.stringify(String(HOOK_PROTOCOL_VERSION))},
      ${JSON.stringify(HEADER_AGENT_ID)}: panelId,
      ${JSON.stringify(HEADER_INSTANCE_ID)}: instanceId,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1000),
  }).catch(() => {})
}

export default async function jericoOpenCodePlugin() {
  return {
    event: async ({ event }) => {
      if (event?.type === "session.idle") {
        void postTurn(${JSON.stringify(PROVIDER_EVENT_TURN_ENDED)}, event)
      } else if (event?.type === "session.error") {
        void postTurn(${JSON.stringify(PROVIDER_EVENT_TURN_FAILED)}, event)
      }
    },
  }
}
`
}
