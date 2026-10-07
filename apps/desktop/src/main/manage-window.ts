import { BrowserWindow } from 'electron'
import * as path from 'node:path'

export class ManageWindow {
  private window: BrowserWindow | null = null

  open(): void {
    if (this.window) {
      this.window.show()
      this.window.focus()
      return
    }

    const preloadPath = path.join(__dirname, '../preload/index.js')
    this.window = new BrowserWindow({
      width: 560,
      height: 620,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      titleBarStyle: 'hiddenInset',
      // The ground Electron paints before the first frame. It has to be the
      // window's own ground (--win in app.css) or opening it flashes the old
      // palette for a frame.
      backgroundColor: '#0e0e0d',
      // Same family as the other windows' titles — this is the identity Mission
      // Control shows for an app with no Dock tile.
      title: 'Jerico — manage',
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    // The page's <title> replaces the window's the moment it loads, and every
    // window here loads the same index.html — which is why this title was
    // silently becoming "Jerico — setup" shortly after being set.
    this.window.on('page-title-updated', (e) => { e.preventDefault() })

    this.window.once('ready-to-show', () => this.window?.show())
    this.window.on('closed', () => { this.window = null })

    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) {
      void this.window.loadURL(`${rendererUrl}#manage`)
    } else {
      void this.window.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'manage' })
    }
  }

  destroy(): void {
    this.window?.close()
    this.window = null
  }
}
