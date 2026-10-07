// ============================================================================
// Codegraph nudge — serve-time strip (issue #521 Step 4 A/B harness)
// ============================================================================
// The codegraph nudge sentence below is byte-identical in 4 roles in
// default-role-prompts.ts (developer/reviewer/planner/executor). Role
// prompts resolve DB-first (workspace_prompts row wins over code defaults), so
// editing the code default would be inert for existing workspaces — the A/B
// off-arm strip MUST happen at serve time, leaving DB rows byte-unchanged.
//
// The sentence here is copied VERBATIM from default-role-prompts.ts — do not
// paraphrase; the strip relies on an exact substring match.

/** Verbatim nudge sentence shared by all 4 role prompts (398 chars). */
export const CODEGRAPH_NUDGE_PATTERN =
  "When exploring code STRUCTURE (find a symbol, who-calls-X, callees, a file's outline, a symbol's source), PREFER `bridge_codegraph_find_symbol` / `bridge_codegraph_find_references` / `bridge_codegraph_call_graph` / `bridge_codegraph_file_outline` / `bridge_codegraph_get_symbol_source` over reading whole files or broad Grep. Use Read/Grep only for content search or when codegraph returns nothing."

// Belt-and-braces: any line mentioning a bridge_codegraph_* tool. Covers
// user-edited prompts with paraphrased nudges — in the off-arm those tools do
// not exist, so no served prompt line may reference them.
const CODEGRAPH_TOOL_LINE_RE = /bridge_codegraph_\w+/

// Heading line that directly introduces the nudge paragraph (reviewer role:
// '### Step 3.5 — Code exploration (structure)'). In the other 3 roles the
// bold label rides on the same line as the sentence, so only the reviewer
// needs this lookback.
const NUDGE_HEADING_RE = /^#{1,6}\s+.*code exploration/i

/**
 * Remove the codegraph nudge paragraph from a role prompt and collapse the
 * blank line the removal leaves behind. Returns the input unchanged when no
 * nudge is present. Pure: the codegraphEnabled() check lives at the serve
 * points (relay.ts spawn enrich, workspaces.ts prompts route).
 */
export function stripCodegraphNudge(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let removed = false
  let fallbackFired = false

  for (const line of lines) {
    const isVerbatim = line.includes(CODEGRAPH_NUDGE_PATTERN)
    const isFallback = !isVerbatim && CODEGRAPH_TOOL_LINE_RE.test(line)
    if (isVerbatim || isFallback) {
      removed = true
      if (isFallback) fallbackFired = true
      // Drop a heading line that directly introduces the removed nudge line.
      const prev = out[out.length - 1]
      if (prev !== undefined && NUDGE_HEADING_RE.test(prev)) out.pop()
      continue
    }
    out.push(line)
  }

  if (!removed) return content
  if (fallbackFired) {
    // Frequency of this log = prompt drift measure (paraphrased nudges the
    // verbatim sentence no longer matches).
    console.warn('[prompts] codegraph-nudge fallback strip fired — paraphrased nudge line removed')
  }

  // Collapse blank-line runs left behind by the removal (2+ blank → 1 blank).
  const collapsed: string[] = []
  for (const line of out) {
    const prev = collapsed[collapsed.length - 1]
    if (line.trim() === '' && prev !== undefined && prev.trim() === '') continue
    collapsed.push(line)
  }
  return collapsed.join('\n')
}
