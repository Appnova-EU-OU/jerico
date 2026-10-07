'use strict'

/**
 * The macOS signing identity, read from the environment instead of the source.
 *
 *   JERICO_MAC_SIGN_IDENTITY — the Developer ID Application certificate's COMMON
 *                              NAME without the type prefix, e.g. "Jane Doe (ABCDE12345)".
 *                              CI passes it from the MAC_SIGN_IDENTITY secret.
 *
 * Both consumers derive their form from that one value:
 *   - electron-builder: the common name, via CSC_NAME. With `mac.identity` absent,
 *     app-builder-lib 24.13.3 resolves `qualifier || process.env.CSC_NAME`
 *     (out/codeSign/macCodeSign.js:257) when it signs, which is after afterPack.
 *     It rejects the "Developer ID Application:" prefix (macCodeSign.js:277).
 *   - after-sign.js: codesign needs the prefixed form, built by codesignIdentity().
 *
 * Fail closed: a build that signs (CSC_LINK set, or notarization credentials
 * present) without the identity throws instead of letting electron-builder
 * auto-discover some other certificate or ship an ad-hoc/unsigned app.
 * A local build with neither is an unsigned dev build: auto-discovery is turned
 * off so it is unsigned on every machine, not signed by whatever happens to be
 * in the keychain.
 */

const { hasNotaryCreds } = require('./notary-creds')

const ENV_NAME = 'JERICO_MAC_SIGN_IDENTITY'
const PREFIX = 'Developer ID Application:'

function isSigningBuild() {
  return Boolean((process.env.CSC_LINK || '').trim()) || hasNotaryCreds()
}

/** The common name, or null when unset. Throws on a malformed value. */
function readSignIdentity() {
  const raw = (process.env[ENV_NAME] || '').trim()
  if (!raw) return null
  if (raw.startsWith(PREFIX)) {
    throw new Error(`${ENV_NAME} must be the certificate's common name without the "${PREFIX}" prefix (e.g. "Jane Doe (ABCDE12345)")`)
  }
  if (!/\([A-Z0-9]{10}\)$/.test(raw)) {
    throw new Error(`${ENV_NAME} must end with the 10-character team ID in parentheses, e.g. "Jane Doe (ABCDE12345)"`)
  }
  return raw
}

function missingIdentityError(where) {
  return new Error(
    `[${where}] refusing to build: this build signs (CSC_LINK or notarization credentials are set) ` +
    `but ${ENV_NAME} is not set. Set it to the Developer ID Application certificate's common name, ` +
    `e.g. ${ENV_NAME}="Jane Doe (ABCDE12345)" (CI: secrets.MAC_SIGN_IDENTITY).`,
  )
}

/**
 * Called from afterPack, before electron-builder signs. Exports CSC_NAME for a
 * signing build, throws if the identity is missing there, and disables identity
 * auto-discovery for an unsigned dev build.
 */
function applySignIdentity(where) {
  const identity = readSignIdentity()
  if (identity) {
    process.env.CSC_NAME = identity
    console.log(`[${where}] signing identity from ${ENV_NAME}: ${identity}`)
    return identity
  }
  if (isSigningBuild()) throw missingIdentityError(where)
  delete process.env.CSC_NAME
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  console.log(`[${where}] ${ENV_NAME} not set and nothing to sign with — unsigned dev build`)
  return null
}

/** The prefixed identity codesign needs. Throws if unset: only called when signing. */
function codesignIdentity(where) {
  const identity = readSignIdentity()
  if (!identity) throw missingIdentityError(where)
  return `${PREFIX} ${identity}`
}

module.exports = { ENV_NAME, applySignIdentity, codesignIdentity, isSigningBuild, readSignIdentity }
