import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { registerHookTarget, unregisterHookTarget, type HookTargetRegistryEntry } from '../hooks/targets.js'
import { assertHookBlock, removeHookBlock, getTargetFile } from '../hooks/install.js'
import { renderBlock, spliceBlock, stripBlock, findBlock } from '../hooks/block.js'
import { promises as fs } from 'node:fs'
import path from 'path'
import os from 'os'

describe('hook-registry step 1 red-before-green proof', () => {
  let tempDir: string
  let mockFile: string
  let installAttempted: boolean
  let stripAttempted: boolean

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jerico-reg-test-'))
    mockFile = path.join(tempDir, 'fake-config.json')
    await fs.writeFile(mockFile, JSON.stringify({ hooks: { Stop: [] } }), 'utf-8')
    installAttempted = false
    stripAttempted = false
  })

  afterEach(async () => {
    unregisterHookTarget('fake-agent')
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('unregistered target fails getTargetFile / assertHookBlock', async () => {
    expect(() => getTargetFile('unregistered-agent' as any)).toThrow()
    const res = await assertHookBlock('unregistered-agent' as any)
    expect(res).toBe('refused-malformed')
  })

  it('registered target receives install attempt and unregistering stops it', async () => {
    const fakeEntry: HookTargetRegistryEntry = {
      target: 'fake-agent',
      installKind: 'config-block',
      format: 'json',
      getTargetFile: () => mockFile,
      renderBlock: () => ({ fake: true }),
      findBlock: (content: string) => {
        try {
          const parsed = JSON.parse(content)
          return parsed.fakeInstalled ? { fake: true } : null
        } catch {
          return null
        }
      },
      spliceBlock: (content: string) => {
        installAttempted = true
        return {
          content: JSON.stringify({ fakeInstalled: true }),
          status: 'installed'
        }
      },
      stripBlock: (content: string) => {
        stripAttempted = true
        return {
          content: JSON.stringify({ fakeInstalled: false }),
          status: 'installed'
        }
      }
    }

    // Step A: Register target -> prove install is attempted
    registerHookTarget(fakeEntry)
    expect(getTargetFile('fake-agent' as any)).toBe(mockFile)

    const installRes = await assertHookBlock('fake-agent' as any)
    expect(installAttempted).toBe(true)
    expect(installRes).toBe('installed')

    const fileAfterInstall = await fs.readFile(mockFile, 'utf-8')
    expect(JSON.parse(fileAfterInstall).fakeInstalled).toBe(true)

    const removeRes = await removeHookBlock('fake-agent' as any)
    expect(stripAttempted).toBe(true)
    expect(removeRes).toBe('installed')

    // Step B: Unregister target -> prove install attempt stops
    unregisterHookTarget('fake-agent')
    installAttempted = false
    stripAttempted = false

    const installRes2 = await assertHookBlock('fake-agent' as any)
    expect(installAttempted).toBe(false)
    expect(installRes2).toBe('refused-malformed')
  })
})
