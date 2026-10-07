import { hookScriptPath } from './script.js'
import {
  HOOK_ENV_EVENT_NAME,
  HOOK_ENV_STDOUT,
  PROVIDER_EVENT_TURN_ENDED
} from './protocol.js'
import {
  HOOK_TARGETS,
  getHookTargetEntry,
  registerHookTarget,
  type HookTarget,
  type HookTargetRegistryEntry
} from './targets.js'
import { parse as parseToml } from 'smol-toml'
import { seedCodexTrust } from './codex-hash.js'
import path from 'path'
import os from 'os'
import { getOpenCodeConfigDir } from '../profile.js'
import { getOpenCodePluginPath, renderOpenCodePlugin } from './opencode.js'

export const HOOK_MARKER = 'JERICO_AGENT_HOOK=1'

export type InstallResult =
  | 'installed'
  | 'already-present'
  | 'refused-malformed'
  | 'target-missing'
  | 'refused-invalid-script'
  | 'refused-conflict'
  | 'refused-unsafe-target'
  | 'installer-threw'

export interface HookBlock {
  matcher: string
  jerico_hook: true
  hooks: ReadonlyArray<{ type: 'command'; command: string; timeout: number }>
}

export interface KimiHookBlock {
  event: 'Stop'
  command: string
  timeout: number
}

export interface CodexHookBlock {
  hooks: ReadonlyArray<{ type: 'command'; command: string; timeout: number }>
}

export interface AgyHookHandler {
  type: 'command'
  command: string
  timeout: number
}

/** agy's hooks.json maps a *hook name* to its events; `Stop` is a flat handler
 *  array with no matcher/hooks wrapper. This is not the codex shape. */
export interface AgyHookBlock {
  Stop: ReadonlyArray<AgyHookHandler>
}

/* ---------------- Claude implementation ---------------- */

export function renderClaudeBlock(): HookBlock {
  return {
    matcher: '*',
    jerico_hook: true,
    hooks: [
      {
        type: 'command',
        command: `${HOOK_MARKER} "${hookScriptPath()}"`,
        timeout: 2
      }
    ]
  }
}

function isOurClaudeGroup(group: any): boolean {
  if (group && group.jerico_hook === true) return true
  const expectedCmd = `${HOOK_MARKER} "${hookScriptPath()}"`
  if (group && Array.isArray(group.hooks)) {
    for (const h of group.hooks) {
      if (h && h.type === 'command' && h.command === expectedCmd) {
        return true
      }
    }
  }
  return false
}

function parseAndValidateClaude(content: string): { parsed: any; stopHooks: any[] } | 'malformed' {
  let parsed: any
  try {
    parsed = JSON.parse(content)
  } catch {
    return 'malformed'
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'malformed'
  if (parsed.hooks !== undefined) {
    if (typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks) || parsed.hooks === null) return 'malformed'
  }

  const stopHooks = parsed.hooks?.Stop
  if (stopHooks !== undefined) {
    if (!Array.isArray(stopHooks)) return 'malformed'
    for (const group of stopHooks) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) return 'malformed'
    }
  }

  return { parsed, stopHooks: stopHooks || [] }
}

export function findClaudeBlock(content: string): any {
  const validated = parseAndValidateClaude(content)
  if (validated === 'malformed') return null
  for (const group of validated.stopHooks) {
    if (isOurClaudeGroup(group)) return group
  }
  return null
}

export function spliceClaudeBlock(content: string): { content: string; status: InstallResult } {
  const validated = parseAndValidateClaude(content)
  if (validated === 'malformed') return { content, status: 'refused-malformed' }

  const { parsed, stopHooks } = validated
  const foundIndices: number[] = []
  for (let i = 0; i < stopHooks.length; i++) {
    if (isOurClaudeGroup(stopHooks[i])) {
      foundIndices.push(i)
    }
  }

  const newBlock = renderClaudeBlock()
  const finalHooks = []
  let inserted = false
  for (let i = 0; i < stopHooks.length; i++) {
    if (foundIndices.includes(i)) {
      if (!inserted) {
        finalHooks.push(newBlock)
        inserted = true
      }
    } else {
      finalHooks.push(stopHooks[i])
    }
  }
  if (!inserted) {
    finalHooks.push(newBlock)
  }

  const newConfig = {
    ...parsed,
    hooks: {
      ...(parsed.hooks || {}),
      Stop: finalHooks
    }
  }

  const newContent = JSON.stringify(newConfig, null, 2) + '\n'
  if (newContent === content) {
    return { content: newContent, status: 'already-present' }
  }

  return { content: newContent, status: 'installed' }
}

export function stripClaudeBlock(content: string): { content: string; status: InstallResult } {
  const validated = parseAndValidateClaude(content)
  if (validated === 'malformed') return { content, status: 'refused-malformed' }

  const { parsed, stopHooks } = validated
  const foundIndices: number[] = []
  for (let i = 0; i < stopHooks.length; i++) {
    if (isOurClaudeGroup(stopHooks[i])) {
      foundIndices.push(i)
    }
  }

  if (foundIndices.length === 0) return { content, status: 'already-present' }

  const finalHooks = stopHooks.filter((_, i) => !foundIndices.includes(i))
  const newConfig = {
    ...parsed,
    hooks: {
      ...(parsed.hooks || {}),
      Stop: finalHooks
    }
  }

  return { content: JSON.stringify(newConfig, null, 2) + '\n', status: 'installed' }
}

/* ---------------- Kimi implementation ---------------- */

export function renderKimiBlock(): KimiHookBlock {
  return {
    event: 'Stop',
    command: `${HOOK_MARKER} "${hookScriptPath()}"`,
    timeout: 2
  }
}

interface TomlTableRange {
  start: number
  end: number
}

interface KimiConfig {
  parsed: Record<string, unknown>
  hooks: Array<Record<string, unknown>>
  ranges: TomlTableRange[]
}

const KIMI_BEGIN = '# >>> jerico hook v1'
const KIMI_END = '# <<< jerico hook v1'

function tableHeaders(content: string): Array<{ start: number; name: string }> {
  const headers: Array<{ start: number; name: string }> = []
  let offset = 0
  let multiline: 'basic' | 'literal' | null = null

  for (const line of content.match(/.*(?:\r\n|\n|$)/g) || []) {
    if (line.length === 0) break
    if (multiline === null) {
      const match = line.match(/^[ \t]*(\[\[?)([^\]\r\n]+)(\]\]?)[ \t]*(?:#.*)?(?:\r?\n)?$/)
      if (match && ((match[1] === '[[' && match[3] === ']]') || (match[1] === '[' && match[3] === ']'))) {
        headers.push({ start: offset, name: match[2]!.trim() })
      }
    }

    let cursor = 0
    while (cursor < line.length) {
      if (multiline === 'basic') {
        const end = line.indexOf('"""', cursor)
        if (end < 0) break
        let backslashes = 0
        for (let i = end - 1; i >= 0 && line[i] === '\\'; i--) backslashes++
        cursor = end + 3
        if (backslashes % 2 === 0) multiline = null
        continue
      }
      if (multiline === 'literal') {
        const end = line.indexOf("'''", cursor)
        if (end < 0) break
        multiline = null
        cursor = end + 3
        continue
      }

      const basic = line.indexOf('"""', cursor)
      const literal = line.indexOf("'''", cursor)
      const comment = line.indexOf('#', cursor)
      const candidates = [basic, literal, comment].filter((value) => value >= 0)
      if (candidates.length === 0) break
      const next = Math.min(...candidates)
      if (next === comment) break
      multiline = next === basic ? 'basic' : 'literal'
      cursor = next + 3
    }

    offset += line.length
  }
  return headers
}

function parseKimi(content: string): KimiConfig | 'malformed' {
  let parsed: Record<string, unknown>
  try {
    const value = parseToml(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'malformed'
    parsed = value as Record<string, unknown>
  } catch {
    return 'malformed'
  }

  const headers = tableHeaders(content)
  const hookHeaders = headers.filter((header) => header.name === 'hooks')
  const rawHooks = parsed.hooks
  if (rawHooks === undefined) {
    if (hookHeaders.length !== 0) return 'malformed'
    return { parsed, hooks: [], ranges: [] }
  }
  if (!Array.isArray(rawHooks) || rawHooks.some((hook) => !hook || typeof hook !== 'object' || Array.isArray(hook))) {
    return 'malformed'
  }
  if (rawHooks.length !== hookHeaders.length) return 'malformed'

  const ranges = hookHeaders.map((header) => {
    const headerIndex = headers.indexOf(header)
    const next = headers[headerIndex + 1]
    let start = header.start
    const prefix = content.slice(0, start)
    const markerMatch = prefix.match(/(?:^|\r?\n)(# >>> jerico hook v1[^\r\n]*)(?:\r?\n)$/)
    if (markerMatch) start -= markerMatch[0].length - (markerMatch[0].startsWith('\n') || markerMatch[0].startsWith('\r\n') ? markerMatch[0].match(/^\r?\n/)![0].length : 0)
    return { start, end: next?.start ?? content.length }
  })

  return { parsed, hooks: rawHooks as Array<Record<string, unknown>>, ranges }
}

function isOurKimiHook(hook: Record<string, unknown>): boolean {
  return hook.event === 'Stop' && hook.command === `${HOOK_MARKER} "${hookScriptPath()}"`
}

function isCanonicalKimiHook(hook: Record<string, unknown>): boolean {
  return isOurKimiHook(hook) && hook.timeout === 2 && Object.keys(hook).length === 3
}

function renderKimiTable(content: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const addedSeparator = content.length > 0 && !content.endsWith('\n')
  const separator = addedSeparator ? eol : ''
  const marker = `${KIMI_BEGIN} separator=${addedSeparator ? 'added' : 'kept'}`
  const block = renderKimiBlock()
  return `${separator}${marker}${eol}[[hooks]]${eol}event = "Stop"${eol}command = ${JSON.stringify(block.command)}${eol}timeout = 2${eol}${KIMI_END}${eol}`
}

function removeKimiRanges(content: string, config: KimiConfig, ownedIndices: number[]): string {
  let result = content
  for (const index of [...ownedIndices].sort((a, b) => b - a)) {
    const range = config.ranges[index]!
    let start = range.start
    if (content.slice(start).startsWith(`${KIMI_BEGIN} separator=added`) && start > 0) {
      if (content.slice(start - 2, start) === '\r\n') start -= 2
      else if (content[start - 1] === '\n') start -= 1
    }
    result = result.slice(0, start) + result.slice(range.end)
  }
  return result
}

export function findKimiBlock(content: string): any {
  const validated = parseKimi(content)
  if (validated === 'malformed') return null
  return validated.hooks.find(isOurKimiHook) || null
}

export function spliceKimiBlock(content: string): { content: string; status: InstallResult } {
  const validated = parseKimi(content)
  if (validated === 'malformed') return { content, status: 'refused-malformed' }
  const owned = validated.hooks.flatMap((hook, index) => (isOurKimiHook(hook) ? [index] : []))
  if (owned.length === 1 && isCanonicalKimiHook(validated.hooks[owned[0]!]!)) {
    return { content, status: 'already-present' }
  }
  const withoutOwned = removeKimiRanges(content, validated, owned)
  return { content: withoutOwned + renderKimiTable(withoutOwned), status: 'installed' }
}

export function stripKimiBlock(content: string): { content: string; status: InstallResult } {
  const validated = parseKimi(content)
  if (validated === 'malformed') return { content, status: 'refused-malformed' }
  const owned = validated.hooks.flatMap((hook, index) => (isOurKimiHook(hook) ? [index] : []))
  if (owned.length === 0) return { content, status: 'already-present' }
  return { content: removeKimiRanges(content, validated, owned), status: 'installed' }
}

/* ---------------- Codex implementation ---------------- */

export function renderCodexBlock(): CodexHookBlock {
  return {
    hooks: [
      {
        type: 'command',
        command: `${HOOK_MARKER} "${hookScriptPath()}"`,
        timeout: 2
      }
    ]
  }
}

function parseAndValidateCodex(content: string): { parsed: any; stopHooks: any[] } | 'malformed' {
  let parsed: any
  try {
    parsed = JSON.parse(content)
  } catch {
    return 'malformed'
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'malformed'
  if (parsed.hooks !== undefined) {
    if (typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks) || parsed.hooks === null) return 'malformed'
  }

  const stopHooks = parsed.hooks?.Stop
  if (stopHooks !== undefined) {
    if (!Array.isArray(stopHooks)) return 'malformed'
    for (const group of stopHooks) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) return 'malformed'
    }
  }

  return { parsed, stopHooks: stopHooks || [] }
}

export function isJericoHookCommand(command: string): boolean {
  if (typeof command !== 'string' || !command.startsWith(HOOK_MARKER)) return false
  const match = command.match(/^JERICO_AGENT_HOOK=1 "([^"]+)"$/)
  if (!match) return false
  return match[1]!.endsWith('jerico-hook.sh')
}

function isOurCodexGroup(group: any): boolean {
  if (!group || typeof group !== 'object') return false
  if (Array.isArray(group.hooks)) {
    for (const h of group.hooks) {
      if (h && h.type === 'command' && isJericoHookCommand(h.command)) {
        return true
      }
    }
  }
  return false
}

function isCanonicalCodexGroup(group: any): boolean {
  if (!isOurCodexGroup(group)) return false
  if (group.matcher !== undefined) return false
  if (!Array.isArray(group.hooks) || group.hooks.length !== 1) return false
  const h = group.hooks[0]
  return h.type === 'command' && h.command === `${HOOK_MARKER} "${hookScriptPath()}"` && h.timeout === 2 && Object.keys(h).length === 3
}

export function findCodexBlock(content: string): any {
  const validated = parseAndValidateCodex(content)
  if (validated === 'malformed') return null
  return validated.stopHooks.find(isOurCodexGroup) || null
}

export function spliceCodexBlock(content: string): { content: string; status: InstallResult } {
  const validated = parseAndValidateCodex(content)
  if (validated === 'malformed') return { content, status: 'refused-malformed' }

  const { parsed, stopHooks } = validated
  const canonicalHandler = { type: 'command', command: `${HOOK_MARKER} "${hookScriptPath()}"`, timeout: 2 }

  let totalOwnedCount = 0
  for (const group of stopHooks) {
    if (!group || typeof group !== 'object') continue
    const currentHooks = Array.isArray(group.hooks) ? group.hooks : []
    for (const h of currentHooks) {
      if (h && typeof h === 'object' && h.type === 'command' && isJericoHookCommand(h.command)) {
        totalOwnedCount++
      }
    }
  }

  let jericoHandlerFound = false
  const updatedStopHooks: any[] = []

  for (const group of stopHooks) {
    if (!group || typeof group !== 'object') {
      updatedStopHooks.push(group)
      continue
    }

    const currentHooks = Array.isArray(group.hooks) ? group.hooks : []
    const updatedHooks: any[] = []
    let groupHadJerico = false

    for (const h of currentHooks) {
      if (h && typeof h === 'object' && h.type === 'command' && isJericoHookCommand(h.command)) {
        groupHadJerico = true
        if (!jericoHandlerFound) {
          jericoHandlerFound = true
          updatedHooks.push(canonicalHandler)
        }
      } else {
        updatedHooks.push(h)
      }
    }

    const otherKeys = Object.keys(group).filter((k) => k !== 'hooks')
    const hasOtherState = otherKeys.length > 0
    if (updatedHooks.length > 0 || hasOtherState || !groupHadJerico) {
      updatedStopHooks.push({
        ...group,
        hooks: updatedHooks
      })
    }
  }

  if (!jericoHandlerFound) {
    updatedStopHooks.push(renderCodexBlock())
  }

  const newConfig = {
    ...parsed,
    hooks: {
      ...(parsed.hooks || {}),
      Stop: updatedStopHooks
    }
  }

  const newContent = JSON.stringify(newConfig, null, 2) + '\n'

  if (totalOwnedCount === 1 && newContent === content) {
    return { content, status: 'already-present' }
  }

  return { content: newContent, status: 'installed' }
}

export function stripCodexBlock(content: string): { content: string; status: InstallResult } {
  const validated = parseAndValidateCodex(content)
  if (validated === 'malformed') return { content, status: 'refused-malformed' }

  const { parsed, stopHooks } = validated
  let jericoHandlerFound = false
  const updatedStopHooks: any[] = []

  for (const group of stopHooks) {
    if (!group || typeof group !== 'object') {
      updatedStopHooks.push(group)
      continue
    }

    const currentHooks = Array.isArray(group.hooks) ? group.hooks : []
    const remainingHooks: any[] = []
    let groupHadJericoHandler = false

    for (const h of currentHooks) {
      if (h && typeof h === 'object' && h.type === 'command' && isJericoHookCommand(h.command)) {
        jericoHandlerFound = true
        groupHadJericoHandler = true
      } else {
        remainingHooks.push(h)
      }
    }

    if (!groupHadJericoHandler) {
      updatedStopHooks.push(group)
    } else {
      const otherKeys = Object.keys(group).filter((k) => k !== 'hooks')
      const hasOtherState = otherKeys.length > 0
      if (remainingHooks.length > 0 || hasOtherState) {
        updatedStopHooks.push({
          ...group,
          hooks: remainingHooks
        })
      }
    }
  }

  if (!jericoHandlerFound) return { content, status: 'already-present' }

  const newConfig = {
    ...parsed,
    hooks: {
      ...(parsed.hooks || {}),
      Stop: updatedStopHooks
    }
  }

  return { content: JSON.stringify(newConfig, null, 2) + '\n', status: 'installed' }
}

/* ---------------- agy (Antigravity CLI) implementation ---------------- */

/** The single top-level named hook we own in ~/.gemini/config/hooks.json. */
export const AGY_HOOK_NAME = 'jerico'
const AGY_HOOK_TIMEOUT = 10

/** agy's Stop payload carries no event-name field and the CLI reads a decision
 *  from stdout, so the managed command declares both to the shared script.
 *  `{"decision":""}` means "do not block the stop" — anything containing
 *  "continue" would re-enter the agent loop. */
export function renderAgyCommand(): string {
  return `${HOOK_ENV_EVENT_NAME}=${PROVIDER_EVENT_TURN_ENDED} ${HOOK_ENV_STDOUT}='{"decision":""}' ${HOOK_MARKER} "${hookScriptPath()}"`
}

export function renderAgyBlock(): AgyHookBlock {
  return {
    Stop: [
      {
        type: 'command',
        command: renderAgyCommand(),
        timeout: AGY_HOOK_TIMEOUT
      }
    ]
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Ownership is the marker plus a quoted path to our own script, so a
 *  user-authored handler under the same hook name is never claimed. */
export function isOurAgyHandler(handler: unknown): boolean {
  if (!isPlainObject(handler)) return false
  if (handler.type !== 'command') return false
  const command = handler.command
  if (typeof command !== 'string') return false
  if (!command.includes(HOOK_MARKER)) return false
  const match = command.match(/"([^"]+)"\s*$/)
  return !!match && match[1]!.endsWith('jerico-hook.sh')
}

function isCanonicalAgyHandler(handler: unknown): boolean {
  if (!isOurAgyHandler(handler)) return false
  const h = handler as Record<string, unknown>
  return (
    h.command === renderAgyCommand() &&
    h.timeout === AGY_HOOK_TIMEOUT &&
    Object.keys(h).length === 3
  )
}

interface AgyConfig {
  parsed: Record<string, unknown>
  jerico: Record<string, unknown>
  stop: unknown[]
}

function parseAndValidateAgy(content: string): AgyConfig | 'malformed' {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return 'malformed'
  }
  if (!isPlainObject(parsed)) return 'malformed'

  const rawJerico = parsed[AGY_HOOK_NAME]
  if (rawJerico !== undefined && !isPlainObject(rawJerico)) return 'malformed'
  const jerico: Record<string, unknown> = isPlainObject(rawJerico) ? rawJerico : {}

  const rawStop = jerico.Stop
  if (rawStop !== undefined) {
    if (!Array.isArray(rawStop)) return 'malformed'
    for (const handler of rawStop) {
      if (!isPlainObject(handler)) return 'malformed'
    }
  }

  return { parsed, jerico, stop: Array.isArray(rawStop) ? rawStop : [] }
}

function serializeAgy(parsed: Record<string, unknown>): string {
  return JSON.stringify(parsed, null, 2) + '\n'
}

export function findAgyBlock(content: string): unknown {
  const validated = parseAndValidateAgy(content)
  if (validated === 'malformed') return null
  return validated.stop.find(isOurAgyHandler) ?? null
}

export function spliceAgyBlock(content: string): { content: string; status: InstallResult } {
  const validated = parseAndValidateAgy(content)
  if (validated === 'malformed') return { content, status: 'refused-malformed' }

  const { parsed, jerico, stop } = validated
  const canonical = renderAgyBlock().Stop[0]!
  const ownedCount = stop.filter(isOurAgyHandler).length

  const finalStop: unknown[] = []
  let inserted = false
  for (const handler of stop) {
    if (isOurAgyHandler(handler)) {
      if (!inserted) {
        finalStop.push(canonical)
        inserted = true
      }
      continue
    }
    finalStop.push(handler)
  }
  if (!inserted) finalStop.push(canonical)

  const newContent = serializeAgy({
    ...parsed,
    [AGY_HOOK_NAME]: { ...jerico, Stop: finalStop }
  })

  if (ownedCount === 1 && isCanonicalAgyHandler(stop.find(isOurAgyHandler)) && newContent === content) {
    return { content, status: 'already-present' }
  }
  return { content: newContent, status: 'installed' }
}

export function stripAgyBlock(content: string): { content: string; status: InstallResult } {
  const validated = parseAndValidateAgy(content)
  if (validated === 'malformed') return { content, status: 'refused-malformed' }

  const { parsed, jerico, stop } = validated
  const remaining = stop.filter(handler => !isOurAgyHandler(handler))
  if (remaining.length === stop.length) return { content, status: 'already-present' }

  const nextJerico: Record<string, unknown> = { ...jerico }
  if (remaining.length > 0) nextJerico.Stop = remaining
  else delete nextJerico.Stop

  const nextParsed: Record<string, unknown> = { ...parsed }
  if (Object.keys(nextJerico).length > 0) nextParsed[AGY_HOOK_NAME] = nextJerico
  else delete nextParsed[AGY_HOOK_NAME]

  return { content: serializeAgy(nextParsed), status: 'installed' }
}

registerHookTarget({
  target: 'claude',
  installKind: 'config-block',
  format: 'json',
  getTargetFile: () => process.env.JERICO_CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json'),
  renderBlock: renderClaudeBlock,
  findBlock: findClaudeBlock,
  spliceBlock: spliceClaudeBlock,
  stripBlock: stripClaudeBlock
})

registerHookTarget({
  target: 'kimi',
  installKind: 'config-block',
  format: 'toml',
  getTargetFile: () => path.join(process.env.HOME || os.homedir(), '.kimi-code', 'config.toml'),
  renderBlock: renderKimiBlock,
  findBlock: findKimiBlock,
  spliceBlock: spliceKimiBlock,
  stripBlock: stripKimiBlock
})

registerHookTarget({
  target: 'codex',
  installKind: 'config-block',
  format: 'json',
  getTargetFile: () => process.env.JERICO_CODEX_HOOKS_PATH || path.join(process.env.HOME || os.homedir(), '.codex', 'hooks.json'),
  renderBlock: renderCodexBlock,
  findBlock: findCodexBlock,
  spliceBlock: spliceCodexBlock,
  stripBlock: stripCodexBlock,
  trustSeeder: seedCodexTrust,
  seedWhenMissing: () => '{}\n'
})


registerHookTarget({
  target: 'agy',
  installKind: 'config-block',
  format: 'json',
  getTargetFile: () =>
    process.env.JERICO_AGY_HOOKS_PATH || path.join(os.homedir(), '.gemini', 'config', 'hooks.json'),
  renderBlock: renderAgyBlock,
  findBlock: findAgyBlock,
  spliceBlock: spliceAgyBlock,
  stripBlock: stripAgyBlock,
  // The Antigravity CLI writes ~/.gemini/config/hooks.json only when the user
  // runs /hooks in its TUI, so on most machines it is simply absent. The file
  // holds nothing but hooks, so creating an empty one is safe — unlike
  // ~/.claude/settings.json, which also holds the user's own settings.
  seedWhenMissing: () => '{}\n'
})

registerHookTarget({
  target: 'opencode',
  installKind: 'plugin-file',
  getTargetFile: getOpenCodePluginPath,
  renderFile: renderOpenCodePlugin,
  getSpawnEnv: () => ({ OPENCODE_CONFIG_DIR: getOpenCodeConfigDir() })
})

/* ---------------- Exported Dispatchers ---------------- */

export function renderBlock(target: 'claude'): HookBlock
export function renderBlock(target: 'kimi'): KimiHookBlock
export function renderBlock(target: 'codex'): CodexHookBlock
export function renderBlock(target: 'agy'): AgyHookBlock
export function renderBlock(target: HookTarget): HookBlock | KimiHookBlock | CodexHookBlock | AgyHookBlock
export function renderBlock(target: HookTarget): any {
  const entry = getHookTargetEntry(target)
  if (entry?.installKind === 'config-block') {
    return entry.renderBlock()
  }
  switch (target) {
    case 'claude':
    case 'kimi':
    case 'codex':
    case 'opencode':
    case 'agy':
      throw new Error(`renderBlock: missing registry entry for target ${target}`)
    default: {
      const unhandled: never = target
      throw new Error(`renderBlock: no block shape implemented for target ${String(unhandled)}`)
    }
  }
}

export function findBlock(target: string, content: string): any {
  const entry = getHookTargetEntry(target)
  if (!entry || entry.installKind !== 'config-block') return null
  return entry.findBlock(content)
}

export function spliceBlock(target: string, content: string): { content: string; status: InstallResult } {
  const entry = getHookTargetEntry(target)
  if (!entry || entry.installKind !== 'config-block') return { content, status: 'refused-malformed' }
  return entry.spliceBlock(content)
}

export function stripBlock(target: string, content: string): { content: string; status: InstallResult } {
  const entry = getHookTargetEntry(target)
  if (!entry || entry.installKind !== 'config-block') return { content, status: 'refused-malformed' }
  return entry.stripBlock(content)
}
