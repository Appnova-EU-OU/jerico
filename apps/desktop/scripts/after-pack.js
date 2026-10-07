'use strict'

const { chmodSync, existsSync } = require('fs')
const path = require('path')

const { applySignIdentity } = require('./sign-identity')

/**
 * electron-builder afterPack hook.
 *
 * electron-builder strips the executable bit from copied files.
 * The bundled bridge-agent binary (in Contents/Resources/) must be +x
 * so the main process can spawn it. Same applies to node-pty's spawn-helper
 * if it ever ends up in Resources.
 *
 * It also resolves the macOS signing identity (sign-identity.js) here, because
 * afterPack is the last hook before electron-builder signs: a signing build
 * without JERICO_MAC_SIGN_IDENTITY fails now instead of shipping unsigned.
 */
exports.default = async function afterPack({ appOutDir, electronPlatformName }) {
  if (electronPlatformName === 'darwin') applySignIdentity('after-pack')

  const appName = 'jerico.app'
  const resourcesDir = path.join(appOutDir, appName, 'Contents', 'Resources')

  const targets = ['bridge-agent']

  for (const name of targets) {
    const target = path.join(resourcesDir, name)
    if (existsSync(target)) {
      chmodSync(target, 0o755)
      console.log(`[after-pack] chmod +x ${target}`)
    } else {
      console.warn(`[after-pack] WARNING: ${name} not found at ${target} — skipping chmod`)
    }
  }
}
