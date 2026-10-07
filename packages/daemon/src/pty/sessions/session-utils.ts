import fs from 'node:fs'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isCanonicalSessionId = (value: string): boolean => UUID_RE.test(value)

export function canonicalSessionCwd(cwd: string): string {
  try { return fs.realpathSync.native(cwd) } catch { return cwd }
}

export function sameSessionCwd(left: string, right: string): boolean {
  return canonicalSessionCwd(left) === canonicalSessionCwd(right)
}
