import { app, dialog, shell } from 'electron'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { TrayController } from './tray.js'
import { startHealthPoller, pollOnce } from './utils/health.js'
import { getPlatformLifecycle } from './lifecycle/factory.js'
import type { DaemonLifecycle } from './lifecycle/types.js'
import { isSetupComplete } from './setup-check.js'
import { WizardController } from './wizard.js'
import { registerIpcHandlers, setGatePassed } from './ipc-handlers.js'
import { runPermissionGate } from './permission-gate.js'
import { playIntro } from './intro.js'
import { ManageWindow } from './manage-window.js'
import { installAppMenu } from './app-menu.js'
import {
  EndpointConfigurationError,
  getHealthPort,
  getAuthFailedFlagPath,
  getEndpointRejectedFlagPath,
  readEndpointRejectedFlag,
  getProfileName,
} from './utils/profile.js'
import {
  setupUpdater,
  setUpdateCallback,
  setUpdateProgressSink,
  scheduleBackgroundChecks,
  checkForUpdates,
  isInstallingUpdate,
} from './updater.js'

// In dev mode, isolate config/plist/health-port from prod by using the dev profile.
if (!app.isPackaged && !process.env['BRIDGE_PROFILE']) {
  process.env['BRIDGE_PROFILE'] = 'dev'
}

// ── Deep link handler ─────────────────────────────────────────────────────────

const ALLOWED_CHANNELS = new Set(['latest', 'beta', 'next', 'canary'])

function handleDeepLink(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    console.warn('[deeplink] invalid URL:', url)
    return
  }

  const rawChannel = parsed.searchParams.get('channel') ?? 'latest'
  const channel = ALLOWED_CHANNELS.has(rawChannel) ? rawChannel : 'latest'

  console.log('[deeplink] received:', url, '→ action:', parsed.hostname, 'channel:', channel)

  if (parsed.hostname === 'update') {
    // Opens the Update screen and runs a check. Never auto-downloads or
    // auto-installs — the user must click "Update Now".
    //
    // There is deliberately no app.dock.show() here. The Update window owns the
    // Dock tile: it shows one when it opens and hides it again when it closes
    // (updater.ts), which is the only shape that cannot leak. Showing one here
    // as well was redundant on the happy path and a one-way door off it —
    // runCheck() returns early when a check is already in flight, WITHOUT
    // opening the window, and a background check runs 10s after launch and every
    // 6h. A deep link landing in that window raised a tile that nothing would
    // ever hide, quietly turning a menu-bar app into an ordinary one for the
    // rest of the session.
    //
    // It also never did what its comment claimed. dock.show() changes the
    // activation POLICY; it does not activate the app. Bringing the window
    // forward is UpdateWindow.open()'s job and is done there.
    checkForUpdates()
    return
  }

  // Unknown hostname — log and ignore (security: deep link only opens the Update screen)
  console.warn('[deeplink] unknown host:', parsed.hostname, '— ignored')
}

/** Issue #43: the daemon's Documents-service probe returned readable:false.
 *  Full Disk Access is one remedy, but the probe does not prove FDA state. */
async function showDocumentsAccessDialog(healthPort: number): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: [
      'Reveal bridge-agent in Finder',
      'Open Full Disk Access pane',
      'Restart & Check',
      'Dismiss',
    ],
    defaultId: 2,
    cancelId: 3,
    message: 'Daemon cannot read the Documents folder',
    detail:
      'The bridge-agent daemon runs under launchd, and its Documents probe returned “Operation not permitted.” ' +
      'macOS privacy or filesystem permissions may be blocking access. ' +
      'This check does not determine Full Disk Access state. If you choose to grant Full Disk Access, ' +
      'grant it to bridge-agent; granting it to the Jerico app does not cover the daemon.\n\n' +
      '1. Click "Reveal" to find bridge-agent in Finder\n' +
      '2. Open System Settings → Privacy → Full Disk Access\n' +
      '3. Drag bridge-agent into the list or click + and press ⌘⇧G to paste the path\n' +
      '4. Toggle it ON\n' +
      '5. Click "Restart & Check" below when done',
  })
  if (response === 0) {
    const bridgePath = app.isPackaged
      ? path.join(process.resourcesPath, 'bridge-agent')
      : path.join(app.getAppPath(), '..', '..', 'packages', 'daemon', 'dist')
    shell.showItemInFolder(path.resolve(bridgePath))
  } else if (response === 1) {
    const darwinMajor = parseInt((await import('node:os')).release().split('.')[0] ?? '0', 10)
    const url = darwinMajor >= 22
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFilesAccess'
    await shell.openExternal(url)
  } else if (response === 2) {
    const lifecycle = getPlatformLifecycle(healthPort)
    await lifecycle.start()
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 2000))
      const health = await pollOnce(healthPort)
      if (health.documentsFolderReadable === true) {
        await dialog.showMessageBox({
          type: 'info',
          message: 'Documents access confirmed ✓',
          detail: 'The daemon can now read the Documents folder.',
        })
        return
      }
    }
  }
}

// Shared state accessible to both main() and doQuitShutdown().
let tray: TrayController | null = null
let poller: ReturnType<typeof startHealthPoller> | null = null
let wizard: WizardController | null = null
let lifecycle: DaemonLifecycle | null = null
let quitting = false

function main(): void {
  // ── Protocol registration ─────────────────────────────────────────────────
  // In dev mode, process.defaultApp is true (Electron is the real executable
  // and our script path lives in argv[1]). Passing them explicitly lets macOS
  // re-launch the dev app correctly when the protocol fires cold.
  // In packaged mode, app.setAsDefaultProtocolClient() alone suffices because
  // the Info.plist (written by electron-builder mac.protocols) tells macOS
  // exactly which .app to launch.
  const isDevApp = (process as unknown as Record<string, unknown>)['defaultApp'] === true
  if (isDevApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(
      'jerico',
      process.execPath,
      [path.resolve(process.argv[1]!)],
    )
  } else {
    app.setAsDefaultProtocolClient('jerico')
  }

  // ── Cold-start buffering ──────────────────────────────────────────────────
  // On macOS, open-url fires for cold-start deep links before app.isReady().
  // Buffer here; flush it once whenReady() resolves and the app is fully set up.
  let pendingDeepLink: string | null = null

  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (!app.isReady()) {
      // Store for flush in whenReady()
      pendingDeepLink = url
    } else {
      handleDeepLink(url)
    }
  })

  const HEALTH_PORT = getHealthPort()

  // Every other per-profile path is scoped — config, plist, health port, lock,
  // intro flag — but userData was not, and Electron keys its single-instance
  // lock on it. Two named profiles therefore fought over one SingletonLock:
  // the loser called app.quit() below with nothing but a raw Chromium line on
  // stderr, so `BRIDGE_PROFILE=x` and `BRIDGE_PROFILE=y` could not run side by
  // side at all — the isolation the daemon fully supports stopped at the app.
  const profileName = getProfileName()

  // Pin userData to what it resolves to RIGHT NOW, before anything renames the
  // app. Electron derives it as appData/<app.getName()>, so the name and this
  // path are the same knob: `jerico` when packaged (CFBundleName, which
  // electron-builder writes from productName) and `@jerico/desktop` in an
  // unpackaged run (package.json name). setName() below moves it, and moving it
  // relocates every existing install's window state AND changes the
  // single-instance lock key — two instances could then run at once. Reading it
  // first and setting it back makes the path immune to the name.
  const baseUserData = app.getPath('userData')
  app.setPath('userData', profileName
    ? path.join(baseUserData, `profile-${profileName}`)
    : baseUserData)

  // The app called itself Electron everywhere the name is user-facing: the
  // application menu, notifications, and the Keychain and permission prompts.
  // Safe only because the line above pinned the path — do not reorder these.
  app.setName('Jerico')

  if (!app.requestSingleInstanceLock()) {
    console.warn(
      `[jerico-desktop] another instance already holds the lock for profile `
      + `${profileName ?? 'prod'} — exiting`,
    )
    app.quit()
    return
  }

  // ── Second-instance: forward jerico:// URLs to the already-running instance ─
  // On macOS, open-url handles the protocol for running instances, but on
  // Windows/Linux (and as a fallback) deep links arrive as argv of the second
  // process that tried to launch. Scan and forward.
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith('jerico://'))
    if (url) {
      handleDeepLink(url)
    }
  })

  // Tray app: subscribing to this event prevents the default quit when all windows close
  app.on('window-all-closed', () => {
    // intentionally empty — tray stays alive without open windows
  })

  app.on('before-quit', (event) => {
    // If lifecycle isn't ready (app quits before whenReady resolves), just exit.
    if (!lifecycle) {
      poller?.stop()
      tray?.destroy()
      return
    }

    // Guard: if already shutting down, let the eventual app.exit(0) re-trigger
    // pass through so Electron actually exits.
    if (quitting) return

    // Update install in progress (Squirrel): skip the active-panel
    // confirmation dialog so we don't block the update.  Stop the daemon
    // on a best-effort basis (fire-and-forget), then let the quit event
    // through naturally so Squirrel can install the new version.
    if (isInstallingUpdate()) {
      poller?.stop()
      tray?.destroy()
      void lifecycle.stop()
      return
    }

    // Standard Electron pattern: prevent default exit on the first before-quit,
    // run async shutdown, then call app.exit(0) which re-fires before-quit.
    event.preventDefault()
    quitting = true

    doQuitShutdown(lifecycle, HEALTH_PORT).then((proceed) => {
      if (proceed) app.exit(0)
      else quitting = false
    }).catch(() => {
      app.exit(0)
    })
  })

  app.on('activate', () => {
    wizard?.showIfNeeded()
  })

  app.whenReady()
    .then(async () => {
      app.dock?.hide()
      installAppMenu()

      // Flush a deep link that arrived before the app was ready (cold start).
      // Deferred with setTimeout so app setup (protocol client, updater) completes
      // synchronously before handleDeepLink() tries to open the Update window.
      if (pendingDeepLink) {
        const url = pendingDeepLink
        pendingDeepLink = null
        setTimeout(() => handleDeepLink(url), 0)
      }

      // Wired before the intro, not after. setupUpdater() is where every
      // autoUpdater listener and updater IPC handler is registered, and a
      // cold-start `jerico://update` deep link flushes on the next tick —
      // during the film. Registering afterwards meant that check ran with no
      // listeners at all and its result went nowhere.
      setupUpdater()

      // The first-launch intro, before anything asks the user for something.
      // Awaited: the permission gate opens a window, and two windows racing to
      // the front on first launch is how you get a gate hidden behind a film.
      await playIntro()

      lifecycle = getPlatformLifecycle(HEALTH_PORT)!
      wizard = new WizardController()

      function startTray(): void {
        tray = new TrayController(() => app.quit(), lifecycle!, HEALTH_PORT)
        // A menu-bar popover has no window until the icon is clicked, and macOS
        // Accessibility is denied to scripted contexts here — it reports zero
        // windows for every process, including ones plainly on screen. So the
        // only way to open the popover from a test is to reach the controller.
        // Development builds only; a packaged app has no such handle.
        if (!app.isPackaged) {
          (globalThis as Record<string, unknown>)['__jericoTray'] = tray
        }
        let lastAuthFailed = false
        // One reading is not a verdict. The daemon reports auth_failed from a
        // flag file, and during a restart the app can catch a stale one before
        // the new connection has had a chance to clear it — which is enough to
        // throw a working setup back to the sign-in screen. Two in a row.
        let authFailedStreak = 0
        let lastDocumentsReadable: boolean | undefined = undefined
        let documentsDialogShown = false
        poller = startHealthPoller(HEALTH_PORT, (result) => {
          // A daemon from another profile answered; its numbers are not ours.
          // Do not paint the tray with them and do not act on them.
          if (result.foreign) return

          tray?.setState(result)

          // The daemon does not stay up to be asked. On the second 1008 it
          // writes the auth-failed flag and exits 0 (ws/client.ts), and launchd
          // does not respawn a clean exit — so the whole reject-to-gone cycle
          // takes about three seconds, which is shorter than one poll. Waiting
          // for two auth_failed readings from a process that is already gone
          // meant a user whose token was revoked mid-session watched the tray
          // turn red and stay red forever, with no way back except quitting and
          // relaunching. The flag it left behind is the durable signal, and it
          // is the same one startup already trusts.
          const flaggedOnDisk = result.state === 'red' && existsSync(getAuthFailedFlagPath())
          // #571: a daemon that refused its endpoint never dialled, so it cannot
          // have had its token rejected. Opening the re-auth wizard here sends
          // the user through a flow whose auth exits 1 on the very endpoint being
          // complained about. The flag is read from disk as well as /health
          // because the reason has to survive the daemon not answering at all.
          const endpointRefused = result.endpointRejectedReason !== null || readEndpointRejectedFlag() !== null
          const authFailed = !endpointRefused && (result.authFailed || flaggedOnDisk)
          authFailedStreak = authFailed ? authFailedStreak + 1 : 0
          // A flag on disk is already a settled fact, so it does not need a
          // second opinion; a live reading still does.
          if (!endpointRefused && (flaggedOnDisk || authFailedStreak === 2) && !lastAuthFailed && !wizard!.isOpen()) {
            console.log('[jerico-desktop] auth_failed detected at runtime, opening wizard')
            wizard!.showAtAuthStep()
          }
          lastAuthFailed = !endpointRefused && (flaggedOnDisk || authFailedStreak >= 2)
          // Issue #43: surface a Documents-service denial without claiming it
          // proves the daemon's broader Full Disk Access state.
          const currentReadable = result.documentsFolderReadable
          if (currentReadable === false && lastDocumentsReadable !== false && !documentsDialogShown) {
            documentsDialogShown = true
            if (!wizard!.isOpen()) {
              void showDocumentsAccessDialog(HEALTH_PORT)
            }
          }
          if (currentReadable === true) {
            documentsDialogShown = false
          }
          lastDocumentsReadable = currentReadable
        })
        // Auto-ensure daemon: on every app launch, check that the running
        // daemon version matches the expected version.  If the daemon is
        // already running but stale (desktop updated, old launchd process
        // still alive), lifecycle.start() will kickstart it and await the
        // new version. The ordinary current-version check stays silent; if a
        // replacement is needed, its stages flow into the popover's existing
        // transition state and activity register.
        void tray.ensureDaemonWithProgress()
        // Wire update-available/not-available events to the popover's notice,
        // and the download's own progress with them — the notice carries a rule
        // that fills, so it needs every event the Update window gets.
        setUpdateCallback((version) => { tray?.setUpdateAvailable(version) })
        setUpdateProgressSink({
          onStarting: (version) => { tray?.setUpdateStarting(version) },
          onProgress: (percent, version) => { tray?.setUpdateProgress(percent, version) },
          onPreparing: (version) => { tray?.setUpdatePreparing(version) },
          onReady: (version) => { tray?.setUpdateReady(version) },
          onError: (version, message) => { tray?.setUpdateError(version, message) },
        })
        // Proactive check: 10s after tray is ready, then every 6h
        scheduleBackgroundChecks()

        // Dev affordance, same reason JERICO_FORCE_INTRO exists: once setup is
        // complete the app opens no window at all, so the only way to reach
        // Manage or Update is the tray — which cannot be driven from a script.
        // That made both windows effectively un-iterable.
        const openWindow = !app.isPackaged ? process.env['JERICO_OPEN'] : undefined
        if (openWindow === 'manage') new ManageWindow().open()
        else if (openWindow === 'update') checkForUpdates()
      }

      registerIpcHandlers(wizard, startTray)

      // Phase B: run permission gate BEFORE any setup/auth flow.
      // If the gate fails, show the PermissionGate UI and block until
      // all three MUST grants pass (Keychain ACL, LaunchAgent, ~/.bridge).
      // The user clicks "Continue" in the gate UI → permissions:gate-complete
      // IPC re-checks and resumes setup on success.
      const gateResult = await runPermissionGate()
      if (!gateResult.passed) {
        console.log('[jerico-desktop] permission gate blocked — showing gate UI', gateResult.status)
        wizard.showAtPermissionGate()
        return
      }
      setGatePassed(true)

      if (!isSetupComplete()) {
        wizard.show()
      } else if (readEndpointRejectedFlag() !== null) {
        // Not the wizard: re-auth cannot repair an endpoint (its auth exits 1 on
        // the invalid configured value). The tray names the fault and prints the
        // command that does work.
        const flag = readEndpointRejectedFlag()
        console.log('[jerico-desktop] endpoint-rejected flag detected, going to tray with the reason', {
          path: getEndpointRejectedFlagPath(), reason: flag?.reason, remedy: flag?.remedy,
        })
        startTray()
      } else if (existsSync(getAuthFailedFlagPath())) {
        console.log('[jerico-desktop] auth_failed flag detected, reopening wizard for re-auth', { path: getAuthFailedFlagPath() })
        wizard.showAtAuthStep()
      } else {
        startTray()
      }
    })
    .catch((err: unknown) => {
      console.error('[jerico-desktop] startup failed', err)
      app.quit()
    })
}

/**
 * Async shutdown run on Quit (Cmd+Q, tray Quit, window-all-closed).
 * Stops the daemon (and thereby its agents) before the app exits, so
 * no zombie daemon/panel survives in the background.  If panels are
 * active, shows a confirmation dialog first.  Bounds the daemon stop
 * to ~5s — the app always exits, it never hangs.
 */
async function doQuitShutdown(lc: DaemonLifecycle, healthPort: number): Promise<boolean> {
  // Step 1: If panels are active, confirm with the user.
  try {
    const health = await pollOnce(healthPort)
    if (health.activePanels > 0) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Cancel', 'Quit'],
        defaultId: 0,
        message: 'Active panels are open',
        detail: `${health.activePanels} panel(s) are currently active. Quitting will terminate them.`,
      })
      if (response !== 1) {
        // User cancelled — return false so the caller resets quitting and
        // does NOT exit.  Caller sets quitting = false for re-entrancy reset.
        return false
      }
    }
  } catch {
    // Can't reach the daemon health endpoint — proceed with quit anyway.
  }

  // Step 2: Stop the health poller and tear down the tray (synchronous cleanup).
  poller?.stop()
  tray?.destroy()

  // Step 3: Full-stop the daemon (bootout, no respawn) with a timeout.
  // On timeout or failure the app still exits — we never hang the quit.
  // Uses shutdownForQuit() (not stop()) so launchd does NOT respawn the daemon.
  try {
    const stopPromise = lc.shutdownForQuit()
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 8000))
    await Promise.race([stopPromise, timeout])
  } catch {
    // Stop failed — proceed to exit.
    console.warn('[jerico-desktop] daemon stop failed or timed out — exiting anyway')
  }

  return true
}

try {
  main()
} catch (err) {
  if (err instanceof EndpointConfigurationError) {
    // The daemon is a CLI and reports invalid profiles on stderr. Electron may
    // have no window yet, so the desktop deliberately uses a native dialog.
    dialog.showErrorBox('Jerico profile configuration error', err.message)
    app.quit()
  } else {
    throw err
  }
}
