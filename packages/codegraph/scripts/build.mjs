import * as esbuild from 'esbuild'
import { chmodSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

mkdirSync('./dist', { recursive: true })

const treeSitterCjsPath = require.resolve('web-tree-sitter')
const treeSitterPkgDir = path.dirname(treeSitterCjsPath)

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle:      true,
  platform:    'node',
  format:      'cjs',
  target:      'node20',
  outfile:     'dist/index.cjs',
  external:    ['better-sqlite3'],
  alias:       { 'web-tree-sitter': treeSitterCjsPath },
  banner:      { js: '#!/usr/bin/env node' },
})

chmodSync('dist/index.cjs', 0o755)

console.log('[codegraph] esbuild done → dist/index.cjs')

const wasmDir = path.join(pkgDir, 'dist', 'wasm')
mkdirSync(wasmDir, { recursive: true })

const coreWasm = path.join(treeSitterPkgDir, 'tree-sitter.wasm')
if (existsSync(coreWasm)) {
  copyFileSync(coreWasm, path.join(wasmDir, 'tree-sitter.wasm'))
  console.log('[codegraph] copied tree-sitter.wasm')
} else {
  console.warn('[codegraph] core wasm not found at', coreWasm)
}

const wasmsPkgDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'))
const wasmsDir = path.join(wasmsPkgDir, 'out')
if (existsSync(wasmsDir)) {
  for (const f of readdirSync(wasmsDir)) {
    if (f.endsWith('.wasm')) {
      copyFileSync(path.join(wasmsDir, f), path.join(wasmDir, f))
      console.log(`[codegraph] copied ${f}`)
    }
  }
} else {
  console.warn('[codegraph] tree-sitter-wasms/out not found at', wasmsDir)
}

console.log('[codegraph] build done')
