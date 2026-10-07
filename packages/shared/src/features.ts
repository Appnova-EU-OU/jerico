/**
 * Env-driven feature flags. Usage:
 *   JERICO_FEATURES=phase2.auto_register,phase2.verified_at bun start
 *   isFeatureEnabled('phase2.auto_register') → true
 *
 * Phase 1.5 scaffolding — no consumers yet. Phase 2 features plug in here.
 *
 * NOTE: Reads process.env on every call (no module-level cache) so tests
 * can mutate the environment and see changes without module reload.
 */

export function isFeatureEnabled(flag: string): boolean {
  const raw = process.env['JERICO_FEATURES'] ?? ''
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(flag)
}

export function enabledFeatures(): readonly string[] {
  const raw = process.env['JERICO_FEATURES'] ?? ''
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}
