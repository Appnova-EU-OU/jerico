import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  seedWorkspaceTrust,
  type WorkspaceTrustSeedInput,
} from '../workspace-trust.js'

/**
 * The real shape ~/.codex/config.toml stores on this machine:
 * TOML tables per absolute path under [projects."<path>"] with trust_level = "trusted".
 * Alongside model settings, notices, MCP servers, and hooks state.
 */
const REAL_CODEX_CONFIG_TOML = `model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
approvals_reviewer = "user"
[projects."/Users/owner"]
trust_level = "trusted"

[projects."/Users/owner/.config/orchestra"]
trust_level = "trusted"

[projects."/Users/owner/Development/jerico"]
trust_level = "trusted"

[notice]
hide_rate_limit_model_nudge = true

[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest"]
`

describe('codex workspace trust seeding', () => {
  let root: string
  let configPath: string
  let project: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jerico-codex-trust-'))
    configPath = join(root, '.codex', 'config.toml')
    project = join(root, 'project with spaces')
    mkdirSync(dirname(configPath), { recursive: true })
    mkdirSync(project, { recursive: true })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function codexInput(overrides: Partial<WorkspaceTrustSeedInput> = {}): WorkspaceTrustSeedInput {
    return {
      agentKey: 'codex',
      cwd: project,
      cwdSource: 'local_override',
      setVia: 'cli',
      orchestratorOwned: false,
      codexHome: root,
      ...overrides,
    }
  }

  function writeConfig(content: string, { mode = 0o600 } = {}): string {
    writeFileSync(configPath, content, { mode })
    return content
  }

  function tempLeftovers(): string[] {
    const dir = realpathSync(dirname(configPath))
    return readdirSync(dir).filter(name => name.startsWith('.config.toml.') && name.endsWith('.tmp'))
  }

  const canonicalProject = () => realpathSync.native(project)

  /* --- Test 1. Catches pre-change workspace-trust.ts:586 (missing codex adapter in WORKSPACE_TRUST_ADAPTERS).
     Before change: seedWorkspaceTrust({ agentKey: 'codex', ... }) returned skipped-agent and wrote nothing. --- */

  test('1. Absent [projects."<root>"] -> appended with trust_level = "trusted", every other table preserved verbatim', () => {
    writeConfig(REAL_CODEX_CONFIG_TOML)

    const result = seedWorkspaceTrust(codexInput())
    expect(result.status).toBe('installed')
    expect(result.canonicalRoot).toBe(canonicalProject())

    const afterContent = readFileSync(configPath, 'utf8')
    // Existing config lines before the append must be byte-for-byte identical
    expect(afterContent.startsWith(REAL_CODEX_CONFIG_TOML)).toBe(true)

    const parsed: any = parseToml(afterContent)
    expect(parsed.model).toBe('gpt-5.6-terra')
    expect(parsed.model_reasoning_effort).toBe('medium')
    expect(parsed.approvals_reviewer).toBe('user')
    expect(parsed.notice.hide_rate_limit_model_nudge).toBe(true)
    expect(parsed.mcp_servers.playwright.command).toBe('npx')
    expect(parsed.projects['/Users/owner'].trust_level).toBe('trusted')
    expect(parsed.projects['/Users/owner/.config/orchestra'].trust_level).toBe('trusted')
    expect(parsed.projects['/Users/owner/Development/jerico'].trust_level).toBe('trusted')
    expect(parsed.projects[canonicalProject()].trust_level).toBe('trusted')

    expect(tempLeftovers()).toEqual([])
  })

  /* --- Test 2. Catches pre-change workspace-trust.ts:586.
     Before change: skipped-agent was returned; after change: already-present with 0 writes and byte-identical file. --- */

  test('2. Already trusted -> already-present, file byte-identical', () => {
    const canonical = canonicalProject()
    const contentWithProject = `${REAL_CODEX_CONFIG_TOML}\n[projects."${canonical}"]\ntrust_level = "trusted"\n`
    const before = writeConfig(contentWithProject)

    const renameSpy = spyOn(fs, 'renameSync')
    try {
      const result = seedWorkspaceTrust(codexInput())
      expect(result.status).toBe('already-present')
      expect(result.canonicalRoot).toBe(canonical)
      expect(renameSpy).not.toHaveBeenCalled()
      expect(readFileSync(configPath, 'utf8')).toBe(before)
      expect(tempLeftovers()).toEqual([])
    } finally {
      renameSpy.mockRestore()
    }
  })

  /* --- Test 3. Catches pre-change workspace-trust.ts:586 and pins Safety Property 5.
     A project with a different trust_level (e.g. untrusted or prompt) is NOT overwritten; returns refused-conflict. --- */

  test('3. Entry present with a different trust_level -> refused-conflict, nothing written', () => {
    const canonical = canonicalProject()
    const contentWithUntrusted = `${REAL_CODEX_CONFIG_TOML}\n[projects."${canonical}"]\ntrust_level = "untrusted"\n`
    const before = writeConfig(contentWithUntrusted)

    const result = seedWorkspaceTrust(codexInput())
    expect(result.status).toBe('refused-conflict')
    expect(result.canonicalRoot).toBe(canonical)
    expect(readFileSync(configPath, 'utf8')).toBe(before)
    expect(tempLeftovers()).toEqual([])
  })

  test('refuses when project entry is missing trust_level or has malformed value', () => {
    const canonical = canonicalProject()
    const contentWithCustom = `${REAL_CODEX_CONFIG_TOML}\n[projects."${canonical}"]\ncustom_setting = true\n`
    const before = writeConfig(contentWithCustom)

    expect(seedWorkspaceTrust(codexInput()).status).toBe('refused-conflict')
    expect(readFileSync(configPath, 'utf8')).toBe(before)
  })

  test('refuses when projects table is a non-table scalar', () => {
    const malformed = `model = "gpt-5"\nprojects = "invalid"\n`
    writeConfig(malformed)

    expect(seedWorkspaceTrust(codexInput()).status).toBe('refused-conflict')
    expect(readFileSync(configPath, 'utf8')).toBe(malformed)
  })

  test('refuses an unparseable TOML file rather than clobbering it', () => {
    const brokenToml = `[invalid toml\nkey = = broken`
    writeConfig(brokenToml)

    expect(seedWorkspaceTrust(codexInput()).status).toBe('refused-conflict')
    expect(readFileSync(configPath, 'utf8')).toBe(brokenToml)
  })

  /* --- Test 4. Catches unsafe symlink targets. --- */

  test('4. Symlinked config.toml -> refused-unsafe-target', () => {
    const decoy = join(root, 'decoy.toml')
    writeFileSync(decoy, REAL_CODEX_CONFIG_TOML, { mode: 0o600 })
    symlinkSync(decoy, configPath)

    expect(seedWorkspaceTrust(codexInput()).status).toBe('refused-unsafe-target')
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(readFileSync(decoy, 'utf8')).toBe(REAL_CODEX_CONFIG_TOML)
    expect(tempLeftovers()).toEqual([])
  })

  test('refuses a config path that escapes the home it was resolved against', () => {
    const outside = mkdtempSync(join(tmpdir(), 'jerico-codex-outside-'))
    try {
      const escaped = join(outside, 'config.toml')
      writeFileSync(escaped, REAL_CODEX_CONFIG_TOML, { mode: 0o600 })

      const result = seedWorkspaceTrust(codexInput({ codexConfigPath: escaped }))
      expect(result.status).toBe('refused-unsafe-target')
      expect(readFileSync(escaped, 'utf8')).toBe(REAL_CODEX_CONFIG_TOML)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('refuses when a directory component on the path is a symlink', () => {
    const realDir = join(root, 'real-codex')
    mkdirSync(realDir, { recursive: true })
    writeFileSync(join(realDir, 'config.toml'), REAL_CODEX_CONFIG_TOML, { mode: 0o600 })
    const linkedDir = join(root, 'linked-codex')
    symlinkSync(realDir, linkedDir)

    const result = seedWorkspaceTrust(codexInput({ codexConfigPath: join(linkedDir, 'config.toml') }))
    expect(result.status).toBe('refused-unsafe-target')
    expect(readFileSync(join(realDir, 'config.toml'), 'utf8')).toBe(REAL_CODEX_CONFIG_TOML)
  })

  /* --- Test 5. Provenance gate verification. Catches any attempt to bypass or weaken generic gate. --- */

  test('5. Provenance gate still rejects server_project, fallback_home, and bindings without trusted provenance', () => {
    writeConfig(REAL_CODEX_CONFIG_TOML)
    const untouched = readFileSync(configPath, 'utf8')

    expect(seedWorkspaceTrust(codexInput({ cwdSource: 'server_project' })).status)
      .toBe('skipped-server-project')
    expect(seedWorkspaceTrust(codexInput({ cwdSource: 'fallback_home' })).status)
      .toBe('skipped-fallback-home')
    expect(seedWorkspaceTrust(codexInput({ cwdSource: 'local_override', setVia: undefined })).status)
      .toBe('refused-no-provenance')
    expect(seedWorkspaceTrust(codexInput({ cwdSource: 'local_override', setVia: 'ui' })).status)
      .toBe('refused-no-provenance')
    expect(seedWorkspaceTrust(codexInput({ cwdSource: 'daemon_override', setVia: undefined })).status)
      .toBe('refused-no-provenance')
    expect(seedWorkspaceTrust(codexInput({ orchestratorOwned: true, setVia: 'auto' })).status)
      .toBe('skipped-orchestrator')

    expect(readFileSync(configPath, 'utf8')).toBe(untouched)
  })

  test('an orchestrator-owned daemon_override with UI provenance reaches the codex adapter', () => {
    writeConfig(REAL_CODEX_CONFIG_TOML)

    expect(seedWorkspaceTrust(codexInput({
      orchestratorOwned: true,
      cwdSource: 'daemon_override',
      setVia: 'ui',
    })).status).toBe('installed')
  })

  test('a cwd that is not a real directory is refused before any write', () => {
    writeConfig(REAL_CODEX_CONFIG_TOML)
    const untouched = readFileSync(configPath, 'utf8')

    expect(seedWorkspaceTrust(codexInput({ cwd: join(root, 'does-not-exist') })).status)
      .toBe('refused-invalid-cwd')
    expect(seedWorkspaceTrust(codexInput({ cwd: configPath })).status)
      .toBe('refused-invalid-cwd')

    expect(readFileSync(configPath, 'utf8')).toBe(untouched)
  })

  test('a daemon_override bound through the UI is trusted (installed)', () => {
    writeConfig(REAL_CODEX_CONFIG_TOML)

    expect(seedWorkspaceTrust(codexInput({ cwdSource: 'daemon_override', setVia: 'ui' })).status)
      .toBe('installed')
  })

  /* --- File creation, mode preservation, newline handling --- */

  test('absent config.toml is created with mode 0600', () => {
    expect(existsSync(configPath)).toBe(false)

    const result = seedWorkspaceTrust(codexInput())
    expect(result.status).toBe('installed')
    expect(existsSync(configPath)).toBe(true)

    const parsed: any = parseToml(readFileSync(configPath, 'utf8'))
    expect(parsed.projects[canonicalProject()].trust_level).toBe('trusted')
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    expect(tempLeftovers()).toEqual([])
  })

  test('preserves existing file mode (e.g. 0640)', () => {
    writeConfig(REAL_CODEX_CONFIG_TOML, { mode: 0o640 })

    expect(seedWorkspaceTrust(codexInput()).status).toBe('installed')
    expect(statSync(configPath).mode & 0o7777).toBe(0o640)
  })

  test('preserves file without trailing newline correctly', () => {
    const withoutTrailing = REAL_CODEX_CONFIG_TOML.trimEnd()
    writeConfig(withoutTrailing)

    expect(seedWorkspaceTrust(codexInput()).status).toBe('installed')
    const after = readFileSync(configPath, 'utf8')
    const parsed: any = parseToml(after)
    expect(parsed.projects[canonicalProject()].trust_level).toBe('trusted')
  })

  /* --- Atomic write CAS and conflict detection --- */

  test('retries and merges an observed concurrent edit before replacement', () => {
    writeConfig(REAL_CODEX_CONFIG_TOML)
    const canonicalTarget = join(realpathSync(root), '.codex', 'config.toml')
    const originalRead = fs.readFileSync
    const originalWrite = fs.writeFileSync
    let targetReads = 0

    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: any) => {
      const result = originalRead(file, options)
      if (file === canonicalTarget && ++targetReads === 2) {
        originalWrite(configPath, `${REAL_CODEX_CONFIG_TOML}# concurrent edit\n`)
      }
      return result
    }) as typeof fs.readFileSync)

    try {
      expect(seedWorkspaceTrust(codexInput()).status).toBe('installed')
    } finally {
      readSpy.mockRestore()
    }

    const after = readFileSync(configPath, 'utf8')
    expect(after).toContain('# concurrent edit')
    const parsed: any = parseToml(after)
    expect(parsed.projects[canonicalProject()].trust_level).toBe('trusted')
    expect(tempLeftovers()).toEqual([])
  })

  test('refuses after three repeatedly observed concurrent edits without clobbering them', () => {
    writeConfig(REAL_CODEX_CONFIG_TOML)
    const canonicalTarget = join(realpathSync(root), '.codex', 'config.toml')
    const originalRead = fs.readFileSync
    const originalWrite = fs.writeFileSync
    let targetReads = 0

    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: any) => {
      const result = originalRead(file, options)
      if (file === canonicalTarget && ++targetReads % 2 === 0) {
        originalWrite(configPath, `${REAL_CODEX_CONFIG_TOML}concurrent = ${targetReads}\n`)
      }
      return result
    }) as typeof fs.readFileSync)

    try {
      expect(seedWorkspaceTrust(codexInput()).status).toBe('refused-conflict')
    } finally {
      readSpy.mockRestore()
    }

    expect(readFileSync(configPath, 'utf8')).toContain('concurrent = 6')
    expect(tempLeftovers()).toEqual([])
  })

  test('cleans temp files when atomic replacement throws', () => {
    writeConfig(REAL_CODEX_CONFIG_TOML)
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
    })

    try {
      expect(seedWorkspaceTrust(codexInput()).status).toBe('failed')
    } finally {
      renameSpy.mockRestore()
    }

    expect(readFileSync(configPath, 'utf8')).toBe(REAL_CODEX_CONFIG_TOML)
    expect(tempLeftovers()).toEqual([])
  })

  /* --- Environment variable overrides --- */

  test('config path can be overridden by JERICO_CODEX_CONFIG_PATH environment variable', () => {
    const alternate = join(root, '.codex', 'alternate-config.toml')
    writeFileSync(alternate, REAL_CODEX_CONFIG_TOML, { mode: 0o600 })
    const saved = process.env['JERICO_CODEX_CONFIG_PATH']
    process.env['JERICO_CODEX_CONFIG_PATH'] = alternate
    try {
      expect(seedWorkspaceTrust(codexInput()).status).toBe('installed')
      const parsed: any = parseToml(readFileSync(alternate, 'utf8'))
      expect(parsed.projects[canonicalProject()].trust_level).toBe('trusted')
      expect(existsSync(configPath)).toBe(false)
    } finally {
      if (saved === undefined) delete process.env['JERICO_CODEX_CONFIG_PATH']
      else process.env['JERICO_CODEX_CONFIG_PATH'] = saved
    }
  })
})
