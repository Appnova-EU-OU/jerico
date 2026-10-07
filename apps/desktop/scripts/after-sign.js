'use strict'

const { execSync, spawnSync } = require('child_process')
const { existsSync } = require('fs')
const os = require('os')
const path = require('path')

const { hasNotaryCreds, resolveNotaryArgs } = require('./notary-creds')
const { codesignIdentity } = require('./sign-identity')

/**
 * electron-builder afterSign hook — re-sign bridge-agent, re-seal .app,
 * then notarize + staple the .app before electron-builder packages the zip/dmg.
 *
 * WHY THIS HOOK RE-SIGNS bridge-agent:
 * electron-builder's deep-sign applies the Developer ID identity to every
 * Mach-O inside the .app, but does NOT forward custom entitlements to nested
 * executables in Contents/Resources/. bridge-agent (@yao-pkg/pkg output with
 * embedded Node.js runtime + node-pty addon) requires
 * com.apple.security.cs.disable-library-validation; without it the hardened-
 * runtime kernel policy kills it at exec time.
 *
 * WHY NOTARIZATION LIVES HERE (not mac.notarize):
 * electron-builder v24 runs its native notarize step BEFORE afterSign. Using
 * mac.notarize:true would notarize the .app on a pre-re-seal cdhash; afterSign's
 * codesign --force then changes the cdhash, invalidating the staple ticket. The
 * .zip and .dmg are then built from an un-stapled .app → offline Gatekeeper fails.
 * By moving notarize+staple to the END of afterSign (after the cdhash is final),
 * the ticket survives into every artifact electron-builder packages next.
 *
 * ORDERING:
 *   1. Re-sign bridge-agent with the correct entitlements.
 *   2. Re-seal the .app (updates CodeResources with the new bridge-agent hash).
 *   3. ditto-zip the .app (notarytool requires a zip/dmg, not a bare .app dir).
 *   4. xcrun notarytool submit --wait   → Apple records the definitive cdhash.
 *   5. xcrun stapler staple             → embeds the ticket in the .app bundle.
 *   6. xcrun stapler validate           → hard-fail the build if no ticket.
 */

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status === null ? '(killed)' : r.status}`)
  }
}

exports.default = async function afterSign({ appOutDir }) {
  const appPath = path.join(appOutDir, 'jerico.app')
  const bridgeAgent = path.join(appPath, 'Contents', 'Resources', 'bridge-agent')
  const spawnHelper = path.join(appPath, 'Contents', 'Resources', 'spawn-helper')
  const entitlements = path.resolve(__dirname, '..', 'build', 'entitlements.mac.plist')

  if (!existsSync(bridgeAgent)) {
    console.log('[after-sign] bridge-agent not found in Resources — skipping (unsigned/dev build)')
    return
  }

  // Guard: skip if no notarization credentials are resolvable (API key env vars or keychain
  // profile). This is the same gate used by after-all-artifact-build.js and avoids the
  // silent-skip trap of `security find-identity`: in CI the signing cert lives in a temp
  // keychain that may not appear in the default search list, so find-identity returns empty
  // and the whole hook silently skips — re-seal AND notarize — producing an unstapled release.
  // With this guard: no creds → graceful skip; creds present → proceed (codesign will find
  // the identity via the keychain electron-builder already configured for signing).
  if (!hasNotaryCreds()) {
    console.log('[after-sign] no notary credentials — skipping notarize (dev build)')
    if (existsSync(spawnHelper)) {
      execSync(`chmod 755 "${spawnHelper}"`, { stdio: 'inherit' })
    }
    return
  }

  // Prefixed form of JERICO_MAC_SIGN_IDENTITY; throws when unset (sign-identity.js).
  const IDENTITY = codesignIdentity('after-sign')

  // ── Step 1: Re-sign bridge-agent ─────────────────────────────────────────
  console.log('[after-sign] re-signing bridge-agent with hardened runtime + entitlements…')
  execSync(
    `codesign --force --timestamp --options runtime ` +
    `--identifier io.appnova.jerico.bridge ` +
    `--entitlements "${entitlements}" ` +
    `--sign "${IDENTITY}" ` +
    `"${bridgeAgent}"`,
    { stdio: 'inherit' },
  )
  execSync(`codesign --verify --deep --strict "${bridgeAgent}"`, { stdio: 'inherit' })
  console.log('[after-sign] bridge-agent signature verified')

  // ── Step 1b: Re-sign spawn-helper ────────────────────────────────────────
  // Must happen BEFORE re-sealing the .app so the helper is covered by the seal.
  if (existsSync(spawnHelper)) {
    console.log('[after-sign] re-signing spawn-helper…')
    execSync(
      `codesign --force --timestamp --options runtime ` +
      `--sign "${IDENTITY}" ` +
      `"${spawnHelper}"`,
      { stdio: 'inherit' },
    )
    execSync(`chmod 755 "${spawnHelper}"`, { stdio: 'inherit' })
    console.log('[after-sign] spawn-helper signed')
  }

  // ── Step 2: Re-seal the .app ──────────────────────────────────────────────
  console.log('[after-sign] re-sealing .app bundle…')
  execSync(
    `codesign --force --timestamp --options runtime ` +
    `--entitlements "${entitlements}" ` +
    `--sign "${IDENTITY}" ` +
    `"${appPath}"`,
    { stdio: 'inherit' },
  )
  console.log('[after-sign] .app re-sealed — cdhash is now final')

  // ── Steps 3-6: Notarize + staple ─────────────────────────────────────────
  // Must happen AFTER the final re-seal so the cdhash Apple records matches the
  // binary that will be packaged into the .zip and .dmg.
  const { args: notaryArgs, label } = resolveNotaryArgs()
  console.log(`[after-sign] notarizing via ${label}…`)

  // notarytool requires a zip or dmg, not a bare .app directory
  const tmpZip = path.join(os.tmpdir(), 'jerico-notarize.zip')
  console.log(`[after-sign] packaging .app → ${tmpZip}`)
  execSync(`ditto -c -k --keepParent "${appPath}" "${tmpZip}"`, { stdio: 'inherit' })

  run('xcrun', ['notarytool', 'submit', tmpZip, ...notaryArgs, '--wait'])

  try { require('fs').unlinkSync(tmpZip) } catch (_) { /* best-effort cleanup */ }

  console.log('[after-sign] stapling .app…')
  run('xcrun', ['stapler', 'staple', appPath])

  // Hard guard: if the staple did not take, fail the build now rather than
  // shipping an un-stapled app that fails offline Gatekeeper assessment.
  const validate = spawnSync('xcrun', ['stapler', 'validate', appPath], { encoding: 'utf8', stdio: 'pipe' })
  if (validate.status !== 0) {
    throw new Error(
      `[after-sign] stapler validate failed (exit ${validate.status}) — .app is NOT stapled; aborting build.\n` +
      `stdout: ${(validate.stdout || '').trim()}\nstderr: ${(validate.stderr || '').trim()}`
    )
  }

  console.log('[after-sign] stapler validate OK — .app is stapled before packaging')
}
