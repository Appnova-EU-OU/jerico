import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { AGENT_SPECS } from '../pty/agents.js'
import {
  detectStartupGate,
  seedWorkspaceTrust,
  startupGateTimeoutDecision,
  type StartupGateProfile,
  type WorkspaceTrustSeedInput,
} from '../workspace-trust.js'

describe('workspace trust seeding', () => {
  let root: string
  let kimiHome: string
  let project: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jerico-workspace-trust-'))
    kimiHome = join(root, 'kimi-home')
    project = join(root, 'project with spaces')
    mkdirSync(kimiHome, { recursive: true })
    mkdirSync(project, { recursive: true })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function claudeInput(overrides: Partial<WorkspaceTrustSeedInput> = {}): WorkspaceTrustSeedInput {
    return {
      agentKey: 'claude',
      cwd: project,
      cwdSource: 'local_override',
      setVia: 'cli',
      orchestratorOwned: false,
      claudeHome: root,
      claudeConfigPath: join(root, '.claude.json'),
      ...overrides,
    }
  }

  function claudeTemps(): string[] {
    return readdirSync(realpathSync(root)).filter(name => name.startsWith('..claude.json.') && name.endsWith('.tmp'))
  }

  test('writes Kimi exact realpath filename and payload before spawn consumers use it', () => {
    const canonical = realpathSync(project)
    const expectedName = `wd_${basename(canonical)}_${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`
    const result = seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'local_override', setVia: 'cli',
      orchestratorOwned: false, kimiHome, now: 1_725_000_000_123,
    })

    expect(result).toEqual({ status: 'installed', canonicalRoot: canonical })
    const target = join(kimiHome, 'workspace-trust', expectedName)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ root: canonical, trustedAt: 1_725_000_000_123 })
    expect(lstatSync(join(kimiHome, 'workspace-trust')).mode & 0o777).toBe(0o700)
    expect(lstatSync(target).mode & 0o777).toBe(0o600)

    const bytes = readFileSync(target, 'utf8')
    expect(seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'local_override', setVia: 'cli',
      orchestratorOwned: false, kimiHome, now: 1_725_000_999_999,
    }).status).toBe('already-present')
    expect(readFileSync(target, 'utf8')).toBe(bytes)
  })

  test('keeps provenance gates unchanged', () => {
    expect(seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'fallback_home', orchestratorOwned: false, kimiHome,
    }).status).toBe('skipped-fallback-home')
    expect(seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'server_project', orchestratorOwned: false, kimiHome,
    }).status).toBe('skipped-server-project')
    expect(seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'local_override', orchestratorOwned: false, kimiHome,
    }).status).toBe('refused-no-provenance')
    expect(seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'daemon_override', orchestratorOwned: false, kimiHome,
    }).status).toBe('refused-no-provenance')
    expect(seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'daemon_override', setVia: 'auto',
      orchestratorOwned: true, kimiHome,
    }).status).toBe('skipped-orchestrator')
  })

  test('an orchestrator panel seeds trusted provenance and silently skips refusals', () => {
    expect(seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'daemon_override', setVia: 'auto',
      orchestratorOwned: true, kimiHome,
    }).status).toBe('skipped-orchestrator')
    expect(seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'local_override', setVia: 'ui',
      orchestratorOwned: true, kimiHome,
    }).status).toBe('skipped-orchestrator')
    expect(seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'daemon_override', setVia: 'ui',
      orchestratorOwned: true, kimiHome,
    }).status).toBe('installed')
    expect(seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'local_override', setVia: 'cli',
      orchestratorOwned: true, kimiHome,
    }).status).toBe('already-present')

    // Non-orchestrator spawns keep every refusal.
    expect(seedWorkspaceTrust({
      agentKey: 'kimi', cwd: project, cwdSource: 'daemon_override', orchestratorOwned: false, kimiHome,
    }).status).toBe('refused-no-provenance')
  })

  test('merges only Claude onboarding and canonical workspace trust while preserving unrelated JSON', () => {
    const target = join(root, '.claude.json')
    const canonical = realpathSync(project)
    writeFileSync(target, JSON.stringify({
      theme: 'dark',
      projects: { '/other': { keep: true }, [canonical]: { note: 'keep' } },
    }))

    expect(seedWorkspaceTrust(claudeInput())).toEqual({ status: 'installed', canonicalRoot: canonical })
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
      theme: 'dark',
      hasCompletedOnboarding: true,
      projects: {
        '/other': { keep: true },
        [canonical]: { note: 'keep', hasTrustDialogAccepted: true },
      },
    })
    expect(existsSync(join(root, '.claude'))).toBe(false)
    expect(existsSync(join(project, '.claude'))).toBe(false)
  })

  test('never creates or modifies either deleted persistent settings path', () => {
    const homeSettings = join(root, '.claude', 'settings.json')
    const localSettings = join(project, '.claude', 'settings.local.json')
    mkdirSync(join(root, '.claude'))
    mkdirSync(join(project, '.claude'))
    writeFileSync(homeSettings, '{"owner":"user"}\n')
    writeFileSync(localSettings, '{"owner":"project"}\n')

    expect(seedWorkspaceTrust(claudeInput()).status).toBe('installed')
    expect(readFileSync(homeSettings, 'utf8')).toBe('{"owner":"user"}\n')
    expect(readFileSync(localSettings, 'utf8')).toBe('{"owner":"project"}\n')

    rmSync(homeSettings)
    rmSync(localSettings)
    expect(seedWorkspaceTrust(claudeInput()).status).toBe('already-present')
    expect(existsSync(homeSettings)).toBe(false)
    expect(existsSync(localSettings)).toBe(false)
  })

  test('is idempotent when onboarding and trust are already present', () => {
    const target = join(root, '.claude.json')
    const canonical = realpathSync(project)
    const original = JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [canonical]: { hasTrustDialogAccepted: true, keep: 1 } },
    }, null, 4)
    writeFileSync(target, original)
    const renameSpy = spyOn(fs, 'renameSync')
    try {
      expect(seedWorkspaceTrust(claudeInput())).toEqual({ status: 'already-present', canonicalRoot: canonical })
      expect(renameSpy).not.toHaveBeenCalled()
      expect(readFileSync(target, 'utf8')).toBe(original)
    } finally {
      renameSpy.mockRestore()
    }
  })

  test('preserves an existing Claude config file mode', () => {
    const target = join(root, '.claude.json')
    writeFileSync(target, '{"theme":"dark"}')
    chmodSync(target, 0o640)
    expect(seedWorkspaceTrust(claudeInput()).status).toBe('installed')
    expect(lstatSync(target).mode & 0o7777).toBe(0o640)
  })

  test('fails closed for malformed JSON and conflicting project shapes', () => {
    const target = join(root, '.claude.json')
    for (const bytes of ['{ malformed', '[]', '{"projects":[]}', `{"projects":{"${realpathSync(project)}":false}}`]) {
      writeFileSync(target, bytes)
      expect(seedWorkspaceTrust(claudeInput()).status).toBe('refused-conflict')
      expect(readFileSync(target, 'utf8')).toBe(bytes)
    }
  })

  test('refuses a symlink target and a target outside the canonical home direct child', () => {
    const outside = join(root, 'outside.json')
    const target = join(root, '.claude.json')
    writeFileSync(outside, '{"owner":"outside"}')
    symlinkSync(outside, target, 'file')
    expect(seedWorkspaceTrust(claudeInput()).status).toBe('refused-unsafe-target')
    expect(readFileSync(outside, 'utf8')).toBe('{"owner":"outside"}')

    rmSync(target)
    const nested = join(root, 'nested')
    mkdirSync(nested)
    expect(seedWorkspaceTrust(claudeInput({ claudeConfigPath: join(nested, '.claude.json') })).status)
      .toBe('refused-unsafe-target')
    expect(existsSync(join(nested, '.claude.json'))).toBe(false)
  })

  test('accepts a canonical OS alias for home without escaping it', () => {
    // On macOS tmpdir() sits under an OS alias (/var → /private/var), so home
    // and project are reached through a symlinked ANCESTOR. Where tmpdir() has
    // no alias, the test builds the same shape: a symlink to root, with home
    // and project below it. (A home that is itself a symlink is refused — that
    // is a different case.)
    let home = root
    let cwd = project
    let alias: string | null = null
    if (realpathSync(root) === root) {
      alias = `${root}-alias`
      symlinkSync(root, alias)
      mkdirSync(join(root, 'home', basename(project)), { recursive: true })
      home = join(alias, 'home')
      cwd = join(home, basename(project))
    }
    try {
      const canonicalHome = realpathSync(home)
      const canonical = realpathSync(cwd)
      expect(home).not.toBe(canonicalHome)
      expect(cwd).not.toBe(canonical)
      expect(seedWorkspaceTrust(claudeInput({
        cwd,
        claudeHome: home,
        claudeConfigPath: join(home, '.claude.json'),
      }))).toEqual({ status: 'installed', canonicalRoot: canonical })
      expect(existsSync(join(canonicalHome, '.claude.json'))).toBe(true)
      expect(JSON.parse(readFileSync(join(canonicalHome, '.claude.json'), 'utf8')).projects[canonical].hasTrustDialogAccepted).toBe(true)
    } finally {
      if (alias) rmSync(alias, { force: true })
    }
  })

  test('retries and merges an observed concurrent edit before replacement', () => {
    const target = join(root, '.claude.json')
    const canonicalTarget = join(realpathSync(root), '.claude.json')
    writeFileSync(target, '{"theme":"dark"}')
    const originalRead = fs.readFileSync
    const originalWrite = fs.writeFileSync
    let targetReads = 0
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: any) => {
      const result = originalRead(file, options)
      if (file === canonicalTarget && ++targetReads === 2) {
        originalWrite(target, '{"theme":"dark","concurrent":1}')
      }
      return result
    }) as typeof fs.readFileSync)
    try {
      expect(seedWorkspaceTrust(claudeInput()).status).toBe('installed')
    } finally {
      readSpy.mockRestore()
    }
    const parsed = JSON.parse(readFileSync(target, 'utf8'))
    expect(parsed.concurrent).toBe(1)
    expect(parsed.projects[realpathSync(project)].hasTrustDialogAccepted).toBe(true)
    expect(claudeTemps()).toEqual([])
  })

  test('refuses after three repeatedly observed concurrent edits without clobbering them', () => {
    const target = join(root, '.claude.json')
    const canonicalTarget = join(realpathSync(root), '.claude.json')
    writeFileSync(target, '{"theme":"dark"}')
    const originalRead = fs.readFileSync
    const originalWrite = fs.writeFileSync
    let targetReads = 0
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: any) => {
      const result = originalRead(file, options)
      if (file === canonicalTarget && ++targetReads % 2 === 0) {
        originalWrite(target, JSON.stringify({ owner: 'concurrent', revision: targetReads }))
      }
      return result
    }) as typeof fs.readFileSync)
    try {
      expect(seedWorkspaceTrust(claudeInput()).status).toBe('refused-conflict')
    } finally {
      readSpy.mockRestore()
    }
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ owner: 'concurrent', revision: 6 })
    expect(claudeTemps()).toEqual([])
  })

  test('never clobbers a target created concurrently on the absent-file path', () => {
    const target = join(root, '.claude.json')
    const canonicalTarget = join(realpathSync(root), '.claude.json')
    const originalLink = fs.linkSync
    const originalWrite = fs.writeFileSync
    const linkSpy = spyOn(fs, 'linkSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (to === canonicalTarget && !existsSync(target)) originalWrite(target, '{"owner":"concurrent"}')
      return originalLink(from, to)
    }) as typeof fs.linkSync)
    try {
      expect(seedWorkspaceTrust(claudeInput()).status).toBe('refused-conflict')
    } finally {
      linkSpy.mockRestore()
    }
    expect(readFileSync(target, 'utf8')).toBe('{"owner":"concurrent"}')
    expect(claudeTemps()).toEqual([])
  })

  test('cleans its temp when atomic replacement fails', () => {
    const target = join(root, '.claude.json')
    writeFileSync(target, '{"theme":"dark"}')
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
    })
    try {
      expect(seedWorkspaceTrust(claudeInput()).status).toBe('failed')
    } finally {
      renameSpy.mockRestore()
    }
    expect(readFileSync(target, 'utf8')).toBe('{"theme":"dark"}')
    expect(claudeTemps()).toEqual([])
  })
})

describe('generic startup-gate detection', () => {
  const profile: StartupGateProfile = {
    kind: 'workspace_trust',
    allOf: [/Trust this folder/i, /Don't trust/i],
  }

  test('requires the full profile signature after ANSI stripping', () => {
    expect(detectStartupGate(profile, '\u001b[31mTrust this folder\u001b[0m\nDon\'t trust')).toBe(true)
    expect(detectStartupGate(profile, 'Trust this folder')).toBe(false)
    expect(detectStartupGate(profile, 'ordinary model output')).toBe(false)
  })

  test('a fourth agent uses the same consumer with only a new profile', () => {
    const fourth: StartupGateProfile = { kind: 'workspace_trust', allOf: [/allow acme/i, /exit acme/i] }
    expect(detectStartupGate(fourth, 'Allow Acme for this folder?  Exit Acme')).toBe(true)
  })

  test('a gate-aware timeout surfaces attention and never takes the legacy forced flush', () => {
    expect(startupGateTimeoutDecision(profile, false, undefined)).toBe('attention')
    expect(startupGateTimeoutDecision(profile, true, undefined)).toBe('hold')
    expect(startupGateTimeoutDecision(profile, false, 'seed_failed')).toBe('hold')
    expect(startupGateTimeoutDecision(undefined, false, undefined)).toBe('fallback')
  })

  test('the codex-shaped startup acknowledger is deleted rather than extended', () => {
    expect(AGENT_SPECS.some(spec => 'onboardingAck' in (spec.tui ?? {}))).toBe(false)
    const client = readFileSync(join(import.meta.dir, '..', 'ws', 'client.ts'), 'utf8')
    expect(client).not.toContain('codexOnboardingAcked')
    expect(client).not.toContain('codex.onboarding.auto_ack')
  })

  test('spawn wiring seeds before Kimi mirrors its real home and before PTY spawn', () => {
    const client = readFileSync(join(import.meta.dir, '..', 'ws', 'client.ts'), 'utf8')
    const seedAt = client.indexOf('const trustSeed = seedWorkspaceTrust({')
    const setupAt = client.indexOf('const kimiHome = setupKimiMcpHome(mcpSpawnCtx)')
    const spawnAt = client.indexOf('const ok = manager.spawn(')
    expect(seedAt).toBeGreaterThan(-1)
    expect(setupAt).toBeGreaterThan(seedAt)
    expect(spawnAt).toBeGreaterThan(setupAt)
  })
})

describe('two-spawn regression', () => {
  test('does not seed trust for auto-promoted server paths (phase2a.auto_register)', () => {
    // Covered by two-spawn-trust.test.ts; retained here as the suite map.
  })
})
