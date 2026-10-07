import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
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
import {
  seedWorkspaceTrust,
  type WorkspaceTrustSeedInput,
} from '../workspace-trust.js'

/**
 * The shape agy actually stores, verified against the real
 * ~/.gemini/antigravity-cli/settings.json on 2026-08-27: a flat array of
 * absolute path strings under `trustedWorkspaces`, alongside the user's model,
 * telemetry opt-out and command-permission allowlist. 2-space indented,
 * trailing newline, mode 0600.
 */
const REAL_SHAPE = {
  allowNonWorkspaceAccess: true,
  enableTelemetry: false,
  model: 'Gemini 3.7 Flash (Low)',
  permissions: { allow: ['command(git status)', 'command(ls)'] },
  trustedWorkspaces: ['/Users/someone/Development/jerico'],
}

describe('agy workspace trust seeding', () => {
  let root: string
  let settingsPath: string
  let project: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jerico-agy-trust-'))
    settingsPath = join(root, '.gemini', 'antigravity-cli', 'settings.json')
    project = join(root, 'project with spaces')
    mkdirSync(dirname(settingsPath), { recursive: true })
    mkdirSync(project, { recursive: true })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function agyInput(overrides: Partial<WorkspaceTrustSeedInput> = {}): WorkspaceTrustSeedInput {
    return {
      agentKey: 'agy',
      cwd: project,
      cwdSource: 'local_override',
      setVia: 'cli',
      orchestratorOwned: false,
      agyHome: root,
      ...overrides,
    }
  }

  function writeSettings(value: unknown, { trailingNewline = true } = {}): string {
    const bytes = `${JSON.stringify(value, null, 2)}${trailingNewline ? '\n' : ''}`
    writeFileSync(settingsPath, bytes, { mode: 0o600 })
    return bytes
  }

  function tempLeftovers(): string[] {
    return readdirSync(realpathSync(dirname(settingsPath)))
      .filter(name => name.startsWith('.settings.json.') && name.endsWith('.tmp'))
  }

  const canonicalProject = () => realpathSync.native(project)

  /* --- 1 & 3. Catches workspace-trust.ts:446-449, the two-entry
     WORKSPACE_TRUST_ADAPTERS registry: with no `agy` adapter the dispatch
     returns skipped-agent and nothing is ever written, which is why the live
     smoke sat on the CLI's folder-trust prompt until the handshake timed out. --- */

  test('appends the project when trustedWorkspaces is absent, preserving every other key and its order', () => {
    const { trustedWorkspaces: _omitted, ...withoutTrust } = REAL_SHAPE
    writeSettings(withoutTrust)

    const result = seedWorkspaceTrust(agyInput())
    expect(result.status).toBe('installed')
    expect(result.canonicalRoot).toBe(canonicalProject())

    const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(after.trustedWorkspaces).toEqual([canonicalProject()])
    // Order: the four original keys keep their positions, the new key is appended.
    expect(Object.keys(after)).toEqual([
      'allowNonWorkspaceAccess', 'enableTelemetry', 'model', 'permissions', 'trustedWorkspaces',
    ])
    expect(after.allowNonWorkspaceAccess).toBe(true)
    expect(after.enableTelemetry).toBe(false)
    expect(after.model).toBe('Gemini 3.7 Flash (Low)')
    expect(after.permissions).toEqual({ allow: ['command(git status)', 'command(ls)'] })
    expect(tempLeftovers()).toEqual([])
  })

  test('appends to an existing list without disturbing the entries already in it', () => {
    writeSettings(REAL_SHAPE)

    expect(seedWorkspaceTrust(agyInput()).status).toBe('installed')

    const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(after.trustedWorkspaces).toEqual([
      '/Users/someone/Development/jerico',
      canonicalProject(),
    ])
    // trustedWorkspaces was already 5th; it must not jump to the end.
    expect(Object.keys(after)).toEqual(Object.keys(REAL_SHAPE))
  })

  test('every unrelated key survives verbatim, and none is dropped', () => {
    const rich = {
      ...REAL_SHAPE,
      permissions: { allow: ['command(git status)'], deny: ['command(rm -rf /)'] },
      someFutureKey: { nested: { deep: [1, 2, 3] } },
      anotherScalar: 'keep me',
    }
    writeSettings(rich)

    expect(seedWorkspaceTrust(agyInput()).status).toBe('installed')

    const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(Object.keys(after).sort()).toEqual(Object.keys(rich).sort())
    for (const key of Object.keys(rich)) {
      if (key === 'trustedWorkspaces') continue
      expect(after[key]).toEqual((rich as Record<string, unknown>)[key])
    }
  })

  test('preserves the trailing newline and the file mode so the user file does not churn', () => {
    writeSettings(REAL_SHAPE)
    const modeBefore = statSync(settingsPath).mode & 0o7777

    expect(seedWorkspaceTrust(agyInput()).status).toBe('installed')

    const bytes = readFileSync(settingsPath, 'utf8')
    expect(bytes.endsWith('\n')).toBe(true)
    expect(bytes).toContain('\n  "model": "Gemini 3.7 Flash (Low)",')
    expect(statSync(settingsPath).mode & 0o7777).toBe(modeBefore)
  })

  test('a file written without a trailing newline stays without one', () => {
    writeSettings(REAL_SHAPE, { trailingNewline: false })

    expect(seedWorkspaceTrust(agyInput()).status).toBe('installed')

    expect(readFileSync(settingsPath, 'utf8').endsWith('\n')).toBe(false)
  })

  /* --- 2. Same registry line: before the change this could not even reach a
     duplicate check, and a naive adapter would append the path twice. --- */

  test('an already-trusted path is already-present and the file is byte-identical', () => {
    const before = writeSettings({
      ...REAL_SHAPE,
      trustedWorkspaces: ['/Users/someone/Development/jerico', realpathSync.native(project)],
    })

    const result = seedWorkspaceTrust(agyInput())
    expect(result.status).toBe('already-present')
    expect(readFileSync(settingsPath, 'utf8')).toBe(before)
    expect(tempLeftovers()).toEqual([])
  })

  /* --- 4. Catches an adapter that coerces an unexpected shape. Nothing in the
     pre-change code did this, because nothing ran at all; the risk is in the
     fix, so it is pinned. --- */

  test('refuses when trustedWorkspaces is a string rather than an array', () => {
    const before = writeSettings({ ...REAL_SHAPE, trustedWorkspaces: '/Users/someone/one-path' })

    expect(seedWorkspaceTrust(agyInput()).status).toBe('refused-conflict')
    expect(readFileSync(settingsPath, 'utf8')).toBe(before)
    expect(tempLeftovers()).toEqual([])
  })

  test('refuses when trustedWorkspaces holds a non-string entry', () => {
    const before = writeSettings({ ...REAL_SHAPE, trustedWorkspaces: ['/Users/someone/ok', 42] })

    expect(seedWorkspaceTrust(agyInput()).status).toBe('refused-conflict')
    expect(readFileSync(settingsPath, 'utf8')).toBe(before)
  })

  test('refuses an unparseable settings file rather than replacing it', () => {
    writeFileSync(settingsPath, '{ not json', { mode: 0o600 })

    expect(seedWorkspaceTrust(agyInput()).status).toBe('refused-conflict')
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ not json')
  })

  /* --- 5. Catches an adapter that writes through a symlink. --- */

  test('refuses a symlinked settings file and never follows it', () => {
    const decoy = join(root, 'decoy.json')
    writeFileSync(decoy, JSON.stringify({ trustedWorkspaces: [] }, null, 2), { mode: 0o600 })
    symlinkSync(decoy, settingsPath)

    expect(seedWorkspaceTrust(agyInput()).status).toBe('refused-unsafe-target')

    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(decoy, 'utf8')).trustedWorkspaces).toEqual([])
    expect(tempLeftovers()).toEqual([])
  })

  test('refuses a settings path that escapes the home it was resolved against', () => {
    const outside = mkdtempSync(join(tmpdir(), 'jerico-agy-outside-'))
    try {
      const escaped = join(outside, 'settings.json')
      writeFileSync(escaped, JSON.stringify(REAL_SHAPE, null, 2), { mode: 0o600 })

      const result = seedWorkspaceTrust(agyInput({ agySettingsPath: escaped }))
      expect(result.status).toBe('refused-unsafe-target')
      expect(JSON.parse(readFileSync(escaped, 'utf8')).trustedWorkspaces)
        .toEqual(REAL_SHAPE.trustedWorkspaces)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('refuses when a directory component on the way to the file is a symlink', () => {
    const realDir = join(root, 'real-config')
    mkdirSync(realDir, { recursive: true })
    writeFileSync(join(realDir, 'settings.json'), JSON.stringify(REAL_SHAPE, null, 2), { mode: 0o600 })
    const linkedDir = join(root, 'linked-config')
    symlinkSync(realDir, linkedDir)

    const result = seedWorkspaceTrust(agyInput({ agySettingsPath: join(linkedDir, 'settings.json') }))
    expect(result.status).toBe('refused-unsafe-target')
    expect(JSON.parse(readFileSync(join(realDir, 'settings.json'), 'utf8')).trustedWorkspaces)
      .toEqual(REAL_SHAPE.trustedWorkspaces)
  })

  /* --- 6. The file is never created from nothing. --- */

  test('an absent settings file is not created', () => {
    expect(existsSync(settingsPath)).toBe(false)

    const result = seedWorkspaceTrust(agyInput())
    expect(result.status).toBe('failed')
    expect(result.canonicalRoot).toBe(canonicalProject())

    expect(existsSync(settingsPath)).toBe(false)
    expect(tempLeftovers()).toEqual([])
  })

  /* --- 7. The generic provenance gate runs before the adapter and is neither
     duplicated nor weakened. Each of these returns before any file is read. --- */

  test('the provenance gate still rejects what it rejected before', () => {
    writeSettings(REAL_SHAPE)
    const untouched = readFileSync(settingsPath, 'utf8')

    expect(seedWorkspaceTrust(agyInput({ cwdSource: 'server_project' })).status)
      .toBe('skipped-server-project')
    expect(seedWorkspaceTrust(agyInput({ cwdSource: 'fallback_home' })).status)
      .toBe('skipped-fallback-home')
    expect(seedWorkspaceTrust(agyInput({ cwdSource: 'local_override', setVia: undefined })).status)
      .toBe('refused-no-provenance')
    expect(seedWorkspaceTrust(agyInput({ cwdSource: 'local_override', setVia: 'ui' })).status)
      .toBe('refused-no-provenance')
    expect(seedWorkspaceTrust(agyInput({ cwdSource: 'daemon_override', setVia: undefined })).status)
      .toBe('refused-no-provenance')
    expect(seedWorkspaceTrust(agyInput({ orchestratorOwned: true, setVia: 'auto' })).status)
      .toBe('skipped-orchestrator')

    expect(readFileSync(settingsPath, 'utf8')).toBe(untouched)
  })

  test('an orchestrator-owned daemon_override with UI provenance reaches the agy adapter', () => {
    writeSettings(REAL_SHAPE)

    expect(seedWorkspaceTrust(agyInput({
      orchestratorOwned: true,
      cwdSource: 'daemon_override',
      setVia: 'ui',
    })).status).toBe('installed')
  })

  test('a cwd that is not a real directory is refused before any write', () => {
    writeSettings(REAL_SHAPE)
    const untouched = readFileSync(settingsPath, 'utf8')

    expect(seedWorkspaceTrust(agyInput({ cwd: join(root, 'does-not-exist') })).status)
      .toBe('refused-invalid-cwd')
    expect(seedWorkspaceTrust(agyInput({ cwd: settingsPath })).status)
      .toBe('refused-invalid-cwd')

    expect(readFileSync(settingsPath, 'utf8')).toBe(untouched)
  })

  test('a daemon_override bound through the UI is still trusted, as for the other agents', () => {
    writeSettings(REAL_SHAPE)

    expect(seedWorkspaceTrust(agyInput({ cwdSource: 'daemon_override', setVia: 'ui' })).status)
      .toBe('installed')
  })

  test('an agent with no adapter is still skipped', () => {
    writeSettings(REAL_SHAPE)
    const untouched = readFileSync(settingsPath, 'utf8')

    expect(seedWorkspaceTrust(agyInput({ agentKey: 'qwen' })).status).toBe('skipped-agent')
    expect(readFileSync(settingsPath, 'utf8')).toBe(untouched)
  })

  test('the settings path can also be overridden by environment variable', () => {
    const alternate = join(root, '.gemini', 'antigravity-cli', 'alternate.json')
    writeFileSync(alternate, `${JSON.stringify(REAL_SHAPE, null, 2)}\n`, { mode: 0o600 })
    const saved = process.env['JERICO_AGY_SETTINGS_PATH']
    process.env['JERICO_AGY_SETTINGS_PATH'] = alternate
    try {
      expect(seedWorkspaceTrust(agyInput()).status).toBe('installed')
      expect(JSON.parse(readFileSync(alternate, 'utf8')).trustedWorkspaces)
        .toContain(canonicalProject())
      expect(existsSync(settingsPath)).toBe(false)
    } finally {
      if (saved === undefined) delete process.env['JERICO_AGY_SETTINGS_PATH']
      else process.env['JERICO_AGY_SETTINGS_PATH'] = saved
    }
  })
})
