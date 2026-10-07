# Codegraph Adoption Gate (spec §11) — Phase 3

Date: 2026-07-15
Scope: spec §11 Layer 3 (conditional PreToolUse hook) + the adoption-gate
evaluator + the nudge→hook→kill decision ladder. Node 22. No prod daemon.
Mechanism is **deploy-ready and opt-in**; **real adoption is UNMEASURED** (needs
weeks of live agent use — not produced in this phase).

---

## 1. The honest state

| Layer | Status |
|-------|--------|
| §11 Layer 1 — role-prompt nudge | **SHIPPED** (P1-D): `bridge_codegraph_*` preferred in developer/reviewer/planner/executor role prompts |
| §11 Layer 2 — measurement counters | **SHIPPED** (P1-D): per-call tally + `~/.jerico/codegraph/adoption.jsonl` |
| §11 Layer 3 — conditional PreToolUse hook | **BUILD + DEPLOY-READY, NOT AUTO-ENABLED** (this phase) |
| Real adoption % | **UNMEASURED** — no live agent traffic existed during this build |

> **Decision pending live data.** The mechanism is complete. Whether codegraph earns
> its keep is a question only weeks of real agent use can answer. This doc defines
> the ladder and the kill criterion so the decision is mechanical, not subjective.

---

## 2. The nudge → hook → kill ladder

Adoption is a **soft lever** (spec §11). The three layers escalate cost/intrusiveness
only as the previous, cheaper one fails:

1. **NUDGE (Layer 1, already shipped).** Role-prompt text asks agents to prefer
   `bridge_codegraph_*` for structural exploration. Zero friction, zero blocking,
   fully cacheable. *Cheapest lever; try first.*
2. **HOOK (Layer 3, this phase — opt-in).** A NON-BLOCKING PreToolUse hook
   (`packages/codegraph/hooks/codegraph-discovery-gate.{sh,mjs}`) intercepts
   `Grep`/`Glob` calls and injects the codegraph structural equivalent
   (`find_symbol`/`find_references` matches) as `additionalContext`. Still
   non-blocking, still never gates `Read`. Only escalate to the hook **if the nudge
   alone shows < 5% adoption** after a measurement window.
3. **KILL (decommission).** If the hook is active (opt-in deployed) AND adoption
   is still below the assumed target after the grace window, **decommission
   codegraph** — the lever is not paying for itself.

```
adoption gate decision (per adoption-gate output):

  adoption proxy UNMEASURED (no Grep denominator)  -> PENDING (collect data)
  adoption < 5%  AND hook not active             -> FAIL   (activate hook)
  adoption < 15% AND hook active (grace elapsed) -> KILL   (decommission)
  5% <= adoption < 15%                            -> PENDING (observe)
  adoption >= 15% (target met)                    -> PASS
```

---

## 3. The PreToolUse hook (Layer 3) — opt-in, NOT auto-enabled

Files:
- `packages/codegraph/hooks/codegraph-discovery-gate.mjs` — the hook logic.
- `packages/codegraph/hooks/codegraph-discovery-gate.sh` — thin wrapper.

Behaviour:
- Reads the PreToolUse JSON from stdin (`tool_name`, `tool_input`).
- Gated tools: **`Grep` and `Glob` only.** `Read` is deliberately **NOT**
  gated — gating `Read` would break read-before-edit.
- Translates the textual `pattern` into a codegraph structural lookup
  (`jerico-codegraph structural --pattern <p> --cwd <project>` →
  `find_symbol` exact, then a name `LIKE` fallback).
- Injects the matches as `additionalContext` + a non-blocking
  `hookSpecificOutput` (`permissionDecision: allow`).
- **Always `exit 0`.** If codegraph is down, slow (>`CODEGRAPH_HOOK_TIMEOUT_MS`,
  default 600ms), returns nothing, or errors → **silent passthrough**, the tool
  call proceeds unchanged.
- Optionally records a `codegraph_hook_inject` event to `adoption.jsonl`
  (`CODEGRAPH_HOOK_RECORD=1`) so the hook's engagement is measurable without
  parsing transcripts.

Opt-in install (you must add this yourself — it is **not** enabled by default):

```jsonc
// ~/.claude/settings.json  (or a project .claude/settings.json)
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Grep|Glob",
        "hooks": [
          {
            "type": "command",
            "command": "node /abs/path/to/packages/codegraph/hooks/codegraph-discovery-gate.mjs",
            "timeout": 2
          }
        ]
      }
    ]
  }
}
```

Why not auto-enable: a hook that spawns a subprocess on every Grep/Glob is a
real per-call latency + surface-area cost. It is the *escalation* lever, applied
only after the cheaper nudge proves insufficient in live data.

---

## 4. The adoption-gate evaluator (spec §11 metrics)

Command: `jerico-codegraph adoption-gate`
Reads: `~/.jerico/codegraph/adoption.jsonl` (written by the bridge-mcp server on
every `bridge_codegraph_*` call, and optionally by the hook on every inject).

Metrics computed:
- **codegraph tool calls** total + per-tool breakdown.
- **Grep denominator** — native `Grep`/`Read` are Claude-Code built-ins, **not
  visible** to the mcp server, so `adoption.jsonl` has no Grep rows. The honest
  denominator proxy:
  - *If* a side-channel `grep-counts.jsonl` exists (e.g. parsed from session
    transcripts), it supplies the Grep count and a true ratio is computed.
  - *Else* the ratio is reported **UNMEASURED** and we fall back to reporting
    codegraph-calls-per-project + the limitation. This is the expected state
    today.
- **adoption proxy** = `codegraphCalls / (codegraphCalls + grepCalls)` when the
  Grep denominator is available.
- **hook injects** — count of `codegraph_hook_inject` records (proof the opt-in
  hook is engaged), used by the verdict logic.
- **token-delta** — **UNMEASURED**; no per-turn token logs are collected. The
  assumed ≥30% token-reduction target cannot yet be verified; flagged honestly.

### ASSUMED targets (recalibrate after 2 weeks of live data)

| Metric | ASSUMED target | Source |
|--------|----------------|--------|
| Adoption proxy | ≥ **15%** | assumed (spec §11) — recalibrate |
| Token reduction | ≥ **30%** | assumed — UNMEASURED today |

These are **assumed**, not measured. They exist so the kill decision is
mechanical once real data lands. Treat them as hypotheses to test, not facts.

### Verdict

`PASS` / `FAIL` / `KILL` / `PENDING` per the ladder in §2. The default verdict
today is **PENDING** (adoption proxy UNMEASURED — Grep denominator unavailable;
mechanism ready; decision deferred to live data).

---

## 5. Files

- `packages/codegraph/hooks/codegraph-discovery-gate.mjs` (Layer 3 hook)
- `packages/codegraph/hooks/codegraph-discovery-gate.sh` (wrapper)
- `packages/codegraph/src/index.ts` — `structural` + `adoption-gate` subcommands
- `packages/codegraph/src/engine.ts` — `ProjectDb.structuralLookup`
- `packages/codegraph/live-smoke-p3.mjs` — Phase 3 gate
- `packages/codegraph/ADOPTION-GATE.md` (this file)
