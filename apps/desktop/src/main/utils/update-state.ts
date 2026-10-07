/**
 * The state we know was initiated in this process.  electron-updater emits
 * `update-available` again when a window opens; that observation must not
 * erase an in-flight or staged download for the very same version.
 */
export type DownloadState = {
  version: string
  state: 'downloading' | 'preparing' | 'downloaded'
} | null

export type DownloadPlan = 'start' | 'attach' | 'defer' | 'already-downloaded'

export function reconcileAvailable(
  current: DownloadState,
  version: string,
  transferVersion: string | null = null,
): { state: DownloadState; downgradePrevented: boolean } {
  if (current?.version === version) return { state: current, downgradePrevented: true }
  // A feed result must never erase the state of a transfer which still owns
  // electron-updater's pending directory. The new version remains discoverable,
  // but its download waits for the owner to settle.
  if (transferVersion !== null) return { state: current, downgradePrevented: true }
  return { state: null, downgradePrevented: false }
}

export function planDownload(
  current: DownloadState,
  version: string | null,
  transferVersion: string | null = null,
): {
  plan: DownloadPlan
  state: DownloadState
} {
  if (transferVersion !== null) {
    return {
      plan: transferVersion === version ? 'attach' : 'defer',
      state: current,
    }
  }
  if (current?.state === 'downloading') return { plan: 'attach', state: current }
  if (current?.state === 'downloaded' && current.version === version) {
    return { plan: 'already-downloaded', state: current }
  }
  return { plan: 'start', state: version ? { version, state: 'downloading' } : null }
}

export function markDownloaded(current: DownloadState, version: string): DownloadState {
  return current?.version === version ? { version, state: 'downloaded' } : { version, state: 'downloaded' }
}

export function markPreparing(current: DownloadState, version: string): DownloadState {
  return current?.version === version ? { version, state: 'preparing' } : { version, state: 'preparing' }
}

export function shouldFailDownload(phase: 'check' | 'download' | 'stage' | 'install' | 'unknown'): boolean {
  return phase === 'download' || phase === 'stage'
}

export function shouldClearPendingCache(plan: DownloadPlan): boolean {
  return plan === 'start'
}

export function canPublishReady(nativeStageSucceeded: boolean): boolean {
  return nativeStageSucceeded
}

export function planInstall(stagedVersion: string | null, availableVersion: string | null): 'install' | 'open-update' | 'redownload' {
  if (stagedVersion === null) return 'redownload'
  return stagedVersion === availableVersion ? 'install' : 'open-update'
}

export function shouldShowDiscoveryNotification(
  notifiedVersions: ReadonlySet<string>,
  version: string,
  displayedVersion: string | null,
  transferVersion: string | null,
): boolean {
  return !notifiedVersions.has(version) && version !== displayedVersion && version !== transferVersion
}

export function shortFailureMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function clearDownload(): DownloadState {
  return null
}
