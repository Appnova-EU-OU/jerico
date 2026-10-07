import type { InstallResult } from './block.js'

import { HOOK_CAPABLE_AGENT_KEYS, type HookCapableAgentKey } from '@jerico/shared'

/** Derived, never re-spelled: the list lives in @jerico/shared so the daemon and
 *  the server validate against the same set and cannot drift apart again. */
export type HookTarget = HookCapableAgentKey

interface HookTargetRegistryEntryBase {
  target: HookTarget | string
  installKind: 'config-block' | 'plugin-file'
  getTargetFile: () => string
  getSpawnEnv?: () => Record<string, string>
}

export interface ConfigBlockHookTargetRegistryEntry extends HookTargetRegistryEntryBase {
  installKind: 'config-block'
  format: 'json' | 'toml'
  renderBlock: () => any
  findBlock: (content: string) => any
  spliceBlock: (content: string) => { content: string; status: InstallResult }
  stripBlock: (content: string) => { content: string; status: InstallResult }
  trustSeeder?: (targetPath: string, knownPreviousHashes?: string[]) => Promise<void> | void
  /** Content to create the target file with when it does not exist. Only set this
   *  for targets whose file exists solely to hold hooks — never for a file that
   *  also holds the user's own settings. */
  seedWhenMissing?: () => string
}

export interface PluginFileHookTargetRegistryEntry extends HookTargetRegistryEntryBase {
  installKind: 'plugin-file'
  renderFile: () => string
}

export type HookTargetRegistryEntry = ConfigBlockHookTargetRegistryEntry | PluginFileHookTargetRegistryEntry

// Spread rather than aliased: HOOK_TARGETS is a daemon-local view of the shared
// list, so a test that mutates it in place cannot reach into @jerico/shared.
export const HOOK_TARGETS: readonly HookTarget[] = [...HOOK_CAPABLE_AGENT_KEYS]

const registryMap = new Map<string, HookTargetRegistryEntry>()

export function registerHookTarget(entry: HookTargetRegistryEntry): void {
  registryMap.set(entry.target, entry)
}

export function unregisterHookTarget(target: string): void {
  registryMap.delete(target)
}

export function getHookTargetEntry(target: string): HookTargetRegistryEntry | undefined {
  return registryMap.get(target)
}

/** Remove every registry-owned spawn variable before applying only the target
 * entry's values. This prevents daemon env, project env, or agent env from
 * leaking one provider's config into another provider's process. */
export function applyHookTargetSpawnEnv(target: string, env: Record<string, string>): void {
  for (const entry of registryMap.values()) {
    if (!entry.getSpawnEnv) continue
    for (const key of Object.keys(entry.getSpawnEnv())) delete env[key]
  }
  const entry = registryMap.get(target)
  if (entry?.getSpawnEnv) Object.assign(env, entry.getSpawnEnv())
}
