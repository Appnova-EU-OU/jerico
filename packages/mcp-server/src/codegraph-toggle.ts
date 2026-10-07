/**
 * Codegraph cohort A/B — mcp-server side (issue #521 Step 2).
 *
 * When disabled, buildMcpServer registers NO bridge_codegraph_* tools, so an
 * A/B off-arm panel has no schema-listing tokens and no failed-call burn.
 *
 * Arms are PER-PANEL, pinned at spawn: the server resolves the arm ONCE at
 * spawn and records it immutably on the agents row (Step-2 relay wiring).
 * This fetch asks for the RECORDED arm by agentId — the answer is stable for
 * the panel's life, so the 10s TTL no longer risks a mid-session tools flip
 * (the recorded arm doesn't change even if the global toggle or experiment
 * config changes mid-session).
 *
 * State sources, in precedence order:
 *   1. env BRIDGE_CODEGRAPH=0/false — HARD override, no server round-trip.
 *      Only works for a bespoke harness that spawns the mcp-server directly:
 *      the daemon spawns the stdio mcp-server with an explicit env block
 *      (daemon client.ts mcp-config) that does NOT include BRIDGE_CODEGRAPH,
 *      so this override never reaches daemon-spawned panels.
 *   2. TTL-cached (10s, keyed by agentId) GET {BRIDGE_SERVER_URL}
 *      /api/meta/codegraph?agentId={ctx.agentId} via the existing api.ts
 *      request() path. The server answers with the recorded arm for a
 *      known agentId; a bare call (no agentId) yields the legacy global.
 *
 * Fetch failure → ON (fail-open = shipped behavior).
 */

import { request, type BridgeContext } from './api.js'

const TOGGLE_TTL_MS = 10_000
const TOGGLE_TIMEOUT_MS = 5_000

interface ToggleCacheEntry {
  enabled: boolean
  expiresAt: number
}

// FIX E: keyed by agentId — in HTTP mode concurrent sessions with different
// arms must not cross-contaminate within the TTL window. '' keys no-agent
// contexts (bare call → legacy global answer).
const cache = new Map<string, ToggleCacheEntry>()

/** Returns the hard override when BRIDGE_CODEGRAPH is set, else null. */
function envOverride(): boolean | null {
  const v = process.env['BRIDGE_CODEGRAPH']
  if (v === undefined || v.trim() === '') return null
  return !(v === '0' || v.toLowerCase() === 'false')
}

export async function codegraphToolsEnabled(ctx: BridgeContext): Promise<boolean> {
  const hard = envOverride()
  if (hard !== null) return hard

  const cacheKey = ctx.agentId ?? ''
  const now = Date.now()
  const hit = cache.get(cacheKey)
  if (hit && now < hit.expiresAt) return hit.enabled

  let enabled = true // fail-open: tools are the shipped behavior
  try {
    const base = ctx.serverUrl.replace(/\/$/, '')
    // The recorded-arm lookup is by agentId ONLY (server ignores projectId
    // here — the pin already encodes the (user,project) resolution).
    const params = new URLSearchParams()
    if (ctx.agentId) params.set('agentId', ctx.agentId)
    const res = await request<{ enabled?: boolean; arm?: string }>(
      ctx,
      'GET',
      `${base}/api/meta/codegraph?${params.toString()}`,
      undefined,
      { timeoutMs: TOGGLE_TIMEOUT_MS },
    )
    // Recorded-arm answer ({arm:'on'|'off'}) wins; the bare legacy {enabled}
    // shape covers older servers and the no-agentId fallback.
    if (res.arm === 'on' || res.arm === 'off') enabled = res.arm === 'on'
    else if (typeof res.enabled === 'boolean') enabled = res.enabled
  } catch (err) {
    // Server unreachable / older server without the endpoint → stay ON.
    // Loud on purpose: during an OFF arm a silent fail-open registers the
    // tools and invisibly contaminates the baseline — make it detectable.
    console.warn('[codegraph-toggle] arm fetch failed, failing OPEN (tools ON):', err instanceof Error ? err.message : err)
  }
  cache.set(cacheKey, { enabled, expiresAt: now + TOGGLE_TTL_MS })
  return enabled
}
