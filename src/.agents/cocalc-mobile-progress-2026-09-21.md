# CoCalc mobile implementation progress

Date: 2026-09-21
Branch: `feature/cocalc-mobile`
PR: [#671](https://github.com/sagemathinc/cocalc-ai/pull/671)
Plan: [native agent-first application](cocalc-mobile-plan-2026-09-21.md)

Entries are chronological; later milestones supersede earlier remaining-work lists.

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

## Initial boundaries and next work

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

## Live voice development and local preview

The dictation/read-aloud milestone was confirmed working on the maintainer's
physical iPhone after replacing unsupported AbortSignal.throwIfAborted calls.
The native tests now use React Native's actual abort-controller implementation.

Implemented a development-gated live voice path with native WebRTC, direct
provider media, and a headless transcript/delegation bridge to the current agent
conversation. Server admission is account-home routed, checks project access,
and requires an administrator plus an explicit development environment switch.
Only existing account/project OpenAI keys are supported; no site-funded or
customer live voice is enabled. Durable leases, heartbeats, and hangup cleanup
bound ordinary sessions. Provider uncertainty/outages still need reconciliation;
this is not yet a production-grade spend guarantee.

Staging is being prepared by the maintainer. lite1b.cocalc.ai is busy and must
not be modified. No remote deployment has been performed. PR 640 has merged
into origin/main; the mobile branch will need synchronization before staging
integration.

While waiting, added a local-only live voice transport to the explicitly gated
preview profile. It exercises the same delegation bridge with duplicate events,
delayed fixture replies, mute, end, disconnect, and background transitions. No
microphone, credentials, provider calls, or real agent submissions are involved.
Voice task/result messages persist in the fixture chat; incidental captions are
transient, as in the initial real-live prototype.

The call panel hides the inactive text composer without clearing its draft,
dismisses the keyboard at start, labels caption speakers, and avoids announcing
every timer tick to screen readers. Permission-dialog inactivity does not cancel
a call during startup; backgrounding does. Native capture cancellation tests
cover late permission and late admission cleanup.

Native iPhone build succeeded and was installed with devicectl. Launch requires
unlocking the phone. This proves build/install compatibility, not physical live
audio or GPT-Live integration. Finalized transcript reconciliation, actual
provider usage accounting, paid customer entitlement, and real-device audio
qualification remain outstanding. See the mobile README for local preview and
development-gate instructions.

The maintainer opened the installed preview on the iPhone. Their feedback exposed
ambiguous labeling: the simulation intentionally produces captions, not sound.
The panel and start button now explicitly say "Silent simulation", and the
confirmation explains that it uses neither the microphone nor audio playback.

Validation: mobile typecheck, 62 mobile domain/UI/adapter tests, server build and
six focused live-voice tests, frontend lint, dependency consistency, and diff
whitespace checks passed. The focused Maestro live flow passed in light, dark,
and large-text appearances (15 screenshots), covering delegation/results,
mute, end, disconnect, and background/return. Artifacts are under
`src/packages/mobile/dist/visual/2026-09-22T00-37-31.995Z/`.
Run this focused flow with
`MOBILE_VISUAL_FLOW=.maestro/live.yaml pnpm -C src/packages/mobile test:visual`.
These simulated checks do not qualify real provider audio or billing behavior.

## Markdown reading while staging is prepared

Added per-block wrap/unwrap controls for native code rendering, accessible copy
success/failure feedback, and preservation of code whitespace when copying.
Tables now honor Markdown column alignment and expose bold column headings.
The local reply fixture includes a long code line and a numeric table. No native
rebuild or server changes are required. The focused native flow is
`MOBILE_VISUAL_FLOW=.maestro/markdown.yaml pnpm -C src/packages/mobile test:visual`.
Mobile typechecking, all 33 UI tests, and frontend lint passed for this change.

A development-only `cocalc:///markdown-preview` screen provides isolated renderer
fixtures for native visual checks. It redirects to the welcome screen unless
local preview is explicitly enabled. This avoids chat virtualization and
scroll-to-newest behavior interfering with renderer-focused automation.

The final isolated Maestro flow passed in light, dark, and large-text modes,
including wrap/unwrap and copy feedback (nine screenshots). Artifacts:
`src/packages/mobile/dist/visual/2026-09-22T01-13-26.490Z/`.
Keep preview controls clear of Expo's floating developer overlay; taps near it
produced misleading failures during the initial automation attempts.

## Production feedback: accounts, directory, and thread settings

The home screen now shows saved accounts directly. Agent rows show indexed
thread titles, colors, images, and supported web icon aliases (Ant Design and
the existing CoCalc icon font). The appearance reader uses three bounded
workers and project-host session indices; unavailable appearance does not
block the directory or start compute.

The directory exposes the existing shared recent/custom order, project grouping,
and pinned sections. A native draggable list provides reordering, with
accessible up/down alternatives. Moves stay inside pinned/project groups.
Large-text testing moved row actions underneath the title/description and
limited title display to three lines while retaining the full accessible name.

The thread's thinking placeholder becomes an accessible native spinner.
A native settings sheet saves payment preference, model, reasoning, and service
tier via the existing updateThread RPC. It fetches ChatGPT model capabilities
for the selected funding source and preserves other thread configuration.
Credential connection/management remains in the web UI. Missing model catalogs
and failed saves remain visible and do not silently close the sheet.

Validation: 43 UI tests, mobile typecheck, frontend lint, dependency consistency,
and simulator settings flows in light/dark and large-text mode. Large-text
automation needed to wait for reorder layout to settle before tapping the
moved row. Physical-device behavior and production appearance/index coverage
still need maintainer qualification.

Staging CLI authentication was approved and verified. No server deployment or
live provider call has been made during this UI change. Deployment target/config
and R2 artifact setup are not present in this worktree's operator configuration;
the maintainer has been asked for the staging deployment location. Existing
live voice remains the admin-only development prototype described above.

## Native message attachments

The iPhone composer now offers camera, photo library, and document selection.
Selected files upload before Send and appear as removable items in a saved
per-conversation draft; an attachment can be sent without typed text. Raster
photos use the authenticated home-bay blob endpoint and render inline in chat.
Other files go directly to the owning project host beside the agent chat and
use the same `sandbox:` project-file links as the web agent composer. Inputs are
bounded to 20 MB per file and eight items per draft. Unsupported camera image formats are converted to
JPEG for cross-client rendering. Failed uploads leave existing text and already
attached items intact, and only confirmed sends clear the saved draft.

The native picker dependencies require a rebuilt app. Typecheck, mobile tests,
frontend lint, dependency consistency, and an iOS production bundle export
passed. Actual camera/library/document selection, authenticated uploads on a
physical iPhone, and viewing a resulting project-file link on mobile still
need device acceptance.
