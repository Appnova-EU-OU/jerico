import { chmodSync, readdirSync, statSync, copyFileSync, mkdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve, join, sep } from 'path'
import os from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))

function findSpawnHelpers(dir) {
  const results = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        results.push(...findSpawnHelpers(full))
      } else if (entry === 'spawn-helper') {
        results.push(full)
      }
    }
  } catch {}
  return results
}

const searchRoots = [
  resolve(__dirname, '../node_modules/node-pty/prebuilds'),
  resolve(__dirname, '../../node_modules/node-pty/prebuilds'),
  resolve(__dirname, '../../../node_modules/node-pty/prebuilds'),
]

let fixed = 0
for (const root of searchRoots) {
  for (const file of findSpawnHelpers(root)) {
    try {
      chmodSync(file, 0o755)
      fixed++
      console.log('[bridge-agent] postinstall: fixed permissions for', file)
    } catch (err) {
      console.warn('[bridge-agent] postinstall: failed to chmod', file, err.message)
    }
  }
}

if (fixed === 0) {
  console.log('[bridge-agent] postinstall: no node-pty spawn-helper found to fix')
}

// A workspace checkout (this file is not under node_modules) runs postinstall
// before anything is built, and its daemon finds the simulator install script
// in the repository itself; the steps below only matter for an installed package.
const sourceCheckout = !__dirname.split(sep).includes('node_modules')

// Ensure bridge-mcp binary is executable (npm usually handles `bin` entries, but
// pnpm stores and some preserve-symlinks installs miss it).
const mcpBin = resolve(__dirname, '../dist/bridge-mcp.cjs')
if (!existsSync(mcpBin)) {
  console.log('[bridge-agent] postinstall: dist/ not built yet — skipping bridge-mcp chmod')
} else {
  try {
    chmodSync(mcpBin, 0o755)
    console.log('[bridge-agent] postinstall: bridge-mcp bin chmod +x')
  } catch (err) {
    console.warn('[bridge-agent] postinstall: could not chmod bridge-mcp:', err.message)
  }
}

// Ensure install-sim-prereqs.sh is executable and seed the ~/.bridge copy the
// daemon falls back to when it cannot fetch the script from the service. Not
// done from a source checkout: there the daemon falls back to the repository's
// scripts/install-sim-prereqs.sh, and overwriting ~/.bridge would put a local
// script behind the cached ETag of the service's copy.
if (sourceCheckout) {
  console.log('[bridge-agent] postinstall: source checkout — not copying install-sim-prereqs.sh to ~/.bridge')
} else {
  try {
    const bundledScript = resolve(__dirname, '../dist/scripts/install-sim-prereqs.sh')
    if (existsSync(bundledScript)) {
      chmodSync(bundledScript, 0o755)
      console.log('[bridge-agent] postinstall: install-sim-prereqs.sh chmod +x')
      const bridgeDir = join(os.homedir(), '.bridge')
      mkdirSync(bridgeDir, { recursive: true })
      const dest = join(bridgeDir, 'install-sim-prereqs.sh')
      copyFileSync(bundledScript, dest)
      chmodSync(dest, 0o755)
      console.log('[bridge-agent] postinstall: install-sim-prereqs.sh →', dest)
    } else {
      console.log('[bridge-agent] postinstall: install-sim-prereqs.sh not bundled — skipping')
    }
  } catch (err) {
    console.warn('[bridge-agent] postinstall: could not copy install-sim-prereqs.sh:', err.message)
  }
}
