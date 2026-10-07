import { app, BrowserWindow, screen, type Tray } from 'electron'
import * as path from 'node:path'
import type { PopoverState } from './utils/popover-model.js'

/** The design's width, in points, and it is not negotiable: the panel rows, the
 *  heartbeat strip's fixed 0–400 ms scale and the 33px headline were all drawn
 *  against it. */
export const POPOVER_WIDTH = 368

/** Room for the notch above the card and the drop shadow around it. The window
 *  is transparent, so this padding is invisible — it exists so the shadow has
 *  somewhere to fall and the notch has somewhere to point from.
 *
 *  This number and the `.pop` box-shadow in Popover.svelte are ONE constraint
 *  in two files: the shadow has to reach zero within this many points, because
 *  the window rect clips whatever is left and a clipped gradient is a flat
 *  rectangle with a straight edge — invisible over a dark wallpaper, an opaque
 *  near-white sheet over a bright one. The shadow there is tuned to this 22;
 *  lowering it re-clips the shadow, and neither value can move alone. The note
 *  on `.pop` has the measurement to re-run. */
const SHADOW_PAD = 22
const NOTCH_H = 7

/** Until the renderer measures itself. Chosen so the first paint is not a
 *  visibly wrong shape that then jumps. */
const INITIAL_HEIGHT = 560

/**
 * The menu-bar popover.
 *
 * Replaces `tray.setContextMenu()`. NSMenu gave keyboard navigation, dismissal,
 * VoiceOver roles and an opaque Reduce-Transparency fallback for free; a
 * BrowserWindow gives none of them, so each is built explicitly — the keyboard
 * model and the roles live in the renderer, dismissal here, and the opaque
 * fallback is now the only rendering there is (see the window options below).
 */
export class PopoverWindow {
  private window: BrowserWindow | null = null
  private lastState: PopoverState | null = null
  /** True while the card shows a view the renderer folds back on Escape. */
  private nested = false
  private anchorCenterX = 0
  private ready = false
  /** Set while hide() runs so the blur handler cannot re-enter it. */
  private hiding = false
  /** What isOpen() answers. Kept here rather than asked of the window, for the
   *  reason spelled out on isOpen(). */
  private visible = false

  /**
   * Our own record of whether the card is up.
   *
   * NOT `win.isVisible()`. hide() calls `app.hide()` when no other window is
   * visible (an accessory app returns activation to whatever the user was in),
   * and a window inside a hidden app can still report `isVisible() === true`.
   * Toggling off that reading made the SECOND tray click hide an invisible card
   * and the third one open it — the "click it a few times and it appears" bug.
   */
  isOpen(): boolean {
    return this.visible
  }

  /**
   * Build the window and load its renderer NOW, before anyone clicks.
   *
   * ensureWindow() used to run only from show(), which meant the first click of
   * a session paid for creating a BrowserWindow, spawning a renderer, parsing
   * the bundle and loading the fonts — measured as a 1–2 second wait. And
   * because the window is transparent and the card draws nothing until its
   * first state arrives, that wait was spent looking at NOTHING: a spinner
   * cannot help, since there is no visible surface to put one on.
   *
   * The cost is one hidden renderer process from launch. For a menu-bar app
   * whose entire value is being there the instant you reach for it, that is the
   * right side of the trade.
   */
  prewarm(): void {
    this.ensureWindow()
  }

  /** Left-click and right-click both land here. A second click closes it, the
   *  way clicking an open menu extra does. */
  toggle(tray: Tray): void {
    if (this.isOpen()) { this.hide(); return }
    this.show(tray)
  }

  show(tray: Tray): void {
    const win = this.ensureWindow()
    this.position(tray, win)
    if (this.lastState) this.push(this.lastState)
    // ACTIVATE BEFORE SHOWING. hide() hides the whole app (see hide()), and
    // `win.show()` on a hidden app puts the window in a state where nothing is
    // drawn — while still reporting itself visible. Ordering it after the
    // activation is what makes the first click after a dismissal work.
    //
    // The dock is hidden, so this is an accessory app: showing a window does
    // not make the app active, and without that the renderer's focus() lands in
    // a window that receives no key events at all. `steal` is the documented
    // way for a menu-bar app to take the keyboard on a user gesture — and this
    // only ever runs because the user just clicked the tray icon.
    app.focus({ steal: true })
    win.show()
    win.focus()
    this.visible = true
    win.webContents.send('popover:opened')
  }

  hide(): void {
    if (this.hiding) return
    // BEFORE the early return, deliberately. The window can be GONE — `role: 'close'`
    // in app-menu.ts is Cmd+W and this card is the key window while open — and the
    // guard below used to return first, leaving `visible` stuck true with no window
    // to hide. isOpen() then answered true forever and every tray click took the
    // hide branch: the menu-bar icon was dead for the rest of the session, which is
    // strictly worse than the several-clicks bug this flag was introduced to fix.
    this.visible = false
    this.clearNested()
    const win = this.window
    if (!win || win.isDestroyed()) return
    this.hiding = true
    try {
      // Tell the renderer it is gone. Without this the usage view stayed mounted
      // behind a hidden window, holding a 30-second provider poll and a 1-second
      // clock for a surface nobody was looking at.
      if (this.ready) win.webContents.send('popover:hidden')
      win.hide()
      // NSMenu returns key focus to the menu bar on dismiss. A BrowserWindow
      // cannot focus a tray item — Electron exposes no handle for one — so the
      // closest true equivalent is to stop being the key window, which returns
      // activation to whatever the user was in before they reached up to the
      // menu bar. That is where they want to be typing next.
      const others = BrowserWindow.getAllWindows().filter((w) => w !== win && w.isVisible())
      if (others.length === 0 && process.platform === 'darwin' && app.isReady()) app.hide()
    } finally {
      this.hiding = false
    }
  }

  /** Push a fresh reading. Kept even while closed, so the next open paints the
   *  current state immediately instead of an empty frame. */
  setState(state: PopoverState): void {
    this.lastState = state
    if (this.window && !this.window.isDestroyed() && this.ready) this.push(this.lastState)
  }

  /**
   * The renderer has mounted and asked for its state.
   *
   * `popover:opened` cannot simply be sent from show(): the FIRST open builds
   * the window, so the event races the document's own load and lands in a page
   * with no listeners — which cost the first open of every session its keyboard
   * focus. Sending it in reply to the renderer's own request removes the race
   * from both ends.
   */
  onRendererReady(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    if (this.lastState) this.push(this.lastState)
    win.webContents.send('popover:anchor', { centerX: this.anchorCenterX })
    if (this.visible) win.webContents.send('popover:opened')
  }

  destroy(): void {
    this.window?.destroy()
    this.window = null
    this.ready = false
    this.visible = false
    this.nested = false
  }

  /** The renderer measured its content. The popover is content-height by design
   *  — seven states of genuinely different length, and a fixed height would
   *  either clip the longest or leave a hole under the shortest. */
  /** The renderer entered or left a nested view. */
  setNested(nested: boolean): void {
    this.nested = nested
  }

  /** Any hide leaves the nested view behind: the card always reopens on its main
   *  view, so a stale flag here would swallow the first Escape of the next open. */
  private clearNested(): void {
    this.nested = false
  }

  /**
   * The content height the card may reach before resizeTo starts clipping it.
   * Same display and same arithmetic as resizeTo, so the renderer sheds against
   * the bound that will actually be applied rather than against a guess.
   */
  contentBudget(): number {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    return Math.max(200, display.workArea.height - 24 - SHADOW_PAD - NOTCH_H)
  }

  resizeTo(contentHeight: number): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const maxH = display.workArea.height - 24
    const h = Math.max(200, Math.min(Math.ceil(contentHeight) + SHADOW_PAD + NOTCH_H, maxH))
    const b = win.getBounds()
    if (b.height === h) return
    win.setBounds({ ...b, height: h }, false)
  }

  private push(state: PopoverState): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    win.webContents.send('popover:state', state)
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window

    const preloadPath = path.join(__dirname, '../preload/index.js')
    const win = new BrowserWindow({
      width: POPOVER_WIDTH + SHADOW_PAD * 2,
      height: INITIAL_HEIGHT,
      show: false,
      frame: false,
      // Otherwise it inherits index.html's <title> and reports itself to Mission
      // Control and the accessibility tree as "Jerico — setup" — the wizard's
      // name, on a window that is not the wizard.
      title: 'Jerico',
      // The window is transparent so the card can have rounded corners, a notch
      // that points at the tray icon, and a drop shadow it draws itself. The
      // CARD is not: see the note on vibrancy below.
      transparent: true,
      // The card draws its own shadow so it can follow the 10px radius and the
      // notch. A system shadow on a transparent window traces the window RECT,
      // which would put a square shadow behind a rounded card.
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Above ordinary windows but below the menu bar, and present on whichever
      // space the user is on — a menu extra that opens on space 1 when you
      // clicked it on space 3 is a bug, not a window.
      alwaysOnTop: true,
      // NO VIBRANCY, and the card paints opaque.
      //
      // `vibrancy: 'popover'` was tried and reverted. On macOS the material is
      // an NSVisualEffectView filling the window's whole content rect, and it
      // does not clip to the card's rounded shape — so the 22pt of padding the
      // card's own shadow falls into became a blurred pane on every side. Over
      // a bright page that padding read as a milky halo around the card, and
      // the card's 82%-opaque ground lifted with it. design/README.md flagged
      // this composition as unverified; it does not compose, and this is that
      // fallback being taken.
      //
      // What it costs: the native popover blur. An instrument that reads the
      // same over any wallpaper is worth more than a material that tints its
      // own ground with whatever is behind it — and being unconditionally
      // opaque is also a stronger answer to Reduce Transparency than a branch
      // that has to be kept in step with a second rendering.
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setAlwaysOnTop(true, 'pop-up-menu')

    // A menu extra is not a window the user manages, so it does not belong in the
    // list of windows. `skipTaskbar` above is the Windows half of that and does
    // nothing here. Without this the popover appeared among the app's windows
    // under index.html's title, "Jerico — setup" — a screen it is not.
    win.excludedFromShownWindowsMenu = true

    // The page's <title> replaces the window's the moment it loads, and every
    // window here loads the same index.html — which is why this title was
    // silently becoming "Jerico — setup" shortly after being set.
    win.on('page-title-updated', (e) => { e.preventDefault() })


    // Menu dismissal: clicking anywhere else closes it. This is the behaviour
    // NSMenu had and the one thing users will not tolerate its absence of.
    // Same source of truth as isOpen(): a window inside a hidden app can report
    // itself visible, and hiding on that reading is how the flag drifted.
    win.on('blur', () => { if (this.visible) this.hide() })

    // Escape is handled in the renderer, but a renderer that has crashed or is
    // still loading would swallow it — so main watches for it too. Both paths
    // end in the same hide().
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      // A nested view handles its own Escape by stepping back. Hiding here as
      // well would close the card out from under a user who asked to go back —
      // and the renderer has already told us which view is up.
      if (this.nested) return
      this.hide()
    })

    win.webContents.on('did-finish-load', () => {
      this.ready = true
      if (this.lastState) this.push(this.lastState)
      win.webContents.send('popover:anchor', { centerX: this.anchorCenterX })
    })

    // `closed`, not `hide`: Cmd+W destroys the window without going through hide(),
    // and a flag left set here is the latch described above. Anything that ends the
    // window ends the flag with it.
    win.on('closed', () => {
      this.window = null
      this.ready = false
      this.visible = false
      this.nested = false
    })

    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) {
      void win.loadURL(`${rendererUrl}#popover`)
    } else {
      void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'popover' })
    }

    this.window = win
    return win
  }

  /** Centre the card under the tray icon, clamped to the display it is on, and
   *  tell the renderer where the notch has to point. */
  private position(tray: Tray, win: BrowserWindow): void {
    const trayBounds = tray.getBounds()
    const outerW = POPOVER_WIDTH + SHADOW_PAD * 2

    // Only the HORIZONTAL half of tray.getBounds() is trustworthy. Measured on
    // a single 1440×900 display whose menu bar occupies y 0–30, it returned
    // y:-62 — a value no menu extra can have. The x it returns is sound, and it
    // is the one that matters: the vertical answer is always the same, namely
    // just below the menu bar, which the work area states exactly.
    const display = screen.getDisplayNearestPoint({
      x: trayBounds.width > 0 ? trayBounds.x + Math.floor(trayBounds.width / 2) : 0,
      // Sampled at the top of the screen rather than at the tray's own y, which
      // is the value being distrusted.
      y: 0,
    })
    const area = display.workArea

    // With no usable tray bounds at all — Electron can return an empty rect
    // before the icon has been laid out — a menu extra lives at the right end
    // of the bar, which is where this app's is.
    const trayCenter = trayBounds.width > 0
      ? trayBounds.x + trayBounds.width / 2
      : area.x + area.width - 40

    let x = Math.round(trayCenter - outerW / 2)
    x = Math.max(area.x + 4, Math.min(x, area.x + area.width - outerW - 4))
    const y = area.y + 2

    win.setBounds({ x, y, width: outerW, height: win.getBounds().height }, false)

    // Where the notch sits within the card, so it points at the icon even when
    // the card was clamped away from centre at the edge of a display.
    this.anchorCenterX = Math.round(trayCenter - x)
    if (this.ready) win.webContents.send('popover:anchor', { centerX: this.anchorCenterX })
  }
}
