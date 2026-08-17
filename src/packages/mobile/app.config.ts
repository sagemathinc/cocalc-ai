import type { ExpoConfig, ConfigContext } from "expo/config";

const isProduction = process.env.COCALC_MOBILE_VARIANT === "production";
const defaultDevelopmentServer =
  process.env.COCALC_MOBILE_DEV_SERVER_URL?.trim();

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: isProduction ? "CoCalc" : "CoCalc Dev",
  slug: "cocalc-mobile",
  version: "0.1.0",
  orientation: "default",
  scheme: "cocalc",
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: isProduction
      ? "com.sagemath.cocalc.mobile"
      : "com.sagemath.cocalc.mobile.dev",
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      ...(defaultDevelopmentServer
        ? { DEV_CLIENT_DEFAULT_LAUNCHER_URL: defaultDevelopmentServer }
        : {}),
    },
  },
  android: {
    package: isProduction
      ? "com.sagemath.cocalc.mobile"
      : "com.sagemath.cocalc.mobile.dev",
  },
  plugins: ["expo-router", "expo-secure-store"],
  experiments: {
    typedRoutes: true,
  },
});
