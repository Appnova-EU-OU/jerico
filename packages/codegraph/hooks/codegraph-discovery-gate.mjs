#!/usr/bin/env node
// codegraph-discovery-gate.mjs — NON-BLOCKING PreToolUse hook (spec §11 Layer 3).
//
// On a Grep/Glob call it asks codegraph for the STRUCTURAL equivalent of the
// textual pattern (symbols whose name matches) and injects that as
// `additionalContext`. It NEVER gates Read (gating Read would break
// read-before-edit) and it is ALWAYS non-blocking: exit 0, and if codegraph
// is down / slow / returns nothing, it passes through silently.
//
// Opt-in only — NOT auto-enabled. Wire it via a settings.json PreToolUse entry
// (see ../ADOPTION-GATE.md). Example:
//
//   {
//     "hooks": {
//       "PreToolUse": [
//         { "matcher": "Grep|Glob",
//           "hooks": [ { "type": "command",
//             "command": "node /abs/path/codegraph/hooks/codegraph-discovery-gate.mjs",
//             "timeout": 2 } ] }
//       ]
//     }
//   }
//
// Env knobs:
//   CODEGRAPH_BIN          bin to invoke for structural lookup
//                          (default: sibling dist/index.cjs, else `jerico-codegraph`)
//   CODEGRAPH_HOOK_CWD    fallback project root when the tool input has no `path`
//   CODEGRAPH_HOOK_TIMEOUT_MS  give-up budget for codegraph (default 600ms)
//   CODEGRAPH_HOOK_RECORD  if "1", append a codegraph_hook_inject record to
//                          ~/.jerico/codegraph/adoption.jsonl when context is injected

import { readFileSync, existsSync, statSync, mkdirSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HOOK_NAME = 'codegraph-discovery-gate'
const GATED = new Set(['Grep', 'Glob'])
const TIMEOUT_MS = parseInt(process.env['CODEGRAPH_HOOK_TIMEOUT_MS'] ?? '600', 10) || 600

/** Always exit 0 — this hook never blocks a tool call. */
function pass(msg) {
  if (msg) process.stderr.write(`[${HOOK_NAME}] ${msg}\n`)
  process.exit(0)
}

function resolveBin() {
  if (process.env['CODEGRAPH_BIN']) return process.env['CODEGRAPH_BIN']
  const here = path.dirname(fileURLToPath(import.meta.url))
  const sibling = path.resolve(here, '..', 'dist', 'index.cjs')
  if (existsSync(sibling)) return sibling
  return 'jerico-codegraph'
}

function recordInject(pattern, cwd) {
  if (process.env['CODEGRAPH_HOOK_RECORD'] !== '1') return
  try {
    const dir = path.join(os.homedir(), '.jerico', 'codegraph')
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, 'adoption.jsonl'),
      JSON.stringify({ ts: Date.now(), tool: 'codegraph_hook_inject', pattern, cwd }) + '\n')
  } catch { /* never fatal */ }
}

function main() {
  let raw = ''
  try { raw = readFileSync(0, 'utf8') } catch { return pass('no stdin') }
  if (!raw.trim()) return pass('empty stdin')

  let payload
  try { payload = JSON.parse(raw) } catch { return pass('stdin is not JSON') }

  const toolName = payload.tool_name
  if (!GATED.has(toolName)) return pass(`not gated (${toolName})`)

  const input = payload.tool_input ?? {}
  const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : ''
  if (!pattern) return pass('no pattern in tool input')

  // Resolve the project root. Grep/Glob `path` may be a file or a directory.
  let cwd = input.path || input.cwd || process.env['CODEGRAPH_HOOK_CWD'] || process.cwd()
  try {
    const st = statSync(cwd)
    if (!st.isDirectory()) cwd = path.dirname(cwd)
  } catch { /* use as-is; getProject will surface a clean error we swallow */ }

  const bin = resolveBin()
  let res
  try {
    res = spawnSync(process.execPath, [bin, 'structural', '--pattern', pattern, '--cwd', cwd, '--quiet'], {
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
      // Keep the hook's own stdin closed so the spawned bin does not inherit it.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    return pass(`spawn failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // codegraph down / slow / crashed -> passthrough, never block.
  if (!res || res.error || res.status !== 0 || !res.stdout) return pass('codegraph unavailable or timed out')

  let data
  try { data = JSON.parse(res.stdout) } catch { return pass('codegraph output not JSON') }
  if (!data || data.ok !== true) return pass('codegraph lookup returned !ok')
  const results = Array.isArray(data.results) ? data.results : []
  if (results.length === 0) return pass('no structural match')

  const strat = data.strategy === 'exact' ? 'exact match' : 'fuzzy match'
  const lines = results.slice(0, 10).map(r =>
    `  • ${r.qualifiedName}  (${r.kind}${r.exported ? ', exported' : ''})  @ ${r.file}:${r.line}`,
  )
  if (results.length > 10) lines.push(`  • … and ${results.length - 10} more`)
  const ctx = [
    `[codegraph] structural lookup for Grep/Glob pattern "${pattern}" (${strat}):`,
    ...lines,
    `Prefer bridge_codegraph_find_symbol / find_references / call_graph for these.`,
  ].join('\n')

  recordInject(pattern, cwd)

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `codegraph structural context injected for "${pattern}" (non-blocking)`,
    },
    additionalContext: ctx,
  }
  process.stdout.write(JSON.stringify(out))
  pass()
}

main()
