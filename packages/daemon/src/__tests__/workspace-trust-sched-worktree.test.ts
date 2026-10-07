// Scoped `sched_worktree` trust provenance (scheduled-duty delivery), tests 1-5.
// The daemon may accept `setVia: 'sched_worktree'` for a `daemon_override` cwd ONLY when the cwd is
// canonically contained as `<parentRoot>/.jerico/sched/<scheduleId>/<slot>` with
// no symlink escape; any resolution error fails closed. A containment failure is
// a distinct status — never `refused-no-provenance` (provenance WAS offered).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedWorkspaceTrust, type WorkspaceTrustSeedInput } from '../workspace-trust.js'

describe('workspace trust — sched_worktree provenance (fix round 3)', () => {
  let root: string
  let claudeConfigPath: string
  let project: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jerico-sched-worktree-trust-'))
    claudeConfigPath = join(root, '.claude.json')
    project = join(root, 'project')
    mkdirSync(join(project, '.jerico', 'sched', 'sched-1'), { recursive: true })
    mkdirSync(join(root, 'elsewhere'), { recursive: true })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function schedInput(cwd: string, overrides: Partial<WorkspaceTrustSeedInput> = {}): WorkspaceTrustSeedInput {
    return {
      agentKey: 'claude',
      cwd,
      cwdSource: 'daemon_override',
      setVia: 'sched_worktree',
      orchestratorOwned: false,
      claudeHome: root,
      claudeConfigPath,
      ...overrides,
    }
  }

  function claudeProjects(): Record<string, { hasTrustDialogAccepted?: boolean }> {
    const config = JSON.parse(readFileSync(claudeConfigPath, 'utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }
    return config.projects ?? {}
  }

  test('a cwd contained as <project>/.jerico/sched/<id>/<slot> seeds trust (brief test 1)', () => {
    const worktree = join(project, '.jerico', 'sched', 'sched-1', 'slot0')
    mkdirSync(worktree, { recursive: true })

    const result = seedWorkspaceTrust(schedInput(worktree))

    expect(result.status).toBe('installed')
    expect(result.canonicalRoot).toBe(realpathSync(worktree))
    expect(claudeProjects()[realpathSync(worktree)]?.hasTrustDialogAccepted).toBe(true)
  })

  test('a cwd outside any project root — no .jerico/sched shape at all — is refused with the containment status (brief test 2)', () => {
    // Reframed against the structural check: a daemon_override cwd reaching this
    // gate has no independent local parent-root record (resolveSpawnCwd gives
    // local_override precedence), so "outside the parent root" is every path
    // that does not carry the `.jerico/sched/<id>/<slot>` shape — an arbitrary
    // sibling directory must never be trustable with this provenance value.
    const result = seedWorkspaceTrust(schedInput(join(root, 'elsewhere')))
    expect(result.status).toBe('refused-sched-containment')
  })

  test('a cwd inside the project but not under .jerico/sched/ is refused (brief test 3)', () => {
    const inside = join(project, 'subdir')
    mkdirSync(inside, { recursive: true })

    expect(seedWorkspaceTrust(schedInput(inside)).status).toBe('refused-sched-containment')
  })

  test('a symlinked worktree slot escaping the parent root is refused (brief test 4)', () => {
    const outsideTarget = join(root, 'outside-target')
    mkdirSync(outsideTarget, { recursive: true })
    const slotLink = join(project, '.jerico', 'sched', 'sched-1', 'slot-link')
    symlinkSync(outsideTarget, slotLink)

    expect(seedWorkspaceTrust(schedInput(slotLink)).status).toBe('refused-sched-containment')
  })

  test('setVia: undefined is still refused exactly as today — no behaviour change for existing paths (brief test 5)', () => {
    const worktree = join(project, '.jerico', 'sched', 'sched-1', 'slot0')
    mkdirSync(worktree, { recursive: true })

    expect(seedWorkspaceTrust(schedInput(worktree, { setVia: undefined })).status).toBe('refused-no-provenance')
  })

  test('documents the trust boundary: the daemon-side check is shape containment, the human-parent anchor is enforced server-side', () => {
    // The sched-path shape is all the daemon can verify locally (see brief
    // decision): any existent `<root>/.jerico/sched/<id>/<slot>` passes the
    // containment check. The human anchor — "the parent project binding is
    // 'ui'/'cli'" — is enforced by the server, which only forwards
    // `sched_worktree` for such schedules (dispatch.ts, fix round 3). A forged
    // spawn can therefore not trust `/Users/x/.ssh`, `/tmp`, or any arbitrary
    // sibling — only sched-worktree-shaped paths. Hardening candidate for a
    // later round: verify `<cwd>/.git` is a worktree gitdir pointer of the
    // derived parent repo.
    const otherRoot = join(root, 'other-project', '.jerico', 'sched', 'sched-9', 'slot0')
    mkdirSync(otherRoot, { recursive: true })

    expect(seedWorkspaceTrust(schedInput(otherRoot)).status).toBe('installed')
  })
})
