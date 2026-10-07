import { readFileSync } from 'node:fs'
import { getTargetFile } from './install.js'
import { findBlock, spliceBlock } from './block.js'
import type { AgentKey, HookInstallRefusal, HookInstallRefusalStatus, PanelHookConfigState } from '@jerico/shared'
import { ALL_AGENT_KEYS } from '@jerico/shared'
import { HOOK_TARGETS, type HookTarget } from './targets.js'
import { getHookTargetEntry } from './targets.js'

import type { InstallResult } from './block.js'

const refusals = new Map<HookTarget, HookInstallRefusal>()
export let lastHookInstallRefusal: HookInstallRefusal | null = null

function isRefusal(status: InstallResult): status is HookInstallRefusalStatus {
  return status !== 'installed' && status !== 'already-present'
}

export function setHookInstallRefusal(
  status: InstallResult | null,
  target: HookTarget = 'claude',
  at = Date.now()
): void {
  if (status === null) {
    refusals.delete(target)
    lastHookInstallRefusal = [...refusals.values()].sort((a, b) => b.at - a.at)[0] ?? null
    return
  }
  if (!isRefusal(status)) return
  const refusal = { status, at }
  refusals.set(target, refusal)
  lastHookInstallRefusal = refusal
}

export function getHookInstallRefusal(agentKey: string): HookInstallRefusal | undefined {
  return (HOOK_TARGETS as readonly string[]).includes(agentKey)
    ? refusals.get(agentKey as HookTarget)
    : undefined
}

export type HookConfigState = PanelHookConfigState

/**
 * What a non-target agent's hook state actually is.
 *
 * `'unknown'` used to catch everything that was not a hook target — six real
 * agent keys — so a shell panel, which has no turn-hook surface to configure at
 * all, reported the same word as an agent the daemon has never heard of. Two
 * different facts under one label, and the honest-by-design surfaces then drew a
 * permanent, un-actionable "unknown" on every project holding a shell.
 *
 * Three words, three meanings, all already on the wire:
 *   no_config_hook_surface  — there is nothing here to configure. Settled.
 *   runtime_unverified      — the agent has *a* surface; Jerico has not verified
 *                             that it can carry the turn-end contract.
 *   different_contract      — it has a config-driven post-turn action, but not
 *                             the one Jerico speaks.
 *
 * Everything below that is not a hook target is provisional by construction:
 * running a CLI's `--help` shows that a surface exists, never that a
 * Jerico-compatible turn-end callback contract does. Promote a row when someone
 * checks, do not guess it upward.
 */
const NON_TARGET_HOOK_STATE: Record<Exclude<AgentKey, HookTarget>, HookConfigState> = {
  // Nothing to configure.
  sh: 'unsupported_no_config_hook_surface',
  // Not a CLI agent at all — it has no pty agent spec (`agents.ts` never
  // mentions it), so there is no process whose turns could be hooked.
  sim_ios: 'unsupported_no_config_hook_surface',
  // `Large language model runner`; serve/run/stop/ps and no hook, plugin or
  // event surface in its help. Observed, not proof of absence.
  ollama: 'unsupported_no_config_hook_surface',
  // A first-class hooks subsystem exists (`qwen hooks`, and `--safe-mode`
  // disables "context files, hooks, extensions"). The contract is what is
  // unverified here — never call this one no-surface.
  qwen: 'unsupported_runtime_unverified',
  // `--auto-test`, `--test-cmd`, `--auto-lint`, `--lint-cmd`: a post-turn action
  // driven by a config file. That is a different contract, not an absent
  // surface — the distinction this word exists for.
  aider: 'unsupported_different_contract',
  // `-e, --event <EVENT>` dispatches an event *into* forge, which is the
  // opposite direction from a turn-end callback out of it. So its surface is
  // unproven rather than absent.
  forge: 'unsupported_runtime_unverified',
  // `plugin`, `plugins`, `--plugin-dir`, `--extension-sdk-path`: a real
  // extension surface, unverified against Jerico's contract.
  copilot: 'unsupported_runtime_unverified',
}

export function getHookConfig(agentKey: string): HookConfigState {
  // Before the membership check on purpose: `gemini` is not an AgentKey at all,
  // so the guard below would answer 'unknown' for it. Kept as a named
  // diagnostic for a key that used to appear in this position.
  if (agentKey === 'gemini') return 'unsupported_not_a_jerico_agent'

  // Defensive, not load-bearing. On the production path `agentKey` can only be
  // a detected, installed agent — spawn fails with AGENT_NOT_FOUND before a
  // handle exists, and the server rejects unknown keys as `bad_enum` — so this
  // is unreachable there. It earns its line because the export takes `string`
  // and is called directly with arbitrary values, and because 'unknown' is the
  // only truthful answer for a key nobody has classified.
  if (!(ALL_AGENT_KEYS as readonly string[]).includes(agentKey)) return 'unknown'

  if (!(HOOK_TARGETS as readonly string[]).includes(agentKey)) {
    return NON_TARGET_HOOK_STATE[agentKey as Exclude<AgentKey, HookTarget>]
  }

  const target = agentKey as HookTarget
  const entry = getHookTargetEntry(target)
  if (!entry) return 'unknown'

  let content: string
  try {
    const targetPath = getTargetFile(agentKey as HookTarget)
    content = readFileSync(targetPath, 'utf-8')
  } catch (err: any) {
    if (err.code === 'ENOENT') return 'absent'
    return 'unknown'
  }

  if (entry.installKind === 'plugin-file') {
    return content === entry.renderFile() ? 'present_ok' : 'malformed'
  }

  const probe = spliceBlock(target, content)
  if (probe.status === 'refused-malformed') return 'malformed'
  return findBlock(target, content) === null ? 'absent' : 'present_ok'
}
