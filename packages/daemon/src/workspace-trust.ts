import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CwdSource } from './shared/types.js'
import { mergeCodexWorkspaceTrust } from './hooks/codex-hash.js'

export interface StartupGateProfile {
  kind: 'workspace_trust' | 'unknown_startup'
  allOf: RegExp[]
}

export type WorkspaceTrustSeedStatus =
  | 'installed'
  | 'already-present'
  | 'skipped-agent'
  | 'skipped-fallback-home'
  | 'skipped-server-project'
  | 'skipped-orchestrator'
  | 'refused-no-provenance'
  | 'refused-sched-containment'
  | 'refused-invalid-cwd'
  | 'refused-unsafe-target'
  | 'refused-conflict'
  | 'failed'

export interface WorkspaceTrustSeedResult {
  status: WorkspaceTrustSeedStatus
  canonicalRoot?: string
}

export interface WorkspaceTrustSeedInput {
  agentKey: string
  cwd: string
  cwdSource: CwdSource
  orchestratorOwned: boolean
  kimiHome?: string
  claudeHome?: string
  claudeConfigPath?: string
  agyHome?: string
  agySettingsPath?: string
  codexHome?: string
  codexConfigPath?: string
  now?: number
  setVia?: string
}

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

export function detectStartupGate(profile: StartupGateProfile | undefined, outputTail: string): boolean {
  if (!profile || profile.allOf.length === 0) return false
  const clean = outputTail.replace(ANSI_PATTERN, '')
  return profile.allOf.every(pattern => {
    pattern.lastIndex = 0
    return pattern.test(clean)
  })
}

export function startupGateTimeoutDecision(
  profile: StartupGateProfile | undefined,
  gateDetected: boolean,
  seedReason: string | undefined,
): 'attention' | 'hold' | 'fallback' {
  if (!profile) return 'fallback'
  return gateDetected || seedReason ? 'hold' : 'attention'
}

function validExistingRecord(target: string, canonicalRoot: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>
    return parsed['root'] === canonicalRoot
      && typeof parsed['trustedAt'] === 'number'
      && Number.isFinite(parsed['trustedAt'])
      && parsed['trustedAt'] > 0
  } catch {
    return false
  }
}

function targetInsideHome(realHome: string, target: string): boolean {
  const relative = path.relative(realHome, target)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function installNoClobber(target: string, content: string): 'installed' | 'exists' {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    try {
      linkSync(temp, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
      throw error
    }
    chmodSync(target, 0o600)
    return 'installed'
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch { /* already removed or never created */ }
  }
}

/**
 * Seed provider workspace trust only for a human-linked cwd. The provider's own
 * record is the source of truth; this function never answers a PTY prompt.
 */
function seedKimiWorkspaceTrust(input: WorkspaceTrustSeedInput, canonicalRoot: string): WorkspaceTrustSeedResult {
  try {
    const configuredHome = input.kimiHome ?? process.env['KIMI_CODE_HOME'] ?? path.join(os.homedir(), '.kimi-code')
    if (!existsSync(configuredHome)) mkdirSync(configuredHome, { recursive: true, mode: 0o700 })
    const realHome = realpathSync.native(configuredHome)
    const trustDir = path.join(realHome, 'workspace-trust')
    if (!targetInsideHome(realHome, trustDir)) return { status: 'refused-unsafe-target', canonicalRoot }

    if (existsSync(trustDir)) {
      if (lstatSync(trustDir).isSymbolicLink() || !lstatSync(trustDir).isDirectory()) {
        return { status: 'refused-unsafe-target', canonicalRoot }
      }
    } else {
      mkdirSync(trustDir, { mode: 0o700 })
    }
    chmodSync(trustDir, 0o700)

    const digest = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12)
    const target = path.join(trustDir, `wd_${path.basename(canonicalRoot)}_${digest}`)
    if (!targetInsideHome(realHome, target)) return { status: 'refused-unsafe-target', canonicalRoot }
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink()) return { status: 'refused-unsafe-target', canonicalRoot }
      return { status: validExistingRecord(target, canonicalRoot) ? 'already-present' : 'refused-conflict', canonicalRoot }
    }

    const content = JSON.stringify({ root: canonicalRoot, trustedAt: input.now ?? Date.now() })
    const installed = installNoClobber(target, content)
    if (installed === 'exists') {
      return { status: validExistingRecord(target, canonicalRoot) ? 'already-present' : 'refused-conflict', canonicalRoot }
    }
    return { status: 'installed', canonicalRoot }
  } catch (error) {
    console.warn('[daemon] workspace_trust.seed_failed', {
      agentKey: input.agentKey,
      cwdSource: input.cwdSource,
      error: error instanceof Error ? error.message : String(error),
    })
    return { status: 'failed', canonicalRoot }
  }
}

/**
 * Reject any symlinked component strictly between `target` and the trusted
 * `base` (inclusive of `base`). OS-level symlinks above the trusted base (e.g.
 * the macOS `/var` -> `/private/var` indirection) are out of the attacker's
 * control and are not our concern; a symlink an attacker can plant inside the
 * home/project subtree must never be traversed for a write.
 */
function pathHasSymlinkComponent(target: string, base: string): boolean {
  const resolvedBase = realResolve(base)
  let current = path.resolve(target)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let isSymlink = false
    try {
      isSymlink = lstatSync(current).isSymbolicLink()
    } catch {
      // component does not exist yet; only existing components can be symlinks
    }
    if (isSymlink) return true
    // Stop when this component resolves to the trusted base. Comparing by realpath
    // (not literal string) avoids being fooled by OS symlink indirection such as
    // macOS `/var` -> `/private/var`, which would otherwise make the walk overshoot
    // the base and falsely flag a higher-level symlink.
    let currentResolved: string | null = null
    try {
      currentResolved = realpathSync.native(current)
    } catch {
      currentResolved = null
    }
    if (currentResolved !== null && currentResolved === resolvedBase) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return false
}

/**
 * Resolve `p` to its real (symlink-following) form using the longest existing
 * prefix, then re-append the remaining literal components. This lets containment
 * comparison ignore OS-level symlink indirection (e.g. macOS `/var` ->
 * `/private/var`) without following attacker-controlled symlinks at the tail.
 */
function realResolve(p: string): string {
  const abs = path.resolve(p)
  const tailParts: string[] = []
  let cur = abs
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return path.join(realpathSync.native(cur), ...tailParts)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return abs
      tailParts.unshift(path.basename(cur))
      cur = parent
    }
  }
}

const SCHED_WORKTREE_MARKER = `${path.sep}${path.join('.jerico', 'sched')}${path.sep}`

/**
 * `sched_worktree` provenance is valid only for a server-created schedule
 * worktree, `<projectRoot>/.jerico/sched/<scheduleId>/<slot>` — a shape only
 * the scheduling worktree executor constructs, with no user input in the
 * segments (the server worktree scheduler uses `join('.jerico',
 * 'sched', scheduleId, slot)).
 *
 * The parent root IS derived from the spawn message's cwd — but it is not
 * taken as a separately-asserted field the server could set independently:
 * it is forced to be the structural prefix of that cwd at the `.jerico/sched/`
 * marker, and both sides are then canonically resolved and symlink-checked
 * against the filesystem: the canonical cwd must be a strict descendant of
 * the canonical derived parent through the `.jerico/sched/` namespace, with
 * no symlink component between them. Any resolution error fails closed. The
 * human anchor lives server-side, where the scheduler forwards
 * `sched_worktree` only when the parent project binding is 'ui' or 'cli'
 * (the server scheduler dispatch), so a forged spawn gains nothing
 * here beyond a directory whose shape it could already create itself.
 * Returns true when containment does NOT hold.
 */
function schedWorktreeContainmentFailed(rawCwd: string, canonicalCwd: string): boolean {
  try {
    const abs = path.resolve(rawCwd)
    const markerIndex = abs.lastIndexOf(SCHED_WORKTREE_MARKER)
    if (markerIndex < 0) return true
    const parentRoot = abs.slice(0, markerIndex + path.sep.length)
    const canonicalParent = realResolve(parentRoot)
    const rel = path.relative(canonicalParent, canonicalCwd)
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return true
    const segments = rel.split(path.sep)
    // `<scheduleId>/<slot>` must follow `.jerico/sched` — the exact relative
    // shape the worktree executor builds. A bare `<root>/.jerico/sched` cwd is
    // not a worktree and must not be trustable through this provenance.
    if (segments.length < 4 || segments[0] !== '.jerico' || segments[1] !== 'sched' || segments[2] === '' || segments[3] === '') return true
    return pathHasSymlinkComponent(abs, parentRoot)
  } catch {
    return true
  }
}

function mergeClaudeConfig(
  config: Record<string, unknown>,
  canonicalRoot: string,
): { modified: boolean; obj: Record<string, unknown> } | 'conflict' {
  const rawProjects = config['projects']
  if (rawProjects !== undefined && (!rawProjects || typeof rawProjects !== 'object' || Array.isArray(rawProjects))) {
    return 'conflict'
  }
  const projects = { ...((rawProjects ?? {}) as Record<string, unknown>) }
  const rawProject = projects[canonicalRoot]
  if (rawProject !== undefined && (!rawProject || typeof rawProject !== 'object' || Array.isArray(rawProject))) {
    return 'conflict'
  }
  const project = { ...((rawProject ?? {}) as Record<string, unknown>) }

  const onboardingDone = config['hasCompletedOnboarding'] === true
  const trustDone = project['hasTrustDialogAccepted'] === true

  if (onboardingDone && trustDone) {
    return { modified: false, obj: config }
  }

  projects[canonicalRoot] = { ...project, hasTrustDialogAccepted: true }
  return {
    modified: true,
    obj: { ...config, hasCompletedOnboarding: true, projects },
  }
}

interface JsonFileSnapshot {
  bytes: string
  dev: number
  ino: number
  size: number
  mode: number
  uid: number
  gid: number
  mtimeMs: number
  ctimeMs: number
}

type JsonReadResult =
  | { kind: 'absent' }
  | { kind: 'unsafe' }
  | { kind: 'changed' }
  | { kind: 'existing'; snapshot: JsonFileSnapshot; config: Record<string, unknown> }
  | { kind: 'conflict' }

function sameJsonSnapshot(a: JsonFileSnapshot, b: JsonFileSnapshot): boolean {
  return a.bytes === b.bytes
    && a.dev === b.dev
    && a.ino === b.ino
    && a.size === b.size
    && a.mode === b.mode
    && a.uid === b.uid
    && a.gid === b.gid
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs
}

function readJsonConfigSnapshot(target: string): JsonReadResult {
  let before
  try {
    before = lstatSync(target)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'changed' }
  }
  if (before.isSymbolicLink() || !before.isFile()) return { kind: 'unsafe' }

  let bytes: string
  let after
  try {
    bytes = readFileSync(target, 'utf8')
    after = lstatSync(target)
  } catch {
    return { kind: 'changed' }
  }
  if (after.isSymbolicLink() || !after.isFile()) return { kind: 'unsafe' }

  const snapshot: JsonFileSnapshot = {
    bytes,
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mode: after.mode,
    uid: after.uid,
    gid: after.gid,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
  }
  const beforeSnapshot: JsonFileSnapshot = {
    ...snapshot,
    dev: before.dev,
    ino: before.ino,
    size: before.size,
    mode: before.mode,
    uid: before.uid,
    gid: before.gid,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
  }
  if (!sameJsonSnapshot(beforeSnapshot, snapshot)) return { kind: 'changed' }

  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch {
    return { kind: 'conflict' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'conflict' }
  return { kind: 'existing', snapshot, config: parsed as Record<string, unknown> }
}

interface HomeIdentity {
  dev: number
  ino: number
  uid: number
  gid: number
  mode: number
}

function validateHomeIdentity(realHome: string, identity?: HomeIdentity): HomeIdentity | null {
  try {
    const stat = lstatSync(realHome)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null
    if (realpathSync.native(realHome) !== realHome) return null
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (currentUid !== undefined && (stat.uid !== currentUid || (stat.mode & 0o022) !== 0)) return null
    if (identity && (stat.dev !== identity.dev
      || stat.ino !== identity.ino
      || stat.uid !== identity.uid
      || stat.gid !== identity.gid
      || stat.mode !== identity.mode)) return null
    return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode }
  } catch {
    return null
  }
}

interface ClaudeTrustTarget {
  realHome: string
  canonicalTarget: string
  homeIdentity: HomeIdentity
}

function resolveClaudeTrustTarget(
  input: WorkspaceTrustSeedInput,
  canonicalRoot: string,
): ClaudeTrustTarget | WorkspaceTrustSeedResult {
  const literalHome = path.resolve(input.claudeHome ?? os.homedir())
  let realHome: string
  try {
    const literalHomeStat = lstatSync(literalHome)
    if (literalHomeStat.isSymbolicLink() || !literalHomeStat.isDirectory()) {
      return { status: 'refused-unsafe-target', canonicalRoot }
    }
    realHome = realpathSync.native(literalHome)
  } catch {
    return { status: 'refused-unsafe-target', canonicalRoot }
  }

  const requestedTarget = path.resolve(input.claudeConfigPath ?? path.join(literalHome, '.claude.json'))
  const canonicalTarget = path.join(realHome, path.basename(requestedTarget))
  if (realResolve(requestedTarget) !== canonicalTarget
    || path.dirname(canonicalTarget) !== realHome
    || pathHasSymlinkComponent(canonicalTarget, realHome)) {
    return { status: 'refused-unsafe-target', canonicalRoot }
  }

  const homeIdentity = validateHomeIdentity(realHome)
  if (!homeIdentity) return { status: 'refused-unsafe-target', canonicalRoot }
  return { realHome, canonicalTarget, homeIdentity }
}

function probeClaudeWorkspaceTrust(
  input: WorkspaceTrustSeedInput,
  canonicalRoot: string,
): boolean {
  const target = resolveClaudeTrustTarget(input, canonicalRoot)
  if ('status' in target) return false

  for (let attempt = 0; attempt < 3; attempt++) {
    const initial = readJsonConfigSnapshot(target.canonicalTarget)
    if (initial.kind === 'unsafe' || initial.kind === 'conflict') return false
    if (initial.kind === 'changed') continue

    const merged = mergeClaudeConfig(initial.kind === 'existing' ? initial.config : {}, canonicalRoot)
    if (merged === 'conflict') return false
    return !merged.modified
  }
  return false
}

function seedClaudeWorkspaceTrust(input: WorkspaceTrustSeedInput, canonicalRoot: string): WorkspaceTrustSeedResult {
  const target = resolveClaudeTrustTarget(input, canonicalRoot)
  if ('status' in target) return target
  const { canonicalTarget, homeIdentity, realHome } = target

  for (let attempt = 0; attempt < 3; attempt++) {
    const initial = readJsonConfigSnapshot(canonicalTarget)
    if (initial.kind === 'unsafe') return { status: 'refused-unsafe-target', canonicalRoot }
    if (initial.kind === 'conflict') return { status: 'refused-conflict', canonicalRoot }
    if (initial.kind === 'changed') continue

    const merged = mergeClaudeConfig(initial.kind === 'existing' ? initial.config : {}, canonicalRoot)
    if (merged === 'conflict') return { status: 'refused-conflict', canonicalRoot }
    if (!merged.modified) return { status: 'already-present', canonicalRoot }

    const temp = path.join(realHome, `.${path.basename(canonicalTarget)}.${process.pid}.${randomUUID()}.tmp`)
    let fd: number | undefined
    try {
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify(merged.obj, null, 2), 'utf8')
      if (initial.kind === 'existing') chmodSync(temp, initial.snapshot.mode & 0o7777)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined

      if (!validateHomeIdentity(realHome, homeIdentity)) {
        return { status: 'refused-unsafe-target', canonicalRoot }
      }

      if (initial.kind === 'absent') {
        try {
          linkSync(temp, canonicalTarget)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return { status: 'refused-conflict', canonicalRoot }
          }
          throw error
        }
      } else {
        const latest = readJsonConfigSnapshot(canonicalTarget)
        if (latest.kind === 'unsafe') return { status: 'refused-unsafe-target', canonicalRoot }
        if (latest.kind !== 'existing' || !sameJsonSnapshot(initial.snapshot, latest.snapshot)) continue
        // This is the last comparison available through portable Node/POSIX APIs.
        // rename(2) is atomic, but it is not a compare-and-swap: an edit racing
        // after this check and before rename cannot be detected here.
        renameSync(temp, canonicalTarget)
      }
      return { status: 'installed', canonicalRoot }
    } catch (error) {
      console.warn('[daemon] workspace_trust.seed_failed', {
        agentKey: input.agentKey,
        cwdSource: input.cwdSource,
        error: error instanceof Error ? error.message : String(error),
      })
      return { status: 'failed', canonicalRoot }
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* already closed */ }
      }
      try { unlinkSync(temp) } catch { /* linked, renamed, or never created */ }
    }
  }
  return { status: 'refused-conflict', canonicalRoot }
}

/**
 * agy (Antigravity CLI) records folder trust as a flat array of absolute paths
 * under `trustedWorkspaces` in ~/.gemini/antigravity-cli/settings.json.
 * Verified against the real file on 2026-08-27: top-level keys
 * allowNonWorkspaceAccess / enableTelemetry / model / permissions /
 * trustedWorkspaces, every entry a string, 2-space indented, trailing newline.
 *
 * Unlike hooks.json this file is NOT hooks-only — it carries the user's model
 * choice, their telemetry opt-out and their whole command-permission allowlist.
 * So: append to one key, never rewrite the file wholesale, never reorder or drop
 * an unrelated key, and never bring the file into existence.
 */
function mergeAgyTrust(
  config: Record<string, unknown>,
  canonicalRoot: string,
): { modified: boolean; obj: Record<string, unknown> } | 'conflict' {
  const raw = config['trustedWorkspaces']
  if (raw !== undefined) {
    // Never coerce. A non-array, or an array holding anything but strings, is a
    // shape we do not understand — refuse rather than reinterpret the user's file.
    if (!Array.isArray(raw)) return 'conflict'
    if (raw.some(entry => typeof entry !== 'string')) return 'conflict'
  }
  const trusted = (raw ?? []) as string[]
  if (trusted.includes(canonicalRoot)) return { modified: false, obj: config }
  // Spreading `config` first keeps every unrelated key, and its position: an
  // existing `trustedWorkspaces` stays where the user's file has it, and an
  // absent one is appended last.
  return { modified: true, obj: { ...config, trustedWorkspaces: [...trusted, canonicalRoot] } }
}

function seedAgyWorkspaceTrust(input: WorkspaceTrustSeedInput, canonicalRoot: string): WorkspaceTrustSeedResult {
  const literalHome = path.resolve(input.agyHome ?? process.env['JERICO_AGY_HOME'] ?? os.homedir())
  let realHome: string
  try {
    const literalHomeStat = lstatSync(literalHome)
    if (literalHomeStat.isSymbolicLink() || !literalHomeStat.isDirectory()) {
      return { status: 'refused-unsafe-target', canonicalRoot }
    }
    realHome = realpathSync.native(literalHome)
  } catch {
    return { status: 'refused-unsafe-target', canonicalRoot }
  }

  const requestedTarget = path.resolve(
    input.agySettingsPath
    ?? process.env['JERICO_AGY_SETTINGS_PATH']
    ?? path.join(literalHome, '.gemini', 'antigravity-cli', 'settings.json'),
  )
  // The settings file sits two directories below home, so containment is checked
  // by relative path rather than by the claude adapter's "directly in home" rule.
  const relativeToHome = path.relative(literalHome, requestedTarget)
  if (relativeToHome === ''
    || relativeToHome.startsWith(`..${path.sep}`)
    || relativeToHome === '..'
    || path.isAbsolute(relativeToHome)) {
    return { status: 'refused-unsafe-target', canonicalRoot }
  }
  const canonicalTarget = path.join(realHome, relativeToHome)
  if (realResolve(requestedTarget) !== canonicalTarget
    || !targetInsideHome(realHome, canonicalTarget)
    || pathHasSymlinkComponent(canonicalTarget, realHome)) {
    return { status: 'refused-unsafe-target', canonicalRoot }
  }

  const homeIdentity = validateHomeIdentity(realHome)
  if (!homeIdentity) return { status: 'refused-unsafe-target', canonicalRoot }

  for (let attempt = 0; attempt < 3; attempt++) {
    const initial = readJsonConfigSnapshot(canonicalTarget)
    if (initial.kind === 'unsafe') return { status: 'refused-unsafe-target', canonicalRoot }
    if (initial.kind === 'conflict') return { status: 'refused-conflict', canonicalRoot }
    if (initial.kind === 'changed') continue
    if (initial.kind === 'absent') {
      // Deliberately not created. This file holds the user's model, telemetry
      // and permission settings; a stub we invent could shadow the CLI's own
      // first-run defaults. An absent file means agy has not been configured
      // here, so it will ask its own trust question and the human answers it.
      console.warn('[daemon] workspace_trust.seed_failed', {
        agentKey: input.agentKey,
        cwdSource: input.cwdSource,
        error: 'agy settings.json absent; trust not seeded (file is never created)',
      })
      return { status: 'failed', canonicalRoot }
    }

    const merged = mergeAgyTrust(initial.config, canonicalRoot)
    if (merged === 'conflict') return { status: 'refused-conflict', canonicalRoot }
    if (!merged.modified) return { status: 'already-present', canonicalRoot }

    // Match the user's existing formatting so the file does not churn: agy writes
    // 2-space indented JSON with a trailing newline.
    const trailingNewline = initial.snapshot.bytes.endsWith('\n') ? '\n' : ''
    const rendered = `${JSON.stringify(merged.obj, null, 2)}${trailingNewline}`

    const temp = path.join(
      path.dirname(canonicalTarget),
      `.${path.basename(canonicalTarget)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let fd: number | undefined
    try {
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, rendered, 'utf8')
      chmodSync(temp, initial.snapshot.mode & 0o7777)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined

      if (!validateHomeIdentity(realHome, homeIdentity)
        || pathHasSymlinkComponent(canonicalTarget, realHome)) {
        return { status: 'refused-unsafe-target', canonicalRoot }
      }

      const latest = readJsonConfigSnapshot(canonicalTarget)
      if (latest.kind === 'unsafe') return { status: 'refused-unsafe-target', canonicalRoot }
      if (latest.kind !== 'existing' || !sameJsonSnapshot(initial.snapshot, latest.snapshot)) continue
      // rename(2) is atomic but is not a compare-and-swap: an edit racing after
      // this check and before the rename cannot be detected here. Same bound as
      // the claude adapter.
      renameSync(temp, canonicalTarget)
      return { status: 'installed', canonicalRoot }
    } catch (error) {
      console.warn('[daemon] workspace_trust.seed_failed', {
        agentKey: input.agentKey,
        cwdSource: input.cwdSource,
        error: error instanceof Error ? error.message : String(error),
      })
      return { status: 'failed', canonicalRoot }
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* already closed */ }
      }
      try { unlinkSync(temp) } catch { /* renamed or never created */ }
    }
  }
  return { status: 'refused-conflict', canonicalRoot }
}

type TomlReadResult =
  | { kind: 'absent' }
  | { kind: 'unsafe' }
  | { kind: 'changed' }
  | { kind: 'existing'; snapshot: JsonFileSnapshot; content: string }
  | { kind: 'conflict' }

function readTomlConfigSnapshot(target: string): TomlReadResult {
  let before
  try {
    before = lstatSync(target)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'changed' }
  }
  if (before.isSymbolicLink() || !before.isFile()) return { kind: 'unsafe' }

  let bytes: string
  let after
  try {
    bytes = readFileSync(target, 'utf8')
    after = lstatSync(target)
  } catch {
    return { kind: 'changed' }
  }
  if (after.isSymbolicLink() || !after.isFile()) return { kind: 'unsafe' }

  const snapshot: JsonFileSnapshot = {
    bytes,
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mode: after.mode,
    uid: after.uid,
    gid: after.gid,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
  }
  const beforeSnapshot: JsonFileSnapshot = {
    ...snapshot,
    dev: before.dev,
    ino: before.ino,
    size: before.size,
    mode: before.mode,
    uid: before.uid,
    gid: before.gid,
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
  }
  if (!sameJsonSnapshot(beforeSnapshot, snapshot)) return { kind: 'changed' }

  return { kind: 'existing', snapshot, content: bytes }
}

/**
 * Codex records workspace trust in ~/.codex/config.toml as a TOML table:
 *
 * [projects."<canonicalRoot>"]
 * trust_level = "trusted"
 *
 * Preserves every unrelated table and key and existing formatting.
 * Reuses mergeCodexWorkspaceTrust from hooks/codex-hash.ts to avoid drift.
 */
function seedCodexWorkspaceTrust(input: WorkspaceTrustSeedInput, canonicalRoot: string): WorkspaceTrustSeedResult {
  const literalHome = path.resolve(
    input.codexHome
    ?? process.env['JERICO_CODEX_HOME']
    ?? process.env['CODEX_HOME']
    ?? os.homedir(),
  )
  let realHome: string
  try {
    const literalHomeStat = lstatSync(literalHome)
    if (literalHomeStat.isSymbolicLink() || !literalHomeStat.isDirectory()) {
      return { status: 'refused-unsafe-target', canonicalRoot }
    }
    realHome = realpathSync.native(literalHome)
  } catch {
    return { status: 'refused-unsafe-target', canonicalRoot }
  }

  const requestedTarget = path.resolve(
    input.codexConfigPath
    ?? process.env['JERICO_CODEX_CONFIG_PATH']
    ?? path.join(literalHome, '.codex', 'config.toml'),
  )
  const relativeToHome = path.relative(literalHome, requestedTarget)
  if (relativeToHome === ''
    || relativeToHome.startsWith(`..${path.sep}`)
    || relativeToHome === '..'
    || path.isAbsolute(relativeToHome)) {
    return { status: 'refused-unsafe-target', canonicalRoot }
  }
  const canonicalTarget = path.join(realHome, relativeToHome)
  if (realResolve(requestedTarget) !== canonicalTarget
    || !targetInsideHome(realHome, canonicalTarget)
    || pathHasSymlinkComponent(canonicalTarget, realHome)) {
    return { status: 'refused-unsafe-target', canonicalRoot }
  }

  const homeIdentity = validateHomeIdentity(realHome)
  if (!homeIdentity) return { status: 'refused-unsafe-target', canonicalRoot }

  for (let attempt = 0; attempt < 3; attempt++) {
    const initial = readTomlConfigSnapshot(canonicalTarget)
    if (initial.kind === 'unsafe') return { status: 'refused-unsafe-target', canonicalRoot }
    if (initial.kind === 'conflict') return { status: 'refused-conflict', canonicalRoot }
    if (initial.kind === 'changed') continue

    const merged = mergeCodexWorkspaceTrust(initial.kind === 'existing' ? initial.content : '', canonicalRoot)
    if (merged === 'conflict') return { status: 'refused-conflict', canonicalRoot }
    if (!merged.modified) return { status: 'already-present', canonicalRoot }

    const targetDir = path.dirname(canonicalTarget)
    if (!existsSync(targetDir)) {
      try {
        mkdirSync(targetDir, { recursive: true, mode: 0o700 })
      } catch {
        return { status: 'failed', canonicalRoot }
      }
    }

    const temp = path.join(
      targetDir,
      `.${path.basename(canonicalTarget)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let fd: number | undefined
    try {
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, merged.content, 'utf8')
      if (initial.kind === 'existing') chmodSync(temp, initial.snapshot.mode & 0o7777)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined

      if (!validateHomeIdentity(realHome, homeIdentity)
        || pathHasSymlinkComponent(canonicalTarget, realHome)) {
        return { status: 'refused-unsafe-target', canonicalRoot }
      }

      if (initial.kind === 'absent') {
        try {
          linkSync(temp, canonicalTarget)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return { status: 'refused-conflict', canonicalRoot }
          }
          throw error
        }
      } else {
        const latest = readTomlConfigSnapshot(canonicalTarget)
        if (latest.kind === 'unsafe') return { status: 'refused-unsafe-target', canonicalRoot }
        if (latest.kind !== 'existing' || !sameJsonSnapshot(initial.snapshot, latest.snapshot)) continue
        renameSync(temp, canonicalTarget)
      }
      return { status: 'installed', canonicalRoot }
    } catch (error) {
      console.warn('[daemon] workspace_trust.seed_failed', {
        agentKey: input.agentKey,
        cwdSource: input.cwdSource,
        error: error instanceof Error ? error.message : String(error),
      })
      return { status: 'failed', canonicalRoot }
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* already closed */ }
      }
      try { unlinkSync(temp) } catch { /* linked, renamed, or never created */ }
    }
  }
  return { status: 'refused-conflict', canonicalRoot }
}

type WorkspaceTrustAdapter = (input: WorkspaceTrustSeedInput, canonicalRoot: string) => WorkspaceTrustSeedResult
type WorkspaceTrustProbe = (
  input: WorkspaceTrustSeedInput,
  canonicalRoot: string,
) => boolean

const WORKSPACE_TRUST_ADAPTERS: Readonly<Record<string, WorkspaceTrustAdapter>> = {
  kimi: seedKimiWorkspaceTrust,
  claude: seedClaudeWorkspaceTrust,
  agy: seedAgyWorkspaceTrust,
  codex: seedCodexWorkspaceTrust,
}

const WORKSPACE_TRUST_PROBES: Readonly<Record<string, WorkspaceTrustProbe>> = {
  claude: probeClaudeWorkspaceTrust,
}

const STARTUP_GATE_SEED_REASON_STATUSES: ReadonlySet<WorkspaceTrustSeedStatus> = new Set([
  'refused-invalid-cwd',
  'refused-unsafe-target',
  'refused-conflict',
  'failed',
  'refused-no-provenance',
  'refused-sched-containment',
])


/**
 * Generic provenance gate and provider-adapter dispatch. Adding another provider
 * changes only the registry and its adapter, never the spawn consumer.
 */
export function seedWorkspaceTrust(input: WorkspaceTrustSeedInput): WorkspaceTrustSeedResult {
  const adapter = WORKSPACE_TRUST_ADAPTERS[input.agentKey]
  if (!adapter) return { status: 'skipped-agent' }
  if (input.cwdSource === 'server_project') return { status: 'skipped-server-project' }
  if (input.cwdSource === 'fallback_home') return { status: 'skipped-fallback-home' }

  // Trusted human provenance should seed orchestrator-owned workers exactly
  // like manual panels. Seed-reason outcomes must remain silent for those
  // workers, though: the caller turns each status listed above into a readiness
  // veto, which would otherwise wedge the queued orchestration input.
  const finish = (result: WorkspaceTrustSeedResult): WorkspaceTrustSeedResult =>
    input.orchestratorOwned && STARTUP_GATE_SEED_REASON_STATUSES.has(result.status)
      ? { status: 'skipped-orchestrator' }
      : result

  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync.native(input.cwd)
    if (!lstatSync(canonicalRoot).isDirectory()) return finish({ status: 'refused-invalid-cwd' })
  } catch {
    return finish({ status: 'refused-invalid-cwd' })
  }

  if (WORKSPACE_TRUST_PROBES[input.agentKey]?.(input, canonicalRoot) === true) {
    return { status: 'already-present', canonicalRoot }
  }

  if (input.cwdSource === 'local_override' && input.setVia !== 'cli') {
    return finish({ status: 'refused-no-provenance' })
  }
  if (input.cwdSource === 'daemon_override' && input.setVia === 'sched_worktree') {
    // Scoped widening (fix round 3): the server forwards `sched_worktree` only
    // when the schedule's parent project binding is human-set ('ui'/'cli') —
    // that is the human anchor, asserted server-side. The daemon adds the
    // filesystem half: canonical, symlink-safe containment of the cwd in the
    // `.jerico/sched` namespace (see schedWorktreeContainmentFailed). A
    // containment failure is provenance OFFERED but unverified — a distinct
    // status, never `refused-no-provenance`.
    if (schedWorktreeContainmentFailed(input.cwd, canonicalRoot)) {
      return finish({ status: 'refused-sched-containment' })
    }
  } else if (input.cwdSource === 'daemon_override' && input.setVia !== 'cli' && input.setVia !== 'ui') {
    // A UI-set binding is a human act (so we trust it), even though it was not necessarily
    // performed on the machine that owns the files. This is acceptable because a user explicitly
    // clicked through the UI to bind this path, establishing clear intent and provenance.
    return finish({ status: 'refused-no-provenance' })
  }

  return finish(adapter(input, canonicalRoot))
}
