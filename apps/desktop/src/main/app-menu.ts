import { app, Menu } from 'electron'

/**
 * The application menu, which for a menu-bar app is mostly about what it does
 * NOT contain.
 *
 * Electron installs a default menu built for a document app: File, View, Window
 * and Help, none of which this app has anything to put in. It also titled itself
 * from `app.name`, which is how the menu bar came to read "Electron" — the name
 * is fixed in index.ts, but a Jerico menu offering "New Window" and "Reload"
 * would still be describing an app that does not exist.
 *
 * It is NOT replaced with nothing, which is the tempting answer for a tray app.
 * On macOS the editing shortcuts are not built into the text field — they are
 * the Edit menu's key equivalents, and with no menu there is no Cmd+V. The
 * wizard's whole job is to receive a daemon token that the user copied out of a
 * browser. Deleting the menu would break the one interaction the app cannot do
 * without, and it would break it silently.
 *
 * So: the app submenu, and Edit. Minimize and Close keep their shortcuts because
 * users press them at windows regardless of whether we listed them.
 */
export function installAppMenu(): void {
  if (process.platform !== 'darwin') {
    // Windows/Linux have no always-present menu bar to name, and an empty one
    // would draw a strip of nothing at the top of every window.
    Menu.setApplicationMenu(null)
    return
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      // macOS OVERRIDES this label with the bundle's CFBundleName and there is
      // no runtime call that changes it — `app.setName()` moves app.name and the
      // paths derived from it, not the menu title. So an unpackaged run titles
      // this "Electron" (Electron.app's own CFBundleName) whatever is written
      // here, and the shipped bundle titles it "jerico" from productName. The
      // label is kept truthful for the platforms that do read it.
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
  ]))
}
