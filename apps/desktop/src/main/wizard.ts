import { BrowserWindow, app } from 'electron'
import * as path from 'node:path'

export class WizardController {
  private window: BrowserWindow | null = null
  // Phase B fix (#1): suppress quit-on-close when close() is called programmatically
  // (gate passed → normal flow resumes). User-initiated close (X button / Cmd+W)
  // when gate hasn't passed → app.quit() to avoid zombie state.
  private _suppressQuitOnClose = false

  show(): void {
    if (this.window) {
      this.window.show()
      this.window.focus()
      return
    }
    this._openWindow()
  }

  /** Open the wizard and jump directly to the Auth step (for re-auth after token rejection). */
  showAtAuthStep(): void {
    if (this.window) {
      this.window.show()
      this.window.focus()
      return
    }
    this._openWindow('auth-step')
  }

  showAtPermissionGate(): void {
    if (this.window) {
      this.window.show()
      this.window.focus()
      return
    }
    this._openWindow('permission-gate')
  }

  private _openWindow(hash?: string): void {
    app.dock?.show()

    const preloadPath = path.join(__dirname, '../preload/index.js')

    const w = new BrowserWindow({
      width: 520,
      height: 640,
      resizable: false,
      titleBarStyle: 'hiddenInset',
      // The ground Electron paints before the renderer's first frame. It has to
      // be the window's own ground (--win in app.css) or opening the wizard
      // flashes the old palette for a frame — most visible on the cold launch
      // this window exists for.
      backgroundColor: '#0e0e0d',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.window = w
    this._suppressQuitOnClose = false

    w.on('closed', () => {
      // Guard: only null if this window still owns the ref — prevents a stale
      // closed event from a previous window nulling a newly-opened one.
      if (this.window === w) this.window = null
      app.dock?.hide()
      // Phase B fix (#1): if user closes the gate window before it passes,
      // quit cleanly instead of leaving a zombie. close() sets the flag.
      if (!this._suppressQuitOnClose) {
        app.quit()
      }
      this._suppressQuitOnClose = false
    })

    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) {
      void this.window.loadURL(hash ? `${rendererUrl}#${hash}` : rendererUrl)
    } else {
      void this.window.loadFile(path.join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
    }
  }

  showIfNeeded(): void {
    if (this.window) {
      this.window.show()
      this.window.focus()
    }
  }

  close(): void {
    this._suppressQuitOnClose = true
    const w = this.window
    this.window = null
    app.dock?.hide()
    w?.removeAllListeners('closed')
    w?.close()
  }

  isOpen(): boolean {
    return this.window !== null
  }
}
