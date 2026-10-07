import { afterEach, beforeEach, describe, test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedWorkspaceTrust } from '../workspace-trust.js'

/**
 * Regression: a REST-spawned panel (bridge_spawn_worker → POST /projects/:pid/agents)
 * used to arrive without `daemonBindingSetVia`, so the daemon's trust gate refused a
 * legitimate UI binding with `trust_provenance_missing` while the WS spawn path — which
 * does send it — worked. The two spawn paths must agree.
 */
describe('REST spawn carries binding provenance', () => {
  const base = { agentKey: 'claude' as const, cwd: process.cwd(), orchestratorOwned: false }
  let fixtureRoot: string
  let projectRoot: string
  let claudeHome: string

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'jerico-rest-provenance-'))
    projectRoot = join(fixtureRoot, 'project')
    claudeHome = join(fixtureRoot, 'claude-home')
    mkdirSync(projectRoot)
    mkdirSync(claudeHome)
    writeFileSync(join(claudeHome, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: {},
    }))
  })

  afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }))

  function untrustedClaudeBase() {
    return {
      ...base,
      cwd: projectRoot,
      claudeHome,
      claudeConfigPath: join(claudeHome, '.claude.json'),
    }
  }

  test('daemon_override with no setVia is refused (the old REST behaviour)', () => {
    const r = seedWorkspaceTrust({ ...untrustedClaudeBase(), cwdSource: 'daemon_override', setVia: undefined })
    expect(r.status).toBe('refused-no-provenance')
  })

  test('daemon_override with setVia=ui is accepted (what REST now sends)', () => {
    const r = seedWorkspaceTrust({ ...untrustedClaudeBase(), cwdSource: 'daemon_override', setVia: 'ui' })
    expect(r.status).toBe('installed')
  })

  test('daemon_override with setVia=cli is accepted', () => {
    const r = seedWorkspaceTrust({ ...untrustedClaudeBase(), cwdSource: 'daemon_override', setVia: 'cli' })
    expect(r.status).toBe('installed')
  })

  test('setVia=auto is still refused — only a human act grants trust', () => {
    const r = seedWorkspaceTrust({ ...untrustedClaudeBase(), cwdSource: 'daemon_override', setVia: 'auto' })
    expect(r.status).toBe('refused-no-provenance')
  })

  test('local_override still requires cli — a UI binding is not local provenance', () => {
    const isolatedBase = untrustedClaudeBase()
    expect(seedWorkspaceTrust({ ...isolatedBase, cwdSource: 'local_override', setVia: 'ui' }).status)
      .toBe('refused-no-provenance')
    expect(seedWorkspaceTrust({ ...isolatedBase, cwdSource: 'local_override', setVia: 'cli' }).status)
      .not.toBe('refused-no-provenance')
  })
})
