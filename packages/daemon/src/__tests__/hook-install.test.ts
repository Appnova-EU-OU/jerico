import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { assertHookBlock, removeHookBlock, getTargetFile } from '../hooks/install.js'
import { findBlock, HOOK_MARKER, renderBlock } from '../hooks/block.js'
import { randomBytes } from 'crypto'
import { promises as fs } from 'node:fs'
import path from 'path'
import os from 'os'
import { HOOK_TARGETS, getHookTargetEntry } from '../hooks/targets.js'

const fixtureString = `{
  "model": "opus[1m]",
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "UCES_EVENT=Stop bash ~/.claude/hooks/memory.sh",
            "timeout": 2
          }
        ]
      }
    ]
  }
}
`

describe('hook-install', () => {
  let tempDir: string
  let targetPath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jerico-test-'))
    targetPath = path.join(tempDir, 'settings.json')
    process.env.JERICO_CLAUDE_SETTINGS_PATH = targetPath
    
    // Write normalized fixture so round-trip comparison is byte-identical
    const normalizedFixture = JSON.stringify(JSON.parse(fixtureString), null, 2) + '\n'
    await fs.writeFile(targetPath, normalizedFixture, { mode: 0o644 })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    delete process.env.JERICO_CLAUDE_SETTINGS_PATH
  })

  it('It lands on disk', async () => {
    await assertHookBlock('claude')
    const content = await fs.readFile(targetPath, 'utf-8')
    const parsed = JSON.parse(content)
    expect(findBlock('claude', content)).not.toBeNull()
  })

  it('Round trip on disk is byte-identical', async () => {
    const originalBytes = await fs.readFile(targetPath)
    await assertHookBlock('claude')
    await removeHookBlock('claude')
    const finalBytes = await fs.readFile(targetPath)
    expect(finalBytes.equals(originalBytes)).toBe(true)
  })

  it('Idempotent on disk', async () => {
    await assertHookBlock('claude')
    const firstWriteBytes = await fs.readFile(targetPath)
    
    await assertHookBlock('claude')
    const secondWriteBytes = await fs.readFile(targetPath)
    
    expect(secondWriteBytes.equals(firstWriteBytes)).toBe(true)
    
    const content = await fs.readFile(targetPath, 'utf-8')
    const parsed = JSON.parse(content)
    let blockCount = 0
    for (const group of parsed.hooks.Stop) {
      for (const h of group.hooks) {
        if (h.command && h.command.includes('JERICO_AGENT_HOOK=1')) {
          blockCount++
        }
      }
    }
    expect(blockCount).toBe(1)
  })

  it('Refusal writes nothing', async () => {
    const invalidJson = 'invalid json {['
    await fs.writeFile(targetPath, invalidJson)
    const initialStat = await fs.stat(targetPath)
    
    // Wait a tiny bit so mtime would theoretically change
    await new Promise(r => setTimeout(r, 10))
    
    await assertHookBlock('claude')
    
    const finalStat = await fs.stat(targetPath)
    const finalContent = await fs.readFile(targetPath, 'utf-8')
    
    expect(finalContent).toBe(invalidJson)
    expect(finalStat.mtimeMs).toBe(initialStat.mtimeMs)
  })

  it('Mode and ownership', async () => {
    // Initial is 0644 from beforeEach
    await assertHookBlock('claude')
    const stat = await fs.stat(targetPath)
    expect(stat.mode & 0o777).toBe(0o644)
    
    // Test with 0600
    await fs.chmod(targetPath, 0o600)
    await assertHookBlock('claude')
    const stat2 = await fs.stat(targetPath)
    expect(stat2.mode & 0o777).toBe(0o600)
  })

  it('Concurrency', async () => {
    // Two assertHookBlock calls racing
    const p1 = assertHookBlock('claude')
    const p2 = assertHookBlock('claude')
    
    await Promise.all([p1, p2])
    
    const content = await fs.readFile(targetPath, 'utf-8')
    const parsed = JSON.parse(content)
    let blockCount = 0
    for (const group of parsed.hooks.Stop) {
      for (const h of group.hooks) {
        if (h.command && h.command.includes('JERICO_AGENT_HOOK=1')) {
          blockCount++
        }
      }
    }
    expect(blockCount).toBe(1)
  })

  it('No partial file at the target path', async () => {
    const originalContent = await fs.readFile(targetPath, 'utf-8')
    
    // Mock fs.rename to throw an error
    const originalRename = fs.rename
    fs.rename = async () => {
      throw new Error('Simulated rename failure')
    }
    
    try {
      await assertHookBlock('claude')
    } catch (e: any) {
      expect(e.message).toBe('Simulated rename failure')
    } finally {
      // Restore original rename
      fs.rename = originalRename
    }
    
    const finalContent = await fs.readFile(targetPath, 'utf-8')
    expect(finalContent).toBe(originalContent)
    expect(() => JSON.parse(finalContent)).not.toThrow()
  })

  describe('F3 - Enforcement', () => {
    let hooksDir: string
    let originalHome: string | undefined

    beforeEach(async () => {
      // Point HOME at tempDir so getGlobalHooksDir() uses it
      originalHome = process.env['HOME']
      process.env['HOME'] = tempDir
      hooksDir = path.join(tempDir, '.jerico', 'hooks')
      await fs.mkdir(hooksDir, { recursive: true })
    })

    afterEach(() => {
      if (originalHome !== undefined) {
        process.env['HOME'] = originalHome
      } else {
        delete process.env['HOME']
      }
    })


    it('hooks dir unwritable so the script cannot be created -> returns refused-invalid-script and does not modify target', async () => {
      // ensureHookScript() runs unconditionally at the top of assertHookBlock, so a
      // genuinely absent script is unreachable in production — it would just be written.
      // The reachable path to refused-missing-script is an unwritable hooks dir, which is
      // what this exercises. Naming it "script absent" would describe a state that cannot occur.
      await fs.chmod(hooksDir, 0o555)
      const originalBytes = await fs.readFile(targetPath)
      const res = await assertHookBlock('claude')
      expect(res).toBe('refused-invalid-script')
      const finalBytes = await fs.readFile(targetPath)
      expect(finalBytes.equals(originalBytes)).toBe(true)
      await fs.chmod(hooksDir, 0o777) // cleanup
    })

    it('script present but mode 0o644 -> returns refused-invalid-script', async () => {
      const scriptPath = path.join(hooksDir, 'jerico-hook.sh')
      await fs.writeFile(scriptPath, 'something', { mode: 0o644 })
      
      const res = await assertHookBlock('claude')
      expect(res).toBe('refused-invalid-script')
    })

    it('script present but content differs -> staleness refresh happens', async () => {
      const scriptPath = path.join(hooksDir, 'jerico-hook.sh')
      await fs.writeFile(scriptPath, 'old content', { mode: 0o755 })
      
      await assertHookBlock('claude')
      
      const { HOOK_SCRIPT_V1 } = await import('../hooks/script.js')
      const finalContent = await fs.readFile(scriptPath, 'utf-8')
      expect(finalContent).toBe(HOOK_SCRIPT_V1)
    })

    it('script present and equal -> file is NOT rewritten', async () => {
      const scriptPath = path.join(hooksDir, 'jerico-hook.sh')
      const { HOOK_SCRIPT_V1 } = await import('../hooks/script.js')
      await fs.writeFile(scriptPath, HOOK_SCRIPT_V1, { mode: 0o755 })
      
      // Wait to ensure mtime would be different if written
      await new Promise(r => setTimeout(r, 10))
      const statBefore = await fs.stat(scriptPath)
      
      await assertHookBlock('claude')
      
      const statAfter = await fs.stat(scriptPath)
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs)
    })

    it('a thrown installer error records installer-threw refusal state, not target-missing', async () => {
      const stateModule = await import('../hooks/state.js')
      const { recordHookInstallFailure } = await import('../ws/client.js')

      try {
        recordHookInstallFailure(new Error('EACCES: permission denied'))

        expect(stateModule.lastHookInstallRefusal?.status).toBe('installer-threw')
        expect(stateModule.lastHookInstallRefusal?.status).not.toBe('target-missing')
      } finally {
        stateModule.setHookInstallRefusal(null)
      }
    })
  })
})

describe('dark Kimi installer', () => {
  let tempDir: string
  let originalHome: string | undefined
  let originalKimiHome: string | undefined

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jerico-kimi-test-'))
    originalHome = process.env.HOME
    originalKimiHome = process.env.KIMI_CODE_HOME
    process.env.HOME = tempDir
    process.env.KIMI_CODE_HOME = path.join(tempDir, 'panel-kimi-home')
    await fs.mkdir(process.env.KIMI_CODE_HOME, { recursive: true })
    await fs.mkdir(path.join(tempDir, '.kimi-code'), { recursive: true })
    await fs.writeFile(path.join(tempDir, '.kimi-code', 'config.toml'), 'default_model = "kimi-for-coding"\n')
  })

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalKimiHome === undefined) delete process.env.KIMI_CODE_HOME
    else process.env.KIMI_CODE_HOME = originalKimiHome
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('ignores the per-panel KIMI_CODE_HOME and edits the real global config byte-identically', async () => {
    const target = path.join(tempDir, '.kimi-code', 'config.toml')
    const before = await fs.readFile(target)
    expect(getTargetFile('kimi')).toBe(target)
    expect(await assertHookBlock('kimi')).toBe('installed')
    expect(findBlock('kimi', await fs.readFile(target, 'utf8'))).not.toBeNull()
    expect(await removeHookBlock('kimi')).toBe('installed')
    expect((await fs.readFile(target)).equals(before)).toBe(true)
  })

  it('refuses a config.toml symlink that escapes the real Kimi home', async () => {
    const target = path.join(tempDir, '.kimi-code', 'config.toml')
    const outside = path.join(tempDir, 'outside.toml')
    await fs.writeFile(outside, 'foreign = true\n')
    await fs.unlink(target)
    await fs.symlink(outside, target)

    expect(await assertHookBlock('kimi')).toBe('refused-unsafe-target')
    expect(await fs.readFile(outside, 'utf8')).toBe('foreign = true\n')
  })

  // This replaced a temporary assertion that HOOK_TARGETS was claude-only, which existed to stop
  // kimi being enabled before its gate was met. The gate was met on 2026-08-23: a hook fired from a
  // daemon-spawned PTY panel and agents.last_hook_callback_at went NULL -> a timestamp within ten
  // seconds, corroborated by hook.turn_ended.accepted for that same panel. Pinning the old list
  // would now assert something false, so it is replaced by the property that does not expire —
  // every ENABLED target must actually be installable. Enabling an agent whose installer throws is
  // the failure this guards, and it is the shape this repo keeps producing: a target list that
  // reaches code which cannot serve it.
  it('every enabled target can render its install artifact and resolve a target file', () => {
    expect(HOOK_TARGETS.length).toBeGreaterThan(0)
    for (const target of HOOK_TARGETS) {
      const entry = getHookTargetEntry(target)
      expect(entry).toBeDefined()
      if (entry?.installKind === 'config-block') {
        expect(() => renderBlock(target)).not.toThrow()
        expect(JSON.stringify(renderBlock(target))).toContain(HOOK_MARKER)
      } else {
        expect(entry?.renderFile()).toContain('BRIDGE_HOOK_DESCRIPTOR')
      }
      expect(() => getTargetFile(target)).not.toThrow()
      expect(getTargetFile(target)).toMatch(/^\//)
    }
  })
})

describe('a successful hook install clears that target\'s stale refusal', () => {
  // Pre-change, ws/client.ts had no `else` on the assertHookBlock result, so a
  // refusal recorded by one panel outlived the fix and painted every later
  // panel of that agent red for the rest of the daemon's life. state.ts:27
  // (`if (!isRefusal(status)) return`) means a success can never clear an entry
  // on its own — only an explicit setHookInstallRefusal(null, target) does.
  let state: typeof import('../hooks/state.js')
  let client: typeof import('../ws/client.js')

  beforeEach(async () => {
    state = await import('../hooks/state.js')
    client = await import('../ws/client.js')
    for (const target of ['claude', 'kimi', 'codex', 'opencode', 'agy'] as const) {
      state.setHookInstallRefusal(null, target)
    }
  })

  afterEach(() => {
    for (const target of ['claude', 'kimi', 'codex', 'opencode', 'agy'] as const) {
      state.setHookInstallRefusal(null, target)
    }
  })

  // 1. Catches the missing `else` at ws/client.ts:4177-4182 — the live-smoke bug.
  it('clears the refusal the same target recorded earlier', () => {
    state.setHookInstallRefusal('target-missing', 'agy', 1_000)
    expect(state.getHookInstallRefusal('agy')?.status).toBe('target-missing')

    client.recordHookInstallOutcome('installed', 'agy')

    expect(state.getHookInstallRefusal('agy')).toBeUndefined()
    expect(state.lastHookInstallRefusal).toBeNull()
  })

  // 1b. Same line: `already-present` is a success too, and it is what every
  // respawn after the first one actually returns.
  it('treats already-present as a success that clears the refusal', () => {
    state.setHookInstallRefusal('target-missing', 'agy', 1_000)

    client.recordHookInstallOutcome('already-present', 'agy')

    expect(state.getHookInstallRefusal('agy')).toBeUndefined()
    expect(state.lastHookInstallRefusal).toBeNull()
  })

  // 2. Catches a blunt fix that clears the whole map, and confirms
  // state.ts:22-25 recomputes lastHookInstallRefusal from what remains rather
  // than blindly nulling it.
  it('leaves another agent\'s refusal intact and re-points lastHookInstallRefusal at it', () => {
    state.setHookInstallRefusal('refused-malformed', 'claude', 1_000)
    state.setHookInstallRefusal('target-missing', 'agy', 2_000)
    expect(state.lastHookInstallRefusal?.status).toBe('target-missing')

    client.recordHookInstallOutcome('installed', 'agy')

    expect(state.getHookInstallRefusal('agy')).toBeUndefined()
    expect(state.getHookInstallRefusal('claude')?.status).toBe('refused-malformed')
    expect(state.lastHookInstallRefusal?.status).toBe('refused-malformed')
    expect(state.lastHookInstallRefusal?.at).toBe(1_000)
  })

  // 3. Confirms setHookInstallRefusal(null, target) is a no-op for a target
  // that never refused — the clear must not disturb unrelated state.
  it('is a no-op when that target never refused', () => {
    state.setHookInstallRefusal('refused-malformed', 'claude', 1_000)
    const before = state.lastHookInstallRefusal

    expect(() => client.recordHookInstallOutcome('installed', 'agy')).not.toThrow()

    expect(state.getHookInstallRefusal('agy')).toBeUndefined()
    expect(state.lastHookInstallRefusal).toEqual(before!)
    expect(state.getHookInstallRefusal('claude')?.status).toBe('refused-malformed')
  })

  it('does not throw when nothing has ever refused', () => {
    expect(() => client.recordHookInstallOutcome('installed', 'agy')).not.toThrow()
    expect(state.lastHookInstallRefusal).toBeNull()
  })

  // 4. Catches a fix that clears on success but then stops recording — the
  // chip must go red again if the next attempt really does refuse.
  it('re-arms: a refusal after a success records normally', () => {
    state.setHookInstallRefusal('target-missing', 'agy', 1_000)
    client.recordHookInstallOutcome('installed', 'agy')
    expect(state.lastHookInstallRefusal).toBeNull()

    client.recordHookInstallOutcome('refused-malformed', 'agy')

    expect(state.getHookInstallRefusal('agy')?.status).toBe('refused-malformed')
    expect(state.lastHookInstallRefusal?.status).toBe('refused-malformed')
  })
})
