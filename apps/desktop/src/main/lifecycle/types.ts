export type DaemonState = 'running-connected' | 'running-disconnected' | 'not-running' | 'starting' | 'restarting' | 'stopping'

export interface HealthStatus {
  connected: boolean
  activePanels: number
  version: string | null
}

export interface SpawnResult {
  code: number | null
  stdout: string
  stderr: string
}

export type LifecycleProgressStage = 'stopping' | 'starting' | 'waiting_for_launchd'

export interface LifecycleProgress {
  stage: LifecycleProgressStage
  message: string
}

export type LifecycleProgressCallback = (progress: LifecycleProgress) => void

export interface DaemonLifecycle {
  install(): Promise<SpawnResult>
  start(onProgress?: LifecycleProgressCallback): Promise<SpawnResult>
  /**
   * Replace the launchd registration for this label: `bridge-agent restart`, which
   * unloads a foreign/stale registration and bootstraps ours (#577).
   *
   * DESTRUCTIVE — it stops the running daemon and every PTY session with it, so it
   * is only ever called from an explicit user action, never from a start path.
   */
  reregister(onProgress?: LifecycleProgressCallback): Promise<SpawnResult>
  stop(): Promise<SpawnResult>
  shutdownForQuit(): Promise<SpawnResult>
  uninstall(): Promise<SpawnResult>
  status(): Promise<DaemonState>
  isInstalled(): Promise<boolean>
  logsPath(): { out: string; err: string; lifecycle: string }
}
