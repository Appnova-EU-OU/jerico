// ============================================================================
// Repo digest (issue #512 P3) — a compact, token-cheap map of a project's
// working tree, injected into project-scoped panels at spawn so agents start
// with repo shape instead of paying discovery turns.
//
// File set: `git ls-files -c -o --exclude-standard` (tracked + untracked but
// NOT ignored → .gitignore respected without a JS ignore dep). Non-git
// fallback: manual walk with a fixed ignore set (node_modules/.git/dist/…).
//
// Render: indented tree, one line per file with size and a git-status flag
// (M/A/D/? from porcelain status). HARD budget ~2.5KB with head+tail elision
// ("[… N elided …]") — lines are elided whole, never split mid-path.
//
// Cache: keyed by (realpath cwd, git HEAD). A HEAD move (commit/checkout)
// invalidates; working-tree-only churn is intentionally NOT tracked — the
// digest is spawn-time orientation, not a live view.
// ============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

const BUDGET_BYTES = 2560
const MAX_FILES = 4000
const FALLBACK_MAX_ENTRIES = 500
const FALLBACK_MAX_DEPTH = 4
const CACHE_MAX = 32

const FALLBACK_IGNORE = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  '.next', '.nuxt', '.turbo', '.cache', 'coverage', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', '.idea', '.DS_Store',
])

interface DigestEntry { path: string; size: number; status?: string }

const digestCache = new Map<string, string>()

function cacheGet(key: string): string | undefined {
  const v = digestCache.get(key)
  if (v !== undefined) {
    // refresh recency (simple LRU via delete+set)
    digestCache.delete(key)
    digestCache.set(key, v)
  }
  return v
}

function cacheSet(key: string, value: string): void {
  digestCache.set(key, value)
  while (digestCache.size > CACHE_MAX) {
    const oldest = digestCache.keys().next().value
    if (oldest === undefined) break
    digestCache.delete(oldest)
  }
}

function git(root: string, args: string[]): string | null {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_PAGER: 'cat' }
  const res = spawnSync('git', ['--no-pager', '-C', root, ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    env,
  })
  if (res.status !== 0 || res.error) return null
  return res.stdout
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

function statSize(root: string, rel: string): number {
  try {
    return fs.statSync(path.join(root, rel)).size
  } catch {
    return 0
  }
}

/** Tracked + untracked-not-ignored files with git status flags. null = not a repo. */
function gitFileSet(root: string): { head: string; entries: DigestEntry[]; total: number } | null {
  const head = git(root, ['rev-parse', 'HEAD'])
  if (head === null) return null
  const listed = git(root, ['ls-files', '-c', '-o', '--exclude-standard'])
  if (listed === null) return null
  const statusOut = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) ?? ''

  const statusByPath = new Map<string, string>()
  const parts = statusOut.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec || rec.length < 4) continue
    const x = rec[0] ?? ' '
    const y = rec[1] ?? ' '
    const p = rec.slice(3)
    if (x === 'R' || x === 'C') i++ // rename/copy consumes the next NUL field
    const code = x === '?' && y === '?' ? '?' : (y !== ' ' ? y : x)
    if (['M', 'A', 'D', 'R', 'C', 'U', '?'].includes(code)) statusByPath.set(p, code)
  }

  const files = listed.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  const capped = files.slice(0, MAX_FILES)
  const entries: DigestEntry[] = capped.map(rel => ({
    path:   rel,
    size:   statSize(root, rel),
    status: statusByPath.get(rel),
  }))
  return { head: head.trim(), entries, total: files.length }
}

/** Manual walk fallback for non-git directories. */
function fallbackFileSet(root: string): DigestEntry[] {
  const out: DigestEntry[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > FALLBACK_MAX_DEPTH || out.length >= FALLBACK_MAX_ENTRIES) return
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (out.length >= FALLBACK_MAX_ENTRIES) return
      if (item.name.startsWith('.') && item.name !== '.env.example') continue
      if (FALLBACK_IGNORE.has(item.name)) continue
      const full = path.join(dir, item.name)
      const rel = path.relative(root, full).split(path.sep).join('/')
      if (item.isDirectory()) {
        walk(full, depth + 1)
      } else if (item.isFile()) {
        out.push({ path: rel, size: statSize(root, rel) })
      }
    }
  }
  walk(root, 0)
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

/** Render entries as an indented tree, eliding whole lines to fit the budget. */
function renderTree(root: string, entries: DigestEntry[], total: number, source: 'git' | 'walk'): string {
  const lines: string[] = []
  lines.push(`root: ${root} (${total} files, ${source === 'git' ? 'git ls-files' : 'walk fallback'})`)
  for (const e of entries) {
    const depth = e.path.split('/').length - 1
    const name = e.path.slice(e.path.lastIndexOf('/') + 1)
    const flag = e.status ? ` [${e.status}]` : ''
    lines.push(`${'  '.repeat(depth)}${name} (${humanSize(e.size)})${flag}`)
  }
  if (total > entries.length) {
    lines.push(`[… capped at ${entries.length} of ${total} files …]`)
  }

  const joined = lines.join('\n')
  if (joined.length <= BUDGET_BYTES) return joined

  // Head+tail elision: keep whole lines from both ends, never split a path.
  const marker = (n: number): string => `[… ${n} elided …]`
  let headCount = 0
  let tailCount = 0
  let headBytes = lines[0]!.length + 1
  let tailBytes = 0
  const body = lines.slice(1)
  // Reserve room for the marker line; grow head and tail alternately.
  while (headCount + tailCount < body.length) {
    const nextHead = body[headCount]
    const nextTail = body[body.length - 1 - tailCount]
    const markerBytes = marker(body.length - headCount - tailCount).length + 1
    if (nextHead !== undefined && headBytes + nextHead.length + 1 + tailBytes + markerBytes <= BUDGET_BYTES) {
      headBytes += nextHead.length + 1
      headCount++
      continue
    }
    if (nextTail !== undefined && headBytes + tailBytes + nextTail.length + 1 + markerBytes <= BUDGET_BYTES) {
      tailBytes += nextTail.length + 1
      tailCount++
      continue
    }
    break
  }
  const elided = body.length - headCount - tailCount
  const headLines = body.slice(0, headCount)
  const tailLines = tailCount > 0 ? body.slice(body.length - tailCount) : []
  return [lines[0]!, ...headLines, marker(elided), ...tailLines].join('\n')
}

/**
 * Build (or return cached) repo digest for `root` (already realpath-jailed by
 * the caller). Returns empty string when the directory has no listable files.
 */
export function buildRepoDigest(root: string): string {
  const gitSet = gitFileSet(root)
  if (gitSet) {
    const key = `${root}@${gitSet.head}`
    const cached = cacheGet(key)
    if (cached !== undefined) return cached
    const rendered = renderTree(root, gitSet.entries, gitSet.total, 'git')
    cacheSet(key, rendered)
    return rendered
  }
  const entries = fallbackFileSet(root)
  if (entries.length === 0) return ''
  // Non-git dirs have no HEAD — key on entry count + total size as a cheap
  // change heuristic.
  const totalSize = entries.reduce((acc, e) => acc + e.size, 0)
  const key = `${root}@walk:${entries.length}:${totalSize}`
  const cached = cacheGet(key)
  if (cached !== undefined) return cached
  const rendered = renderTree(root, entries, entries.length, 'walk')
  cacheSet(key, rendered)
  return rendered
}

/** Test hook: drop all cached digests. */
export function clearRepoDigestCache(): void {
  digestCache.clear()
}
