import { homedir } from 'node:os'
import path from 'node:path'

const JERICO_DIR = path.join(homedir(), '.jerico')
const BRIDGE_DIR = path.join(homedir(), '.bridge')

const SAFE_PROFILE_RE = /^[a-zA-Z0-9-]+$/

function activeProfile(): string | undefined {
  const p = process.env['BRIDGE_PROFILE'] || undefined
  if (p !== undefined && !SAFE_PROFILE_RE.test(p)) {
    console.error(`[codegraph] profile.invalid — BRIDGE_PROFILE "${p}" contains unsafe characters (allowed: a-z A-Z 0-9 -)`)
    process.exit(1)
  }
  return p
}

export function getCodegraphDir(): string {
  const p = activeProfile()
  if (!p) return path.join(JERICO_DIR, 'codegraph')
  return path.join(JERICO_DIR, 'profiles', p, 'codegraph')
}

export function getCodegraphLockPath(): string {
  const p = activeProfile()
  const filename = p ? `${p}.codegraph.lock` : 'codegraph.lock'
  return path.join(BRIDGE_DIR, filename)
}
