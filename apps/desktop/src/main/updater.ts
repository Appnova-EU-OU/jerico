import { app, ipcMain, BrowserWindow, Notification, autoUpdater as nativeAutoUpdater } from 'electron'
import { afterIntro } from './intro.js'
import { pollOnce } from './utils/health.js'
import { getHealthPort } from './utils/profile.js'
import { autoUpdater } from 'electron-updater'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { recordEvent } from './utils/event-log.js'
import {
  canPublishReady, clearDownload, markDownloaded, markPreparing, planDownload, planInstall,
  reconcileAvailable, shouldClearPendingCache, shouldFailDownload, shouldShowDiscoveryNotification,
  type DownloadState,
} from './utils/update-state.js'

// ── Pending-cache helpers ──────────────────────────────────────────────────────
// electron-updater 6.x on macOS checks its cache before downloading. On a cache
// hit it calls dispatchUpdateDownloaded() and returns early, bypassing
// doDownloadUpdate() where native Squirrel staging (proxy server +
// nativeUpdater.checkForUpdates()) runs. squirrelDownloadedUpdate stays false →
// quitAndInstall() is a silent no-op. Clearing the pending cache forces the full
// download path so native staging always runs before quitAndInstall is offered.
//
// Cache-hit survives a full process restart (files on disk in ~/Library/Caches),
// so a user who reopens the app can see a stale "ready to install" state with
// no working install button. Clearing blockmap files (differential cache hints)
// alongside the update.zip ensures the next downloadUpdate() call performs a
// full native Squirrel staging rather than shortcutting via a cached delta.

function resolveUpdaterCacheDir(): string {
  const fallback = '@jericodesktop-updater'
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf-8')
    const m = yml.match(/updaterCacheDirName:\s*'?([^'\n]+)'?/)
    const dirName = (m?.[1] ?? fallback).trim()
    return path.join(os.homedir(), 'Library', 'Caches', dirName)
  } catch {
    return path.join(os.homedir(), 'Library', 'Caches', fallback)
  }
}

function clearPendingUpdateCache(): void {
  try {
    const dir = resolveUpdaterCacheDir()
    fs.rmSync(path.join(dir, 'pending'), { recursive: true, force: true })
    fs.rmSync(path.join(dir, 'update.zip'), { force: true })
    // Remove blockmap files so differential cache-hit path is also defeated.
    fs.rmSync(path.join(dir, 'current.blockmap'), { force: true })
    try {
      const entries = fs.readdirSync(dir)
      for (const f of entries) {
        if (f.endsWith('.blockmap')) fs.rmSync(path.join(dir, f), { force: true })
      }
    } catch { /* readdir non-fatal — cache dir may not exist on fresh install */ }
    console.log('[updater] cleared pending update cache to force native Squirrel staging')
  } catch (err) {
    console.warn('[updater] could not clear pending update cache:', (err as Error).message)
  }
}

// ── Feed URL resolution ────────────────────────────────────────────────────────
// Priority: JERICO_UPDATE_FEED env override > dev profile > prod

function getFeedUrl(): string {
  const override = process.env['JERICO_UPDATE_FEED']
  if (override) {
    const isHttps = override.startsWith('https://')
    const isLocalHttp = override.startsWith('http://localhost')
    if (isHttps || isLocalHttp) return override
    console.warn('[updater] JERICO_UPDATE_FEED must be https:// or http://localhost — ignoring, using profile default')
  }
  // dev profile is set in index.ts when !app.isPackaged
  if (process.env['BRIDGE_PROFILE'] === 'dev' || !app.isPackaged) {
    return 'http://localhost:3100/updates'
  }
  return 'https://lcars.jerico.appnova.io/updates'
}

// ── Console logger shim ───────────────────────────────────────────────────────
// electron-updater's logger interface expects { info, warn, error, debug }.
// Wiring it to console makes check outcomes visible in the main-process stdout.
const updaterLogger = {
  info(msg: string): void { console.log('[updater]', msg) },
  warn(msg: string): void { console.warn('[updater]', msg) },
  error(msg: string): void { console.error('[updater]', msg) },
  debug(_msg: string): void { /* suppress debug noise */ },
}

// ── Status payload type (shared with renderer via preload) ────────────────────

/* Re-exported from the preload's declaration rather than declared twice. The
   two copies had already drifted apart the moment the payload grew: main sent
   fields the renderer's type did not know about, and tsc only complained on one
   side of the wire. One definition, so a change to it breaks both ends at
   once. */
export type { UpdaterStatusPayload, UpdatePhase } from '../preload/types.d.ts'
import type { UpdaterStatusPayload, UpdatePhase } from '../preload/types.d.ts'

// ── Update window ─────────────────────────────────────────────────────────────

class UpdateWindow {
  private window: BrowserWindow | null = null
  // Replay last status to the renderer on did-finish-load (handles the
  // race where events fire before the window has fully loaded).
  private lastStatus: UpdaterStatusPayload | null = null

  open(): void {
    if (this.window) {
      this.window.show()
      this.window.focus()
      return
    }

    app.dock?.show()

    const preloadPath = path.join(__dirname, '../preload/index.js')
    this.window = new BrowserWindow({
      width: 520,
      height: 480,
      resizable: false,
      titleBarStyle: 'hiddenInset',
      // Named, because a Dock-less app has no tile to identify a window by: this
      // one's title is what Mission Control and the window switcher show. Without
      // it the window inherited index.html's <title> and called itself
      // "Jerico — setup", which is a different screen.
      title: 'Jerico — update',
      // The ground Electron paints before the first frame. It has to be the
      // window's own ground (--win in app.css) or opening it flashes the old
      // palette for a frame.
      backgroundColor: '#0e0e0d',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    // The page's <title> overrides the window's from the moment it loads, and
    // every window here loads the same index.html — so this title, and Manage's
    // before it, were silently replaced with "Jerico — setup" a few hundred
    // milliseconds after being set. Refusing the update is what makes the option
    // above mean anything.
    this.window.on('page-title-updated', (e) => { e.preventDefault() })

    this.window.on('closed', () => {
      this.window = null
      app.dock?.hide()
    })

    this.window.webContents.on('did-finish-load', () => {
      if (this.lastStatus) this.push(this.lastStatus)
    })

    // Creating a window does not activate an accessory app, so a window opened
    // by a `jerico://update` link from a browser could appear BEHIND the browser
    // the user just clicked it in. The already-open branch above focuses; this
    // one had nothing, and handleDeepLink's dock.show() — which is what used to
    // stand here in spirit — never activated anything either.
    //
    // `steal` is the documented way for a menu-bar app to come forward, and the
    // same justification the popover uses applies: every path into this window
    // is a user gesture (a tray click, a menu item, or a link they clicked).
    app.focus({ steal: true })
    this.window.focus()

    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) {
      void this.window.loadURL(`${rendererUrl}#update`)
    } else {
      void this.window.loadFile(
        path.join(__dirname, '../renderer/index.html'),
        { hash: 'update' },
      )
    }
  }

  send(payload: UpdaterStatusPayload): void {
    this.lastStatus = payload
    this.push(payload)
  }

  private push(payload: UpdaterStatusPayload): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('updater:status', payload)
    }
  }

  isOpen(): boolean {
    return this.window !== null
  }
}

const updateWindow = new UpdateWindow()

// ── In-process staging guard ──────────────────────────────────────────────────
// On macOS, electron-updater 6.x stages the update for native Squirrel only
// inside the same process that runs doDownloadUpdate(). If the process restarts
// the in-memory `squirrelDownloadedUpdate` flag is lost, so quitAndInstall()
// becomes a silent no-op even though the zip is on disk.
//
// CRITICAL: 'update-downloaded' fires for BOTH real downloads AND cache hits
// (dispatchUpdateDownloaded bypasses doDownloadUpdate + native staging). Setting
// stagedThisSession inside that handler without proof the event came from a
// download WE initiated would re-create the bug. freshDownloadInFlight gates this:
// only downloads preceded by our own clearPendingUpdateCache → downloadUpdate()
// sequence can set stagedThisSession to true. A passive cache-hit check that
// emits 'update-downloaded' on app reopen leaves stagedThisSession false, forcing
// updater:install into the re-download path where native staging actually runs.
let stagedThisSession = false
let stagedVersion: string | null = null
let installAfterStage = false
let freshDownloadInFlight = false
let downloadState: DownloadState = null
let downloadPromise: Promise<void> | null = null
/** The transfer lock deliberately outlives feed state and archive completion:
 * Squirrel can still be reading electron-updater's pending zip while staging. */
let transferVersion: string | null = null
let nativeStageVersion: string | null = null
let downloadPercent = 0
let updateStateCallback: ((version: string | null) => void) | null = null
const discoveryNotifiedVersions = new Set<string>()

/**
 * Which part of updating is currently running.
 *
 * `autoUpdater.on('error')` fires for every phase and the event says nothing
 * about which one — but WE know, because nothing reaches the updater except
 * through the three functions below. So the phase is tracked rather than
 * guessed, and `unknown` is reserved for an error arriving with no operation of
 * ours in flight, which is the one case we genuinely cannot name.
 *
 * A failed check emits twice — `on('error')` first, then the promise rejection
 * — and both now carry 'check', so it no longer matters which lands last.
 */
let activePhase: UpdatePhase = 'unknown'

/** The popover carries the update notice inline — a version, a rule that fills
 *  while it downloads, and Restart when it is staged. It therefore needs the
 *  same three events the Update window gets, not just "a version exists". */
export interface UpdateProgressSink {
  onStarting(version: string | null): void
  onProgress(percent: number, version: string | null): void
  onPreparing(version: string): void
  onReady(version: string): void
  onError(version: string | null, message: string): void
}
let progressSink: UpdateProgressSink | null = null
/** Remembered so a download-progress event, which carries no version, can still
 *  name the thing it is downloading. */
let availableVersion: string | null = null

export function setUpdateProgressSink(sink: UpdateProgressSink): void {
  progressSink = sink
}

/** Start downloading the available update. Exposed so the popover's own notice
 *  can act without sending the user to a second window first. */
function sendRememberedDownloadState(): void {
  if (!downloadState) return
  if (downloadState.state === 'downloaded') {
    updateWindow.send({ type: 'downloaded', version: downloadState.version })
    progressSink?.onReady(downloadState.version)
    return
  }
  if (downloadState.state === 'preparing') {
    updateWindow.send({ type: 'preparing', version: downloadState.version })
    progressSink?.onPreparing(downloadState.version)
    return
  }
  updateWindow.send({ type: 'downloading', percent: downloadPercent })
  progressSink?.onProgress(downloadPercent, downloadState.version)
}

function failDownload(err: Error): void {
  const version = downloadState?.version ?? availableVersion
  downloadState = clearDownload()
  freshDownloadInFlight = false
  transferVersion = null
  nativeStageVersion = null
  installAfterStage = false
  autoUpdater.autoInstallOnAppQuit = false
  activePhase = 'unknown'
  recordEvent('updater.download.failed', err.message, 'bad')
  progressSink?.onError(version, err.message)
  updateWindow.send({ type: 'error', message: err.message, phase: 'download' })
}

function showReady(version: string): void {
  stagedThisSession = true
  stagedVersion = version
  downloadState = markDownloaded(downloadState, version)
  transferVersion = null
  nativeStageVersion = null
  freshDownloadInFlight = false
  activePhase = 'unknown'
  updateWindow.send({ type: 'downloaded', version })
  progressSink?.onReady(version)
  if (installAfterStage) {
    installAfterStage = false
    autoUpdater.autoInstallOnAppQuit = true
    activePhase = 'install'
    autoUpdater.quitAndInstall()
    return
  }
  if (Notification.isSupported()) {
    const notif = new Notification({ title: `jerico ${version} is ready`, body: 'Restart to update' })
    notif.on('click', () => {
      recordEvent('updater.notification.clicked', version)
      installUpdate()
    })
    notif.show()
    recordEvent('updater.notification.shown', version)
  }
}

export function downloadUpdate(): Promise<void> {
  // Promise ownership is the final cache-clear guard. A version may be absent
  // briefly (for example a stale-session install before its check resolves),
  // but electron-updater can still be writing pending/ at that point.
  const inFlightVersion = transferVersion ?? (downloadPromise ? '__unknown-transfer__' : null)
  const decision = planDownload(downloadState, availableVersion, inFlightVersion)
  if (decision.plan === 'attach') {
    recordEvent('updater.download.attached', downloadState?.version ?? 'unknown')
    return downloadPromise ?? Promise.resolve()
  }
  if (decision.plan === 'defer') {
    recordEvent('updater.download.deferred', `${availableVersion ?? 'unknown'}; transfer ${transferVersion ?? 'unknown'}`)
    sendRememberedDownloadState()
    return downloadPromise ?? Promise.resolve()
  }
  if (decision.plan === 'already-downloaded') {
    recordEvent('updater.download.skipped-already-downloaded', downloadState?.version ?? 'unknown')
    sendRememberedDownloadState()
    return Promise.resolve()
  }

  if (shouldClearPendingCache(decision.plan)) clearPendingUpdateCache()
  downloadState = decision.state
  transferVersion = availableVersion
  downloadPercent = 0
  freshDownloadInFlight = true
  activePhase = 'download'
  autoUpdater.autoInstallOnAppQuit = true
  recordEvent('updater.download.started', availableVersion ?? 'unknown')
  updateWindow.send({ type: 'downloading', percent: 0 })
  progressSink?.onStarting(availableVersion)
  const promise = autoUpdater.downloadUpdate()
    .then(() => undefined)
    .catch((err: Error) => {
      if (transferVersion !== null) failDownload(err)
    })
    .finally(() => { if (downloadPromise === promise) downloadPromise = null })
  downloadPromise = promise
  return promise
}

/** Install a staged update (quit + relaunch). Same body as the updater:install
 *  IPC handler, which now calls this rather than duplicating it. */
export function installUpdate(): void {
  const installPlan = planInstall(stagedThisSession ? stagedVersion : null, availableVersion)
  if (installPlan === 'install') {
    // Normal path — native Squirrel staging completed in this process.
    // Already true from before downloadUpdate(); harmless belt-and-suspenders.
    autoUpdater.autoInstallOnAppQuit = true
    // Squirrel validates and swaps the bundle from here; anything that goes
    // wrong now arrives through on('error') and IS an install failure.
    activePhase = 'install'
    autoUpdater.quitAndInstall()
    return
  }
  if (installPlan === 'open-update') {
    // A notification for an older staged build can outlive a newer feed result.
    // Never install it implicitly: show the current update state instead.
    updateWindow.open()
    return
  }
  // Stale cache from a previous session — re-download so native staging runs.
  console.log('[updater] stale pending cache — clearing and re-downloading for install')
  installAfterStage = true
  void downloadUpdate()
}

/**
 * True when an update has been staged this session and the user requested
 * install.  The before-quit handler in index.ts checks this to avoid
 * blocking the Squirrel update with its active-panel confirmation dialog.
 */
export function isInstallingUpdate(): boolean {
  return stagedThisSession
}

export function setUpdateCallback(cb: (version: string | null) => void): void {
  updateStateCallback = cb
}

// ── In-flight lock — prevents overlapping concurrent checks ──────────────────
let checkInFlight = false

/**
 * Core check runner. openWindowFirst=true for user-initiated checks (tray /
 * IPC); false for background checks that should be silent until a result lands.
 */
function runCheck(openWindowFirst: boolean): void {
  if (checkInFlight) {
    console.log('[updater] check already in progress — skipping')
    return
  }
  checkInFlight = true
  activePhase = 'check'
  if (openWindowFirst) {
    // The intro covers the screen at the screen-saver level, so a window opened
    // during it lands underneath and cannot be reached — and a cold-start
    // `jerico://update` deep link flushes on the very next tick, which is
    // squarely inside the film. Wait it out; afterIntro() is already resolved
    // when no intro is playing, which is every launch after the first.
    void afterIntro().then(() => updateWindow.open())
  }
  autoUpdater.checkForUpdates()
    .catch((err: Error) => {
      console.error('[updater] check threw:', err.message)
      updateWindow.send({ type: 'error', message: err.message, phase: 'check' })
    })
    .finally(() => { checkInFlight = false; activePhase = 'unknown' })
}

// ── autoUpdater configuration + event wiring ──────────────────────────────────

export function setupUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = updaterLogger

  const feedUrl = getFeedUrl()
  console.log('[updater] feed configured:', feedUrl)

  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
    // Write resolved URL to a temp yml — guarantees env override wins regardless
    // of electron-updater v6 config-loading order (see S5 fix for full context).
    const tmpYml = path.join(os.tmpdir(), 'jerico-dev-update.yml')
    fs.writeFileSync(tmpYml, `provider: generic\nurl: ${feedUrl}\n`, 'utf-8')
    autoUpdater.updateConfigPath = tmpYml
  } else {
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
  }

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking-for-update feed:', feedUrl)
    if (downloadState) {
      // The window re-checks on mount, but its first paint must still describe
      // the in-process download the user already started.
      sendRememberedDownloadState()
      return
    }
    updateWindow.send({ type: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    const version = String(info.version)
    console.log('[updater] update-available version:', version)
    const reconciled = reconcileAvailable(downloadState, version, transferVersion)
    if (reconciled.downgradePrevented) {
      recordEvent('updater.state-downgrade-prevented', `${version} (${downloadState?.state})`)
      console.log('[updater] state downgrade prevented for:', version)
      availableVersion = version
      sendRememberedDownloadState()
    } else {
      downloadState = reconciled.state
      availableVersion = version

      // The feed lists each artefact's size. Passing it on lets the window say
      // how big the download is before the user commits to it.
      const files = (info as { files?: Array<{ size?: number }> }).files
      const sizeBytes = files?.[0]?.size

      if (downloadState) {
        sendRememberedDownloadState()
      } else {
        updateStateCallback?.(version)
        updateWindow.send({ type: 'available', version, sizeBytes })
      }
    }
    if (shouldShowDiscoveryNotification(discoveryNotifiedVersions, version, downloadState?.version ?? null, transferVersion)) {
      discoveryNotifiedVersions.add(version)
      if (Notification.isSupported()) {
        const notif = new Notification({ title: `jerico ${version} is available`, body: 'Download it from Updates' })
        notif.on('click', () => {
          recordEvent('updater.discovery-notification.clicked', version)
          updateWindow.open()
        })
        notif.show()
        recordEvent('updater.discovery-notification.shown', version)
      }
    }

  })

  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] update-not-available current:', info.version)
    if (downloadState) {
      console.log('[updater] keeping in-process download state after not-available')
      sendRememberedDownloadState()
      return
    }
    availableVersion = null
    updateStateCallback?.(null)  // clear the popover notice
    updateWindow.send({ type: 'not-available', checkedAt: Date.now() })
  })

  autoUpdater.on('error', (err: Error) => {
    console.error('[updater] error (%s phase):', activePhase, err.message)
    if (shouldFailDownload(activePhase)) {
      failDownload(err)
      return
    }
    updateWindow.send({ type: 'error', message: err.message, phase: activePhase })
  })

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent)
    downloadPercent = percent
    // The window says how big and how fast; the popover's notice is one line
    // and says only how far. Same event, two audiences.
    updateWindow.send({
      type: 'downloading',
      percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    })
    progressSink?.onProgress(percent, transferVersion ?? availableVersion)
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update-downloaded version:', info.version)
    const version = String(info.version)

    // Only mark staging as real if this event came from a download WE initiated
    // (after clearPendingUpdateCache). Cache-hit emits the same event without
    // native Squirrel staging — do NOT trust it.
    if (freshDownloadInFlight) {
      freshDownloadInFlight = false
      nativeStageVersion = version
      activePhase = 'stage'
      downloadState = markPreparing(downloadState, version)
      updateWindow.send({ type: 'preparing', version })
      progressSink?.onPreparing(version)
      console.log('[updater] archive downloaded — waiting for native Squirrel staging')
    } else {
      console.log('[updater] update-downloaded from cache-hit — staging NOT confirmed')
    }
  })

  nativeAutoUpdater.on('update-downloaded', () => {
    if (nativeStageVersion === null || !canPublishReady(true)) return
    const version = nativeStageVersion
    console.log('[updater] native Squirrel staging confirmed:', version)
    showReady(version)
    void pollOnce(getHealthPort())
      .then((h) => updateWindow.send({ type: 'downloaded', version, activePanels: h.activePanels }))
      .catch(() => { /* no daemon to ask — the screen just omits the count */ })
  })

  // MacUpdater forwards this same native failure to its own EventEmitter. Keep
  // the direct listener too: a concurrent feed check changes activePhase to
  // 'check', but must not hide a genuine Squirrel staging failure.
  nativeAutoUpdater.on('error', (err: Error) => {
    if (nativeStageVersion !== null) failDownload(err)
  })

  // ── IPC handlers ────────────────────────────────────────────────────────────

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('updater:check', () => {
    checkForUpdates()
  })

  // Clearing the electron-updater pending cache before downloading is what makes
  // the native Squirrel staging path run (a cache-hit skips doDownloadUpdate →
  // squirrelDownloadedUpdate stays false → quitAndInstall is a silent no-op).
  // That rule now lives in downloadUpdate()/installUpdate(), which both the
  // Update window and the popover call, so there is one copy of it.
  ipcMain.handle('updater:download', () => { downloadUpdate() })
  ipcMain.handle('updater:install', () => { installUpdate() })
}

// ── Proactive background checking ────────────────────────────────────────────

let backgroundChecksScheduled = false

/**
 * Schedule a proactive check 10s after the tray is ready, then every 6 hours.
 * Called once from index.ts after startTray() to avoid blocking startup.
 * Guards against double-scheduling if called more than once.
 */
export function scheduleBackgroundChecks(): void {
  if (backgroundChecksScheduled) return
  backgroundChecksScheduled = true

  const INTERVAL_MS = 6 * 60 * 60 * 1000  // 6 hours

  console.log('[updater] background checks scheduled (10s then every 6h)')

  const initialTimer = setTimeout(() => {
    console.log('[updater] background check (launch)')
    runCheck(false)
  }, 10_000)

  const periodicTimer = setInterval(() => {
    console.log('[updater] background check (periodic)')
    runCheck(false)
  }, INTERVAL_MS)

  // Clean up timers on quit so they don't prevent process exit
  app.once('before-quit', () => {
    clearTimeout(initialTimer)
    clearInterval(periodicTimer)
  })
}

/** Open the Update window without starting a new check. Used by tray badge click. */
export function openUpdateWindow(): void {
  updateWindow.open()
}

/** Open the update window and trigger a check. Called from tray "Check for Updates…" and IPC. */
export function checkForUpdates(): void {
  console.log('[updater] checkForUpdates → feed:', getFeedUrl())
  runCheck(true)
}
