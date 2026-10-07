// Issue #71 — codegraph silently reports "indexed"/total:0 on a pure C#/.NET
// (or any unsupported-language) project with zero distinguishing signal. Fix:
// engine.status()/index() now additionally return unsupportedLanguages: string[],
// computed via a positive extension allowlist inside the existing memoized
// source-file walk (no perf regression), and plumbed across the index-child
// IPC boundary (spawnIndexChild/IndexChildResult), which a naive fix would miss.
//
// Mirrors live-smoke-issue68.mjs's harness: spawn the real built dist/index.cjs
// as an HTTP MCP server, connect the real MCP SDK client, index throwaway
// fixture projects, call the real tools end to end (not the engine directly —
// the child-process boundary is exactly what a direct-engine test would miss).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'os'
import { fileURLToPath } from 'node:url'

const PORT = '3297'
const PKG = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(PKG, 'dist', 'index.cjs')
const NODE_BIN = process.execPath

const results = []
const rec = (name, ok, detail) => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`) }
const parse = (r) => JSON.parse(r.content[0].text)

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [SERVER], {
      env: { ...process.env, CODEGRAPH_PORT: PORT, CODEGRAPH_STDIO: '0' },
      stdio: ['ignore', 'inherit', 'pipe'],
    })
    let buf = ''
    const onErr = (d) => {
      buf += d.toString()
      if (buf.includes('listening')) resolve(child)
    }
    child.stderr.on('data', onErr)
    child.on('error', reject)
    setTimeout(() => reject(new Error('server did not start in time; stderr:\n' + buf)), 20000)
  })
}

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'codegraph-issue71-'))

function writeCSharpProj(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'Program.cs'), 'namespace Demo {\n  class Greeter {\n    public string Hello() { return "hi"; }\n  }\n}\n')
  writeFileSync(path.join(dir, 'Helper.cs'), 'namespace Demo {\n  static class Helper {\n    public static string Format(string s) { return s; }\n  }\n}\n')
  writeFileSync(path.join(dir, 'Demo.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n')
  writeFileSync(path.join(dir, 'appsettings.json'), '{}\n')
  writeFileSync(path.join(dir, 'README.md'), '# Demo\n')
}

function writeMixedProj(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'index.ts'), 'export function main() { return 1 }\n')
  writeFileSync(path.join(dir, 'Service.java'), 'public class Service { void run() {} }\n')
}

function writeNoiseOnlyProj(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'README.md'), '# Nothing here\n')
  writeFileSync(path.join(dir, 'package.json'), '{"name":"noise"}\n')
  writeFileSync(path.join(dir, 'notes.txt'), 'just text\n')
}

const client = new Client({ name: 'issue71-smoke', version: '0' }, { capabilities: {} })

try {
  const server = await startServer()
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)))

  // ── Fixture A: pure C# — the exact reported bug ──────────────────────────
  const dirA = path.join(ROOT, 'projA')
  writeCSharpProj(dirA)

  const preStatusA = parse(await client.callTool({ name: 'bridge_codegraph_status', arguments: { cwd: dirA } }))
  rec('A: pre-index status total=0, unsupportedLanguages=["csharp"]',
    preStatusA.total === 0 && Array.isArray(preStatusA.unsupportedLanguages) && preStatusA.unsupportedLanguages.includes('csharp'),
    JSON.stringify(preStatusA))

  const idxA = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: dirA, force: true, wait: true } }))
  rec('A: completed index total=0, status still "indexed" (not overloaded), unsupportedLanguages=["csharp"]',
    idxA.status === 'indexed' && idxA.total === 0 && Array.isArray(idxA.unsupportedLanguages) && idxA.unsupportedLanguages.length === 1 && idxA.unsupportedLanguages[0] === 'csharp',
    JSON.stringify(idxA))

  const postStatusA = parse(await client.callTool({ name: 'bridge_codegraph_status', arguments: { cwd: dirA } }))
  rec('A: post-index status carries the same signal (data-layer fix survives both status() and index() paths)',
    postStatusA.total === 0 && postStatusA.unsupportedLanguages.includes('csharp'),
    JSON.stringify(postStatusA))

  rec('A: noise files (.csproj/.json/.md) do not appear as unsupported languages',
    idxA.unsupportedLanguages.length === 1,
    JSON.stringify(idxA.unsupportedLanguages))

  // ── Fixture B: mixed TS+Java — proves the signal fires even when total>0 ──
  const dirB = path.join(ROOT, 'projB')
  writeMixedProj(dirB)

  const idxB = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: dirB, force: true, wait: true } }))
  rec('B: mixed repo — total>=1 (TS indexed) AND unsupportedLanguages contains "java" (silent-partial-coverage case)',
    idxB.total >= 1 && Array.isArray(idxB.unsupportedLanguages) && idxB.unsupportedLanguages.includes('java'),
    JSON.stringify(idxB))

  const symB = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: dirB, name: 'main' } }))
  rec('B: supported-language query still works (no regression from the new field)',
    (symB.results ?? []).some(r => r.qualifiedName.includes('main')),
    JSON.stringify(symB.results))

  // ── Fixture C: noise-only — false-positive guard on the allowlist ────────
  const dirC = path.join(ROOT, 'projC')
  writeNoiseOnlyProj(dirC)

  const statusC = parse(await client.callTool({ name: 'bridge_codegraph_status', arguments: { cwd: dirC } }))
  rec('C: pure-noise repo — total=0 and unsupportedLanguages=[] (allowlist, not a denylist — no false positives)',
    statusC.total === 0 && Array.isArray(statusC.unsupportedLanguages) && statusC.unsupportedLanguages.length === 0,
    JSON.stringify(statusC))

  // ── Cache invalidation: adding a new unsupported-lang file updates the signal
  writeFileSync(path.join(dirA, 'Extra.java'), 'public class Extra {}\n')
  const idxA2 = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: dirA, force: true, wait: true } }))
  rec('A2: after adding Extra.java, re-index picks up both csharp and java (cache invalidation works)',
    idxA2.unsupportedLanguages.includes('csharp') && idxA2.unsupportedLanguages.includes('java'),
    JSON.stringify(idxA2.unsupportedLanguages))

  await client.close()
  server.kill()
} catch (e) {
  console.error('SMOKE ERROR:', e)
  rec('smoke completed without exception', false, String(e))
} finally {
  rmSync(ROOT, { recursive: true, force: true })
  const failed = results.filter(r => !r.ok).length
  console.log(`\n=== ISSUE #71 LIVE SMOKE: ${results.length - failed}/${results.length} PASS ===`)
  process.exit(failed ? 1 : 0)
}
