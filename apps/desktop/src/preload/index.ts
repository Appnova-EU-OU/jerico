import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeAPI, PopoverAction, PopoverState, UpdaterStatusPayload, UsageDetail } from './types.d.ts'

const bridge: BridgeAPI = {
  async checkSetup(): Promise<{ complete: boolean }> {
    return (await ipcRenderer.invoke('setup:check')) as { complete: boolean }
  },

  async getServerEndpoints(): Promise<{
    ok: boolean
    wsUrl?: string
    connectPageUrl?: string
    connectPageLabel?: string
    error?: string
  }> {
    return (await ipcRenderer.invoke('server:endpoints')) as {
      ok: boolean
      wsUrl?: string
      connectPageUrl?: string
      connectPageLabel?: string
      error?: string
    }
  },

  async getConnectionSummary(): Promise<{
    machine: string
    server: string
    serviceInstalled: boolean
  }> {
    return (await ipcRenderer.invoke('setup:connection-summary')) as {
      machine: string
      server: string
      serviceInstalled: boolean
    }
  },

  async getManageSummary(): Promise<BridgeAPI['getManageSummary'] extends () => Promise<infer R> ? R : never> {
    return (await ipcRenderer.invoke('manage:summary')) as never
  },

  async setClaudeTier(tier: string): Promise<{ ok: boolean }> {
    return (await ipcRenderer.invoke('manage:set-claude-tier', tier)) as { ok: boolean }
  },

  /** Every window the daemon reports for every agent that has a fetcher.
   *  `usage: null` = this daemon does not report limits at all; `[]` = it does
   *  and has nothing yet. The two are drawn differently. */
  async popoverSetNested(nested: boolean): Promise<void> {
    await ipcRenderer.invoke('popover:set-nested', nested)
  },

  async getUsageDetail(): Promise<{ usage: UsageDetail[] | null; daemonReachable: boolean; foreign?: boolean }> {
    return (await ipcRenderer.invoke('usage:detail')) as { usage: UsageDetail[] | null; daemonReachable: boolean; foreign?: boolean }
  },

  /** Ask the daemon to re-read every provider now. The ONLY path that can produce
   *  a Keychain-backed reading, because the scheduled cycle will not prompt. */
  async refreshUsage(): Promise<{ usage: UsageDetail[] | null; daemonReachable: boolean; foreign?: boolean }> {
    return (await ipcRenderer.invoke('usage:refresh')) as { usage: UsageDetail[] | null; daemonReachable: boolean; foreign?: boolean }
  },

  /** The `system:open-external` handler has existed all along with nothing
   *  wired to it — Manage's "Open logs" needs it. */
  async openExternal(url: string): Promise<void> {
    await ipcRenderer.invoke('system:open-external', url)
  },

  async openAuthUrl(): Promise<void> {
    await ipcRenderer.invoke('auth:open-url')
  },

  async validateToken(token: string): Promise<{ ok: boolean; error?: string }> {
    return (await ipcRenderer.invoke('auth:validate-token', token)) as {
      ok: boolean
      error?: string
    }
  },

  async saveAuth(token: string): Promise<{ ok: boolean; error?: string }> {
    return (await ipcRenderer.invoke('auth:save', token)) as { ok: boolean; error?: string }
  },

  async detectLegacyConfig(): Promise<{ found: boolean; configPath?: string; server?: string }> {
    return (await ipcRenderer.invoke('config:detect-legacy')) as {
      found: boolean
      configPath?: string
      server?: string
    }
  },

  async migrateLegacyConfig(): Promise<{ ok: boolean; error?: string }> {
    return (await ipcRenderer.invoke('config:migrate-legacy')) as { ok: boolean; error?: string }
  },

  async completeSetup(): Promise<void> {
    await ipcRenderer.invoke('setup:complete')
  },

  async installDaemon(): Promise<{ ok: boolean; error?: string }> {
    return (await ipcRenderer.invoke('daemon:install')) as { ok: boolean; error?: string }
  },

  async runNow(): Promise<{ ok: boolean; error?: string }> {
    return (await ipcRenderer.invoke('daemon:run-now')) as { ok: boolean; error?: string }
  },

  async uninstallDaemon(): Promise<{ ok: boolean; error?: string }> {
    return (await ipcRenderer.invoke('daemon:uninstall')) as { ok: boolean; error?: string }
  },

  async getConsentStatus(): Promise<{ consented: boolean }> {
    return (await ipcRenderer.invoke('bridge:get-consent-status')) as { consented: boolean }
  },

  async recordConsent(): Promise<{ ok: boolean }> {
    return (await ipcRenderer.invoke('bridge:record-consent')) as { ok: boolean }
  },


  async openFDASettings(): Promise<void> {
    await ipcRenderer.invoke('permissions:open-fda')
  },

  async revealBridgeAgent(): Promise<void> {
    await ipcRenderer.invoke('permissions:reveal-bridge-agent')
  },

  async probeAndOpenFDA(): Promise<void> {
    await ipcRenderer.invoke('permissions:probe-and-open-fda')
  },

  async checkDocumentsAccess(): Promise<{ readable: boolean }> {
    return (await ipcRenderer.invoke('permissions:check-documents-access')) as { readable: boolean }
  },

  async setLoginItem(enabled: boolean): Promise<{ didStick: boolean }> {
    return (await ipcRenderer.invoke('permissions:set-login-item', enabled)) as {
      didStick: boolean
    }
  },

  async getLoginItemEnabled(): Promise<boolean> {
    return (await ipcRenderer.invoke('permissions:get-login-item')) as boolean
  },

  async checkPermissions(): Promise<{
    passed: boolean
    keychain: boolean
    launchAgent: boolean
    bridgeDir: boolean
    jericoDir: boolean
  }> {
    return (await ipcRenderer.invoke('permissions:check')) as {
      passed: boolean
      keychain: boolean
      launchAgent: boolean
      bridgeDir: boolean
      jericoDir: boolean
    }
  },

  async completePermissionSetup(): Promise<{ ok: boolean }> {
    return (await ipcRenderer.invoke('permissions:gate-complete')) as { ok: boolean }
  },

  async installLaunchAgent(): Promise<{ ok: boolean; error?: string }> {
    return (await ipcRenderer.invoke('permissions:install-launchagent')) as { ok: boolean; error?: string }
  },

  async healKeychainAcl(): Promise<{ ok: boolean; error?: string }> {
    return (await ipcRenderer.invoke('permissions:heal-keychain')) as { ok: boolean; error?: string }
  },

  async getLogsPath(): Promise<{ out: string; err: string }> {
    return (await ipcRenderer.invoke('system:get-logs-path')) as { out: string; err: string }
  },

  onPopoverState(callback): () => void {
    const listener = (_event: unknown, state: PopoverState): void => callback(state)
    ipcRenderer.on('popover:state', listener)
    return () => ipcRenderer.removeListener('popover:state', listener)
  },

  onPopoverOpened(callback): () => void {
    const listener = (): void => callback()
    ipcRenderer.on('popover:opened', listener)
    return () => ipcRenderer.removeListener('popover:opened', listener)
  },

  onPopoverHidden(callback): () => void {
    const listener = (): void => callback()
    ipcRenderer.on('popover:hidden', listener)
    return () => ipcRenderer.removeListener('popover:hidden', listener)
  },

  onPopoverAnchor(callback): () => void {
    const listener = (_event: unknown, a: { centerX: number }): void => callback(a)
    ipcRenderer.on('popover:anchor', listener)
    return () => ipcRenderer.removeListener('popover:anchor', listener)
  },

  async popoverAction(action: PopoverAction): Promise<void> {
    await ipcRenderer.invoke('popover:action', action)
  },

  async popoverResize(height: number): Promise<void> {
    await ipcRenderer.invoke('popover:resize', height)
  },

  async popoverClose(): Promise<void> {
    await ipcRenderer.invoke('popover:close')
  },

  async popoverRequestState(): Promise<void> {
    await ipcRenderer.invoke('popover:request-state')
  },

  async getAppVersion(): Promise<string> {
    return (await ipcRenderer.invoke('app:version')) as string
  },

  async checkForUpdates(): Promise<void> {
    await ipcRenderer.invoke('updater:check')
  },

  async downloadUpdate(): Promise<void> {
    await ipcRenderer.invoke('updater:download')
  },

  async installUpdate(): Promise<void> {
    await ipcRenderer.invoke('updater:install')
  },

  onUpdaterStatus(callback): () => void {
    const listener = (_event: unknown, payload: UpdaterStatusPayload): void => callback(payload)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  },

  async quitApp(): Promise<void> {
    await ipcRenderer.invoke('app:quit')
  },
}

contextBridge.exposeInMainWorld('bridge', bridge)
