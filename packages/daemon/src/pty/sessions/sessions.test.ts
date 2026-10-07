import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { listClaudeSessions, claudeSessionFile, boundedClaudeStats } from './claude.js'
import { listCodexSessions, snapshotCodexRollouts, captureCodexSessionId, captureCodexThreadId, findCodexOrchestratorThread, readCodexThreadNames, tryAcquireCodexCapture, reserveCodexCaptureForSpawn, runCodexRenameReadySequence, codexThreadExists, queryCodexState } from './codex.js'
import { appendSessionRole, readSessionRoles } from './role-index.js'
import { nameClaudeSession, orchestratorSessionName, createCodexRenameOnReady, CODEX_RENAME_SUBMIT_DELAY_MS } from './naming.js'
import { renameNativeSession } from './index.js'
import { checkNativeSessionResumeAtCwd, listSessionsForCwd, nativeSessionExists } from './index.js'
import { isCanonicalSessionId, sameSessionCwd } from './session-utils.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const runNode = (script: string, ...args: string[]) => execFileSync('node', ['-e', script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const sqliteFixture = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, name TEXT, title TEXT, first_user_message TEXT, preview TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, archived INTEGER, history_mode TEXT)'); const rows = JSON.parse(process.argv[2]); const insert = db.prepare('INSERT INTO threads (id,rollout_path,cwd,name,title,first_user_message,preview,created_at_ms,updated_at_ms,archived,history_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?)'); rows.forEach((row,index)=>insert.run(row[0],row[4]??null,row[3]??'/privacy',row[1],row[2],'SECRET FIRST MESSAGE','SECRET PREVIEW',row[5]??(Date.now()-index),row[6]??(Date.now()-index),row[7]??0,row[8]??'paginated')); db.close()`
const sqliteLoader = async () => ({ DatabaseSync: class {
  readonly filename: string
  constructor(filename: string, options: { readOnly: true }) { this.filename = filename; if (options.readOnly !== true) throw new Error('not_read_only') }
  exec(_sql: string): void {}
  prepare(sql: string) {
    return { all: (...params: Array<string | number>) => {
      expect(sql.toLowerCase()).not.toMatch(/\b(title|first_user_message|preview)\b/)
      return JSON.parse(runNode(`const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true, timeout: 150 }); db.exec('PRAGMA busy_timeout=150'); const rows = db.prepare(process.argv[2]).all(...JSON.parse(process.argv[3])); console.log(JSON.stringify(rows)); db.close()`, this.filename, sql, JSON.stringify(params))) as unknown
    } }
  }
  close(): void {}
} })
let tempHome: string
let originalHome: string | undefined
let originalCodexHome: string | undefined
let originalProfile: string | undefined

beforeEach(async () => {
  tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jerico-sessions-'))
  originalHome = process.env.HOME; originalCodexHome = process.env.CODEX_HOME; originalProfile = process.env.BRIDGE_PROFILE
  process.env.HOME = tempHome; process.env.CODEX_HOME = path.join(tempHome, '.codex'); process.env.BRIDGE_PROFILE = 'test'
})
afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome
  if (originalProfile === undefined) delete process.env.BRIDGE_PROFILE; else process.env.BRIDGE_PROFILE = originalProfile
  await fs.promises.rm(tempHome, { recursive: true, force: true })
})

describe('Claude and Codex native session providers', () => {
  test('Claude skips corrupt and incomplete JSONL lines while preserving Unicode and reports cap', async () => {
    const cwd = '/work/ü-project', dir = path.dirname(claudeSessionFile(cwd, id(1)))
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(claudeSessionFile(cwd, id(1)), `broken\n{"cwd":"${cwd}","timestamp":"2026-05-01T12:00:00.000Z"}\n{"customTitle":"Süper ü"}\n{"customTitle":"truncated`, 'utf8')
    for (let i = 2; i <= 31; i++) await fs.promises.writeFile(claudeSessionFile(cwd, id(i)), `{"cwd":"${cwd}","timestamp":"2026-05-02T12:00:00.000Z"}\n`)
    await fs.promises.utimes(claudeSessionFile(cwd, id(1)), new Date(), new Date(Date.now() + 10_000))
    const result = await listClaudeSessions(cwd)
    expect(result.entries).toHaveLength(30)
    expect(result.truncated).toBe(true)
    expect(result.truncatedReason).toBe('cap')
    expect(result.entries.some(row => row.title === 'Süper ü')).toBe(true)
    expect(result.entries.find(row => row.sessionId === id(1))?.startedAt).toBe('2026-05-01T12:00:00.000Z')
  })

  test('Claude empty project directory returns an empty, non-truncated list', async () => {
    expect(await listClaudeSessions('/empty-project')).toEqual({ entries: [], truncated: false })
  })

  test('Claude encoded cwd collisions are rejected by recorded cwd', async () => {
    const wanted = '/a.b', collision = '/a/b'
    expect(claudeSessionFile(wanted, id(77))).toBe(claudeSessionFile(collision, id(77)))
    const file = claudeSessionFile(wanted, id(77))
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, `${JSON.stringify({ cwd: collision, timestamp: new Date().toISOString() })}\n`)
    expect((await listClaudeSessions(wanted)).entries).toHaveLength(0)
    expect((await listClaudeSessions(collision)).entries).toHaveLength(1)
    expect(await nativeSessionExists('claude', collision, id(77))).toBe(true)
    expect(await nativeSessionExists('claude', wanted, id(77))).toBe(false)
  })

  test('Claude stat deadline returns truncated partial results without claiming completeness', async () => {
    const start = Date.now()
    const result = await boundedClaudeStats(['a', 'b'], '/tmp', start + 15, async file => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return fs.promises.stat(file)
    })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - start).toBeLessThan(80)
    const alreadyExpired = await boundedClaudeStats(['a'], '/tmp', Date.now() - 1)
    expect(alreadyExpired.timedOut).toBe(true)
    const cwd = '/deadline-scan', file = claudeSessionFile(cwd, id(78))
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, `${JSON.stringify({ cwd, timestamp: new Date().toISOString() })}\n`)
    const partial = await listClaudeSessions(cwd, 0)
    expect(partial.truncated).toBe(true)
    expect(partial.truncatedReason).toBe('deadline')
  })

  test('Codex scans newest date directory first, filters exact cwd and tolerates missing database', async () => {
    const date = new Date(), day = String(date.getDate()).padStart(2, '0'), month = String(date.getMonth() + 1).padStart(2, '0'), year = String(date.getFullYear())
    const root = path.join(process.env.CODEX_HOME!, 'sessions', year, month, day)
    await fs.promises.mkdir(root, { recursive: true })
    await fs.promises.writeFile(path.join(root, 'rollout-z-newest.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: id(5), cwd: '/wanted', timestamp: date.toISOString() } })}\nrest\n`)
    await fs.promises.writeFile(path.join(root, 'rollout-b.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: id(6), cwd: '/other', timestamp: date.toISOString() } })}\n`)
    const result = await listCodexSessions('/wanted')
    expect(result.entries.map(row => row.sessionId)).toEqual([id(5)])
    expect(result.entries[0]?.title).toBeNull()
    expect(result.entries[0]?.renamable).toBe(false)
    expect(result.entries[0]?.sizeBytes).toBe((await fs.promises.stat(path.join(root, 'rollout-z-newest.jsonl'))).size)
    expect(result.entries[0]?.lastActivity).toBe((await fs.promises.stat(path.join(root, 'rollout-z-newest.jsonl'))).mtime.toISOString())
    expect(result.entries[0]?.startedAt).toBe(date.toISOString())
    for (let i = 0; i < 30; i++) await fs.promises.writeFile(path.join(root, `rollout-${String(i).padStart(2, '0')}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: id(100 + i), cwd: '/wanted', timestamp: date.toISOString() } })}\n`)
    const capped = await listCodexSessions('/wanted')
    expect(capped.entries).toHaveLength(30)
    expect(capped.truncated).toBe(true)
    for (let i = 0; i < 30; i++) await fs.promises.writeFile(path.join(root, `rollout-exact-${String(i).padStart(2, '0')}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: id(300 + i), cwd: '/exactly-thirty', timestamp: date.toISOString() } })}\n`)
    expect((await listCodexSessions('/exactly-thirty')).entries).toHaveLength(30)
    expect((await listCodexSessions('/exactly-thirty')).truncated).toBe(false)
  })

  test('legacy list requests remain Claude-only unless Codex is explicitly requested', async () => {
    const date = new Date(), year = String(date.getFullYear()), month = String(date.getMonth() + 1).padStart(2, '0'), day = String(date.getDate()).padStart(2, '0')
    const dir = path.join(process.env.CODEX_HOME!, 'sessions', year, month, day)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(path.join(dir, 'rollout-compat.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: id(8), cwd: '/compat', timestamp: date.toISOString() } })}\n`)
    const oldWeb = await listSessionsForCwd('/compat')
    expect(oldWeb.entries.every(entry => entry.agentKey !== 'codex')).toBe(true)
    const newWeb = await listSessionsForCwd('/compat', ['claude', 'codex'])
    expect(newWeb.entries.map(entry => entry.agentKey)).toContain('codex')
  })

  test('role index is idempotent, role updates win, corrupt rows skip, and compacts past 5000 lines', async () => {
    await appendSessionRole({ agentKey: 'claude', sessionId: id(7), role: 'developer', cwd: '/p' })
    await appendSessionRole({ agentKey: 'claude', sessionId: id(7), role: 'developer', cwd: '/p' })
    await appendSessionRole({ agentKey: 'claude', sessionId: id(7), role: 'orchestrator', cwd: '/p' })
    const file = path.join(tempHome, '.jerico', 'profiles', 'test', 'session-roles.jsonl')
    expect((await fs.promises.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2)
    const records = Array.from({ length: 5001 }, (_, i) => JSON.stringify({ agentKey: 'claude', sessionId: id(i + 100), role: 'worker', cwd: '/p', createdAt: new Date().toISOString() }))
    await fs.promises.writeFile(file, `corrupt\n${records.join('\n')}\n`)
    await appendSessionRole({ agentKey: 'claude', sessionId: id(99), role: 'orchestrator', cwd: '/p' })
    const lines = (await fs.promises.readFile(file, 'utf8')).trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(2001)
    expect((await readSessionRoles()).get(`claude|${id(99)}|/p`)).toBe('orchestrator')
  })

  test('Codex capture returns one candidate, refuses ambiguous candidates and times out empty', async () => {
    const day = new Date(), root = path.join(process.env.CODEX_HOME!, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    await fs.promises.mkdir(root, { recursive: true })
    const before = await snapshotCodexRollouts()
    const rollout = (n: number) => path.join(root, `rollout-${n}.jsonl`)
    const meta = (n: number) => JSON.stringify({ type: 'session_meta', payload: { id: id(n), cwd: '/p', timestamp: new Date().toISOString() } }) + '\n'
    await fs.promises.writeFile(rollout(10), meta(10))
    expect(await captureCodexSessionId('/p', Date.now() - 1000, before, new AbortController().signal, 3000)).toBe(id(10))
    const snapshot = await snapshotCodexRollouts()
    await fs.promises.writeFile(rollout(11), meta(11)); await fs.promises.writeFile(rollout(12), meta(12))
    expect(await captureCodexSessionId('/p', Date.now() - 1000, snapshot, new AbortController().signal, 3000)).toBeNull()
    expect(await captureCodexSessionId('/missing', Date.now(), await snapshotCodexRollouts(), new AbortController().signal, 20)).toBeNull()
    const cancelled = new AbortController(), started = Date.now()
    const pending = captureCodexSessionId('/not-created', Date.now(), await snapshotCodexRollouts(), cancelled.signal, 5000)
    setTimeout(() => cancelled.abort(), 10)
    expect(await pending).toBeNull()
    expect(Date.now() - started).toBeLessThan(400)
  })

  test('Codex capture overlap skips only capture and allows a second same-cwd spawn', async () => {
    const releaseFirst = tryAcquireCodexCapture('/same-cwd')!
    const second = reserveCodexCaptureForSpawn('/same-cwd')
    expect(second.shouldSpawn).toBe(true)
    expect(second.shouldCapture).toBe(false)
    expect(second.release).toBeNull()
    tryAcquireCodexCapture('/other-cwd')?.()
    releaseFirst()
    const nextCapture = reserveCodexCaptureForSpawn('/same-cwd')
    expect(nextCapture.shouldSpawn).toBe(true)
    expect(nextCapture.shouldCapture).toBe(true)
    nextCapture.release?.()
  })

  test('Codex rollout created after polling starts cannot be attributed to a concurrent same-cwd spawn', async () => {
    const now = new Date(), year = String(now.getFullYear()), month = String(now.getMonth() + 1).padStart(2, '0'), day = String(now.getDate()).padStart(2, '0')
    const dir = path.join(process.env.CODEX_HOME!, 'sessions', year, month, day)
    await fs.promises.mkdir(dir, { recursive: true })
    const before = await snapshotCodexRollouts(), release = tryAcquireCodexCapture('/same')!
    const pending = captureCodexSessionId('/same', Date.now() - 1000, before, new AbortController().signal, 2500)
    await new Promise(resolve => setTimeout(resolve, 600))
    const overlappingPanel = reserveCodexCaptureForSpawn('/same')
    expect(overlappingPanel.shouldSpawn).toBe(true)
    expect(overlappingPanel.shouldCapture).toBe(false)
    const meta = (n: number) => `${JSON.stringify({ type: 'session_meta', payload: { id: id(n), cwd: '/same', timestamp: new Date().toISOString() } })}\n`
    await fs.promises.writeFile(path.join(dir, 'rollout-late-a.jsonl'), meta(201))
    await fs.promises.writeFile(path.join(dir, 'rollout-late-b.jsonl'), meta(202))
    expect(await pending).toBeNull()
    release()
  })

  test('Codex capture invalidates lease holder when an overlapping spawn row appears first', async () => {
    await fs.promises.mkdir(process.env.CODEX_HOME!, { recursive: true })
    await fs.promises.writeFile(path.join(process.env.CODEX_HOME!, 'state_1.sqlite'), '')
    let rows: Array<{ id: string; cwd: string }> = []
    let queryStarted!: () => void
    const started = new Promise<void>(resolve => { queryStarted = resolve })
    const loader = async () => ({ DatabaseSync: class {
      constructor(_file: string, _options: { readOnly: true }) {}
      exec(_sql: string) {}
      prepare(_sql: string) { return { all: (..._params: Array<string | number>) => { queryStarted(); return rows } } }
      close() {}
    } })
    const first = reserveCodexCaptureForSpawn('/same-cwd')
    const pending = captureCodexThreadId('/same-cwd', Date.now(), new AbortController().signal, new Set(), 3000, loader, first.isAmbiguous)
    await started
    const second = reserveCodexCaptureForSpawn('/same-cwd')
    expect(second.shouldSpawn).toBe(true)
    expect(second.shouldCapture).toBe(false)
    rows = [{ id: id(203), cwd: '/same-cwd' }]
    expect(await pending).toEqual({ available: true, sessionId: null })
    first.release?.()
  })

  test('Codex rollout fallback invalidates the lease holder when overlap occurs after SQLite fails', async () => {
    const now = new Date(), year = String(now.getFullYear()), month = String(now.getMonth() + 1).padStart(2, '0'), day = String(now.getDate()).padStart(2, '0')
    const dir = path.join(process.env.CODEX_HOME!, 'sessions', year, month, day)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(path.join(process.env.CODEX_HOME!, 'state_1.sqlite'), '')
    const before = await snapshotCodexRollouts()
    const first = reserveCodexCaptureForSpawn('/same-cwd')
    let fallbackEntered!: () => void
    const entered = new Promise<void>(resolve => { fallbackEntered = resolve })
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      const unavailableSQLite = async () => { throw new Error('node:sqlite unavailable') }
      const pending = captureCodexThreadId('/same-cwd', Date.now() - 1000, new AbortController().signal, new Set(), 2500, unavailableSQLite)
        .then(result => result.available ? result.sessionId : (() => {
          fallbackEntered()
          return captureCodexSessionId('/same-cwd', Date.now() - 1000, before, new AbortController().signal, 2500, first.isAmbiguous)
        })())
      await entered
      await new Promise(resolve => setTimeout(resolve, 600))
      const second = reserveCodexCaptureForSpawn('/same-cwd')
      expect(second.shouldSpawn).toBe(true)
      expect(second.shouldCapture).toBe(false)
      await fs.promises.writeFile(path.join(dir, 'rollout-overlap-fallback.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: id(221), cwd: '/same-cwd', timestamp: new Date().toISOString() } })}\n`)

      expect(await pending).toBeNull()
      expect(warnings).toContainEqual(['[daemon] codex.capture.ambiguous', { reason: 'overlap' }])
      first.release?.()
    } finally {
      first.release?.()
      console.warn = originalWarn
    }
  })

  test('Codex resume refuses a state row whose contained native rollout file is missing', async () => {
    const root = process.env.CODEX_HOME!, state = path.join(root, 'state_12.sqlite')
    await fs.promises.mkdir(root, { recursive: true })
    runNode(sqliteFixture, state, JSON.stringify([[id(214), 'Deleted rollout', null, '/resume', 'sessions/missing.jsonl', Date.now(), Date.now()]]))
    expect(await nativeSessionExists('codex', '/resume', id(214), sqliteLoader)).toBe(false)
    const now = new Date(), day = path.join(root, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    await fs.promises.mkdir(day, { recursive: true })
    await fs.promises.writeFile(path.join(day, 'rollout-rowless.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: id(218), cwd: '/resume', timestamp: now.toISOString() } })}\n`)
    expect(await nativeSessionExists('codex', '/resume', id(218), sqliteLoader)).toBe(false)
  })

  test('resume cwd helper passes the effective daemon cwd to native session validation', async () => {
    const checked: string[] = []
    const effectiveCwd = path.join(tempHome, 'resolved-project')
    expect(await checkNativeSessionResumeAtCwd('codex', effectiveCwd, id(215), async (_agentKey, cwd) => { checked.push(cwd); return true })).toBe(true)
    expect(checked).toEqual([effectiveCwd])
  })

  test('Codex rename sequence does not write submit, clear, or queued input to a respawned instance', async () => {
    let currentInstanceId = 31
    let resumeDelay!: () => void
    const delay = new Promise<void>(resolve => { resumeDelay = resolve })
    const controller = new AbortController()
    const writes: Array<{ instanceId: number; text: string }> = []
    const owners = new Map([['panel', { panelInstanceId: 31, controller }]])
    const fakeManager = {
      write: (agentId: string, data: Buffer) => { writes.push({ instanceId: currentInstanceId, text: `${agentId}:${data.toString('utf8')}` }); return true },
      exit: (agentId: string, exitedInstanceId: number) => {
        currentInstanceId = 0
        const owner = owners.get(agentId)
        if (owner?.panelInstanceId === exitedInstanceId) { owner.controller.abort(); owners.delete(agentId) }
      },
      respawn: (agentId: string, panelInstanceId: number) => {
        currentInstanceId = panelInstanceId
        owners.set(agentId, { panelInstanceId, controller: new AbortController() })
      },
    }
    const isCurrent = () => currentInstanceId === 31 && !controller.signal.aborted
    const action = createCodexRenameOnReady(true, data => isCurrent() && fakeManager.write('panel', data), () => 'Orchestrator · test', async () => delay)!
    const sequence = runCodexRenameReadySequence({
      writeRename: action,
      confirm: async () => ({ available: true, confirmed: false }),
      clearComposer: () => { if (isCurrent()) fakeManager.write('panel', Buffer.from('\x15')) },
      onUnconfirmed: () => {},
      flushFirstInput: () => { if (isCurrent()) fakeManager.write('panel', Buffer.from('queued input')) },
      signal: controller.signal,
      isCurrent,
    })
    expect(writes).toEqual([{ instanceId: 31, text: 'panel:/rename Orchestrator · test' }])
    fakeManager.exit('panel', 31)
    fakeManager.respawn('panel', 32)
    resumeDelay()
    expect((await sequence).reason).toBe('panel_exited')
    expect(writes).toEqual([{ instanceId: 31, text: 'panel:/rename Orchestrator · test' }])
  })

  test('Claude cwd aliases compare by real path for list and resume', async () => {
    const actual = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jerico-cwd-real-'))
    const alias = path.join(tempHome, 'cwd-alias')
    await fs.promises.symlink(actual, alias)
    const idValue = id(216), file = claudeSessionFile(alias, idValue)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, `${JSON.stringify({ cwd: actual, timestamp: new Date().toISOString() })}\n`)
    expect(alias).not.toBe(await fs.promises.realpath(actual))
    expect(sameSessionCwd(alias, actual)).toBe(true)
    expect((await listClaudeSessions(alias)).entries.map(entry => entry.sessionId)).toContain(idValue)
    expect(await nativeSessionExists('claude', alias, idValue)).toBe(true)
  })

  test('Codex state cwd aliases match in list, thread existence, and resume validation', async () => {
    const actual = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jerico-codex-cwd-real-'))
    const alias = path.join(tempHome, 'codex-cwd-alias')
    await fs.promises.symlink(actual, alias)
    const root = path.join(process.env.CODEX_HOME!, 'sessions'), now = new Date()
    const day = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    await fs.promises.mkdir(day, { recursive: true })
    const rollout = path.join(day, `rollout-${id(217)}.jsonl`)
    await fs.promises.writeFile(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: id(217), cwd: actual, timestamp: now.toISOString() } })}\n`)
    const state = path.join(process.env.CODEX_HOME!, 'state_99.sqlite')
    const canonical = await fs.promises.realpath(actual)
    runNode(sqliteFixture, state, JSON.stringify([[id(217), 'Alias session', null, canonical, rollout, now.getTime(), now.getTime()]]))
    expect(sameSessionCwd(alias, actual)).toBe(true)
    expect((await queryCodexState('SELECT id, cwd FROM threads WHERE cwd IN (?, ?)', [alias, await fs.promises.realpath(alias)], sqliteLoader)).rows).toHaveLength(1)
    expect((await listCodexSessions(alias, 3000, sqliteLoader)).entries.map(entry => entry.sessionId)).toContain(id(217))
    expect(await codexThreadExists(alias, id(217), sqliteLoader)).toBe(true)
    expect(await nativeSessionExists('codex', alias, id(217), sqliteLoader)).toBe(true)
  })

  test('Codex orchestrator input waits for rename confirmation and settle before submitted PTY input', async () => {
    const order: string[] = []
    let confirmationCount = 0
    let virtualNow = 0
    const rename = createCodexRenameOnReady(true, data => {
      order.push(`pty:rename:${data.toString('utf8')}`)
      return true
    }, () => 'Orchestrator · 04.10.2026 10:52', async ms => { order.push(`wait:${ms}`); virtualNow += ms })!
    const fakePty = {
      submit: () => { order.push('pty:first-input'); order.push('pty:submit-cr') },
      clear: () => { order.push('pty:clear-ctrl-u') },
    }
    const fakeDb = { confirm: async () => {
      order.push('db:confirm')
      confirmationCount++
      return { available: true, confirmed: confirmationCount === 2, sessionId: confirmationCount === 2 ? id(205) : undefined }
    } }
    await runCodexRenameReadySequence({
      writeRename: rename,
      confirm: fakeDb.confirm,
      delay: async ms => { order.push(`wait:${ms}`); virtualNow += ms },
      onConfirmed: () => { order.push('session:captured') },
      clearComposer: fakePty.clear,
      onUnconfirmed: reason => { order.push(`unconfirmed:${reason}`) },
      flushFirstInput: fakePty.submit,
    })
    expect(order).toEqual([`pty:rename:/rename Orchestrator · 04.10.2026 10:52`, `wait:${CODEX_RENAME_SUBMIT_DELAY_MS}`, 'pty:rename:\r', 'db:confirm', 'wait:250', 'db:confirm', 'session:captured', 'wait:500', 'pty:first-input', 'pty:submit-cr'])
    expect(virtualNow).toBeGreaterThanOrEqual(750)
  })

  test('Codex rename failure clears the composer before flushing queued input', async () => {
    const order: string[] = []
    const rename = createCodexRenameOnReady(true, data => { order.push(`pty:rename:${data.toString('utf8')}`); return true }, () => 'Orchestrator · 04.10.2026 10:52', async ms => { order.push(`wait:${ms}`) })!
    const result = await runCodexRenameReadySequence({
      writeRename: rename,
      confirm: async () => { order.push('db:unavailable'); return { available: false, confirmed: false, reason: 'database_unavailable' } },
      clearComposer: () => { order.push('pty:clear-ctrl-u') },
      onUnconfirmed: reason => { order.push(`unconfirmed:${reason}`) },
      delay: async ms => { order.push(`settle:${ms}`) },
      flushFirstInput: () => { order.push('pty:first-input') },
    })
    expect(result.reason).toBe('database_unavailable')
    expect(order).toEqual([`pty:rename:/rename Orchestrator · 04.10.2026 10:52`, `wait:${CODEX_RENAME_SUBMIT_DELAY_MS}`, 'pty:rename:\r', 'db:unavailable', 'pty:clear-ctrl-u', 'unconfirmed:database_unavailable', 'settle:500', 'pty:first-input'])
  })

  test('Codex oversized metadata is skipped with one warning per list request', async () => {
    const now = new Date(), year = String(now.getFullYear()), month = String(now.getMonth() + 1).padStart(2, '0'), day = String(now.getDate()).padStart(2, '0')
    const dir = path.join(process.env.CODEX_HOME!, 'sessions', year, month, day)
    await fs.promises.mkdir(dir, { recursive: true })
    const oversized = `${JSON.stringify({ type: 'session_meta', payload: { id: id(211), cwd: '/large', timestamp: now.toISOString(), data: 'x'.repeat(1024 * 1024 + 10) } })}\n`
    await fs.promises.writeFile(path.join(dir, 'rollout-large-a.jsonl'), oversized)
    await fs.promises.writeFile(path.join(dir, 'rollout-large-b.jsonl'), oversized)
    const warnings: unknown[][] = [], originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      expect((await listCodexSessions('/large')).entries).toHaveLength(0)
      expect(warnings.filter(args => args[0] === '[daemon] sessions.codex.first_line_oversize')).toHaveLength(1)
    } finally { console.warn = originalWarn }
  })

  test('Codex gets only threads.name from the newest read-only state database', async () => {
    const root = process.env.CODEX_HOME!, older = path.join(root, 'state_2.sqlite'), latest = path.join(root, 'state_9.sqlite')
    await fs.promises.mkdir(root, { recursive: true })
    const date = new Date(), year = String(date.getFullYear()), month = String(date.getMonth() + 1).padStart(2, '0'), day = String(date.getDate()).padStart(2, '0')
    const sessionsDir = path.join(root, 'sessions', year, month, day), rollout = path.join(sessionsDir, 'rollout-private.jsonl')
    await fs.promises.mkdir(sessionsDir, { recursive: true })
    await fs.promises.writeFile(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: id(30), cwd: '/privacy', timestamp: date.toISOString() } })}\n`)
    const outsideRollout = path.join(tempHome, 'outside-rollout.jsonl')
    await fs.promises.writeFile(outsideRollout, 'must not stat outside CODEX_HOME/sessions')
    expect((await readCodexThreadNames([id(30)], sqliteLoader)).size).toBe(0)
    const created = Date.now() - 5000
    runNode(sqliteFixture, older, JSON.stringify([[id(30), 'Old name', 'PRIVATE TITLE', '/privacy', null, created - 1000, created - 1000]]))
    runNode(sqliteFixture, latest, JSON.stringify([
      [id(30), 'Orchestrator · 02.01.2026 03:04', 'PRIVATE TITLE', '/privacy', rollout, created, created + 1000],
      [id(31), null, 'PRIVATE TITLE 2', '/privacy', outsideRollout, created - 100, created + 500],
      [id(32), 'Paginated no rollout', 'PRIVATE TITLE 3', '/privacy', null, created - 200, created + 250],
    ]))
    const names = await readCodexThreadNames([id(30), id(31)], sqliteLoader)
    expect(names.get(id(30))).toBe('Orchestrator · 02.01.2026 03:04')
    expect(names.get(id(31))).toBeNull()
    expect(JSON.stringify([...names])).not.toContain('PRIVATE FIRST PROMPT')
    expect(JSON.stringify([...names])).not.toContain('ANOTHER SECRET')
    const confirmed = await findCodexOrchestratorThread('/privacy', 'Orchestrator · 02.01.2026 03:04', created + 2000, sqliteLoader)
    expect(confirmed).toEqual({ available: true, confirmed: true, sessionId: id(30) })
    const captured = await captureCodexThreadId('/privacy', created + 1900, new AbortController().signal, new Set([id(30), id(32)]), 2500, sqliteLoader)
    expect(captured).toEqual({ available: true, sessionId: id(31) })
    expect(await codexThreadExists('/privacy', id(32), sqliteLoader)).toBe(true)
    expect(await nativeSessionExists('codex', '/privacy', id(32), sqliteLoader)).toBe(false)
    expect(await nativeSessionExists('codex', '/privacy', id(30), sqliteLoader)).toBe(true)
    expect(await nativeSessionExists('codex', '/wrong', id(30))).toBe(false)
    const outputLogs: unknown[][] = [], originalLog = console.log, originalWarnForList = console.warn, originalError = console.error
    console.log = (...args: unknown[]) => { outputLogs.push(args) }
    console.warn = (...args: unknown[]) => { outputLogs.push(args) }
    console.error = (...args: unknown[]) => { outputLogs.push(args) }
    let listed: Awaited<ReturnType<typeof listCodexSessions>>
    try { listed = await listCodexSessions('/privacy', 3000, sqliteLoader) }
    finally { console.log = originalLog; console.warn = originalWarnForList; console.error = originalError }
    expect(listed.entries[0]?.title).toBe('Orchestrator · 02.01.2026 03:04')
    expect(listed.entries[0]?.startedAt).toBe(new Date(created).toISOString())
    expect(listed.entries[0]?.lastActivity).toBe(new Date(created + 1000).toISOString())
    expect(listed.entries[0]?.sizeBytes).toBe((await fs.promises.stat(rollout)).size)
    expect(listed.entries[1]?.sizeBytes).toBeNull()
    expect(listed.entries[2]?.title).toBe('Paginated no rollout')
    expect(listed.entries[2]?.sizeBytes).toBeNull()
    expect(listed.truncated).toBe(false)
    expect(JSON.stringify(listed.entries)).not.toContain('PRIVATE FIRST PROMPT')
    expect(JSON.stringify(listed.entries)).not.toContain('ANOTHER SECRET')
    expect(JSON.stringify(listed.entries)).not.toContain('PRIVATE TITLE')
    expect(JSON.stringify(listed.entries)).not.toContain('SECRET FIRST MESSAGE')
    expect(JSON.stringify(listed.entries)).not.toContain('SECRET PREVIEW')
    expect(JSON.stringify(outputLogs)).not.toContain('PRIVATE TITLE')
    expect(JSON.stringify(outputLogs)).not.toContain('SECRET FIRST MESSAGE')
    expect(JSON.stringify(outputLogs)).not.toContain('SECRET PREVIEW')
    const warnings: unknown[][] = [], originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args) }
    try {
      const fallback = await listCodexSessions('/privacy', 3000, async () => { throw new Error('node:sqlite unavailable') })
      expect(fallback.entries[0]?.title).toBeNull()
      expect(JSON.stringify(fallback.entries)).not.toContain('PRIVATE FIRST PROMPT')
      expect(warnings).toHaveLength(1)
    } finally { console.warn = originalWarn }
    const locker = spawn('node', ['-e', `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); process.stdout.write('locked'); setTimeout(()=>{db.close();process.exit(0)},2500)`, latest], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      await new Promise<void>((resolve, reject) => {
        locker.once('error', reject)
        locker.stdout.once('data', () => resolve())
      })
      expect((await readCodexThreadNames([id(30)], sqliteLoader)).size).toBe(0)
    } finally { locker.kill() }
    await fs.promises.writeFile(path.join(root, 'state_10.sqlite'), 'corrupt sqlite bytes')
    expect((await readCodexThreadNames([id(30)], sqliteLoader)).size).toBe(0)
    expect((await readCodexThreadNames([id(30)], async () => { throw new Error('database is locked') })).size).toBe(0)
  })

  test('Codex SQLite listing returns at most 30 of 31 unarchived matching threads and marks truncation', async () => {
    const root = process.env.CODEX_HOME!, state = path.join(root, 'state_11.sqlite')
    await fs.promises.mkdir(root, { recursive: true })
    const rows = Array.from({ length: 31 }, (_, index) => [id(500 + index), `Session ${index}`, 'SECRET TITLE', '/cap', null, Date.now() - index, Date.now() - index])
    rows.push([id(531), 'Archived session', 'SECRET TITLE', '/cap', null, Date.now(), Date.now() + 10_000, 1])
    runNode(sqliteFixture, state, JSON.stringify(rows))
    const result = await listCodexSessions('/cap', 3000, sqliteLoader)
    expect(result.entries).toHaveLength(30)
    expect(result.truncated).toBe(true)
    expect(result.truncatedReason).toBe('cap')
    expect(JSON.stringify(result.entries)).not.toContain('SECRET TITLE')
    expect(result.entries.some(entry => entry.sessionId === id(531))).toBe(false)
  })

  test('Codex raw rename command is exact, once-only, and absent on resume', async () => {
    const writes: string[] = [], write = (data: Buffer) => { writes.push(data.toString('utf8')); return true }
    const fresh = createCodexRenameOnReady(true, write, () => 'Orchestrator · 04.10.2026 03:30', async () => {})!
    await fresh(); await fresh()
    expect(writes).toEqual(['/rename Orchestrator · 04.10.2026 03:30', '\r'])
    expect(createCodexRenameOnReady(false, write, () => 'should not send')).toBeNull()
    expect(writes).toHaveLength(2)
  })

  test('orchestrator name is local-time formatted, Claude writes once, and never creates a missing native file', async () => {
    const date = new Date(2026, 0, 2, 3, 4)
    expect(orchestratorSessionName(date)).toBe('Orchestrator · 02.01.2026 03:04')
    const cwd = '/p', file = claudeSessionFile(cwd, id(20))
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, '{"timestamp":"2026-01-02T00:00:00Z"}\n')
    const naming = new AbortController()
    expect(await nameClaudeSession(cwd, id(20), orchestratorSessionName(date), naming.signal)).toBe(true)
    expect(await nameClaudeSession(cwd, id(20), 'different', naming.signal)).toBe(false)
    expect((await fs.promises.readFile(file, 'utf8')).match(/custom-title/g)).toHaveLength(1)
    const cancelMissing = new AbortController(), missingResult = nameClaudeSession(cwd, id(21), 'never create', cancelMissing.signal)
    setTimeout(() => cancelMissing.abort(), 5)
    expect(await missingResult).toBe(false)
    expect(fs.existsSync(claudeSessionFile(cwd, id(21)))).toBe(false)
    const delayedFile = claudeSessionFile(cwd, id(25)), delayedController = new AbortController()
    const delayedName = nameClaudeSession(cwd, id(25), 'appeared later', delayedController.signal, 5)
    setTimeout(async () => {
      await fs.promises.writeFile(delayedFile, `{"cwd":"${cwd}"}\n`)
    }, 20)
    expect(await delayedName).toBe(true)
    const preNamed = claudeSessionFile(cwd, id(22))
    await fs.promises.writeFile(preNamed, '{"customTitle":"Already named"}\n')
    expect(await nameClaudeSession(cwd, id(22), 'second name', naming.signal)).toBe(false)
    expect(await fs.promises.readFile(preNamed, 'utf8')).toBe('{"customTitle":"Already named"}\n')
    await expect(renameNativeSession('claude', cwd, '../../x', 'bad')).rejects.toThrow('invalid_session_id')
    await expect(renameNativeSession('codex', cwd, '--help', 'bad')).rejects.toThrow('invalid_session_id')
    await expect(renameNativeSession('claude', cwd, id(23), 'missing')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(nativeSessionExists('claude', cwd, id(21))).resolves.toBe(false)
    const appendTarget = claudeSessionFile(cwd, id(24))
    await fs.promises.writeFile(appendTarget, '{"cwd":"/p"}\n')
    await fs.promises.appendFile(appendTarget, '{"type":"assistant"}\n')
    await renameNativeSession('claude', cwd, id(24), 'safe append')
    expect((await fs.promises.readFile(appendTarget, 'utf8')).split('\n').filter(Boolean)).toHaveLength(3)
  })

  test('daemon resume boundary accepts UUID v4/v7 and refuses malformed IDs', () => {
    expect(isCanonicalSessionId('123e4567-e89b-42d3-a456-426614174000')).toBe(true)
    expect(isCanonicalSessionId('018f0f45-7b3c-7abc-8def-0123456789ab')).toBe(true)
    for (const value of ['--help', '../../x', '', '123e4567-e89b-42d3-a456-426614174000x']) expect(isCanonicalSessionId(value)).toBe(false)
  })
})
