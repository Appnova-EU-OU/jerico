import type { AgentKey } from './types.js'
import { AGENT_LABELS, AGENT_SHORT_LABELS } from './types.js'
import { AGENT_MODELS, supportsLaunchModel } from './agent-models.js'

export function modelShort(agentKey: AgentKey, model?: string): string | undefined {
  if (!model || !supportsLaunchModel(agentKey)) return undefined
  const reg = AGENT_MODELS[agentKey]?.models?.find(m => m.id === model)?.label
  if (reg) return reg
  const base = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  return base.length > 16 ? base.slice(0, 15) + '…' : base
}

export function workerDisplayName(agentKey: AgentKey, ordinal?: number | null, model?: string | null): string {
  const base = AGENT_LABELS[agentKey] ?? agentKey
  const ord  = ordinal != null ? ` #${ordinal}` : ''
  const sm   = modelShort(agentKey, model ?? undefined)
  return `${base}${ord}${sm ? ` · ${sm}` : ''}`
}

export function workerShortName(agentKey: AgentKey, ordinal?: number | null): string {
  return `${AGENT_SHORT_LABELS[agentKey] ?? agentKey}${ordinal != null ? ` #${ordinal}` : ''}`
}
