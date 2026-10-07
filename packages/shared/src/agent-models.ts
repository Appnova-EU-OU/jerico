import type { AgentKey } from './types.js'

export interface AgentModelInfo {
  supportsLaunchModel: boolean
  /** Whether the daemon can send agent_models_available for this agent. */
  reportsModels: boolean
  defaultModel?: string
  models: Array<{ id: string; label: string }>
}

// Launch-time model ids are single tokens (e.g. "sonnet", "gpt-5",
// "anthropic/claude-sonnet-5", "llama3.2:8b") — never whitespace or escapes.
const RE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/

/** Validate a user-supplied model id without relying on server-only sanitize.ts. */
export function isValidModelId(model: string | undefined): model is string {
  if (!model) return false
  return RE_MODEL.test(model)
}

export const AGENT_MODELS: Record<AgentKey, AgentModelInfo> = {
  sh:       { supportsLaunchModel: false, reportsModels: false, models: [] },
  claude:   { supportsLaunchModel: true, reportsModels: false, defaultModel: 'sonnet', models: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }, { id: 'haiku', label: 'Haiku' }, { id: 'fable', label: 'Fable' }] },
  codex:    { supportsLaunchModel: true, reportsModels: true, defaultModel: 'gpt-5.4', models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }, { id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }, { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }] },
  qwen:     { supportsLaunchModel: true, reportsModels: false, models: [] },
  kimi:     { supportsLaunchModel: true, reportsModels: false, models: [] },
  agy:      { supportsLaunchModel: true, reportsModels: false, models: [] },
  ollama:   { supportsLaunchModel: true, reportsModels: true, models: [] },
  aider:    { supportsLaunchModel: true, reportsModels: false, models: [] },
  forge:    { supportsLaunchModel: false, reportsModels: false, models: [] },
  opencode: { supportsLaunchModel: true, reportsModels: true, models: [] },
  copilot:  { supportsLaunchModel: true, reportsModels: false, defaultModel: 'auto', models: [{ id: 'auto', label: 'Auto' }] },
  sim_ios:  { supportsLaunchModel: false, reportsModels: false, models: [] },
}

export function getDefaultModel(agentKey: AgentKey): string | undefined {
  return AGENT_MODELS[agentKey]?.defaultModel
}

export function supportsLaunchModel(agentKey: AgentKey): boolean {
  return AGENT_MODELS[agentKey]?.supportsLaunchModel ?? false
}

/**
 * Agents whose NATIVE in-session model switch is live-enabled in v1.
 * The modelSwitch adapter may be implemented for additional agents
 * (live-verify group), but only keys in this set are active at runtime —
 * others are gated off until the maintainer's local live-test enables them.
 *
 * SHIP v1: claude (/model <name>), aider (/model <name>), ollama (/load <model>).
 */
export const IN_SESSION_MODEL_SWITCH_ENABLED: ReadonlySet<AgentKey> = new Set<AgentKey>([
  'claude',
  'aider',
  'ollama',
])

/** Whether in-session (no-respawn) model switching is live-enabled for an agent. */
export function isInSessionModelSwitchEnabled(agentKey: AgentKey): boolean {
  return IN_SESSION_MODEL_SWITCH_ENABLED.has(agentKey)
}
