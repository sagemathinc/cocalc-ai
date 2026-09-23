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

For a simulator build use `pnpm ios:sim` and select a simulator. The visual
runner opens an explicit Metro deep link. Do not bake a forced
`DEV_CLIENT_DEFAULT_LAUNCHER_URL` into the native app: it caused startup crashes
when combined with development-client deep-link launches in this setup.

`pnpm ios` requires the full Xcode application and a selected Xcode developer
directory. A physical device also needs a trusted HTTPS development site; it
cannot reach a service at the Mac's loopback address.

The app supports a development-only HTTP exception for explicit local targets.
Production profiles require HTTPS.

## Standalone iPhone build

Build a Release app with an embedded JavaScript bundle and install it on a
paired iPhone from this directory:

```bash
COCALC_MOBILE_VARIANT=production pnpm exec expo prebuild --platform ios --no-install --clean
COCALC_MOBILE_VARIANT=production pnpm exec expo run:ios --configuration Release --device <device-udid> --no-bundler
```

The production variant is named **CoCalc** and uses
`com.sagemath.cocalc.mobile`; it installs beside **CoCalc Dev**
(`com.sagemath.cocalc.mobile.dev`). A clean prebuild replaces the ignored local
`ios/` directory, so run the dev variant's prebuild again before the next dev
native build. Existing installed apps and their data are unaffected. The
standalone app has its own secure storage, so sign in to a site again.

The Release build embeds `main.jsbundle` in `CoCalc.app` and runs without a
Metro connection. For a cold-launch check, stop the Metro servers, launch the
CoCalc icon directly, then restore them for development. A local Release build
signed for a paired device is a device-test artifact, not a TestFlight or App
Store distribution build. Store distribution and wider device qualification
remain separate release steps.
The prepared internal-beta candidate and signing handoff are recorded in
[TESTFLIGHT.md](TESTFLIGHT.md).

Implementation status and remaining device/release qualification are tracked in
[the mobile progress document](../../.agents/cocalc-mobile-progress-2026-09-21.md).
The component tests mock native platform primitives; they do not establish
physical-device accessibility, audio, or background behavior.

Chat attachments use the native camera, photo-library, and document pickers.
Photos are uploaded as CoCalc blobs for inline rendering; other files are saved
directly on the owning project host and inserted as project-file links. The
composer keeps selected attachments in its saved draft until Send. Each file is
limited to 20 MB and a draft can contain eight attachments. The pickers are
unavailable in the credential-free local UI
preview. Because these are new native modules, rebuild the installed development
app before testing attachments on a phone; a Metro refresh alone is insufficient.

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
idle/running conversations, earlier messages, search, pinning, dictation drafts,
resume, and read-aloud controls; it does not simulate approvals, live voice,
attachments, or server failures.

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
dictating into a draft, background/resume, sending a local message, following
activity, read-aloud/stop, dismissing the keyboard, scrolling, earlier messages,
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

## Dictation and read-aloud

The conversation composer has **Dictate**, **Finish dictation**, and **Cancel**.
Finishing transcribes into the current draft; review/edit it and press Send.
Recording is limited to 90 seconds (or the site's lower limit). Each completed
agent message has **Read aloud**; **Stop read-aloud** stops playback and pending
speech work. Both modes use the site's existing speech capabilities, billing,
and account limits. No live voice session is started.

Switching away stops microphone/playback and cancels unfinished transcription.
The text draft persists, and returning reconnects to the conversation without
starting project compute merely to read. Completed agent work remains on the
server. Sending retains the existing compute-start behavior.

This adds native audio modules and microphone permission. Rebuild the development
app once after updating. Stop the old Metro process, then run
`pnpm start:clear` to start a fresh development server. In another terminal,
from this directory:

```bash
pnpm exec expo prebuild --platform ios
pnpm exec expo run:ios --device
```

Subsequent JavaScript changes use Fast Refresh as before. On a real account,
check microphone permission, dictate a short task, review/send it, switch away
while it runs, return, and try Read aloud/Stop. Also check headset routing and
an interrupted recording. The local UI preview simulates transcription/playback;
it never records or calls the speech provider.

### Local live-voice preview

Start `EXPO_PUBLIC_MOBILE_PREVIEW=1 pnpm exec expo start --dev-client --port 8081`
for a phone (or `pnpm start:preview` on port 8082 for the simulator). Reload the
app, return to its welcome screen, and choose **Open local UI preview → Research
→ Live voice → Start silent simulation**. This explicit preview profile never signs in
or uses a remote agent, microphone, audio playback, or provider connection.
It is silent: simulated replies appear in captions.

**Simulate spoken task** feeds transcript and duplicate delegation events through
the real conversation bridge into the local fixture chat. Its delayed result
returns through the same bridge to the simulated voice captions. Try mute/unmute,
ending a call before the result, **Simulate disconnect**, and leaving/returning to
the app. Accepted preview tasks continue independently of the call. The displayed
cost is an example only. Text drafts are preserved while the call panel replaces
the composer. The extended `pnpm test:visual` flow covers these states in light,
dark, and enlarged-text configurations.

### Real live-voice development gate

The native development build includes `react-native-webrtc`; a rebuild is needed
for actual audio, but the local simulation works without loading that module.
The server API is implemented but awaits staging integration and real-provider
qualification. Remote deployment is intentionally on hold.

The preview API requires **both** `COCALC_LIVE_VOICE_DEV=1` on the account-home
server and an administrator account, plus an existing account/project OpenAI API
key. Site-funded live voice and customer access remain disabled. Keys stay on the
server; audio travels directly between the phone and OpenAI. Session admission,
heartbeat, and end operations route to the account's home bay; ordinary agent
work uses the existing project-host chat transport.

Calls expire after 120 seconds, with a 25-second heartbeat lease and five-second
server cleanup sweep. Lease records are durable across server restarts; keep the
development switch enabled until sessions are closed. Failed provider hangups
remain pending for retries. These are application cleanup deadlines, not a
provider-enforced monetary cap: server/provider outages, credential revocation,
or an unknown creation response still require operator/provider reconciliation.
This limitation must be resolved before customer rollout.

Spoken task submissions and agent results live in the existing chat. Incidental
voice captions are currently transient; full finalized-voice transcript
reconciliation, verified provider usage settlement, configurable paid entitlements,
and background/Bluetooth qualification remain later work. Ending a call never
invokes agent interruption. Voice approval is not a substitute for the existing
approval controls.

### iOS socket session cookies

The workspace patches React Native 0.86.0's `RCTWebSocketModule` so an explicit
`Cookie` header replaces cookies loaded from the iOS cookie jar. Upstream uses
`addValue`, which comma-joins those headers; the resulting login cookie can be
parsed as part of another cookie's value. CoCalc stores profile credentials
separately and supplies its session cookie explicitly.

`plugins/with-native-cookie-fix.cjs` enables `ios.buildReactNativeFromSource` so
Expo does not substitute an unpatched precompiled React Native binary. Native
builds take longer with this setting. Re-run prebuild/pod install and rebuild
the development app when adding or changing this patch. Revisit both the patch
and plugin when upgrading React Native.

### Agent directory and settings

Saved accounts are available directly from the home screen. The directory uses
the same account organization setting as the web app: pins, recent/custom order,
and grouping by project. In Reorder mode, hold a name to drag it or use the
accessible up/down buttons. Moves stay within the pinned/unpinned group and,
when grouped, the project. Filtering disables reordering.

Appearance is loaded independently from each project's existing agent-session
index through its owning host, without starting compute or loading chat history.
Missing/offline indices fall back to the directory title and initials. Supported
web icon aliases use Ant Design and the existing CoCalc font; regenerate the
alias maps with node scripts/generate-icon-names.cjs after web icon changes.
Custom images use the selected site's blob endpoint.

Chat Settings saves payment source, model, thinking level, and speed on the
existing thread. It preserves other configuration. ChatGPT model availability
comes from the account-specific server catalog; API-funded choices use the
shared CoCalc catalog. Connecting/removing credentials remains in the web UI.
Settings affect subsequent turns, not a turn already running.

The focused local simulator flow is:
MOBILE_VISUAL_FLOW=.maestro/agent-settings.yaml pnpm test:visual.
