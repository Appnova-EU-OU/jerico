/**
 * Wake cohort — which harnesses surface each event-stream line as a model turn.
 * Measured live: claude wakes per line; kimi wakes only when the process exits;
 * codex and opencode wake on neither. Only per-line wakers may receive notices
 * through the stream instead of the PTY.
 * Extracted so both the producer (ws/client.ts) and its tests share the same cohort definition.
 */
export const WAKE_COHORT = new Set<string>(['claude'])

export function isWakeCapable(agentKey: string | undefined): boolean {
  return WAKE_COHORT.has(agentKey ?? '')
}
