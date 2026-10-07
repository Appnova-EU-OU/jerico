import { BrowserWindow, app, ipcMain, screen, systemPreferences } from 'electron'
import * as path from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { getIntroSeenPath } from './utils/profile.js'
import { isSetupComplete } from './setup-check.js'
import { introDecision } from './intro-gate.js'
import { firstRunMinimumVisibleMs } from './first-run-policy.js'

/** The complete 07 -> 08 -> 09 flow is 74.6s. This bounds loading as well. */
const HARD_TIMEOUT_MS = 95_000

/** True while the intro window is up. The intro sits at the 'screen-saver'
 *  level and covers the screen, so anything that opens an ordinary window
 *  during it — the updater, reached by a `jerico://update` deep link that
 *  flushes on the tick after launch — opens it underneath, invisible and
 *  unreachable until the film ends. Callers ask before they open. */
let introOnScreen = false
const introEndedWaiters: Array<() => void> = []

export function isIntroOnScreen(): boolean {
  return introOnScreen
}

/** Resolves immediately when no intro is playing, otherwise when it ends. */
export function afterIntro(): Promise<void> {
  if (!introOnScreen) return Promise.resolve()
  return new Promise<void>((resolve) => introEndedWaiters.push(resolve))
}

function setIntroOnScreen(v: boolean): void {
  introOnScreen = v
  if (!v) {
    while (introEndedWaiters.length) introEndedWaiters.shift()?.()
  }
}

/**
 * The first-launch sequence: a transparent, always-on-top window over the live
 * desktop, played once, ever. The opening brand film is mandatory; after its
 * lockup, the renderer exposes one Skip tour action for every remaining scene.
 *
 * It runs BEFORE the permission gate on purpose. The gate is the first thing
 * that asks the user for something, and asking before saying who you are is
 * the wrong order — Dia, whose structure this follows, spends its opening on
 * a credit for exactly this reason. It never starts the daemon, reads the
 * keychain or writes config; it reads settings.json once (via isSetupComplete)
 * and writes one marker file.
 *
 * Every path out of here resolves. A film that can strand someone behind a
 * fullscreen transparent window they cannot click through is worse than no
 * film, so renderer completion, a dead renderer/window, and this timeout are
 * independent exits. Main also accepts Escape after the renderer reports that
 * the mandatory intro has ended; it deliberately ignores it before then.
 */
export async function playIntro(): Promise<void> {
  const seenPath = getIntroSeenPath()

  // The rule lives in intro-gate.ts, tested without Electron — see the comment
  // there for why the seen-flag alone is the wrong test.
  const decision = introDecision({
    seenFlagExists: existsSync(seenPath),
    // Only asked when it can change the answer; it reads settings.json.
    setupComplete: existsSync(seenPath) ? false : isSetupComplete(),
    forced: introForced(),
  })

  if (decision === 'skip') return
  if (decision === 'skip-and-record') {
    markIntroSeen(seenPath)
    return
  }

  // Recorded BEFORE the film plays, not after. If the app is force-quit or
  // crashes mid-intro, the user has still had the experience interrupted once
  // — replaying it on the next launch would be the more annoying failure.
  markIntroSeen(seenPath)

  try {
    await runIntroWindow()
  } catch (err) {
    console.warn('[intro] failed to play', err)
  }
}

function markIntroSeen(seenPath: string): void {
  try {
    mkdirSync(path.dirname(seenPath), { recursive: true })
    writeFileSync(seenPath, `${new Date().toISOString()}\n`, { mode: 0o644 })
  } catch (err) {
    // Can't record it — play anyway and accept the risk of one repeat.
    console.warn('[intro] could not write the seen flag', err)
  }
}

function runIntroWindow(): Promise<void> {
  return new Promise<void>((resolve) => {
    const display = screen.getPrimaryDisplay()
    const { x, y, width, height } = display.bounds
    const workArea = display.workArea
    // The transparent film covers the whole display; controls belong to the
    // usable work area. Preserve a small optical margin after accounting for
    // a Dock placed along the bottom or right edge.
    const skipBottom = Math.max(20, y + height - (workArea.y + workArea.height) + 20)
    const skipRight = Math.max(22, x + width - (workArea.x + workArea.width) + 22)

    const win = new BrowserWindow({
      x, y, width, height,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      // Cmd+W is a real second skip channel through the app menu. Keep native
      // close disabled until main's own clock says the mandatory intro ended.
      closable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Named for the same reason the other windows are: with no Dock tile the
      // title is the identity. Not "Jerico — setup", which is the window that
      // follows this one.
      title: 'Jerico',
      // The film is a dawn breaking over the desktop; the desktop has to be
      // there to break over. An opaque window would make it a splash screen.
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '../preload/intro.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Pinned, not required: Electron 34 already defaults to this
        // (electron.d.ts:17392). The score is synthesised in the page and
        // starts on a timer rather than a click, so if that default ever
        // flips the film would play mute on the one launch that matters —
        // state it rather than inherit it.
        autoplayPolicy: 'no-user-gesture-required',
        // rAF is throttled in occluded/background windows; this one has no
        // chrome to focus and must run at full rate the moment it appears.
        backgroundThrottling: false,
      },
    })

    // Above full-screen apps and every space, so it does not open behind
    // whatever the user happened to be doing when the installer finished.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    let settled = false
    let tourCanSkip = false
    let visibleAt: number | null = null
    let tourReadyRequested = false
    let doneRequested = false
    let hardTimer: NodeJS.Timeout | null = null
    let minimumTimer: NodeJS.Timeout | null = null
    const reducedMotion = systemPreferences.getAnimationSettings().prefersReducedMotion
    const minimumVisibleMs = firstRunMinimumVisibleMs(reducedMotion)
    setIntroOnScreen(true)

    const finish = (): void => {
      if (settled) return
      settled = true
      setIntroOnScreen(false)
      if (hardTimer) clearTimeout(hardTimer)
      if (minimumTimer) clearTimeout(minimumTimer)
      ipcMain.removeListener('intro:done', onDone)
      ipcMain.removeListener('intro:tour-ready', onTourReady)
      if (!win.isDestroyed()) win.destroy()
      resolve()
    }

    const allowTourSkip = (): void => {
      if (settled || tourCanSkip) return
      tourCanSkip = true
      win.setClosable(true)
    }

    const flushRendererRequests = (): void => {
      if (doneRequested) finish()
      else if (tourReadyRequested) allowTourSkip()
    }

    const afterMandatoryIntro = (): void => {
      if (visibleAt === null) return
      const remaining = minimumVisibleMs - (Date.now() - visibleAt)
      if (remaining <= 0) {
        flushRendererRequests()
        return
      }
      if (minimumTimer) clearTimeout(minimumTimer)
      minimumTimer = setTimeout(flushRendererRequests, remaining)
    }

    // Only this window's renderer may end the intro — any other window that
    // sends intro:done is ignored.
    const onDone = (event: Electron.IpcMainEvent): void => {
      if (event.sender !== win.webContents) return
      doneRequested = true
      afterMandatoryIntro()
    }
    const onTourReady = (event: Electron.IpcMainEvent): void => {
      if (event.sender !== win.webContents) return
      tourReadyRequested = true
      afterMandatoryIntro()
    }
    ipcMain.on('intro:done', onDone)
    ipcMain.on('intro:tour-ready', onTourReady)

    // Main is the independent keyboard exit after the intro. It requires both
    // the renderer's ready signal and main's own minimum-visible clock, so an
    // early IPC/refactor cannot dismiss the brand film. Afterwards Escape skips
    // the entire remaining tour even if the renderer listener failed.
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && tourCanSkip) finish()
    })

    // The page's <title> replaces the window's the moment it loads, and every
    // window here loads the same index.html — which is why this title was
    // silently becoming "Jerico — setup" shortly after being set.
    win.on('page-title-updated', (e) => { e.preventDefault() })

    win.on('closed', finish)
    win.webContents.on('render-process-gone', finish)
    win.webContents.on('did-fail-load', finish)

    hardTimer = setTimeout(finish, HARD_TIMEOUT_MS)

    win.once('ready-to-show', () => {
      visibleAt = Date.now()
      win.show()
      win.focus()
      // IPC normally arrives later. These branches cover a renderer that
      // completed or requested unlock during the final ready-to-show turn.
      if (doneRequested || tourReadyRequested) afterMandatoryIntro()
    })

    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) {
      const introUrl = new URL('intro.html', `${rendererUrl}/`)
      introUrl.searchParams.set('skipBottom', String(skipBottom))
      introUrl.searchParams.set('skipRight', String(skipRight))
      void win.loadURL(introUrl.toString())
    } else {
      void win.loadFile(path.join(__dirname, '../renderer/intro.html'), {
        query: { skipBottom: String(skipBottom), skipRight: String(skipRight) },
      })
    }
  })
}

/** Dev affordance: `pnpm dev` after you have already seen it once shows nothing,
 *  which makes the intro impossible to iterate on. JERICO_FORCE_INTRO=1 replays
 *  it without clearing the flag. */
function introForced(): boolean {
  return !app.isPackaged && process.env['JERICO_FORCE_INTRO'] === '1'
}
