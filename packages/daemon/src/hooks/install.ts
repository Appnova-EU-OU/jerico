import { HOOK_TARGETS, getHookTargetEntry, type HookTarget, type PluginFileHookTargetRegistryEntry } from './targets.js'
import { spliceBlock, stripBlock, type InstallResult } from './block.js'
import { randomBytes } from 'crypto'
import { promises as fs } from 'node:fs'
import path from 'path'
import os from 'os'
import { hookScriptPath, ensureHookScript, HOOK_SCRIPT_V1 } from './script.js'
import { extractJericoHashesFromHooksJson } from './codex-hash.js'

export function getTargetFile(target: HookTarget): string {
  const entry = getHookTargetEntry(target)
  if (entry) {
    return entry.getTargetFile()
  }
  switch (target) {
    case 'claude':
    case 'kimi':
    case 'codex':
    case 'opencode':
    case 'agy':
      throw new Error(`getTargetFile: missing registry entry for target ${target}`)
    default: {
      const unhandled: never = target
      throw new Error(`getTargetFile: no config path implemented for target ${String(unhandled)}`)
    }
  }
}

export async function resolveRealTargetFile(target: HookTarget | string, targetPath: string): Promise<string | 'refused-unsafe-target'> {
  try {
    const stat = await fs.lstat(targetPath)
    if (!stat.isSymbolicLink()) return targetPath
    const resolved = await fs.realpath(targetPath)
    if (target === 'kimi') {
      const realHome = path.dirname(targetPath)
      const relative = path.relative(realHome, resolved)
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
        return 'refused-unsafe-target'
      }
    }
    return resolved
  } catch (err: any) {
    // If it doesn't exist, we'll write to the original path.
    return targetPath
  }
}

export async function readTargetFile(targetPath: string): Promise<{ content: string; mode: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(targetPath)
    const content = await fs.readFile(targetPath, 'utf-8')
    return { content, mode: stat.mode, mtimeMs: stat.mtimeMs }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

export async function atomicWrite(targetPath: string, content: string, originalMode: number | null, expectedMtimeMs: number | null): Promise<void> {
  const dir = path.dirname(targetPath)
  await fs.mkdir(dir, { recursive: true })
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.tmp.${randomBytes(6).toString('hex')}`)
  
  try {
    // Write to a temp file in the same directory, explicit mode 0600 initially
    await fs.writeFile(tempPath, content, { mode: 0o600 })
    
    // Preserve the original file's mode if it differs from 0600, otherwise leave as 0600
    if (originalMode !== null) {
      const modeBits = originalMode & 0o777
      if (modeBits !== 0o600) {
        await fs.chmod(tempPath, modeBits)
      }
    }
    
    // Verify file has not changed since we read it
    if (expectedMtimeMs !== null) {
      try {
        const currentStat = await fs.stat(targetPath)
        if (currentStat.mtimeMs !== expectedMtimeMs) {
          const err = new Error('File changed since read')
          ;(err as any).code = 'ECONFLICT'
          throw err
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          const err2 = new Error('File deleted since read')
          ;(err2 as any).code = 'ECONFLICT'
          throw err2
        }
        throw err
      }
    } else {
      try {
        await fs.stat(targetPath)
        const err = new Error('File created since read')
        ;(err as any).code = 'ECONFLICT'
        throw err
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err
      }
    }

    // Atomic rename over the target.
    await fs.rename(tempPath, targetPath)
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {})
    throw err
  }
}

async function assertPluginFile(entry: PluginFileHookTargetRegistryEntry): Promise<InstallResult> {
  const targetPath = entry.getTargetFile()
  const expected = entry.renderFile()
  let retries = 3

  while (retries > 0) {
    const fileInfo = await readTargetFile(targetPath)
    if (fileInfo?.content === expected) return 'already-present'

    try {
      await atomicWrite(targetPath, expected, fileInfo?.mode ?? null, fileInfo?.mtimeMs ?? null)
      return 'installed'
    } catch (err: any) {
      if (err.code === 'ECONFLICT') {
        retries--
        continue
      }
      throw err
    }
  }
  return 'refused-conflict'
}

/** Create a target file that does not exist yet, for targets whose file holds
 *  nothing but hooks. Exclusive create: if another process wins the race we
 *  report `exists` and the caller re-reads and splices into whatever landed,
 *  rather than overwriting it. A symlink at the path is never written through. */
async function seedTargetFile(
  targetPath: string,
  content: string
): Promise<'created' | 'exists' | 'refused-unsafe-target'> {
  try {
    const stat = await fs.lstat(targetPath)
    // readTargetFile saw nothing, yet the path exists — a dangling or
    // redirected symlink. Creating through it would write somewhere we did
    // not choose.
    if (stat.isSymbolicLink()) return 'refused-unsafe-target'
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 })
  try {
    await fs.writeFile(targetPath, content, { flag: 'wx', mode: 0o600 })
    return 'created'
  } catch (err: any) {
    if (err.code === 'EEXIST') return 'exists'
    throw err
  }
}

export async function assertHookBlock(target: HookTarget): Promise<InstallResult> {
  const entry = getHookTargetEntry(target)
  if (!entry) return 'refused-malformed'
  if (entry.installKind === 'plugin-file') return assertPluginFile(entry)

  try {
    ensureHookScript()
  } catch (err) {
    // If ensureHookScript fails (e.g. read-only dir), we handle it in the stat/content check below.
  }

  const scriptPath = hookScriptPath()
  try {
    const stat = await fs.stat(scriptPath)
    if ((stat.mode & 0o111) === 0) {
      return 'refused-invalid-script'
    }
    const content = await fs.readFile(scriptPath, 'utf-8')
    if (content !== HOOK_SCRIPT_V1) {
      return 'refused-invalid-script'
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return 'refused-invalid-script'
    }
    throw err
  }

  let initialTargetPath: string
  try {
    initialTargetPath = getTargetFile(target)
  } catch {
    return 'refused-malformed'
  }
  const resolvedTargetPath = await resolveRealTargetFile(target, initialTargetPath)
  if (resolvedTargetPath === 'refused-unsafe-target') return resolvedTargetPath
  const targetPath = resolvedTargetPath

  let retries = 3
  while (retries > 0) {
    const fileInfo = await readTargetFile(targetPath)

    if (!fileInfo) {
      // Without a seed the policy is unchanged: we splice into a file the user
      // already owns, we never bring one into existence.
      if (!entry.seedWhenMissing) return 'target-missing'
      const seeded = await seedTargetFile(targetPath, entry.seedWhenMissing())
      if (seeded === 'refused-unsafe-target') return seeded
      // Whether we created it or lost the race, the next pass reads what is on
      // disk and puts it through the same splice + validation as any install.
      retries--
      continue
    }

    const knownHashes = target === 'codex' ? extractJericoHashesFromHooksJson(fileInfo.content, targetPath) : []
    const result = spliceBlock(target, fileInfo.content)
    if (result.status === 'already-present') {
      if (entry.trustSeeder) {
        await entry.trustSeeder(targetPath, knownHashes)
      }
      return 'already-present'
    }
    if (result.status !== 'installed') {
      return result.status
    }

    try {
      await atomicWrite(targetPath, result.content, fileInfo.mode, fileInfo.mtimeMs)
      if (entry.trustSeeder) {
        await entry.trustSeeder(targetPath, knownHashes)
      }
      return 'installed'
    } catch (err: any) {
      if (err.code === 'ECONFLICT') {
        retries--
        continue
      }
      throw err
    }
  }
  return 'refused-conflict'
}

export async function removeHookBlock(target: HookTarget): Promise<InstallResult> {
  const entry = getHookTargetEntry(target)
  if (!entry) return 'target-missing'
  if (entry.installKind === 'plugin-file') {
    try {
      await fs.unlink(entry.getTargetFile())
      return 'installed'
    } catch (err: any) {
      if (err.code === 'ENOENT') return 'target-missing'
      throw err
    }
  }

  let initialTargetPath: string
  try {
    initialTargetPath = getTargetFile(target)
  } catch {
    return 'target-missing'
  }
  const resolvedTargetPath = await resolveRealTargetFile(target, initialTargetPath)
  if (resolvedTargetPath === 'refused-unsafe-target') return resolvedTargetPath
  const targetPath = resolvedTargetPath

  let retries = 3
  while (retries > 0) {
    const fileInfo = await readTargetFile(targetPath)
    
    if (!fileInfo) {
      return 'target-missing'
    }

    const knownHashes = target === 'codex' ? extractJericoHashesFromHooksJson(fileInfo.content, targetPath) : []
    const result = stripBlock(target, fileInfo.content)
    if (result.status === 'already-present') {
      if (entry.trustSeeder) {
        await entry.trustSeeder(targetPath, knownHashes)
      }
      return 'already-present'
    }
    if (result.status !== 'installed') {
      return result.status
    }

    try {
      await atomicWrite(targetPath, result.content, fileInfo.mode, fileInfo.mtimeMs)
      if (entry.trustSeeder) {
        await entry.trustSeeder(targetPath, knownHashes)
      }
      return 'installed'
    } catch (err: any) {
      if (err.code === 'ECONFLICT') {
        retries--
        continue
      }
      throw err
    }
  }
  return 'refused-conflict'
}
