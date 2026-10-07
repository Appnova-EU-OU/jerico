import { spawnSync } from 'node:child_process'

export interface ProjectGitSnapshot {
  branchRef: string | null
  headSha: string
  gitDirty: boolean
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 3_000,
    windowsHide: true,
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  return result.stdout.trim()
}

/**
 * Capture checkout truth on the daemon that owns the filesystem. The server
 * never accepts equivalent browser assertions as provenance.
 */
export function observeProjectGitSnapshot(cwd: string): ProjectGitSnapshot | null {
  const headSha = git(cwd, ['rev-parse', '--verify', 'HEAD'])
  if (!headSha || !/^[a-f0-9]{40,64}$/i.test(headSha)) return null
  const branchRef = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=normal'])
  if (status === null) return null
  return {
    branchRef: branchRef && branchRef.length <= 255 ? branchRef : null,
    headSha: headSha.toLowerCase(),
    gitDirty: status.length > 0,
  }
}
