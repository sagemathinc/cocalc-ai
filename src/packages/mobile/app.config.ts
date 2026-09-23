import type { ExpoConfig, ConfigContext } from "expo/config";

const isProduction = process.env.COCALC_MOBILE_VARIANT === "production";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: isProduction ? "CoCalc" : "CoCalc Dev",
  slug: "cocalc-mobile",
  version: "0.1.0",
  icon: "./assets/icon.png",
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
    },
  },
  android: {
    permissions: [
      "android.permission.MODIFY_AUDIO_SETTINGS",
      "android.permission.BLUETOOTH",
    ],
    package: isProduction
      ? "com.sagemath.cocalc.mobile"
      : "com.sagemath.cocalc.mobile.dev",
  },
  plugins: [
    "./plugins/with-native-cookie-fix.cjs",
    "expo-router",
    "expo-secure-store",
    [
      "expo-audio",
      {
        microphonePermission:
          "Allow CoCalc to record dictation and talk with your agents.",
        enableBackgroundRecording: false,
        enableBackgroundPlayback: false,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
});
