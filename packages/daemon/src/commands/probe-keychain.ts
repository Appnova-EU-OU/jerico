import { probeKeychainAcl } from '../token-store.js'

export function runProbeKeychain(): void {
  const ok = probeKeychainAcl()
  if (ok) {
    console.log('[bridge] probe-keychain: ACL functional')
    process.exit(0)
  } else {
    console.error('[bridge] probe-keychain: ACL check failed')
    process.exit(1)
  }
}
