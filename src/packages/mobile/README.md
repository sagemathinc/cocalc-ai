# `@cocalc/mobile`

The chat-first CoCalc React Native application. It uses Expo SDK 57, React
Native 0.86, React 19.2, Expo Router, and an Expo development build. The package
pins the August 10 SDK 57 patch line so installs honor this repository's
three-day package-age policy while staying on the current Expo SDK.

Generated `ios/` and `android/` projects are intentionally ignored. Native
projects are produced locally with `pnpm native:prebuild` or `pnpm ios`.

## Local commands

From this directory:

```bash
pnpm typecheck
pnpm export:ios
pnpm start
pnpm ios
```

For a simulator-only loop that launches straight into the local Metro server
without the development-launcher chooser, use `pnpm ios:sim`. The configured
`localhost` URL is intentionally not suitable for a physical device.

`pnpm ios` requires the full Xcode application and a selected Xcode developer
directory. A physical device also needs a trusted HTTPS development site; it
cannot reach a service at the Mac's loopback address.

The app supports a development-only HTTP exception for explicit local targets.
Production profiles require HTTPS.
