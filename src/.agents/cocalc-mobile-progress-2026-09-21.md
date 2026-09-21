# CoCalc mobile implementation progress

Date: 2026-09-21
Branch: `feature/cocalc-mobile`
PR: [#671](https://github.com/sagemathinc/cocalc-ai/pull/671)
Plan: [native agent-first application](cocalc-mobile-plan-2026-09-21.md)

## Implemented in the first milestone

- Successful sign-in and saved-account selection now open native My Agents.
- Named agents come from the account registry, not project/session enumeration.
  Native search, pins, hidden-agent restoration, and recency use the same
  organization data as web. Refresh occurs on focus/foreground and pull-to-refresh.
- Moved the pure organization model to `@cocalc/chat-client`; web re-exports it
  and keeps its existing persistence hook. Shared RPC helpers load/save native
  account organization and resolve only the selected project's current host.
- Native agent details support name/description changes, past conversations,
  current conversation, and confirmed fresh-conversation transitions using the
  existing server's expected-thread check and identity/history semantics.
- Native chat uses the existing remote project-host chat service, including
  bounded initial history and explicit older-message loading. Reading no longer
  starts project compute. Send retains normal compute startup.
- Added a guidance control for running agents, distinct from queued sending and
  interruption. Browser handoff now selects the actual thread.
- Draft restoration no longer races a default empty-draft write. Edits persist
  immediately through a per-conversation serialized writer, so a delayed write
  cannot resurrect a draft cleared after sending. Failed/uncertain sends retain
  the draft and do not claim confirmed rejection.
- New screens and conversation chrome use concrete semantic appearance palette
  values for native light/dark themes, with named controls and touch targets.
- Added native component tests with mocked platform primitives, plus focused
  domain/storage tests. This is interaction regression coverage, not device QA.

## Validation

The following checks passed for this milestone:

- chat-client build and Jest suites (32 tests);
- mobile typecheck, storage/protocol tests (16), and native component tests (11);
- web organization suites (16 tests) and frontend typecheck;
- frontend lint, dependency-version consistency, and iOS production bundle export;
- formatting and diff checks.

A production JavaScript bundle export is not an installed iOS application.
At the initial milestone, live-account acceptance, simulator visual review, and
physical-device testing had not yet been performed. Subsequent evidence is
recorded below. No push, audio, or store release is claimed.

## Current boundaries and next work

This is an agent-first foundation, not full plan completion. Native agent
creation, attachments, rich output/artifact viewing and selection feedback,
terminals, live voice, push notifications, and distribution remain. Dictation/TTS
implementation and qualification are recorded in the later milestone below.
A clearly labeled web Agents management action is available while creation and
other management screens are implemented. It is a temporary capability gap.

The directory reads preference snapshots; it is not yet subscribed to live
account projections. Simultaneous organization writes have the existing
whole-preference last-write behavior. Groups/custom order are respected in the
shared model, but native grouping/reordering controls remain to be designed.
Errors and unavailable-agent states are visible; full capability negotiation and
live cross-bay/device acceptance still need qualification.

Next implement shared agent creation with recoverable intermediate state and
native project/configuration selection, then attachments and artifact viewing.
Prototype live delegation early alongside those features using configurable
membership entitlements, retaining the existing less expensive speech modes.

## Simulator feedback loop and first visual fixes

William subsequently installed the development build on his iPhone and reported
successfully sending a message to an agent and seeing its response. He also
reported overlapping text. This is a real-device smoke check, not full acceptance.

Added a repeatable local visual workflow in `src/packages/mobile`:

- `pnpm ios:preview` installs the simulator development build;
- `pnpm start:preview` runs explicitly enabled preview Metro on port 8082,
  independently of the physical-phone Metro server on 8081;
- `pnpm test:visual` drives the installed iPhone 17 Pro through Maestro, captures
  screenshots and debug artifacts under `dist/visual`, and restores the prior
  simulator theme and text size;
- fixtures exercise the actual agent directory and conversation screens without
  credentials, project startup, or agent charges. Both `__DEV__` and the explicit
  preview environment flag are required. Production flag gating and independent
  local conversation state have regression coverage.

Simulator inspection reproduced directory content underneath the large native
header/status bar. Use a regular native header for these layouts. Chat also used
an assumed 90-point keyboard offset, partially covering Send; it now uses the
actual navigation header height. The navigation theme follows system appearance,
message/action rows can wrap, and Markdown removes extra block-edge whitespace
and uses the same semantic palette as the conversation.

The native flow covers search, pin/unpin, opening chat, keyboard input, local
sending/reply, keyboard dismissal, scrolling, loading earlier messages, and iOS
edge-swipe back navigation. It runs in light/dark mode and dark mode with
`accessibility-medium` text. Screenshots require visual inspection in addition
to passing flow assertions. Native header-back taps did not navigate reliably
in the initial automation attempts; the tested navigation is the edge gesture.
Do not treat that as qualification of the header button on physical devices.

Remaining preview scenarios include running/streaming activity, failures,
approvals, artifacts, voice, and agent settings. The fixture smoke test does not
replace authenticated integration tests or physical-device audio/lifecycle QA.
Keep source files stable during a flow: Fast Refresh can reset local fixtures
and invalidate a run. The Expo floating Tools button is development-client UI.

Follow-up validation passed: native iOS Simulator build, the three Maestro 2.10.0
flows on iPhone 17 Pro / iOS 26.5 (15 captured screenshots), mobile typecheck,
16 domain/storage tests, 14 component/fixture tests, frontend lint, and iOS
production bundle export. Final visual artifacts are local and ignored at
`src/packages/mobile/dist/visual/2026-09-21T21-15-04.993Z/`. Directory/chat and
keyboard screenshots were visually inspected, including dark mode and enlarged
text. This establishes the development feedback loop, not full visual polish.

## Dictate, follow, return, and listen milestone

Implemented the native conversation loop:

- Dictate records bounded mono MP4 audio, checks existing site speech capabilities,
  and transcribes through the existing account-authorized speech RPC. Finish adds
  recognized text to the latest editable draft; it never sends automatically.
- Cancelling, leaving the screen, or backgrounding cancels speech work, stops
  recording/playback, and fences late results. Temporary recordings and generated
  speech files are disposed. Permission, capability, and provider errors remain
  visible beside the composer.
- Completed agent replies have Read aloud and a Stop control. Markdown-to-speech
  conversion is shared with web via chat-client. Long responses are synthesized
  and played in bounded chunks using the site's default voice and existing
  account limits/billing. This does not open a live voice session.
- Background/resume preserves the current transcript and draft while reconnecting
  to project-host chat; reading/reconnecting does not start compute. Incomplete
  connection snapshots retain visible messages. Sending requires a ready,
  connected client. Existing uncertain-send behavior retains the draft.
- Native Markdown now renders headings, emphasis, nested lists, quotes, code
  blocks with Copy, and horizontally scrollable tables. Images/advanced math and
  artifact interaction remain outside this increment.
- Local preview simulates dictation, running activity, completion after leaving
  the app, and read-aloud controls. Those simulations do not prove actual audio
  capture, provider calls, or physical-device behavior.

Native audio dependencies require one development-app rebuild; subsequent JS
changes retain the normal Fast Refresh loop. Background speech is deliberately
stopped for this increment. Push notifications and live voice remain later work.

Validation passed: mobile typecheck, 23 domain/controller tests, 22 native
component/adapter/fixture tests, chat-client build and 32 tests, the three web
speech conversion tests, frontend typecheck/lint, dependency consistency, and
iOS production bundle export. A native iOS Simulator build succeeded. All three
Maestro flows passed on iPhone 17 Pro / iOS 26.5, producing 24 screenshots at
`src/packages/mobile/dist/visual/2026-09-21T23-14-32.326Z/`. Recording, progress,
reply, and read-aloud screenshots were inspected, including dark mode and
enlarged text. Horizontal code-block scrolling initially expanded message
heights; bounding its flex growth fixed that observed layout regression.
Message actions remain individually accessible instead of being swallowed by a
message-level accessibility label.

The native build now uses Expo SDK 57's recommended React Native 0.86.0. During
qualification, startup crashes occurred before application JavaScript with the
forced `DEV_CLIENT_DEFAULT_LAUNCHER_URL` setting. Clean builds and source-built
Expo modules alone did not resolve them. Removing that forced URL and restarting
Metro after dependency changes restored repeatable cold launches through the
explicit deep link. No dependency patch or source-build override is required.
The previously observed native-header tap issue remains; the acceptance flow
uses the iOS back gesture.

Real microphone, speaker/headset routing, interruptions, and actual provider
usage still require a physical-device smoke check. The new modules and
microphone permission require a native rebuild, with a freshly restarted Metro
server; see the mobile README for the exact commands.
