import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import path from 'node:path'
import os from 'os'
import { fileURLToPath } from 'node:url'

const PORT = '3293'
const PKG = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(PKG, 'dist', 'index.cjs')
const HOOK = path.join(PKG, 'hooks', 'codegraph-discovery-gate.mjs')
const NODE_BIN = process.execPath

const gate = []
const prior = []
const recGate = (name, ok, detail) => { gate.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  [P3] ${name} — ${detail}`) }
const recPrior = (name, ok, detail) => { prior.push({ ok }); console.log(`${ok ? 'PASS' : 'SKIP'}  [prior] ${name} — ${detail}`) }

// Start an isolated codegraph HTTP server on `port` (used for smokes that don't
// boot their own, e.g. live-smoke-p1.mjs which connects to :3251).
function startServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE_BIN, [SERVER], {
      env: { ...process.env, CODEGRAPH_PORT: String(port), CODEGRAPH_STDIO: '0' },
      stdio: ['ignore', 'inherit', 'pipe'],
    })
    let buf = ''
    const onErr = (d) => {
      buf += d.toString()
      if (buf.includes('listening')) resolve(proc)
    }
    proc.stderr.on('data', onErr)
    proc.on('error', reject)
    setTimeout(() => reject(new Error('server did not start on ' + port + '; stderr:\n' + buf)), 20000)
  })
}

// ── fixture repo (indexed by the hook's structural call via the bin) ──
const repo = mkdtempSync(path.join(os.tmpdir(), 'codegraph-p3-repo-'))
mkdirSync(path.join(repo, 'src'), { recursive: true })
writeFileSync(path.join(repo, 'src', 'alpha.ts'),
  `export class KwikLookup {\n  find(): void { return; }\n}\nexport function kwickSearch(): void {\n  const k = new KwikLookup();\n  k.find();\n}\n`)
const kwickCwd = repo

// ── 1. Hook: Grep event WITH codegraph available ──
const grepPayload = JSON.stringify({
  session_id: 'p3-smoke',
  tool_name: 'Grep',
  tool_input: { pattern: 'KwikLookup', path: kwickCwd, output_mode: 'content' },
})
const hookUp = spawnSync(NODE_BIN, [HOOK], {
  input: grepPayload,
  encoding: 'utf8',
  timeout: 30000,
  env: { ...process.env, CODEGRAPH_BIN: SERVER, CODEGRAPH_HOOK_TIMEOUT_MS: '8000' },
})
const hookUpOut = (hookUp.stdout || '')
const hookUpExit = hookUp.status ?? 1
let hookUpJson = null
try { hookUpJson = JSON.parse(hookUpOut) } catch { /* not JSON */ }
recGate('hook: Grep event exits 0 (codegraph up)',
  hookUpExit === 0,
  `exit=${hookUpExit}`)
recGate('hook: emits additionalContext with codegraph result',
  hookUpExit === 0 && !!hookUpJson && typeof hookUpJson.additionalContext === 'string'
    && hookUpJson.additionalContext.includes('KwikLookup'),
  `hasAdditionalContext=${!!(hookUpJson && hookUpJson.additionalContext)} matchesKwik=${!!(hookUpJson && (hookUpJson.additionalContext||'').includes('KwikLookup'))}`)
recGate('hook: non-blocking permissionDecision allow',
  !!hookUpJson && hookUpJson.hookSpecificOutput?.permissionDecision === 'allow',
  `decision=${hookUpJson?.hookSpecificOutput?.permissionDecision}`)

// ── 2. Hook: Grep event WITH codegraph DOWN ──
const hookDown = spawnSync(NODE_BIN, [HOOK], {
  input: grepPayload,
  encoding: 'utf8',
  timeout: 30000,
  env: { ...process.env, CODEGRAPH_BIN: '/nonexistent/codegraph-bin-does-not-exist', CODEGRAPH_HOOK_TIMEOUT_MS: '2000' },
})
const hookDownExit = hookDown.status ?? 1
let hookDownJson = null
try { hookDownJson = JSON.parse((hookDown.stdout || '').trim()) } catch { /* not JSON = passthrough */ }
recGate('hook: Grep event still exits 0 when codegraph DOWN',
  hookDownExit === 0,
  `exit=${hookDownExit}`)
recGate('hook: no crash / empty passthrough when DOWN',
  hookDownExit === 0 && !(hookDownJson && hookDownJson.additionalContext),
  `stdoutEmpty=${(hookDown.stdout || '').trim().length === 0} additionalContextPresent=${!!(hookDownJson && hookDownJson.additionalContext)}`)

// ── 3. Hook: non-gated tool (Read) passes through untouched ──
const readPayload = JSON.stringify({
  session_id: 'p3-smoke',
  tool_name: 'Read',
  tool_input: { file_path: path.join(repo, 'src', 'alpha.ts') },
})
const hookRead = spawnSync(NODE_BIN, [HOOK], {
  input: readPayload,
  encoding: 'utf8',
  timeout: 30000,
  env: { ...process.env, CODEGRAPH_BIN: SERVER },
})
recGate('hook: Read is NOT gated (exit 0, no additionalContext)',
  (hookRead.status ?? 1) === 0 && !/additionalContext/.test(hookRead.stdout || ''),
  `exit=${hookRead.status} hasCtx=${/additionalContext/.test(hookRead.stdout || '')}`)

// ── 4. Adoption-gate evaluator ──
// Point HOME at a temp dir so we don't touch the real ~/.jerico, then seed
// a few adoption.jsonl lines and assert the evaluator prints proxy + verdict.
const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'codegraph-p3-home-'))
const cgDir = path.join(fakeHome, '.jerico', 'codegraph')
mkdirSync(cgDir, { recursive: true })
const seedLines = [
  { ts: 1, tool: 'bridge_codegraph_index', cwd: '/proj/a' },
  { ts: 2, tool: 'bridge_codegraph_find_symbol', cwd: '/proj/a' },
  { ts: 3, tool: 'bridge_codegraph_find_references', cwd: '/proj/a' },
  { ts: 4, tool: 'bridge_codegraph_index', cwd: '/proj/b' },
  { ts: 5, tool: 'codegraph_hook_inject', pattern: 'foo', cwd: '/proj/a' },
]
writeFileSync(path.join(cgDir, 'adoption.jsonl'), seedLines.map(l => JSON.stringify(l)).join('\n') + '\n')

const gateRun = spawnSync(NODE_BIN, [SERVER, 'adoption-gate'], {
  encoding: 'utf8',
  timeout: 30000,
  env: { ...process.env, HOME: fakeHome },
})
const gateOut = (gateRun.stdout || '') + (gateRun.stderr || '')
recGate('adoption-gate: prints adoption proxy',
  /adoption proxy/.test(gateOut),
  `exit=${gateRun.status}`)
recGate('adoption-gate: prints a VERDICT line',
  /VERDICT\s*:/.test(gateOut),
  `verdict=${(gateOut.match(/VERDICT\s*:\s*(\w+)/) || [])[1] || 'none'}`)
recGate('adoption-gate: reports hook injects',
  /hook injects/.test(gateOut) && /codegraph_hook_inject/.test(JSON.stringify(seedLines)),
  `mentionsHookInjects=${/hook injects/.test(gateOut)}`)

// ── 6. Walk-fix regression: nested calls captured (Promise.all/arr.map/.then) ──
{
  const nest = mkdtempSync(path.join(os.tmpdir(), 'codegraph-p3-nest-'))
  mkdirSync(path.join(nest, 'src'), { recursive: true })
  writeFileSync(path.join(nest, 'src', 'nested.ts'),
`export function foo(): void { return; }
export function bar(x: number): void { return; }
export function caller(): void {
  Promise.all([foo(), bar(1)]);
  const arr = [1, 2];
  arr.map((x) => foo());
  something().then(() => bar(2));
}
`)
  const srv = await startServer(3294)
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const cli = new Client({ name: 'p3-nest', version: '0' }, { capabilities: {} })
  await cli.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3294/mcp')))
  await cli.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: nest, force: true, wait: true } })
  const fooQn = 'src/nested.foo'
  const fooRefs = JSON.parse((await cli.callTool({ name: 'bridge_codegraph_find_references', arguments: { cwd: nest, qualifiedName: fooQn } })).content[0].text)
  const fooCallers = (fooRefs.references ?? []).map(r => r.callerFile)
  recGate('walkfix: nested foo() in Promise.all/arr.map is captured',
    fooCallers.some(f => f.includes('nested.ts')),
    `foo callers=${JSON.stringify([...new Set(fooCallers)])}`)
  const barQn = 'src/nested.bar'
  const barRefs = JSON.parse((await cli.callTool({ name: 'bridge_codegraph_find_references', arguments: { cwd: nest, qualifiedName: barQn } })).content[0].text)
  const barCallers = (barRefs.references ?? []).map(r => r.callerFile)
  recGate('walkfix: nested bar() in Promise.all/.then is captured',
    barCallers.some(f => f.includes('nested.ts')),
    `bar callers=${JSON.stringify([...new Set(barCallers)])}`)
  await cli.close()
  srv.kill()
  rmSync(nest, { recursive: true, force: true })
}

// ── 5. Prior regressions: P1 6/6, P2a 11/11, P2b 7/7, P2c 26/26 ──
console.log('\n=== prior smokes (regression) ===')
// P1 connects to a codegraph server on :3251 — boot an isolated one.
let p1Srv = null
try { p1Srv = await startServer(3251) } catch (e) { console.error('P1 server start failed:', e?.message ?? e) }
const p1 = spawnSync(NODE_BIN, ['live-smoke-p1.mjs'], { cwd: PKG, encoding: 'utf8', timeout: 180000 })
try { p1Srv?.kill() } catch {}
const p1Out = (p1.stdout || '') + (p1.stderr || '')
recPrior('live-smoke-p1.mjs 6/6',
  p1.status === 0 && /LIVE SMOKE: \d+\/\d+ PASS/.test(p1Out) && !/FAIL/.test(p1Out),
  (p1Out.match(/LIVE SMOKE: \d+\/\d+ PASS/) || ['no summary'])[0])

const p2a = spawnSync(NODE_BIN, ['live-smoke-p2a.mjs'], { cwd: PKG, encoding: 'utf8', timeout: 180000 })
const p2aOut = (p2a.stdout || '') + (p2a.stderr || '')
recPrior('live-smoke-p2a.mjs 11/11',
  p2a.status === 0 && /LIVE SMOKE: \d+\/\d+ PASS/.test(p2aOut) && !/FAIL/.test(p2aOut),
  (p2aOut.match(/LIVE SMOKE: \d+\/\d+ PASS/) || ['no summary'])[0])

const p2b = spawnSync(NODE_BIN, ['live-smoke-p2b.mjs'], { cwd: PKG, encoding: 'utf8', timeout: 180000 })
const p2bOut = (p2b.stdout || '') + (p2b.stderr || '')
recPrior('live-smoke-p2b.mjs 7/7',
  p2b.status === 0 && /P2B GATE: \d+\/\d+ PASS/.test(p2bOut) && !/FAIL/.test(p2bOut),
  (p2bOut.match(/P2B GATE: \d+\/\d+ PASS/) || ['no summary'])[0])

const p2c = spawnSync(NODE_BIN, ['live-smoke-p2c.mjs'], { cwd: PKG, encoding: 'utf8', timeout: 180000 })
const p2cOut = (p2c.stdout || '') + (p2c.stderr || '')
recPrior('live-smoke-p2c.mjs 26/26',
  p2c.status === 0 && /P2C GATE: 26\/26 PASS/.test(p2cOut) && !/FAIL/.test(p2cOut),
  (p2cOut.match(/P2C GATE: \d+\/\d+ PASS/) || ['no summary'])[0])

// ── summary ──
const gateFailed = gate.filter(r => !r.ok).length
const priorPass = prior.filter(r => r.ok === true).length
console.log(`\n=== P3 GATE: ${gate.length - gateFailed}/${gate.length} PASS ===`)
console.log(`=== PRIOR: ${priorPass}/4 PASS (P1 6/6, P2a 11/11, P2b 7/7, P2c 26/26) ===`)
rmSync(repo, { recursive: true, force: true })
rmSync(fakeHome, { recursive: true, force: true })
console.log('P3 DONE')
process.exit(gateFailed ? 1 : 0)
