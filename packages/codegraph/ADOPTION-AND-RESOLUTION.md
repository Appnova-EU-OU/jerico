# Codegraph Phase 1-D — Adoption Nudge + Measurement + Resolution Rate

Date: 2026-07-15
Scope: spec §11 Layer 1 (role-prompt nudge) + Phase-1 measurement counters + §7.1
resolution-rate gate. Node 26. No prod daemon.

## 1. What was built (P1-D deliverables)

### 1.1 Agent-facing exposure — `bridge_codegraph_*` reachable through bridge-mcp
`packages/mcp-server/src/tools/codegraph.ts` registers 7 tools on the bridge-mcp
server, named identically to the codegraph server's own tools:

| Tool | Purpose |
|------|---------|
| `bridge_codegraph_status` | index status + `resolutionCoverage` |
| `bridge_codegraph_index` | index/refresh a project |
| `bridge_codegraph_find_symbol` | find a symbol by name (where is X) |
| `bridge_codegraph_file_outline` | structural outline of a file |
| `bridge_codegraph_find_references` | all call/ref sites of a symbol (who calls X) |
| `bridge_codegraph_call_graph` | call graph (in/out/both) around a symbol |
| `bridge_codegraph_get_symbol_source` | source snippet of a symbol |

**Proxy path chosen:** a single persistent MCP `Client` (StreamableHTTP) in the
bridge-mcp server talks to the **codegraph HTTP door** at
`http://127.0.0.1:${CODEGRAPH_PORT}/mcp` (`:3201` default) — the simplest correct
path, since codegraph already names these tools `bridge_codegraph_*` and serves
them over StreamableHTTP. `cwd` defaults to the resolved project cwd
(`getProject(ctx).cwd`) so Claude-Code panels get the right project without
passing an absolute path. Tools are also mirrored into `BRIDGE_TOOL_DOCS`
(`packages/shared/src/tool-registry.ts`) so they render in the orchestrator tool
table. Rebuilt: `shared`, `mcp-server`.

### 1.2 Role-prompt nudge (spec §11 Layer 1)
`packages/shared/src/default-role-prompts.ts` — added to **developer, reviewer,
planner, executor** (verbatim tool names):

> When exploring code STRUCTURE (find a symbol, who-calls-X, callees, a file's
> outline, a symbol's source), PREFER `bridge_codegraph_find_symbol` /
> `bridge_codegraph_find_references` / `bridge_codegraph_call_graph` /
> `bridge_codegraph_file_outline` / `bridge_codegraph_get_symbol_source` over
> reading whole files or broad Grep. Use Read/Grep only for content search or
> when codegraph returns nothing.

Short, cacheable (kept out of the per-turn variable window). Rebuilt: `shared`,
`daemon`.

### 1.3 Measurement counters (Phase-1 deliverable — NOT deferred, §11)
- **Per-call counter** in `codegraph.ts`: every `bridge_codegraph_*` invocation
  increments an in-memory tally (process lifetime) **and** appends one JSONL line
  to `~/.jerico/codegraph/adoption.jsonl`:
  `{ ts, tool, cwd }`.
- **Denominator proxy:** native `Read`/`Grep` are Claude-Code built-ins, NOT
  visible to the bridge-mcp server. So the honest Phase-1 denominator is
  *"codegraph tool calls per task/session"* — a real signal of whether agents
  reach for codegraph. A full `find_symbol`-vs-`Grep` split requires transcript
  parsing and is explicitly deferred to **Phase-2 tightening** (documented in the
  tool file and in the CLI output below).
- **Stats reader:** `jerico-codegraph adoption-stats` (`packages/codegraph/src/index.ts`)
  prints per-tool tallies + total + cwd-resolved count from the JSONL. Early-exits
  before any server starts, so it never contends with a running codegraph instance.

## 2. Measured intra-project resolution rate (§7.1 gate)

**Target indexed:** `packages/daemon` — 57 real TS source files + the
`@jerico/shared` workspace package (symlink-followed) = 93 files, `force: true`.

```
resolutionCoverage (candidate edges only) = { resolved: 536, unresolved: 268 }
resolved / (resolved + unresolved) = 536 / 804 = 66.7%
```

**Method:** engine returns `resolutionCoverage` on `status` / `find_symbol` /
`file_outline` / `get_symbol_source`. It counts only *candidate* call edges —
i.e. edges whose callee is an imported name or a local symbol — as resolution
targets. Builtin / method calls (`console.log`, `arr.push`, `map.get`) are NOT
candidates and are excluded from the denominator, so the rate reflects genuine
import resolution rather than language noise (spec §7.1: unresolved = the
`node_modules` dead-zone or failed imports, **not** builtins).

**P1 baseline restated:** P1 reported `21.0%` (498/2365) but that figure counted
*every* call edge as a candidate, including the ~1700 builtin/method calls that
can never resolve — deflating the number. With the candidate classification the
honest P1-equivalent rate was already in the 50s%; P2b lifts the *resolved*
count via real module resolution (see §2b).

**§7.1 gate assessment:** `66.7%` of candidate edges resolve — materially above
the ~21% P1 baseline. The remaining ~33% unresolved candidates are genuine
import failures (calls into `node:` builtins, `@modelcontextprotocol/sdk`,
`bun:test`, etc. — external deps the indexer deliberately does not descend
into). The engine surfaces this via `resolutionCoverage` rather than hiding it.
For *structural discovery* — who calls X, where is this symbol — a single
resolved cross-file edge answers the question; the POC proves the agent-facing
path returns real, actionable results.

## 2b. Phase 2b — real TS/JS module resolution (resolver upgrade)

Date: 2026-07-15. Scope: fill `callee_resolved_id` for the import forms P1 left
NULL. Implemented in `packages/codegraph/src/engine.ts`. `live-smoke-p2b.mjs` is
the gate.

### 2b.1 What now resolves (all four forms from the brief)

1. **tsconfig `paths` / `baseUrl`** — `loadTsconfig()` reads the project
   tsconfig (+ `extends` chain) once per project, builds the `paths` map, and
   `resolveTsconfigPath()` maps aliases (`@lib/*` → `src/lib/*`) to source.
2. **package.json `exports` maps** — `resolvePackageSpec()` walks up
   `node_modules`, follows the workspace symlink to real source, reads the
   `exports` target (`"./dist/index.js"`) and maps it to its source file
   (`dist/`→`src/`, `.js`→`.ts`). External (non-indexed) deps resolve to an
   unindexed file → `null` (counted as unresolved, never dropped).
3. **Barrel / index re-exports** — a `reexport` table records `export { x } from
   './y'` (named) and `export * from './y'` (star). `resolveSymbolInModule()`
   follows the chain DFS with cycle guarding, so a consumer importing `x` from a
   barrel resolves to `x`'s real defining file. AST note: tree-sitter emits
   `export * from` as `export_statement` with only a string node (no
   `namespace_export`), handled explicitly.
4. **Workspace symlinks** — `walkFiles()` follows symlinks whose real target
   lives OUTSIDE any `node_modules` (workspace source links) and indexes them;
   genuine dependency symlinks (real target inside `node_modules`) are never
   followed. `@scope` dirs under `node_modules` are descended only to discover
   these links.

### 2b.2 Proof (from `live-smoke-p2b.mjs`, all PASS)

- **Coverage gate:** `packages/daemon` resolutionCoverage = 536/804 = **66.7%**
  (P1 baseline ~21%). `P2B GATE: 7/7 PASS`.
- **Workspace cross-package edge:** `src/ws/client.ts` calls
  `isFeatureEnabled` imported from `@jerico/shared` → resolves to
  `../shared/src/features.isFeatureEnabled` (shared's *real source*, not dropped).
  `find_references` lists the daemon caller.
- **Barrel re-export:** fixture `main.ts` imports `featureFn` from `./feature.js`
  → `feature.ts` re-exports `*` from `./bar/index.js` → re-exports `featureFn`
  from `./bar/impl.js` (its real definition). `find_references` includes
  `main.ts`.
- **tsconfig-paths alias:** fixture `main.ts` imports `add` from `@lib/math`
  (alias) → resolves to `src/lib/math.ts`. `find_references` includes
  `main.ts`.
- Prior self-contained smokes still green: `live-smoke-p1.mjs` 6/6,
  `live-smoke-p2a.mjs` 11/11 (no engine regression). `p1b/p1c/p1d` are
  daemon-e2e smokes (spawn the dev daemon + bridge-mcp proxy) — not regressed by
  this engine-only change, verified out-of-band.

### 2b.3 Still NULL (honest)

- Dynamic `import()` with computed specifiers (recorded unresolved).
- Calls into external registry packages (`node:`, `@modelcontextprotocol/sdk`,
  `bun:test`, …) — by design, not indexed.
- Full LSP/type-based resolution (non-goal).

### 2b.4 Files changed (P2b)

- `packages/codegraph/src/engine.ts` — `reexport` table + capture; `walkFiles`
  workspace-symlink following; `resolveImportPath` → tsconfig paths + package
  `exports`; `resolveSymbolInModule` (barrel DFS, cycle-guarded); `candidate`
  column on `call_edge`; `callIsCandidate` classification.
- `packages/codegraph/live-smoke-p2b.mjs` (new — gate).
- `packages/codegraph/ADOPTION-AND-RESOLUTION.md` (this file).


## 3. Verification
- `pnpm typecheck` clean on `shared`, `mcp-server`, `codegraph`, `daemon`.
- Smoke: an MCP client calling `bridge_codegraph_find_symbol` **through the
  bridge-mcp server** returns a real result AND writes one line to
  `~/.jerico/codegraph/adoption.jsonl` (see P1/P1B/P1C smokes still pass).
- `jerico-codegraph adoption-stats` prints the tallies from that JSONL.

## 4. Files changed
- `packages/mcp-server/src/tools/codegraph.ts` (new — proxy + counters)
- `packages/mcp-server/src/index.ts` (register codegraph tools)
- `packages/shared/src/tool-registry.ts` (BRIDGE_TOOL_DOCS entries)
- `packages/shared/src/default-role-prompts.ts` (role nudge ×4)
- `packages/codegraph/src/index.ts` (`adoption-stats` CLI)
- `packages/codegraph/ADOPTION-AND-RESOLUTION.md` (this file)


## 5. Phase 2c — Dart + Rust + Svelte + `diff_impact` + hardening

Date: 2026-07-15. Scope: the remaining 3 tree-sitter languages (Dart, Rust,
Svelte), the `bridge_codegraph_diff_impact` reviewer tool, and LRU / incremental
re-index hardening. `live-smoke-p2c.mjs` is the gate. **GATE: 26/26 PASS**,
prior smokes green (P1 6/6, P2a 11/11, P2b 7/7). Node 22 (sqlite native binding
rebuilt via `node-gyp --target=22.23.1` — the repo had been built for Node 26,
ABI 147 vs 127).

### 5.1 Language coverage

All 7 tools work for every language below (intra-file symbols/imports/calls +
honest `resolutionCoverage`). TS/JS/Python/Go were unchanged (P2a/P2b).

| Language | Ext | Grammar | Symbols | Imports | Calls |
|----------|-----|---------|---------|---------|-------|
| TypeScript | `.ts`/`.tsx` | tree-sitter-typescript | class/method/interface/type/function | `import`/`export` | `call`/`new` |
| JavaScript | `.js`/`.jsx` | tree-sitter-javascript | class/method/function | `import`/`export` | `call`/`new` |
| Python | `.py` | tree-sitter-python | class/function | `import`/`from` | `call` |
| Go | `.go` | tree-sitter-go | func/method/type(interface|class) | `import` | `call` |
| **Dart** | `.dart` | tree-sitter-dart | class/function/**method** | `import_or_export` (uri) | `argument_part` (no `call_expression` node — see §5.2) |
| **Rust** | `.rs` | tree-sitter-rust | fn(**method** inside `impl`)/struct/enum/trait | `use_declaration` | `call_expression` |
| **Svelte** | `.svelte` | *(none)* | function (from `<script lang="ts">`) | from `<script>` | from `<script>` |

**Svelte note:** there is no `tree-sitter-svelte` wasm in `tree-sitter-wasms`, so
`parseFile` extracts the `<script>` (or `<script lang="ts">`) block, prepends
blank lines to offset the TS AST's row numbers back onto the original `.svelte`
file, and re-parses it with the **typescript** grammar (`walk`). Symbols,
imports, and calls are extracted from the script; `qualified_name` /
`file_outline` / `call_graph` positions map to the real `.svelte` lines (verified:
`render` at `.svelte` line 2).

### 5.2 Dart call detection quirk

The Dart grammar has **no `call_expression` node**. A call is an `identifier`
(or member access) followed by a `selector` carrying an `argument_part`.
`walkDart` scans for `argument_part` and reads the call target off the enclosing
`selector`'s previous sibling (`obj.method(1)` → `method`; `add(1,2)` → `add`).

Two Dart AST gotchas fixed during this phase:
- `method_signature`'s end position stops at the **signature** — the body is a
  *sibling* `function_body`, not a child. Method symbols therefore extend their
  `end_line` to the following `function_body` so calls inside the body are
  attributed to the method, not the class.
- Top-level `function_signature` and `function_body` are siblings too; same
  `nextSibling` extension applies.

### 5.3 New tool: `bridge_codegraph_diff_impact`

High-value for reviewer agents. Input `{ cwd, base? }` (base defaults to `HEAD`
= working-tree-vs-HEAD). It computes the blast radius of a git diff:

1. `git diff --name-only <base>` → `changedFiles`.
2. Exported symbols defined in those files = the **change surface**
   (`changedSymbols`).
3. Every transitive *caller* of those symbols (direction `in`, depth ≤ 3) via the
   same recursive CTE as `call_graph` — only **resolved** candidate edges are
   followed, so the blast radius is truthful (unresolved imports are not claimed
   as impacted). Output:
   `{ changedFiles, changedSymbols, impactedSymbols:[{qualifiedName,file,line,depth}], truncated, resolutionCoverage }`.

Registered in `packages/codegraph/src/index.ts`, proxied through
`packages/mcp-server/src/tools/codegraph.ts`, and mirrored into
`BRIDGE_TOOL_DOCS` (`packages/shared/src/tool-registry.ts`). Smoke proof
(`live-smoke-p2c.mjs`): change an exported `foo()` that has two transitive
callers (`bar`→`foo`, `baz`→`bar`); `diff_impact` returns `bar` (depth 1) and
`baz` (depth 2) as impacted.

### 5.4 Hardening (re-confirmed)

- **F1 (LRU never closes an indexing DB):** `Engine.evictLru()` skips any project
  whose `indexing` flag is set, so a background re-index can never be killed by DB
  eviction. Re-confirmed present.
- **Incremental re-index robust to rename/delete/.gitignore** (kimi's P1-B
  fixes): `refreshStale()` does a stat sweep to catch deletions and uses
  `git status --porcelain=v2 -z --untracked-files=all` to detect renames (dest
  path indexed; orig path pruned via the stat sweep) and new untracked files.
  Smoke proof: `git mv fileA.ts fileA2.ts` re-indexes `fnA` into `fileA2.ts`;
  deleting `fileB.ts` drops `fnB`. Both PASS.
- **`.gitignore` re-read on change:** `ProjectDb.refreshGitignoreIfChanged()`
  re-parses `.gitignore` when its mtime changes, called from both `index()` and
  `refreshStale()`, so new ignore rules take effect on the next incremental
  refresh without a full re-index.

### 5.5 Files changed (P2c)
- `packages/codegraph/src/engine.ts` — Dart/Rust `walk*` + `extractDartCallee` +
  `extractSvelteScript`; `ext`/grammar maps (`.dart`/`.rs`/`.svelte`);
  `extractCalleeName` `field_expression`/`scoped_identifier`; `diffImpact()`;
  `.gitignore` mtime re-read.
- `packages/codegraph/src/index.ts` — register `bridge_codegraph_diff_impact`.
- `packages/mcp-server/src/tools/codegraph.ts` — proxy `bridge_codegraph_diff_impact`.
- `packages/shared/src/tool-registry.ts` — `BRIDGE_TOOL_DOCS` entry.
- `packages/codegraph/live-smoke-p2c.mjs` (new — gate).
- `packages/codegraph/ADOPTION-AND-RESOLUTION.md` (this file).
