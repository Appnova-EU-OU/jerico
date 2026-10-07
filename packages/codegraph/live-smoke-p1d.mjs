// P1-D Live Smoke — bridge_codegraph_find_symbol THROUGH the bridge-mcp server.
//
// The bridge-mcp server requires a Bearer-token preflight against BRIDGE_SERVER_URL
// before it allocates an MCP session. For an isolated smoke we stand up a tiny mock
// "bridge server" that answers the preflight GETs with 200, then run the REAL built
// bridge-mcp bundle (dist/index.cjs) against it. The codegraph proxy inside
// bridge-mcp then talks to the real codegraph HTTP door at CODEGRAPH_PORT, so the
// agent-facing path (HTTP MCP → tool → codegraph door) is exercised end-to-end.
// Finally we assert an adoption.jsonl line was written for the call.

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(process.cwd(), '..', '..')
const MCP_ENTRY = path.join(REPO, 'packages', 'mcp-server', 'dist', 'index.cjs')
const ADOPTION_FILE = path.join(os.homedir(), '.jerico', 'codegraph', 'adoption.jsonl')
const CODEGRAPH_PORT = parseInt(process.env['CODEGRAPH_PORT'] ?? '3201', 10)
const MOCK_PORT = 3296
const MCP_PORT = 3295
const TOKEN = 'p1d-smoke-token'
const WS = 'ws_p1d'
const PROJECT = 'proj_p1d'

const results = []
const rec = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function httpGet(url, headers = {}, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve(body) } })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// ── Mock bridge server (preflight only) ─────────────────────────────────────
const mockServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, id: 'mock', name: 'mock' }))
})
await new Promise(r => mockServer.listen(MOCK_PORT, r))
console.log(`mock bridge server on :${MOCK_PORT}`)

// ── Start real bridge-mcp bundle ────────────────────────────────────────────
const mcpProc = spawn(process.execPath, [MCP_ENTRY], {
  env: {
    ...process.env,
    HTTP_MODE: 'true',
    BRIDGE_SERVER_URL: `http://127.0.0.1:${MOCK_PORT}`,
    PORT: String(MCP_PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let mcpStderr = ''
mcpProc.stderr.on('data', (d) => { mcpStderr += d.toString() })
mcpProc.stdout.on('data', () => {})

async function cleanup() {
  try { mcpProc.kill('SIGKILL') } catch {}
  try { mockServer.close() } catch {}
}
process.on('exit', () => { try { mcpProc.kill('SIGKILL') } catch {} })

try {
  // wait for bridge-mcp health
  let up = false
  for (let i = 0; i < 40; i++) {
    try { const h = await httpGet(`http://127.0.0.1:${MCP_PORT}/health`); if (h?.ok) { up = true; break } } catch {}
    await sleep(250)
  }
  rec('bridge-mcp server starts', up, up ? 'health ok' : 'no health')

  // connect an MCP client THROUGH bridge-mcp
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'p1d-smoke', version: '0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${MCP_PORT}/mcp/${WS}/${PROJECT}`),
    { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
  ))
  rec('MCP session through bridge-mcp', true, 'connected')

  // count adoption lines BEFORE
  const before = fs.existsSync(ADOPTION_FILE)
    ? fs.readFileSync(ADOPTION_FILE, 'utf8').split('\n').filter(Boolean).length : 0

  // index + find_symbol through the proxy (real codegraph door at CODEGRAPH_PORT)
  const daemonDir = path.join(REPO, 'packages', 'daemon')
  const idx = await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: daemonDir, force: true, wait: true } })
  console.log('  index:', (idx.content?.[0]?.text ?? '').slice(0, 80).replace(/\n/g, ' '))

  const find = await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: daemonDir, name: 'PtyManager' } })
  const findText = find.content?.[0]?.text ?? '{}'
  let findData
  try { findData = JSON.parse(findText) } catch { findData = { results: [] } }
  const hits = (findData.results ?? []).filter(r => r.qualifiedName && r.qualifiedName.includes('PtyManager'))
  rec('bridge_codegraph_find_symbol returns real result', hits.length > 0, `hits=${hits.length} first=${JSON.stringify(hits[0])?.slice(0, 100)}`)

  // allow async appendFile to flush
  await sleep(300)
  const after = fs.existsSync(ADOPTION_FILE)
    ? fs.readFileSync(ADOPTION_FILE, 'utf8').split('\n').filter(Boolean).length : 0
  const newLines = after - before
  // find at least one line naming bridge_codegraph_find_symbol
  const lastLines = fs.existsSync(ADOPTION_FILE)
    ? fs.readFileSync(ADOPTION_FILE, 'utf8').split('\n').filter(Boolean).slice(-newLines)
    : []
  const hasFindLine = lastLines.some(l => { try { return JSON.parse(l).tool === 'bridge_codegraph_find_symbol' } catch { return false } })
  rec('adoption.jsonl incremented for bridge_codegraph_find_symbol', newLines >= 2 && hasFindLine,
    `newLines=${newLines} hasFindLine=${hasFindLine}`)

  await client.close()
} catch (err) {
  console.error('\nSMOKE ERROR:', err)
  rec('smoke runner', false, String(err))
} finally {
  await cleanup()
}

console.log('\n=== P1-D SMOKE ===')
const passed = results.filter(r => r.ok).length
console.log(`${passed}/${results.length} passed`)
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`)
process.exit(passed === results.length ? 0 : 1)
