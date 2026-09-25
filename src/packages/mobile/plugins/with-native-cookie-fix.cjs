// CoCalc: Copyright © 2026 SageMath, Inc. License: MS-RSL.
const { withPodfileProperties } = require("expo/config-plugins");

module.exports = function withNativeCookieFix(config) {
  return withPodfileProperties(config, (config) => {
    // The pnpm React Native patch changes RCTWebSocketModule. Expo's default
    // precompiled React Native binary would silently bypass that source patch.
    config.modResults["ios.buildReactNativeFromSource"] = "true";
    return config;
  });
};
