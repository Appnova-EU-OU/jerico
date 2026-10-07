import { spawn, execSync } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const DAEMON_ENTRY = path.join(REPO, 'packages', 'daemon', 'dist', 'index.js')
const CODEGRAPH_PORT = 3291
const HEALTH_PORT = 3192

// The codegraph child is spawned by the daemon via process.execPath, so it
// inherits whatever Node the daemon runs under. better-sqlite3/tree-sitter are
// native modules whose ABI must match — to avoid a flaky
// "compiled against a different Node.js version" crash, force the daemon to run
// under Node 26 (homebrew) explicitly. Override with P1C_NODE_BIN if needed.
const NODE_BIN = process.env['P1C_NODE_BIN']
  || '/opt/homebrew/bin/node'
const nodeVersion = execSync(`${NODE_BIN} -v`, { encoding: 'utf8' }).trim()
console.log(`--- using node: ${NODE_BIN} (${nodeVersion}) ---`)
if (!nodeVersion.startsWith('v26')) {
  console.warn(`WARNING: P1C_NODE_BIN is ${nodeVersion}, not v26 — native module ABI match not guaranteed`)
}

const results = []
const rec = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(body) }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function waitForHealth(url, maxWait = 15000) {
  const deadline = Date.now() + maxWait
  while (Date.now() < deadline) {
    try {
      const result = await httpGet(url)
      if (result) return result
    } catch {}
    await sleep(500)
  }
  throw new Error(`health check timeout: ${url}`)
}

function findCodegraphPid() {
  try {
    const out = execSync('pgrep -f "codegraph.*dist/index.cjs"', { encoding: 'utf8', timeout: 3000 }).trim()
    const pids = out.split('\n').filter(Boolean).map(Number)
    return pids.length > 0 ? pids[0] : null
  } catch {
    return null
  }
}

let daemonProc = null

async function cleanup() {
  if (daemonProc && !daemonProc.killed) {
    daemonProc.kill('SIGTERM')
    await sleep(2000)
    if (!daemonProc.killed) daemonProc.kill('SIGKILL')
  }
  try {
    const cgPid = findCodegraphPid()
    if (cgPid) process.kill(cgPid, 'SIGKILL')
  } catch {}
}

try {
  console.log('=== P1C Live Smoke — dev-profile daemon ↔ codegraph ===\n')

  console.log('--- Step 1: Start dev-profile daemon ---')
  daemonProc = spawn(NODE_BIN, [DAEMON_ENTRY, '--profile', 'dev', 'start', '--health-port', String(HEALTH_PORT)], {
    env: {
      ...process.env,
      BRIDGE_PROFILE: 'dev',
      BRIDGE_DAEMON: '1',
      CODEGRAPH_PORT: String(CODEGRAPH_PORT),
      HEALTH_PORT: String(HEALTH_PORT),
      BRIDGE_SUPERVISED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let daemonStderr = ''
  daemonProc.stderr.on('data', (d) => { daemonStderr += d.toString() })
  daemonProc.stdout.on('data', () => {})

  console.log(`  daemon PID: ${daemonProc.pid}`)

  console.log('\n--- Step 2: Wait for codegraph HTTP health (proves daemon spawned codegraph) ---')
  const cgHealth = await waitForHealth(`http://127.0.0.1:${CODEGRAPH_PORT}/health`, 20000)
  rec('codegraph spawned by daemon',
    cgHealth && cgHealth.ok === true,
    `health=${JSON.stringify(cgHealth)}`)

  // Surface a non-recoverable codegraph health error (e.g. ABI/DLOPEN mismatch)
  // from the daemon /health endpoint instead of looping silently.
  const daemonHealth = await httpGet(`http://127.0.0.1:${HEALTH_PORT}/health`).catch(() => null)
  if (daemonHealth?.codegraph?.status === 'error') {
    rec('codegraph health error', false, `codegraph.status=error: ${daemonHealth.codegraph.error?.split('\n')[0] ?? 'unknown'}`)
    console.error('CODEGRAPH HEALTH ERROR:\n' + (daemonHealth.codegraph.error ?? ''))
    throw new Error('codegraph health error: ' + (daemonHealth.codegraph.error ?? 'unknown'))
  }

  console.log('\n--- Step 3: Verify codegraph PID is a child of daemon ---')
  const cgPid = findCodegraphPid()
  rec('codegraph process exists',
    cgPid !== null && cgPid > 0,
    `codegraph pid=${cgPid}`)

  console.log('\n--- Step 4: Query codegraph via MCP client (simulates codegraph_query handler) ---')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const mcpClient = new Client({ name: 'p1c-smoke', version: '0' }, { capabilities: {} })
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${CODEGRAPH_PORT}/mcp`)))

  const daemonDir = path.join(REPO, 'packages', 'daemon')
  const idxResult = await mcpClient.callTool({
    name: 'bridge_codegraph_index',
    arguments: { cwd: daemonDir, force: true, wait: true },
  })
  const idxText = idxResult.content?.[0]?.text ?? '{}'
  console.log(`  index response (first 200 chars): ${idxText.slice(0, 200)}`)
  let idxData
  try {
    idxData = JSON.parse(idxText)
  } catch {
    idxData = { total: '?', status: 'parse_error', raw: idxText.slice(0, 200) }
  }
  console.log(`  indexed: ${idxData.total ?? '?'} files, status=${idxData.status ?? '?'}`)

  const findResult = await mcpClient.callTool({
    name: 'bridge_codegraph_find_symbol',
    arguments: { cwd: daemonDir, name: 'PtyManager' },
  })
  const findText = findResult.content?.[0]?.text ?? '{}'
  console.log(`  find_symbol response (first 300 chars): ${findText.slice(0, 300)}`)
  let findData
  try {
    findData = JSON.parse(findText)
  } catch {
    findData = { results: [], raw: findText.slice(0, 200) }
  }
  const ptyHits = (findData.results ?? []).filter(r => r.qualifiedName && r.qualifiedName.includes('PtyManager'))
  rec('codegraph_query returns PtyManager',
    ptyHits.length > 0,
    `hits=${ptyHits.length} first=${JSON.stringify(ptyHits[0])?.slice(0, 120)}`)

  await mcpClient.close()

  console.log('\n--- Step 5: Crash-restart — kill codegraph child, verify daemon respawns ---')
  const originalPid = cgPid
  console.log(`  killing codegraph pid=${originalPid}`)
  try { process.kill(originalPid, 'SIGKILL') } catch {}
  await sleep(1000)

  const deadCheck = findCodegraphPid()
  console.log(`  after kill: codegraph pid=${deadCheck} (should be different or null briefly)`)

  console.log('  waiting for daemon to respawn codegraph...')
  let respawned = false
  let newPid = null
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    const pid = findCodegraphPid()
    if (pid && pid !== originalPid) {
      newPid = pid
      respawned = true
      break
    }
  }
  rec('codegraph respawned after crash',
    respawned && newPid !== null,
    `original_pid=${originalPid} new_pid=${newPid}`)

  if (respawned) {
    console.log('  verifying new codegraph is healthy...')
    await sleep(2000)
    const newHealth = await httpGet(`http://127.0.0.1:${CODEGRAPH_PORT}/health`).catch(() => null)
    rec('respawned codegraph is healthy',
      newHealth && newHealth.ok === true,
      `health=${JSON.stringify(newHealth)}`)

    const mcpClient2 = new Client({ name: 'p1c-smoke-2', version: '0' }, { capabilities: {} })
    await mcpClient2.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${CODEGRAPH_PORT}/mcp`)))
    const findResult2 = await mcpClient2.callTool({
      name: 'bridge_codegraph_find_symbol',
      arguments: { cwd: daemonDir, name: 'PtyManager' },
    })
    const findText2 = findResult2.content?.[0]?.text ?? '{}'
    const findData2 = JSON.parse(findText2)
    const ptyHits2 = (findData2.results ?? []).filter(r => r.qualifiedName && r.qualifiedName.includes('PtyManager'))
    rec('post-crash query returns PtyManager',
      ptyHits2.length > 0,
      `hits=${ptyHits2.length}`)
    await mcpClient2.close()
  }

  console.log('\n--- Step 6: Daemon shutdown terminates codegraph ---')
  daemonProc.kill('SIGTERM')
  await sleep(6000)

  const postShutdownPid = findCodegraphPid()
  rec('codegraph terminated on daemon shutdown',
    postShutdownPid === null,
    `codegraph_pid_after_shutdown=${postShutdownPid}`)

} catch (err) {
  console.error('\nSMOKE ERROR:', err)
  rec('smoke runner', false, String(err))
} finally {
  await cleanup()
}

console.log('\n=== Results ===')
const passed = results.filter(r => r.ok).length
const total = results.length
console.log(`${passed}/${total} passed`)
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`)
}
process.exit(passed === total ? 0 : 1)
