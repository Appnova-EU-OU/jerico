// Renders the menu bar mark variants to PNG and writes
// src/main/tray-icons.generated.ts.
//
// Run BY HAND after changing brand/tray/mark.svg or the variant table, then
// commit the output:
//   npx electron scripts/render-tray-icons.mjs
//
// Deliberately NOT part of `pnpm build`: it boots a real Chromium to rasterize
// SVG, which packaging must not depend on.
//
// Artwork authority: apps/desktop/design/01-tray-popover.html §"Quiet when healthy".

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VARIANTS, buildDocument } from './lib/tray-variants.mjs'

// `app.commandLine.appendSwitch('force-device-scale-factor', ...)` is too late
// on a Retina Mac: Electron's native bootstrap reads the host's backing scale
// factor before any of this process's JS runs, so a switch appended from JS —
// however early — cannot override it. The only reliable fix is to have the
// flag present in argv at OS process launch, so on first run we re-exec this
// same Electron binary with the flag added and let the corrected child do the
// rendering. `TRAY_ICONS_SCALE_LOCKED` guards against re-spawning forever.
const SCALE_FLAG = '--force-device-scale-factor=1'
if (!process.argv.includes(SCALE_FLAG) && !process.env.TRAY_ICONS_SCALE_LOCKED) {
  const result = spawnSync(process.execPath, [SCALE_FLAG, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, TRAY_ICONS_SCALE_LOCKED: '1' },
  })
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow, nativeImage } = await import('electron')

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const SVG_PATH = join(DESKTOP, 'brand', 'tray', 'mark.svg')
const OUT_TS = join(DESKTOP, 'src', 'main', 'tray-icons.generated.ts')
const SIZES = [22, 44]

const fail = (msg) => { console.error(`[render-tray-icons] ${msg}`); app.exit(1) }

// Belt-and-braces: harmless if the flag already took effect via argv above,
// but keeps this working unchanged if Electron ever fixes the early-read path.
app.commandLine.appendSwitch('force-device-scale-factor', '1')

// Windows created by render() are torn down together at the very end, not one
// at a time between renders. Destroying a window immediately after use, then
// spawning a fresh one for the next render, reliably makes the *next*
// renderer process fail its macOS mach-port handshake on this host (ERR_FAILED
// loading the very next data: URL, with a "MachPortRendezvousServer ...
// Unknown service name" / "Permission denied" line on stderr) — a rapid
// destroy-then-spawn race in Electron's renderer-process bootstrap, not
// anything wrong with the HTML/CSS being loaded. Keeping every window alive
// until the process is about to exit avoids the race entirely; the OS
// reclaims them all when `app.exit()` terminates the process below.
const openWindows = []

/**
 * Render one variant at one size and return the PNG buffer.
 *
 * The window is shown, not hidden: `capturePage()` on a never-shown window can
 * come back blank. Parking it far off-screen and using `showInactive()` keeps
 * it off every display and out of focus while still compositing for real.
 */
async function render(svg, variant, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    x: -10000,
    y: -10000,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false },
  })
  openWindows.push(win)
  const html = buildDocument(svg, variant, size)
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  win.showInactive()
  const image = await win.webContents.capturePage()
  return image.toPNG()
}

/**
 * Decode and assert the mechanical invariants.
 *
 * Decoding goes through Electron's own nativeImage rather than a PNG library —
 * it is already here, and adding a dependency for four assertions is not worth
 * the lockfile churn. toBitmap() is BGRA on macOS and may be premultiplied;
 * neither matters below, because both checks are channel-order independent and
 * premultiplication scales all three colour channels equally, so a grey pixel
 * stays grey.
 */
function verify(buffer, variant, size) {
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) fail(`${variant.name} @${size} is not a decodable image`)

  const dims = image.getSize()
  if (dims.width !== size || dims.height !== size) {
    fail(`${variant.name} @${size} came back ${dims.width}x${dims.height} — device scale factor leaked in`)
  }

  const bitmap = image.toBitmap()
  let opaque = 0
  let chromatic = 0
  for (let i = 0; i < bitmap.length; i += 4) {
    if (bitmap[i + 3] <= 8) continue
    opaque++
    if (bitmap[i] !== bitmap[i + 1] || bitmap[i + 1] !== bitmap[i + 2]) chromatic++
  }
  const total = size * size
  if (opaque === 0) fail(`${variant.name} @${size} is blank`)
  if (opaque === total) fail(`${variant.name} @${size} is fully opaque — transparency did not take`)
  // All three variants ship as template images, so none may carry colour.
  if (chromatic > 0) {
    fail(`${variant.name} @${size} has ${chromatic} chromatic pixels but ships as a template image`)
  }
}

app.whenReady().then(async () => {
  const svg = readFileSync(SVG_PATH, 'utf-8').trim()
  const icons = {}

  for (const variant of VARIANTS) {
    const buffers = {}
    for (const size of SIZES) {
      const buffer = await render(svg, variant, size)
      verify(buffer, variant, size)
      buffers[size === 22 ? 'x1' : 'x2'] = buffer.toString('base64')
    }
    icons[variant.name] = buffers
    console.log(`[render-tray-icons] ${variant.name}: ok`)
  }

  // Two identical variants means a colour or flag silently failed to apply.
  const seen = new Map()
  for (const [name, { x2 }] of Object.entries(icons)) {
    if (seen.has(x2)) fail(`${name} and ${seen.get(x2)} produced identical @2x pixels`)
    seen.set(x2, name)
  }

  const names = VARIANTS.map((v) => `'${v.name}'`).join(' | ')
  const body =
    '// GENERATED by scripts/render-tray-icons.mjs — do not edit by hand.\n' +
    '// Source art: brand/tray/mark.svg (from design/01-tray-popover.html)\n' +
    '// Regenerate: npx electron scripts/render-tray-icons.mjs\n\n' +
    `export type TrayIconVariant = ${names}\n\n` +
    '/** Base64 PNG data. x1 = 22x22 (@1x), x2 = 44x44 (@2x). */\n' +
    'export const TRAY_ICONS: Record<TrayIconVariant, { readonly x1: string; readonly x2: string }> = {\n' +
    VARIANTS.map((v) =>
      `  ${v.name}: {\n    x1: '${icons[v.name].x1}',\n    x2: '${icons[v.name].x2}',\n  },`,
    ).join('\n') +
    '\n}\n'

  writeFileSync(OUT_TS, body)
  console.log(`[render-tray-icons] wrote ${OUT_TS}`)
  app.exit(0)
}).catch((err) => {
  fail(`Promise chain failed: ${err.message}`)
})
