/** The approved film reaches its held Jerico lockup at 13.6 real seconds. */
export const FIRST_RUN_INTRO_END_SECONDS = 13.6

/** Reduced motion replaces the film with one settled lockup hold. */
export const FIRST_RUN_REDUCED_INTRO_HOLD_MS = 1_800

/** The first-run renderer's complete authority before the permission gate. */
export interface FirstRunAPI {
  /** Announces that Escape and the visible Skip action may now dismiss the tour. */
  tourReady(): void
  /** Ends either the completed sequence or the optional remainder. */
  done(): void
}

/**
 * The brand introduction is the one non-dismissible part of first launch.
 * Once its lockup has held, every product scene after it is optional.
 */
export function canSkipFirstRun(elapsedSeconds: number): boolean {
  return Number.isFinite(elapsedSeconds) && elapsedSeconds >= FIRST_RUN_INTRO_END_SECONDS
}

/** Main-process wall-clock gate; renderer IPC cannot shorten this interval. */
export function firstRunMinimumVisibleMs(reducedMotion: boolean): number {
  return reducedMotion
    ? FIRST_RUN_REDUCED_INTRO_HOLD_MS
    : FIRST_RUN_INTRO_END_SECONDS * 1_000
}
