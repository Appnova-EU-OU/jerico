import { build } from 'esbuild'
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

// __dirname of scripts/build.mjs = packages/daemon/scripts
// monorepo root = packages/daemon/scripts/../../.. = ../
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir   = path.resolve(__dirname, '../../..')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// Inline the inspect-runtime JS into the bundle so the daemon carries it — no
// runtime path resolution (the CJS/pkg bundle has no usable import.meta.url,
// and the single-file dist lives at packages/daemon/dist/). Survives pkg-binary
// distribution. The proxy reads this global at runtime.
const INSPECT_RUNTIME_SRC = path.join(rootDir, 'packages/inspect-runtime/dist/jerico-inspect.js')
// The runtime dist is gitignored, so in a fresh checkout (desktop.yml / release.yml
// CI, before this fix) it doesn't exist → the daemon shipped an EMPTY runtime and
// the pkg-binary app 500'd on /__jerico/inspect.js. Build it on demand, and HARD-FAIL
// rather than silently inlining "" — never ship a daemon whose inspect proxy is dead.
if (!existsSync(INSPECT_RUNTIME_SRC)) {
  console.log('[build] inspect-runtime dist missing — building @jerico/inspect-runtime')
  execSync('pnpm --filter @jerico/inspect-runtime build', { cwd: rootDir, stdio: 'inherit' })
}
const inspectRuntimeJs = readFileSync(INSPECT_RUNTIME_SRC, 'utf-8')
if (!inspectRuntimeJs || inspectRuntimeJs.trim().length === 0) {
  throw new Error(`[build] inspect-runtime empty at ${INSPECT_RUNTIME_SRC} — refusing to ship a daemon that 500s on /__jerico/inspect.js`)
}
const inspectRuntimeDefine = JSON.stringify(inspectRuntimeJs)

// ── Build daemon ────────────────────────────────────────────────────────────────

try {
  await build({
    entryPoints: ['src/index.ts'],
    bundle:      true,
    minify:      true,
    platform:    'node',
    format:      'cjs',
    target:      'node20',
    outfile:     'dist/index.js',
    // node-pty ships native .node binaries — cannot be bundled.
    // ./bridge-mcp.cjs is a sibling artifact built separately below; keep the
    // literal require('./bridge-mcp.cjs') as a runtime require so pkg's static
    // analyzer bundles it into the snapshot (inlining it here would defeat that).
    external:    ['node-pty', './bridge-mcp.cjs', './codegraph.cjs', 'bun:sqlite', 'better-sqlite3'],
    define: {
      'process.env.AGENT_VERSION': JSON.stringify(pkg.version),
      'globalThis.__JERICO_INSPECT_RUNTIME__': inspectRuntimeDefine,
    },
  })
  console.log(`[build] bridge-agent v${pkg.version} bundled → dist/index.js`)
} catch (err) {
  console.error('[build] bridge-agent failed:', err)
  process.exit(1)
}

// ── Build OpenCode worker thread ─────────────────────────────────────────────────
// The worker is loaded at runtime via new Worker(__dirname + '/opencode-worker.js').
// It must be compiled separately because better-sqlite3 runs inside it off the
// main event loop.

try {
  await build({
    entryPoints: ['src/pty/opencode-worker.ts'],
    bundle:      true,
    minify:      true,
    platform:    'node',
    format:      'cjs',
    target:      'node20',
    outfile:     'dist/opencode-worker.js',
    external:    ['better-sqlite3'],
  })
  console.log('[build] opencode-worker bundled → dist/opencode-worker.js')
} catch (err) {
  console.error('[build] opencode-worker failed:', err)
  process.exit(1)
}

// ── Copy install script to dist ────────────────────────────────────────────────

try {
  const scriptSrc = path.join(rootDir, 'scripts/install-sim-prereqs.sh')
  const scriptDst = path.join(__dirname, '../dist/scripts/install-sim-prereqs.sh')
  if (existsSync(scriptSrc)) {
    mkdirSync(path.dirname(scriptDst), { recursive: true })
    copyFileSync(scriptSrc, scriptDst)
    console.log('[build] install-sim-prereqs.sh → dist/scripts/install-sim-prereqs.sh')
  } else {
    console.log('[build] install-sim-prereqs.sh not found at repo root — skipping copy')
  }
} catch (err) {
  console.warn('[build] copy install-sim-prereqs.sh failed:', err)
}

// ── Build MCP server (bundled with daemon) ─────────────────────────────────────

const mcpSrcDir    = path.join(rootDir, 'packages/mcp-server')
const mcpDistDest = path.join(__dirname, '../dist')

if (existsSync(path.join(mcpSrcDir, 'package.json'))) {
  // mkdir is safe to call even if dir already exists
  mkdirSync(mcpDistDest, { recursive: true })
  try {
    await build({
      entryPoints: [path.join(mcpSrcDir, 'src/index.ts')],
      bundle:      true,
      platform:    'node',
      format:      'cjs',
      target:      'node20',
      outfile:     path.join(mcpDistDest, 'bridge-mcp.cjs'),
      banner:      { js: '#!/usr/bin/env node' },
      external:    [],
    })
    console.log('[build] bridge-mcp bundled → dist/bridge-mcp.cjs')
  } catch (err) {
    console.error('[build] bridge-mcp failed:', err)
    // Don't exit — daemon built successfully, MCP is optional
  }
} else {
  console.log('[build] MCP server source not found — skipping')
}
