'use strict'

/**
 * electron-builder afterAllArtifactBuild hook — intentional no-op.
 *
 * The .app is notarized+stapled by afterSign (after the final re-seal, before
 * electron-builder packages the .zip and .dmg). Both artifacts therefore
 * contain a stapled .app; Gatekeeper assesses the .app on launch, not the
 * DMG container, so no further action is needed here.
 *
 * The DMG container staple was removed because xcrun stapler staple on a
 * UDZO/APFS DMG is unreliable: it can corrupt the container (hdiutil reports
 * "image not recognized") while the staple write appears to succeed. Since the
 * .app inside is already stapled, the DMG container ticket is not required for
 * correct Gatekeeper behaviour, and the risk of shipping a corrupt DMG is not
 * worth the marginal benefit of a container-level ticket.
 */
exports.default = async function afterAllArtifactBuild() {
  // no-op: notarize+staple is fully handled by afterSign
}
