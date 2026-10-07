// P1BC fix gates — F2 (git rename re-index), F3 (new-dir untracked file),
// F4 (pre-P1B DB migration re-populates), F5 (status.stale reflects drift).
// Self-contained: spawns its own HTTP-only codegraph server against temp git
// repos, so it never touches the real repo working tree.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const NODE_BIN = process.env['P1C_NODE_BIN'] || '/opt/homebrew/bin/node'
const PORT = 3277
const ENTRY = path.join(__dirname, 'dist', 'index.cjs')

const results = []
const rec = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(b) } }) })
    req.on('error', reject)
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function git(cwd, args) {
  execSync(`git ${args}`, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cg-p1bc-'))
  git(dir, 'init -q')
  return dir
}

let server = null
const tmpDirs = []

async function main() {
  server = spawn(NODE_BIN, [ENTRY], {
    env: { ...process.env, CODEGRAPH_STDIO: '0', CODEGRAPH_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stderr.on('data', () => {})

  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try { const h = await httpGet(`http://127.0.0.1:${PORT}/health`); if (h?.ok) break } catch {}
    await sleep(300)
  }

  const client = new Client({ name: 'p1bc-fix', version: '0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)))
  const parse = (r) => JSON.parse(r.content[0].text)
  const call = (name, args) => client.callTool({ name, arguments: args }).then(parse)

  // ---- F5: status.stale reflects drift ----
  {
    const dir = makeRepo(); tmpDirs.push(dir)
    for (let i = 0; i < 12; i++) writeFileSync(path.join(dir, `f${i}.ts`), `export function fn${i}() { return ${i} }\n`)
    git(dir, 'add -A'); git(dir, 'commit -q -m init')
    await call('bridge_codegraph_index', { cwd: dir, force: true, wait: true })
    const st0 = await call('bridge_codegraph_status', { cwd: dir })
    await sleep(20)
    writeFileSync(path.join(dir, 'f0.ts'), `export function fn0() { return 999 }\n// changed\n`)
    const st1 = await call('bridge_codegraph_status', { cwd: dir })
    rec('F5 status.stale reflects drift after edit', st0.stale === 0 && st1.stale >= 1, `before=${st0.stale} after=${st1.stale}`)
  }

  // ---- F2: git rename re-indexes at new path ----
  {
    const dir = makeRepo(); tmpDirs.push(dir)
    writeFileSync(path.join(dir, 'a.ts'), `export function RenameTarget() { return 1 }\n`)
    for (let i = 0; i < 10; i++) writeFileSync(path.join(dir, `pad${i}.ts`), `export const pad${i} = ${i}\n`)
    git(dir, 'add -A'); git(dir, 'commit -q -m init')
    await call('bridge_codegraph_index', { cwd: dir, force: true, wait: true })
    const before = await call('bridge_codegraph_find_symbol', { cwd: dir, name: 'RenameTarget' })
    git(dir, 'mv a.ts b.ts')
    const after = await call('bridge_codegraph_find_symbol', { cwd: dir, name: 'RenameTarget' })
    const hit = (after.results ?? [])[0]
    rec('F2 renamed file re-indexes at destination path',
      (before.results ?? []).length === 1 && !!hit && hit.file === 'b.ts',
      `before_file=${(before.results ?? [])[0]?.file} after_file=${hit?.file}`)
  }

  // ---- F3: new file in a brand-new untracked dir gets indexed ----
  {
    const dir = makeRepo(); tmpDirs.push(dir)
    writeFileSync(path.join(dir, 'root.ts'), `export function Root() { return 1 }\n`)
    for (let i = 0; i < 10; i++) writeFileSync(path.join(dir, `pad${i}.ts`), `export const pad${i} = ${i}\n`)
    git(dir, 'add -A'); git(dir, 'commit -q -m init')
    await call('bridge_codegraph_index', { cwd: dir, force: true, wait: true })
    mkdirSync(path.join(dir, 'brandnew', 'deep'), { recursive: true })
    writeFileSync(path.join(dir, 'brandnew', 'deep', 'c.ts'), `export function DeepNewSymbol() { return 1 }\n`)
    const found = await call('bridge_codegraph_find_symbol', { cwd: dir, name: 'DeepNewSymbol' })
    const hit = (found.results ?? [])[0]
    rec('F3 file in brand-new untracked dir indexed on next query',
      !!hit && hit.file === path.join('brandnew', 'deep', 'c.ts'),
      `hit=${JSON.stringify(hit)}`)
  }

  // ---- F4: pre-P1B DB migration re-populates (does not leave empty graph) ----
  {
    const dir = makeRepo(); tmpDirs.push(dir)
    const srcRel = 'x.ts'
    const srcAbs = path.join(dir, srcRel)
    writeFileSync(srcAbs, `export function MigratedSymbol() { return 1 }\n`)
    git(dir, 'add -A'); git(dir, 'commit -q -m init')
    const st = statSync(srcAbs)

    // Locate the db path the engine will use: getCodegraphDir()/sha256(realpath(cwd)).db
    const realDir = execSync('pwd -P', { cwd: dir, encoding: 'utf8' }).trim()
    const cgDir = path.join(os.homedir(), '.jerico', 'codegraph')
    mkdirSync(cgDir, { recursive: true })
    const dbPath = path.join(cgDir, `${sha256(realDir)}.db`)
    rmSync(dbPath, { force: true })

    // Craft an OLD-schema DB: call_edge WITHOUT "ON DELETE SET NULL", a file row
    // whose hash/mtime/bytes MATCH the current file (so a non-force index would
    // skip it), and an EMPTY symbol table. Without F4 this stays empty forever.
    const old = new Database(dbPath)
    old.pragma('journal_mode = WAL')
    old.exec(`
      CREATE TABLE file (path TEXT PRIMARY KEY, lang TEXT NOT NULL, content_hash TEXT NOT NULL, mtime_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, parsed_at_ms INTEGER NOT NULL);
      CREATE TABLE symbol (id INTEGER PRIMARY KEY, file_path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, qualified_name TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, exported INTEGER NOT NULL DEFAULT 0, parent_id INTEGER);
      CREATE TABLE import (id INTEGER PRIMARY KEY, file_path TEXT NOT NULL, spec TEXT NOT NULL, imported_names TEXT NOT NULL);
      CREATE TABLE call_edge (id INTEGER PRIMARY KEY, caller_id INTEGER NOT NULL, callee_name TEXT NOT NULL, callee_resolved_id INTEGER, line INTEGER NOT NULL);
    `)
    const content = require('node:fs').readFileSync(srcAbs, 'utf-8')
    old.prepare('INSERT INTO file (path, lang, content_hash, mtime_ms, bytes, parsed_at_ms) VALUES (?,?,?,?,?,?)')
      .run(srcRel, 'typescript', sha256(content), st.mtimeMs, st.size, Date.now())
    old.close()

    // Open via engine (triggers initSchema migration) + non-force index.
    const idx = await call('bridge_codegraph_index', { cwd: dir, force: false, wait: true })
    const found = await call('bridge_codegraph_find_symbol', { cwd: dir, name: 'MigratedSymbol' })
    const hit = (found.results ?? [])[0]
    rec('F4 pre-P1B migration re-populates graph (not empty forever)',
      !!hit && hit.file === srcRel,
      `indexed_total=${idx.total} hit=${JSON.stringify(hit)}`)
    rmSync(dbPath, { force: true }); rmSync(dbPath + '-wal', { force: true }); rmSync(dbPath + '-shm', { force: true })
  }

  await client.close()
}

main()
  .catch((e) => { rec('smoke runner', false, String(e)) })
  .finally(async () => {
    try { if (server && !server.killed) server.kill('SIGKILL') } catch {}
    for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
    const failed = results.filter(r => !r.ok).length
    console.log(`\n=== P1BC FIX GATES: ${results.length - failed}/${results.length} PASS ===`)
    process.exit(failed ? 1 : 0)
  })
