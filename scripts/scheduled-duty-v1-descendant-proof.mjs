/**
 * Scheduled Duty V1 descendant proof (#637 cp5, Q1), parent side.
 *
 * Source of identity: the nonce daemon's harness-gated `/health`
 * `scheduledProcessGroups` field (packages/daemon/src/pty/scheduled-process-groups.ts).
 * The parent captures and verifies it while the daemon is alive, binds it to the
 * parent DB snapshot, and after daemon shutdown proves every captured group and
 * every captured descendant absent. Anything else is `not_proven`.
 */
import { spawnSync } from 'node:child_process'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCHEDULED_AGENT_ID = /^sched-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCHEDULED_WORKTREE_ID = /^sched-wt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const scheduledGroupAgentId = value => typeof value === 'string' && (SCHEDULED_AGENT_ID.test(value) || SCHEDULED_WORKTREE_ID.test(value))
const positivePid = value => Number.isInteger(value) && value > 1

/** Full process table: pid, ppid, pgid and exact start time (pid-reuse guard). */
export function processTable() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('process_table_unavailable')
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [pid, ppid, pgid, ...start] = line.split(/\s+/)
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), lstart: start.join(' ') }
  })
}

export function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
}

/** `ps -g <pgid>` must print nothing. macOS/BSD ps exits 1 on an empty selection. */
export function psGroupEmpty(pgid) {
  const result = spawnSync('ps', ['-g', String(pgid), '-o', 'pid='], { encoding: 'utf8' })
  if (result.error || result.signal) return false
  return result.stdout.trim() === '' && (result.status === 0 || result.status === 1)
}

export function validateGroupReport(report) {
  if (!report || typeof report !== 'object' || report.version !== 1 || !positivePid(report.daemonPid) || typeof report.overflow !== 'boolean' || !Array.isArray(report.groups)) throw new Error('scheduled_group_report_invalid')
  for (const group of report.groups) {
    if (!group || !scheduledGroupAgentId(group.agentId)) throw new Error('scheduled_group_entry_invalid_agent_id')
    if (!UUID.test(group.spawnAttemptId)) throw new Error('scheduled_group_entry_invalid_spawn_attempt_id')
    if (!positivePid(group.pid)) throw new Error('scheduled_group_entry_invalid_pid')
    if (group.pgid !== group.pid) throw new Error('scheduled_group_entry_invalid_pgid')
    if (typeof group.live !== 'boolean') throw new Error('scheduled_group_entry_invalid_live')
  }
  return report
}

/** Accumulates identities across polls. Created once per harness run.
 * `errors` is integrity-only (report-invalid, daemon-changed, attempt-changed,
 * leader-reused, overflow, required field-unavailable) and stays fatal via
 * `bindingFailure`. `misses`/`lastCaptureOkAt` are observability only. */
export function createDescendantProof() {
  return { groups: new Map(), daemonPid: null, overflow: false, captures: 0, errors: [], misses: [], lastCaptureOkAt: null }
}

const SAFE_MISS_REASON = /^[a-z0-9_]{1,80}$/
/** One observability miss: a capture attempt that could not read the ledger.
 * Never fatal by itself; only a `required` miss also raises the integrity
 * error. The reason must remain a publishable slug. */
export function recordMiss(proof, reason, at = Date.now()) {
  proof.misses.push({ reason: SAFE_MISS_REASON.test(reason) ? reason : 'capture_exception', at })
  return proof
}

function raiseFieldUnavailable(proof) {
  if (!proof.errors.includes('scheduled_group_field_unavailable')) proof.errors.push('scheduled_group_field_unavailable')
}

/**
 * The pre-shutdown final-capture anchor was never attempted at all — the
 * daemon child was already gone, or there was no health port to begin with.
 * This is not an observed miss from a failed fetch; it is the harness
 * skipping the attempt outright, so it must raise the same fatal
 * `scheduled_group_field_unavailable` error a fully-failed `requiredFinalCapture`
 * would, or a run could still read `proven` with no anchor at all.
 */
export function recordFinalCaptureSkipped(proof) {
  recordMiss(proof, 'final_capture_skipped')
  raiseFieldUnavailable(proof)
  return proof
}

/**
 * One capture attempt from the nonce daemon's harness-gated `/health` field.
 * `load()` resolves the parsed health body (a fetch throw or timeout rejects);
 * `accept(body)` is true only for this nonce profile's report. A miss (fetch
 * throw, timeout, absent field) is recorded as an observability miss and, only
 * when `required`, also raises the fatal `scheduled_group_field_unavailable`
 * error. Returns true iff a report was captured.
 */
export async function captureDescendantHealth(proof, load, accept, { required = false } = {}) {
  let body = null
  try { body = await load() } catch { body = null }
  if (body === null || !accept(body)) {
    recordMiss(proof, 'scheduled_group_field_unavailable')
    if (required) raiseFieldUnavailable(proof)
    return false
  }
  captureGroups(proof, body.scheduledProcessGroups)
  proof.lastCaptureOkAt = Date.now()
  return true
}

/**
 * The final pre-shutdown capture anchors the terminal window: the daemon's
 * ledger is append-only, so one successful capture re-reports every group ever
 * spawned. It retries up to `attempts` times (each attempt keeps its own 2 s
 * fetch timeout); every failed attempt is a recorded miss, and only after the
 * last attempt fails does the miss raise the fatal
 * `scheduled_group_field_unavailable` error. An exception from an attempt is
 * recorded the same way and must never skip teardown.
 *
 * `delayMs` (default 300) waits between attempts so a transient failure
 * (ECONNREFUSED during daemon shutdown races, a field momentarily absent) has
 * a chance to clear before the next try; there is never a delay after the
 * last attempt. Tests inject `delayMs: 0` to stay fast.
 */
export async function requiredFinalCapture(proof, attempt, { attempts = 3, delayMs = 300 } = {}) {
  let ok = false
  let tried = 0
  for (; tried < attempts && !ok; tried++) {
    const required = tried + 1 === attempts
    try { ok = await attempt(required) === true }
    catch (error) {
      recordMiss(proof, String(error?.message ?? error))
      if (required) raiseFieldUnavailable(proof)
    }
    if (!ok && tried + 1 < attempts && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return { ok, attempts: tried }
}

/**
 * Capture one health report. A live group is verified against the OS right now:
 * its leader must be a group leader (pgid === pid), and every process in the
 * group or under the leader's ppid tree is recorded with its start time.
 */
export function captureGroups(proof, rawReport, table = processTable()) {
  let report
  try { report = validateGroupReport(rawReport) } catch (error) { proof.errors.push(String(error.message)); return proof }
  if (proof.daemonPid !== null && proof.daemonPid !== report.daemonPid) proof.errors.push('scheduled_group_daemon_changed')
  proof.daemonPid = report.daemonPid
  proof.overflow ||= report.overflow
  proof.captures++
  for (const group of report.groups) {
    const key = `${group.agentId}:${group.pgid}`
    const entry = proof.groups.get(key) ?? { agentId: group.agentId, spawnAttemptId: group.spawnAttemptId, pgid: group.pgid, verifiedLive: false, leaderStart: null, members: new Map() }
    if (entry.spawnAttemptId !== group.spawnAttemptId) proof.errors.push('scheduled_group_attempt_changed')
    const leader = table.find(row => row.pid === group.pid)
    if (group.live && leader && leader.pgid === group.pgid) {
      if (entry.leaderStart !== null && entry.leaderStart !== leader.lstart) proof.errors.push('scheduled_group_leader_reused')
      entry.leaderStart = leader.lstart
      entry.verifiedLive = true
      const tree = new Set([group.pid])
      for (let grew = true; grew;) {
        grew = false
        for (const row of table) if (!tree.has(row.pid) && tree.has(row.ppid)) { tree.add(row.pid); grew = true }
      }
      for (const row of table) if (row.pgid === group.pgid || tree.has(row.pid)) entry.members.set(`${row.pid}:${row.lstart}`, { pid: row.pid, lstart: row.lstart, pgid: row.pgid })
    }
    proof.groups.set(key, entry)
  }
  return proof
}

/** Journal form: exact groups recovery may signal. */
export function journalGroups(proof) {
  return [...proof.groups.values()].map(entry => ({ agentId: entry.agentId, pgid: entry.pgid, leaderStart: entry.leaderStart }))
}

/**
 * Binding: exactly one scheduled group, for exactly the parent-snapshot agent and
 * spawn attempt, observed live by the parent. Zero or multiple fail closed.
 */
export function bindingFailure(proof, binding) {
  if (proof.errors.length) return proof.errors[0]
  if (proof.overflow) return 'scheduled_group_ledger_overflow'
  if (proof.captures < 1) return 'scheduled_group_not_captured'
  if (!binding || !SCHEDULED_AGENT_ID.test(binding.agentId ?? '') || !UUID.test(binding.spawnAttemptId ?? '')) return 'scheduled_group_binding_missing'
  const groups = [...proof.groups.values()].filter(group => SCHEDULED_AGENT_ID.test(group.agentId))
  if (groups.length === 0) return 'scheduled_group_zero'
  if (groups.length > 1) return 'scheduled_group_multiple'
  const [group] = groups
  if (group.agentId !== binding.agentId) return 'scheduled_group_agent_mismatch'
  if (group.spawnAttemptId !== binding.spawnAttemptId) return 'scheduled_group_attempt_mismatch'
  if (!group.verifiedLive || group.members.size < 1) return 'scheduled_group_never_verified_live'
  return null
}

/** After daemon shutdown. Pure observation: never signals anything. */
export function evaluateDescendantProof(proof, binding, { table = processTable(), alive = groupAlive, psEmpty = psGroupEmpty } = {}) {
  const failure = bindingFailure(proof, binding)
  const groups = [...proof.groups.values()].map(group => {
    const survivors = [...group.members.values()].filter(member => table.some(row => row.pid === member.pid && row.lstart === member.lstart))
    const inGroup = table.filter(row => row.pgid === group.pgid).map(row => row.pid)
    return { agentId: group.agentId, spawnAttemptId: group.spawnAttemptId, pgid: group.pgid, capturedMembers: group.members.size,
      killGroupEsrch: !alive(group.pgid), psGroupEmpty: psEmpty(group.pgid), tableGroupEmpty: inGroup.length === 0, capturedDescendantsAbsent: survivors.length === 0 }
  })
  const allAbsent = groups.length > 0 && groups.every(group => group.killGroupEsrch && group.psGroupEmpty && group.tableGroupEmpty && group.capturedDescendantsAbsent)
  const proven = failure === null && allAbsent
  return { scheduledDescendantProof: proven ? 'proven' : 'not_proven', reason: failure ?? (allAbsent ? null : 'scheduled_group_survives'), groups }
}

/**
 * Teardown escalation for exactly the captured groups: SIGTERM, then SIGKILL,
 * then poll ESRCH. A group is signalled only while its captured leader start
 * time is unchanged or it holds a captured member, so a reused pgid is never hit.
 */
export async function reapCapturedGroups(proof, { graceMs = 2_000, waitMs = 10_000 } = {}) {
  const owned = group => {
    const table = processTable()
    const rows = table.filter(row => row.pgid === group.pgid)
    return rows.some(row => group.members.has(`${row.pid}:${row.lstart}`))
  }
  const actions = []
  for (const group of proof.groups.values()) {
    if (!groupAlive(group.pgid)) { actions.push({ pgid: group.pgid, action: 'absent' }); continue }
    if (!owned(group)) { actions.push({ pgid: group.pgid, action: 'not_owned_skipped' }); continue }
    try { process.kill(-group.pgid, 'SIGTERM') } catch {}
    const termDeadline = Date.now() + graceMs
    while (Date.now() < termDeadline && groupAlive(group.pgid)) await new Promise(resolve => setTimeout(resolve, 50))
    let action = 'sigterm'
    if (groupAlive(group.pgid) && owned(group)) { try { process.kill(-group.pgid, 'SIGKILL') } catch {}; action = 'sigkill' }
    const killDeadline = Date.now() + waitMs
    while (Date.now() < killDeadline && groupAlive(group.pgid)) await new Promise(resolve => setTimeout(resolve, 50))
    actions.push({ pgid: group.pgid, action, esrch: !groupAlive(group.pgid) })
  }
  // A captured descendant that left the group (setsid/setpgid) is signalled by
  // exact pid only while its recorded start time still matches.
  for (const group of proof.groups.values()) {
    for (const member of group.members.values()) {
      if (!processTable().some(row => row.pid === member.pid && row.lstart === member.lstart)) continue
      try { process.kill(member.pid, 'SIGKILL') } catch {}
      actions.push({ pid: member.pid, action: 'escaped_member_sigkill' })
    }
  }
  return actions
}
