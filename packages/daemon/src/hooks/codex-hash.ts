import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { hookScriptPath } from './script.js'
import { isJericoHookCommand } from './block.js'
import { atomicWrite, readTargetFile, resolveRealTargetFile } from './install.js'

const HOOK_MARKER = 'JERICO_AGENT_HOOK=1'
const CANONICAL_CODEX_HASH = /^sha256:[a-f0-9]{64}$/

/**
 * Structural equality check for Jerico's managed Codex hook handler.
 * Item 1 Rule: eventName MUST be 'Stop' exactly (case-sensitive).
 * Command MUST equal exactly JERICO_AGENT_HOOK=1 "<scriptPath>".
 */
export function isOurCodexHandler(
  eventName: string,
  handler: any,
  scriptPath: string = hookScriptPath()
): boolean {
  if (typeof eventName !== 'string' || eventName !== 'Stop') return false
  if (!handler || typeof handler !== 'object' || Array.isArray(handler)) return false
  if (handler.type !== 'command') return false
  if (typeof handler.command !== 'string') return false
  const expectedCommand = `${HOOK_MARKER} "${scriptPath}"`
  if (handler.command !== expectedCommand) return false
  const timeout = handler.timeout ?? 600
  if (timeout !== 2) return false
  if (handler.async !== undefined && handler.async !== false) return false
  if (handler.statusMessage !== undefined) return false
  return true
}

export function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

export function sortKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sortKeys)
  const sorted: Record<string, any> = {}
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key])
  }
  return sorted
}

export function computeCodexHookHash(
  eventName: string,
  matcher: string | undefined,
  handlerRaw: { type?: string; command: string; timeout?: number; async?: boolean; statusMessage?: string }
): string {
  const snakeCaseEvent = toSnakeCase(eventName)
  const handler = {
    type: handlerRaw.type || 'command',
    command: handlerRaw.command,
    timeout: Math.max(1, handlerRaw.timeout ?? 600),
    async: handlerRaw.async ?? false,
    ...(handlerRaw.statusMessage !== undefined ? { statusMessage: handlerRaw.statusMessage } : {})
  }

  const isDroppedMatcher = snakeCaseEvent === 'stop' || snakeCaseEvent === 'user_prompt_submit'
  const identity: Record<string, unknown> = {
    event_name: snakeCaseEvent,
    hooks: [handler]
  }
  if (!isDroppedMatcher && matcher !== undefined) {
    identity.matcher = matcher
  }

  const sorted = sortKeys(identity)
  const serialized = JSON.stringify(sorted)
  const hashHex = crypto.createHash('sha256').update(serialized).digest('hex')
  return 'sha256:' + hashHex
}

export function getJericoExpectedCodexHash(scriptPath: string = hookScriptPath()): string {
  return computeCodexHookHash('Stop', undefined, {
    type: 'command',
    command: `${HOOK_MARKER} "${scriptPath}"`,
    timeout: 2
  })
}

export function extractJericoHashesFromHooksJson(content: string, hooksJsonPath: string): string[] {
  const hashes: string[] = []
  if (!content || content.trim().length === 0) return hashes
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && parsed.hooks && typeof parsed.hooks === 'object') {
      for (const [eventName, groups] of Object.entries<any>(parsed.hooks)) {
        if (!Array.isArray(groups)) continue
        for (let gIdx = 0; gIdx < groups.length; gIdx++) {
          const group = groups[gIdx]
          if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue
          const matcher = group.matcher
          for (let hIdx = 0; hIdx < group.hooks.length; hIdx++) {
            const handler = group.hooks[hIdx]
            if (handler && typeof handler === 'object' && handler.type === 'command' && isJericoHookCommand(handler.command)) {
              hashes.push(computeCodexHookHash(eventName, matcher, handler))
            }
          }
        }
      }
    }
  } catch {}
  return hashes
}

/* ---------------- Transaction Lock ---------------- */

let lockChain = Promise.resolve()

export function withCodexLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lockChain.then(fn, fn)
  lockChain = next.then(() => {}, () => {})
  return next
}

/* ---------------- Trust Ledger ---------------- */

export interface LedgerEntry {
  key: string
  seededHash: string
  insertedSep?: boolean
}

export interface LedgerData {
  keys: LedgerEntry[]
}

function getTrustLedgerPath(hooksJsonPath: string): string {
  if (process.env.JERICO_CODEX_TRUST_LEDGER_PATH) {
    return process.env.JERICO_CODEX_TRUST_LEDGER_PATH
  }
  return path.join(path.dirname(hooksJsonPath), '.jerico-codex-trust.json')
}

/* ---------------- Syntax-Aware TOML Parser & Splicer ---------------- */

export interface TomlTableSpan {
  headerKey: string // e.g. '/path/hooks.json:stop:1:0'
  start: number     // byte index of '[' header line start
  end: number       // byte index after last assignment in section
  fullEnd: number   // byte index where next section header or EOF starts
}

type TomlMultilineState = 'basic' | 'literal' | null

function isBackslashEscaped(value: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) backslashes++
  return backslashes % 2 === 1
}

/**
 * Advance TOML string state across one physical line. A comment begins only
 * outside quoted strings; inside a multiline string every byte, including #,
 * remains string content until the matching delimiter.
 */
function advanceTomlMultilineState(line: string, initial: TomlMultilineState): TomlMultilineState {
  let multiline = initial
  let cursor = 0

  while (cursor < line.length) {
    if (multiline === 'basic') {
      if (line.startsWith('"""', cursor) && !isBackslashEscaped(line, cursor)) {
        multiline = null
        cursor += 3
      } else {
        cursor++
      }
      continue
    }

    if (multiline === 'literal') {
      if (line.startsWith("'''", cursor)) {
        multiline = null
        cursor += 3
      } else {
        cursor++
      }
      continue
    }

    if (line[cursor] === '#') break

    if (line.startsWith('"""', cursor)) {
      multiline = 'basic'
      cursor += 3
      continue
    }

    if (line.startsWith("'''", cursor)) {
      multiline = 'literal'
      cursor += 3
      continue
    }

    if (line[cursor] === '"') {
      cursor++
      while (cursor < line.length) {
        if (line[cursor] === '"' && !isBackslashEscaped(line, cursor)) {
          cursor++
          break
        }
        cursor++
      }
      continue
    }

    if (line[cursor] === "'") {
      const closingQuote = line.indexOf("'", cursor + 1)
      cursor = closingQuote < 0 ? line.length : closingQuote + 1
      continue
    }

    cursor++
  }

  return multiline
}

export function findTomlStateSpans(content: string): TomlTableSpan[] {
  const spans: TomlTableSpan[] = []
  let multiline: TomlMultilineState = null
  let currentSpan: { headerKey: string; start: number; lastAssignmentEnd: number } | null = null
  let offset = 0

  const lines = content.match(/.*(?:\r\n|\n|$)/g) || []
  for (const line of lines) {
    if (line.length === 0) break

    if (multiline === null) {
      const match = line.match(/^[ \t]*\[hooks\.state\."([^"]+)"\][ \t]*(?:#.*)?(?:\r?\n)?$/)
      if (match) {
        if (currentSpan) {
          spans.push({
            headerKey: currentSpan.headerKey,
            start: currentSpan.start,
            end: currentSpan.lastAssignmentEnd,
            fullEnd: offset
          })
        }
        currentSpan = {
          headerKey: match[1]!,
          start: offset,
          lastAssignmentEnd: offset + line.length
        }
      } else {
        const anyHeader = line.match(/^[ \t]*(\[\[?)([^\]\r\n]+)(\]\]?)[ \t]*(?:#.*)?(?:\r?\n)?$/)
        if (anyHeader && ((anyHeader[1] === '[' && anyHeader[3] === ']') || (anyHeader[1] === '[[' && anyHeader[3] === ']]'))) {
          if (currentSpan) {
            spans.push({
              headerKey: currentSpan.headerKey,
              start: currentSpan.start,
              end: currentSpan.lastAssignmentEnd,
              fullEnd: offset
            })
            currentSpan = null
          }
        } else if (currentSpan) {
          const isComment = /^[ \t]*#/.test(line)
          const isEmpty = /^[ \t]*(?:\r?\n)?$/.test(line)
          if (!isComment && !isEmpty) {
            currentSpan.lastAssignmentEnd = offset + line.length
          }
        }
      }
    } else if (currentSpan) {
      currentSpan.lastAssignmentEnd = offset + line.length
    }

    multiline = advanceTomlMultilineState(line, multiline)

    offset += line.length
  }

  if (currentSpan) {
    spans.push({
      headerKey: currentSpan.headerKey,
      start: currentSpan.start,
      end: currentSpan.lastAssignmentEnd,
      fullEnd: offset
    })
  }

  return spans
}

type SyntaxAwareTrustedHash =
  | { kind: 'supported'; hash: string; start: number; end: number; indent: string; suffix: string }
  | { kind: 'unsupported' }
  | { kind: 'absent' }

function inspectSyntaxAwareTrustedHash(spanText: string): SyntaxAwareTrustedHash {
  let multiline: TomlMultilineState = null
  const lines = spanText.match(/.*(?:\r\n|\n|$)/g) || []
  let offset = 0

  for (const line of lines) {
    if (line.length === 0) break

    if (multiline === null) {
      const match = line.match(/^([ \t]*)trusted_hash[ \t]*=[ \t]*"([^"]*)"([ \t]*(?:#.*)?(?:\r?\n)?)$/)
      if (match) {
        return {
          kind: 'supported',
          hash: match[2]!,
          start: offset,
          end: offset + line.length,
          indent: match[1]!,
          suffix: match[3]!
        }
      }
      if (/^[ \t]*trusted_hash[ \t]*=/.test(line)) {
        return { kind: 'unsupported' }
      }
    }

    multiline = advanceTomlMultilineState(line, multiline)

    offset += line.length
  }
  return { kind: 'absent' }
}

export function getSyntaxAwareTrustedHash(spanText: string): string | null {
  const field = inspectSyntaxAwareTrustedHash(spanText)
  return field.kind === 'supported' ? field.hash : null
}

export function setSyntaxAwareTrustedHash(spanText: string, newHash: string, _eol: string): string {
  const field = inspectSyntaxAwareTrustedHash(spanText)
  if (field.kind !== 'supported') {
    throw new Error('setSyntaxAwareTrustedHash: trusted_hash is missing or not a supported double-quoted string')
  }

  const replacement = `${field.indent}trusted_hash = "${newHash}"${field.suffix}`
  return spanText.slice(0, field.start) + replacement + spanText.slice(field.end)
}

function insertTrustedHashAfterHeader(spanText: string, newHash: string, eol: string): string {
  const headerEol = spanText.match(/\r?\n/)
  if (!headerEol || headerEol.index === undefined) {
    return `${spanText}${eol}trusted_hash = "${newHash}"${eol}`
  }

  const insertAt = headerEol.index + headerEol[0].length
  return spanText.slice(0, insertAt) +
    `trusted_hash = "${newHash}"${eol}` +
    spanText.slice(insertAt)
}

export function updateTomlTrustState(
  configContent: string,
  keysToUpdate: Array<{ key: string; hash: string; insertedSep?: boolean; reclaimAbsent?: boolean }>,
  keysToRemove: Array<{ key: string; seededHash?: string; insertedSep?: boolean }>
): string {
  if (keysToUpdate.length === 0 && keysToRemove.length === 0) {
    return configContent
  }

  const hasOriginalEol = configContent.endsWith('\n') || configContent.endsWith('\r')

  if (configContent.trim().length > 0) {
    try {
      parseToml(configContent)
    } catch (err) {
      throw new Error(`updateTomlTrustState: invalid input TOML content: ${err}`)
    }
  }

  let result = configContent
  const eol = configContent.includes('\r\n') ? '\r\n' : '\n'

  // 1. Prune keys in keysToRemove. Right-to-left evaluation lets an earlier
  // owned table become the terminal survivor after later owned tables are removed.
  const initialSpans = findTomlStateSpans(result)
  const removalQueue = keysToRemove
    .map((entry, index) => ({
      entry,
      index,
      start: initialSpans.find((span) => span.headerKey === entry.key)?.start ?? -1
    }))
    .sort((a, b) => b.start - a.start || a.index - b.index)

  for (const { entry: { key, seededHash, insertedSep } } of removalQueue) {
    const spans = findTomlStateSpans(result)
    const targetSpan = spans.find((s) => s.headerKey === key)
    if (targetSpan) {
      // At EOF, comments and blank lines after the last assignment still belong
      // to this table. Before another header, that inter-table trivia is retained
      // with the following table rather than treated as content owned by this one.
      const tableEnd = targetSpan.fullEnd === result.length ? targetSpan.fullEnd : targetSpan.end
      const spanText = result.slice(targetSpan.start, tableEnd)
      const trustedHash = inspectSyntaxAwareTrustedHash(spanText)
      if (!seededHash || trustedHash.kind !== 'supported' || trustedHash.hash !== seededHash) {
        // Without a readable exact match, ownership is not proven: relinquish.
        continue
      }

      const headerEnd = spanText.search(/\r?\n/)
      const ownedHeaderEnd = headerEnd < 0 ? spanText.length : headerEnd + (spanText[headerEnd] === '\r' ? 2 : 1)
      const suffixWithoutEol = trustedHash.suffix.replace(/\r?\n$/, '')
      const preservedLineSuffix = suffixWithoutEol.length > 0 ? trustedHash.suffix : ''
      const foreignContent =
        spanText.slice(ownedHeaderEnd, trustedHash.start) +
        preservedLineSuffix +
        spanText.slice(trustedHash.end)

      if (foreignContent.length > 0) {
        const retainedTable =
          spanText.slice(0, trustedHash.start) +
          preservedLineSuffix +
          spanText.slice(trustedHash.end)
        result = result.slice(0, targetSpan.start) + retainedTable + result.slice(tableEnd)
        continue
      }

      let deleteStart = targetSpan.start
      const headerLine = spanText.split(/\r?\n/)[0] || ''
      const isSepInserted = insertedSep ?? /# jerico_sep=1/.test(headerLine)
      if (isSepInserted && tableEnd === result.length) {
        if (deleteStart > 0 && result[deleteStart - 1] === '\n') {
          deleteStart -= 1
          if (deleteStart > 0 && result[deleteStart - 1] === '\r') {
            deleteStart -= 1
          }
        }
      }
      result = result.slice(0, deleteStart) + result.slice(tableEnd)
    }
  }

  // 2. Add or update active keys in keysToUpdate
  for (const { key, hash, insertedSep, reclaimAbsent } of keysToUpdate) {
    const spans = findTomlStateSpans(result)
    const targetSpan = spans.find((s) => s.headerKey === key)

    if (targetSpan) {
      const spanText = result.slice(targetSpan.start, targetSpan.end)
      const trustedHash = inspectSyntaxAwareTrustedHash(spanText)
      if (trustedHash.kind === 'unsupported' || (trustedHash.kind === 'absent' && !reclaimAbsent)) {
        throw new Error(
          `updateTomlTrustState: refusing to claim existing hooks.state table "${key}": ` +
          'trusted_hash is missing or not a supported double-quoted string; restore the Jerico-seeded value or remove/rename the foreign table, then retry'
        )
      }
      const updatedSpanText = trustedHash.kind === 'absent'
        ? insertTrustedHashAfterHeader(spanText, hash, eol)
        : setSyntaxAwareTrustedHash(spanText, hash, eol)
      result = result.slice(0, targetSpan.start) + updatedSpanText + result.slice(targetSpan.end)
    } else {
      let appendix = ''
      let sepComment = ''
      if (result.length > 0 && !result.endsWith('\n') && !result.endsWith('\r')) {
        appendix += eol
        sepComment = ' # jerico_sep=1'
      } else if (insertedSep) {
        sepComment = ' # jerico_sep=1'
      }
      appendix += `[hooks.state."${key}"]${sepComment}${eol}trusted_hash = "${hash}"${eol}`
      result += appendix
    }
  }

  // Fallback for no-final-newline files without jerico_sep marker
  if (keysToUpdate.length === 0 && !hasOriginalEol && (result.endsWith('\n') || result.endsWith('\r'))) {
    const trimmed = result.replace(/(?:\r?\n)+$/, '')
    if (trimmed.length > 0) {
      try {
        parseToml(trimmed)
        result = trimmed
      } catch {}
    }
  }

  // Always validate generated TOML with smol-toml before returning!
  if (result.trim().length > 0) {
    try {
      parseToml(result)
    } catch (err) {
      throw new Error(`updateTomlTrustState: generated invalid TOML: ${err}`)
    }
  }

  return result
}

/**
 * Merge workspace trust into ~/.codex/config.toml content.
 * Follows the same format and safety properties as seedCodexTrust:
 * - Table header: [projects."<canonicalRoot>"]
 * - Key: trust_level = "trusted"
 * - Preserves all existing tables, keys, comments, formatting verbatim.
 * - If already trusted -> { modified: false, content }
 * - If present with a different trust_level -> 'conflict'
 * - If absent -> appends the table and validates with smol-toml
 */
export function mergeCodexWorkspaceTrust(
  content: string,
  canonicalRoot: string,
): { modified: boolean; content: string } | 'conflict' {
  let parsed: unknown
  if (content.trim().length > 0) {
    try {
      parsed = parseToml(content)
    } catch {
      return 'conflict'
    }
  } else {
    parsed = {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'conflict'

  const rawProjects = (parsed as Record<string, unknown>)['projects']
  if (rawProjects !== undefined) {
    if (!rawProjects || typeof rawProjects !== 'object' || Array.isArray(rawProjects)) {
      return 'conflict'
    }
    const projects = rawProjects as Record<string, unknown>
    const existingProject = projects[canonicalRoot]
    if (existingProject !== undefined) {
      if (!existingProject || typeof existingProject !== 'object' || Array.isArray(existingProject)) {
        return 'conflict'
      }
      const proj = existingProject as Record<string, unknown>
      if (proj['trust_level'] === 'trusted') {
        return { modified: false, content }
      }
      return 'conflict'
    }
  }

  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  let prefix = ''
  if (content.length > 0 && !content.endsWith('\n') && !content.endsWith('\r')) {
    prefix = eol
  }
  const escapedRoot = canonicalRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const table = `[projects."${escapedRoot}"]${eol}trust_level = "trusted"${eol}`
  const newContent = `${content}${prefix}${table}`

  try {
    parseToml(newContent)
  } catch {
    return 'conflict'
  }

  return { modified: true, content: newContent }
}


/* ---------------- Main Transaction Entry Point ---------------- */

async function executeSeedCodexTrustTransaction(hooksJsonPath: string, knownPreviousHashes: string[] = []): Promise<void> {
  let content = ''
  try {
    content = await fs.readFile(hooksJsonPath, 'utf-8')
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
  }

  const rawConfigPath = process.env.JERICO_CODEX_CONFIG_PATH || path.join(path.dirname(hooksJsonPath), 'config.toml')
  const realConfigPath = await resolveRealTargetFile('codex', rawConfigPath)
  let configRead: { content: string; mode: number; mtimeMs: number } | null = null
  if (realConfigPath !== 'refused-unsafe-target') {
    configRead = await readTargetFile(realConfigPath)
  }

  const ledgerPath = getTrustLedgerPath(hooksJsonPath)
  const realLedgerPath = await resolveRealTargetFile('codex', ledgerPath)
  if (realLedgerPath === 'refused-unsafe-target') throw new Error('Refused unsafe ledger path')

  const ledgerFile = await readTargetFile(realLedgerPath)
  let ledgerData: LedgerData | null = null
  if (ledgerFile !== null && ledgerFile.content.trim().length > 0) {
    try {
      const parsed = JSON.parse(ledgerFile.content)
      if (parsed && Array.isArray(parsed.keys)) {
        const valid: LedgerEntry[] = []
        for (const item of parsed.keys) {
          if (item && typeof item === 'object' && typeof item.key === 'string' && typeof item.seededHash === 'string') {
            valid.push({
              key: item.key,
              seededHash: item.seededHash,
              ...(typeof item.insertedSep === 'boolean' ? { insertedSep: item.insertedSep } : {})
            })
          }
        }
        ledgerData = { keys: valid }
      }
    } catch {
      // malformed
    }
  }

  const activeJericoEntries: Array<{
    key: string
    hash: string
    insertedSep?: boolean
    reclaimAbsent?: boolean
  }> = []
  if (content.trim().length > 0) {
    let parsed: any
    try {
      parsed = JSON.parse(content)
    } catch {
      // malformed
    }

    if (parsed && typeof parsed === 'object' && parsed.hooks && typeof parsed.hooks === 'object') {
      for (const [eventName, groups] of Object.entries<any>(parsed.hooks)) {
        if (!Array.isArray(groups)) continue
        const snakeEvent = toSnakeCase(eventName)
        for (let gIdx = 0; gIdx < groups.length; gIdx++) {
          const group = groups[gIdx]
          if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue
          const matcher = group.matcher
          for (let hIdx = 0; hIdx < group.hooks.length; hIdx++) {
            const handler = group.hooks[hIdx]
            if (!isOurCodexHandler(eventName, handler)) continue
            const key = `${hooksJsonPath}:${snakeEvent}:${gIdx}:${hIdx}`
            const hash = computeCodexHookHash(eventName, matcher, handler)

            const existingLedgerItem = ledgerData?.keys.find((k) => k.key === key)
            let insertedSep = existingLedgerItem?.insertedSep
            if (insertedSep === undefined && configRead !== null) {
              const spans = findTomlStateSpans(configRead.content)
              const span = spans.find((s) => s.headerKey === key)
              if (span) {
                const headerLine = configRead.content.slice(span.start, span.end).split(/\r?\n/)[0] || ''
                insertedSep = /# jerico_sep=1/.test(headerLine)
              } else {
                insertedSep = configRead.content.length > 0 && !configRead.content.endsWith('\n') && !configRead.content.endsWith('\r')
              }
            }

            activeJericoEntries.push({
              key,
              hash,
              reclaimAbsent: existingLedgerItem === undefined,
              ...(insertedSep !== undefined ? { insertedSep } : {})
            })
          }
        }
      }
    }
  }

  const activeKeysSet = new Set(activeJericoEntries.map((e) => e.key))

  let keysToRemove: Array<{ key: string; seededHash?: string; insertedSep?: boolean }> = []
  const ledgerEntriesForThisPath = ledgerData?.keys.filter((k) => k.key.startsWith(`${hooksJsonPath}:`)) ?? []

  if (ledgerEntriesForThisPath.length > 0) {
    const independentlyKnownHashes = new Set([
      getJericoExpectedCodexHash(),
      ...knownPreviousHashes
    ])
    keysToRemove = ledgerEntriesForThisPath
      .filter((k) =>
        !activeKeysSet.has(k.key) &&
        (independentlyKnownHashes.has(k.seededHash) || CANONICAL_CODEX_HASH.test(k.seededHash))
      )
      .map((k) => ({ key: k.key, seededHash: k.seededHash, insertedSep: k.insertedSep }))
  } else {
    // Fallback reconciliation
    const expectedHash = getJericoExpectedCodexHash()
    if (configRead !== null) {
      const spans = findTomlStateSpans(configRead.content)
      for (const span of spans) {
        if (span.headerKey.startsWith(`${hooksJsonPath}:`) && !activeKeysSet.has(span.headerKey)) {
          const spanText = configRead.content.slice(span.start, span.end)
          const spanHash = getSyntaxAwareTrustedHash(spanText)
          if (spanHash && (spanHash === expectedHash || knownPreviousHashes.includes(spanHash))) {
            const headerLine = spanText.split(/\r?\n/)[0] || ''
            const insertedSep = /# jerico_sep=1/.test(headerLine)
            keysToRemove.push({ key: span.headerKey, seededHash: spanHash, insertedSep })
          }
        }
      }
    }
  }

  if (activeJericoEntries.length === 0 && keysToRemove.length === 0) {
    return
  }

  const configContent = configRead ? configRead.content : ''
  const configMode = configRead ? configRead.mode : null
  const configMtime = configRead ? configRead.mtimeMs : null

  const updatedConfig = updateTomlTrustState(configContent, activeJericoEntries, keysToRemove)
  if (updatedConfig !== configContent) {
    await atomicWrite(realConfigPath, updatedConfig, configMode, configMtime)
  }

  const existingOtherEntries = ledgerData !== null
    ? ledgerData.keys.filter((k) => !k.key.startsWith(`${hooksJsonPath}:`))
    : []
  const newActiveLedgerEntries: LedgerEntry[] = activeJericoEntries.map((e) => ({
    key: e.key,
    seededHash: e.hash,
    ...(e.insertedSep !== undefined ? { insertedSep: e.insertedSep } : {})
  }))
  const newLedgerData: LedgerData = {
    keys: [...existingOtherEntries, ...newActiveLedgerEntries]
  }

  const ledgerContent = JSON.stringify(newLedgerData, null, 2) + '\n'
  const ledgerMode = ledgerFile ? ledgerFile.mode : null
  const ledgerMtime = ledgerFile ? ledgerFile.mtimeMs : null
  await atomicWrite(realLedgerPath, ledgerContent, ledgerMode, ledgerMtime)
}

export async function seedCodexTrust(hooksJsonPath: string, knownPreviousHashes: string[] = []): Promise<void> {
  return withCodexLock(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await executeSeedCodexTrustTransaction(hooksJsonPath, knownPreviousHashes)
        break
      } catch (err: any) {
        if (err.code === 'ECONFLICT' && attempt < 2) {
          await new Promise((r) => setTimeout(r, 10 + Math.random() * 20))
          continue
        }
        throw err
      }
    }
  })
}
