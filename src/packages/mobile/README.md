# `@cocalc/mobile`

The agent-first CoCalc React Native application. Sign in to open the native
My Agents directory, pin or restore agents, manage names and conversation
history, and continue collaborative chat. Agent creation and other incomplete
surfaces remain available through the explicit web management action. It uses Expo SDK 57, React
Native 0.86, React 19.2, Expo Router, and an Expo development build. The package
pins the August 10 SDK 57 patch line so installs honor this repository's
three-day package-age policy while staying on the current Expo SDK.

Generated `ios/` and `android/` projects are intentionally ignored. Native
projects are produced locally with `pnpm native:prebuild` or `pnpm ios`.

## Local commands

From this directory:

```bash
pnpm typecheck
pnpm test
pnpm test:ui
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

Implementation status and remaining device/release qualification are tracked in
[the mobile progress document](../../.agents/cocalc-mobile-progress-2026-09-21.md).
The component tests mock native platform primitives; they do not establish
physical-device accessibility, audio, or background behavior.

## Simulator visual development loop

Use the native iOS Simulator for routine layout work; a phone screenshot is not
required. The preview uses the **same directory, message renderer, and composer**
as the signed-in app, with local sample agents and deterministic replies. It
makes no agent requests and does not need credentials. This is visual/interaction
coverage, not evidence that networking, authentication, or real agents work.

First build/install on an iPhone simulator (select a simulator if prompted):

```bash
pnpm ios:preview
```

For later sessions, keep the existing native build and start Metro:

```bash
pnpm start:preview
```

Preview Metro uses port **8082**, leaving the normal phone server on 8081 alone.
Open **Open local UI preview** on the welcome screen. Preview requires both a
React Native development build and `EXPO_PUBLIC_MOBILE_PREVIEW=1`; a production
bundle cannot activate it through a URL. Browser management and settings are
intentionally unavailable for these sample agents. The preview currently covers
idle conversations, earlier messages, search, and pinning; it does not simulate
approvals, live voice, attachments, or server failures.

Install the **mobile-dev-inc Maestro CLI** from
[its official installer](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli)
and Java 17 or newer. Do not use the unrelated `maestro` Homebrew cask. This Mac's
CLI is in `~/.local/share/cocalc-mobile-tools/maestro/bin/maestro`, with Homebrew
`openjdk@21`; the runner detects those locations. Other installations can set
`MAESTRO_BIN` and `JAVA_HOME` or put the tools on PATH.

With preview Metro running:

```bash
pnpm test:visual
```

The runner boots the installed iPhone 17 Pro simulator, restarts only its CoCalc
app, and tests light, dark, and enlarged accessibility text. It restores the
simulator's previous appearance and text size on completion/failure. Override
the device with `MOBILE_SIMULATOR_ID=<uuid>` and port with
`MOBILE_PREVIEW_PORT=<port>` if needed. It never clears app data or keychain state.

The Maestro flow checks search, pin/unpin, opening a conversation, typing,
sending a local message, dismissing the keyboard, scrolling, earlier messages,
and iOS edge-swipe back navigation. Screenshots, hierarchy/debug data, and logs go under the
ignored `dist/visual/<timestamp>/` directory. Inspect the screenshots after a
run: passing accessibility assertions alone does **not** prove absence of
clipping or overlap. Capture additional states directly with:

```bash
xcrun simctl io <simulator-uuid> screenshot /tmp/cocalc-screen.png
```

JavaScript/layout edits use Fast Refresh. Rebuild for native dependency/config
changes. Reserve physical-device checks for touch feel, audio routing,
permissions, background/resume, and performance; the simulator cannot qualify
those experiences. The Expo floating Tools button belongs to the development
client and may appear in screenshots.
