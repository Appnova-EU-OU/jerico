import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { readFileSync, statSync, stat as statFile, lstatSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { execFileSync, execFile } from 'node:child_process'
import * as asyncFs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Parser, Language, type Node as SyntaxNode } from 'web-tree-sitter'
import BetterSqlite3 from 'better-sqlite3'
import { getCodegraphDir } from './profile.js'

type Database = ReturnType<typeof BetterSqlite3>

interface FileRecord {
  path: string
  lang: string
  content_hash: string
  mtime_ms: number
  bytes: number
  parsed_at_ms: number
}

interface SymbolRecord {
  id?: number
  file_path: string
  name: string
  kind: string
  qualified_name: string
  start_line: number
  end_line: number
  exported: number
  parent_id: number | null
}

interface ImportRecord {
  file_path: string
  spec: string
  imported_names: string
}

interface ReexportRecord {
  file_path: string
  name: string
  target_spec: string
  star: number
}

interface CallEdgeRecord {
  caller_id: number
  callee_name: string
  callee_resolved_id: number | null
  line: number
  candidate: number
}

interface ParsedSymbol {
  name: string
  kind: string
  start_line: number
  end_line: number
  exported: boolean
  parentName: string | null
}

interface ParsedImport {
  spec: string
  imported_names: string[]
  has_default: boolean
  default_name: string | null
}

interface ParsedReexport {
  name: string
  target_spec: string
  star: boolean
}

interface ParsedCall {
  callee_name: string
  line: number
}

interface ParsedFile {
  symbols: ParsedSymbol[]
  imports: ParsedImport[]
  reexports: ParsedReexport[]
  calls: ParsedCall[]
}

export interface CodegraphStatus {
  indexed: number
  total: number
  stale: number
  lastIndexedAt: number | null
  indexing: boolean
  openDbs: number
  resolutionCoverage: { resolved: number; unresolved: number }
  unsupportedLanguages: string[]
}

export interface SymbolResult {
  qualifiedName: string
  file: string
  line: number
  kind: string
  exported: boolean
}

export interface ReferenceResult {
  references: { callerFile: string; callerName: string; line: number; depth: number }[]
  boundedByUnresolved: boolean
  status: 'ok' | 'not_found' | 'ambiguous'
  resolvedSymbol?: string
  matchedBy?: 'qualified' | 'name' | 'suffix'
  candidates?: SymbolCandidate[]
  totalCandidates?: number
  resolutionCoverage: { resolved: number; unresolved: number }
}

export interface CallGraphResult {
  nodes: { name: string; file: string; line: number; depth: number; qualifiedName: string }[]
  truncated: boolean
  status: 'ok' | 'not_found' | 'ambiguous'
  resolvedSymbol?: string
  matchedBy?: 'qualified' | 'name' | 'suffix'
  candidates?: SymbolCandidate[]
  totalCandidates?: number
  resolutionCoverage: { resolved: number; unresolved: number }
}

export interface SymbolCandidate {
  id: number
  qualifiedName: string
  file: string
  line: number
  kind: string
  exported: boolean
}

interface SymbolLookupRow {
  id: number
  qualified_name: string
  file_path: string
  name: string
  start_line: number
  end_line: number
  kind: string
  exported: number
}

type SymbolResolution =
  | { status: 'ok'; ids: number[]; resolvedSymbol: string; leafName: string; matchedBy: 'qualified' | 'name' | 'suffix' }
  | { status: 'ambiguous'; candidates: SymbolCandidate[]; totalCandidates: number }
  | { status: 'not_found' }

function compareBinary(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export interface IndexResult {
  status: string
  total: number
  unsupportedLanguages: string[]
}



const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.go': 'go',
  '.dart': 'dart',
  '.rs': 'rust',
  '.svelte': 'svelte',
}

// Positive allowlist of extensions we recognize as real programming-language
// source that we do NOT parse — used only to signal "this project's code is in
// an unsupported language" (issue #71). Deliberately not a denylist: a denylist
// of non-code extensions (.json/.md/.yml/images/...) is unbounded and would
// false-positive on every new non-code file type forever. An extension absent
// from both this table and EXT_TO_LANG is simply uncounted, silently.
const UNSUPPORTED_SOURCE_EXTS: Record<string, string> = {
  '.cs': 'csharp', '.fs': 'fsharp', '.vb': 'vb',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.lua': 'lua', '.zig': 'zig',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hs': 'haskell',
  '.ml': 'ocaml', '.clj': 'clojure', '.m': 'objc', '.mm': 'objc', '.pl': 'perl',
  '.groovy': 'groovy', '.jl': 'julia', '.nim': 'nim',
}

const EXT_TO_GRAMMAR: Record<string, 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'dart' | 'rust'> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.dart': 'dart',
  '.rs': 'rust',
  // `.svelte` is intentionally NOT mapped to a grammar: there is no
  // tree-sitter-svelte wasm in tree-sitter-wasms. parseFile extracts the
  // <script> block and re-parses it with the typescript grammar (with a line
  // offset) — see the `.svelte` branch in parseFile.
}

const GRAMMAR_FILES: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  dart: 'tree-sitter-dart.wasm',
  rust: 'tree-sitter-rust.wasm',
}

function isSourceFile(p: string): boolean {
  const ext = path.extname(p).toLowerCase()
  return ext in EXT_TO_LANG
}

function detectLang(p: string): string {
  const ext = path.extname(p).toLowerCase()
  return EXT_TO_LANG[ext] ?? 'unknown'
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function findWasmDir(): string {
  const dir = __dirname
  const candidates = [
    path.join(dir, 'wasm'),
    path.join(dir, '..', 'wasm'),
    path.join(dir, '..', '..', 'wasm'),
    path.join(process.cwd(), 'wasm'),
    path.join(process.cwd(), 'dist', 'wasm'),
  ]
  for (const c of candidates) {
    if (existsSync(c) && existsSync(path.join(c, 'tree-sitter.wasm'))) return c
  }
  const fromNodeModules = path.join(dir, '..', 'node_modules', 'web-tree-sitter')
  if (existsSync(fromNodeModules) && existsSync(path.join(fromNodeModules, 'tree-sitter.wasm'))) {
    return fromNodeModules
  }
  const fallback = path.join(dir, '..', '..', 'spike', 'wasm-pkg', 'wasm')
  if (existsSync(fallback)) return fallback
  return path.join(os.tmpdir(), 'codegraph-wasm')
}

async function initParser(): Promise<{
  parser: Parser
  langs: Record<string, Language>
}> {
  const wasmDir = findWasmDir()
  const corePath = path.join(wasmDir, 'tree-sitter.wasm')

  if (!corePath) {
    throw new Error(`WASM path resolution failed: wasmDir=${wasmDir}`)
  }
  if (!existsSync(corePath)) {
    throw new Error(`Core WASM not found at ${corePath} (wasmDir=${wasmDir}, __dirname=${__dirname})`)
  }

  const missing = Object.values(GRAMMAR_FILES).map(f => path.join(wasmDir, f)).filter(p => !existsSync(p))
  if (missing.length > 0) {
    const searchMsg = `WASM directory checked: ${wasmDir}`
    throw new Error(`Missing WASM files: ${missing.join(', ')}. ${searchMsg}`)
  }

  await Parser.init({
    wasmBinary: readFileSync(corePath),
  })

  const langs: Record<string, Language> = {}
  for (const [name, file] of Object.entries(GRAMMAR_FILES)) {
    const gp = path.join(wasmDir, file)
    langs[name] = await Language.load(new Uint8Array(readFileSync(gp)))
  }

  const parser = new Parser()
  return { parser, langs }
}

function getLanguageForFile(
  filePath: string,
  parser: Parser,
  langs: Record<string, Language>,
): Language | null {
  const ext = path.extname(filePath).toLowerCase()
  const grammar = EXT_TO_GRAMMAR[ext]
  if (!grammar) return null
  const lang = langs[grammar]
  if (!lang) return null
  parser.setLanguage(lang)
  return lang
}

function extractCalleeName(funcNode: SyntaxNode | null): string {
  if (!funcNode) return ''
  switch (funcNode.type) {
    case 'identifier':
    case 'field_identifier':
    case 'property_identifier':
      return funcNode.text
    case 'member_expression': {
      const meNc = funcNode.namedChildren.filter((c): c is SyntaxNode => c !== null)
      const prop = meNc.find(c => c.type === 'property_identifier')
      return prop ? prop.text : ''
    }
    case 'attribute': {
      const attrNc = funcNode.namedChildren.filter((c): c is SyntaxNode => c !== null)
      const id = attrNc.find(c => c.type === 'identifier')
      return id ? id.text : ''
    }
    case 'field_expression': {
      // Rust `obj.method()` — the called method is the trailing field.
      const feNc = funcNode.namedChildren.filter((c): c is SyntaxNode => c !== null)
      const field = feNc.find(c => c.type === 'field_identifier')
      return field ? field.text : ''
    }
    case 'scoped_identifier': {
      // Rust `HashMap::new()` — the called item is the last identifier segment.
      const parts = funcNode.namedChildren.filter((c): c is SyntaxNode => c !== null && c.type === 'identifier')
      return parts.length > 0 ? parts[parts.length - 1].text : ''
    }
    case 'selector_expression': {
      const seNc = funcNode.namedChildren.filter((c): c is SyntaxNode => c !== null)
      const field = seNc.find(c => c.type === 'field_identifier')
      return field ? field.text : ''
    }
    default:
      return ''
  }
}

/**
 * Read the call target off a Dart `selector` node that carries an `argument_part`.
 * `obj.method(1)` → inner `selector` (`.method`) → `method`. `add(1, 2)` →
 * preceding `identifier` → `add`. Dart has no dedicated call node, so calls are
 * detected via `argument_part` (see walkDart).
 */
function extractDartCallee(selector: SyntaxNode): string {
  const prev = selector.previousSibling
  if (!prev) return ''
  if (prev.type === 'identifier') return prev.text
  if (prev.type === 'selector') {
    const uas = prev.namedChildren.find((c): c is SyntaxNode => c !== null && c.type === 'unconditional_assignable_selector')
    if (uas) {
      const id = uas.namedChildren.find((c): c is SyntaxNode => c !== null && c.type === 'identifier')
      return id ? id.text : ''
    }
  }
  return ''
}

/**
 * Extract the contents of the first `<script>` block from a `.svelte` file so it
 * can be re-parsed as TypeScript. Returns `offset` = the number of lines before
 * the script content begins (so callers can prepend blank lines and keep the TS
 * AST's row numbers aligned with the original `.svelte` file). Returns null when
 * there is no script block to index.
 */
function extractSvelteScript(content: string): { script: string; offset: number } | null {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/i
  const m = re.exec(content)
  if (!m) return null
  const attrs = m[1] ?? ''
  const script = m[2]
  const openTagEnd = m[0].indexOf('>') + 1
  const contentStart = m.index + openTagEnd
  const offset = content.slice(0, contentStart).split('\n').length - 1
  return { script, offset }
}

/** Collect binding names from an object-destructuring pattern (`{ a, b: c }` → ['a','c']). */
function collectPatternNames(objPattern: SyntaxNode, out: string[]): void {
  for (const c of objPattern.namedChildren.filter((n): n is SyntaxNode => n !== null)) {
    if (c.type === 'shorthand_property_identifier_pattern') out.push(c.text)
    else if (c.type === 'pair_pattern') {
      const val = c.namedChildren.filter((n): n is SyntaxNode => n !== null).slice(-1)[0]
      if (val && (val.type === 'identifier' || val.type === 'shorthand_property_identifier_pattern')) out.push(val.text)
    }
  }
}

/**
 * Dynamic import (consensus R3): record a STATIC-string `import('...')` call as an ordinary
 * `ParsedImport` so the existing resolver links callers through it — closing the blind spot where
 * `const { x } = await import('./y')` callers were invisible to find_references / call_graph.
 * ONE detector, classified by parent context:
 *   - `const { a,b } = await import('./y')`         → names [a,b]   (destructure)
 *   - `const m = await import('./y')`               → ['*']         (namespace)
 *   - `import('./y').then(m => m.x())`              → ['*']         (module handed to callback)
 *   - `(await import('./y')).x` / `import('./y').x` → [x]           (inline member)
 * Returns null for bare `import()` (no binding) and for variable / interpolated specifiers
 * (not statically knowable — punted permanently). Never throws.
 */
function parseDynamicImport(callNode: SyntaxNode): ParsedImport | null {
  try {
    const kids = callNode.namedChildren.filter((c): c is SyntaxNode => c !== null)
    const argsNode = kids.find(c => c.type === 'arguments')
    const firstArg = argsNode?.namedChildren.filter((c): c is SyntaxNode => c !== null)[0]
    if (!firstArg) return null
    let spec: string | null = null
    if (firstArg.type === 'string') {
      spec = firstArg.text.replace(/^['"]|['"]$/g, '')
    } else if (firstArg.type === 'template_string') {
      // Only substitution-free templates are statically knowable.
      if (!firstArg.namedChildren.some(c => c?.type === 'template_substitution')) {
        spec = firstArg.text.replace(/^`|`$/g, '')
      }
    }
    if (!spec) return null

    const names: string[] = []
    const parent = callNode.parent
    if (parent?.type === 'await_expression') {
      const gp = parent.parent
      if (gp?.type === 'variable_declarator') {
        const nameNode = gp.namedChildren.filter((c): c is SyntaxNode => c !== null)[0]
        if (nameNode?.type === 'object_pattern') collectPatternNames(nameNode, names)
        else if (nameNode?.type === 'identifier') names.push('*')
      } else if (gp?.type === 'parenthesized_expression' && gp.parent?.type === 'member_expression') {
        const prop = gp.parent.namedChildren.filter((c): c is SyntaxNode => c !== null).slice(-1)[0]
        if (prop && (prop.type === 'property_identifier' || prop.type === 'identifier')) names.push(prop.text)
      }
    } else if (parent?.type === 'member_expression') {
      const prop = parent.namedChildren.filter((c): c is SyntaxNode => c !== null).slice(-1)[0]
      if (prop?.text === 'then') names.push('*')
      else if (prop && (prop.type === 'property_identifier' || prop.type === 'identifier')) names.push(prop.text)
    }
    if (names.length === 0) return null
    return { spec, imported_names: names, has_default: false, default_name: null }
  } catch {
    return null
  }
}

function parseFile(
  content: string,
  filePath: string,
  parser: Parser,
  langs: Record<string, Language>,
): ParsedFile {
  const ext = path.extname(filePath).toLowerCase()

  const symbols: ParsedSymbol[] = []
  const imports: ParsedImport[] = []
  const reexports: ParsedReexport[] = []
  const calls: ParsedCall[] = []
  const currentMethodStack: { name: string; startLine: number; nodeId: number }[] = []

  let methodCounter = 0

  function getId(): number {
    methodCounter++
    return methodCounter
  }

  // ---- Svelte (no dedicated grammar) ----
  // Extract the <script lang="ts"> (or plain <script>) block and re-parse it as
  // TypeScript. We prepend `offset` blank lines so the TS AST's row numbers line
  // up with the original .svelte file, then reuse the TS walker (`walk`).
  if (ext === '.svelte') {
    const extracted = extractSvelteScript(content)
    if (!extracted) return { symbols, imports, reexports, calls }
    const { script, offset } = extracted
    const tsLang = langs['typescript']
    if (!tsLang) return { symbols, imports, reexports, calls }
    parser.setLanguage(tsLang)
    const tree = parser.parse('\n'.repeat(offset) + script)
    if (!tree) return { symbols, imports, reexports, calls }
    walk(tree.rootNode)
    return { symbols, imports, reexports, calls }
  }

  const lang = getLanguageForFile(filePath, parser, langs)
  if (!lang) return { symbols, imports, reexports, calls }

  const tree = parser.parse(content)
  if (!tree) return { symbols, imports, reexports, calls }
  const root = tree.rootNode

  // ---- Python (def/class/import/call) ----
  function walkPython(node: SyntaxNode): void {
    const type = node.type
    const nc = node.namedChildren.filter((c): c is SyntaxNode => c !== null)

    if (type === 'function_definition' || type === 'class_definition') {
      const nameNode = nc.find(c => c.type === 'identifier')
      const name = nameNode ? nameNode.text : '(anonymous)'
      const isClass = type === 'class_definition'
      const topLevel = !currentMethodStack.length
      const sym: ParsedSymbol = {
        name,
        kind: isClass ? 'class' : 'function',
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported: topLevel,
        parentName: null,
      }
      symbols.push(sym)
      currentMethodStack.push({ name, startLine: node.startPosition.row + 1, nodeId: getId() })
      for (const c of nc) walkPython(c)
      currentMethodStack.pop()
      return
    }

    // assignment to a lambda: `foo = lambda x: ...`
    if (type === 'assignment') {
      const left = nc.find(c => c.type === 'identifier')
      const right = nc.find(c => c.type === 'lambda')
      if (left && right) {
        const topLevel = !currentMethodStack.length
        const sym: ParsedSymbol = {
          name: left.text,
          kind: 'function',
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          exported: topLevel,
          parentName: null,
        }
        symbols.push(sym)
      }
      for (const c of nc) walkPython(c)
      return
    }

    if (type === 'import_statement') {
      for (const child of nc) {
        if (child.type === 'dotted_name') {
          imports.push({ spec: child.text, imported_names: [child.text.split('.').pop() ?? child.text], has_default: false, default_name: null })
        } else if (child.type === 'aliased_import') {
          const dn = child.namedChildren.find((c): c is SyntaxNode => c !== null && c.type === 'dotted_name')
          const alias = child.namedChildren.find((c): c is SyntaxNode => c !== null && c.type === 'identifier')
          if (dn) imports.push({ spec: dn.text, imported_names: alias ? [alias.text] : [dn.text.split('.').pop() ?? dn.text], has_default: false, default_name: null })
        }
      }
      return
    }

    if (type === 'import_from_statement') {
      // Relative imports (`from ..pkg.mod import x`, `from . import x`) parse as a
      // dedicated `relative_import` node (import_prefix dots + optional dotted_name),
      // NOT a top-level `dotted_name` sibling. The old code only ever looked for
      // `dotted_name` here, so for a relative import it grabbed the IMPORTED NAME's
      // dotted_name as if it were the module spec, and produced an empty names list —
      // silently wrong, not merely unresolved (issue #90).
      const relImport = nc.find(c => c.type === 'relative_import')
      const names: string[] = []
      let spec: string | null = null

      if (relImport) {
        // relative_import.text already IS the correctly-formed spec — tree-sitter
        // groups the dots and the optional dotted path under one node's text
        // (e.g. "..services.tracking", ".", ".mod").
        spec = relImport.text
        for (const child of nc) {
          if (child === relImport) continue
          if (child.type === 'dotted_name') {
            names.push(child.text.split('.').pop() ?? child.text)
          } else if (child.type === 'aliased_import') {
            const alias = child.namedChildren.find((c): c is SyntaxNode => c !== null && c.type === 'identifier')
            if (alias) names.push(alias.text)
          } else if (child.type === 'wildcard_import') {
            names.push('*')
          }
        }
      } else {
        const dotted = nc.filter(c => c.type === 'dotted_name')
        const moduleNode = dotted[0]
        if (moduleNode) {
          spec = moduleNode.text
          for (const child of nc) {
            if (child.type === 'dotted_name') {
              if (child === moduleNode) continue
              names.push(child.text.split('.').pop() ?? child.text)
            } else if (child.type === 'aliased_import') {
              const alias = child.namedChildren.find((c): c is SyntaxNode => c !== null && c.type === 'identifier')
              if (alias) names.push(alias.text)
            } else if (child.type === 'wildcard_import') {
              names.push('*')
            }
          }
        }
      }

      if (spec !== null) {
        imports.push({ spec, imported_names: names, has_default: false, default_name: null })
      }
      return
    }

    if (type === 'call') {
      const funcNode = node.namedChildren[0] ?? null
      const calleeName = extractCalleeName(funcNode)
      if (calleeName) calls.push({ callee_name: calleeName, line: node.startPosition.row + 1 })
      // don't recurse into the callable itself; still walk args/children for nested calls
      for (const c of nc) walkPython(c)
      return
    }

    for (const c of nc) walkPython(c)
  }

  // ---- Go (func/method/type/import/call) ----
  function walkGo(node: SyntaxNode): void {
    const type = node.type
    const nc = node.namedChildren.filter((c): c is SyntaxNode => c !== null)

    if (type === 'function_declaration' || type === 'method_declaration') {
      const nameNode = nc.find(c => c.type === 'field_identifier' || c.type === 'identifier')
      const name = nameNode ? nameNode.text : '(anonymous)'
      const topLevel = !currentMethodStack.length
      const sym: ParsedSymbol = {
        name,
        kind: type === 'method_declaration' ? 'method' : 'function',
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported: topLevel && name.length > 0 && name[0] === name[0].toUpperCase(),
        parentName: null,
      }
      symbols.push(sym)
      currentMethodStack.push({ name, startLine: node.startPosition.row + 1, nodeId: getId() })
      for (const c of nc) walkGo(c)
      currentMethodStack.pop()
      return
    }

    if (type === 'type_declaration') {
      for (const child of nc) {
        if (child.type === 'type_spec') {
          const nameNode = child.namedChildren.find((c): c is SyntaxNode => c !== null && c.type === 'type_identifier')
          if (nameNode) {
            const kind = child.namedChildren.some((c): c is SyntaxNode => c !== null && c.type === 'interface_type') ? 'interface' : 'class'
            const sym: ParsedSymbol = {
              name: nameNode.text,
              kind,
              start_line: child.startPosition.row + 1,
              end_line: child.endPosition.row + 1,
              exported: nameNode.text.length > 0 && nameNode.text[0] === nameNode.text[0].toUpperCase(),
              parentName: null,
            }
            symbols.push(sym)
          }
        }
      }
      for (const c of nc) walkGo(c)
      return
    }

    if (type === 'import_declaration') {
      const specLists = nc.filter(c => c.type === 'import_spec_list')
      const specs = specLists.length > 0
        ? specLists.flatMap(l => l.namedChildren.filter((c): c is SyntaxNode => c !== null).filter(c => c.type === 'import_spec'))
        : nc.filter(c => c.type === 'import_spec')
      for (const spec of specs) {
        const sc = spec.namedChildren.filter((c): c is SyntaxNode => c !== null)
        const pathNode = sc.find(c => c.type === 'string')
        const aliasNode = sc.find(c => c.type === 'package_identifier')
        if (pathNode) {
          const specPath = pathNode.text.replace(/^['"]|['"]$/g, '')
          let name = aliasNode ? aliasNode.text : specPath.split('/').pop() ?? specPath
          if (name === '.') name = '*'
          imports.push({ spec: specPath, imported_names: [name], has_default: false, default_name: null })
        }
      }
      return
    }

    if (type === 'call_expression') {
      const funcNode = nc[0] ?? null
      const calleeName = extractCalleeName(funcNode)
      if (calleeName) calls.push({ callee_name: calleeName, line: node.startPosition.row + 1 })
      for (const c of nc) walkGo(c)
      return
    }

    for (const c of nc) walkGo(c)
  }

  // ---- Dart ----
  function walkDart(node: SyntaxNode): void {
    const type = node.type
    const nc = node.namedChildren.filter((c): c is SyntaxNode => c !== null)

    if (type === 'class_definition') {
      const nameNode = node.childForFieldName('name') ?? nc.find(c => c.type === 'identifier')
      const name = nameNode ? nameNode.text : '(anonymous)'
      const topLevel = !currentMethodStack.length
      symbols.push({ name, kind: 'class', start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, exported: topLevel, parentName: null })
      currentMethodStack.push({ name, startLine: node.startPosition.row + 1, nodeId: getId() })
      for (const c of nc) walkDart(c)
      currentMethodStack.pop()
      return
    }

    if (type === 'method_signature') {
      const fs = nc.find(c => c.type === 'function_signature')
      const parentClass = currentMethodStack.length > 0 ? currentMethodStack[currentMethodStack.length - 1] : null
      // In tree-sitter-dart the `function_body` is a SIBLING of `method_signature`
      // (not a child), so extend end_line via the following sibling.
      const body = (node.nextSibling && node.nextSibling.type === 'function_body') ? node.nextSibling : null
      if (fs) {
        const fsNc = fs.namedChildren.filter((c): c is SyntaxNode => c !== null)
        const nameNode = fsNc.find(c => c.type === 'identifier')
        if (nameNode) {
          // method_signature's end position stops at the signature — the body is
          // a child `function_body`. Extend end_line to the body so calls inside
          // the method body are attributed to this method, not the class.
          const endLine = body ? body.endPosition.row + 1 : node.endPosition.row + 1
          symbols.push({ name: nameNode.text, kind: 'method', start_line: node.startPosition.row + 1, end_line: endLine, exported: false, parentName: parentClass ? parentClass.name : null })
          currentMethodStack.push({ name: nameNode.text, startLine: node.startPosition.row + 1, nodeId: getId() })
          if (body) walkDart(body)
          currentMethodStack.pop()
          return
        }
      }
      if (body) walkDart(body)
      return
    }

    if (type === 'function_signature') {
      const nameNode = nc.find(c => c.type === 'identifier')
      if (nameNode) {
        const topLevel = !currentMethodStack.length
        // At top level `function_signature` and `function_body` are siblings, so
        // the signature node alone does NOT span the body. Extend end_line to the
        // following `function_body` so calls inside the body are attributed to
        // this function (not the enclosing class).
        const body = (node.nextSibling && node.nextSibling.type === 'function_body') ? node.nextSibling : null
        const endLine = body ? body.endPosition.row + 1 : node.endPosition.row + 1
        symbols.push({ name: nameNode.text, kind: 'function', start_line: node.startPosition.row + 1, end_line: endLine, exported: topLevel, parentName: null })
        currentMethodStack.push({ name: nameNode.text, startLine: node.startPosition.row + 1, nodeId: getId() })
        for (const c of nc) walkDart(c)
        currentMethodStack.pop()
      }
      return
    }

    if (type === 'import_or_export') {
      const uriNode = nc.find(c => c.type === 'string_literal')
      if (uriNode) {
        const spec = uriNode.text.replace(/^['"]|['"]$/g, '')
        const base = spec.split('/').pop()?.replace(/\.dart$/, '') ?? spec
        imports.push({ spec, imported_names: [base], has_default: false, default_name: null })
      }
      return
    }

    // Dart has no `call_expression` node; a call is an `identifier` (or member
    // access) followed by a `selector` carrying an `argument_part`. Detect the
    // `argument_part` and read the call target off its enclosing `selector`.
    if (type === 'argument_part') {
      const sel = node.parent
      if (sel && sel.type === 'selector') {
        const callee = extractDartCallee(sel)
        if (callee) calls.push({ callee_name: callee, line: node.startPosition.row + 1 })
      }
      return
    }

    for (const c of nc) walkDart(c)
  }

  // ---- Rust ----
  const implStack: string[] = []
  function walkRust(node: SyntaxNode): void {
    const type = node.type
    const nc = node.namedChildren.filter((c): c is SyntaxNode => c !== null)

    if (type === 'function_item') {
      const nameNode = nc.find(c => c.type === 'identifier')
      const name = nameNode ? nameNode.text : '(anonymous)'
      const topLevel = !currentMethodStack.length
      const exported = topLevel && !!nc.find(c => c.type === 'visibility_modifier')
      const inImpl = implStack.length > 0
      symbols.push({ name, kind: inImpl ? 'method' : 'function', start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, exported, parentName: inImpl ? implStack[implStack.length - 1] : null })
      currentMethodStack.push({ name, startLine: node.startPosition.row + 1, nodeId: getId() })
      for (const c of nc) walkRust(c)
      currentMethodStack.pop()
      return
    }

    if (type === 'struct_item' || type === 'enum_item' || type === 'trait_item' || type === 'union_item') {
      const nameNode = nc.find(c => c.type === 'type_identifier')
      if (nameNode) {
        const exported = !!nc.find(c => c.type === 'visibility_modifier')
        const kind = type === 'trait_item' ? 'interface' : (type === 'enum_item' ? 'enum' : 'class')
        symbols.push({ name: nameNode.text, kind, start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, exported, parentName: null })
      }
      for (const c of nc) walkRust(c)
      return
    }

    if (type === 'impl_item') {
      const implName = nc.find(c => c.type === 'type_identifier')?.text ?? null
      if (implName) implStack.push(implName)
      for (const c of nc) walkRust(c)
      if (implName) implStack.pop()
      return
    }

    if (type === 'use_declaration') {
      const scoped = nc.filter(c => c.type === 'scoped_identifier')
      let spec = ''
      const names: string[] = []
      if (scoped.length > 0) {
        const last = scoped[scoped.length - 1]
        spec = last.text
        const idChildren = last.namedChildren.filter((c): c is SyntaxNode => c !== null && c.type === 'identifier')
        names.push(idChildren.length > 0 ? idChildren[idChildren.length - 1].text : last.text)
      } else {
        const id = nc.find(c => c.type === 'identifier')
        if (id) { spec = id.text; names.push(id.text) }
      }
      if (spec) imports.push({ spec, imported_names: names, has_default: false, default_name: null })
      return
    }

    if (type === 'call_expression') {
      const funcNode = nc[0] ?? null
      const calleeName = extractCalleeName(funcNode)
      if (calleeName) calls.push({ callee_name: calleeName, line: node.startPosition.row + 1 })
      for (const c of nc) walkRust(c)
      return
    }

    for (const c of nc) walkRust(c)
  }

  // ---- TypeScript / JavaScript ----
  function walk(node: SyntaxNode): void {
    const type = node.type

    const nc = node.namedChildren.filter((c): c is SyntaxNode => c !== null)

    if (type === 'function_declaration') {
      const nameNode = nc.find(c => c.type === 'identifier')
      const name = nameNode ? nameNode.text : '(anonymous)'
      const exported = node.parent?.type === 'export_statement'
      const sym: ParsedSymbol = {
        name,
        kind: 'function',
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported,
        parentName: null,
      }
      symbols.push(sym)
      currentMethodStack.push({ name, startLine: node.startPosition.row + 1, nodeId: getId() })
      for (const c of nc) walk(c)
      currentMethodStack.pop()
      return
    }

    if (type === 'method_definition') {
      const nameNode = nc.find(c => c.type === 'property_identifier')
      const name = nameNode ? nameNode.text : '(anonymous)'
      const parentClass = currentMethodStack.length > 0 ? currentMethodStack[currentMethodStack.length - 1] : null

      const sym: ParsedSymbol = {
        name,
        kind: 'method',
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported: false,
        parentName: parentClass ? parentClass.name : null,
      }
      symbols.push(sym)
      currentMethodStack.push({ name, startLine: node.startPosition.row + 1, nodeId: getId() })
      for (const c of nc) walk(c)
      currentMethodStack.pop()
      return
    }

    if (type === 'class_declaration') {
      const nameNode = nc.find(c => c.type === 'type_identifier' || c.type === 'identifier')
      const name = nameNode ? nameNode.text : '(anonymous)'
      const exported = node.parent?.type === 'export_statement'
      const sym: ParsedSymbol = {
        name,
        kind: 'class',
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported,
        parentName: null,
      }
      symbols.push(sym)
      currentMethodStack.push({ name, startLine: node.startPosition.row + 1, nodeId: getId() })
      for (const c of nc) walk(c)
      currentMethodStack.pop()
      return
    }

    if (type === 'interface_declaration') {
      const nameNode = nc.find(c => c.type === 'type_identifier' || c.type === 'identifier')
      const name = nameNode ? nameNode.text : '(anonymous)'
      const exported = node.parent?.type === 'export_statement'
      const sym: ParsedSymbol = {
        name,
        kind: 'interface',
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported,
        parentName: null,
      }
      symbols.push(sym)
      return
    }

    if (type === 'type_alias_declaration') {
      const nameNode = nc.find(c => c.type === 'type_identifier' || c.type === 'identifier')
      const name = nameNode ? nameNode.text : '(anonymous)'
      const exported = node.parent?.type === 'export_statement'
      const sym: ParsedSymbol = {
        name,
        kind: 'type',
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported,
        parentName: null,
      }
      symbols.push(sym)
      return
    }

    if (type === 'lexical_declaration') {
      for (const decl of nc) {
        if (decl.type === 'variable_declarator') {
          const declNc = decl.namedChildren.filter((c): c is SyntaxNode => c !== null)
          const idNode = declNc.find(c => c.type === 'identifier')
          const initNode = declNc.find(c => c.type === 'arrow_function' || c.type === 'function')
          if (idNode && initNode) {
            const name = idNode.text
            const exported = node.parent?.type === 'export_statement'
            const sym: ParsedSymbol = {
              name,
              kind: 'function',
              start_line: decl.startPosition.row + 1,
              end_line: decl.endPosition.row + 1,
              exported,
              parentName: null,
            }
            symbols.push(sym)
            currentMethodStack.push({ name, startLine: decl.startPosition.row + 1, nodeId: getId() })
            for (const c of declNc) walk(c)
            currentMethodStack.pop()
            continue
          }
        }
      }
      for (const c of nc) walk(c)
      return
    }

    if (type === 'import_statement') {
      const specNode = nc.find(c => c.type === 'string')
      const spec = specNode ? specNode.text.replace(/^['"]|['"]$/g, '') : ''
      const clauseNode = nc.find(c => c.type === 'import_clause')
      const importedNames: string[] = []
      let hasDefault = false
      let defaultName: string | null = null
      if (clauseNode) {
        for (const clauseChild of clauseNode.namedChildren.filter((c): c is SyntaxNode => c !== null)) {
          if (clauseChild.type === 'identifier') {
            hasDefault = true
            defaultName = clauseChild.text
            importedNames.push(clauseChild.text)
          }
          if (clauseChild.type === 'named_imports') {
            for (const specifier of clauseChild.namedChildren.filter((c): c is SyntaxNode => c !== null)) {
              if (specifier.type === 'import_specifier') {
                const localName = specifier.namedChildren.filter((c): c is SyntaxNode => c !== null).slice(-1)[0]
                if (localName) importedNames.push(localName.text)
              }
            }
          }
          if (clauseChild.type === 'namespace_import') {
            importedNames.push('*')
          }
        }
      }
      const pi: ParsedImport = { spec, imported_names: importedNames, has_default: hasDefault, default_name: defaultName }
      if (spec && importedNames.length > 0) {
        imports.push(pi)
      } else if (spec && importedNames.length === 0 && !hasDefault) {
        imports.push({ spec, imported_names: [], has_default: false, default_name: null })
      }
      return
    }

    if (type === 'export_statement') {
      const specNode = nc.find(c => c.type === 'string')
      if (specNode) {
        const spec = specNode.text.replace(/^['"]|['"]$/g, '')
        const exportedNames: string[] = []
        const exportClause = nc.find(c => c.type === 'export_clause' || c.type === 'named_exports')
        const namedExports = exportClause ?? nc.find(c => c.type === 'named_exports')
        if (namedExports) {
          for (const specifier of namedExports.namedChildren.filter((c): c is SyntaxNode => c !== null)) {
            if (specifier.type === 'export_specifier') {
              const specNc = specifier.namedChildren.filter((c): c is SyntaxNode => c !== null)
              const nameNode = specNc[0]
              if (nameNode) exportedNames.push(nameNode.text)
            }
          }
        }
        if (spec && exportedNames.length > 0) {
          imports.push({ spec, imported_names: exportedNames, has_default: false, default_name: null })
          for (const n of exportedNames) {
            reexports.push({ name: n, target_spec: spec, star: false })
          }
        } else if (spec) {
          const hasClause = !!namedExports
          const hasNamespace = !!nc.find(c => c.type === 'namespace_export')
          if (hasNamespace || !hasClause) {
            // `export * from './x'` (no clause / namespace_export node in the
            // typescript grammar) or `export * as ns from './x'`.
            imports.push({ spec, imported_names: ['*'], has_default: false, default_name: null })
            reexports.push({ name: '*', target_spec: spec, star: true })
          }
        }
      }
      for (const c of nc) walk(c)
      return
    }

    if (type === 'call_expression' || type === 'new_expression') {
      const funcNode = nc[0]
      const line = node.startPosition.row + 1
      // Dynamic import: `import('...')` records an ordinary import row (parent-context matrix)
      // so the resolver links callers through it. `import` never yields a callee edge (below).
      if (type === 'call_expression' && funcNode?.type === 'import') {
        const di = parseDynamicImport(node)
        if (di) imports.push(di)
      }
      const calleeName = extractCalleeName(funcNode)
      if (calleeName) {
        calls.push({ callee_name: calleeName, line })
      }
      // Recurse into the arguments BEFORE returning: a call nested inside another
      // call's arguments (Promise.all([f()]), foo(bar()), arr.map(x => g(x)),
      // .then(() => baz())) would otherwise be missed, undercounting callers.
      for (const c of nc) walk(c)
      return
    }

    for (const c of nc) walk(c)
  }

  if (ext === '.py') walkPython(root)
  else if (ext === '.go') walkGo(root)
  else if (ext === '.dart') walkDart(root)
  else if (ext === '.rs') walkRust(root)
  else walk(root)

  return { symbols, imports, reexports, calls }
}



interface GitignorePatterns {
  patterns: { pattern: string; negate: boolean }[]
}

function parseGitignore(rootDir: string): GitignorePatterns {
  const gitignorePath = path.join(rootDir, '.gitignore')
  if (!existsSync(gitignorePath)) return { patterns: [] }
  const content = readFileSync(gitignorePath, 'utf-8')
  const patterns: { pattern: string; negate: boolean }[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const negate = trimmed.startsWith('!')
    const pattern = negate ? trimmed.slice(1) : trimmed
    patterns.push({ pattern: pattern.replace(/\/$/, ''), negate })
  }
  return { patterns }
}

function shouldIgnore(relPath: string, gi: GitignorePatterns): boolean {
  const segments = relPath.split('/')
  for (const seg of segments) {
    if (seg === 'node_modules' || seg === 'dist' || seg === '.git') return true
    if (seg.startsWith('.') && seg !== '.gitignore' && seg !== '.' && seg !== '..') return true
  }
  for (const p of gi.patterns) {
    if (p.negate) continue
    const normPattern = p.pattern.replace(/^\//, '')
    if (normPattern.includes('*')) {
      const regex = new RegExp('^' + normPattern.replace(/\*/g, '.*') + '$')
      if (regex.test(relPath) || regex.test(path.basename(relPath))) return true
      continue
    }
    if (relPath === normPattern || relPath.startsWith(normPattern + '/') || relPath.includes('/' + normPattern)) return true
    if (path.basename(relPath) === normPattern) return true
  }
  return false
}

function computeQualifiedName(relPath: string, name: string, parentName: string | null): string {
  const noExt = relPath.replace(/\.[^/.]+$/, '')
  if (parentName) return `${noExt}.${parentName}.${name}`
  return `${noExt}.${name}`
}

/**
 * Bump when parse/extraction logic changes in a way that requires re-parsing
 * ALREADY-indexed files — their mtimes are unchanged, so staleness alone never
 * triggers a reparse. Stamped into the DB `user_version`; a lower stamp forces a
 * one-time full reparse on open. v1 = dynamic-import call-site recording.
 */
const CODEGRAPH_PARSE_VERSION = 1

/**
 * `--end-of-options` (git >= 2.24) blocks a caller-supplied ref/revision from
 * ever being parsed as an option, independent of the rev-parse guard in
 * `diffImpact`. The daemon ships to machines with an unknown git version, so
 * this is feature-tested once (cheap: `git --version`, no repo access) and
 * cached — a hard version dependency would break on an older fleet install.
 * On unsupported git, `diffImpact` falls back to the rev-parse guard alone
 * for `git rev-parse`, and to a bare trailing `--` for `git diff` (weaker,
 * but the guard already rejects the option-shaped values that matter today).
 */
let supportsEndOfOptions: boolean | undefined
function gitSupportsEndOfOptions(): boolean {
  if (supportsEndOfOptions !== undefined) return supportsEndOfOptions
  try {
    const raw = execFileSync('git', ['--version'], { encoding: 'utf-8', timeout: 5000 })
    const m = raw.match(/(\d+)\.(\d+)/)
    const major = m ? parseInt(m[1], 10) : 0
    const minor = m ? parseInt(m[2], 10) : 0
    supportsEndOfOptions = major > 2 || (major === 2 && minor >= 24)
  } catch {
    supportsEndOfOptions = false
  }
  return supportsEndOfOptions
}

class ProjectDb {
  private db: Database
  private closed = false
  private leases = 0
  private mutationVersion = 0
  private freshCallbackDepth = 0
  private freshnessFlight: Promise<void> | null = null

  get busy(): boolean { return this.indexing || this.leases > 0 }

  acquire(): void {
    if (this.closed) throw new Error('Codegraph project is closed')
    this.leases++
  }

  release(): void { this.leases-- }

  /** No TTL: overlapping queries share discovery; the next query starts a new sweep. */
  async withFreshSnapshot<T>(fn: (project: ProjectDb) => T extends PromiseLike<unknown> ? never : T): Promise<T> {
    this.acquire()
    try {
      if (!this.freshnessFlight) {
        this.freshnessFlight = this.refreshStaleAsync().finally(() => { this.freshnessFlight = null })
      }
      await this.freshnessFlight
      if (this.closed) throw new Error('Codegraph project is closed')
      const previous = this.freshCallbackDepth
      this.freshCallbackDepth++
      try {
        const result = fn(this)
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          throw new Error('Codegraph fresh snapshot callback must be synchronous')
        }
        return result as T
      } finally { this.freshCallbackDepth = previous }
    } finally { this.release() }
  }

  private async refreshStaleAsync(): Promise<void> {
    // Other connections (the index child) can commit while discovery is awaiting I/O.
    // Never apply a diff computed from an obsolete file table.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.closed) throw new Error('Codegraph project is closed')
      this.refreshGitignoreIfChanged()
      const mutation = this.mutationVersion
      const version = (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version
      const tracked = this.db.prepare('SELECT path, mtime_ms, bytes, parser_version FROM file').all() as { path: string; mtime_ms: number; bytes: number; parser_version: number }[]
      const stale: string[] = []
      const deleted: string[] = []
      // One promise per sweep, not per file: callback stat avoids thousands of
      // promise continuations on large projects while keeping I/O bounded.
      const statWork = new Promise<void>((resolve, reject) => {
        let next = 0
        let active = Math.min(32, tracked.length)
        let firstError: NodeJS.ErrnoException | undefined
        if (active === 0) { resolve(); return }
        const run = (): void => {
          const f = tracked[next++]
          statFile(path.join(this.projectRoot, f.path), (error, st) => {
            if (error) {
              if (error.code === 'ENOENT' || error.code === 'ENOTDIR') deleted.push(f.path)
              else firstError ??= error
            } else if (st.mtimeMs !== f.mtime_ms || st.size !== f.bytes || f.parser_version < CODEGRAPH_PARSE_VERSION) {
              stale.push(f.path)
            }
            // Stop scheduling on failure, but drain every outstanding callback
            // before rejection so a subsequent query cannot overlap an old pool.
            if (!firstError && next < tracked.length) run()
            else if (--active === 0) {
              if (firstError) reject(firstError)
              else resolve()
            }
          })
        }
        for (let worker = 0; worker < Math.min(32, tracked.length); worker++) run()
      })
      const collected = await Promise.allSettled([this.detectNewFilesAsync(tracked), statWork])
      for (const result of collected) if (result.status === 'rejected') throw result.reason
      const added = (collected[0] as PromiseFulfilledResult<string[]>).value
      if (this.closed) throw new Error('Codegraph project is closed')
      if (mutation !== this.mutationVersion || version !== (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version) continue
      if (!stale.length && !deleted.length && !added.length) return
      const apply = this.db.transaction(() => {
        if (mutation !== this.mutationVersion || version !== (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version) return false
        if (added.length || deleted.length) { this.cachedSourceCount = null; this.cachedUnsupportedLangs = null }
        // Apply only changed files. A large diff must not trigger another synchronous tree walk.
        if (stale.length || deleted.length || added.length) this.reparseFiles(stale, deleted, added)
        return true
      }) as unknown as { immediate: () => boolean }
      // Do not let SQLite's default busy sleep block protocol pings while an
      // index child owns the writer lock. Retry asynchronously and boundedly.
      const busyTimeout = (this.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout
      let applied = false
      let busy = false
      this.db.pragma('busy_timeout = 0')
      try { applied = apply.immediate() }
      catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error
        busy = true
      } finally { this.db.pragma(`busy_timeout = ${busyTimeout}`) }
      if (busy) await new Promise(resolve => setTimeout(resolve, 10))
      if (!applied) continue
      return
    }
    throw new Error('Codegraph index changed during freshness discovery; retry the query')
  }

  private async detectNewFilesAsync(tracked: { path: string }[]): Promise<string[]> {
    const trackedSet = new Set(tracked.map(f => f.path))
    const found = new Set<string>()
    const consider = (rel: string): void => {
      if (rel && isSourceFile(rel) && !trackedSet.has(rel) && !shouldIgnore(rel, this.gitignore)) found.add(rel)
    }
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        // Enumerate tracked and untracked names: status alone misses a new file
        // that was committed between queries. NUL framing preserves unusual names.
        execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
          cwd: this.projectRoot, encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024,
        }, (error, stdout) => error ? reject(error) : resolve(stdout))
      })
      for (const rel of raw.split('\0')) consider(rel)
    } catch {
      await this.walkFilesAsync(rel => { if (isSourceFile(rel) && !trackedSet.has(rel)) found.add(rel) })
    }
    return [...found]
  }
  private cwd: string
  private projectRoot: string
  private parser: Parser
  private langs: Record<string, Language>
  private gitignore: GitignorePatterns
  private gitignoreMtime: number = -1
  indexing: boolean = false
  private indexQueue: (() => void)[] = []
  private static activeIndexJobs = 0
  private static MAX_CONCURRENT_INDEX = 2
  private tsconfigCache: { paths: Record<string, string[]>, baseUrl: string | null } | null = null
  private svelteAppRootCache = new Map<string, string | null>()

  constructor(
    cwd: string,
    dbPath: string,
    parser: Parser,
    langs: Record<string, Language>,
  ) {
    this.cwd = cwd
    this.projectRoot = cwd
    this.parser = parser
    this.langs = langs
    this.gitignore = parseGitignore(this.projectRoot)
    this.gitignoreMtime = this.readGitignoreMtime()

    const dir = path.dirname(dbPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.db = BetterSqlite3(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.initSchema()
  }

  private readGitignoreMtime(): number {
    const giPath = path.join(this.projectRoot, '.gitignore')
    try {
      return statSync(giPath).mtimeMs
    } catch {
      return -1
    }
  }

  /**
   * Re-read `.gitignore` when its mtime changes so incremental re-index reflects
   * new ignore rules without forcing a full re-index (hardening: P2c item 3).
   */
  private refreshGitignoreIfChanged(): void {
    const mtime = this.readGitignoreMtime()
    if (mtime !== this.gitignoreMtime) {
      this.gitignore = parseGitignore(this.projectRoot)
      this.gitignoreMtime = mtime
    }
  }

  private initSchema(): void {
    const existing = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='call_edge'").get() as { sql: string } | undefined
    const needsMigration = !!(existing && !existing.sql.includes('ON DELETE SET NULL'))
    if (needsMigration) {
      this.db.exec('DROP TABLE IF EXISTS call_edge')
      this.db.exec('DROP TABLE IF EXISTS symbol')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file (
        path TEXT PRIMARY KEY, lang TEXT NOT NULL, content_hash TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, parsed_at_ms INTEGER NOT NULL,
        parser_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS symbol (
        id INTEGER PRIMARY KEY, file_path TEXT NOT NULL REFERENCES file(path),
        name TEXT NOT NULL, kind TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0, parent_id INTEGER REFERENCES symbol(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_name ON symbol(name);
      CREATE INDEX IF NOT EXISTS idx_symbol_qname ON symbol(qualified_name);
      CREATE INDEX IF NOT EXISTS idx_symbol_file ON symbol(file_path);
      CREATE TABLE IF NOT EXISTS import (
        id INTEGER PRIMARY KEY, file_path TEXT NOT NULL REFERENCES file(path),
        spec TEXT NOT NULL, imported_names TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reexport (
        id INTEGER PRIMARY KEY, file_path TEXT NOT NULL REFERENCES file(path),
        name TEXT NOT NULL, target_spec TEXT NOT NULL, star INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_reexport_file ON reexport(file_path);
      CREATE TABLE IF NOT EXISTS call_edge (
        id INTEGER PRIMARY KEY, caller_id INTEGER NOT NULL REFERENCES symbol(id),
        callee_name TEXT NOT NULL, callee_resolved_id INTEGER REFERENCES symbol(id) ON DELETE SET NULL,
        line INTEGER NOT NULL, candidate INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_call_caller ON call_edge(caller_id);
      CREATE INDEX IF NOT EXISTS idx_call_callee ON call_edge(callee_resolved_id);
      CREATE INDEX IF NOT EXISTS idx_call_candidate ON call_edge(candidate);
    `)
    // P2b: add the `candidate` column to pre-existing DBs (resolution-coverage
    // now only counts call edges that are genuine resolution targets — i.e.
    // imported names or local symbols — not builtin/method calls like
    // `console.log` / `arr.push`).
    const colInfo = this.db.prepare('PRAGMA table_info(call_edge)').all() as { name: string }[]
    if (!colInfo.some(c => c.name === 'candidate')) {
      this.db.exec('ALTER TABLE call_edge ADD COLUMN candidate INTEGER NOT NULL DEFAULT 1')
    }

    const fileColInfo = this.db.prepare('PRAGMA table_info(file)').all() as { name: string }[]
    if (!fileColInfo.some(c => c.name === 'parser_version')) {
      this.db.exec('ALTER TABLE file ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0')
    }

    // F4: on migration we dropped symbol + call_edge but kept the file rows. A
    // subsequent non-force index would see matching hash/mtime and skip every
    // file, leaving symbols empty forever. Clear file + import so the next index
    // re-parses everything from scratch.
    if (needsMigration) {
      this.db.exec('DELETE FROM import')
      this.db.exec('DELETE FROM file')
    }

    // Parser-version gate: when extraction logic changes (e.g. the dynamic-import
    // detector) an existing DB has unchanged file mtimes and would never reparse.
    // Instead of wiping the entire DB (which forces a full rebuild), we flag every
    // file as stale by resetting its parser_version to 0. The next incremental
    // index (via refreshStale) reparses only the out-of-version files, a few per
    // health-ping tick. No destructive DELETE, no full reparse storm.
    const stamped = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (stamped < CODEGRAPH_PARSE_VERSION) {
      this.db.exec('UPDATE file SET parser_version = 0')
      this.db.exec(`PRAGMA user_version = ${CODEGRAPH_PARSE_VERSION}`)
    }
  }

  close(): void {
    this.closed = true
    this.db.close()
  }

  refreshStale(): { stale: number; deleted: number; added: number } {
    if (this.freshCallbackDepth) return { stale: 0, deleted: 0, added: 0 }
    this.refreshGitignoreIfChanged()
    const tracked = this.db.prepare('SELECT path, mtime_ms, bytes, parser_version FROM file').all() as { path: string; mtime_ms: number; bytes: number; parser_version: number }[]
    if (tracked.length === 0) return { stale: 0, deleted: 0, added: 0 }

    const stalePaths: string[] = []
    const deletedPaths: string[] = []

    for (const f of tracked) {
      const absPath = path.join(this.projectRoot, f.path)
      try {
        const st = statSync(absPath)
        if (st.mtimeMs !== f.mtime_ms || st.size !== f.bytes || f.parser_version < CODEGRAPH_PARSE_VERSION) {
          stalePaths.push(f.path)
        }
      } catch {
        deletedPaths.push(f.path)
      }
    }

    const newFiles = this.detectNewFiles(tracked)

    // F5: capture the drift counts from THIS sweep before we reparse/refresh
    // stored mtimes — callers (status()) report these, otherwise a post-refresh
    // recount always sees 0.
    const drift = { stale: stalePaths.length, deleted: deletedPaths.length, added: newFiles.length }
    if (deletedPaths.length || newFiles.length) { this.cachedSourceCount = null; this.cachedUnsupportedLangs = null } // file set changed — invalidate cached count

    if (stalePaths.length === 0 && deletedPaths.length === 0 && newFiles.length === 0) return drift

    const totalFiles = tracked.length
    const changedCount = stalePaths.length + deletedPaths.length + newFiles.length
    if (totalFiles > 0 && changedCount / totalFiles > 0.1) {
      this.index(true)
      return drift
    }

    this.reparseFiles(stalePaths, deletedPaths, newFiles)
    return drift
  }

  private detectNewFiles(tracked: { path: string }[]): string[] {
    const trackedSet = new Set(tracked.map(f => f.path))
    const newFiles: string[] = []
    const consider = (relPath: string): void => {
      if (!relPath) return
      if (!isSourceFile(relPath)) return
      if (trackedSet.has(relPath)) return
      if (shouldIgnore(relPath, this.gitignore)) return
      newFiles.push(relPath)
    }
    try {
      // F2/F3: porcelain=v2 gives unambiguous, per-field records; -z makes paths
      // NUL-terminated (safe for spaces/quotes); --untracked-files=all lists every
      // untracked file individually instead of collapsing a new dir to `?? src/sub/`.
      const raw = execFileSync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const tokens = raw.split('\0')
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]
        if (!tok) continue
        const kind = tok[0]
        if (kind === '1') {
          // Ordinary change: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
          const parts = tok.split(' ')
          consider(parts.slice(8).join(' '))
        } else if (kind === '2') {
          // Rename/copy: "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>"
          // followed by a separate NUL-terminated <origPath> token. The DEST path
          // is the new location — index it. The origPath is pruned as deleted by
          // the stat sweep, so old symbols don't linger.
          const parts = tok.split(' ')
          consider(parts.slice(9).join(' '))
          i++ // consume the origPath token
        } else if (kind === '?') {
          // Untracked: "? <path>"
          consider(tok.slice(2))
        }
        // '!' (ignored) and 'u' (unmerged) are intentionally skipped.
      }
    } catch {
      this.walkFiles((relPath) => {
        if (isSourceFile(relPath) && !trackedSet.has(relPath)) {
          newFiles.push(relPath)
        }
      })
    }
    return newFiles
  }

  private reparseFiles(stalePaths: string[], deletedPaths: string[], newFiles: string[]): void {
    const now = Date.now()
    const insertFile = this.db.prepare('INSERT OR REPLACE INTO file (path, lang, content_hash, mtime_ms, bytes, parsed_at_ms, parser_version) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insertSymbol = this.db.prepare('INSERT INTO symbol (file_path, name, kind, qualified_name, start_line, end_line, exported, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const insertImport = this.db.prepare('INSERT INTO import (file_path, spec, imported_names) VALUES (?, ?, ?)')
    const insertReexport = this.db.prepare('INSERT INTO reexport (file_path, name, target_spec, star) VALUES (?, ?, ?, ?)')
    const insertCall = this.db.prepare('INSERT INTO call_edge (caller_id, callee_name, callee_resolved_id, line, candidate) VALUES (?, ?, ?, ?, ?)')
    const clearFile = this.db.prepare('DELETE FROM file WHERE path = ?')
    const clearSymbols = this.db.prepare('DELETE FROM symbol WHERE file_path = ?')
    const clearImports = this.db.prepare('DELETE FROM import WHERE file_path = ?')
    const clearReexports = this.db.prepare('DELETE FROM reexport WHERE file_path = ?')
    const clearCalls = this.db.prepare('DELETE FROM call_edge WHERE caller_id IN (SELECT id FROM symbol WHERE file_path = ?)')

    const txn = this.db.transaction(() => {
      for (const relPath of deletedPaths) {
        clearCalls.run(relPath)
        clearSymbols.run(relPath)
        clearImports.run(relPath)
        clearReexports.run(relPath)
        clearFile.run(relPath)
      }

      const toParse = [...stalePaths, ...newFiles]
      for (const relPath of toParse) {
        const absPath = path.join(this.projectRoot, relPath)
        let content: string
        let st: ReturnType<typeof statSync>
        try {
          content = readFileSync(absPath, 'utf-8')
          st = statSync(absPath)
        } catch {
          continue
        }

        clearCalls.run(relPath)
        clearSymbols.run(relPath)
        clearImports.run(relPath)
        clearReexports.run(relPath)
        clearFile.run(relPath)

        const contentHash = sha256(content)
        const parsed = parseFile(content, relPath, this.parser, this.langs)
        insertFile.run(relPath, detectLang(relPath), contentHash, st.mtimeMs, st.size, now, CODEGRAPH_PARSE_VERSION)

        const symbolIds: Map<string, { id: number; name: string; kind: string }> = new Map()
        const methodEntries: { sym: ParsedSymbol; newId: number }[] = []

        for (const sym of parsed.symbols) {
          let parentId: number | null = null
          if (sym.parentName !== null) {
            const parent = symbolIds.get(sym.parentName)
            if (parent) parentId = parent.id
          }
          const qn = computeQualifiedName(relPath, sym.name, null)
          const result = insertSymbol.run(relPath, sym.name, sym.kind, qn, sym.start_line, sym.end_line, sym.exported ? 1 : 0, parentId)
          const newId = Number(result.lastInsertRowid)
          symbolIds.set(sym.name, { id: newId, name: sym.name, kind: sym.kind })
          if (sym.kind === 'method') methodEntries.push({ sym, newId })
        }

        for (const { sym, newId } of methodEntries) {
          if (sym.parentName) {
            const methodQn = computeQualifiedName(relPath, sym.name, sym.parentName)
            this.db.prepare('UPDATE symbol SET qualified_name = ? WHERE id = ?').run(methodQn, newId)
          }
        }

        for (const imp of parsed.imports) {
          const namesJson = JSON.stringify(imp.imported_names)
          if (namesJson !== '[]') insertImport.run(relPath, imp.spec, namesJson)
        }

        for (const re of parsed.reexports) {
          insertReexport.run(relPath, re.name, re.target_spec, re.star ? 1 : 0)
        }

        for (const call of parsed.calls) {
          const containingSymbol = this.findContainingSymbol(parsed.symbols, call.line)
          if (containingSymbol) {
            const symInfo = symbolIds.get(containingSymbol.name)
            if (symInfo) {
              const cand = this.callIsCandidate(call.callee_name, parsed.imports, parsed.symbols) ? 1 : 0
              insertCall.run(symInfo.id, call.callee_name, null, call.line, cand)
            }
          }
        }
      }

      this.resolutionPass()
    })

    txn()
    this.mutationVersion++
  }

  status(openDbs?: number): CodegraphStatus {
    // Read-only: never calls refreshStale() or triggers any reparse.
    // Stale count = files whose parser_version is behind current (version bump),
    // not disk-drift (that's for the explicit index path to discover).
    const staleRow = this.db.prepare('SELECT COUNT(*) as c FROM file WHERE parser_version < ?').get(CODEGRAPH_PARSE_VERSION) as { c: number }
    const stale = staleRow?.c ?? 0
    const fileRow = this.db.prepare('SELECT COUNT(*) as c FROM file').get() as { c: number }
    const indexed = fileRow?.c ?? 0

    const lastRow = this.db.prepare('SELECT MAX(parsed_at_ms) as t FROM file').get() as { t: number | null }
    const lastIndexedAt = lastRow?.t ?? null

    // Only candidate edges count toward resolutionCoverage (builtin/method
    // calls are excluded from the denominator — see getResolutionCoverage).
    const resolved = this.db.prepare('SELECT COUNT(*) as c FROM call_edge WHERE candidate = 1 AND callee_resolved_id IS NOT NULL').get() as { c: number }
    const unresolved = this.db.prepare('SELECT COUNT(*) as c FROM call_edge WHERE candidate = 1 AND callee_resolved_id IS NULL').get() as { c: number }

    return {
      indexed,
      total: this.countSourceFiles(),
      stale,
      lastIndexedAt,
      indexing: this.indexing,
      openDbs: openDbs ?? 0,
      resolutionCoverage: {
        resolved: resolved?.c ?? 0,
        unresolved: unresolved?.c ?? 0,
      },
      unsupportedLanguages: this.scanUnsupportedLanguages(),
    }
  }

  // Memoized: status() runs on every 30s daemon health-ping, and a full walkFiles()
  // FS traversal per tick was burning ~50% CPU while idle. Cache the count; invalidate
  // only when the file set actually changes (index / add / delete). The unsupported-
  // language histogram (issue #71) piggybacks on the SAME walk/cache — a second
  // independent tree traversal would reintroduce that exact regression.
  private cachedSourceCount: number | null = null
  private cachedUnsupportedLangs: string[] | null = null
  // Post-hoc review (#71): unlike cachedSourceCount, whose invalidation triggers
  // (detectNewFiles / the stat-sweep deletion loop) only ever look at SUPPORTED
  // extensions, an unsupported file being added or removed is invisible to both —
  // detectNewFiles gates on isSourceFile() before considering a path, and the
  // deletion sweep only iterates DB-tracked (i.e. already-supported) files. So
  // cachedUnsupportedLangs could go stale in both directions (false negative on
  // add, false positive on delete) and never self-heal, since the production
  // daemon's 30s status health-ping keeps the parent cache permanently primed —
  // reproduced independently by two reviewers. Correctly detecting unsupported-
  // file drift without a full walk would need real design work (git-status-based
  // detection breaks down the moment such files are already committed, which is
  // the common case); instead bound the staleness window with a TTL. The full
  // walk this forces measures ~7ms on this codebase (reviewer-measured) — cheap
  // enough to eat periodically without reintroducing the per-tick CPU regression
  // the memoization exists to prevent.
  private cachedUnsupportedLangsAt = 0
  private static readonly UNSUPPORTED_LANGS_TTL_MS = 60_000
  private scanSourceTree(): void {
    // Dedicated FAST count: skip node_modules/.git entirely (source files never live
    // there) and use one readdir(withFileTypes) per dir — no per-entry lstat. The
    // resolution-oriented walkFiles() descends node_modules/@scope for workspace-symlink
    // discovery, which is a ~54s FS-syscall storm in a big monorepo and is irrelevant to
    // simply counting the project's own source files.
    let count = 0
    const unsupportedCounts = new Map<string, number>()
    const walk = (dir: string): void => {
      let entries: import('node:fs').Dirent[]
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const rel = path.relative(this.projectRoot, path.join(dir, e.name))
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.git') continue
          if (shouldIgnore(rel, this.gitignore)) continue
          walk(path.join(dir, e.name))
        } else if (e.isFile()) {
          if (isSourceFile(rel)) {
            count++
          } else {
            const ext = path.extname(rel).toLowerCase()
            const lang = UNSUPPORTED_SOURCE_EXTS[ext]
            if (lang) unsupportedCounts.set(lang, (unsupportedCounts.get(lang) ?? 0) + 1)
          }
        }
      }
    }
    walk(this.projectRoot)
    this.cachedSourceCount = count
    this.cachedUnsupportedLangs = [...unsupportedCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([lang]) => lang)
    this.cachedUnsupportedLangsAt = Date.now()
  }
  private countSourceFiles(): number {
    if (this.cachedSourceCount === null) this.scanSourceTree()
    return this.cachedSourceCount as number
  }
  private scanUnsupportedLanguages(): string[] {
    if (this.cachedUnsupportedLangs === null || Date.now() - this.cachedUnsupportedLangsAt > ProjectDb.UNSUPPORTED_LANGS_TTL_MS) {
      this.scanSourceTree()
    }
    return this.cachedUnsupportedLangs as string[]
  }

  private walkFiles(fn: (relPath: string) => void): void {
    const visitedRealpaths = new Set<string>()
    const walkDir = (dir: string): void => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry)
        let lst: ReturnType<typeof lstatSync>
        try {
          lst = lstatSync(fullPath)
        } catch {
          continue
        }
        const relPath = path.relative(this.projectRoot, fullPath)

        // Workspace symlinks (spec §3 exception: workspace pkgs ARE indexed).
        // Follow symlinks whose real target lives OUTSIDE any node_modules —
        // those are workspace/monorepo source links. Genuine dependency
        // symlinks point INTO node_modules and are never followed.
        if (lst.isSymbolicLink()) {
          let real: string
          try {
            real = realpathSync(fullPath)
          } catch {
            continue
          }
          if (this.isInsideNodeModules(real)) continue
          if (visitedRealpaths.has(real)) continue
          visitedRealpaths.add(real)
          try {
            const st = statSync(fullPath)
            if (st.isDirectory()) {
              walkDir(real)
            } else if (st.isFile() && isSourceFile(fullPath)) {
              fn(path.relative(this.projectRoot, real))
            }
          } catch {
            continue
          }
          continue
        }

        if (lst.isDirectory()) {
          const segs = relPath.split('/')
          if (segs.includes('node_modules')) {
            // Inside node_modules: descend only into `@scope` dirs (to discover
            // workspace symlinks) and the top-level node_modules itself. Never
            // crawl genuine dependency directories or their files. This bypasses
            // shouldIgnore's node_modules rule so workspace links stay reachable.
            if (relPath !== 'node_modules' && !entry.startsWith('@')) continue
            walkDir(fullPath)
            continue
          }
          if (shouldIgnore(relPath, this.gitignore)) continue
          walkDir(fullPath)
        } else if (lst.isFile()) {
          if (shouldIgnore(relPath, this.gitignore)) continue
          fn(relPath)
        }
      }
    }
    walkDir(this.projectRoot)
  }

  private async walkFilesAsync(fn: (relPath: string) => void): Promise<void> {
    const visitedRealpaths = new Set<string>()
    const walkDir = async (dir: string): Promise<void> => {
      let entries: string[]
      try {
        entries = await asyncFs.readdir(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry)
        let lst: ReturnType<typeof lstatSync>
        try {
          lst = await asyncFs.lstat(fullPath)
        } catch {
          continue
        }
        const relPath = path.relative(this.projectRoot, fullPath)

        // Workspace symlinks (spec §3 exception: workspace pkgs ARE indexed).
        // Follow symlinks whose real target lives OUTSIDE any node_modules —
        // those are workspace/monorepo source links. Genuine dependency
        // symlinks point INTO node_modules and are never followed.
        if (lst.isSymbolicLink()) {
          let real: string
          try {
            real = await asyncFs.realpath(fullPath)
          } catch {
            continue
          }
          if (this.isInsideNodeModules(real)) continue
          if (visitedRealpaths.has(real)) continue
          visitedRealpaths.add(real)
          try {
            const st = await asyncFs.stat(fullPath)
            if (st.isDirectory()) {
              await walkDir(real)
            } else if (st.isFile() && isSourceFile(fullPath)) {
              fn(path.relative(this.projectRoot, real))
            }
          } catch {
            continue
          }
          continue
        }

        if (lst.isDirectory()) {
          const segs = relPath.split('/')
          if (segs.includes('node_modules')) {
            // Inside node_modules: descend only into `@scope` dirs (to discover
            // workspace symlinks) and the top-level node_modules itself. Never
            // crawl genuine dependency directories or their files. This bypasses
            // shouldIgnore's node_modules rule so workspace links stay reachable.
            if (relPath !== 'node_modules' && !entry.startsWith('@')) continue
            await walkDir(fullPath)
            continue
          }
          if (shouldIgnore(relPath, this.gitignore)) continue
          await walkDir(fullPath)
        } else if (lst.isFile()) {
          if (shouldIgnore(relPath, this.gitignore)) continue
          fn(relPath)
        }
      }
    }
    await walkDir(this.projectRoot)
  }

  // ── TS/JS module resolution (Phase 2b) ──────────────────────────────────────
  //
  // Resolves an import specifier to a source file that is indexed in THIS db.
  // Handles: relative/absolute, .js→source mapping, directory index imports,
  // tsconfig `paths`/`baseUrl` aliases, and bare workspace-package specs via
  // node_modules symlinks + package.json `exports` maps (mapped to source).

  private isInsideNodeModules(p: string): boolean {
    return p.split(path.sep).includes('node_modules')
  }

  /**
   * Try a base path (no extension) against the candidate extension/index set and
   * return the project-relative path of the first candidate that is actually
   * indexed in the db. External (unindexed) files are intentionally rejected so
   * that resolution stays truthful.
   */
  private tryResolve(absBase: string): string | null {
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go']
    const candidates = [
      absBase,
      ...exts.map(e => absBase + e),
      ...exts.map(e => path.join(absBase, 'index' + e)),
      path.join(absBase, '__init__.py'),
    ]
    for (const c of candidates) {
      if (existsSync(c)) {
        const relPath = path.relative(this.projectRoot, c)
        const dbFile = this.db.prepare('SELECT path FROM file WHERE path = ?').get(relPath) as { path: string } | undefined
        if (dbFile) return relPath
      }
    }
    return null
  }

  /** Load and cache the project's tsconfig `paths`/`baseUrl` (supports `extends`). */
  private loadTsconfig(): { paths: Record<string, string[]>, baseUrl: string | null } {
    if (this.tsconfigCache) return this.tsconfigCache
    const result: { paths: Record<string, string[]>, baseUrl: string | null } = { paths: {}, baseUrl: null }
    try {
      const cfgPath = path.join(this.projectRoot, 'tsconfig.json')
      if (existsSync(cfgPath)) {
        const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'))
        const cc = (raw.compilerOptions ?? {}) as Record<string, unknown>
        if (typeof cc['baseUrl'] === 'string') result.baseUrl = cc['baseUrl']
        if (cc['paths'] && typeof cc['paths'] === 'object') {
          result.paths = cc['paths'] as Record<string, string[]>
        }
        if (typeof raw.extends === 'string') {
          const basePath = path.resolve(path.dirname(cfgPath), raw.extends)
          if (existsSync(basePath)) {
            try {
              const baseRaw = JSON.parse(readFileSync(basePath, 'utf-8'))
              const bcc = (baseRaw.compilerOptions ?? {}) as Record<string, unknown>
              if (!result.baseUrl && typeof bcc['baseUrl'] === 'string') result.baseUrl = bcc['baseUrl']
              if (bcc['paths'] && typeof bcc['paths'] === 'object') {
                result.paths = { ...(bcc['paths'] as Record<string, string[]>), ...result.paths }
              }
            } catch { /* ignore bad base */ }
          }
        }
      }
    } catch { /* no tsconfig: empty map */ }
    this.tsconfigCache = result
    return result
  }

  /** Resolve a tsconfig `paths` alias (e.g. `@/lib/x` or `@app/*`). */
  private resolveTsconfigPath(_importerFile: string, spec: string): string | null {
    const tc = this.loadTsconfig()
    if (!tc.paths || Object.keys(tc.paths).length === 0) return null
    const baseDir = tc.baseUrl ? path.resolve(this.projectRoot, tc.baseUrl) : this.projectRoot

    for (const [pattern, targets] of Object.entries(tc.paths)) {
      if (pattern.includes('*')) {
        const starIdx = pattern.indexOf('*')
        const pfx = pattern.slice(0, starIdx)
        const sfx = pattern.slice(starIdx + 1)
        if (spec.startsWith(pfx) && (sfx === '' || spec.endsWith(sfx))) {
          const star = sfx === '' ? spec.slice(pfx.length) : spec.slice(pfx.length, -sfx.length)
          for (const t of targets) {
            const candidate = path.resolve(baseDir, t.replace('*', star))
            const r = this.tryResolve(candidate)
            if (r) return r
          }
        }
      } else if (pattern === spec) {
        for (const t of targets) {
          const candidate = path.resolve(baseDir, t)
          const r = this.tryResolve(candidate)
          if (r) return r
        }
      }
    }
    return null
  }

  /** Map a package.json `exports` target (usually under `dist`) to its source file. */
  private mapExportToSource(relTarget: string): string {
    let s = relTarget.replace(/^\.\//, '')
    // dist/ → src/ (and dist.js-ish prefixes)
    s = s.replace(/\bdist\b/, 'src')
    s = s.replace(/\.jsx$/, '.tsx').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts').replace(/\.js$/, '.ts')
    return s
  }

  /**
   * Reduce a package.json `exports` value to a string target. Conditional-exports
   * entries nest (`"import": { "types": "...", "default": "..." }`), so recurse
   * through the standard condition keys until a string is found. Returns null for
   * shapes that don't reduce to a string — MUST NOT throw: a single package with a
   * nested exports map would otherwise abort the entire index (was: relTarget.replace
   * crash on the object left by an `as string` cast).
   */
  private pickExportString(entry: unknown): string | null {
    if (typeof entry === 'string') return entry
    if (entry && typeof entry === 'object') {
      const cond = entry as Record<string, unknown>
      for (const key of ['import', 'module', 'require', 'default', 'node', 'types']) {
        const r = this.pickExportString(cond[key])
        if (r) return r
      }
    }
    return null
  }

  /** Pick the source-ish target for a subpath from a package.json `exports` map. */
  private resolveExportsTarget(pkgJson: Record<string, unknown>, subpath: string): string | null {
    const exportsField = pkgJson['exports']
    const exportKey = subpath === '' ? '.' : '.' + subpath
    let exportEntry: unknown
    if (typeof exportsField === 'string') {
      exportEntry = subpath === '' ? exportsField : null
    } else if (exportsField && typeof exportsField === 'object') {
      const map = exportsField as Record<string, unknown>
      exportEntry = map[exportKey] ?? (subpath === '' ? map['.'] : undefined)
      if (!exportEntry && subpath !== '') {
        // allow nested key match like "./sub" even without leading dot
        exportEntry = map[subpath] ?? map['./' + subpath.replace(/^\//, '')]
      }
    }
    const target = this.pickExportString(exportEntry)
    if (target) return target
    // No exports map: fall back to `main` or a guessed subpath.
    if (subpath === '') {
      const main = (pkgJson['main'] as string | undefined) ?? 'index.js'
      return main
    }
    return subpath.replace(/^\//, '') + '.js'
  }

  /**
   * Resolve a bare package specifier (`@jerico/shared`, `lodash`, `@scope/pkg/sub`)
   * by walking up node_modules, following the (workspace) symlink to real source,
   * and mapping the package.json `exports` target to its source file.
   * Genuine third-party deps resolve to an unindexed file → returns null (counted
   * as unresolved, never dropped silently).
   */
  private resolvePackageSpec(importerFile: string, spec: string): string | null {
    const importerDir = path.dirname(path.join(this.projectRoot, importerFile))
    const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    const subpath = spec.slice(pkgName.length)

    let dir = importerDir
    let pkgDir: string | null = null
    while (true) {
      const candidate = path.join(dir, 'node_modules', pkgName)
      if (existsSync(candidate)) {
        pkgDir = candidate
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    if (!pkgDir) return null

    let realPkgDir: string
    try {
      realPkgDir = realpathSync(pkgDir)
    } catch {
      realPkgDir = pkgDir
    }
    const pkgJsonPath = path.join(realPkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) return null
    let pkgJson: Record<string, unknown>
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    } catch {
      return null
    }

    const exportTarget = this.resolveExportsTarget(pkgJson, subpath)
    if (!exportTarget) return null

    // Prefer the source mapping (dist→src); fall back to the literal export.
    const srcAbs = path.resolve(realPkgDir, this.mapExportToSource(exportTarget))
    const srcRel = this.tryResolve(srcAbs)
    if (srcRel) return srcRel
    const litAbs = path.resolve(realPkgDir, exportTarget.replace(/^\.\//, ''))
    return this.tryResolve(litAbs)
  }

  private resolveImportPath(importerFile: string, spec: string): string | null {
    try {
      return this.resolveImportPathUnsafe(importerFile, spec)
    } catch {
      // Defense-in-depth: a malformed dependency (bad exports map, broken symlink,
      // unexpected package.json shape) must never abort the whole index — a single
      // failed import resolution degrades to "unresolved", not a crashed run.
      return null
    }
  }

  /**
   * Resolve a Python import spec (issue #90). Python's dotted-path notation is NOT
   * POSIX path syntax (`..services.tracking` is not "go up a directory"), so it needs
   * its own resolver entirely separate from the JS relative-path/tsconfig/node_modules
   * chain below — falling through into that chain would misinterpret the leading dots.
   *
   * - Relative (`spec` starts with `.`): dot count N means "the package N-1 levels
   *   above the importer's own directory" (Python semantics: one dot = the importer's
   *   own package, two dots = its parent package, ...). The remaining dotted segments
   *   (if any) are joined as a path under that directory.
   * - Absolute, intra-project (`app.services.tracking`): no config-file-based source-root
   *   concept exists for Python in this codebase (and none is added here — see the
   *   ancestor-walk below). Walk up from the importer's own directory to the project
   *   root, trying `<ancestor>/<dotted-path-as-segments>` at each level; the nearest
   *   ancestor that actually resolves to an indexed file wins. This handles the common
   *   `backend/app/...`-style and `src/<pkg>/...`-style layouts without parsing
   *   `pyproject.toml`/`setup.py`/namespace-package conventions.
   * - A genuinely external import (e.g. `import requests`) never resolves under either
   *   branch and correctly falls through to unresolved.
   */
  private resolvePythonImport(importerFile: string, spec: string): string | null {
    const importerDir = path.dirname(path.join(this.projectRoot, importerFile))

    const dotMatch = spec.match(/^\.+/)
    if (dotMatch) {
      const dotCount = dotMatch[0].length
      const remainder = spec.slice(dotCount)
      let dir = importerDir
      for (let i = 0; i < dotCount - 1; i++) dir = path.dirname(dir)
      const target = remainder ? path.join(dir, ...remainder.split('.')) : dir
      return this.tryResolve(target)
    }

    const modulePath = path.join(...spec.split('.'))
    let dir = importerDir
    while (true) {
      const r = this.tryResolve(path.join(dir, modulePath))
      if (r) return r
      if (path.resolve(dir) === path.resolve(this.projectRoot)) break
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  private findNearestSvelteAppRoot(startDir: string): string | null {
    const cached = this.svelteAppRootCache.get(startDir)
    if (cached !== undefined) return cached

    const configNames = ['svelte.config.js', 'svelte.config.cjs', 'svelte.config.mjs', 'svelte.config.ts']
    let dir = startDir
    let result: string | null = null
    const rootResolved = path.resolve(this.projectRoot)
    while (true) {
      if (configNames.some((n) => existsSync(path.join(dir, n)))) {
        result = dir
        break
      }
      if (path.resolve(dir) === rootResolved) break
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    this.svelteAppRootCache.set(startDir, result)
    return result
  }

  private resolveImportPathUnsafe(importerFile: string, spec: string): string | null {
    if (importerFile.endsWith('.py')) {
      return this.resolvePythonImport(importerFile, spec)
    }
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const importerDir = path.dirname(path.join(this.projectRoot, importerFile))
      const resolved = path.resolve(importerDir, spec)
      const jsMatch = resolved.match(/\.(js|jsx|mjs|cjs)$/)
      if (jsMatch) {
        const stem = resolved.slice(0, -jsMatch[0].length)
        return this.tryResolve(stem)
      }
      return this.tryResolve(resolved)
    }
    // SvelteKit `$lib` alias — maps `$lib` -> `<sveltekit-app-root>/src/lib`.
    // In a monorepo the app root is not projectRoot; walk up from the importer
    // to find the nearest ancestor containing a svelte.config.* file, bounded
    // by projectRoot. Fall back to projectRoot for single-package projects.
    if (spec === '$lib' || spec.startsWith('$lib/')) {
      const importerDir = path.dirname(path.join(this.projectRoot, importerFile))
      const appRoot = this.findNearestSvelteAppRoot(importerDir) ?? this.projectRoot
      const rest = spec === '$lib' ? 'index' : spec.slice('$lib/'.length)
      const r = this.tryResolve(path.join(appRoot, 'src', 'lib', rest))
      if (r) return r
    }
    // bare specifier: tsconfig paths first, then workspace/package resolution
    const tc = this.resolveTsconfigPath(importerFile, spec)
    if (tc) return tc
    return this.resolvePackageSpec(importerFile, spec)
  }

  /**
   * Resolve `name` to its defining symbol, following barrel re-export chains
   * (`export { x } from './y'`, `export * from './y'`) with cycle guarding.
   */
  private resolveSymbolInModule(moduleFile: string, name: string, visited: Set<string>): number | null {
    const key = moduleFile + '#' + name
    if (visited.has(key)) return null
    visited.add(key)

    const direct = this.db.prepare('SELECT id FROM symbol WHERE file_path = ? AND name = ? AND exported = 1').get(moduleFile, name) as { id: number } | undefined
    if (direct) return direct.id

    const named = this.db.prepare('SELECT target_spec FROM reexport WHERE file_path = ? AND name = ?').all(moduleFile, name) as { target_spec: string }[]
    for (const r of named) {
      const rp = this.resolveImportPath(moduleFile, r.target_spec)
      if (rp) {
        const id = this.resolveSymbolInModule(rp, name, visited)
        if (id !== null) return id
      }
    }

    const stars = this.db.prepare('SELECT target_spec FROM reexport WHERE file_path = ? AND star = 1').all(moduleFile) as { target_spec: string }[]
    for (const r of stars) {
      const rp = this.resolveImportPath(moduleFile, r.target_spec)
      if (rp) {
        const id = this.resolveSymbolInModule(rp, name, visited)
        if (id !== null) return id
      }
    }

    return null
  }

  /**
   * Whether a call edge is a genuine resolution *candidate*: its callee is an
   * imported name in the caller, or a symbol defined locally in the caller.
   * Builtin/method calls (`console.log`, `arr.push`, `map.get`) are NOT
   * candidates — they are not "unresolved imports" and must not deflate the
   * resolution rate (spec §7.1: unresolved = node_modules dead-zone or failed
   * imports, not language builtins).
   */
  private callIsCandidate(
    calleeName: string,
    imports: ParsedImport[],
    symbols: ParsedSymbol[],
  ): boolean {
    for (const imp of imports) {
      if (imp.imported_names.includes(calleeName) || imp.imported_names.includes('*')) return true
    }
    for (const s of symbols) {
      if (s.name === calleeName) return true
    }
    return false
  }

  private resolveCallee(
    calleeName: string,
    callerFile: string,
  ): number | null {
    const imports = this.db.prepare('SELECT spec, imported_names FROM import WHERE file_path = ?').all(callerFile) as { spec: string; imported_names: string }[]

    for (const imp of imports) {
      let names: string[]
      try {
        names = JSON.parse(imp.imported_names) as string[]
      } catch {
        continue
      }
      if (names.includes(calleeName) || names.includes('*')) {
        const resolvedPath = this.resolveImportPath(callerFile, imp.spec)
        if (resolvedPath) {
          const visited = new Set<string>()
          const id = this.resolveSymbolInModule(resolvedPath, calleeName, visited)
          if (id !== null) return id
        }
      }
    }

    const sym = this.db.prepare('SELECT id FROM symbol WHERE file_path = ? AND name = ?').get(callerFile, calleeName) as { id: number } | undefined
    if (sym) return sym.id

    return null
  }

  index(force?: boolean): IndexResult {
    this.refreshGitignoreIfChanged()
    this.cachedSourceCount = null; this.cachedUnsupportedLangs = null // a (re)index may change the file set — refresh the cached count
    const now = Date.now()
    const insertFile = this.db.prepare('INSERT OR REPLACE INTO file (path, lang, content_hash, mtime_ms, bytes, parsed_at_ms, parser_version) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insertSymbol = this.db.prepare('INSERT INTO symbol (file_path, name, kind, qualified_name, start_line, end_line, exported, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const insertImport = this.db.prepare('INSERT INTO import (file_path, spec, imported_names) VALUES (?, ?, ?)')
    const insertReexport = this.db.prepare('INSERT INTO reexport (file_path, name, target_spec, star) VALUES (?, ?, ?, ?)')
    const insertCall = this.db.prepare('INSERT INTO call_edge (caller_id, callee_name, callee_resolved_id, line, candidate) VALUES (?, ?, ?, ?, ?)')

    const clearFile = this.db.prepare('DELETE FROM file WHERE path = ?')
    const clearSymbols = this.db.prepare('DELETE FROM symbol WHERE file_path = ?')
    const clearImports = this.db.prepare('DELETE FROM import WHERE file_path = ?')
    const clearReexports = this.db.prepare('DELETE FROM reexport WHERE file_path = ?')
    const clearCalls = this.db.prepare('DELETE FROM call_edge WHERE caller_id IN (SELECT id FROM symbol WHERE file_path = ?)')

    const indexTxn = this.db.transaction(() => {
      let total = 0

      if (force) {
        this.db.exec('DELETE FROM call_edge')
        this.db.exec('DELETE FROM import')
        this.db.exec('DELETE FROM reexport')
        this.db.exec('DELETE FROM symbol')
        this.db.exec('DELETE FROM file')
      }

      const visitedPaths = new Set<string>()
      let fileCount = 0
      this.walkFiles((relPath) => {
        if (!isSourceFile(relPath)) return
        visitedPaths.add(relPath)
        const absPath = path.join(this.projectRoot, relPath)

        if (!absPath) {
          console.error(`[codegraph] SKIP: empty absPath (relPath=${relPath}, root=${this.projectRoot})`)
          return
        }

        let content: string
        let st: ReturnType<typeof statSync>
        try {
          content = readFileSync(absPath, 'utf-8')
          st = statSync(absPath)
        } catch {
          return
        }
        fileCount++

        const contentHash = sha256(content)
        const mtimeMs = st.mtimeMs
        const bytes = st.size

        if (!force) {
          const existing = this.db.prepare('SELECT content_hash, mtime_ms, bytes FROM file WHERE path = ?').get(relPath) as { content_hash: string; mtime_ms: number; bytes: number } | undefined
          if (existing && existing.content_hash === contentHash && existing.mtime_ms === mtimeMs && existing.bytes === bytes) {
            return
          }
        }

        clearCalls.run(relPath)
        clearSymbols.run(relPath)
        clearImports.run(relPath)
        clearReexports.run(relPath)
        clearFile.run(relPath)

        const parsed = parseFile(content, relPath, this.parser, this.langs)
        insertFile.run(relPath, detectLang(relPath), contentHash, mtimeMs, bytes, now, CODEGRAPH_PARSE_VERSION)

        const symbolIds: Map<string, { id: number; name: string; kind: string }> = new Map()

        const methodEntries: { sym: ParsedSymbol; newId: number }[] = []

        for (const sym of parsed.symbols) {
          let parentId: number | null = null
          if (sym.parentName !== null) {
            const parent = symbolIds.get(sym.parentName)
            if (parent) parentId = parent.id
          }
          const qn = computeQualifiedName(relPath, sym.name, null)
          const result = insertSymbol.run(relPath, sym.name, sym.kind, qn, sym.start_line, sym.end_line, sym.exported ? 1 : 0, parentId)
          const newId = Number(result.lastInsertRowid)
          symbolIds.set(sym.name, { id: newId, name: sym.name, kind: sym.kind })

          if (sym.kind === 'method') {
            methodEntries.push({ sym, newId })
          }
        }

        for (const { sym, newId } of methodEntries) {
          if (sym.parentName) {
            const methodQn = computeQualifiedName(relPath, sym.name, sym.parentName)
            this.db.prepare('UPDATE symbol SET qualified_name = ? WHERE id = ?').run(methodQn, newId)
          }
        }

        for (const imp of parsed.imports) {
          const namesJson = JSON.stringify(imp.imported_names)
          const spec = imp.spec
          if (namesJson !== '[]') {
            insertImport.run(relPath, spec, namesJson)
          }
        }

        for (const re of parsed.reexports) {
          insertReexport.run(relPath, re.name, re.target_spec, re.star ? 1 : 0)
        }

        for (const call of parsed.calls) {
          const containingSymbol = this.findContainingSymbol(parsed.symbols, call.line)
          if (containingSymbol) {
            const symInfo = symbolIds.get(containingSymbol.name)
            if (symInfo) {
              const cand = this.callIsCandidate(call.callee_name, parsed.imports, parsed.symbols) ? 1 : 0
              insertCall.run(symInfo.id, call.callee_name, null, call.line, cand)
            }
          }
        }

        total++
      })

      if (!force) {
        const dbFiles = this.db.prepare('SELECT path FROM file').all() as { path: string }[]
        for (const dbFile of dbFiles) {
          if (!visitedPaths.has(dbFile.path)) {
            clearCalls.run(dbFile.path)
            clearSymbols.run(dbFile.path)
            clearImports.run(dbFile.path)
            clearFile.run(dbFile.path)
          }
        }
      }

      this.resolutionPass()

      return total
    })

    const total = indexTxn()
    this.mutationVersion++
    return { status: 'indexed', total, unsupportedLanguages: this.scanUnsupportedLanguages() }
  }

  indexAsync(force?: boolean): IndexResult {
    if (this.indexing) {
      return { status: 'indexing', total: 0, unsupportedLanguages: this.scanUnsupportedLanguages() }
    }
    if (ProjectDb.activeIndexJobs >= ProjectDb.MAX_CONCURRENT_INDEX) {
      return { status: 'queued', total: 0, unsupportedLanguages: this.scanUnsupportedLanguages() }
    }
    this.indexing = true
    ProjectDb.activeIndexJobs++
    const doWork = () => {
      try {
        this.index(force)
      } catch {
      } finally {
        this.indexing = false
        ProjectDb.activeIndexJobs--
      }
    }
    setImmediate(doWork)
    return { status: 'indexing', total: 0, unsupportedLanguages: this.scanUnsupportedLanguages() }
  }

  private findContainingSymbol(symbols: ParsedSymbol[], line: number): ParsedSymbol | null {
    let best: ParsedSymbol | null = null
    let bestStart = -1
    for (const sym of symbols) {
      if (line >= sym.start_line && line <= sym.end_line) {
        if (sym.start_line > bestStart) {
          best = sym
          bestStart = sym.start_line
        }
      }
    }
    return best
  }

  private resolutionPass(): void {
    const edges = this.db.prepare('SELECT id, callee_name, caller_id FROM call_edge WHERE candidate = 1 AND callee_resolved_id IS NULL').all() as { id: number; callee_name: string; caller_id: number }[]

    const updateResolved = this.db.prepare('UPDATE call_edge SET callee_resolved_id = ? WHERE id = ?')

    for (const edge of edges) {
      const callerSym = this.db.prepare('SELECT file_path FROM symbol WHERE id = ?').get(edge.caller_id) as { file_path: string } | undefined
      if (!callerSym) continue
      const resolvedId = this.resolveCallee(edge.callee_name, callerSym.file_path)
      if (resolvedId !== null) {
        updateResolved.run(resolvedId, edge.id)
      }
    }
  }

  /**
   * Issue #68: exact-only leaf-name lookup, split out of the (now fuzzy)
   * public findSymbol() so structuralLookup()'s "try exact first" tier keeps
   * its original meaning — structuralLookup decides strategy:'exact' vs
   * 'fuzzy' based on this returning results, and that logic would break if
   * it called the fuzzy findSymbol() below (every non-empty fuzzy result
   * would get mislabeled 'exact').
   */
  private exactSymbolMatch(name: string, kind?: string, limit?: number, offset?: number): { results: SymbolResult[]; resolutionCoverage: { resolved: number; unresolved: number } } {
    this.refreshStale()
    const lim = limit ?? 50
    const off = offset ?? 0
    let sql = 'SELECT qualified_name, file_path, start_line, kind, exported FROM symbol WHERE name = ?'
    const params: unknown[] = [name]
    if (kind) {
      sql += ' AND kind = ?'
      params.push(kind)
    }
    sql += ' LIMIT ? OFFSET ?'
    params.push(lim, off)
    const rows = this.db.prepare(sql).all(...params) as { qualified_name: string; file_path: string; start_line: number; kind: string; exported: number }[]
    const results = rows.map(r => ({
      qualifiedName: r.qualified_name,
      file: r.file_path,
      line: r.start_line,
      kind: r.kind,
      exported: r.exported === 1,
    }))
    return { results, resolutionCoverage: this.getResolutionCoverage() }
  }

  /**
   * Issue #68: this is the MCP-facing find_symbol tool's implementation.
   * It used to be `WHERE name = ?` — plain equality on the leaf symbol
   * name — even though the tool is documented as "substring match"
   * (packages/mcp-server/src/tools/codegraph.ts). find_symbol("track")
   * returned [] even with track_click/track_event indexed. The correct
   * substring matcher already existed 20 lines below in structuralLookup's
   * fallback, just never wired to this tool.
   *
   * Ranked: exact (case-sensitive) > prefix (case-insensitive, SQLite's
   * default LIKE collation) > contains, then exported DESC, shorter name,
   * name. Returns `truncated`/`totalMatches` instead of imposing a minimum
   * query length — a hard length ban would silently break legitimate short
   * identifiers ("db", "id"); a truncation signal lets the caller see
   * "37 more matches, refine your query" instead.
   */
  findSymbol(name: string, kind?: string, limit?: number, offset?: number): { results: SymbolResult[]; resolutionCoverage: { resolved: number; unresolved: number }; totalMatches: number; truncated: boolean } {
    this.refreshStale()
    // Post-hoc review (issue #68): a negative limit bypassed this cap entirely —
    // SQLite treats `LIMIT -1` as "no limit" — and an empty/whitespace name matched
    // every symbol via `LIKE '%%'`. Both are reachable through the MCP boundary
    // (the zod schema doesn't constrain limit's sign or name's length).
    if (!name.trim()) {
      return { results: [], resolutionCoverage: this.getResolutionCoverage(), totalMatches: 0, truncated: false }
    }
    const lim = Math.min(Math.max(Math.trunc(limit ?? 50), 1), 200)
    const off = Math.max(Math.trunc(offset ?? 0), 0)
    const escaped = name.replace(/[%_\\]/g, '\\$&')
    const containsLike = `%${escaped}%`
    const prefixLike = `${escaped}%`

    let sql = `SELECT qualified_name, file_path, start_line, kind, exported,
                      CASE WHEN name = ? THEN 0 WHEN name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END AS rank
               FROM symbol
               WHERE name LIKE ? ESCAPE '\\'`
    const params: unknown[] = [name, prefixLike, containsLike]
    if (kind) {
      sql += ' AND kind = ?'
      params.push(kind)
    }
    sql += ' ORDER BY rank, exported DESC, LENGTH(name), name LIMIT ? OFFSET ?'
    params.push(lim, off)

    const rows = this.db.prepare(sql).all(...params) as { qualified_name: string; file_path: string; start_line: number; kind: string; exported: number }[]
    const results = rows.map(r => ({
      qualifiedName: r.qualified_name,
      file: r.file_path,
      line: r.start_line,
      kind: r.kind,
      exported: r.exported === 1,
    }))

    let countSql = 'SELECT COUNT(*) AS c FROM symbol WHERE name LIKE ? ESCAPE \'\\\''
    const countParams: unknown[] = [containsLike]
    if (kind) {
      countSql += ' AND kind = ?'
      countParams.push(kind)
    }
    const totalMatches = (this.db.prepare(countSql).get(...countParams) as { c: number }).c

    return {
      results,
      resolutionCoverage: this.getResolutionCoverage(),
      totalMatches,
      truncated: off + results.length < totalMatches,
    }
  }

  /**
   * Phase 3 — PreToolUse hook structural lookup. A Grep/Glob `pattern` is a
   * textual search term; the structural equivalent is "where are the symbols
   * that match this name". We first try an exact-name match (exactSymbolMatch),
   * then fall back to a prefix/contains search so a partial or camelCase fragment
   * still surfaces the relevant symbols. Returns the same SymbolResult shape as
   * exactSymbolMatch/findSymbol so the hook can render a stable context block.
   */
  structuralLookup(pattern: string, limit?: number): {
    results: SymbolResult[]
    resolutionCoverage: { resolved: number; unresolved: number }
    strategy: 'exact' | 'fuzzy'
  } {
    this.refreshStale()
    const lim = limit ?? 20
    const exact = this.exactSymbolMatch(pattern, undefined, lim, 0)
    if (exact.results.length > 0) {
      return { results: exact.results, resolutionCoverage: exact.resolutionCoverage, strategy: 'exact' }
    }
    const like = `%${pattern.replace(/[%_]/g, '\\$&')}%`
    const rows = this.db.prepare(
      'SELECT qualified_name, file_path, start_line, kind, exported FROM symbol WHERE name LIKE ? ESCAPE \'\\\' ORDER BY exported DESC, name LIMIT ?',
    ).all(like, lim) as { qualified_name: string; file_path: string; start_line: number; kind: string; exported: number }[]
    const results = rows.map(r => ({
      qualifiedName: r.qualified_name,
      file: r.file_path,
      line: r.start_line,
      kind: r.kind,
      exported: r.exported === 1,
    }))
    return { results, resolutionCoverage: this.getResolutionCoverage(), strategy: 'fuzzy' }
  }

  fileOutline(file: string): { results: SymbolResult[]; resolutionCoverage: { resolved: number; unresolved: number } } {
    this.refreshStale()
    let relPath: string
    if (path.isAbsolute(file)) {
      try {
        relPath = path.relative(this.projectRoot, realpathSync(file))
      } catch {
        relPath = path.relative(this.projectRoot, file)
      }
    } else {
      relPath = file
    }
    if (relPath.startsWith('..')) {
      return { results: [], resolutionCoverage: this.getResolutionCoverage() }
    }
    const rows = this.db.prepare('SELECT qualified_name, file_path, start_line, kind, exported FROM symbol WHERE file_path = ? AND parent_id IS NULL ORDER BY start_line').all(relPath) as { qualified_name: string; file_path: string; start_line: number; kind: string; exported: number }[]
    const results = rows.map(r => ({
      qualifiedName: r.qualified_name,
      file: r.file_path,
      line: r.start_line,
      kind: r.kind,
      exported: r.exported === 1,
    }))
    return { results, resolutionCoverage: this.getResolutionCoverage() }
  }

  private readSnapshot<T>(fn: () => T): T {
    const txn = this.db.transaction(fn) as unknown as { deferred: () => T }
    return txn.deferred()
  }

  private validateQualifiedName(qualifiedName: unknown): asserts qualifiedName is string {
    if (typeof qualifiedName !== 'string' || qualifiedName.length === 0 || qualifiedName.includes('\0')) {
      throw new Error('qualifiedName must be a non-empty string without NUL characters')
    }
  }

  private escapeGlobPattern(input: string): string {
    return input.replace(/[*?[\]]/g, (ch) => (ch === ']' ? '[]]' : `[${ch}]`))
  }

  private resolveSymbol(qualifiedName: string): SymbolResolution {
    this.validateQualifiedName(qualifiedName)

    return this.readSnapshot(() => {
      // Step 1: Exact match on qualified_name
      const byQualified = this.db.prepare(`
        SELECT id, qualified_name, file_path, name, start_line, end_line, kind, exported
        FROM symbol
        WHERE qualified_name = ?
        ORDER BY file_path COLLATE BINARY, start_line ASC, end_line ASC, kind COLLATE BINARY, id ASC
      `).all(qualifiedName) as SymbolLookupRow[]

      if (byQualified.length > 0) {
        const rep = byQualified[0]
        return {
          status: 'ok',
          ids: byQualified.map((r) => r.id),
          resolvedSymbol: rep.qualified_name,
          leafName: rep.name,
          matchedBy: 'qualified',
        }
      }

      const processCandidates = (rows: SymbolLookupRow[], matchedBy: 'name' | 'suffix'): SymbolResolution => {
        const groups = new Map<string, { representative: SymbolCandidate; ids: number[]; leafName: string }>()
        for (const r of rows) {
          let g = groups.get(r.qualified_name)
          if (!g) {
            g = {
              representative: {
                id: r.id,
                qualifiedName: r.qualified_name,
                file: r.file_path,
                line: r.start_line,
                kind: r.kind,
                exported: r.exported === 1,
              },
              ids: [],
              leafName: r.name,
            }
            groups.set(r.qualified_name, g)
          }
          g.ids.push(r.id)
        }

        if (groups.size === 0) {
          return { status: 'not_found' }
        }

        if (groups.size === 1) {
          const single = Array.from(groups.values())[0]
          return {
            status: 'ok',
            ids: single.ids,
            resolvedSymbol: single.representative.qualifiedName,
            leafName: single.leafName,
            matchedBy,
          }
        }

        const candidates = Array.from(groups.values()).map((g) => g.representative).sort((a, b) => {
          const aTest = a.file.includes('test') || a.file.includes('__tests__')
          const bTest = b.file.includes('test') || b.file.includes('__tests__')
          if (aTest !== bTest) return aTest ? 1 : -1
          if (a.exported !== b.exported) return b.exported ? 1 : -1
          if (a.file.length !== b.file.length) return a.file.length - b.file.length
          const qCmp = compareBinary(a.qualifiedName, b.qualifiedName)
          if (qCmp !== 0) return qCmp
          const fCmp = compareBinary(a.file, b.file)
          if (fCmp !== 0) return fCmp
          if (a.line !== b.line) return a.line - b.line
          const kCmp = compareBinary(a.kind, b.kind)
          if (kCmp !== 0) return kCmp
          return a.id - b.id
        })

        return {
          status: 'ambiguous',
          candidates: candidates.slice(0, 20),
          totalCandidates: groups.size,
        }
      }

      // Step 2: Bare name match on name = ?
      // Expand to all declaration rows of winning qualified_name groups
      const byName = this.db.prepare(`
        SELECT id, qualified_name, file_path, name, start_line, end_line, kind, exported
        FROM symbol
        WHERE qualified_name IN (SELECT qualified_name FROM symbol WHERE name = ?)
        ORDER BY file_path COLLATE BINARY, start_line ASC, end_line ASC, kind COLLATE BINARY, id ASC
      `).all(qualifiedName) as SymbolLookupRow[]

      if (byName.length > 0) {
        return processCandidates(byName, 'name')
      }

      // Step 3: Dotted qualified suffix match
      if (!qualifiedName.includes('.')) {
        return { status: 'not_found' }
      }

      const escaped = this.escapeGlobPattern(qualifiedName)
      const bySuffix = this.db.prepare(`
        SELECT id, qualified_name, file_path, name, start_line, end_line, kind, exported
        FROM symbol
        WHERE qualified_name GLOB ('*.' || ?) OR qualified_name GLOB ('*/' || ?)
        ORDER BY file_path COLLATE BINARY, start_line ASC, end_line ASC, kind COLLATE BINARY, id ASC
      `).all(escaped, escaped) as SymbolLookupRow[]

      if (bySuffix.length > 0) {
        return processCandidates(bySuffix, 'suffix')
      }

      return { status: 'not_found' }
    })
  }

  findReferences(qualifiedName: string, limit?: number, offset?: number): ReferenceResult {
    this.refreshStale()
    this.validateQualifiedName(qualifiedName)
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) {
      throw new Error('limit must be an integer between 1 and 200')
    }
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
      throw new Error('offset must be a non-negative integer')
    }
    const lim = limit ?? 200
    const off = offset ?? 0

    return this.readSnapshot(() => {
      const cov = this.getResolutionCoverage()
      const resolution = this.resolveSymbol(qualifiedName)
      if (resolution.status !== 'ok') {
        if (resolution.status === 'not_found') {
          return {
            status: 'not_found',
            references: [],
            boundedByUnresolved: false,
            resolutionCoverage: cov,
          }
        }
        return {
          status: 'ambiguous',
          references: [],
          boundedByUnresolved: false,
          candidates: resolution.candidates,
          totalCandidates: resolution.totalCandidates,
          resolutionCoverage: cov,
        }
      }

      const unresolvedCount = this.db.prepare(
        'SELECT COUNT(*) as c FROM call_edge WHERE candidate = 1 AND callee_resolved_id IS NULL AND callee_name = ?',
      ).get(resolution.leafName) as { c: number } | undefined
      const hasUnresolved = (unresolvedCount?.c ?? 0) > 0

      const rows = this.db.prepare(`
        SELECT DISTINCT
          s.file_path AS callerFile,
          s.name AS callerName,
          e.line AS line
        FROM call_edge e
        JOIN symbol callee ON callee.id = e.callee_resolved_id
        JOIN symbol s ON s.id = e.caller_id
        WHERE callee.qualified_name = ?
        ORDER BY s.file_path COLLATE BINARY, e.line ASC, s.name COLLATE BINARY
        LIMIT ? OFFSET ?
      `).all(resolution.resolvedSymbol, lim, off) as { callerFile: string; callerName: string; line: number }[]

      return {
        status: 'ok',
        resolvedSymbol: resolution.resolvedSymbol,
        matchedBy: resolution.matchedBy,
        references: rows.map((r) => ({
          callerFile: r.callerFile,
          callerName: r.callerName,
          line: r.line,
          depth: 1,
        })),
        boundedByUnresolved: hasUnresolved,
        resolutionCoverage: cov,
      }
    })
  }

  callGraph(qualifiedName: string, direction?: string, depth?: number): CallGraphResult {
    this.refreshStale()
    this.validateQualifiedName(qualifiedName)
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > 3)) {
      throw new Error('depth must be an integer between 1 and 3')
    }
    if (direction !== undefined && direction !== 'in' && direction !== 'out' && direction !== 'both') {
      throw new Error('direction must be in, out, or both')
    }

    const maxDepth = depth ?? 2
    const dir = direction ?? 'out'

    return this.readSnapshot(() => {
      const cov = this.getResolutionCoverage()
      const resolution = this.resolveSymbol(qualifiedName)
      if (resolution.status !== 'ok') {
        if (resolution.status === 'not_found') {
          return {
            status: 'not_found',
            nodes: [],
            truncated: false,
            resolutionCoverage: cov,
          }
        }
        return {
          status: 'ambiguous',
          nodes: [],
          truncated: false,
          candidates: resolution.candidates,
          totalCandidates: resolution.totalCandidates,
          resolutionCoverage: cov,
        }
      }

      const repStmt = this.db.prepare(`
        SELECT name, file_path, start_line
        FROM symbol
        WHERE qualified_name = ?
        ORDER BY file_path COLLATE BINARY, start_line ASC, end_line ASC, kind COLLATE BINARY, id ASC
        LIMIT 1
      `)

      const rootRep = repStmt.get(resolution.resolvedSymbol) as
        | { name: string; file_path: string; start_line: number }
        | undefined
      if (!rootRep) {
        throw new Error('Inconsistent symbol metadata')
      }

      const rootQName = resolution.resolvedSymbol

      const getCalleesStmt = this.db.prepare(`
        SELECT DISTINCT callee.qualified_name
        FROM call_edge e
        JOIN symbol caller ON caller.id = e.caller_id
        JOIN symbol callee ON callee.id = e.callee_resolved_id
        WHERE caller.qualified_name = ?
      `)

      const getCallersStmt = this.db.prepare(`
        SELECT DISTINCT caller.qualified_name
        FROM call_edge e
        JOIN symbol callee ON callee.id = e.callee_resolved_id
        JOIN symbol caller ON caller.id = e.caller_id
        WHERE callee.qualified_name = ?
      `)

      const outDistances = new Map<string, number>()
      const inDistances = new Map<string, number>()
      const mergedDistances = new Map<string, number>()

      outDistances.set(rootQName, 0)
      inDistances.set(rootQName, 0)
      mergedDistances.set(rootQName, 0)

      let outFrontier: string[] = (dir === 'out' || dir === 'both') ? [rootQName] : []
      let inFrontier: string[] = (dir === 'in' || dir === 'both') ? [rootQName] : []

      let truncated = false

      for (let d = 1; d <= maxDepth; d++) {
        const nextOutFrontier: string[] = []
        if (dir === 'out' || dir === 'both') {
          for (const current of outFrontier) {
            const neighbors = getCalleesStmt.all(current) as { qualified_name: string }[]
            for (const n of neighbors) {
              const nQName = n.qualified_name
              if (!outDistances.has(nQName)) {
                outDistances.set(nQName, d)
                nextOutFrontier.push(nQName)
                const existing = mergedDistances.get(nQName)
                if (existing === undefined || d < existing) {
                  mergedDistances.set(nQName, d)
                }
              }
            }
          }
        }

        const nextInFrontier: string[] = []
        if (dir === 'in' || dir === 'both') {
          for (const current of inFrontier) {
            const neighbors = getCallersStmt.all(current) as { qualified_name: string }[]
            for (const n of neighbors) {
              const nQName = n.qualified_name
              if (!inDistances.has(nQName)) {
                inDistances.set(nQName, d)
                nextInFrontier.push(nQName)
                const existing = mergedDistances.get(nQName)
                if (existing === undefined || d < existing) {
                  mergedDistances.set(nQName, d)
                }
              }
            }
          }
        }

        outFrontier = nextOutFrontier
        inFrontier = nextInFrontier

        // Completed ordered depth frontier check
        const nonRootCount = mergedDistances.size - 1
        if (nonRootCount > 200) {
          truncated = true
          break
        }

        if (outFrontier.length === 0 && inFrontier.length === 0) {
          break
        }
      }

      interface TempNode {
        qualifiedName: string
        depth: number
      }
      const nonRoots: TempNode[] = []
      for (const [qname, d] of mergedDistances) {
        if (qname === rootQName) continue
        nonRoots.push({ qualifiedName: qname, depth: d })
      }

      nonRoots.sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth
        return compareBinary(a.qualifiedName, b.qualifiedName)
      })

      let cappedNonRoots = nonRoots
      if (nonRoots.length > 200) {
        truncated = true
        cappedNonRoots = nonRoots.slice(0, 200)
      }

      const finalNodes: { name: string; file: string; line: number; depth: number; qualifiedName: string }[] = [
        {
          name: rootRep.name,
          file: rootRep.file_path,
          line: rootRep.start_line,
          depth: 0,
          qualifiedName: rootQName,
        },
      ]

      for (const node of cappedNonRoots) {
        const rep = repStmt.get(node.qualifiedName) as { name: string; file_path: string; start_line: number } | undefined
        if (rep) {
          finalNodes.push({
            name: rep.name,
            file: rep.file_path,
            line: rep.start_line,
            depth: node.depth,
            qualifiedName: node.qualifiedName,
          })
        }
      }

      return {
        status: 'ok',
        resolvedSymbol: resolution.resolvedSymbol,
        matchedBy: resolution.matchedBy,
        nodes: finalNodes,
        truncated,
        resolutionCoverage: cov,
      }
    })
  }

  /**
   * Phase 2c — `bridge_codegraph_diff_impact`.
   *
   * Compute the blast radius of a git diff: the set of exported symbols defined
   * in changed files (the "change surface"), plus every transitive *caller* of
   * those symbols (direction=in) up to depth 3. The caller traversal reuses the
   * same recursive CTE as `callGraph(in)`; only candidate (resolved) edges are
   * followed, so the blast radius is truthful — unresolved imports are not
   * silently claimed as impacted.
   *
   * `base` defaults to `HEAD` (working-tree-vs-HEAD). A git error (no repo, no
   * diff) yields an empty but well-formed result.
   */
  diffImpact(base?: string): {
    changedFiles: string[]
    changedSymbols: { qualifiedName: string; file: string; line: number }[]
    impactedSymbols: { qualifiedName: string; file: string; line: number; depth: number }[]
    truncated: boolean
    resolutionCoverage: { resolved: number; unresolved: number }
  } | { error: string } {
    this.refreshStale()
    // `base` absent/blank means the hardcoded 'HEAD' default, not caller input —
    // the rev-parse gate below exists to reject *caller-supplied* refs, so it
    // must not run for the default path (see class doc on `diffImpact`).
    const baseSupplied = !!(base && base.trim())
    const baseRef = baseSupplied ? base!.trim() : 'HEAD'
    const limit = 500
    const maxDepth = 3
    const eoo = gitSupportsEndOfOptions()
    if (baseSupplied && baseRef.startsWith('-')) return { error: `Invalid git ref: ${baseRef}` }

    if (baseSupplied) {
      try {
        execFileSync(
          'git',
          eoo
            ? ['rev-parse', '--verify', '--quiet', '--end-of-options', baseRef]
            : ['rev-parse', '--verify', '--quiet', baseRef],
          {
            cwd: this.projectRoot,
            encoding: 'utf-8',
            timeout: 10000,
            maxBuffer: 32 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        )
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr ?? ''
        if (/not a git repository/i.test(stderr)) {
          return { error: `Not a git repository: ${this.projectRoot}` }
        }
        return { error: `Invalid git ref: ${baseRef}` }
      }
    }

    let changedFiles: string[] = []
    try {
      const raw = execFileSync(
        'git',
        eoo
          ? ['diff', '--name-only', '--end-of-options', baseRef, '--']
          : ['diff', '--name-only', baseRef, '--'],
        {
          cwd: this.projectRoot,
          encoding: 'utf-8',
          timeout: 10000,
          maxBuffer: 32 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      changedFiles = raw.split('\n').map(s => s.trim()).filter(Boolean)
    } catch {
      // Documented degradation (unborn HEAD, non-repo cwd, or any other git
      // failure on the default path): empty but well-formed result, never
      // `{ error }` — that shape is reserved for a caller-supplied bad ref.
      changedFiles = []
    }

    if (changedFiles.length === 0) {
      return {
        changedFiles: [],
        changedSymbols: [],
        impactedSymbols: [],
        truncated: false,
        resolutionCoverage: this.getResolutionCoverage(),
      }
    }

    const placeholders = changedFiles.map(() => '?').join(',')
    const changedSyms = this.db.prepare(
      `SELECT id, qualified_name, file_path, start_line FROM symbol WHERE exported = 1 AND file_path IN (${placeholders})`,
    ).all(...changedFiles) as { id: number; qualified_name: string; file_path: string; start_line: number }[]

    const changedSymbols = changedSyms.map(s => ({
      qualifiedName: s.qualified_name,
      file: s.file_path,
      line: s.start_line,
    }))

    const impacted: Map<string, { qualifiedName: string; file: string; line: number; depth: number }> = new Map()
    if (changedSyms.length > 0) {
      const callerRows = this.db.prepare(`
        WITH RECURSIVE callers AS (
          SELECT e.caller_id AS sid, 1 AS depth, '/'||e.caller_id||'/' AS path
          FROM call_edge e
          JOIN symbol c ON c.id = e.callee_resolved_id
          WHERE c.exported = 1 AND c.file_path IN (${placeholders})
          UNION ALL
          SELECT e.caller_id, cc.depth+1, cc.path||e.caller_id||'/'
          FROM call_edge e
          JOIN callers cc ON e.callee_resolved_id = cc.sid
          WHERE cc.depth < ? AND e.callee_resolved_id IS NOT NULL
            AND cc.path NOT LIKE '%/'||e.caller_id||'/%'
        )
        SELECT DISTINCT s.qualified_name, s.file_path, s.start_line, cc.depth
        FROM callers cc JOIN symbol s ON s.id = cc.sid
        ORDER BY cc.depth
        LIMIT ?
      `).all(...changedFiles, maxDepth, limit) as { qualified_name: string; file_path: string; start_line: number; depth: number }[]

      for (const r of callerRows) {
        const key = r.file_path + ':' + r.qualified_name
        const existing = impacted.get(key)
        if (!existing || r.depth < existing.depth) {
          impacted.set(key, { qualifiedName: r.qualified_name, file: r.file_path, line: r.start_line, depth: r.depth })
        }
      }
    }

    const impactedSymbols = Array.from(impacted.values()).sort((a, b) => a.depth - b.depth)
    return {
      changedFiles,
      changedSymbols,
      impactedSymbols,
      truncated: impactedSymbols.length >= limit,
      resolutionCoverage: this.getResolutionCoverage(),
    }
  }

  getSymbolSource(qualifiedName: string): { source: string; file: string; resolutionCoverage: { resolved: number; unresolved: number } }
    | { error: 'Symbol not found' }
    | { error: 'Ambiguous symbol'; candidates: SymbolCandidate[]; totalCandidates: number }
    | { error: 'Failed to read source file' } {
    this.refreshStale()
    this.validateQualifiedName(qualifiedName)

    const dbResult = this.readSnapshot(() => {
      const sym = this.resolveSymbol(qualifiedName)
      if (sym.status === 'not_found') return { kind: 'not_found' as const }
      if (sym.status === 'ambiguous') {
        return {
          kind: 'ambiguous' as const,
          candidates: sym.candidates,
          totalCandidates: sym.totalCandidates,
        }
      }

      const meta = this.db.prepare(`
        SELECT file_path, start_line, end_line
        FROM symbol
        WHERE qualified_name = ?
        ORDER BY file_path COLLATE BINARY, start_line ASC, end_line ASC, kind COLLATE BINARY, id ASC
        LIMIT 1
      `).get(sym.resolvedSymbol) as { file_path: string; start_line: number; end_line: number } | undefined

      if (!meta || !meta.file_path || typeof meta.file_path !== 'string') {
        throw new Error('Inconsistent symbol metadata')
      }

      if (
        !Number.isInteger(meta.start_line) ||
        !Number.isInteger(meta.end_line) ||
        meta.start_line < 1 ||
        meta.start_line > meta.end_line
      ) {
        throw new Error('Inconsistent symbol metadata')
      }

      return {
        kind: 'ok' as const,
        meta,
        coverage: this.getResolutionCoverage(),
      }
    })

    if (dbResult.kind === 'not_found') return { error: 'Symbol not found' }
    if (dbResult.kind === 'ambiguous') {
      return { error: 'Ambiguous symbol', candidates: dbResult.candidates, totalCandidates: dbResult.totalCandidates }
    }

    const { meta, coverage } = dbResult
    const absPath = path.join(this.projectRoot, meta.file_path)
    let content: string
    try {
      content = readFileSync(absPath, 'utf-8')
    } catch {
      return { error: 'Failed to read source file' }
    }

    const lines = content.split('\n')
    if (meta.end_line > lines.length) {
      throw new Error('Inconsistent symbol metadata')
    }

    const slice = lines.slice(meta.start_line - 1, meta.end_line)
    return {
      source: slice.join('\n'),
      file: meta.file_path,
      resolutionCoverage: coverage,
    }
  }

  /**
   * Codegraph savings (v2): sum of `file.bytes` for indexed paths. Unindexed
   * paths are silently skipped — this keeps the claimed saving a conservative
   * floor (the true counterfactual would include them, but we cannot measure
   * it honestly from the graph DB).
   *
   * Paths are normalized to project-relative before the lookup because callers
   * (especially file_outline) may pass absolute paths while the DB stores
   * relative paths.
   */
  bytesForFiles(paths: string[]): number {
    if (paths.length === 0) return 0
    const normalized = paths.map(p => path.isAbsolute(p) ? path.relative(this.projectRoot, p) : p)
    const placeholders = normalized.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT bytes FROM file WHERE path IN (${placeholders})`).all(...normalized) as { bytes: number }[]
    const CAP = 256 * 1024
    return rows.reduce((sum, r) => sum + Math.min(r.bytes ?? 0, CAP), 0)
  }

  private getResolutionCoverage(): { resolved: number; unresolved: number } {
    // Count only *candidate* edges (imported names / local symbols). Builtin /
    // method calls are excluded from the denominator so the rate reflects genuine
    // import resolution, not language noise (spec §7.1).
    const resolved = this.db.prepare('SELECT COUNT(*) as c FROM call_edge WHERE candidate = 1 AND callee_resolved_id IS NOT NULL').get() as { c: number }
    const unresolved = this.db.prepare('SELECT COUNT(*) as c FROM call_edge WHERE candidate = 1 AND callee_resolved_id IS NULL').get() as { c: number }
    return {
      resolved: resolved?.c ?? 0,
      unresolved: unresolved?.c ?? 0,
    }
  }
}

export class Engine {
  private static instance: Engine
  private parser: Parser | null = null
  private langs: Record<string, Language> | null = null
  private initPromise: Promise<void> | null = null
  private projects: Map<string, ProjectDb> = new Map()
  private lastQueried: Map<string, number> = new Map()
  private maxOpenDbs: number = parseInt(process.env['CODEGRAPH_MAX_OPEN_DBS'] ?? '8', 10)
  private initError: Error | null = null

  static get(): Engine {
    if (!Engine.instance) {
      Engine.instance = new Engine()
    }
    return Engine.instance
  }

  getOpenDbCount(): number {
    return this.projects.size
  }

  async ensureParser(): Promise<void> {
    if (this.parser) return
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      try {
        const result = await initParser()
        this.parser = result.parser
        this.langs = result.langs
      } catch (err) {
        this.initError = err instanceof Error ? err : new Error(String(err))
        throw this.initError
      }
    })()
    return this.initPromise
  }

  getInitError(): Error | null {
    return this.initError
  }

  private evictLru(): void {
    while (this.projects.size >= this.maxOpenDbs) {
      let oldestKey: string | null = null
      let oldestTime = Infinity
      for (const [key, time] of this.lastQueried) {
        const proj = this.projects.get(key)
        // F1: never evict a DB that is actively indexing — closing its
        // connection mid-transaction crashes the background job with
        // "database connection is closed". Only IDLE projects are evictable.
        if (proj && proj.busy) continue
        if (time < oldestTime) {
          oldestTime = time
          oldestKey = key
        }
      }
      // All open projects are busy indexing — exceed the cap temporarily
      // rather than closing a busy DB. It will be reclaimed on a later call.
      if (!oldestKey) break
      const proj = this.projects.get(oldestKey)
      if (proj) {
        try { proj.close() } catch {}
      }
      this.projects.delete(oldestKey)
      this.lastQueried.delete(oldestKey)
    }
  }

  async withFreshSnapshot<T>(cwd: string, fn: (project: ProjectDb) => T extends PromiseLike<unknown> ? never : T): Promise<T> {
    const project = await this.getProject(cwd, true)
    try { return await project.withFreshSnapshot(fn) }
    finally { project.release() }
  }

  async getProject(cwd: string, acquireLease = false): Promise<ProjectDb> {
    if (typeof cwd !== 'string' || !cwd) {
      throw new Error(`Invalid cwd at step 1: type=${typeof cwd} value="${cwd}"`)
    }

    try {
      await this.ensureParser()
    } catch (e) {
      throw new Error(`ensureParser failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    if (!this.parser || !this.langs) {
      throw new Error('Parser not initialized after ensureParser')
    }

    let resolvedCwd: string
    try {
      resolvedCwd = realpathSync(cwd)
    } catch (e) {
      throw new Error(`realpathSync failed for cwd="${cwd}": ${e instanceof Error ? e.message : String(e)}`)
    }

    if (!resolvedCwd) {
      throw new Error(`realpathSync returned empty for cwd="${cwd}"`)
    }

    const dirHash = createHash('sha256').update(resolvedCwd).digest('hex')
    const cgDir = getCodegraphDir()
    if (!cgDir) {
      throw new Error(`getCodegraphDir() returned empty`)
    }

    const dbPath = path.join(cgDir, `${dirHash}.db`)

    let project = this.projects.get(resolvedCwd)
    if (!project) {
      this.evictLru()
      try {
        project = new ProjectDb(resolvedCwd, dbPath, this.parser, this.langs)
      } catch (e) {
        throw new Error(`ProjectDb constructor failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      this.projects.set(resolvedCwd, project)
    }
    this.lastQueried.set(resolvedCwd, Date.now())
    if (acquireLease) project.acquire() // Pin before returning across the await boundary.
    return project
  }
}
