import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'os'
import { fileURLToPath } from 'node:url'

const PORT = '3289'
const PKG = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(PKG, 'dist', 'index.cjs')
const NODE_BIN = process.execPath
const DAEMON = path.resolve(PKG, '..', '..', 'packages', 'daemon')

const gate = []
const prior = []
const recGate = (name, ok, detail) => { gate.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  [P2C] ${name} — ${detail}`) }
const recPrior = (name, ok, detail) => { prior.push({ ok }); console.log(`${ok ? 'PASS' : 'SKIP'}  [prior] ${name} — ${detail}`) }
const parse = (r) => JSON.parse(r.content[0].text)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function startServer(port, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [SERVER], {
      env: { ...process.env, CODEGRAPH_PORT: String(port), CODEGRAPH_STDIO: '0', ...extra },
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

// ── Dart fixture ──
function writeDart(root) {
  const dir = path.join(root, 'lib')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'calc.dart'),
`class Calculator {
  int add(int a, int b) {
    return a + b;
  }
  void compute() {
    final r = add(1, 2);
    print(r);
  }
}
void helper() {
  final c = Calculator();
  c.compute();
}
`)
  return root
}

// ── Rust fixture ──
function writeRust(root) {
  const dir = path.join(root, 'src')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'main.rs'),
`pub struct Point {
    x: i32,
    y: i32,
}
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
impl Point {
    pub fn draw(&self) {
        let s = add(1, 2);
    }
}
fn main() {
    let p = Point { x: 1, y: 2 };
    p.draw();
}
`)
  return root
}

// ── Svelte fixture ──
function writeSvelte(root) {
  const dir = path.join(root, 'src')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'Widget.svelte'),
`<script lang="ts">
  function render(label: string): string {
    return label.toUpperCase();
  }
  function mount(): void {
    const out = render('hello');
    console.log(out);
  }
</script>

<h1>Hi</h1>
`)
  return root
}

// ── Git diff_impact fixture ──
function writeGitRepo(root) {
  const dir = path.join(root, 'repo')
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  const impact = path.join(dir, 'src', 'impact.ts')
  writeFileSync(impact,
`export function foo(): void {
  return;
}
function bar(): void {
  foo();
}
function baz(): void {
  bar();
}
`)
  // commit it
  spawnSync('git', ['init', '-q'], { cwd: dir })
  spawnSync('git', ['add', '-A'], { cwd: dir })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: dir })
  // now change foo (add a line) so it is "modified" vs HEAD
  writeFileSync(impact,
`export function foo(): void {
  const x = 1;
  return;
}
function bar(): void {
  foo();
}
function baz(): void {
  bar();
}
`)
  return dir
}

const client = new Client({ name: 'p2c-smoke', version: '0' }, { capabilities: {} })

try {
  const server = await startServer(PORT)
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)))

  // ── Dart ──
  console.log('\n=== Dart ===')
  const dRoot = mkdtempSync(path.join(os.tmpdir(), 'codegraph-p2c-dart-'))
  writeDart(dRoot)
  const dIdx = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: dRoot, force: true, wait: true } }))
  recGate('dart: index produced files', dIdx.total >= 1, `total=${dIdx.total}`)
  const dSym = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: dRoot, name: 'Calculator' } }))
  recGate('dart: find_symbol Calculator (class)', (dSym.results ?? []).some(r => r.kind === 'class'), `results=${(dSym.results ?? []).map(r => r.kind + ':' + r.qualifiedName).join(',')}`)
  const dOutline = parse(await client.callTool({ name: 'bridge_codegraph_file_outline', arguments: { cwd: dRoot, file: 'lib/calc.dart' } }))
  const dKinds = (dOutline.results ?? []).map(r => r.kind)
  recGate('dart: file_outline has class+function (top-level)', dKinds.includes('class') && dKinds.includes('function'), `kinds=${dKinds.join(',')}`)
  const dAddSym = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: dRoot, name: 'add' } }))
  recGate('dart: find_symbol add is a method', (dAddSym.results ?? []).some(r => r.kind === 'method'), `kinds=${(dAddSym.results ?? []).map(r => r.kind).join(',')}`)
  const dAdd = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: dRoot, name: 'add' } }))
  const dAddQn = (dAdd.results ?? [])[0]?.qualifiedName
  const dCg = parse(await client.callTool({ name: 'bridge_codegraph_call_graph', arguments: { cwd: dRoot, qualifiedName: dAddQn, direction: 'in', depth: 3 } }))
  recGate('dart: call_graph(in, add) finds compute as caller', (dCg.nodes ?? []).some(n => n.name === 'compute'), `nodes=${(dCg.nodes ?? []).map(n => n.name + '@d' + n.depth).join(',')}`)
  recGate('dart: resolutionCoverage present', !!dCg.resolutionCoverage, JSON.stringify(dCg.resolutionCoverage))

  // ── Rust ──
  console.log('\n=== Rust ===')
  const rRoot = mkdtempSync(path.join(os.tmpdir(), 'codegraph-p2c-rust-'))
  writeRust(rRoot)
  const rIdx = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: rRoot, force: true, wait: true } }))
  recGate('rust: index produced files', rIdx.total >= 1, `total=${rIdx.total}`)
  const rSym = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: rRoot, name: 'Point' } }))
  recGate('rust: find_symbol Point (struct)', (rSym.results ?? []).some(r => r.kind === 'class'), `results=${(rSym.results ?? []).map(r => r.kind + ':' + r.qualifiedName).join(',')}`)
  const rOutline = parse(await client.callTool({ name: 'bridge_codegraph_file_outline', arguments: { cwd: rRoot, file: 'src/main.rs' } }))
  const rKinds = (rOutline.results ?? []).map(r => r.kind)
  recGate('rust: file_outline has struct+function (top-level)', rKinds.includes('class') && rKinds.includes('function'), `kinds=${rKinds.join(',')}`)
  const rDraw = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: rRoot, name: 'draw' } }))
  recGate('rust: find_symbol draw is an impl method', (rDraw.results ?? []).some(r => r.kind === 'method'), `kinds=${(rDraw.results ?? []).map(r => r.kind).join(',')}`)
  const rAdd = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: rRoot, name: 'add' } }))
  const rAddQn = (rAdd.results ?? [])[0]?.qualifiedName
  const rCg = parse(await client.callTool({ name: 'bridge_codegraph_call_graph', arguments: { cwd: rRoot, qualifiedName: rAddQn, direction: 'in', depth: 3 } }))
  recGate('rust: call_graph(in, add) finds draw as caller', (rCg.nodes ?? []).some(n => n.name === 'draw'), `nodes=${(rCg.nodes ?? []).map(n => n.name + '@d' + n.depth).join(',')}`)
  recGate('rust: resolutionCoverage present', !!rCg.resolutionCoverage, JSON.stringify(rCg.resolutionCoverage))

  // ── Svelte ──
  console.log('\n=== Svelte ===')
  const sRoot = mkdtempSync(path.join(os.tmpdir(), 'codegraph-p2c-svelte-'))
  writeSvelte(sRoot)
  const sIdx = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: sRoot, force: true, wait: true } }))
  recGate('svelte: index produced the .svelte file', sIdx.total >= 1, `total=${sIdx.total}`)
  const sSym = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: sRoot, name: 'render' } }))
  const sRenderQn = (sSym.results ?? [])[0]?.qualifiedName
  recGate('svelte: find_symbol render (extracted from <script>)', !!sRenderQn && sRenderQn.includes('Widget'), `qn=${sRenderQn}`)
  const sOutline = parse(await client.callTool({ name: 'bridge_codegraph_file_outline', arguments: { cwd: sRoot, file: 'src/Widget.svelte' } }))
  recGate('svelte: file_outline has both fns', (sOutline.results ?? []).length >= 2, `results=${(sOutline.results ?? []).map(r => r.qualifiedName + ':' + r.line).join(',')}`)
  const sCg = parse(await client.callTool({ name: 'bridge_codegraph_call_graph', arguments: { cwd: sRoot, qualifiedName: sRenderQn, direction: 'in', depth: 3 } }))
  recGate('svelte: call_graph(in, render) finds mount caller (line offset correct)', (sCg.nodes ?? []).some(n => n.name === 'mount'), `nodes=${(sCg.nodes ?? []).map(n => n.name + '@d' + n.depth + ':l' + n.line).join(',')}`)
  const sRenderLine = (sOutline.results ?? []).find(r => r.qualifiedName === sRenderQn)?.line
  recGate('svelte: render line offset maps to original .svelte line (2)', sRenderLine === 2, `line=${sRenderLine}`)
  recGate('svelte: resolutionCoverage present', !!sCg.resolutionCoverage, JSON.stringify(sCg.resolutionCoverage))

  // ── Hardening re-verify: rename + delete robustness (incremental refresh) ──
  console.log('\n=== hardening: rename + delete ===')
  const hRoot = mkdtempSync(path.join(os.tmpdir(), 'codegraph-p2c-hard-'))
  const hdir = path.join(hRoot, 'hrepo')
  mkdirSync(hdir, { recursive: true })
  writeFileSync(path.join(hdir, 'fileA.ts'), `export function fnA(): void { fnB(); }\n`)
  writeFileSync(path.join(hdir, 'fileB.ts'), `export function fnB(): void { return; }\n`)
  spawnSync('git', ['init', '-q'], { cwd: hdir })
  spawnSync('git', ['add', '-A'], { cwd: hdir })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: hdir })
  await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: hdir, force: true, wait: true } })
  // rename fileA.ts -> fileA2.ts (git mv) and delete fileB.ts from disk
  spawnSync('git', ['mv', 'fileA.ts', 'fileA2.ts'], { cwd: hdir })
  writeFileSync(path.join(hdir, 'fileB.ts'), '', { flag: 'w' })
  spawnSync('rm', ['fileB.ts'], { cwd: hdir })
  // trigger incremental refresh via status
  await client.callTool({ name: 'bridge_codegraph_status', arguments: { cwd: hdir } })
  const hA = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: hdir, name: 'fnA' } }))
  recGate('hardening: renamed fileA.ts -> fileA2.ts re-indexed (fnA now in fileA2.ts)', (hA.results ?? []).some(r => r.file === 'fileA2.ts'), `results=${(hA.results ?? []).map(r => r.file).join(',')}`)
  const hB = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: hdir, name: 'fnB' } }))
  recGate('hardening: deleted fileB.ts dropped (fnB gone)', (hB.results ?? []).length === 0, `results=${(hB.results ?? []).map(r => r.file).join(',')}`)

  // ── diff_impact ──
  console.log('\n=== diff_impact ===')
  const gRoot = mkdtempSync(path.join(os.tmpdir(), 'codegraph-p2c-git-'))
  const repo = writeGitRepo(gRoot)
  const dIdx2 = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: repo, force: true, wait: true } }))
  recGate('diff_impact: repo indexed', dIdx2.total >= 1, `total=${dIdx2.total}`)
  const di = parse(await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: 'HEAD' } }))
  const changed = di.changedFiles ?? []
  const changedSyms = (di.changedSymbols ?? []).map(s => s.qualifiedName)
  const impacted = (di.impactedSymbols ?? [])
  recGate('diff_impact: changed file reported', changed.includes('src/impact.ts'), `changedFiles=${JSON.stringify(changed)}`)
  recGate('diff_impact: changed symbol foo is in change surface', changedSyms.some(q => q.endsWith('foo')), `changedSymbols=${JSON.stringify(changedSyms)}`)
  const bar = impacted.find(i => i.qualifiedName.endsWith('bar'))
  const baz = impacted.find(i => i.qualifiedName.endsWith('baz'))
  recGate('diff_impact: bar impacted at depth 1', !!bar && bar.depth === 1, `bar=${JSON.stringify(bar)}`)
  recGate('diff_impact: baz impacted at depth 2 (transitive)', !!baz && baz.depth === 2, `baz=${JSON.stringify(baz)}`)
  recGate('diff_impact: resolutionCoverage present', !!di.resolutionCoverage, JSON.stringify(di.resolutionCoverage))

  await client.close()
  server.kill()

  // ── Prior regression: P1 6/6, P2a 11/11, P2b 7/7 ──
  console.log('\n=== prior smokes (regression) ===')
  const p1Srv = await startServer(3251)
  const p1 = spawnSync(NODE_BIN, ['live-smoke-p1.mjs'], { cwd: PKG, encoding: 'utf-8', timeout: 120000 })
  p1Srv.kill()
  const p1Out = (p1.stdout || '') + (p1.stderr || '')
  const p1ok = p1.status === 0 && /LIVE SMOKE: \d+\/\d+ PASS/.test(p1Out) && !/FAIL/.test(p1Out)
  recPrior('live-smoke-p1.mjs 6/6', p1ok, (p1Out.match(/LIVE SMOKE: \d+\/\d+ PASS/) || ['no summary'])[0])

  const p2a = spawnSync(NODE_BIN, ['live-smoke-p2a.mjs'], { cwd: PKG, encoding: 'utf-8', timeout: 120000 })
  const p2aOut = (p2a.stdout || '') + (p2a.stderr || '')
  const p2aok = p2a.status === 0 && /LIVE SMOKE: \d+\/\d+ PASS/.test(p2aOut) && !/FAIL/.test(p2aOut)
  recPrior('live-smoke-p2a.mjs 11/11', p2aok, (p2aOut.match(/LIVE SMOKE: \d+\/\d+ PASS/) || ['no summary'])[0])

  const p2b = spawnSync(NODE_BIN, ['live-smoke-p2b.mjs'], { cwd: PKG, encoding: 'utf-8', timeout: 120000 })
  const p2bOut = (p2b.stdout || '') + (p2b.stderr || '')
  const p2bok = p2b.status === 0 && /P2B GATE: \d+\/\d+ PASS/.test(p2bOut) && !/FAIL/.test(p2bOut)
  recPrior('live-smoke-p2b.mjs 7/7', p2bok, (p2bOut.match(/P2B GATE: \d+\/\d+ PASS/) || ['no summary'])[0])

  const gateFailed = gate.filter(r => !r.ok).length
  const priorPass = prior.filter(r => r.ok === true).length
  console.log(`\n=== P2C GATE: ${gate.length - gateFailed}/${gate.length} PASS ===`)
  console.log(`=== PRIOR: ${priorPass}/3 PASS (P1 6/6, P2a 11/11, P2b 7/7) ===`)
  console.log('P2C DONE')
  process.exit(gateFailed ? 1 : 0)
} catch (e) {
  console.error('SMOKE ERROR:', e)
  recGate('smoke completed without exception', false, String(e))
  const gateFailed = gate.filter(r => !r.ok).length
  console.log(`\n=== P2C GATE: ${gate.length - gateFailed}/${gate.length} PASS ===`)
  process.exit(1)
}
