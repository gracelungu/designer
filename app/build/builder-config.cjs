// electron-builder settings for the Mac app (used by electron-builder.config.cjs).
// Signing and notarizing turn on by themselves when the secrets are present
// (CSC_LINK for the certificate; APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
// APPLE_TEAM_ID for notarizing). Without them the build is unsigned, which is
// fine for trying it out (right-click › Open the first time).

/** @param {NodeJS.ProcessEnv} env */
function buildConfig(env = process.env) {
  const signed = Boolean(env.CSC_LINK || env.CSC_NAME);
  const notarize = signed && Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
  return {
    appId: 'dev.designer.app',
    productName: 'Designer',
    directories: { output: 'release', buildResources: 'build' },
    files: ['electron/**', 'dist/**', 'skills/**', 'package.json'],
    // The demo project ships next to the app and is copied out on first use.
    extraResources: [{ from: 'demo', to: 'demo', filter: ['**/*', '!node_modules/**', '!dist/**', '!storybook-static/**'] }],
    asar: true,
    // Tells the updater whether macOS will let it swap in a new version by itself.
    extraMetadata: { designerSigned: signed },
    publish: [{ provider: 'github', owner: 'gracelungu', repo: 'designer', releaseType: 'release' }],
    mac: {
      category: 'public.app-category.developer-tools',
      target: [
        { target: 'dmg', arch: ['x64', 'arm64'] },
        // The zip is what auto-update downloads.
        { target: 'zip', arch: ['x64', 'arm64'] },
      ],
      identity: signed ? undefined : null,
      hardenedRuntime: signed,
      gatekeeperAssess: false,
      entitlements: signed ? 'build/entitlements.mac.plist' : undefined,
      entitlementsInherit: signed ? 'build/entitlements.mac.plist' : undefined,
      notarize,
    },
    linux: { target: ['dir'] },
    artifactName: '${productName}-${version}-${arch}.${ext}',
  };
}

module.exports = { buildConfig };
