import type { AgentInfo } from '../shared/types.js'
import os from 'os'

export async function detectSimulatorBackend(): Promise<AgentInfo | null> {
  if (os.platform() !== 'darwin') return null
  return {
    key: 'sim_ios',
    displayName: 'iOS Simulator',
    binaryPath: 'xcrun',
    authStatus: 'ok',
  }
}
