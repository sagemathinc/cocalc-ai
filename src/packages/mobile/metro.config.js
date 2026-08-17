const { getDefaultConfig } = require("expo/metro-config");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Keep package export resolution enabled: CoCalc workspace packages expose their
// browser-neutral surfaces through package.json exports.
config.resolver.unstable_enablePackageExports = true;
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  path: require.resolve("path-browserify"),
};

module.exports = config;
