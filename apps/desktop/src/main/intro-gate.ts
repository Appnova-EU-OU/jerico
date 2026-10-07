/**
 * Whether the first-launch intro should play, as a pure decision.
 *
 * Separated from intro.ts so it can be tested without Electron. The rule it
 * encodes is not obvious and got shipped wrong once: gating on the seen-flag
 * alone looks correct and is not, because the flag is itself new. On the update
 * that introduces it, every existing install has no flag — so every existing
 * user would be handed the complete first-run sequence, and because they are
 * already set up they go straight to the tray afterwards. `setupComplete` is
 * what actually distinguishes a first launch.
 */
export interface IntroGateState {
  /** The marker file exists — this machine has already had its first launch. */
  seenFlagExists: boolean
  /** The daemon is configured: settings, token and LaunchAgent all present. */
  setupComplete: boolean
  /** JERICO_FORCE_INTRO=1 in an unpackaged build — replay for development. */
  forced: boolean
}

export type IntroDecision =
  /** Play it, and record that it played. */
  | 'play'
  /** Do not play, but record it so this is settled once and for all. */
  | 'skip-and-record'
  /** Nothing to do — it is already recorded. */
  | 'skip'

export function introDecision(state: IntroGateState): IntroDecision {
  // Development replay wins over everything, including the flag it ignores.
  if (state.forced) return 'play'
  if (state.seenFlagExists) return 'skip'
  // No flag, but the app is already set up: an existing install meeting this
  // feature for the first time. Settle it silently.
  if (state.setupComplete) return 'skip-and-record'
  return 'play'
}
