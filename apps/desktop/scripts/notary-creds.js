'use strict'

/**
 * Shared notarization credential helpers used by after-sign.js and
 * after-all-artifact-build.js.
 *
 * Credential resolution order:
 *   1. APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER  (CI — App Store Connect API key)
 *   2. NOTARY_KEYCHAIN_PROFILE env var                       (local explicit profile)
 *   3. default keychain profile "jerico-notary"              (local stored credentials)
 *
 * Note: Do NOT gate on `security find-identity` "Developer ID Application".
 * In CI, electron-builder imports the cert into a temp keychain; the default
 * keychain search returns nothing even though the .app is fully signed.
 * notarytool uses the App Store Connect API key — no keychain identity needed.
 */

const { spawnSync } = require('child_process')

function hasNotaryCreds() {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, NOTARY_KEYCHAIN_PROFILE } = process.env
  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) return true
  if (NOTARY_KEYCHAIN_PROFILE) return true
  const r = spawnSync(
    'security',
    ['find-generic-password', '-s', 'com.apple.notarytool', '-a', 'jerico-notary'],
    { encoding: 'utf8' }
  )
  return r.status === 0
}

function resolveNotaryArgs() {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, NOTARY_KEYCHAIN_PROFILE } = process.env
  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    return {
      args: ['--key', APPLE_API_KEY, '--key-id', APPLE_API_KEY_ID, '--issuer', APPLE_API_ISSUER],
      label: `API key ${APPLE_API_KEY_ID}`,
    }
  }
  if (NOTARY_KEYCHAIN_PROFILE) {
    return { args: ['--keychain-profile', NOTARY_KEYCHAIN_PROFILE], label: `keychain profile ${NOTARY_KEYCHAIN_PROFILE}` }
  }
  return { args: ['--keychain-profile', 'jerico-notary'], label: 'keychain profile jerico-notary' }
}

module.exports = { hasNotaryCreds, resolveNotaryArgs }
