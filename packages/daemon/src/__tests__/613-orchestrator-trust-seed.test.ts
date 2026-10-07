import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedWorkspaceTrust, type WorkspaceTrustSeedInput } from '../workspace-trust.js'

describe('#613 orchestrator-owned workspace trust seeding', () => {
  let fixtureRoot: string
  let projectRoot: string
  let claudeHome: string
  let claudeConfigPath: string

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'jerico-613-orchestrator-trust-'))
    projectRoot = join(fixtureRoot, 'project')
    claudeHome = join(fixtureRoot, 'claude-home')
    claudeConfigPath = join(claudeHome, '.claude.json')
    mkdirSync(projectRoot)
    mkdirSync(claudeHome)
  })

  afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }))

  function input(overrides: Partial<WorkspaceTrustSeedInput> = {}): WorkspaceTrustSeedInput {
    return {
      agentKey: 'claude',
      cwd: projectRoot,
      cwdSource: 'daemon_override',
      setVia: 'ui',
      orchestratorOwned: true,
      claudeHome,
      claudeConfigPath,
      ...overrides,
    }
  }

  function writeClaudeConfig(trusted: boolean): void {
    const canonicalRoot = realpathSync(projectRoot)
    writeFileSync(claudeConfigPath, JSON.stringify({
      hasCompletedOnboarding: true,
      projects: trusted ? { [canonicalRoot]: { hasTrustDialogAccepted: true } } : {},
    }))
  }

  test('passes through already-present for an orchestrator-owned UI binding', () => {
    writeClaudeConfig(true)

    expect(seedWorkspaceTrust(input())).toEqual({
      status: 'already-present',
      canonicalRoot: realpathSync(projectRoot),
    })
  })

  test('runs the adapter and installs trust for an untrusted orchestrator-owned UI binding', () => {
    writeClaudeConfig(false)
    const canonicalRoot = realpathSync(projectRoot)

    expect(seedWorkspaceTrust(input())).toEqual({ status: 'installed', canonicalRoot })
    expect(JSON.parse(readFileSync(claudeConfigPath, 'utf8'))).toEqual({
      hasCompletedOnboarding: true,
      projects: { [canonicalRoot]: { hasTrustDialogAccepted: true } },
    })
  })

  test('silently skips an orchestrator-owned auto binding instead of exposing its provenance refusal', () => {
    writeClaudeConfig(false)

    expect(seedWorkspaceTrust(input({ setVia: 'auto' }))).toEqual({ status: 'skipped-orchestrator' })
  })

  test('silently skips every refused target for an orchestrator-owned binding', () => {
    const missingProject = join(fixtureRoot, 'missing-project')
    expect(seedWorkspaceTrust(input({ cwd: missingProject }))).toEqual({ status: 'skipped-orchestrator' })

    const outsideConfig = join(fixtureRoot, 'outside-claude.json')
    writeFileSync(outsideConfig, '{}')
    rmSync(claudeConfigPath, { force: true })
    symlinkSync(outsideConfig, claudeConfigPath)
    expect(seedWorkspaceTrust(input())).toEqual({ status: 'skipped-orchestrator' })

    rmSync(claudeConfigPath)
    writeFileSync(claudeConfigPath, '{not-json')
    expect(seedWorkspaceTrust(input())).toEqual({ status: 'skipped-orchestrator' })
  })

  test('silently skips an adapter failure for an orchestrator-owned binding', () => {
    writeClaudeConfig(false)
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
    })

    try {
      expect(seedWorkspaceTrust(input())).toEqual({ status: 'skipped-orchestrator' })
    } finally {
      renameSpy.mockRestore()
    }
  })

  test('keeps auto provenance refused for an ordinary panel', () => {
    writeClaudeConfig(false)

    expect(seedWorkspaceTrust(input({ orchestratorOwned: false, setVia: 'auto' }))).toEqual({
      status: 'refused-no-provenance',
    })
  })

  test('keeps agents without a trust adapter skipped before orchestrator handling', () => {
    expect(seedWorkspaceTrust(input({ agentKey: 'sh' }))).toEqual({ status: 'skipped-agent' })
  })
})
