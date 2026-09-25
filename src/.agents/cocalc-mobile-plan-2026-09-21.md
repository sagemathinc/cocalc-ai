# CoCalc mobile: native agent-first application

Date: 2026-09-21
Status: implementation in progress following user authorization on 2026-09-21.
See [implementation progress](cocalc-mobile-progress-2026-09-21.md) for tested scope and remaining work.
Branch: `feature/cocalc-mobile`
Base: `feature/my-agents-workspace` / [PR #640](https://github.com/sagemathinc/cocalc-ai/pull/640).

## Product decision

Build a high-quality native mobile application for the agent-first CoCalc
experience. This is a major product priority. The conceptual simplification is
that an agent is the place the user returns to; projects, files, and execution
remain underneath it. Implementation complexity is substantial even though the
navigation becomes easier to understand.

The target is exactly the capabilities and semantics of `/agents`, expressed
through native phone and tablet interactions. Do not reproduce desktop frame
layouts on a small screen or make the existing website the primary app UI.
Actions that leave Agents for the project should open a WebView or external
browser at the precise destination and return cleanly to the native workspace.

Keep Expo/React Native and reuse non-view TypeScript. Share domain behavior,
protocols, and recovery logic, while designing native screens and controls.
Retain both dictation/text-to-speech and live voice permanently. Live voice is
an optional paid capability, not a replacement for the less expensive modes.

This plan supersedes the product scope of the
[August native vertical slice](react-native-first-vertical-slice-plan-2026-08-14.md),
while retaining its transport and authentication foundations. It does not expand
PR #640's release scope or claim that its pending release gates have passed.

## Existing foundation and gaps

The repository already contains:

- `src/packages/mobile`: Expo app with browser-approved login, secure credential
  storage, site profiles, projects, indexed sessions, native chat, drafts, and
  lifecycle/network hooks.
- `src/packages/chat-client`: headless collaborative chat, activity recovery,
  sending, guidance, interruption, and thread/configuration operations.
- `src/packages/frontend/agents`: named-agent directory, persistent workspaces,
  creation/management, organization, history, search, networks, and web embedding.
- `src/packages/frontend/chat/audio`: dictation, read-aloud playback, Markdown
  conversion, preferences, and speech RPC adapters.
- `src/packages/server/ai/chat-speech.ts`: speech capability checks, provider
  requests, cancellation, and usage reservation integration.

The native prototype currently starts with project selection and indexed chat
sessions. Replace that entry flow with the account-owned named-agent registry;
do not scan project sessions to reconstruct My Agents. The current native chat
screen starts project compute while opening a conversation. Reading and browsing
must instead preserve Agents' no-compute-start behavior; start work through the
normal execution admission path when an action needs compute.

The native Markdown renderer is rudimentary. Rich output, attachments, artifacts,
agent management, notifications, and voice are substantial work. Web creation
and workspace operations still depend on ChatActions, Redux, and editor
infrastructure; reusable behavior must be extracted rather than importing the
frontend package into native code.

The initial assessment passed mobile typecheck, 12 mobile tests, and 26
chat-client tests on the earlier checked-out base. Those are baseline evidence,
not qualification of the future app or the latest base. No new device testing
has been performed for this planning change.

## Experience and parity contract

Phone: My Agents list -> agent conversation -> artifact/detail screen, with
sheets for contextual controls and predictable back navigation. Tablet: adaptive
list/detail views where space permits. An agent's identity, conversation, draft,
scroll position, and selected artifact should survive ordinary navigation.

Before implementation, maintain a feature inventory against the actual `/agents`
UI. Record each feature's web entry point, shared operation, native destination,
acceptance scenario, and status. An incremental milestone is not full parity.

| Surface         | Native requirement                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent directory | Same registered agents, search/filtering, pins, recency, custom order, names, running/unseen state, and recovery                                                                    |
| Agent lifecycle | Create, configure, name, copy, archive/remove, close/reopen workspace, and enforce existing limits                                                                                  |
| Conversation    | Rich selectable output, streaming activity, send, interrupt, guidance, drafts, model/reasoning configuration, fresh conversations, previous conversations, and search/message links |
| Input           | Text, dictation, attachments, camera/photo/file selection, mentions, and explicit live voice                                                                                        |
| Artifacts       | Browse, preview, inspect versions, provide feedback, and preserve links to originating messages                                                                                     |
| Coordination    | Agent networks, connection requests/approvals, and relevant delivery state with existing authority semantics                                                                        |
| Context         | Project health/settings, account settings, documentation, and notifications that already live inside Agents                                                                         |
| Handoffs        | Exact project/file destinations, browser return, and incoming agent/conversation/artifact links                                                                                     |

Actions inside the web Agents experience must have an explicit mobile mapping.
In particular, the web embeds terminal and editor frames: document whether each
gets a contained web surface or a native equivalent. General file editing is not required for the initial app. File viewing and
selection-based comments are required. Terminals must work through a contained
WebView using CoCalc's existing implementation and patched xterm.js. Do not quietly
classify all hard features as project escape hatches. Specialized artifact rendering may use
a contained web renderer with native surrounding navigation and actions.

## Architecture and ownership

Keep `@cocalc/mobile` responsible for native navigation, rendering, storage,
audio/device integration, and lifecycle. Keep chat state in `@cocalc/chat-client`.
Extract agent directory/creation/organization/search orchestration into a
browser-neutral shared layer as needed; decide the precise package boundary
before adding it. Migrate corresponding web consumers so the two products do not
accumulate separate implementations of domain rules.

Shared interfaces expose plain typed data and observable state, with injected
transport, persistence, clock, and lifecycle dependencies. They must not depend
on React Native, DOM, Redux, Ant Design, or frontend globals. Avoid a wholesale
rewrite of the web chat system before delivering a vertical slice.

Follow [scalable architecture](scalable-architecture.md):

- Account home bay owns account-facing directory/organization and entitlement
  decisions; use the authoritative existing billing service for charging.
- Project owning bay owns project access and lifecycle; resolve ownership
  explicitly, including across bays and after relocation.
- Project hosts serve chat, files, artifacts, and execution traffic directly.
  Keep steady-state project data out of the hub proxy path.
- Launchpad is the one-bay case of the same implementation.
- Use existing scoped access, authentication, and admission mechanisms. Preserve
  read-only collaborator behavior and existing approval requirements.

Use bounded subscriptions and connection caches. Opening My Agents must not open
one project connection per row. Mobile must release inactive views and recover
state instead of relying on the web's indefinitely mounted hidden workspaces.

## Reliability and mobile quality

Treat the server's durable state as authoritative. Track submitted operations
through accepted, rejected, and unknown outcomes; a disconnect is not permission
to resend. Reconcile before retrying uncertain work and prevent duplicate turns.
Keep drafts separate from accepted messages, scoped by site/account/agent/thread.

Design and test cold launch, background/foreground, process death, airplane mode,
network changes, expired login, host relocation, and concurrent web edits.
Preserve readable cached state with an honest freshness indicator where useful;
offline execution queues are outside the first release unless separately designed.

Use virtualized message lists and bounded history. Preserve reading position
while streaming, avoid keyboard/composer jumps, support selection/copy, and
render code, lists, tables, links, images, and mathematical output appropriately.
Set measured budgets for launch, list load, first readable conversation, memory,
and long-chat scrolling before widening the beta; record device/network/data
sizes with each measurement instead of relying on simulator impressions.

Notifications are foundational: task completion, actionable requests, and
failures should reopen the exact agent/context. Plan server-side event delivery,
device registration/revocation, deduplication, unread convergence, and privacy
preferences. Background JavaScript is not the delivery mechanism. Recheck access
when opening a notification, including after sign-out or account changes.

Apply [accessibility guidance](accessibility.md) with native equivalents:
VoiceOver/TalkBack, dynamic text, meaningful control names/states, focus and back
behavior, non-drag alternatives, contrast, reduced motion, and light/dark themes.
Resolve semantic palette values for native rendering; do not pass CSS variables
to native controls or copy fixed web color literals as a theme system.

## Voice: two permanent modes

### Dictation and read aloud

Port the existing speech behavior through native recording/playback adapters.
Reuse speech capabilities, preferences, backend policy, and appropriate
Markdown-to-speech logic. Recorded dictation becomes an editable draft; it is
not automatically sent. Preserve the draft across interruptions and failures.
Support cancel, retry, playback pause/resume, and useful handling of code/tables.
Verify native encoding compatibility with server-supported formats and limits.

These modes remain available under their existing capability/billing rules,
including for paying users who choose not to spend on live sessions. They are
not implicitly free, and their entitlement must not be tied to live eligibility.

### Live conversation

Investigate GPT-Live-1 client delegation as a voice layer connected to the
selected existing CoCalc agent. Keep project context, harness, approvals, task
execution, and durable progress in CoCalc. Do not create a separate disposable
agent that loses the conversation's identity.

References reviewed during the discussion:

- [GPT-Live-1 announcement](https://openai.com/index/introducing-gpt-live-1-in-the-api/)
- [GPT-Live architecture and delegation](https://developers.openai.com/api/docs/guides/live)

Revalidate API events, mobile transport support, availability, and pricing at
implementation time. This is a proposed integration, not a claim of native SDK
compatibility or an already implemented bridge.

Define a shared voice-session coordinator with native and browser audio adapters.
Prototype delegation to real CoCalc execution early. Map accepted voice requests
to durable conversation operations with stable correlation identifiers; keep
partial transcripts transient. Define which finalized transcripts, spoken
answers, and delegated tasks are saved and how overlapping speech is ordered.
Avoid feeding duplicate transcripts/results back into agent context.

Keep interruption semantics distinct:

- Interrupt speech: stop or redirect spoken output while backend work continues.
- Add guidance: send the user's correction through existing guidance semantics.
- Cancel work: invoke actual agent interruption and report its outcome.
- End call: release audio/session resources without silently canceling accepted
  work; work remains visible in chat and notifications.

Acknowledge task submission only when its admission is known. Spoken summaries
must reflect actual execution results. Preserve explicit human approval controls
where the underlying action requires them; model speech is not approval.

Test headset/Bluetooth routes, speaker echo, microphone permissions, audio focus,
incoming calls, lock screen, network handoff, and reconnection on real devices.
Define supported background audio behavior explicitly; initially ending or
suspending a call must be clear to the user and bounded on the server.

### Paid access and cost control

Live voice is restricted to eligible paying customers and always opt-in per
session. Eligibility does not imply an included or unlimited allowance. Use existing membership-tier entitlements and site-admin-editable parameters for
qualification, allowances, retail pricing, and session limits. Avoid hardcoded
product decisions; initial defaults still need cost measurements.
Enforce entitlement and available budget server-side before provisioning and
throughout the session; a hidden client button is insufficient.

The suggested approximately 5x cost difference is a hypothesis, not an established
ratio. Compare representative workflows using actual live-session duration,
dictation audio, synthesized output, backend model/tool charges, and CoCalc's
billing policy. Silence, idle time, and conversation habits affect the result.
Do not publish a fixed multiplier based on unlike billing units.

Before starting live voice, show its applicable rate/budget and distinguish voice
charges from agent execution charges. Provide elapsed usage/cost visibility,
explicit end-call controls, configurable spending/session limits, and a clear
fallback to dictation/text when unavailable or declined. Never automatically
upgrade dictation into a billable live session.

Design reservation, metering, final settlement, duplicate-event handling, and
server-enforced timeout/cleanup. Account for abrupt disconnects and failed final
usage retrieval. Paid session resources must not remain open indefinitely after
the app disappears. Reuse existing billing primitives where suitable, but review
their fit for duration-based sessions rather than treating live audio as one
ordinary transcription request. Keep provider keys server-side; choose scoped
session access and media routing after validating the provider contract. Document
any necessary departure from the direct-data-plane architecture.

## Web handoffs and authentication

Use one destination resolver for agent, message, artifact, project/file, and
external URLs, preserving site base paths and account/site context. Agent links
stay native; project exits open the chosen web surface. A WebView needs explicit
session establishment; native credentials do not automatically create web cookies.
Never carry reusable credentials in URLs or assume another browser's login.

Preserve return context, draft, and artifact selection. Validate unauthenticated,
expired, wrong-account, revoked-access, and self-hosted-site cases. Retain system
browser authentication and a usable external-browser option. Inventory account
billing/settings drawers as part of parity rather than silently omitting them.

## Delivery milestones and exit evidence

1. **Inventory and native interaction specification.** Record `/agents` parity,
   map all embedded/editor surfaces, design phone/tablet navigation and voice
   controls, identify web-bound domain operations, and define performance budgets.
   Exit: reviewable screen flows and acceptance matrix with explicit gaps.
2. **Agent-first native vertical slice.** Login -> named agents -> create/open
   agent -> durable chat, rich output, attach photo/file, interrupt/guidance,
   switch agents, and resume. Extract shared behavior as required. Exit: same
   agent/conversation visible on desktop, no compute start for reads, no duplicate
   sends under disconnect, device evidence for keyboard/scroll/recovery.
3. **Voice feasibility in parallel with the early product work.** Preserve
   dictation/read-aloud and prototype live delegation to a real agent behind a
   development capability. Exit: start work by voice, converse while it runs,
   interrupt speech independently, hear its result, and inspect correct durable
   chat state. Demonstrate paid-access rejection and bounded session cleanup
   before enabling live voice for customers. This milestone must not wait for
   every parity screen to be complete.
4. **Results, notifications, and complete everyday workflow.** Artifact previews,
   versions/feedback, exact links, notifications, and reliable return from web
   destinations. Exit: the phone workflow below works through backgrounding and
   process restart, including an accepted task outliving its voice call.
5. **Parity and product hardening.** Finish management, history/search, networks,
   approvals, settings/context, embedded surfaces, and accessible native polish.
   Exit: every inventory item passes or has a clearly approved release deferral;
   physical-device and cross-bay matrix passes. Do not label a subset full parity.
6. **Distribution and staged release.** Internal builds -> physical-device beta
   -> TestFlight/store readiness, with supported Android validation scheduled
   explicitly. Qualify entitlements/metering, push delivery, compatibility,
   rollout controls, rollback, and operational support before broad release.

Canonical workflow, exercised in both ordinary and live voice variants:

> Open an agent -> speak a request -> attach a photo -> submit -> put the phone
> away -> receive a notification -> inspect or hear the result -> speak a follow-up.

Initial focus is iPhone/iPad, with shared code kept Android-compatible. Android
support is not claimed until device validation and distribution qualification.
Do not impose calendar estimates before measuring the two highest-risk slices:
shared agent orchestration and native live audio/delegation.

## Updates, compatibility, and release qualification

Expo's update workflow is a reason to retain the stack. Plan separate development,
beta, and production channels with runtime compatibility, staged rollout, and
rollback. Do not promise all changes via OTA: new native dependencies, audio
capabilities/permissions, or other native-runtime changes require a compatible
native build. Validate the exact Expo update mechanism and current store rules
before distribution. Release configuration/signing is not implemented here.

Negotiate server capabilities for named agents, history/search, artifacts, and
each speech mode. Unsupported servers should give clear capability-specific
messages while retaining working features. Test mixed client/server versions and
base paths; never silently fall back to the old project-first product.

Use focused shared-domain/contract tests for extraction; native interaction tests
for navigation, composer, accessible controls, and recovery; provider-fake tests
for voice admission, delegation, metering, and interrupted sessions; then actual
provider/device smoke tests. Web consumers changed by extraction require frontend
lint, typecheck, and focused accessibility/regression coverage.

The acceptance matrix must include light/dark, large text, long conversations,
attachments, artifact feedback, expired auth, concurrent desktop use, read-only
collaboration, same-bay/cross-bay routing, host changes, speech-disabled accounts,
non-paying live rejection, paying users choosing dictation, and budget exhaustion.
Record exact build/server revisions and devices. Logs/telemetry should capture
latency, reconnects, uncertain submissions, crashes, and usage reconciliation
without recording credentials or private conversation/audio by default.

## Product decisions recorded after review

- Use existing admin-editable membership entitlements and configurable pricing,
  allowances, and live-session limits. Keep both speech modes permanently.
- Finalized voice conversation belongs in the same agent chat by default. The
  treatment of partial transcripts and duplicate task/result context remains an
  implementation design task.
- General file editing is outside the initial scope. Viewing and selection-based
  commenting matter; working terminals through the existing patched xterm.js in
  a WebView are required.
- The maintainer can test an iPhone 17 Pro and has an Apple developer account.
  Ask for device/signing actions when a concrete build is ready to test.
- No Android phone is available presently. An emulator is possible; an older
  Chromebook may help later. Do not claim Android device qualification.
- Push infrastructure, audio transport, web session handoff, shared package
  boundaries, and performance budgets are engineering choices to investigate.
  They do not block beginning substantial implementation.

## Remaining engineering decisions

- Native live transport/audio package, session owner, and provider lifecycle;
  physical-device proof precedes committing to the integration.
- Transcript reconciliation and agent-context policy for continuous conversation.
- Initial artifact renderers and selection/comment anchor representation.
- Push infrastructure, privacy defaults, and native permission timing.
- WebView session handoff, incoming app links, and return navigation contract.
- Further shared operations to extract beyond agent organization and discovery.
- Measured performance budgets and store/update rollout qualification.

These are bounded design tasks in the milestones, not reasons to recreate the
prototype's narrower product or drop the less expensive speech modes.
