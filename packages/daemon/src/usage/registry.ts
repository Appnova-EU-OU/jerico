/**
 * Which agents can report usage, and who asks.
 *
 * This is deliberately a thin map rather than a provider framework. The daemon
 * ALREADY knows where every agent keeps its credentials — `pty/agents.ts`
 * `checkAuth` reads exactly those locations to decide whether an agent can be
 * spawned — so the usage layer is that same knowledge with one more question
 * ("where do I ask?") rather than a second registry that can drift from the
 * first.
 *
 * The reference implementation needed a plugin engine because it is a Swift app
 * running TypeScript provider definitions through a bundled transpiler. Jerico is
 * TypeScript, so a provider is a module and a registry entry. Nothing is gained
 * by building the engine too.
 *
 * An agent with no entry is `unsupported`, which is a STATE and not an error:
 * most agents legitimately have no fetcher yet, and a surface that treats that
 * as a failure would cry wolf on every install. See AGENT-USAGE-PROVIDERS.md for
 * the agreed order.
 */

import { fault, type UsageResult } from './model.js'
import { fetchClaudeUsage } from './providers/claude.js'
import { fetchCopilotUsage } from './providers/copilot.js'
import { fetchCodexUsage } from './providers/codex.js'
import { fetchAgyUsage } from './providers/agy.js'
import { fetchKimiUsage } from './providers/kimi.js'

export interface FetchOptions {
  /** True only when a person just asked. Gates any credential read that can
   *  raise a modal; every scheduled refresh passes false. */
  allowInteractive: boolean
}

type Fetcher = (opts: FetchOptions) => Promise<UsageResult>

/** Keys are `pty/agents.ts` agent keys, so the two registries cannot disagree
 *  about what an agent is called. */
const FETCHERS: Record<string, Fetcher> = {
  claude: fetchClaudeUsage,
  codex: fetchCodexUsage,
  kimi: fetchKimiUsage,
  agy: fetchAgyUsage,
  copilot: fetchCopilotUsage,
}

/**
 * Agents Jerico can spawn that deliberately have NO usage to report, with the
 * reason. Kept explicit so the absence is a decision on the record rather than
 * an omission someone later "fixes" by inventing a ceiling.
 */
export const NO_USAGE_BY_DESIGN: Record<string, string> = {
  ollama: 'runs locally against no quota — there is no ceiling to report, and an empty gauge would read as headroom',
  aider: 'authenticates with the backing provider’s key only (OPENAI_API_KEY / ANTHROPIC_API_KEY) and has no budget of its own',
  sh: 'a shell, not an agent',
  // MEASURED 2026-08-11, and the reason is not "nobody got round to it":
  //
  //   • opencode does have its own credentials — ~/.local/share/opencode/auth.json
  //     holds `opencode` and `opencode-go` entries of `type: api`. So this is not
  //     the borrowed-key situation aider is in.
  //   • But there is no quota endpoint to ask. The reference implementation reaches
  //     opencode's numbers only through a browser cookie for opencode.ai plus a
  //     `POST /\_server` RPC whose `text/javascript` response it parses with a
  //     regex. Both halves are the category this feature refuses: reading a
  //     user's cookie jar to authenticate as them, and screen-scraping an
  //     undocumented RPC.
  //   • Locally, `opencode stats` reports real numbers — $124.91 spend, 150.6M
  //     input tokens, 91 days — and NO ceiling. Consumption without a limit cannot
  //     become a percentage: there is no denominator, and inventing one is the one
  //     thing this whole surface forbids. It is also a heavy scan (1,211 sessions,
  //     several seconds) and so cannot be a five-minute background poll.
  //
  // Revisit if opencode publishes a usage endpoint that takes the api key.
  opencode:
    'has its own API key but no quota endpoint to ask — and its local `stats` reports spend with no ceiling, which cannot honestly become a percentage',
}

export function supportsUsage(agent: string): boolean {
  return Object.prototype.hasOwnProperty.call(FETCHERS, agent)
}

export function listSupported(): string[] {
  return Object.keys(FETCHERS).sort()
}

export async function fetchUsage(agent: string, opts: FetchOptions): Promise<UsageResult> {
  const fetcher = FETCHERS[agent]
  if (fetcher === undefined) {
    const why = NO_USAGE_BY_DESIGN[agent]
    return fault('unsupported', why ?? `no usage fetcher for "${agent}" yet`)
  }
  try {
    return await fetcher(opts)
  } catch (err: unknown) {
    // A fetcher that throws is a bug in the fetcher, not a fault of the user's
    // credential — but it must never take the daemon down or block a refresh
    // cycle for every other agent.
    const msg = err instanceof Error ? err.message : String(err)
    return fault('malformed', `the ${agent} usage fetcher threw: ${msg}`)
  }
}
