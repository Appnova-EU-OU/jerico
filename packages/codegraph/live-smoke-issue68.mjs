// Issue #68 Finding 1 — bridge_codegraph_find_symbol was WHERE name = ? (plain
// equality on the leaf symbol name), even though the tool is documented as
// "substring match": find_symbol("track") returned [] with track_click and
// track_event indexed. The correct fuzzy matcher already existed in
// structuralLookup's fallback, just never wired to this tool.
//
// Mirrors live-smoke-p2a.mjs's harness: spawn the real built dist/index.cjs
// as an HTTP MCP server, connect the real MCP SDK client, index a throwaway
// fixture project, call the real tool end to end.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'os'
import { fileURLToPath } from 'node:url'

const PORT = '3298'
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

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'codegraph-issue68-'))

function writeFixture(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'tracking.py'), [
    'def track_click(user_id):',
    '    return user_id',
    '',
    'def track_event(name):',
    '    return name',
    '',
    'def unrelated_thing():',
    '    return 1',
    '',
  ].join('\n'))
}

const client = new Client({ name: 'issue68-smoke', version: '0' }, { capabilities: {} })

try {
  const server = await startServer()
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)))

  const dir = path.join(ROOT, 'proj')
  writeFixture(dir)

  const idx = parse(await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: dir, force: true, wait: true } }))
  rec('index produced files', idx.total >= 1, `total=${idx.total}`)

  // The exact bug report: a substring/prefix query that matches NO symbol's
  // full leaf name exactly must still surface the real matches.
  const track = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: dir, name: 'track' } }))
  const trackNames = (track.results ?? []).map(r => r.qualifiedName)
  rec('substring query "track" finds track_click AND track_event',
    trackNames.some(n => n.includes('track_click')) && trackNames.some(n => n.includes('track_event')) && !trackNames.some(n => n.includes('unrelated_thing')),
    JSON.stringify(trackNames))

  // Case-insensitivity (SQLite LIKE default for ASCII).
  const trackUpper = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: dir, name: 'TRACK' } }))
  const trackUpperNames = (trackUpper.results ?? []).map(r => r.qualifiedName)
  rec('case-insensitive: "TRACK" matches the same symbols as "track"',
    trackUpperNames.some(n => n.includes('track_click')) && trackUpperNames.some(n => n.includes('track_event')),
    JSON.stringify(trackUpperNames))

  // Exact match still works and ranks first.
  const exact = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: dir, name: 'track_click' } }))
  const exactNames = (exact.results ?? []).map(r => r.qualifiedName)
  rec('exact query "track_click" still matches and ranks first',
    exactNames.length > 0 && exactNames[0].includes('track_click'),
    JSON.stringify(exactNames))

  // Response carries the new truncation metadata (additive fields).
  rec('response includes totalMatches/truncated metadata',
    typeof track.totalMatches === 'number' && typeof track.truncated === 'boolean',
    JSON.stringify({ totalMatches: track.totalMatches, truncated: track.truncated }))

  // A query matching nothing returns an empty result set, not an error.
  const none = parse(await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: dir, name: 'zzz_does_not_exist_zzz' } }))
  rec('non-matching query returns empty results, no error', Array.isArray(none.results) && none.results.length === 0, JSON.stringify(none.results))

  // Post-hoc review findings (4 independent reviewers, REPRODUCED): a negative
  // limit bypassed the 200-row cap (SQLite treats LIMIT<0 as unlimited), and an
  // empty/whitespace name matched every symbol via LIKE '%%'. Both rejected at
  // the MCP schema boundary now (z.number().int().min()/max(), z.string().min(1)).
  const negLimit = await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: dir, name: 'track', limit: -1 } })
  rec('negative limit is rejected at the schema boundary (cap cannot be bypassed)',
    negLimit.isError === true, JSON.stringify(negLimit.content?.[0]?.text ?? negLimit))

  const emptyName = await client.callTool({ name: 'bridge_codegraph_find_symbol', arguments: { cwd: dir, name: '' } })
  rec('empty name is rejected at the schema boundary (cannot match-all)',
    emptyName.isError === true, JSON.stringify(emptyName.content?.[0]?.text ?? emptyName))

  await client.close()
  server.kill()
} catch (e) {
  console.error('SMOKE ERROR:', e)
  rec('smoke completed without exception', false, String(e))
} finally {
  rmSync(ROOT, { recursive: true, force: true })
  const failed = results.filter(r => !r.ok).length
  console.log(`\n=== ISSUE #68 LIVE SMOKE: ${results.length - failed}/${results.length} PASS ===`)
  process.exit(failed ? 1 : 0)
}
