import { getToken, setToken } from '../token-store.js'

/**
 * heal-keychain: Re-apply -T ACL flags to the existing token entry.
 *
 * Reads the current token via getToken() (Keychain-first, with staging
 * self-heal), then re-writes it via setToken() which uses the staging
 * delete+recreate pattern from Phase A — ensuring fresh -T ACL with
 * all trusted binary paths.
 *
 * Exit codes:
 *   0 — heal succeeded
 *   1 — heal failed (token found but setToken returned false)
 *   3 — no token found anywhere (nothing to heal)
 */
export function runHealKeychain(): void {
  const t = getToken()
  if (!t.found) {
    console.error('[bridge] heal-keychain: no token found')
    process.exit(3)
  }

  setToken(t.token!)

  // Verify the write was successful by reading back
  const verify = getToken()
  if (!verify.found) {
    console.error('[bridge] heal-keychain: token lost after write')
    process.exit(1)
  }

  console.log('[bridge] heal-keychain: ACL re-applied successfully')
  process.exit(0)
}
