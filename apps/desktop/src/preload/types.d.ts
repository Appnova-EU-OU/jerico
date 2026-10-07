import type { PopoverAction, PopoverLimit, PopoverState } from '../main/utils/popover-model.js'
import type { HealthUsage } from '../main/utils/health-classify.js'

export type { PopoverAction, PopoverLimit, PopoverState }
/** One agent's full set of windows, as the usage window renders them. */
export type UsageDetail = HealthUsage

/** What the Update window can say.
 *
 *  The sizes, the rate and the panel count are here because the approved design
 *  states them, and a progress bar that can only say "42%" makes the user guess
 *  whether that is thirty seconds or ten minutes. electron-updater already
 *  reports all of it; it was simply being thrown away at the boundary. */
export type UpdatePhase = 'check' | 'download' | 'stage' | 'install' | 'unknown'

export type UpdaterStatusPayload =
  | { type: 'checking' }
  | { type: 'available'; version: string; sizeBytes?: number }
  | { type: 'not-available'; checkedAt: number }
  /** Which part of updating failed. The four emit sites are not the same kind
   *  of failure and the screen cannot tell them apart without being told: a feed
   *  that would not load is a REACHABILITY problem, and describing it with the
   *  install copy sent a user to check whether their app had been moved out of
   *  /Applications when nothing had been downloaded, let alone installed.
   *  `unknown` is the honest answer when the updater reports an error with no
   *  operation of ours in flight — the screen then quotes it and says nothing
   *  more. */
  | { type: 'error'; message: string; phase: UpdatePhase }
  | {
      type: 'downloading'
      percent: number
      transferred?: number
      total?: number
      bytesPerSecond?: number
    }
  | { type: 'preparing'; version: string }
  /** `activePanels` is what restarting will kill. The design says it out loud
   *  on this screen, because "restart now" is otherwise an invisible trade. */
  | { type: 'downloaded'; version: string; activePanels?: number }

export interface BridgeAPI {
  checkSetup(): Promise<{ complete: boolean }>
  getServerEndpoints(): Promise<{
    ok: boolean
    wsUrl?: string
    connectPageUrl?: string
    connectPageLabel?: string
    error?: string
  }>
  openAuthUrl(): Promise<void>
  validateToken(token: string): Promise<{ ok: boolean; error?: string }>
  saveAuth(token: string): Promise<{ ok: boolean; error?: string }>
  detectLegacyConfig(): Promise<{
    found: boolean
    configPath?: string
    server?: string
  }>
  getConnectionSummary(): Promise<{ machine: string; server: string; serviceInstalled: boolean }>
  /** Everything the Manage window states about this installation. */
  getManageSummary(): Promise<{
    machine: string
    server: string
    serviceInstalled: boolean
    appVersion: string
    arch: string
    signed: boolean
    daemonVersion: string | null
    daemonRunning: boolean
    activePanels: number
    /** null when no daemon answered — "unknown", which is not "denied". */
    documentsFolderReadable: boolean | null
    claudeTier: string
    tokenStore: string
  }>
  setClaudeTier(tier: string): Promise<{ ok: boolean }>
  openExternal(url: string): Promise<void>
  migrateLegacyConfig(): Promise<{ ok: boolean; error?: string }>
  completeSetup(): Promise<void>
  installDaemon(): Promise<{ ok: boolean; error?: string }>
  runNow(): Promise<{ ok: boolean; error?: string }>
  uninstallDaemon(): Promise<{ ok: boolean; error?: string }>
  getConsentStatus(): Promise<{ consented: boolean }>
  recordConsent(): Promise<{ ok: boolean }>
  openFDASettings(): Promise<void>
  probeAndOpenFDA(): Promise<void>
  revealBridgeAgent(): Promise<void>
  checkDocumentsAccess(): Promise<{ readable: boolean }>
  setLoginItem(enabled: boolean): Promise<{ didStick: boolean }>
  getLoginItemEnabled(): Promise<boolean>
  checkPermissions(): Promise<{
    passed: boolean
    keychain: boolean
    launchAgent: boolean
    bridgeDir: boolean
    jericoDir: boolean
  }>

  completePermissionSetup(): Promise<{ ok: boolean }>

  installLaunchAgent(): Promise<{ ok: boolean; error?: string }>

  healKeychainAcl(): Promise<{ ok: boolean; error?: string }>

  getLogsPath(): Promise<{ out: string; err: string }>

  // ── Popover ───────────────────────────────────────────────────────────────
  /** Subscribe to the whole popover state. Main computes it; the renderer only
   *  draws it. Returns an unsubscribe. */
  /** Tell main a nested view is up, so its own Escape watcher steps back
   *  instead of dismissing the card. */
  popoverSetNested(nested: boolean): Promise<void>
  getUsageDetail(): Promise<{ usage: UsageDetail[] | null; daemonReachable: boolean; foreign?: boolean }>
  refreshUsage(): Promise<{ usage: UsageDetail[] | null; daemonReachable: boolean; foreign?: boolean }>
  /** The card was dismissed. The renderer folds back to its main view, which
   *  unmounts the usage panel and with it the panel's timers. */
  onPopoverHidden(callback: () => void): () => void
  onPopoverState(callback: (state: PopoverState) => void): () => void
  /** Fired every time the window is shown, so the renderer can reset its roving
   *  focus to the primary action the way an NSMenu starts at the top. */
  onPopoverOpened(callback: () => void): () => void
  /** Where the notch must point, in points from the card's left edge. */
  onPopoverAnchor(callback: (a: { centerX: number }) => void): () => void
  popoverAction(action: PopoverAction): Promise<void>
  /** Report measured content height so the window can be exactly as tall as
   *  what is in it. */
  popoverResize(height: number): Promise<void>
  popoverClose(): Promise<void>
  popoverRequestState(): Promise<void>

  // Updater
  getAppVersion(): Promise<string>
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  onUpdaterStatus(callback: (payload: UpdaterStatusPayload) => void): () => void
  quitApp(): Promise<void>
}

declare global {
  interface Window {
    bridge: BridgeAPI
  }
}

export {}
