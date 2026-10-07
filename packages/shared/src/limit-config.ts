/**
 * Single source of truth for Claude 5-hour usage-limit thresholds.
 *
 * These defaults are read by both the server-side evaluator and the web banner.
 * A future user setting can override them in one place without touching eval
 * logic or UI code scattered across the codebase.
 */
export const LIMIT_THRESHOLDS = {
  info: 70,
  warn: 85,
  consent: 90,
} as const
