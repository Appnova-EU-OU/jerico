import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const PORT = process.env['CODEGRAPH_PORT'] ?? '3253'
const REPO = path.resolve(process.cwd(), '..', '..')
const DAEMON_DIR = path.join(REPO, 'packages', 'daemon')
const results = []
const rec = (name, ok, detail) => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`) }
const parse = (r) => JSON.parse(r.content[0].text)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const client = new Client({ name: 'p1b-smoke', version: '0' }, { capabilities: {} })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)))

const TARGET_FILE = path.join(DAEMON_DIR, 'src', 'version.ts')
const originalContent = readFileSync(TARGET_FILE, 'utf-8')

try {
  console.log('--- Gate 1: mtime staleness fast-path (edit→query→reflects WITHOUT explicit index) ---')
  const idx1 = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: DAEMON_DIR, force: true, wait: true } }))
  console.log(`  indexed: ${idx1.total} files, status=${idx1.status}`)

  const before = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: DAEMON_DIR, name: '__P1B_MARKER__' } }))
  const beforeResults = before.results ?? []
  console.log(`  before edit: find_symbol('__P1B_MARKER__') → ${beforeResults.length} results`)

  appendFileSync(TARGET_FILE, '\nexport function __P1B_MARKER__() { return "p1b" }\n')
  console.log('  appended __P1B_MARKER__ to version.ts (cross-referenced file)')

  await sleep(50)

  const after = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: DAEMON_DIR, name: '__P1B_MARKER__' } }))
  const afterResults = after.results ?? []
  rec('staleness: edit→query→reflects WITHOUT explicit index',
    afterResults.length > 0 && afterResults.some(r => r.qualifiedName && r.qualifiedName.includes('__P1B_MARKER__')),
    `before=${beforeResults.length} after=${afterResults.length} found=${JSON.stringify(afterResults[0])?.slice(0, 100)}`)

  writeFileSync(TARGET_FILE, originalContent)
  console.log('  restored version.ts')

  console.log('\n--- Gate 2: deleted file pruning ---')
  const tempFile = path.join(DAEMON_DIR, 'src', '__p1b_temp_prune__.ts')
  writeFileSync(tempFile, 'export function __P1B_PRUNE_TARGET__() { return 42 }\n')
  console.log('  created temp file with __P1B_PRUNE_TARGET__')

  const idx2 = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: DAEMON_DIR, force: true, wait: true } }))
  console.log(`  re-indexed: ${idx2.total} files`)

  const foundBefore = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: DAEMON_DIR, name: '__P1B_PRUNE_TARGET__' } }))
  const foundBeforeResults = foundBefore.results ?? []
  console.log(`  before delete: find_symbol('__P1B_PRUNE_TARGET__') → ${foundBeforeResults.length} results`)

  rmSync(tempFile, { force: true })
  console.log('  deleted temp file')

  await sleep(50)

  const foundAfter = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: DAEMON_DIR, name: '__P1B_PRUNE_TARGET__' } }))
  const foundAfterResults = foundAfter.results ?? []
  rec('deleted file pruning: symbol gone after file delete (no reindex)',
    foundBeforeResults.length > 0 && foundAfterResults.length === 0,
    `before_delete=${foundBeforeResults.length} after_delete=${foundAfterResults.length}`)

  console.log('\n--- Gate 3: LRU warm-cache bounding ---')
  const tmpBase = path.join(os.tmpdir(), 'codegraph-p1b-lru')
  const dirs = []
  for (let i = 0; i < 3; i++) {
    const d = path.join(tmpBase, `proj-${i}`)
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, 'index.ts'), `export function p1bProj${i}() { return ${i} }\n`)
    dirs.push(d)
  }

  for (const d of dirs) {
    await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: d, force: true, wait: true } })
  }
  console.log(`  indexed 3 temp projects`)

  const lastDir = dirs[dirs.length - 1]
  const st = parse(await client.callTool({ name: 'bridge_codegraph_status', arguments: { cwd: lastDir } }))
  const openDbs = st.openDbs ?? 0
  const maxExpected = parseInt(process.env['CODEGRAPH_MAX_OPEN_DBS'] ?? '8', 10)
  rec('LRU: open DB count ≤ CODEGRAPH_MAX_OPEN_DBS',
    openDbs <= maxExpected,
    `openDbs=${openDbs} max=${maxExpected} (3 projects indexed)`)

  rmSync(tmpBase, { recursive: true, force: true })

  console.log('\n--- Gate 4: async index returns {status:"indexing"} immediately ---')
  const asyncDir = path.join(os.tmpdir(), 'codegraph-p1b-async')
  mkdirSync(asyncDir, { recursive: true })
  for (let i = 0; i < 20; i++) {
    writeFileSync(path.join(asyncDir, `file${i}.ts`), `export function asyncFunc${i}() { return ${i} }\n`)
  }

  const t0 = Date.now()
  const asyncResult = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: asyncDir, force: true, wait: false } }))
  const elapsed = Date.now() - t0

  rec('async index: returns {status:"indexing"} quickly',
    asyncResult.status === 'indexing' && elapsed < 5000,
    `status=${asyncResult.status} elapsed=${elapsed}ms`)

  let pollOk = false
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    const pollSt = parse(await client.callTool({ name: 'bridge_codegraph_status', arguments: { cwd: asyncDir } }))
    if (!pollSt.indexing && (pollSt.indexed ?? 0) > 0) {
      pollOk = true
      break
    }
  }
  rec('async index: status.indexing transitions to false',
    pollOk,
    `polling completed indexing`)

  rmSync(asyncDir, { recursive: true, force: true })

} finally {
  writeFileSync(TARGET_FILE, originalContent)
  try {
    const gitStatus = execSync('git status --short packages/daemon', { cwd: REPO, encoding: 'utf-8' }).trim()
    if (gitStatus) {
      console.log(`\nWARNING: daemon dir not clean: ${gitStatus}`)
    } else {
      console.log('\ngit status packages/daemon: CLEAN')
    }
  } catch {}

  await client.close()
  const failed = results.filter(r => !r.ok).length
  console.log(`\n=== P1B LIVE SMOKE: ${results.length - failed}/${results.length} PASS ===`)
  process.exit(failed ? 1 : 0)
}
