import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedWorkspaceTrust, type WorkspaceTrustSeedInput } from '../workspace-trust.js'

describe('#613 trust provenance gate', () => {
  let fixtureRoot: string
  let projectRoot: string
  let claudeHome: string

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'jerico-613-trust-'))
    projectRoot = join(fixtureRoot, 'project')
    claudeHome = join(fixtureRoot, 'claude-home')
    mkdirSync(projectRoot)
    mkdirSync(claudeHome)
  })

  afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }))

  function input(home = claudeHome): WorkspaceTrustSeedInput {
    return {
      agentKey: 'claude',
      cwd: projectRoot,
      cwdSource: 'daemon_override',
      setVia: 'auto',
      orchestratorOwned: false,
      claudeHome: home,
      claudeConfigPath: join(home, '.claude.json'),
    }
  }

  function writeClaudeConfig(home: string, trusted: boolean): void {
    const canonicalRoot = realpathSync(projectRoot)
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: trusted ? { [canonicalRoot]: { hasTrustDialogAccepted: true } } : {},
    }))
  }

  test('returns already-present for an already-trusted auto daemon binding', () => {
    writeClaudeConfig(claudeHome, true)
    const configPath = join(claudeHome, '.claude.json')
    const beforeBytes = readFileSync(configPath, 'utf8')
    const beforeStat = statSync(configPath)

    expect(seedWorkspaceTrust(input())).toEqual({
      status: 'already-present',
      canonicalRoot: realpathSync(projectRoot),
    })
    expect(readFileSync(configPath, 'utf8')).toBe(beforeBytes)
    expect(statSync(configPath).ino).toBe(beforeStat.ino)
    expect(statSync(configPath).mtimeMs).toBe(beforeStat.mtimeMs)
  })

  test('refuses an untrusted auto daemon binding without mutating provider config', () => {
    writeClaudeConfig(claudeHome, false)
    const before = readFileSync(join(claudeHome, '.claude.json'), 'utf8')

    expect(seedWorkspaceTrust(input()).status).toBe('refused-no-provenance')
    expect(readFileSync(join(claudeHome, '.claude.json'), 'utf8')).toBe(before)
  })

  test('rejects a symlinked Claude home before accepting an existing trust record', () => {
    writeClaudeConfig(claudeHome, true)
    const linkedHome = join(fixtureRoot, 'linked-claude-home')
    symlinkSync(claudeHome, linkedHome)

    expect(seedWorkspaceTrust(input(linkedHome)).status).not.toBe('already-present')
  })

  test('keeps every adapter without a trust probe behind the provenance gate', () => {
    for (const agentKey of ['codex', 'kimi', 'agy'] as const) {
      expect(seedWorkspaceTrust({
        agentKey,
        cwd: projectRoot,
        cwdSource: 'daemon_override',
        setVia: 'auto',
        orchestratorOwned: false,
      }).status, agentKey).toBe('refused-no-provenance')
    }
  })
})
