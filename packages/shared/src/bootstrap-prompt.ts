// ============================================================================
// Bootstrap Prompt — Small spawn-time instruction for pull-default architecture
// ============================================================================

import { AGENT_ROLES } from './types.js'
import type { AgentRole } from './types.js'

export function buildBootstrapPrompt(role: AgentRole): string {
  if (!AGENT_ROLES.includes(role)) {
    throw new Error(`buildBootstrapPrompt: unknown role "${role}"`)
  }
  const blueprintNudge = role === 'orchestrator'
    ? `\n\nOn your first message, call bridge_get_blueprint: if the project blueprint is empty, warn the user, and ask to update it whenever a feature completes.`
    : ''
  return `You are running as role="${role}" in the Bridge orchestration system.

Your full operating instructions are stored in the workspace database.
BEFORE you take any other action — before reading files, before running commands,
before replying to the user — call this MCP tool:
    bridge_get_role_prompt({ role: "${role}" })

Treat the response as your authoritative system instructions for this entire
session. You may call bridge_get_role_prompt again at any time to refresh.

If bridge_get_role_prompt is unavailable, fall back to default behavior for role=${role}.${blueprintNudge}`
}

