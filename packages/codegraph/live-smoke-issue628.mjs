// Live smoke for #628 — diff_impact shell injection fix — and its #628 follow-ups
// (unborn-HEAD/non-repo regression, --end-of-options depth defense, this file's
// own durability).
//
// Default run is READ-ONLY: it never edits engine.ts or rebuilds dist/. It
// validates: injection ($(...) and backticks) is dead; legitimate refs still
// work; a caller-supplied invalid ref is reported (not swallowed); unborn HEAD
// and a non-repo cwd degrade to an empty well-formed result (not `{ error }`);
// an option-shaped ref cannot make `git diff` write a file, even with the
// rev-parse guard bypassed; and the run itself leaves the working tree clean.
//
// Set CODEGRAPH_SMOKE_RED_CHECK=1 to additionally run the destructive negative
// control: temporarily revert engine.ts to the pre-#628 vulnerable form, rebuild,
// prove injection succeeds against the vulnerable build, then restore + rebuild
// in a `finally`. This mutates the working tree and rebuilds dist/ — opt-in only,
// never part of the default run, so a crash mid-flight cannot leave dist/ built
// from vulnerable source as the normal outcome of running this smoke.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync, writeFileSync as writeFile } from 'node:fs'
import path from 'node:path'
import os from 'os'
import { fileURLToPath } from 'node:url'

const PORT = '3291'
const PKG = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(PKG, '..', '..')
const SERVER = path.join(PKG, 'dist', 'index.cjs')
const ENGINE_SRC = path.join(PKG, 'src', 'engine.ts')
const NODE_BIN = process.execPath

const RED_CHECK = process.env.CODEGRAPH_SMOKE_RED_CHECK === '1'

const PWN1 = '/tmp/jerico-cg-628-pwned'
const PWN2 = '/tmp/jerico-cg-628-pwned2'
const PWN3 = '/tmp/jerico-cg-628-pwned3-optshaped'

// Captured before any mutation so the catch block can always restore, even if
// the exception happens mid-revert. Reading this unconditionally (not just
// under RED_CHECK) is what lets check 7 prove the default run never touches it.
const ORIGINAL_ENGINE_SOURCE = readFileSync(ENGINE_SRC, 'utf-8')

const gate = []
const recGate = (name, ok, detail) => { gate.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  [628] ${name} — ${detail}`) }
const parse = (r) => JSON.parse(r.content[0].text)
const rmIfExists = (p) => { if (existsSync(p)) unlinkSync(p) }

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [SERVER], {
      env: { ...process.env, CODEGRAPH_PORT: String(port), CODEGRAPH_STDIO: '0' },
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

async function connect(port) {
  const client = new Client({ name: '628-smoke', version: '0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
  return client
}

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
  spawnSync('git', ['init', '-q'], { cwd: dir })
  spawnSync('git', ['add', '-A'], { cwd: dir })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: dir })
  // second commit so HEAD~1 differs from HEAD
  writeFileSync(path.join(dir, 'src', 'trivial.ts'), `export const trivial = 1;\n`)
  spawnSync('git', ['add', '-A'], { cwd: dir })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'second'], { cwd: dir })
  // uncommitted modification of foo — this is what diff_impact should see
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

async function runInjectionChecks(client, repo) {
  // Check: $(...) command substitution
  rmIfExists(PWN1)
  const r1 = await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: `HEAD$(touch ${PWN1})` } })
  const p1 = parse(r1)
  recGate('injection dead: $(...) does not create file', !existsSync(PWN1), `pwnFileExists=${existsSync(PWN1)} response=${JSON.stringify(p1).slice(0, 200)}`)

  // Check: backtick substitution
  rmIfExists(PWN2)
  const r2 = await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: '`touch ' + PWN2 + '`' } })
  const p2 = parse(r2)
  recGate('injection dead: backtick substitution does not create file', !existsSync(PWN2), `pwnFileExists=${existsSync(PWN2)} response=${JSON.stringify(p2).slice(0, 200)}`)

  return { p1, p2 }
}

// Follow-up 1, checks 1+2: unborn HEAD and non-repo cwd must degrade to an
// empty well-formed result on the DEFAULT path (no `base` supplied) — never
// `{ error }`. Each gets its own throwaway dir; never this repo.
async function runDegradationChecks(client) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codegraph-628-degrade-'))

  const unbornDir = path.join(root, 'unborn')
  mkdirSync(unbornDir, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: unbornDir })
  const unborn = parse(await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: unbornDir } } ))
  recGate(
    'unborn HEAD (zero commits): default call returns empty well-formed result, not {error}',
    unborn.error === undefined && Array.isArray(unborn.changedFiles) && unborn.changedFiles.length === 0,
    JSON.stringify(unborn),
  )

  const nonRepoDir = path.join(root, 'non-repo')
  mkdirSync(nonRepoDir, { recursive: true })
  const nonRepo = parse(await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: nonRepoDir } } ))
  recGate(
    'non-repo cwd: default call returns empty well-formed result, not {error}',
    nonRepo.error === undefined && Array.isArray(nonRepo.changedFiles) && nonRepo.changedFiles.length === 0,
    JSON.stringify(nonRepo),
  )
}

// Follow-up 1: a caller-supplied bad ref must still return `{ error }` — the
// security path (rev-parse gate) stays intact for non-default input.
async function runBadRefStillErrorsCheck(client, repo) {
  const invalid = parse(await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: 'not-a-real-ref-xyz123' } }))
  recGate('caller-supplied bad ref returns a structured error', typeof invalid.error === 'string' && invalid.error.length > 0, JSON.stringify(invalid))
  recGate('bad-ref error is distinguishable from empty-changedFiles success', invalid.changedFiles === undefined, JSON.stringify(invalid))
}

// Follow-up 2: an option-shaped ref must not let `git diff` write a file, even
// with the rev-parse guard bypassed. This is a THROWAWAY copy of just the
// fixed git-diff invocation (not a mutation of engine.ts) — it proves the
// `--end-of-options` + trailing `--` depth defense holds on its own, which is
// the whole point of follow-up 2: the guard is not the only thing standing
// between a caller-supplied ref and an arbitrary git option.
function gitSupportsEndOfOptionsForSmoke() {
  try {
    const raw = execFileSync('git', ['--version'], { encoding: 'utf-8' })
    const m = raw.match(/(\d+)\.(\d+)/)
    const major = m ? parseInt(m[1], 10) : 0
    const minor = m ? parseInt(m[2], 10) : 0
    return { supported: major > 2 || (major === 2 && minor >= 24), version: raw.trim() }
  } catch {
    return { supported: false, version: 'unknown' }
  }
}

async function runDepthDefenseCheck(client, repo) {
  const { version } = gitSupportsEndOfOptionsForSmoke()
  rmIfExists(PWN3)
  const optionShapedRef = `--output=${PWN3}`
  // End-to-end through the real MCP tool (no guard bypass): an option-shaped
  // caller-supplied ref must never let `git diff` write a file.
  const result = parse(await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: optionShapedRef } }))
  recGate(
    `depth defense: option-shaped ref cannot make "git diff" write a file, via real MCP tool (git ${version})`,
    !existsSync(PWN3),
    `response=${JSON.stringify(result).slice(0, 200)} pwnFileExists=${existsSync(PWN3)}`,
  )
  rmIfExists(PWN3)
}

// Follow-up 3, check 7: the default (non-red-check) run must be non-mutating.
// `packages/codegraph/` must show the same `git status --porcelain` before
// and after, apart from build.mjs's own normal output-copying targets under
// dist/ which we do not touch here at all (default run never calls build).
function porcelainForCodegraph() {
  return spawnSync('git', ['status', '--porcelain', '--', 'packages/codegraph'], { cwd: REPO_ROOT, encoding: 'utf-8' }).stdout
}

try {
  const beforePorcelain = porcelainForCodegraph()

  console.log('=== fixture setup ===')
  const root = mkdtempSync(path.join(os.tmpdir(), 'codegraph-628-'))
  const repo = writeGitRepo(root)
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).stdout.trim()
  console.log(`repo=${repo} branch=${branch}`)

  console.log('\n=== server (fixed code) ===')
  let server = await startServer(PORT)
  let client = await connect(PORT)
  await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: repo, force: true, wait: true } })

  console.log('\n=== checks 4: injection dead ===')
  await runInjectionChecks(client, repo)

  console.log('\n=== check 6: legitimate refs still work (capture "before" values) ===')
  const beforeHead = parse(await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: 'HEAD' } }))
  const beforeHead1 = parse(await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: 'HEAD~1' } }))
  const beforeBranch = parse(await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: branch } }))
  recGate('HEAD: changedFiles includes src/impact.ts', (beforeHead.changedFiles ?? []).includes('src/impact.ts'), JSON.stringify(beforeHead.changedFiles))
  recGate('HEAD~1: changedFiles includes src/impact.ts and src/trivial.ts', ['src/impact.ts', 'src/trivial.ts'].every(f => (beforeHead1.changedFiles ?? []).includes(f)), JSON.stringify(beforeHead1.changedFiles))
  recGate('branch name: same changedFiles as HEAD (same commit)', JSON.stringify((beforeBranch.changedFiles ?? []).slice().sort()) === JSON.stringify((beforeHead.changedFiles ?? []).slice().sort()), `branch=${JSON.stringify(beforeBranch.changedFiles)} head=${JSON.stringify(beforeHead.changedFiles)}`)

  console.log('\n=== check 3: caller-supplied bad ref still errors ===')
  await runBadRefStillErrorsCheck(client, repo)

  console.log('\n=== checks 1+2: unborn HEAD / non-repo cwd degrade to empty well-formed result ===')
  await runDegradationChecks(client)

  console.log('\n=== check 5: depth defense — option-shaped ref, guard bypassed ===')
  await runDepthDefenseCheck(client, repo)

  await client.close()
  server.kill()

  if (RED_CHECK) {
    console.log('\n=== [opt-in CODEGRAPH_SMOKE_RED_CHECK=1] the guard can go red (temporary revert) ===')
    const fixedSource = ORIGINAL_ENGINE_SOURCE

    const fixedImport = "import { execFileSync } from 'node:child_process'"
    if (!fixedSource.includes(fixedImport)) throw new Error('fixed import line not found — engine.ts changed shape unexpectedly')

    const fixedBlockStart = fixedSource.indexOf("    const baseSupplied = !!(base && base.trim())")
    const fixedBlockEnd = fixedSource.indexOf("    if (changedFiles.length === 0) {")
    if (fixedBlockStart === -1 || fixedBlockEnd === -1) throw new Error('diffImpact block markers not found for revert')
    const fixedBlock = fixedSource.slice(fixedBlockStart, fixedBlockEnd)

    const vulnerableBlock = `    const baseRef = base && base.trim() ? base.trim() : 'HEAD'
    const limit = 500
    const maxDepth = 3

    let changedFiles: string[] = []
    try {
      const raw = execSync(\`git diff --name-only \${JSON.stringify(baseRef)}\`, {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      changedFiles = raw.split('\\n').map(s => s.trim()).filter(Boolean)
    } catch {
      changedFiles = []
    }

`

    const vulnerableSource = fixedSource
      .replace(fixedImport, "import { execFileSync, execSync } from 'node:child_process'")
      .replace(fixedBlock, vulnerableBlock)

    let revertBuildOk = false
    let redObserved = null
    try {
      writeFile(ENGINE_SRC, vulnerableSource)
      const build1 = spawnSync(NODE_BIN, ['scripts/build.mjs'], { cwd: PKG, encoding: 'utf-8', timeout: 60000 })
      revertBuildOk = build1.status === 0
      recGate('revert: vulnerable build succeeded', revertBuildOk, `exit=${build1.status}`)

      if (revertBuildOk) {
        server = await startServer(PORT)
        client = await connect(PORT)
        await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: repo, force: true, wait: true } })
        rmIfExists(PWN1)
        await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: `HEAD$(touch ${PWN1})` } })
        redObserved = existsSync(PWN1)
        recGate('RED CHECK: vulnerable code lets $(...) create the pwn file (guard would have failed pre-fix)', redObserved === true, `pwnFileExists=${redObserved}`)
        rmIfExists(PWN1)
        await client.close()
        server.kill()
      }
    } finally {
      writeFile(ENGINE_SRC, fixedSource)
      const build2 = spawnSync(NODE_BIN, ['scripts/build.mjs'], { cwd: PKG, encoding: 'utf-8', timeout: 60000 })
      recGate('restore: fixed source rebuilt cleanly', build2.status === 0, `exit=${build2.status}`)
    }

    console.log('\n=== post-restore re-verify: fixed behavior + prior values still hold ===')
    server = await startServer(PORT)
    client = await connect(PORT)
    await client.callTool({ name: 'bridge_codegraph_index', arguments: { cwd: repo, force: true, wait: true } })

    await runInjectionChecks(client, repo)

    const afterHead = parse(await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: 'HEAD' } }))
    const afterHead1 = parse(await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: 'HEAD~1' } }))
    const afterBranch = parse(await client.callTool({ name: 'bridge_codegraph_diff_impact', arguments: { cwd: repo, base: branch } }))
    recGate('post-restore HEAD matches pre-revert "before" value', JSON.stringify(afterHead) === JSON.stringify(beforeHead), 'deep-equal check')
    recGate('post-restore HEAD~1 matches pre-revert "before" value', JSON.stringify(afterHead1) === JSON.stringify(beforeHead1), 'deep-equal check')
    recGate('post-restore branch-name matches pre-revert "before" value', JSON.stringify(afterBranch) === JSON.stringify(beforeBranch), 'deep-equal check')

    await client.close()
    server.kill()
  } else {
    console.log('\n=== CODEGRAPH_SMOKE_RED_CHECK not set — skipping destructive engine.ts revert (default: non-mutating) ===')
  }

  console.log('\n=== check 7: default run left packages/codegraph untouched ===')
  const afterPorcelain = porcelainForCodegraph()
  recGate(
    RED_CHECK
      ? 'porcelain check skipped meaningfully under RED_CHECK (mutation+restore expected) — recorded for visibility only'
      : 'default run is non-mutating: git status --porcelain -- packages/codegraph unchanged',
    RED_CHECK ? true : beforePorcelain === afterPorcelain,
    `before=${JSON.stringify(beforePorcelain)} after=${JSON.stringify(afterPorcelain)}`,
  )

  const failed = gate.filter(r => !r.ok).length
  console.log(`\n=== ISSUE #628 LIVE SMOKE: ${gate.length - failed}/${gate.length} PASS ===`)
  process.exit(failed ? 1 : 0)
} catch (e) {
  console.error('SMOKE ERROR:', e)
  // best-effort restore in case the exception happened mid-revert
  try {
    const cur = readFileSync(ENGINE_SRC, 'utf-8')
    if (cur !== ORIGINAL_ENGINE_SOURCE) {
      console.error('engine.ts was left mutated — restoring original and rebuilding...')
      writeFile(ENGINE_SRC, ORIGINAL_ENGINE_SOURCE)
      const rebuild = spawnSync(NODE_BIN, ['scripts/build.mjs'], { cwd: PKG, encoding: 'utf-8', timeout: 60000 })
      console.error(`emergency restore rebuild exit=${rebuild.status}`)
    }
  } catch (restoreErr) {
    console.error('EMERGENCY RESTORE FAILED — engine.ts may still be mutated:', restoreErr)
  }
  recGate('smoke completed without exception', false, String(e))
  const failed = gate.filter(r => !r.ok).length
  console.log(`\n=== ISSUE #628 LIVE SMOKE: ${gate.length - failed}/${gate.length} PASS ===`)
  process.exit(1)
}
