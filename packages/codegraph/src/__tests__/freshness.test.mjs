// Real engine/SQLite/parser regression. Everything writable lives in mkdtemp.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cp from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(pkg, 'package.json'))
if (!process.env.CODEGRAPH_FRESHNESS_TEST_CHILD) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-freshness-'))
  try {
    fs.symlinkSync(path.join(pkg, 'node_modules'), path.join(scratch, 'node_modules'))
    fs.symlinkSync(path.join(pkg, 'dist/wasm'), path.join(scratch, 'wasm'))
    require('esbuild').buildSync({ entryPoints: [path.join(pkg, 'src/engine.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(scratch, 'engine.cjs') })
    const result = cp.spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      env: { ...process.env, HOME: scratch, CODEGRAPH_FRESHNESS_TEST_CHILD: scratch }, stdio: 'inherit', timeout: 60000,
    })
    process.exitCode = result.status ?? 1
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
} else {
  const scratch = process.env.CODEGRAPH_FRESHNESS_TEST_CHILD
  const { Engine } = require(path.join(scratch, 'engine.cjs'))
  const engine = new Engine()
  const dir = path.join(scratch, 'project')
  fs.mkdirSync(dir)
  cp.execFileSync('git', ['init', '-q', dir])
  fs.writeFileSync(path.join(dir, 'seed.ts'), 'export function seed() { return 1 }')
  const project = await engine.getProject(dir)
  project.index(true)
  if (process.argv.includes('--baseline')) {
    const bin = path.join(scratch, 'bin')
    fs.mkdirSync(bin)
    const git = cp.execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nsleep 0.2\nexec '${git}' "$@"\n`, { mode: 0o755 })
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    const started = performance.now()
    for (let i = 0; i < 8; i++) project.findSymbol('seed')
    console.log(JSON.stringify({ baselineMs: performance.now() - started, heartbeatTicks: ticks }))
    assert.equal(ticks, 0, 'old sync discovery blocks timer')
    let flight
    const prototype = () => flight ??= new Promise((resolve, reject) => {
      cp.execFile('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: dir }, (error, stdout) => error ? reject(error) : resolve(stdout))
    }).finally(() => { flight = undefined })
    const asyncStarted = performance.now()
    await Promise.all(Array.from({ length: 8 }, prototype))
    console.log(JSON.stringify({ prototypeMs: performance.now() - asyncStarted, heartbeatTicks: ticks }))
    assert(ticks > 5, 'async singleflight allows heartbeat while git waits')
    clearInterval(timer)
    for (const p of engine.projects.values()) p.close()
    process.exit(0)
  }
  assert.equal(typeof engine.withFreshSnapshot, 'function', 'async freshness boundary must exist')
  const query = name => engine.withFreshSnapshot(dir, p => p.findSymbol(name))
  fs.writeFileSync(path.join(dir, 'new.ts'), 'export function newborn() { return 2 }')
  assert.equal((await query('newborn')).results.length, 1, 'new file visible on next query')
  console.log('PASS new-file next-query freshness')
  fs.writeFileSync(path.join(dir, 'new.ts'), 'export function renamedSymbol() { return 333 }')
  assert.equal((await query('renamedSymbol')).results.length, 1)
  assert.equal((await query('newborn')).results.length, 0)
  fs.renameSync(path.join(dir, 'new.ts'), path.join(dir, 'renamed file.ts'))
  assert.equal((await query('renamedSymbol')).results[0].file, 'renamed file.ts')
  fs.unlinkSync(path.join(dir, 'renamed file.ts'))
  assert.equal((await query('renamedSymbol')).results.length, 0)
  console.log('PASS edit/rename/delete next-query freshness')
  fs.writeFileSync(path.join(dir, 'committed.ts'), 'export function committedAfterIndex() {}')
  cp.execFileSync('git', ['add', '.'], { cwd: dir })
  cp.execFileSync('git', ['-c', 'user.name=Freshness Test', '-c', 'user.email=freshness@example.invalid', 'commit', '-qm', 'fixture'], { cwd: dir })
  assert.equal((await query('committedAfterIndex')).results.length, 1, 'clean committed addition is discovered')
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.ts\n')
  fs.writeFileSync(path.join(dir, 'ignored.ts'), 'export function ignoredSymbol() {}')
  assert.equal((await query('ignoredSymbol')).results.length, 0)
  console.log('PASS committed addition and ignored source')
  const empty = path.join(scratch, 'empty')
  fs.mkdirSync(empty)
  const emptyProject = await engine.getProject(empty)
  emptyProject.index(true)
  fs.writeFileSync(path.join(empty, 'first.ts'), 'export function first() {}')
  assert.equal((await engine.withFreshSnapshot(empty, p => p.findSymbol('first'))).results.length, 1)
  console.log('PASS non-git asynchronous fallback and initially empty index')

  const detect = project.detectNewFilesAsync.bind(project)
  let discoveries = 0
  let entered
  let unblock
  project.detectNewFilesAsync = async tracked => {
    discoveries++
    entered?.()
    await new Promise(resolve => { unblock = resolve })
    return detect(tracked)
  }
  const arrived = new Promise(resolve => { entered = resolve })
  const pending = Array.from({ length: 8 }, () => query('seed'))
  await arrived
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert(ticks > 2, 'heartbeat progresses during discovery')
  clearInterval(timer)
  unblock()
  assert((await Promise.all(pending)).every(result => result.results.length === 1))
  assert.equal(discoveries, 1, 'overlapping queries share one discovery')
  project.detectNewFilesAsync = detect
  console.log('PASS concurrent coalescing and responsive timer')

  project.detectNewFilesAsync = async () => { throw new Error('injected discovery failure') }
  await assert.rejects(query('seed'), /injected discovery failure/)
  project.detectNewFilesAsync = detect
  assert.equal((await query('seed')).results.length, 1)
  await assert.rejects(engine.withFreshSnapshot(dir, () => { throw new Error('callback failure') }), /callback failure/)
  await assert.rejects(engine.withFreshSnapshot(dir, async () => 1), /must be synchronous/)
  assert.equal(project.freshCallbackDepth, 0)
  assert.equal(project.leases, 0)
  console.log('PASS failed refresh recovery and callback guard cleanup')

  for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(dir, `pool-${i}.ts`), `export function pool${i}() {}`)
  project.index(false)
  const originalStat = fs.stat
  let inFlight = 0
  let peakFlight = 0
  let scheduled = 0
  fs.stat = (filename, callback) => {
    const sequence = scheduled++
    peakFlight = Math.max(peakFlight, ++inFlight)
    setTimeout(() => {
      if (sequence === 0) {
        inFlight--
        callback(Object.assign(new Error('injected stat permission failure'), { code: 'EACCES' }))
      } else originalStat(filename, (error, stat) => { inFlight--; callback(error, stat) })
    }, sequence === 0 ? 0 : 15)
  }
  try {
    await assert.rejects(query('seed'), /injected stat permission failure/)
    assert.equal(inFlight, 0, 'failed sweep drains outstanding stat callbacks before rejection')
    assert.equal(peakFlight, 32, 'stat I/O is bounded at32')
    assert.equal(scheduled, 32, 'failed sweep does not schedule more files')
    assert.equal(project.leases, 0)
  } finally { fs.stat = originalStat }
  assert.equal((await query('seed')).results.length, 1)
  console.log('PASS bounded stat pool drains EACCES failure and recovers')

  // A local index changing while stat/Git awaits invalidates the collected diff.
  discoveries = 0
  project.detectNewFilesAsync = async tracked => {
    discoveries++
    if (discoveries === 1) project.index(false)
    return detect(tracked)
  }
  await query('seed')
  assert.equal(discoveries, 2)
  project.detectNewFilesAsync = detect
  console.log('PASS local mutation retries discovery')

  const Database = require('better-sqlite3')
  const external = new Database(project.db.name)
  discoveries = 0
  project.detectNewFilesAsync = async tracked => {
    discoveries++
    if (discoveries === 1) external.prepare('UPDATE file SET parsed_at_ms = parsed_at_ms + 1').run()
    return detect(tracked)
  }
  await query('seed')
  assert.equal(discoveries, 2)
  project.detectNewFilesAsync = detect
  console.log('PASS external SQLite commit retries discovery')

  fs.writeFileSync(path.join(dir, 'pending.ts'), 'export function afterBusy() {}')
  external.exec('BEGIN IMMEDIATE')
  const busyStarted = performance.now()
  const originalBusy = project.db.pragma('busy_timeout')
  ticks = 0
  const busyTimer = setInterval(() => ticks++, 5)
  await assert.rejects(query('afterBusy'), /retry the query/)
  clearInterval(busyTimer)
  assert(performance.now() - busyStarted < 1500, 'writer contention must not synchronously wait the default five seconds')
  assert(ticks > 0, 'heartbeat progresses during writer contention')
  assert.deepEqual(project.db.pragma('busy_timeout'), originalBusy)
  external.exec('ROLLBACK')
  external.close()
  assert.equal((await query('afterBusy')).results.length, 1)
  console.log('PASS writer-lock bounded async retry and recovery')

  engine.maxOpenDbs = 1
  const third = path.join(scratch, 'new-lru-project')
  fs.mkdirSync(third)
  project.detectNewFilesAsync = async tracked => {
    await engine.getProject(third)
    assert.equal(project.closed, false, 'LRU must not evict awaiting query')
    return detect(tracked)
  }
  assert.equal((await query('seed')).results.length, 1)
  project.detectNewFilesAsync = detect
  const closingEngine = new Engine()
  const closing = await closingEngine.getProject(dir)
  closing.detectNewFilesAsync = async () => { closing.close(); return [] }
  await assert.rejects(closingEngine.withFreshSnapshot(dir, p => p.findSymbol('seed')), /closed/)
  assert.equal(closing.leases, 0)
  console.log('PASS close during discovery rejects without applying')
  for (const p of engine.projects.values()) p.close()
  console.log('PASS busy project lease protects against LRU eviction')
}
