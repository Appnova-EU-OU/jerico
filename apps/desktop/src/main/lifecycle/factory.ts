import { MacLaunchdLifecycle } from './mac-launchd.js'
import type { DaemonLifecycle } from './types.js'

const lifecycleInstances = new Map<number, DaemonLifecycle>()

export function getPlatformLifecycle(port: number): DaemonLifecycle {
  if (process.platform !== 'darwin') {
    throw new Error(`Platform '${process.platform}' is not yet supported. macOS (darwin) only.`)
  }
  let inst = lifecycleInstances.get(port)
  if (!inst) {
    inst = new MacLaunchdLifecycle(port)
    lifecycleInstances.set(port, inst)
  }
  return inst
}
