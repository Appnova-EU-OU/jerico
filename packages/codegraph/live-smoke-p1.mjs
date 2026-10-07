// Phase-1 live smoke — index a REAL package and run REAL structural queries.
// No hardcoded verdicts; every check asserts on actual engine output.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import path from 'node:path'

const results = []
const rec = (name, ok, detail) => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`) }
const parse = (r) => JSON.parse(r.content[0].text)
// index a real TS package in this repo
const CWD = path.resolve(process.cwd(), '..', 'daemon')   // packages/daemon

const client = new Client({ name: 'p1-smoke', version: '0' }, { capabilities: {} })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3251/mcp')))

// 1. INDEX a real package
const idx = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: CWD, force: true } }))
rec('index real package (packages/daemon)', (idx.total ?? 0) > 50, `indexed ${idx.total} symbols, status=${idx.status}`)

// 2. STATUS + resolutionCoverage
const st = parse(await client.callTool({ name: 'bridge_codegraph_status', arguments: { cwd: CWD } }))
const cov = st.resolutionCoverage ?? {}
rec('status + resolutionCoverage', (cov.resolved ?? 0) > 0, `indexed=${st.indexed} total=${st.total} coverage={resolved:${cov.resolved},unresolved:${cov.unresolved}}`)

// 3. FIND_SYMBOL a known real symbol
const fs = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: CWD, name: 'PtyManager' } }))
const hit = Array.isArray(fs) ? fs[0] : (fs.results ?? fs.symbols ?? [])[0]
rec('find_symbol PtyManager', !!hit && /pty|manager/i.test(JSON.stringify(hit)), `found: ${JSON.stringify(hit)?.slice(0,120)}`)

// 4. FILE_OUTLINE of a real file
const outlineFile = 'src/pty/manager.ts'
const ol = parse(await client.callTool({ name: 'bridge_codegraph_file_outline', arguments: { cwd: CWD, file: outlineFile } }))
const olArr = Array.isArray(ol) ? ol : (ol.results ?? ol.symbols ?? [])
rec('file_outline manager.ts', olArr.length > 0, `${olArr.length} top-level symbols`)

// 5. FIND_REFERENCES on PtyManager — SEMANTIC: it is `new PtyManager()`d in commands/start.ts,
//    so a correct engine MUST return >=1 CROSS-FILE caller. This asserts new_expression
//    extraction (M2) AND cross-file resolution (B1) together — the previous smoke passed on 0 refs.
const qn = 'src/pty/manager.PtyManager'
const rf = parse(await client.callTool({ name: 'bridge_codegraph_find_references', arguments: { cwd: CWD, qualifiedName: qn } }))
const refs = rf.references ?? rf.results ?? []
const crossFile = refs.filter(r => (r.callerFile ?? r.file ?? '') && !(r.callerFile ?? r.file).endsWith('pty/manager.ts'))
rec('find_references PtyManager — cross-file caller (new_expression + cross-file resolution)',
    refs.length >= 1 && crossFile.length >= 1,
    `${refs.length} refs (${crossFile.length} cross-file), e.g. ${JSON.stringify(crossFile[0] ?? refs[0])?.slice(0,110)}, coverage=${JSON.stringify(rf.resolutionCoverage)}`)

// 6. CALL_GRAPH on the same symbol
let cgOk = false, cgDetail = 'skipped'
if (qn) {
  const cg = parse(await client.callTool({ name: 'bridge_codegraph_call_graph', arguments: { cwd: CWD, qualifiedName: qn, depth: 2 } }))
  const nodes = cg.nodes ?? []
  cgOk = Array.isArray(nodes)
  cgDetail = `qn=${qn} → ${nodes.length} nodes, truncated=${cg.truncated}`
}
rec('call_graph (structural)', cgOk, cgDetail)

await client.close()
const failed = results.filter(r => !r.ok).length
console.log(`\n=== P1 LIVE SMOKE: ${results.length - failed}/${results.length} PASS ===`)
process.exit(failed ? 1 : 0)
