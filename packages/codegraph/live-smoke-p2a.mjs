import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import os from 'os'
import { fileURLToPath } from 'node:url'

const PORT = '3299'
const PKG = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(PKG, 'dist', 'index.cjs')
const NODE_BIN = process.execPath

const results = []
const rec = (name, ok, detail) => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`) }
const parse = (r) => JSON.parse(r.content[0].text)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'codegraph-p2a-'))

function writePyProj(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'utils.py'), `def helper():\n    return 42\n\ndef caller():\n    return helper()\n`)
  writeFileSync(path.join(dir, 'app.py'), `from utils import helper\n\ndef run():\n    return helper()\n`)
}

function writeGoProj(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'main.go'), `package main\n\nimport "fmt"\n\nfunc helper() int {\n\treturn 42\n}\n\nfunc main() {\n\tfmt.Println(helper())\n}\n`)
  writeFileSync(path.join(dir, 'calc.go'), `package main\n\ntype Calculator struct {\n\tvalue int\n}\n\nfunc (c Calculator) Add(a int) int {\n\treturn a + c.value\n}\n\nfunc useCalc() int {\n\tc := Calculator{value: 3}\n\treturn c.Add(4)\n}\n`)
}

const client = new Client({ name: 'p2a-smoke', version: '0' }, { capabilities: {} })

try {
  const server = await startServer()
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)))

  const pyDir = path.join(ROOT, 'py_proj')
  const goDir = path.join(ROOT, 'go_proj')
  writePyProj(pyDir)
  writeGoProj(goDir)

  // ---------- Python ----------
  console.log('--- Python ---')
  const pyIdx = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: pyDir, force: true, wait: true } }))
  rec('py: index produced files', pyIdx.total >= 2, `total=${pyIdx.total}`)

  const pySym = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: pyDir, name: 'helper' } }))
  rec('py: find_symbol finds def', (pySym.results ?? []).length > 0, `results=${(pySym.results ?? []).length}`)

  const pyOutline = parse(await client.callTool({ name: 'bridge_codegraph_file_outline', arguments: { cwd: pyDir, file: 'utils.py' } }))
  const pyOutlineNames = (pyOutline.results ?? []).map(r => r.qualifiedName)
  rec('py: file_outline lists top-level defs', pyOutlineNames.some(n => n.includes('helper')) && pyOutlineNames.some(n => n.includes('caller')), JSON.stringify(pyOutlineNames))

  const pyQn = `utils.helper`
  const pyRef = parse(await client.callTool({ name: 'bridge_codegraph_find_references', arguments: { cwd: pyDir, qualifiedName: pyQn } }))
  rec('py: find_references surfaces caller', (pyRef.references ?? []).length > 0, `refs=${(pyRef.references ?? []).length} cov=${JSON.stringify(pyRef.resolutionCoverage)}`)

  const pyCg = parse(await client.callTool({ name: 'bridge_codegraph_call_graph', arguments: { cwd: pyDir, qualifiedName: 'utils.caller', direction: 'out' } }))
  const pyCgNames = (pyCg.nodes ?? []).map(n => n.name)
  rec('py: call_graph shows intra-file call', pyCgNames.includes('caller') && pyCgNames.includes('helper'), JSON.stringify(pyCgNames))

  // ---------- Go ----------
  console.log('--- Go ---')
  const goIdx = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: goDir, force: true, wait: true } }))
  rec('go: index produced files', goIdx.total >= 2, `total=${goIdx.total}`)

  const goSym = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: goDir, name: 'helper' } }))
  rec('go: find_symbol finds func', (goSym.results ?? []).length > 0, `results=${(goSym.results ?? []).length}`)

  const goOutline = parse(await client.callTool({ name: 'bridge_codegraph_file_outline', arguments: { cwd: goDir, file: 'calc.go' } }))
  const goOutlineNames = (goOutline.results ?? []).map(r => r.qualifiedName)
  rec('go: file_outline lists type + funcs', goOutlineNames.some(n => n.includes('Calculator')) && goOutlineNames.some(n => n.includes('Add')), JSON.stringify(goOutlineNames))

  const goRef = parse(await client.callTool({ name: 'bridge_codegraph_find_references', arguments: { cwd: goDir, qualifiedName: 'main.helper' } }))
  rec('go: find_references surfaces caller', (goRef.references ?? []).length > 0, `refs=${(goRef.references ?? []).length} cov=${JSON.stringify(goRef.resolutionCoverage)}`)

  const goCg = parse(await client.callTool({ name: 'bridge_codegraph_call_graph', arguments: { cwd: goDir, qualifiedName: 'main.main', direction: 'out' } }))
  const goCgNames = (goCg.nodes ?? []).map(n => n.name)
  rec('go: call_graph shows intra-file call', goCgNames.includes('main') && goCgNames.includes('helper'), JSON.stringify(goCgNames))

  // ---------- coverage present ----------
  const st = parse(await client.callTool({ name: 'bridge_codegraph_status', arguments: { cwd: goDir } }))
  rec('coverage: resolutionCoverage present on status', !!st.resolutionCoverage, JSON.stringify(st.resolutionCoverage))

  await client.close()
  server.kill()
} catch (e) {
  console.error('SMOKE ERROR:', e)
  rec('smoke completed without exception', false, String(e))
} finally {
  rmSync(ROOT, { recursive: true, force: true })
  const failed = results.filter(r => !r.ok).length
  console.log(`\n=== P2A LIVE SMOKE: ${results.length - failed}/${results.length} PASS ===`)
  process.exit(failed ? 1 : 0)
}
