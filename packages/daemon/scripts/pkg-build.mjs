/**
 * pkg-build.mjs — Produces self-contained bridge-agent binaries via @yao-pkg/pkg.
 *
 * pkg crawls the entire monorepo via pnpm symlinks when run from the daemon
 * directory, taking 5+ minutes and producing bloated (128+ MB) binaries.
 *
 * This script creates an isolated build directory with only:
 *   - dist/index.js + dist/bridge-mcp.cjs + dist/opencode-worker.js (esbuild output)
 *   - node-pty prebuilds (native .node + spawn-helper)
 *   - better-sqlite3 (native addon + JS)
 *   - dist/scripts/*.sh (install helpers)
 *
 * And runs pkg from there. Build drops to dist/bin/.
 *
 * Usage:
 *   node scripts/pkg-build.mjs                          # auto-detect platform
 *   node scripts/pkg-build.mjs --target=macos-arm64     # specific target
 *   node scripts/pkg-build.mjs --target=macos-x64,linux-x64  # multiple (CSV)
 *   node scripts/pkg-build.mjs --dry-run                # check without building
 *   KEEP_ISO=1 node scripts/pkg-build.mjs               # keep temp dir for debugging
 */

import { execSync, spawnSync } from 'child_process'
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, writeFileSync, renameSync, chmodSync, readdirSync } from 'fs'
import { tmpdir, platform, arch } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const daemonDir = path.resolve(__dirname, '..')
const distDir = path.join(daemonDir, 'dist')
const binDir = path.join(distDir, 'bin')
const pkgVersion = JSON.parse(readFileSync(path.join(daemonDir, 'package.json'), 'utf8')).version

// ── CLI args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const targetArg = args.find(a => a.startsWith('--target='))?.split('=')[1] || ''
const dryRun = args.includes('--dry-run')
const requestedTargets = targetArg ? targetArg.split(',').map(t => t.trim()).filter(Boolean) : []

// ── Target mapping ───────────────────────────────────────────────────────────────

const TARGET_MAP = {
  'macos-arm64': 'node22-macos-arm64',
  'macos-x64':   'node22-macos-x64',
  'linux-x64':   'node22-linux-x64',
  'win-x64':     'node22-win-x64',
}

function detectTarget() {
  const osName = platform()
  const cpuArch = arch()
  if (osName === 'darwin' && cpuArch === 'arm64') return 'macos-arm64'
  if (osName === 'darwin' && cpuArch === 'x64')   return 'macos-x64'
  if (osName === 'linux'  && cpuArch === 'x64')   return 'linux-x64'
  if (osName === 'win32'  && cpuArch === 'x64')   return 'win-x64'
  throw new Error(`Unsupported platform: ${osName} ${cpuArch}`)
}

const buildTargets = requestedTargets.length > 0
  ? requestedTargets
  : [detectTarget()]

const pkgTargets = buildTargets.map(t => {
  const mapped = TARGET_MAP[t]
  if (!mapped) throw new Error(`Unknown target: ${t}. Valid: ${Object.keys(TARGET_MAP).join(', ')}`)
  return { name: t, pkgTarget: mapped }
})

// ── Prerequisites ─────────────────────────────────────────────────────────────────

if (!existsSync(path.join(distDir, 'index.js'))) {
  console.error('[pkg-build] dist/index.js not found — run `pnpm --filter bridge-agent build` first')
  process.exit(1)
}

// #380 Gap 1/2: codegraph rides inside the binary — its dist + tree-sitter wasm must exist.
const codegraphDist = path.resolve(daemonDir, '..', 'codegraph', 'dist')
if (!existsSync(path.join(codegraphDist, 'index.cjs'))) {
  console.error('[pkg-build] codegraph/dist/index.cjs not found — run `pnpm --filter @bridge/codegraph build` first')
  process.exit(1)
}
if (!existsSync(path.join(codegraphDist, 'wasm', 'tree-sitter.wasm'))) {
  console.error('[pkg-build] codegraph/dist/wasm/tree-sitter.wasm not found — run `pnpm --filter @bridge/codegraph build` first')
  process.exit(1)
}

// #380 Gap 4: pkg embeds Node 22 (better-sqlite3 ABI 127). The bundled native addon
// MUST match — re-fetch the node22 prebuild per target rather than trusting whatever
// ABI the dev's last `pnpm install` produced. Node major → the version pkg embeds.
const PKG_NODE_VERSION = '22.22.3'
const PLATFORM_ARCH = {
  'macos-arm64': { platform: 'darwin', arch: 'arm64' },
  'macos-x64':   { platform: 'darwin', arch: 'x64' },
  'linux-x64':   { platform: 'linux',  arch: 'x64' },
  'win-x64':     { platform: 'win32',  arch: 'x64' },
}

console.log(`[pkg-build] bridge-agent v${pkgVersion}`)
console.log(`[pkg-build] targets: ${pkgTargets.map(t => t.name).join(', ')}`)

mkdirSync(binDir, { recursive: true })

// ── Find node-pty prebuilds ──────────────────────────────────────────────────────

function findPnpmPackage(packageName) {
  // pnpm hoists packages to monorepo root node_modules/.pnpm/
  const monorepoRoot = path.resolve(daemonDir, '..', '..')
  const pnpmDir = path.join(monorepoRoot, 'node_modules', '.pnpm')

  const candidates = [
    path.join(daemonDir, 'node_modules', packageName),
  ]

  // pnpm virtual store
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith(packageName + '@') || entry.startsWith(packageName + '+')) {
        candidates.push(path.join(pnpmDir, entry, 'node_modules', packageName))
      }
    }
  }

  // Direct hoist
  candidates.push(path.join(monorepoRoot, 'node_modules', packageName))

  for (const c of candidates) {
    if (existsSync(c) && existsSync(path.join(c, 'package.json'))) {
      return c
    }
  }

  return null
}

function findNodePtyPath() {
  return findPnpmPackage('node-pty')
}

// ── Cross-build safety guard (BS3_GUARD) ─────────────────────────────────────────
// `prebuild-install --force` (run per target below to fetch the node22/ABI-127 addon)
// corrupts the developer's SHARED better-sqlite3 native addon when cross-building a
// non-host target — verified: on an arm64 machine, `--target=macos-x64` flips the shared
// build/Release/better_sqlite3.node to x86_64, which then breaks every later native/dev
// build until a reinstall. (A dereference:true cpSync would stop the corruption at its
// source but breaks better-sqlite3's `require('bindings')` in the snapshot — see the cpSync
// note below — so instead we snapshot the shared addon's bytes now and, on ANY exit, restore
// them if they changed. The per-target ISO copy still gets the correct arch (that's what pkg
// bundles); this only keeps the dev tree's shared addon intact. CI runners are ephemeral so
// it's a no-op there, but it makes local cross-builds safe.
const bs3PkgDir = findPnpmPackage('better-sqlite3')
const bs3NodePath = bs3PkgDir ? path.join(bs3PkgDir, 'build', 'Release', 'better_sqlite3.node') : null
const bs3Snapshot = bs3NodePath && existsSync(bs3NodePath) ? readFileSync(bs3NodePath) : null
if (bs3NodePath && bs3Snapshot) {
  // Restore on EVERY exit path. The prereq/prebuild-install hard-fails below call
  // process.exit(), which skips try/finally — an `on('exit')` handler (sync fs is allowed
  // here) still fires, so a failed cross-build can't leave the shared addon corrupted.
  process.on('exit', () => {
    try {
      if (existsSync(bs3NodePath) && !readFileSync(bs3NodePath).equals(bs3Snapshot)) {
        // Write to a temp sibling then rename over the target: an atomic swap that can't
        // leave the addon truncated/half-written if the process dies mid-restore.
        const tmp = `${bs3NodePath}.pkgbuild-restore`
        writeFileSync(tmp, bs3Snapshot)
        renameSync(tmp, bs3NodePath)
        console.log('[pkg-build] restored shared better-sqlite3 addon (cross-build guard)')
      }
    } catch (e) {
      // Don't mask the underlying build error, but the shared addon may now be corrupt —
      // surface it loudly so the dev knows to reinstall (e.g. ETXTBSY if a daemon has it mapped).
      console.error(`[pkg-build] WARNING: could not restore shared better-sqlite3 addon (${e instanceof Error ? e.message : e}). Run \`pnpm rebuild better-sqlite3\` to fix your dev tree.`)
    }
  })
}

// ── Build isolated directory and run pkg ─────────────────────────────────────────

for (const { name, pkgTarget } of pkgTargets) {
  const outName = `bridge-agent-${name}`
  const outPath = path.join(binDir, outName)
  const isoDir = path.join(tmpdir(), `bridge-pkg-${Date.now()}`)
  console.log(`\n[pkg-build] ── ${name} ──`)

  try {
    mkdirSync(isoDir, { recursive: true })

    // Copy esbuild artifacts
    cpSync(path.join(distDir, 'index.js'), path.join(isoDir, 'index.js'))
    cpSync(path.join(distDir, 'bridge-mcp.cjs'), path.join(isoDir, 'bridge-mcp.cjs'))
    cpSync(path.join(distDir, 'opencode-worker.js'), path.join(isoDir, 'opencode-worker.js'))

    // Copy shell scripts
    const scriptsDir = path.join(isoDir, 'scripts')
    const distScriptsDir = path.join(distDir, 'scripts')
    if (existsSync(distScriptsDir)) {
      mkdirSync(scriptsDir, { recursive: true })
      for (const f of readdirSync(distScriptsDir)) {
        if (f.endsWith('.sh')) {
          cpSync(path.join(distScriptsDir, f), path.join(scriptsDir, f))
          chmodSync(path.join(scriptsDir, f), 0o755)
        }
      }
    }

    // Copy node-pty prebuilds
    const nodePtySrc = findNodePtyPath()
    if (!nodePtySrc) {
      console.error('[pkg-build] node-pty prebuilds not found — cannot build')
      process.exit(1)
    }
    const nodePtyDest = path.join(isoDir, 'node_modules', 'node-pty')
    mkdirSync(path.dirname(nodePtyDest), { recursive: true })
    cpSync(nodePtySrc, nodePtyDest, { recursive: true })

    // Ensure all spawn-helper binaries are executable
    const prebuildsDir = path.join(nodePtyDest, 'prebuilds')
    if (existsSync(prebuildsDir)) {
      for (const plat of readdirSync(prebuildsDir)) {
        const sh = path.join(prebuildsDir, plat, 'spawn-helper')
        if (existsSync(sh)) {
          try { chmodSync(sh, 0o755) } catch {}
        }
      }
    }

    // Copy better-sqlite3 (JS is ABI-independent) then RE-FETCH the node22 prebuild
    // for THIS target's platform/arch (#380 Gap 4). Shared by the OpenCode worker AND
    // (after Gap 1) codegraph. Hard-fail on fetch failure — a host-ABI fallback would
    // silently ship the wrong NODE_MODULE_VERSION into a node22 binary.
    const betterSqlite3Src = findPnpmPackage('better-sqlite3')
    if (!betterSqlite3Src) {
      console.error('[pkg-build] better-sqlite3 not found — cannot build (codegraph + OpenCode need it)')
      process.exit(1)
    }
    const betterSqlite3Dest = path.join(isoDir, 'node_modules', 'better-sqlite3')
    mkdirSync(path.dirname(betterSqlite3Dest), { recursive: true })
    // NOTE: do NOT pass dereference:true here. It stops prebuild-install from following a
    // pnpm symlink back to the shared store (the corruption vector), BUT it also breaks
    // better-sqlite3's `require('bindings')` resolution inside the pkg snapshot — verified by
    // live smoke: the binary then dies with "Cannot find module 'bindings'". So we keep the
    // verbatim copy (working binary) and rely on BS3_GUARD above to restore the shared addon.
    cpSync(betterSqlite3Src, betterSqlite3Dest, { recursive: true })
    // Drop the copied prebuilt artifacts so prebuild-install below fetches a FRESH addon
    // for THIS target's arch into the iso (rather than leaving cpSync's host-arch copy in
    // place). (Shared-store corruption from --force is handled separately by the
    // snapshot/restore on('exit') guard — see BS3_GUARD above.)
    rmSync(path.join(betterSqlite3Dest, 'build'), { recursive: true, force: true })
    rmSync(path.join(betterSqlite3Dest, 'prebuilds'), { recursive: true, force: true })
    const pa = PLATFORM_ARCH[name]
    if (!pa) {
      console.error(`[pkg-build] no platform/arch mapping for target ${name}`)
      process.exit(1)
    }
    console.log(`[pkg-build]   better-sqlite3 → fetching node${PKG_NODE_VERSION} prebuild (${pa.platform}-${pa.arch}, ABI 127)`)
    const pbi = spawnSync(
      'npx',
      ['-y', 'prebuild-install@7', '--runtime', 'node', '--target', PKG_NODE_VERSION,
       '--platform', pa.platform, '--arch', pa.arch, '--force'],
      { cwd: betterSqlite3Dest, stdio: 'inherit', timeout: 5 * 60 * 1000 },
    )
    if (pbi.status !== 0) {
      console.error(`[pkg-build] prebuild-install for better-sqlite3 (node${PKG_NODE_VERSION} ${pa.platform}-${pa.arch}) FAILED — aborting (no host-ABI fallback; that would ship a wrong-ABI addon).`)
      process.exit(1)
    }

    // #380 Gap 1 + 2: codegraph rides inside the binary. Colocate its bundle as
    // codegraph.cjs (client.ts's isPkg spawn re-enters via the `codegraph` subcommand
    // that require()s it) + its tree-sitter wasm (engine.ts findWasmDir → __dirname/wasm).
    cpSync(path.join(codegraphDist, 'index.cjs'), path.join(isoDir, 'codegraph.cjs'))
    cpSync(path.join(codegraphDist, 'wasm'), path.join(isoDir, 'wasm'), { recursive: true })
    console.log('[pkg-build]   codegraph.cjs + tree-sitter wasm → isolated dir')

    // Create standalone package.json (no workspace — prevents monorepo crawl)
    const isoPkgJson = {
      name: 'bridge-agent',
      version: pkgVersion,
      bin: { 'bridge-agent': 'index.js', 'bridge-mcp': 'bridge-mcp.cjs' },
      pkg: {
        assets: [
          'node_modules/node-pty/**/*.node',
          'node_modules/node-pty/**/spawn-helper',
          'node_modules/better-sqlite3/**/*.node',
          'scripts/**/*.sh',
          'bridge-mcp.cjs',
          // #380 Gap 1/2: codegraph bundle + tree-sitter wasm (run/read from the snapshot).
          'codegraph.cjs',
          'wasm/**/*.wasm',
        ],
        scripts: ['opencode-worker.js'],
      },
    }
    writeFileSync(path.join(isoDir, 'package.json'), JSON.stringify(isoPkgJson, null, 2))

    console.log(`[pkg-build]   isolated dir: ${isoDir}`)

    if (dryRun) {
      console.log(`[pkg-build]   --dry-run: would build → ${outPath}`)
      continue
    }

    // Run pkg
    console.log(`[pkg-build]   running pkg -t ${pkgTarget} ...`)
    const result = spawnSync(
      'npx',
      ['-y', '@yao-pkg/pkg@6.20.0', '.', '-t', pkgTarget, '-o', outPath, '--compress', 'GZip'],
      { cwd: isoDir, stdio: 'inherit', timeout: 15 * 60 * 1000 },
    )

    if (result.status !== 0) {
      console.error(`[pkg-build]   pkg exited with code ${result.status}`)
      process.exitCode = 1
      continue
    }

    // Verify output
    if (existsSync(outPath)) {
      const sz = (readFileSync(outPath).length / 1024 / 1024).toFixed(1)
      console.log(`[pkg-build]   ✓ ${outName} (${sz} MB)`)
    } else {
      console.error(`[pkg-build]   ✗ output not found: ${outPath}`)
      process.exitCode = 1
    }

  } finally {
    if (!process.env.KEEP_ISO) {
      rmSync(isoDir, { recursive: true, force: true })
    } else {
      console.log(`[pkg-build]   KEEP_ISO: ${isoDir}`)
    }
  }
}

console.log(`\n[pkg-build] Done. Output in ${binDir}/`)
if (process.exitCode) process.exit(process.exitCode)
