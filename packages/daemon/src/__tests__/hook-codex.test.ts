import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  computeCodexHookHash,
  findTomlStateSpans,
  seedCodexTrust,
  isOurCodexHandler,
  updateTomlTrustState
} from '../hooks/codex-hash.js'
import { assertHookBlock, removeHookBlock } from '../hooks/install.js'
import { spliceBlock, stripBlock } from '../hooks/block.js'
import { hookScriptPath } from '../hooks/script.js'
import { getHookConfig } from '../hooks/state.js'
import { parse as parseToml } from 'smol-toml'
import { promises as fs } from 'node:fs'
import path from 'path'
import os from 'os'

const foreignCodexFixture = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: '.*',
        hooks: [
          {
            type: 'command',
            command: "'/Users/owner/Library/Application Support/OtherTool/othertool-external/hook-scripts/codex/preToolUse.cjs'"
          }
        ]
      }
    ],
    Stop: [
      {
        matcher: '.*',
        hooks: [
          {
            type: 'command',
            command: "'/Users/owner/Library/Application Support/OtherTool/othertool-external/hook-scripts/codex/stop.cjs'"
          }
        ]
      }
    ],
    SessionStart: [
      {
        matcher: '.*',
        hooks: [
          {
            type: 'command',
            command: "'/Users/owner/Library/Application Support/OtherTool/othertool-external/hook-scripts/codex/sessionStart.cjs'"
          }
        ]
      }
    ],
    PermissionRequest: [
      {
        matcher: '.*',
        hooks: [
          {
            type: 'command',
            command: "'/Users/owner/Library/Application Support/OtherTool/othertool-external/hook-scripts/codex/permissionRequest.cjs'"
          }
        ]
      }
    ]
  }
}, null, 2) + '\n'

describe('hook-codex step 2 & fix round 7 verification', () => {
  let tempDir: string
  let hooksPath: string
  let configPath: string
  let ledgerPath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jerico-codex-test-'))
    hooksPath = path.join(tempDir, 'hooks.json')
    configPath = path.join(tempDir, 'config.toml')
    ledgerPath = path.join(tempDir, '.jerico-codex-trust.json')

    process.env.JERICO_CODEX_HOOKS_PATH = hooksPath
    process.env.JERICO_CODEX_CONFIG_PATH = configPath
    process.env.JERICO_CODEX_TRUST_LEDGER_PATH = ledgerPath
    await fs.writeFile(hooksPath, foreignCodexFixture, 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    delete process.env.JERICO_CODEX_HOOKS_PATH
    delete process.env.JERICO_CODEX_CONFIG_PATH
    delete process.env.JERICO_CODEX_TRUST_LEDGER_PATH
    delete process.env.JERICO_HOOK_SCRIPT_PATH_OVERRIDE
  })

  // Codex's hook identity hash: sha256 of the key-sorted, whitespace-free JSON
  // {event_name, hooks:[{async,command,timeout,type}], matcher?} (matcher is
  // dropped for stop/user_prompt_submit). The values below were computed from
  // that recipe with an independent implementation (Python hashlib +
  // json.dumps(sort_keys=True, separators=(',', ':'))), the same recipe that
  // reproduces trusted_hash values real Codex wrote for these four hook shapes.
  it('reproduces 4/4 Codex identity hashes for a foreign tool\'s hooks', () => {
    const preToolUseHash = computeCodexHookHash(
      'PreToolUse',
      '.*',
      { type: 'command', command: "'/Users/owner/Library/Application Support/OtherTool/othertool-external/hook-scripts/codex/preToolUse.cjs'" }
    )
    expect(preToolUseHash).toBe('sha256:e033ad5997fab25eaca5384b7ee30f0b34e8f7bdb24e898cbdffee1ce6ed026a')

    const permissionHash = computeCodexHookHash(
      'PermissionRequest',
      '.*',
      { type: 'command', command: "'/Users/owner/Library/Application Support/OtherTool/othertool-external/hook-scripts/codex/permissionRequest.cjs'" }
    )
    expect(permissionHash).toBe('sha256:377d2270399e8df20cb79f271a53bd6a235310ec98b1f24e08288369ac13881f')

    const sessionStartHash = computeCodexHookHash(
      'SessionStart',
      '.*',
      { type: 'command', command: "'/Users/owner/Library/Application Support/OtherTool/othertool-external/hook-scripts/codex/sessionStart.cjs'" }
    )
    expect(sessionStartHash).toBe('sha256:7555f942b68dc935f010f42291a5887850339b2bb48ed5ab30f837ba5d4bc8c4')

    const stopHash = computeCodexHookHash(
      'Stop',
      '.*',
      { type: 'command', command: "'/Users/owner/Library/Application Support/OtherTool/othertool-external/hook-scripts/codex/stop.cjs'" }
    )
    expect(stopHash).toBe('sha256:12e6f961fe5e18afaa9b3bf3271b81c130c9c0b18bb95185d8f5af1e5006abc3')
  })

  it('spliceCodexBlock preserves foreign-tool foreign hooks and adds Jerico Stop hook', () => {
    const { content: spliced, status } = spliceBlock('codex', foreignCodexFixture)
    expect(status).toBe('installed')

    const parsed = JSON.parse(spliced)
    expect(parsed.hooks.PreToolUse).toHaveLength(1)
    expect(parsed.hooks.PermissionRequest).toHaveLength(1)
    expect(parsed.hooks.SessionStart).toHaveLength(1)
    expect(parsed.hooks.Stop).toHaveLength(2)

    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('othertool-external')
    expect(parsed.hooks.Stop[1].hooks[0].command).toContain('JERICO_AGENT_HOOK=1')
    expect(parsed.hooks.Stop[1].matcher).toBeUndefined()
  })

  it('stripCodexBlock removes Jerico hook while retaining foreign-tool hook', () => {
    const { content: spliced } = spliceBlock('codex', foreignCodexFixture)
    const { content: stripped, status } = stripBlock('codex', spliced)
    expect(status).toBe('installed')

    const parsed = JSON.parse(stripped)
    expect(parsed.hooks.Stop).toHaveLength(1)
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('othertool-external')
  })

  /* ---------------- Restored Regressions 1 through 5 ---------------- */

  it('Regression 1: echo JERICO_AGENT_HOOK=1; /tmp/evil with timeout: 2 is NOT trusted and NOT treated as ours', async () => {
    const maliciousJson = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: '.*',
            hooks: [
              {
                type: 'command',
                command: 'echo JERICO_AGENT_HOOK=1; /tmp/evil',
                timeout: 2
              }
            ]
          }
        ]
      }
    }, null, 2)
    await fs.writeFile(hooksPath, maliciousJson, 'utf-8')
    await seedCodexTrust(hooksPath)

    let configContent = ''
    try {
      configContent = await fs.readFile(configPath, 'utf-8')
    } catch {}

    expect(configContent).not.toContain(`[hooks.state."${hooksPath}:stop:0:0"]`)
    expect(isOurCodexHandler('Stop', { type: 'command', command: 'echo JERICO_AGENT_HOOK=1; /tmp/evil', timeout: 2 })).toBe(false)
  })

  it('Regression 2: A commented trusted_hash inside the section with Jerico hash does not delete that section', async () => {
    const jericoHash = computeCodexHookHash('Stop', '.*', {
      type: 'command',
      command: "'/Users/owner/Library/Application Support/OtherTool/othertool-external/hook-scripts/codex/stop.cjs'"
    })
    const tomlWithCommentInside = `[hooks.state."${hooksPath}:stop:0:0"]\n# trusted_hash = "${jericoHash}"\ntrusted_hash = "sha256:realforeignhash"\n`
    await fs.writeFile(configPath, tomlWithCommentInside, 'utf-8')

    await seedCodexTrust(hooksPath)

    const configContent = await fs.readFile(configPath, 'utf-8')
    expect(configContent).toContain(`[hooks.state."${hooksPath}:stop:0:0"]`)
    expect(configContent).toContain('trusted_hash = "sha256:realforeignhash"')
  })

  it('Regression 3: Active Jerico key header inside multiline string survives byte-for-byte', async () => {
    const tomlWithMultilineCollision = `[custom_setting]\ndescription = """\n[hooks.state."${hooksPath}:stop:1:0"]\ntrusted_hash = "sha256:fake"\n"""\n`
    await fs.writeFile(configPath, tomlWithMultilineCollision, 'utf-8')

    await seedCodexTrust(hooksPath)

    const configContent = await fs.readFile(configPath, 'utf-8')
    expect(configContent).toContain('description = """')
    expect(configContent).toContain(`[hooks.state."${hooksPath}:stop:1:0"]`)
    expect(configContent).toContain('trusted_hash = "sha256:fake"')
  })

  it('Regression 4: enabled (and unknown keys) in our own table survive a trust update', async () => {
    await assertHookBlock('codex')

    let configContent = await fs.readFile(configPath, 'utf-8')
    expect(configContent).toContain(`[hooks.state."${hooksPath}:stop:1:0"]`)

    const updatedWithCustomKeys = configContent.replace(
      `[hooks.state."${hooksPath}:stop:1:0"]`,
      `[hooks.state."${hooksPath}:stop:1:0"]\nenabled = false\ncustom_key = 99`
    )
    await fs.writeFile(configPath, updatedWithCustomKeys, 'utf-8')

    await seedCodexTrust(hooksPath)

    configContent = await fs.readFile(configPath, 'utf-8')
    expect(configContent).toContain('enabled = false')
    expect(configContent).toContain('custom_key = 99')
    expect(configContent).toContain('trusted_hash = "sha256:')
  })

  it('Regression 5: Install, change hookScriptPath(), uninstall — nothing left in config.toml and no second hook group in hooks.json', async () => {
    const script1 = path.join(tempDir, 'script1', 'jerico-hook.sh')
    await fs.mkdir(path.dirname(script1), { recursive: true })
    await fs.writeFile(script1, '#!/bin/sh\n', { mode: 0o755 })
    process.env.JERICO_HOOK_SCRIPT_PATH_OVERRIDE = script1

    await assertHookBlock('codex')
    let hooksContent = await fs.readFile(hooksPath, 'utf-8')
    let parsed = JSON.parse(hooksContent)
    expect(parsed.hooks.Stop).toHaveLength(2)

    const script2 = path.join(tempDir, 'script2', 'jerico-hook.sh')
    await fs.mkdir(path.dirname(script2), { recursive: true })
    await fs.writeFile(script2, '#!/bin/sh\n', { mode: 0o755 })
    process.env.JERICO_HOOK_SCRIPT_PATH_OVERRIDE = script2

    await assertHookBlock('codex')
    hooksContent = await fs.readFile(hooksPath, 'utf-8')
    parsed = JSON.parse(hooksContent)
    expect(parsed.hooks.Stop).toHaveLength(2)
    expect(parsed.hooks.Stop[1].hooks[0].command).toContain('script2')

    await removeHookBlock('codex')
    hooksContent = await fs.readFile(hooksPath, 'utf-8')
    parsed = JSON.parse(hooksContent)
    expect(parsed.hooks.Stop).toHaveLength(1)
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('othertool-external')

    const finalConfig = await fs.readFile(configPath, 'utf-8')
    expect(finalConfig).not.toContain('script1')
    expect(finalConfig).not.toContain('script2')
    expect(finalConfig).not.toContain(`${hooksPath}:stop:1:0`)
  })

  /* ---------------- Restored Single-Guard Mutation Tests A, B, C ---------------- */

  it('Mutation Test A: PreToolUse event matching Jerico command shape is NOT granted trust', async () => {
    const script = hookScriptPath()
    const preToolUseJson = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: `JERICO_AGENT_HOOK=1 "${script}"`,
                timeout: 2
              }
            ]
          }
        ]
      }
    })
    await fs.writeFile(hooksPath, preToolUseJson, 'utf-8')
    await seedCodexTrust(hooksPath)

    let configContent = ''
    try {
      configContent = await fs.readFile(configPath, 'utf-8')
    } catch {}

    expect(configContent).not.toContain(`[hooks.state."${hooksPath}:pre_tool_use:0:0"]`)
    expect(isOurCodexHandler('PreToolUse', { type: 'command', command: `JERICO_AGENT_HOOK=1 "${script}"`, timeout: 2 })).toBe(false)
  })

  it('Mutation Test B: Foreign tool replacing Jerico table with foreign hash causes Jerico to relinquish claim', async () => {
    await assertHookBlock('codex')

    let configContent = await fs.readFile(configPath, 'utf-8')
    const modifiedToml = configContent.replace(/trusted_hash = "sha256:[^"]+"/, 'trusted_hash = "sha256:foreign_tool_hash"')
    await fs.writeFile(configPath, modifiedToml, 'utf-8')

    const { content: stripped } = stripBlock('codex', await fs.readFile(hooksPath, 'utf-8'))
    await fs.writeFile(hooksPath, stripped, 'utf-8')
    await seedCodexTrust(hooksPath)

    configContent = await fs.readFile(configPath, 'utf-8')
    expect(configContent).toContain(`[hooks.state."${hooksPath}:stop:1:0"]`)
    expect(configContent).toContain('trusted_hash = "sha256:foreign_tool_hash"')
  })

  it('Mutation Test C: Owned table containing multiline note with decoy trusted_hash updates real hash without corrupting note', async () => {
    await assertHookBlock('codex')

    let configContent = await fs.readFile(configPath, 'utf-8')
    const spanHeader = `[hooks.state."${hooksPath}:stop:1:0"]`
    const tableWithMultilineNote = configContent.replace(
      spanHeader,
      `${spanHeader}\nnote = """\ntrusted_hash = "sha256:decoy_in_string"\n"""`
    )
    await fs.writeFile(configPath, tableWithMultilineNote, 'utf-8')

    await seedCodexTrust(hooksPath)

    configContent = await fs.readFile(configPath, 'utf-8')
    expect(configContent).toContain('trusted_hash = "sha256:decoy_in_string"')
    expect(configContent).toContain(`[hooks.state."${hooksPath}:stop:1:0"]`)
    expect(configContent).toMatch(/trusted_hash = "sha256:[a-f0-9]{64}"/)
  })

  /* ---------------- Round 4 Items 1 through 6 ---------------- */

  it('Round 4 Item 1: Lowercase stop event carrying exact Jerico handler MUST NOT be granted trust (Critical)', async () => {
    const script = hookScriptPath()
    const lowercaseStopJson = JSON.stringify({
      hooks: {
        stop: [
          {
            hooks: [
              {
                type: 'command',
                command: `JERICO_AGENT_HOOK=1 "${script}"`,
                timeout: 2
              }
            ]
          }
        ]
      }
    })
    await fs.writeFile(hooksPath, lowercaseStopJson, 'utf-8')
    await seedCodexTrust(hooksPath)

    let configContent = ''
    try {
      configContent = await fs.readFile(configPath, 'utf-8')
    } catch {}

    expect(configContent).not.toContain(`[hooks.state."${hooksPath}:stop:0:0"]`)
    expect(isOurCodexHandler('stop', { type: 'command', command: `JERICO_AGENT_HOOK=1 "${script}"`, timeout: 2 })).toBe(false)
  })

  it('Round 4 Item 2: atomicWrite preserves non-0600 mode (0644) and symbolic links', async () => {
    const targetFile = path.join(tempDir, 'real-config.toml')
    await fs.writeFile(targetFile, '[hooks.state]\n', { mode: 0o644 })
    await fs.symlink(targetFile, configPath)

    await assertHookBlock('codex')

    const lstat = await fs.lstat(configPath)
    expect(lstat.isSymbolicLink()).toBe(true)

    const realStat = await fs.stat(targetFile)
    expect(realStat.mode & 0o777).toBe(0o644)
  })

  it('Round 4 Item 3: Conflict detection retries transaction when mtime changes during transaction', async () => {
    await assertHookBlock('codex')

    const originalContent = await fs.readFile(configPath, 'utf-8')

    const trustPromise = seedCodexTrust(hooksPath)
    await fs.writeFile(configPath, originalContent + '# concurrent edit\n')
    await trustPromise

    const updatedContent = await fs.readFile(configPath, 'utf-8')
    expect(updatedContent).toContain('# concurrent edit')
  })

  it('Round 4 Item 4: Empty ledger triggers fallback reconciliation and prunes stale entry', async () => {
    await fs.writeFile(ledgerPath, JSON.stringify({ keys: [] }), 'utf-8')

    const expectedHash = computeCodexHookHash('Stop', undefined, {
      type: 'command',
      command: `JERICO_AGENT_HOOK=1 "${hookScriptPath()}"`,
      timeout: 2
    })
    const staleToml = `[hooks.state."${hooksPath}:stop:1:0"]\ntrusted_hash = "${expectedHash}"\n`
    await fs.writeFile(configPath, staleToml, 'utf-8')

    await seedCodexTrust(hooksPath)

    const updatedConfig = await fs.readFile(configPath, 'utf-8')
    expect(updatedConfig).not.toContain(`[hooks.state."${hooksPath}:stop:1:0"]`)
  })

  it('Round 4 Item 5: Quoted and dotted assignments survive inside the retained Jerico table without scope leakage', async () => {
    await assertHookBlock('codex')

    let configContent = await fs.readFile(configPath, 'utf-8')
    const jericoHeader = `[hooks.state."${hooksPath}:stop:1:0"]`
    const jericoHashMatch = configContent.match(/trusted_hash = "([^"]+)"/)
    const jericoHash = jericoHashMatch ? jericoHashMatch[1] : ''

    const tomlWithQuotedKeys = configContent.replace(
      `trusted_hash = "${jericoHash}"`,
      `trusted_hash = "${jericoHash}"\n"custom key" = 1\ndotted.setting = "value"`
    )
    await fs.writeFile(configPath, tomlWithQuotedKeys, 'utf-8')

    const { content: stripped } = stripBlock('codex', await fs.readFile(hooksPath, 'utf-8'))
    await fs.writeFile(hooksPath, stripped, 'utf-8')
    await seedCodexTrust(hooksPath)

    const finalConfig = await fs.readFile(configPath, 'utf-8')
    const parsed: any = parseToml(finalConfig)

    expect(parsed['custom key']).toBeUndefined()
    expect(parsed['dotted']).toBeUndefined()
    expect(finalConfig).toContain('"custom key" = 1')
  })

  it('Round 4 Item 6: Inline comment on trusted_hash is preserved after trust update', async () => {
    await assertHookBlock('codex')

    let configContent = await fs.readFile(configPath, 'utf-8')
    const tomlWithInlineComment = configContent.replace(
      /trusted_hash = "[^"]+"/,
      'trusted_hash = "sha256:oldhash" # KEEP_COMMENT'
    )
    await fs.writeFile(configPath, tomlWithInlineComment, 'utf-8')

    await seedCodexTrust(hooksPath)

    const updatedConfig = await fs.readFile(configPath, 'utf-8')
    expect(updatedConfig).toContain('# KEEP_COMMENT')
    expect(updatedConfig).toMatch(/trusted_hash = "sha256:[a-f0-9]{64}" # KEEP_COMMENT/)
  })

  /* ---------------- Round 5 Item 3: Byte-Identity Test ---------------- */

  it('Round 5 Item 3: Byte-identity test: foreign config.toml with multiple foreign sections, comments, and blank lines remains 100% byte-exact when we own nothing, and after install-then-uninstall', async () => {
    const complexForeignToml = `# Global Settings
approval_mode = "approve"
model = "gpt-5"

[hooks.state."${hooksPath}:stop:0:0"]
# Note on foreign section
trusted_hash = "sha256:foreign_othertool_hash"
enabled = true

[other.section]
setting = 123
`
    await fs.writeFile(configPath, complexForeignToml, 'utf-8')

    await seedCodexTrust(hooksPath)
    let currentConfig = await fs.readFile(configPath, 'utf-8')
    expect(currentConfig).toBe(complexForeignToml)

    await assertHookBlock('codex')
    currentConfig = await fs.readFile(configPath, 'utf-8')
    expect(currentConfig).toContain(`[hooks.state."${hooksPath}:stop:1:0"]`)

    await removeHookBlock('codex')
    currentConfig = await fs.readFile(configPath, 'utf-8')
    expect(currentConfig).toBe(complexForeignToml)
  })

  /* ---------------- Round 6 Tests ---------------- */

  it('Round 6 Item 1: Mixed handler group in hooks.json — spliceCodexBlock and stripCodexBlock operate at handler granularity', async () => {
    const mixedGroupJson = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: '.*',
            hooks: [
              {
                type: 'command',
                command: '/opt/othertool/stop.cjs'
              },
              {
                type: 'command',
                command: `JERICO_AGENT_HOOK=1 "/old/script/jerico-hook.sh"`
              }
            ]
          }
        ]
      }
    }, null, 2) + '\n'

    const { content: spliced } = spliceBlock('codex', mixedGroupJson)
    const parsedSpliced = JSON.parse(spliced)

    expect(parsedSpliced.hooks.Stop).toHaveLength(1)
    expect(parsedSpliced.hooks.Stop[0].matcher).toBe('.*')
    expect(parsedSpliced.hooks.Stop[0].hooks).toHaveLength(2)
    expect(parsedSpliced.hooks.Stop[0].hooks[0].command).toBe('/opt/othertool/stop.cjs')
    expect(parsedSpliced.hooks.Stop[0].hooks[1].command).toContain('jerico-hook.sh')

    const { content: stripped } = stripBlock('codex', spliced)
    const parsedStripped = JSON.parse(stripped)

    expect(parsedStripped.hooks.Stop).toHaveLength(1)
    expect(parsedStripped.hooks.Stop[0].matcher).toBe('.*')
    expect(parsedStripped.hooks.Stop[0].hooks).toHaveLength(1)
    expect(parsedStripped.hooks.Stop[0].hooks[0].command).toBe('/opt/othertool/stop.cjs')
  })

  it('Round 6 Item 2: Ledger loss plus script path change — knownPreviousHashes prunes stale trust from config.toml on uninstall', async () => {
    const scriptA = path.join(tempDir, 'scriptA', 'jerico-hook.sh')
    await fs.mkdir(path.dirname(scriptA), { recursive: true })
    await fs.writeFile(scriptA, '#!/bin/sh\n', { mode: 0o755 })
    process.env.JERICO_HOOK_SCRIPT_PATH_OVERRIDE = scriptA

    await assertHookBlock('codex')
    let configContent = await fs.readFile(configPath, 'utf-8')
    expect(configContent).toContain(`[hooks.state."${hooksPath}:stop:1:0"]`)

    try {
      await fs.unlink(ledgerPath)
    } catch {}

    const scriptB = path.join(tempDir, 'scriptB', 'jerico-hook.sh')
    await fs.mkdir(path.dirname(scriptB), { recursive: true })
    await fs.writeFile(scriptB, '#!/bin/sh\n', { mode: 0o755 })
    process.env.JERICO_HOOK_SCRIPT_PATH_OVERRIDE = scriptB

    await removeHookBlock('codex')

    configContent = await fs.readFile(configPath, 'utf-8')
    expect(configContent).not.toContain(`[hooks.state."${hooksPath}:stop:1:0"]`)
  })

  /* ---------------- Round 7 Tests ---------------- */

  it('Round 7 Item 1 Shape 1: Duplicate owned handlers in same group (Stop[0].hooks = [canonical, foreign, canonical]) are deduplicated', () => {
    const canonicalCommand = `JERICO_AGENT_HOOK=1 "${hookScriptPath()}"`
    const duplicateJson = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: canonicalCommand, timeout: 2 },
              { type: 'command', command: '/opt/othertool/stop.cjs' },
              { type: 'command', command: canonicalCommand, timeout: 2 }
            ]
          }
        ]
      }
    })

    const { content: spliced, status } = spliceBlock('codex', duplicateJson)
    expect(status).toBe('installed')

    const parsed = JSON.parse(spliced)
    expect(parsed.hooks.Stop[0].hooks).toHaveLength(2)
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(canonicalCommand)
    expect(parsed.hooks.Stop[0].hooks[1].command).toBe('/opt/othertool/stop.cjs')
  })

  it('Round 7 Item 1 Shape 2: Duplicate owned handlers in separate groups (Stop[0].hooks = [canonical], Stop[1].hooks = [ours]) are deduplicated', () => {
    const canonicalCommand = `JERICO_AGENT_HOOK=1 "${hookScriptPath()}"`
    const separateGroupJson = JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: canonicalCommand, timeout: 2 }] },
          { hooks: [{ type: 'command', command: `JERICO_AGENT_HOOK=1 "/tmp/old/jerico-hook.sh"`, timeout: 2 }] }
        ]
      }
    })

    const { content: spliced, status } = spliceBlock('codex', separateGroupJson)
    expect(status).toBe('installed')

    const parsed = JSON.parse(spliced)
    expect(parsed.hooks.Stop).toHaveLength(1)
    expect(parsed.hooks.Stop[0].hooks).toHaveLength(1)
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(canonicalCommand)
  })

  it('Round 7 Item 2 Case 1: Uninstall leaves foreign empty groups (Stop[0] = { matcher: "EMPTY-MATCHER", hooks: [] }, Stop[1] = { hooks: [] }) intact', () => {
    const canonicalCommand = `JERICO_AGENT_HOOK=1 "${hookScriptPath()}"`
    const foreignEmptyGroupJson = JSON.stringify({
      hooks: {
        Stop: [
          { matcher: 'EMPTY-MATCHER', hooks: [] },
          { hooks: [] },
          { hooks: [{ type: 'command', command: canonicalCommand, timeout: 2 }] }
        ]
      }
    })

    const { content: stripped, status } = stripBlock('codex', foreignEmptyGroupJson)
    expect(status).toBe('installed')

    const parsed = JSON.parse(stripped)
    expect(parsed.hooks.Stop).toHaveLength(2)
    expect(parsed.hooks.Stop[0].matcher).toBe('EMPTY-MATCHER')
    expect(parsed.hooks.Stop[0].hooks).toEqual([])
    expect(parsed.hooks.Stop[1].hooks).toEqual([])
  })

  it('Round 7 Item 2 Case 2: Group carrying matcher MISSING gains hooks on install and preserves group and matcher on uninstall', () => {
    const missingHooksJson = JSON.stringify({
      hooks: {
        Stop: [
          { matcher: 'MISSING' }
        ]
      }
    })

    const { content: spliced } = spliceBlock('codex', missingHooksJson)
    const { content: stripped } = stripBlock('codex', spliced)

    const parsed = JSON.parse(stripped)
    expect(parsed.hooks.Stop).toHaveLength(1)
    expect(parsed.hooks.Stop[0].matcher).toBe('MISSING')
  })

  it('Round 7 Item 2 Case 3: Owned-only group carrying unusual matcher and extra properties preserves matcher and extra properties on uninstall', () => {
    const canonicalCommand = `JERICO_AGENT_HOOK=1 "${hookScriptPath()}"`
    const unusualGroupJson = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: 'UNUSUAL',
            extra: 'KEEP',
            hooks: [{ type: 'command', command: canonicalCommand, timeout: 2 }]
          }
        ]
      }
    })

    const { content: stripped } = stripBlock('codex', unusualGroupJson)
    const parsed = JSON.parse(stripped)

    expect(parsed.hooks.Stop).toHaveLength(1)
    expect(parsed.hooks.Stop[0].matcher).toBe('UNUSUAL')
    expect(parsed.hooks.Stop[0].extra).toBe('KEEP')
    expect(parsed.hooks.Stop[0].hooks).toEqual([])
  })

  it('Round 7 Item 3: Round trip byte identity across all 4 line-ending shapes (LF, CRLF, comment, no-final-newline)', async () => {
    const shapes: Array<[string, string]> = [
      ['ends with LF', 'model = "gpt-5"\n'],
      ['ends with CRLF', 'model = "gpt-5"\r\n'],
      ['trailing comment', 'model = "gpt-5"\n# keep\n'],
      ['no final newline', 'model = "gpt-5"']
    ]

    for (const [name, original] of shapes) {
      await fs.writeFile(configPath, original, 'utf-8')
      await fs.writeFile(hooksPath, JSON.stringify({ hooks: {} }, null, 2), 'utf-8')

      await assertHookBlock('codex')
      await removeHookBlock('codex')

      const after = await fs.readFile(configPath, 'utf-8')
      expect(after).toBe(original)
    }
  })

  it('Round 8 Item 1: Separator marker lost before uninstall — ledger remembers insertedSep and preserves config.toml byte-for-byte', async () => {
    const original = 'model = "gpt-5"'
    await fs.writeFile(configPath, original, 'utf-8')
    await fs.writeFile(hooksPath, JSON.stringify({ hooks: {} }, null, 2), 'utf-8')

    await assertHookBlock('codex')

    const installed = await fs.readFile(configPath, 'utf-8')
    const stripped = installed.replace(/[ \t]*# jerico_sep=1/g, '')
    expect(stripped).not.toBe(installed)
    await fs.writeFile(configPath, stripped, 'utf-8')

    await removeHookBlock('codex')

    const after = await fs.readFile(configPath, 'utf-8')
    expect(after).toBe(original)
  })

  /* ---------------- Round 9 Tests ---------------- */

  it('Round 9 Item 1: removal requires a readable trusted_hash equal to the ledger claim', () => {
    const key = '/tmp/hooks.json:stop:0:0'
    const header = `[hooks.state."${key}"]\n`
    const shapes = [
      `${header}user_added = "missing"\n`,
      `${header}trusted_hash = 42\nuser_added = "numeric"\n`,
      `${header}trusted_hash = 'sha256:single-quoted'\nuser_added = "single"\n`
    ]

    for (const original of shapes) {
      const after = updateTomlTrustState(original, [], [
        { key, seededHash: 'sha256:ledger-owned' }
      ])
      expect(after).toBe(original)
    }
  })

  it('Round 9 Item 2: separator removal is suffix-aware and evaluates owned removals right-to-left', () => {
    const original = 'model = "gpt-5"'
    const firstKey = '/tmp/hooks.json:stop:0:0'
    const secondKey = '/tmp/hooks.json:stop:1:0'
    const twoOwnedTables = `${original}\n[hooks.state."${firstKey}"] # jerico_sep=1\ntrusted_hash = "sha256:first"\n[hooks.state."${secondKey}"]\ntrusted_hash = "sha256:second"\n`

    const roundTrip = updateTomlTrustState(twoOwnedTables, [], [
      { key: firstKey, seededHash: 'sha256:first', insertedSep: true },
      { key: secondKey, seededHash: 'sha256:second', insertedSep: false }
    ])
    expect(roundTrip).toBe(original)

    const foreignSuffix = '[foreign]\nvalue = "keep"\n'
    const withForeignSuffix = `${original}\n[hooks.state."${firstKey}"] # jerico_sep=1\ntrusted_hash = "sha256:first"\n${foreignSuffix}`
    const afterForeign = updateTomlTrustState(withForeignSuffix, [], [
      { key: firstKey, seededHash: 'sha256:first', insertedSep: true }
    ])
    expect(afterForeign).toBe(`${original}\n${foreignSuffix}`)
  })

  it('Round 9 Item 3: install refuses an unreadable foreign trusted_hash without appending a duplicate', async () => {
    const shapes: Array<[string, string, number]> = [
      ['missing', '', 0],
      ['numeric', 'trusted_hash = 42', 1],
      ['single-quoted', "trusted_hash = 'sha256:foreign'", 1]
    ]

    for (const [_name, replacement, expectedAssignments] of shapes) {
      await fs.writeFile(hooksPath, foreignCodexFixture, 'utf-8')
      await fs.rm(configPath, { force: true })
      await fs.rm(ledgerPath, { force: true })
      await assertHookBlock('codex')

      const installed = await fs.readFile(configPath, 'utf-8')
      const foreign = installed.replace(
        /^[ \t]*trusted_hash[ \t]*=[^\r\n]*/m,
        replacement
      )
      await fs.writeFile(configPath, foreign, 'utf-8')

      let installError: unknown
      try {
        await seedCodexTrust(hooksPath)
      } catch (err) {
        installError = err
      }

      expect(String(installError)).toContain('refusing to claim existing hooks.state table')
      const after = await fs.readFile(configPath, 'utf-8')
      expect(after).toBe(foreign)
      expect(after.match(/^[ \t]*trusted_hash[ \t]*=/gm) ?? []).toHaveLength(expectedAssignments)
    }
  })

  /* ---------------- Round 10 Tests ---------------- */

  it('Round 10 Requirement 1: uninstall removes only seeded TOML bytes and preserves foreign table content', async () => {
    const original = 'user_root_key = "hello"\n'
    await fs.writeFile(configPath, original, 'utf-8')
    await fs.writeFile(hooksPath, JSON.stringify({ hooks: {} }, null, 2), 'utf-8')

    await assertHookBlock('codex')
    await fs.appendFile(configPath, 'another_user_key = "world"\n# user note\n', 'utf-8')

    await removeHookBlock('codex')

    expect(await fs.readFile(configPath, 'utf-8')).toBe(
      `${original}[hooks.state."${hooksPath}:stop:0:0"]\nanother_user_key = "world"\n# user note\n`
    )
  })

  it('Round 10 Requirement 2: quoted keys and multiline strings cannot create decoy table spans', () => {
    const key = '/tmp/hooks.json:stop:0:0'
    const hash = 'sha256:owned'
    const decoys = [
      `"#"="""\n[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n#"""\n`,
      `'#'='''\n[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n#'''\n`
    ]

    for (const decoy of decoys) {
      const real = `[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n`
      const content = decoy + real
      const spans = findTomlStateSpans(content)
      expect(spans).toHaveLength(1)
      expect(spans[0]?.start).toBe(decoy.length)
      expect(updateTomlTrustState(content, [], [{ key, seededHash: hash }])).toBe(decoy)
    }
  })

  it('Round 10 Requirement 3: an arbitrary ledger hash cannot authorize TOML removal', async () => {
    await fs.writeFile(hooksPath, '{"hooks":{}}\n', 'utf-8')
    const key = `${hooksPath}:stop:0:0`
    const foreign = `[hooks.state."${key}"]\ntrusted_hash = "user-hash"\nuser_key = 1\n`
    await fs.writeFile(configPath, foreign, 'utf-8')
    await fs.writeFile(ledgerPath, JSON.stringify({
      keys: [{ key, seededHash: 'user-hash' }]
    }), 'utf-8')

    await removeHookBlock('codex')

    expect(await fs.readFile(configPath, 'utf-8')).toBe(foreign)
  })

  /* ---------------- Round 11 Regression Tests ---------------- */

  it('Round 11 Requirement 1: install reclaims our retained header when trusted_hash is absent', async () => {
    await assertHookBlock('codex')
    await fs.appendFile(configPath, 'user_key = "keep"\n', 'utf-8')
    await removeHookBlock('codex')

    const retained = await fs.readFile(configPath, 'utf-8')
    expect(retained).toContain('[hooks.state.')
    expect(retained).not.toContain('trusted_hash')

    await assertHookBlock('codex')

    const reinstalled = await fs.readFile(configPath, 'utf-8')
    expect(reinstalled).toContain('user_key = "keep"')
    expect(reinstalled).toMatch(/trusted_hash = "sha256:[a-f0-9]{64}"/)
  })

  it('Round 11 Requirement 2: trailing comments and blank lines retain the table header', () => {
    const key = '/tmp/hooks.json:stop:0:0'
    const hash = `sha256:${'b'.repeat(64)}`
    const original = `[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n\n# foreign comment\n`

    expect(updateTomlTrustState(original, [], [{ key, seededHash: hash }])).toBe(
      `[hooks.state."${key}"]\n\n# foreign comment\n`
    )

    const interTableComment = `[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n# next table note\n[next]\nvalue = 1\n`
    expect(updateTomlTrustState(interTableComment, [], [{ key, seededHash: hash }])).toBe(
      '# next table note\n[next]\nvalue = 1\n'
    )
  })

  it('Round 11 Requirement 3: a canonically shaped stale seeded hash remains removable', async () => {
    const oldScript = path.join(tempDir, 'old', 'jerico-hook.sh')
    const newScript = path.join(tempDir, 'new', 'jerico-hook.sh')
    for (const script of [oldScript, newScript]) {
      await fs.mkdir(path.dirname(script), { recursive: true })
      await fs.writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }

    process.env.JERICO_HOOK_SCRIPT_PATH_OVERRIDE = oldScript
    await assertHookBlock('codex')
    expect(await fs.readFile(configPath, 'utf-8')).toMatch(/trusted_hash = "sha256:[a-f0-9]{64}"/)

    await fs.writeFile(hooksPath, '{"hooks":{}}\n', 'utf-8')
    process.env.JERICO_HOOK_SCRIPT_PATH_OVERRIDE = newScript
    await removeHookBlock('codex')

    expect(await fs.readFile(configPath, 'utf-8')).toBe('')
  })

  /* ---------------- Round 13 Phase 1 Regression Tests ---------------- */

  it('Round 13 V1: uninstall preserves a user suffix appended to our trusted_hash line', async () => {
    await fs.writeFile(hooksPath, JSON.stringify({ hooks: {} }, null, 2), 'utf-8')
    await assertHookBlock('codex')

    const installed = await fs.readFile(configPath, 'utf-8')
    const header = installed.match(/^\[hooks\.state\."[^"]+"\].*$/m)?.[0]
    expect(header).toBeDefined()
    const withUserSuffix = installed.replace(
      /^(trusted_hash = "sha256:[a-f0-9]{64}")$/m,
      '$1 # KEEP_MINE'
    )
    expect(withUserSuffix).not.toBe(installed)
    await fs.writeFile(configPath, withUserSuffix, 'utf-8')

    await removeHookBlock('codex')

    expect(await fs.readFile(configPath, 'utf-8')).toBe(`${header}\n # KEEP_MINE\n`)
  })

  it('Round 13 V4: an unrelated ledger entry does not suppress fallback for this target', async () => {
    const expectedHash = computeCodexHookHash('Stop', undefined, {
      type: 'command',
      command: `JERICO_AGENT_HOOK=1 "${hookScriptPath()}"`,
      timeout: 2
    })
    const key = `${hooksPath}:stop:0:0`
    await fs.writeFile(hooksPath, '{"hooks":{}}\n', 'utf-8')
    await fs.writeFile(
      configPath,
      `[hooks.state."${key}"]\ntrusted_hash = "${expectedHash}"\n`,
      'utf-8'
    )
    await fs.writeFile(ledgerPath, JSON.stringify({
      keys: [{
        key: '/another/target/hooks.json:stop:0:0',
        seededHash: `sha256:${'a'.repeat(64)}`
      }]
    }), 'utf-8')

    await removeHookBlock('codex')

    expect(await fs.readFile(configPath, 'utf-8')).toBe('')
  })

  it('getHookConfig(codex) observes present_ok after installation', async () => {
    expect(getHookConfig('codex')).toBe('absent')
    await assertHookBlock('codex')
    expect(getHookConfig('codex')).toBe('present_ok')
    await removeHookBlock('codex')
    expect(getHookConfig('codex')).toBe('absent')
  })

  /* ---------------- R52 Codex Parity Tests ---------------- */

  /* --- Test 6. Catches pre-change packages/daemon/src/hooks/block.ts:724.
     Before change: codex lacked `seedWhenMissing`, so assertHookBlock('codex') on an absent hooks.json
     returned `target-missing` and never created the file or seeded hash trust in config.toml. --- */
  it('6. hooks.json absent -> created 0600, spliced, and seedCodexTrust leaves a matching trusted hash in the override config.toml', async () => {
    // Ensure hooks.json and config.toml do not exist
    await fs.rm(hooksPath, { force: true })
    await fs.rm(configPath, { force: true })
    await fs.rm(ledgerPath, { force: true })

    expect(await assertHookBlock('codex')).toBe('installed')

    // hooks.json must be created with mode 0600
    const hooksStat = await fs.stat(hooksPath)
    expect(hooksStat.mode & 0o777).toBe(0o600)

    // hooks.json must contain spliced Jerico Stop hook
    const hooksContent = await fs.readFile(hooksPath, 'utf-8')
    const parsedHooks = JSON.parse(hooksContent)
    expect(parsedHooks.hooks.Stop).toHaveLength(1)
    expect(parsedHooks.hooks.Stop[0].hooks[0].command).toContain('JERICO_AGENT_HOOK=1')

    // config.toml must contain the trusted_hash for the newly seeded hook
    const configContent = await fs.readFile(configPath, 'utf-8')
    const expectedHash = computeCodexHookHash('Stop', undefined, {
      type: 'command',
      command: `JERICO_AGENT_HOOK=1 "${hookScriptPath()}"`,
      timeout: 2
    })
    expect(configContent).toContain(`[hooks.state."${hooksPath}:stop:0:0"]`)
    expect(configContent).toContain(`trusted_hash = "${expectedHash}"`)

    // Idempotency: second install returns already-present
    expect(await assertHookBlock('codex')).toBe('already-present')
    expect(getHookConfig('codex')).toBe('present_ok')

    // Uninstall removes our hook and leaves Stop empty, removing hash from config.toml
    expect(await removeHookBlock('codex')).toBe('installed')
    const finalHooksContent = await fs.readFile(hooksPath, 'utf-8')
    expect(JSON.parse(finalHooksContent)).toEqual({ hooks: { Stop: [] } })
    const finalConfig = await fs.readFile(configPath, 'utf-8')
    expect(finalConfig).not.toContain(`[hooks.state."${hooksPath}:stop:0:0"]`)
    expect(getHookConfig('codex')).toBe('absent')

  })

  /* --- Test 7. Foreign-tool coexistence with real foreign-tool fixture shape.
     Proves splice appends alongside foreign-tool's handler under hooks.Stop, and strip removes ONLY ours,
     leaving foreign-tool's handler and the file byte-for-byte identical. --- */
  it('7. Foreign-tool coexistence, using the real foreign-tool fixture shape: handler appended, theirs untouched; strip removes only ours and leaves theirs byte-identical', async () => {
    // 1. Pure splice/strip memory test on exact fixture
    const { content: spliced, status: spliceStatus } = spliceBlock('codex', foreignCodexFixture)
    expect(spliceStatus).toBe('installed')

    const parsedSpliced = JSON.parse(spliced)
    expect(parsedSpliced.hooks.PreToolUse).toEqual(JSON.parse(foreignCodexFixture).hooks.PreToolUse)
    expect(parsedSpliced.hooks.SessionStart).toEqual(JSON.parse(foreignCodexFixture).hooks.SessionStart)
    expect(parsedSpliced.hooks.PermissionRequest).toEqual(JSON.parse(foreignCodexFixture).hooks.PermissionRequest)
    expect(parsedSpliced.hooks.Stop).toHaveLength(2)
    expect(parsedSpliced.hooks.Stop[0].hooks[0].command).toContain('othertool-external')
    expect(parsedSpliced.hooks.Stop[1].hooks[0].command).toContain('JERICO_AGENT_HOOK=1')

    const { content: stripped, status: stripStatus } = stripBlock('codex', spliced)
    expect(stripStatus).toBe('installed')
    expect(stripped).toBe(foreignCodexFixture)

    // 2. Full end-to-end disk install/remove round trip with config.toml trust management
    await fs.writeFile(hooksPath, foreignCodexFixture, 'utf-8')
    expect(await assertHookBlock('codex')).toBe('installed')

    const diskConfig = await fs.readFile(configPath, 'utf-8')
    expect(diskConfig).toContain(`[hooks.state."${hooksPath}:stop:1:0"]`)

    expect(await removeHookBlock('codex')).toBe('installed')
    const diskHooksAfter = await fs.readFile(hooksPath, 'utf-8')
    expect(diskHooksAfter).toBe(foreignCodexFixture)

    const diskConfigAfter = await fs.readFile(configPath, 'utf-8')
    expect(diskConfigAfter).not.toContain(`${hooksPath}:stop:1:0`)
  })

  /* --- Test 8. Guards narrow scope: claude and kimi must NOT have seedWhenMissing and still return target-missing.
     Catches that claude (block.ts:701) and kimi (block.ts:712) target registrations stay narrow. --- */
  it('8. claude and kimi still return target-missing for an absent target file and create nothing', async () => {
    const claudePath = path.join(tempDir, 'claude-missing', 'settings.json')
    const savedClaude = process.env.JERICO_CLAUDE_SETTINGS_PATH
    process.env.JERICO_CLAUDE_SETTINGS_PATH = claudePath
    try {
      expect(await assertHookBlock('claude')).toBe('target-missing')
      await expect(fs.access(claudePath)).rejects.toThrow()
      await expect(fs.access(path.dirname(claudePath))).rejects.toThrow()
    } finally {
      if (savedClaude === undefined) delete process.env.JERICO_CLAUDE_SETTINGS_PATH
      else process.env.JERICO_CLAUDE_SETTINGS_PATH = savedClaude
    }

    const kimiPath = path.join(tempDir, 'kimi-missing', 'config.toml')
    const savedHome = process.env.HOME
    process.env.HOME = path.join(tempDir, 'kimi-missing')
    try {
      expect(await assertHookBlock('kimi')).toBe('target-missing')
      await expect(fs.access(kimiPath)).rejects.toThrow()
    } finally {
      process.env.HOME = savedHome
    }
  })
})

