import { Tray, shell, nativeImage, dialog, ipcMain, app } from 'electron'
import { checkForUpdates, downloadUpdate, installUpdate } from './updater.js'
import type { TrayState, HealthResult } from './utils/health.js'
import { pollOnce } from './utils/health.js'
import type { DaemonLifecycle, LifecycleProgress } from './lifecycle/types.js'
import { getPlatformLifecycle } from './lifecycle/factory.js'
import { ManageWindow } from './manage-window.js'
import { getWebEndpointConfig, getLockPath, getConfigPath, type WebEndpointConfig } from './utils/profile.js'
import { readFileSync, existsSync } from 'node:fs'
import * as os from 'node:os'
import * as http from 'node:http'
import { TRAY_ICONS, type TrayIconVariant } from './tray-icons.generated.js'
import { PopoverWindow } from './popover.js'
import {
  present, forcePhase, isPhase, projectFromCwd, panelsRegister,
  limitsFromUsage,
  type PopoverAction, type PopoverFacts, type PopoverPanel, type PopoverState, type UpdateNotice,
} from './utils/popover-model.js'
import { recordEvent, getEvents, onEvent, lastAt } from './utils/event-log.js'
import { preferredFailureLine, foreignRegistrationFault } from './utils/daemon-failure.js'
import { shortFailureMessage } from './utils/update-state.js'
import { DAEMON_ACTION_LATCH_TIMEOUT_MS } from './utils/spawn.js'

// Tray icon can also be 'starting'/'stopping' (yellow/red icon, distinct
// tooltip), which is why this is a view state and not the raw health state.
type TrayViewState = TrayState | 'starting' | 'stopping'

// ── Tray icons ────────────────────────────────────────────────────────────
//
// EVERY variant is a template image: macOS masks it to its alpha, derives the
// colour from the menu bar it is drawing into, and highlights it correctly.
// State is therefore carried by the badge's SHAPE, never by colour.
//
// A colour flag on a non-template composite was built first and failed live:
// nativeTheme.shouldUseDarkColors reports the SYSTEM APPEARANCE, but macOS
// tints the menu bar from the desktop picture's luminance, so a light-appearance
// user with a dark wallpaper got a near-invisible dark glyph on a dark menu bar.
// See docs/superpowers/specs/2026-08-07-tray-icon-states-design.md D2.

function buildIcon(variant: TrayIconVariant): Electron.NativeImage {
  const { x1, x2 } = TRAY_ICONS[variant]
  const image = nativeImage.createEmpty()
  image.addRepresentation({ scaleFactor: 1.0, buffer: Buffer.from(x1, 'base64') })
  image.addRepresentation({ scaleFactor: 2.0, buffer: Buffer.from(x2, 'base64') })
  image.setTemplateImage(true)
  return image
}

/** green is the quiet, healthy case; yellow and red carry a badge. */
function variantForState(state: TrayState): TrayIconVariant {
  if (state === 'green') return 'quiet'
  if (state === 'yellow') return 'attention'
  return 'down'
}

/** The machine name the daemon connects under — the same field the wizard's
 *  finish screen reads, so the popover and the wizard cannot disagree. */
function machineName(): string {
  try {
    const p = getConfigPath()
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
      if (typeof raw['name'] === 'string' && raw['name']) return raw['name']
    }
  } catch { /* unreadable settings — the hostname is a truthful fallback */ }
  return os.hostname().replace(/\.local$/, '')
}

/** Resolve both the identity shown by the popover and the destinations behind
 * its browser actions in one pass through the strict profile contract. */
function resolvedWebEndpoints(): WebEndpointConfig | null {
  try {
    return getWebEndpointConfig()
  } catch {
    // A named profile without a complete valid endpoint contract still gets
    // local lifecycle controls, but it never falls through to production URLs.
    return null
  }
}

// ── TrayController ────────────────────────────────────────────────────────

export class TrayController {
  private readonly tray: Tray
  private readonly icons: Record<TrayIconVariant, Electron.NativeImage>
  private viewState: TrayViewState = 'red'
  private lastHealth: HealthResult | null = null
  private activePanels = 0
  private authFailed = false
  /** The daemon's sentence about a launchd registration that is not ours (#577),
   *  from the last start attempt. Not a health reading: no poll can change what
   *  launchd has registered, so it is set and cleared by start outcomes only. */
  private foreignRegistration: string | null = null
  private actionInFlight = false  // lock: prevents concurrent start/stop
  private actionTimer: ReturnType<typeof setTimeout> | null = null
  private readonly manageWindow = new ManageWindow()
  private readonly popover = new PopoverWindow()
  private update: UpdateNotice = { kind: 'none' }
  private disposeEventLog: (() => void) | null = null

  constructor(
    private readonly onQuit: () => void,
    private readonly lifecycle: DaemonLifecycle,
    private readonly healthPort: number,
  ) {
    this.icons = {
      quiet:     buildIcon('quiet'),
      attention: buildIcon('attention'),
      down:      buildIcon('down'),
    }
    this.tray = new Tray(this.icons[variantForState('red')])
    this.tray.setTitle('J')
    this.tray.setToolTip('jerico — daemon offline')

    // The NSMenu is gone. Both buttons open the popover, which is the surface
    // that holds every verb the menu had plus the readings a menu could not.
    this.tray.on('click', () => { this.popover.toggle(this.tray) })
    this.tray.on('right-click', () => { this.popover.toggle(this.tray) })

    this.registerPopoverIpc()
    // Load the popover's renderer while the user is doing something else, so
    // the first click is a show() and not a cold start. See PopoverWindow.prewarm.
    this.popover.prewarm()
    this.disposeEventLog = onEvent(() => { this.pushPopover() })
    recordEvent('desktop.tray.ready', `profile ${String(process.env['BRIDGE_PROFILE'] ?? 'prod')}`)
    this.pushPopover()
  }

  /** Called by the health poller on every non-suppressed tick. */
  setState(result: HealthResult): void {
    this.activePanels = result.activePanels
    this.authFailed = result.authFailed
    this.lastHealth = result

    // Only override a transition if we got a definitive response.
    if (this.viewState === 'starting' && result.state !== 'green') { this.pushPopover(); return }
    if (this.viewState === 'stopping' && result.state !== 'red') { this.pushPopover(); return }

    if (result.state !== this.viewState) {
      // Real, observed, timestamped — the only kind of line this log carries.
      recordEvent(
        'health.state',
        `${String(this.viewState)} → ${result.state}`,
        result.state === 'green' ? '' : result.state === 'yellow' ? 'warn' : 'bad',
      )
    }
    this.applyViewState(result.state)
    this.pushPopover()
  }

  /** Synchronously set 'starting' before awaiting lifecycle.start(), preventing red flash. */
  setStarting(): void {
    this.applyViewState('starting')
  }

  /**
   * Called by updater when update-available / update-not-available fires.
   * version = semver string → shows the notice at the top of the popover.
   * version = null → clears it.
   */
  setUpdateAvailable(version: string | null): void {
    this.update = version === null ? { kind: 'none' } : { kind: 'available', version }
    if (version !== null) recordEvent('updater.available', version)
    this.tray.setToolTip(this.buildTooltip())
    this.pushPopover()
  }

  /** Download progress and readiness, so the notice can carry its own rule that
   *  fills instead of sending the user to a second window to watch a number. */
  setUpdateProgress(percent: number, version: string | null): void {
    this.update = { kind: 'downloading', version, percent }
    this.pushPopover()
  }

  setUpdateStarting(version: string | null): void {
    this.update = { kind: 'downloading', version, percent: 0 }
    this.pushPopover()
  }

  setUpdateError(version: string | null, message: string): void {
    const concise = shortFailureMessage(message)
    this.update = version ? { kind: 'failed', version, message: concise } : { kind: 'none' }
    this.pushPopover()
  }

  setUpdatePreparing(version: string): void {
    this.update = { kind: 'preparing', version }
    this.pushPopover()
  }

  setUpdateReady(version: string): void {
    this.update = { kind: 'ready', version }
    recordEvent('updater.downloaded', version)
    this.tray.setToolTip(this.buildTooltip())
    this.pushPopover()
  }

  destroy(): void {
    if (this.actionTimer) { clearTimeout(this.actionTimer); this.actionTimer = null }
    this.disposeEventLog?.()
    this.disposeEventLog = null
    this.popover.destroy()
    this.manageWindow.destroy()
    this.tray.destroy()
  }

  // ── the popover ─────────────────────────────────────────────────────────

  private registerPopoverIpc(): void {
    // removeHandler first: startTray() can run more than once in a session
    // (the permission gate re-check calls it again after a successful heal),
    // and a second handle() on the same channel throws.
    ipcMain.removeHandler('popover:action')
    ipcMain.handle('popover:action', (_e, action: PopoverAction) => { this.runAction(action) })

    ipcMain.removeHandler('popover:resize')
    ipcMain.handle('popover:resize', (_e, height: number) => { this.popover.resizeTo(height) })

    ipcMain.removeHandler('popover:close')
    ipcMain.handle('popover:close', () => { this.popover.hide() })

    // Main watches Escape itself (a crashed renderer would swallow the key), so
    // it has to know when a nested view is up or it would close the card out
    // from under a user who asked to step back.
    ipcMain.removeHandler('popover:set-nested')
    ipcMain.handle('popover:set-nested', (_e, nested: boolean) => { this.popover.setNested(nested === true) })

    ipcMain.removeHandler('popover:request-state')
    ipcMain.handle('popover:request-state', () => {
      this.pushPopover()
      this.popover.onRendererReady()
    })
  }

  /** Every reading the popover shows, assembled from what is actually known.
   *  Anything the daemon does not report leaves here as null and is drawn as an
   *  em dash — this method is the one place that could invent a number, so it
   *  is the one place that must not. */
  private popoverState(): PopoverState {
    const h = this.lastHealth
    const endpoints = resolvedWebEndpoints()
    const transition =
      this.viewState === 'starting' ? 'starting' as const
      : this.viewState === 'stopping' ? 'stopping' as const
      : null

    const stoppedAt = lastAt('daemon.stopped')
    const facts: PopoverFacts = {
      state: this.viewState === 'starting' ? 'yellow'
           : this.viewState === 'stopping' ? 'red'
           : this.viewState,
      transition,
      authFailed: this.authFailed,
      // Only while this app can actually see the daemon: a stale reason from
      // the last poll must not survive the daemon going away entirely.
      endpointRejectedReason: h?.endpointRejectedReason ?? null,
      endpointRepairCommand: h?.endpointRepairCommand ?? null,
      foreignRegistrationReason: this.foreignRegistration,
      activePanels: this.activePanels,
      reconnectAttempts: h?.reconnectAttempts ?? 0,
      uptimeSeconds: h?.uptimeSeconds ?? null,
      lastRttMs: h?.lastRttMs ?? null,
      lastPongAgoMs: h?.lastPongAgoMs ?? null,
      rttHistory: h?.rttHistory ?? null,
      healthPort: this.healthPort,
      stoppedAgoMs: stoppedAt === null || this.viewState !== 'red' ? null : Date.now() - stoppedAt,
      webAvailable: endpoints !== null,
    }

    // Development only, and unreachable in a packaged app: four of the seven
    // states cannot be produced on demand, so this lets each one be opened and
    // reviewed. It bends the health inputs and nothing else — every string
    // below still comes out of the real present().
    const forcedName = process.env['JERICO_POPOVER_STATE']
    const forced = !app.isPackaged && forcedName !== undefined && isPhase(forcedName)
      ? forcePhase(facts, forcedName)
      : facts
    const presentation = present(forced)

    // The forced mode moves activePanels, so the register has to move with it
    // or the headline says "Idle · no panels open" over two live rows. Trimming
    // the real list rather than fabricating rows: the rows that show are still
    // real panels with real cwds.
    const reported = (h?.panels ?? []).slice(0, forced.activePanels === facts.activePanels
      ? undefined
      : forced.activePanels)

    const panels: PopoverPanel[] = reported.map((p) => ({
      key: p.agentId,
      agent: p.agentKey,
      project: projectFromCwd(p.cwd),
      cwd: p.cwd,
      contextPct: p.usagePct,
      hook: p.hook,
      startupGate: p.startupGate,
      startupGateSupport: p.startupGateSupport,
    }))

    return {
      presentation,
      machine: machineName(),
      server: endpoints?.serverHost ?? 'configuration required',
      appVersion: app.getVersion(),
      daemonVersion: h?.daemonVersion ?? null,
      panels,
      panelsView: panelsRegister(panels),
      contentBudget: this.popover.contentBudget(),
      limits: limitsFromUsage(h?.usage ?? null),
      events: getEvents().map((e) => ({ at: e.at, event: e.event, detail: e.detail, level: e.level })),
      update: this.update,
      busy: this.actionInFlight,
      rttHistory: h?.rttHistory ?? null,
      lastRttMs: h?.lastRttMs ?? null,
    }
  }

  private pushPopover(): void {
    this.popover.setState(this.popoverState())
  }

  private runAction(action: PopoverAction): void {
    switch (action) {
      case 'open-jerico':
        this.openConfiguredWebEndpoint('homeUrl')
        return
      case 'reauth':
        this.openConfiguredWebEndpoint('connectPageUrl')
        return
      case 'start':
        void this.handleStart()
        return
      case 'stop':
        void this.handleStop()
        return
      case 'reconnect':
        void this.handleReconnect()
        return
      case 'reregister-service':
        void this.handleReregister()
        return
      case 'manage':
        this.popover.hide()
        this.manageWindow.open()
        return
      case 'updates':
        this.popover.hide()
        checkForUpdates()
        return
      case 'update-download':
        downloadUpdate()
        return
      case 'update-install':
        installUpdate()
        return
      case 'logs': {
        this.popover.hide()
        const { out } = getPlatformLifecycle(this.healthPort).logsPath()
        void shell.openPath(out)
        return
      }
      case 'quit':
        this.popover.hide()
        this.onQuit()
        return
    }
  }

  // ── state ───────────────────────────────────────────────────────────────

  private openConfiguredWebEndpoint(target: 'homeUrl' | 'connectPageUrl'): void {
    const endpoints = resolvedWebEndpoints()
    if (!endpoints) {
      recordEvent('endpoint.configuration.required', 'browser action blocked for this profile', 'warn')
      this.pushPopover()
      return
    }
    this.popover.hide()
    void shell.openExternal(endpoints[target])
  }

  /** Latch the start/stop lock with a hard safety release so the popover can
   *  never stick busy. */
  private beginAction(): void {
    this.actionInFlight = true
    this.pushPopover()
    if (this.actionTimer) clearTimeout(this.actionTimer)
    this.actionTimer = setTimeout(() => {
      this.actionInFlight = false
      this.actionTimer = null
      this.pushPopover()
    }, DAEMON_ACTION_LATCH_TIMEOUT_MS)
  }

  private endAction(): void {
    this.actionInFlight = false
    if (this.actionTimer) { clearTimeout(this.actionTimer); this.actionTimer = null }
    this.pushPopover()
  }

  private applyViewState(viewState: TrayViewState): void {
    if (viewState === this.viewState) return
    this.viewState = viewState
    const state: TrayState =
      this.viewState === 'starting' ? 'yellow'
      : this.viewState === 'stopping' ? 'red'
      : this.viewState
    this.tray.setImage(this.icons[variantForState(state)])
    this.tray.setToolTip(this.buildTooltip())
    // Keep text label in sync so the tray stays visible even if the icon is hidden
    this.tray.setTitle(viewState === 'green' ? '' : 'J')
  }

  private statusLabel(): string {
    switch (this.viewState) {
      case 'green':    return 'connected'
      case 'yellow':   return this.authFailed ? 'auth failed — re-authenticate' : 'daemon running, not connected'
      case 'starting': return 'starting…'
      case 'stopping': return 'stopping…'
      case 'red':      return 'daemon offline'
    }
  }

  private buildTooltip(): string {
    if (this.update.kind === 'ready') return 'jerico — update ready to install'
    if (this.update.kind === 'available') return 'jerico — update available'
    return `jerico — ${this.statusLabel()}`
  }

  /** Main's popover already owns long-action presentation. Feed the restart
   * callback into its existing transition vocabulary and event register rather
   * than resurrecting the deleted ActionProgress window. */
  private showLifecycleProgress(progress: LifecycleProgress): void {
    if (progress.stage === 'stopping') this.applyViewState('stopping')
    else this.applyViewState('starting')
    recordEvent(`lifecycle.restart.${progress.stage}`, progress.message, 'warn')
    this.pushPopover()
  }

  /**
   * Both wait loops poll the same endpoint the background poller polls, and
   * used to keep only `state` from the answer — so every reading beside it
   * (the panel count above all) stayed at whatever the last background tick
   * left behind. A start took the tray from a stale 2 straight to green, and
   * the surface said "2 panels" over a daemon that had just been born with
   * none, until the next tick corrected it seconds later.
   *
   * These polls are the freshest readings the app has during a transition, so
   * they now go through setState like any other. Its own guards do the right
   * thing here: mid-'starting' a non-green answer updates the readings without
   * touching the view, which is exactly what a transition wants.
   */
  private async pollDuringTransition(): Promise<TrayState> {
    const result = await pollOnce(this.healthPort)
    this.setState(result)
    return result.state
  }

  /** Poll health until connected (green) or timeout. Returns the final state. */
  private async waitForHealthy(timeoutMs: number): Promise<TrayState> {
    const deadline = Date.now() + timeoutMs
    let last: TrayState = 'red'
    while (Date.now() < deadline) {
      const state = await this.pollDuringTransition()
      last = state
      if (state === 'green') return 'green'
      await new Promise<void>((r) => setTimeout(r, 800))
    }
    return last
  }

  /** Poll health until the daemon is down (no response / red) or timeout. */
  private async waitForDown(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await this.pollDuringTransition()
      if (state === 'red') return true
      await new Promise<void>((r) => setTimeout(r, 500))
    }
    return false
  }

  /**
   * Record — or clear — what a start attempt said about the launchd registration.
   *
   * Clearing on any start that did NOT report it is the whole reason this is a
   * function: a fault the user has repaired must leave the surface, and the only
   * evidence that it is gone is a start that no longer complains about it.
   */
  private noteStartOutcome(stderr: string): void {
    const fault = foreignRegistrationFault(stderr)
    if (fault) {
      if (this.foreignRegistration !== fault.message) {
        recordEvent('launchd.registration.foreign', fault.message, 'bad')
      }
      this.foreignRegistration = fault.message
      return
    }
    if (this.foreignRegistration !== null) {
      this.foreignRegistration = null
      recordEvent('launchd.registration.ours', 'the login service points at this install', '')
    }
  }

  /**
   * Replace a foreign launchd registration, on purpose, with consent.
   *
   * `bridge-agent restart` is the only thing that repairs it (launchd will not
   * re-read the plist file of a bootstrapped label), and it stops the running
   * daemon and every PTY session with it. That is why this is a button and not
   * something a start path does on its own — see the popover's foreignregistration
   * phase, and mac-launchd.ts's doStart().
   */
  private async handleReregister(): Promise<void> {
    if (this.actionInFlight) return

    this.popover.hide()
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Re-register and restart'],
      defaultId: 0,
      cancelId: 0,
      message: 'Re-register the login service?',
      detail: this.activePanels > 0
        ? `macOS has this login service registered against a different install of the daemon, so it keeps launching that one. Repairing it restarts the daemon — the ${String(this.activePanels)} running panel(s) will be stopped.`
        : 'macOS has this login service registered against a different install of the daemon, so it keeps launching that one. Repairing it restarts the daemon; any running agents will be stopped.',
    })
    if (response !== 1) return

    this.beginAction()
    recordEvent('launchd.registration.reregister.requested', 'from the popover', 'warn')
    try {
      const result = await this.lifecycle.reregister((progress) => { this.showLifecycleProgress(progress) })
      if (result.code !== 0) {
        recordEvent(
          'launchd.registration.reregister.failed',
          preferredFailureLine(result.stderr) ?? 'no detail',
          'bad',
        )
        // The registration is still whatever it was; leave the surface saying so.
        this.applyViewState(this.lastHealth?.state ?? 'red')
        return
      }
      // `restart` re-probes the loaded Program before exiting 0 (restart.ts Phase 5),
      // so a zero exit here IS the evidence that the registration is ours now.
      this.foreignRegistration = null
      recordEvent('launchd.registration.reregister.ok', 'the login service now points at this install')
      this.applyViewState(this.lastHealth?.state ?? 'yellow')
      await this.pollDuringTransition()
    } catch (err) {
      recordEvent(
        'launchd.registration.reregister.failed',
        err instanceof Error ? err.message : 'unknown error',
        'bad',
      )
      this.applyViewState(this.lastHealth?.state ?? 'red')
    } finally {
      this.endAction()
    }
  }

  private async handleStart(): Promise<void> {
    if (this.actionInFlight || this.viewState !== 'red') return
    this.beginAction()
    this.setStarting()
    // The separate progress window is gone: a start no longer opens a second
    // window over the desktop, because the surface that asked for it is the
    // surface that reports it.
    recordEvent('lifecycle.start.requested', 'from the popover')
    this.pushPopover()

    try {
      const result = await this.lifecycle.start((progress) => { this.showLifecycleProgress(progress) })
      this.noteStartOutcome(result.stderr)
      if (result.code !== 0) {
        // preferredFailureLine, not `.pop()`: the daemon prints its humanised
        // sentence FIRST and the machine reason second (start.ts start.failed /
        // start.failed.detail), so taking the last line showed the code and threw
        // the sentence away — for every failure mode, not just this one.
        recordEvent('lifecycle.start.failed', preferredFailureLine(result.stderr) ?? 'no detail', 'bad')
        this.applyViewState('red')
        return
      }
      recordEvent('launchd.kickstart', 'waiting for the health port')
      const state = await this.waitForHealthy(12_000)
      if (state === 'green') {
        this.applyViewState('green')
        recordEvent('daemon.connected', resolvedWebEndpoints()?.serverHost ?? 'configured daemon')
      } else {
        // Running but not yet connected — leave the poller to track it.
        recordEvent('daemon.started', 'connecting…', 'warn')
        this.applyViewState(state)
      }
    } catch (err) {
      recordEvent('lifecycle.start.failed', err instanceof Error ? err.message : 'unknown error', 'bad')
    } finally {
      this.endAction()
    }
  }

  /** Auto-ensure stays silent for an already-current daemon. A version-skew
   * restart emits progress, which the popover exposes as stopping/starting
   * state plus detailed event rows while the derived action latch stays held. */
  async ensureDaemonWithProgress(): Promise<void> {
    if (this.actionInFlight) return
    this.beginAction()
    let progressSeen = false

    try {
      const result = await this.lifecycle.start((progress) => {
        progressSeen = true
        this.showLifecycleProgress(progress)
      })
      // Before the progressSeen shortcut: an ensure on a machine with a foreign
      // registration produces no progress at all (start fails immediately), so
      // returning early here is exactly how that population used to reach the tray
      // with nothing said. The registration verdict is read on every ensure.
      this.noteStartOutcome(result.stderr)
      if (!progressSeen) {
        if (result.code !== 0 && this.foreignRegistration !== null) {
          // The popover's foreignregistration phase now carries it, with the button.
          this.pushPopover()
          return
        }
        if (result.stderr) console.warn('[jerico-desktop] daemon ensure:', result.stderr.trim())
        return
      }
      if (result.code !== 0) {
        recordEvent(
          'lifecycle.restart.failed',
          preferredFailureLine(result.stderr) ?? 'Failed to replace daemon',
          'bad',
        )
        this.applyViewState('red')
        return
      }

      recordEvent('lifecycle.restart.completed', 'replacement daemon is ready')
      // Clear the synthetic transition before refreshing from health; otherwise
      // setState intentionally preserves it until a definitive transition ends.
      this.applyViewState(this.lastHealth?.state ?? 'yellow')
      await this.pollDuringTransition()
    } catch (err) {
      recordEvent(
        'lifecycle.restart.failed',
        err instanceof Error ? err.message : 'Failed to replace daemon',
        'bad',
      )
      if (progressSeen) this.applyViewState(this.lastHealth?.state ?? 'yellow')
      else console.warn('[jerico-desktop] daemon ensure failed:', err)
    } finally {
      this.endAction()
    }
  }

  /**
   * Force an immediate WS reconnect via the daemon's token-gated /reconnect RPC.
   * Preserves live PTY sessions (unlike a Stop→Start restart). The token is the
   * 0600 shutdownToken minted in the daemon lock file.
   */
  private async handleReconnect(): Promise<void> {
    if (this.actionInFlight) return
    let token = ''
    try {
      const raw = readFileSync(getLockPath(), 'utf-8')
      token = (JSON.parse(raw) as { shutdownToken?: string }).shutdownToken ?? ''
    } catch (err) {
      console.error('[jerico-desktop] reconnect: cannot read daemon lock token', err)
      recordEvent('ws.reconnect.failed', 'no daemon lock to authenticate with', 'bad')
      return
    }
    if (!token) {
      console.error('[jerico-desktop] reconnect: no shutdown token in lock')
      recordEvent('ws.reconnect.failed', 'lock file carries no token', 'bad')
      return
    }

    this.beginAction()
    recordEvent('ws.reconnect.requested', 'from the popover', 'warn')
    try {
      await this.postReconnect(token)
      // The next health poll (≤5s) flips the tray to green once the dial lands.
    } catch (err) {
      console.error('[jerico-desktop] reconnect request failed', err)
      recordEvent('ws.reconnect.failed', err instanceof Error ? err.message : 'request failed', 'bad')
    } finally {
      this.endAction()
    }
  }

  private postReconnect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.healthPort,
          path: `/reconnect?token=${encodeURIComponent(token)}`,
          method: 'POST',
          timeout: 4000,
        },
        (res) => {
          res.resume()  // drain the response so the socket frees
          if (res.statusCode === 200) resolve()
          else reject(new Error(`/reconnect returned ${res.statusCode ?? 'no status'}`))
        },
      )
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(new Error('/reconnect timed out')) })
      req.end()
    })
  }

  private async handleStop(): Promise<void> {
    if (this.actionInFlight) return
    if (this.viewState !== 'green' && this.viewState !== 'yellow') return

    if (this.activePanels > 0) {
      // A modal over a popover would leave the popover behind it and the popover
      // closes on blur, so hide it first — the question is the whole interaction
      // now, and the answer reopens nothing the user did not ask for.
      this.popover.hide()
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Cancel', 'Stop daemon'],
        defaultId: 0,  // Cancel is default
        message: 'Active panels are open',
        detail: `${this.activePanels} panel(s) are currently active. Stopping the daemon will terminate them.`,
      })
      if (response !== 1) return
    }

    this.beginAction()
    this.applyViewState('stopping')
    recordEvent('lifecycle.stop.requested', 'from the popover')
    this.pushPopover()

    try {
      // Fire the stop but DON'T block on the command exiting: the daemon dies
      // promptly (launchctl kill), yet `bridge-agent stop` can linger if the
      // daemon's SIGTERM handler schedules a reconnect before exiting. Treat the
      // daemon disappearing from the health endpoint as the real success signal.
      // NOTE: this uses lifecycle.stop() (persistent, job stays loaded) —
      // not shutdownForQuit() which bootouts. The tray stop allows restart
      // via enable+kickstart without re-bootstrap latency.
      const stopResult = this.lifecycle.stop()
      stopResult.catch(() => { /* surfaced via health below */ })

      const down = await this.waitForDown(10_000)
      if (down) {
        this.applyViewState('red')
        recordEvent('daemon.stopped', 'health endpoint unreachable')
      } else {
        const result = await stopResult
        if (result.code === 0) {
          this.applyViewState('red')
          recordEvent('daemon.stopped', 'stop command returned 0')
        } else {
          console.error('[jerico-desktop] stop failed', result.stderr)
          recordEvent('lifecycle.stop.failed', preferredFailureLine(result.stderr) ?? 'no detail', 'bad')
          // The daemon is still up; let the poller repaint from the truth.
          this.applyViewState(this.lastHealth?.state ?? 'yellow')
        }
      }
    } catch (err) {
      recordEvent('lifecycle.stop.failed', err instanceof Error ? err.message : 'unknown error', 'bad')
      this.applyViewState(this.lastHealth?.state ?? 'yellow')
    } finally {
      this.endAction()
    }
  }
}
