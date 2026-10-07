/**
 * agy-usage.ts — Token usage watcher interface for Antigravity (agy).
 *
 * agy stores conversations as SQLite databases under
 * ~/.gemini/antigravity-cli/conversations/<uuid>.db with protobuf-encoded blobs.
 * Decoding these is non-trivial and deferred to a future iteration.
 *
 * The watcher is currently unused (agy shows no quota bar in ToolQuota).
 * The interface is preserved for future implementation.
 */

export interface AgyUsageInfo {
  tokensSpent5h: number
  tokensTotal:   number
}
