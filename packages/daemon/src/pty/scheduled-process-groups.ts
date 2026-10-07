/**
 * Scheduled Duty V1 descendant proof (#637 cp5, Q1).
 *
 * A scheduled panel's PTY child is a session leader (node-pty setsid), so its
 * pid is also its process-group id. The ledger keeps every `sched-*` group this
 * daemon ever spawned, including ones already killed, so the isolated harness
 * can capture them before shutdown and prove each group empty afterwards.
 *
 * Exposure is harness-gated: both isolated-harness markers plus an sdv1 nonce
 * profile. Every normal CLI, desktop, launchd, dev and production daemon omits
 * the field entirely.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCHEDULED_AGENT_ID = /^sched-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NONCE_PROFILE = /^sdv1-\d+-\d+$/
export const SCHEDULED_GROUP_LEDGER_CAP = 256

export interface ScheduledProcessGroup {
  agentId: string
  spawnAttemptId: string
  pid: number
  pgid: number
  spawnedAt: number
}

export interface ScheduledProcessGroupReport {
  version: 1
  daemonPid: number
  /** true when more groups were spawned than the ledger holds: proof must fail closed. */
  overflow: boolean
  groups: Array<ScheduledProcessGroup & { live: boolean }>
}

export function scheduledDescendantHealthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['JERICO_ISOLATED_HARNESS'] === '1'
    && env['JERICO_SDV1_DESCENDANT_PROOF'] === '1'
    && NONCE_PROFILE.test(env['BRIDGE_PROFILE'] ?? '')
}

export class ScheduledProcessGroupLedger {
  private entries: ScheduledProcessGroup[] = []
  private overflowed = false

  record(agentId: string, spawnAttemptId: string, pid: number): void {
    if (!agentId.startsWith('sched-')) return
    if (!Number.isInteger(pid) || pid <= 1) { this.overflowed = true; return }
    if (this.entries.length >= SCHEDULED_GROUP_LEDGER_CAP) { this.overflowed = true; return }
    // node-pty's child is its own session leader: pid == pgid (see manager.ts).
    this.entries.push({ agentId, spawnAttemptId, pid, pgid: pid, spawnedAt: Date.now() })
  }

  report(isLive: (entry: ScheduledProcessGroup) => boolean): ScheduledProcessGroupReport {
    return {
      version: 1,
      daemonPid: process.pid,
      overflow: this.overflowed,
      groups: this.entries.map(entry => ({ ...entry, live: isLive(entry) })),
    }
  }
}

/** Provider-free falsifier panel, harness-gated like the health field. Its
 * shell and its descendant both ignore SIGTERM/SIGHUP/SIGINT, so a daemon
 * shutdown (SIGTERM-only killAll) cannot remove the group. */
export function scheduledDescendantFalsifierPanel(env: NodeJS.ProcessEnv = process.env): { agentId: string; spawnAttemptId: string; binary: string; args: string[] } | null {
  if (!scheduledDescendantHealthEnabled(env)) return null
  const agentId = env['JERICO_SDV1_FAKE_SCHED_PANEL']
  const spawnAttemptId = env['JERICO_SDV1_FAKE_SCHED_ATTEMPT']
  if (!agentId || !spawnAttemptId) return null
  if (!SCHEDULED_AGENT_ID.test(agentId) || !UUID.test(spawnAttemptId)) return null
  return {
    agentId,
    spawnAttemptId,
    binary: '/bin/sh',
    args: ['-c', "trap '' TERM HUP INT; /bin/sleep 900 & /bin/sleep 900; wait"],
  }
}
