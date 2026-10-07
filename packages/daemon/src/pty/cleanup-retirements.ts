/** A kill notification retires a handle before the OS process group exits.
 * Keep these ids in cleanup rosters until the group is actually absent. */
export class CleanupRetirements {
  private groups = new Map<string, Set<number>>()
  constructor(private isAlive = processGroupAlive) {}
  record(agentId: string, pid: number): void {
    this.present()
    const groups = this.groups.get(agentId) ?? new Set<number>()
    groups.add(pid)
    this.groups.set(agentId, groups)
  }
  present(isAlive = this.isAlive): string[] {
    for (const [id, groups] of this.groups) {
      for (const pid of groups) if (!isAlive(pid)) groups.delete(pid)
      if (!groups.size) this.groups.delete(id)
    }
    return [...this.groups.keys()]
  }
}

function processGroupAlive(pid: number): boolean {
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
