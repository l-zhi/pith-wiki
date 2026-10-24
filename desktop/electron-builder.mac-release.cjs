// Keep local unsigned builds separate from distribution builds.
const { build } = require('./package.json');
const { identity: _unsignedIdentity, ...mac } = build.mac;

module.exports = {
  ...build,
  mac: {
    ...mac,
    type: 'distribution',
    forceCodeSigning: true,
    hardenedRuntime: true,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    notarize: true,
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
  dmg: {
    sign: true,
    // The finalization step staples the DMG after packaging. Only ZIPs participate
    // in updater metadata, so stapling cannot invalidate a DMG hash/blockmap.
    writeUpdateInfo: false,
  },
};
