# Codex Attention and Completion Notifications Plan

Date: 2026-09-01

Status: proposed implementation plan; no implementation is included in this
change.

## Goals

CoCalc should reliably tell an account when a Codex thread needs human input or
finishes long-running work. The design must support requests that block the
current turn and requests that let Codex continue independent work. It should
also replace the fragile per-thread completion toggle with an account-level
default that users can override deliberately.

The initial implementation should provide:

- native browser notifications when a CoCalc tab is open but hidden;
- durable in-app attention and completion notices;
- an inline response UI for Codex `request_user_input` requests;
- an account-level default that notifies on every Codex completion unless the
  user is directly watching that thread;
- independent in-app, toast, browser, and email controls instead of a single
  mode that conflates channels;
- bounded escalation for unresolved attention requests;
- durable, multibay-safe state that survives browser reloads, ACP worker
  restarts, project-host preemption, and hub restarts.

This plan builds on the existing notification event, home-bay projection,
email outbox, and Codex completion-notice infrastructure. It does not create a
second notification system.

## Decisions

### Capability discovery does not depend on a skill

CoCalc must enable Codex's request-input tool through the app-server thread
configuration and implement the corresponding server request. The checked-out
upstream Codex app-server supports the experimental
`item/tool/requestUserInput` request and the thread configuration override
`features.default_mode_request_user_input=true`. Requests include required
`isBlocking` state, and app-server emits `serverRequest/resolved` when a request
is answered or cleared by turn lifecycle.

The model knows that the feature is available because Codex registers the
`request_user_input` tool in the model's tool schema. A CoCalc skill is not an
appropriate capability-negotiation mechanism: skills are optional context,
may not be loaded, and can be project-controlled. CoCalc should nevertheless
add short first-party runtime guidance after the tool works:

- use `request_user_input` when a human action or answer is genuinely needed;
- for nonblocking requests, ask once and continue independent work;
- do not wait unnecessarily after making a nonblocking request;
- never ask the user to paste passwords, access tokens, one-time codes, or
  other secrets into the response form.

This guidance belongs in CoCalc's trusted Codex runtime instructions, not in a
project skill. A documentation skill may mention the feature later, but the
feature must work without it.

Official public OpenAI documentation searches did not return documentation for
this experimental request. Protocol details in this plan come from the current
checked-out upstream Codex source and app-server README and must be rechecked
against the Codex version bundled for release.

### Blocking is independent of notification urgency

Preserve app-server's `isBlocking` value exactly:

- A blocking request pauses the current turn until it is answered, declined,
  canceled, or cleared by app-server lifecycle.
- A nonblocking request creates the same durable attention item, but Codex can
  continue unrelated work while the request remains pending.

Both states require user-visible attention. `isBlocking` controls turn
behavior; it does not decide whether a notification is delivered.

### Use one Codex category with separate delivery dimensions

The existing `ai` preference category already classifies Codex completion
notices. Keep that stable storage key for migration and relabel it **Codex and
agents**. Do not add a competing `codex` key unless non-Codex AI traffic later
requires a distinct category.

Replace the category's combined delivery dropdown with separate, accessible
controls for:

- durable in-app inbox;
- in-app toast;
- native browser notification;
- email delivery strategy.

Attention and completion have different urgency, so each channel can have a
separate setting for those two event classes. Email strategy should express
behavior such as **email only if attention remains unresolved for 5 minutes**,
rather than embedding in-app behavior in labels such as “email and in-app.”

### Completion notification is an account preference, not a thread default

The account default for Codex turn completion should be enabled. Replace
`notifyOnTurnFinish?: boolean` semantics with a per-thread tri-state override:

- `inherit` uses the account default;
- `on` always creates a completion notification;
- `off` suppresses it for that thread.

Existing explicit true and false values remain explicit overrides. Missing
values migrate to `inherit`, which uses the new enabled account default. The UI
must label account and thread scope clearly so changing threads cannot look
like a preference was mysteriously reset.

Always create the durable completion event when effective notification is on.
Whether to show an intrusive toast, native notification, or email is a
delivery decision made later. “Directly watching” suppresses those intrusive
deliveries, not the durable event.

Define directly watching as all of the following at delivery time:

- the document is visible and focused;
- the relevant project and chat file are foregrounded;
- the relevant Codex thread is selected;
- the user has interacted with that page recently enough to rule out an idle
  foreground window.

If any condition is false, the user is not directly watching.

## Current State and Gaps

- `src/packages/ai/acp/codex-app-server.ts` enables app-server experimental
  APIs but does not enable default-mode `request_user_input` in thread config.
- `src/packages/project-host/codex/codex-project.ts` handles ChatGPT token
  refresh and rejects all other app-server server requests.
- Codex completion already creates a durable `account_notice` with
  `notice_type=codex_turn_completion`, a stable source ID, and a deep link.
- Completion creation currently depends on the per-thread
  `notifyOnTurnFinish` boolean and defaults to false.
- The frontend already deduplicates completion toasts across tabs with shared
  account DKV state, but only shows them while the document is visible.
- `accounts.other_settings.notification_preferences` stores one combined
  `immediate | digest | off | none` value per category. The value combines
  email and in-app policy that should be independent.
- A service worker is registered for the installed web app, but its install,
  activate, and fetch handlers are empty. There is no Notification API, Push
  API, or service-worker notification implementation.
- Lite mode cannot currently create server-backed Codex turn notices.

## Product Model

### Attention request types

Use one durable attention model with a constrained `attention_kind` enum:

- `question`: app-server `request_user_input` questions;
- `fresh_auth`: CoCalc fresh-auth approval is required;
- `external_login`: an external provider such as Google Cloud requires login;
- `approval`: a supported explicit approval flow;
- `manual_action`: a user must perform or verify an external action;
- `manual_test`: a release or workflow needs human sign-off.

Do not infer attention merely because an agent is quiet or a terminal process
is still running. Prefer structured app-server requests and structured CoCalc
CLI events. Pattern detection of selected CLI output can be a later fallback,
but it must never turn arbitrary terminal output into a trusted action link.

### Durable request state

Represent attention as a durable source record plus the existing notification
event and home-bay inbox projection. The source record needs:

- account, project, path, thread, turn, app-server request, and tool call IDs;
- `attention_kind`, `is_blocking`, safe title, and safe summary;
- bounded structured questions and options;
- state: `pending`, `seen`, `answered`, `declined`, `canceled`, `resolved`,
  `expired`, or `superseded`;
- creation, update, resolution, and optional expiration timestamps;
- response version/idempotency token;
- delivery/escalation timestamps.

`seen` must not resolve a request. An answer transition must be atomic and
idempotent so two browser tabs cannot answer twice. The response must route to
the exact live app-server request. `serverRequest/resolved` is authoritative
for clearing a request whose turn lifecycle ended.

If the runtime disappears before an answer is delivered, mark the app-server
request stale rather than pretending it was answered. Preserve the human
answer as an auditable response and offer a deliberate **continue with this
answer** action that starts or resumes the thread through the normal durable
ACP recovery path.

### User experience

Render pending attention in four coordinated surfaces:

1. An inline card in the Codex thread with accessible question controls,
   answer/decline actions, blocking state, and resolution status.
2. A global **Needs attention** count and filter in the notification UI.
3. Project, chat, and thread indicators that deep-link to the inline card.
4. Toast, browser, and optional email delivery according to account policy.

Nonblocking cards must say that Codex may continue while waiting. Blocking
cards must say that the current turn is paused. Important asynchronous changes
must use a polite live region; errors use an alert. Do not steal focus when a
request arrives. Opening a notification should focus the card, and completing
or dismissing a dialog must restore focus. All controls require keyboard
operation, visible focus, accessible names, 200% zoom support, and 320-CSS-pixel
reflow.

## Delivery Policy

### Recommended defaults

| Event | Inbox | Toast | Browser | Email |
| :-- | :-- | :-- | :-- | :-- |
| Needs attention | On | On when not directly watching | On when hidden and permitted | After 5 minutes unresolved |
| Turn completed | On | On when not directly watching | On when hidden and permitted | Off |
| Turn failed after recovery is exhausted | On | On when not directly watching | On when hidden and permitted | After 5 minutes unread |

These are account defaults. Sites without email or native notification support
degrade to inbox and toast without blocking Codex.

### Escalation and deduplication

- Create one logical notification per stable attention request or completed
  turn.
- Deliver the first inbox event immediately.
- If not directly watching, show at most one toast or native notification per
  account across all open tabs.
- Before sending delayed email, re-read authoritative request and read state;
  skip if resolved, seen under an account policy that treats seen as enough,
  or superseded.
- Permit at most one delayed email and one optional reminder per request. A
  suggested reminder delay is 30 minutes; stop after that.
- Apply per-account and per-origin rate limits. Coalesce bursts from the same
  project/thread into one browser notification while preserving individual
  inbox items.
- A completion that follows a pending nonblocking request does not invent a
  second attention request. Respect app-server resolution semantics and render
  the resulting final state.

### Native browser notifications

Phase 1 must use the Web Notifications API while at least one authenticated
CoCalc tab is open:

- request permission only from an explicit click in Communication settings;
- explain browser and operating-system permission state before prompting;
- show native notifications only when the relevant thread is not directly
  watched, normally when the selected delivery-leader tab is hidden;
- elect one tab per account as delivery leader and deduplicate by notification
  ID using BroadcastChannel plus the existing shared account DKV pattern;
- clicking a notification focuses an existing CoCalc tab where possible and
  opens the authenticated project/chat/thread deep link;
- close or replace stale notifications when the request resolves;
- provide a test-notification button and a clear disabled/denied state.

Phase 2 may add true Web Push when all CoCalc tabs are closed. It requires a
service-worker `push`/`notificationclick` implementation, Push API subscription
storage, key rotation, subscription revocation, per-account device management,
and a separate security/privacy review. Do not claim browser-closed delivery
in Phase 1.

Native notification contents must be privacy-minimal: **Codex needs your
attention** or **Codex finished**, a user-chosen project/thread label if safe,
and no prompt text, terminal output, customer data, authorization URL,
one-time code, token, or model-generated link. The authenticated page renders
the details after navigation.

## Protocol and Routing

### App-server bridge

1. Add `features.default_mode_request_user_input=true` to every compatible
   thread start/resume/fork path, preserving any existing thread config.
2. Handle `item/tool/requestUserInput` in the project-host app-server request
   bridge and retain the JSON-RPC responder until resolution.
3. Validate protocol shape, question count, lengths, IDs, duplicate IDs,
   options, and secret flags before persisting or rendering anything.
4. Publish the durable attention source event before exposing the pending
   request to browser clients.
5. Route one validated answer back to the held responder, then wait for
   `serverRequest/resolved` to finalize lifecycle state.
6. Treat unknown server requests as unsupported without weakening current
   token-refresh behavior.
7. Version-gate the feature against the bundled Codex app-server. If support is
   absent, omit the thread override and continue without attention requests.

Plan-mode requests remain blocking according to upstream behavior. Default
mode requests are expected to be nonblocking when the feature is enabled, but
CoCalc must consume the wire `isBlocking` value rather than infer it from mode.

### Structured CoCalc actions

After generic request input works, connect existing structured workflows:

- fresh-auth approval URL and request ID from the CoCalc CLI;
- VM/operator approval requests already rendered in Codex chat;
- explicit external-login/manual-test requests emitted by first-party tooling.

The agent should be able to publish a nonblocking attention request and then
continue other work. A tool request that only asks a question must not silently
grant fresh auth or perform the privileged action; existing authenticated and
fresh-auth boundaries remain authoritative.

### Multibay ownership

- The project owning bay and ACP worker are authoritative for the request and
  response lifecycle.
- The target account home bay is authoritative for inbox projection,
  preferences, email scheduling, and browser delivery state.
- Route source events through the existing notification outbox/projection
  architecture; do not assume the local bay owns the account.
- Route answers from the home bay to the owning bay and then to the exact
  project-host ACP request with explicit project ownership lookup.
- Project/host credentials may create attention only for the account bound to
  the ACP session and project. They may not choose arbitrary recipients.
- Rehome and account-home-bay changes must transfer or reconcile pending
  records without duplicate delivery or lost answers.

Lite mode should render request input and use local toast/native notification
delivery. It may omit durable cross-device inbox and email until Lite has an
account notification service, but it must label that limitation and preserve
the local answer lifecycle.

## Preference Schema and Migration

Introduce a versioned preference schema that separates channels. The exact
storage shape can evolve during implementation, but it must represent these
dimensions independently:

- inbox enabled;
- toast enabled;
- browser notification enabled;
- email strategy (`off`, `immediate`, `digest`, or `unresolved_after_delay`);
- event class (`attention`, `completion`, `terminal_failure`);
- completion default enabled;
- optional escalation delay within site-defined safe bounds.

Migration requirements:

- preserve existing category email intent from `immediate`, `digest`, `off`,
  and `none`;
- never turn old `none` into email delivery;
- keep required security/billing policy unrelated to Codex unchanged;
- relabel stable category key `ai` without losing saved preferences;
- migrate missing per-thread completion booleans to `inherit`;
- preserve explicit per-thread true/false as `on`/`off`;
- make the account completion default enabled for both existing and new
  accounts, while allowing immediate opt-out;
- support rollback readers for the previous preference version during a
  mixed static/hub deployment.

The Communication settings UI should use a compact matrix of switches or
checkboxes with row and column labels, not a dropdown containing every channel
combination. Email timing can use a separate radio/segmented strategy control
because those choices are mutually exclusive. Browser permission state and
the CoCalc preference must remain visibly separate.

## Security, Privacy, and Abuse Requirements

- Only the authenticated target account can read or answer an attention
  request.
- Recheck project collaboration and ACP-session ownership when opening the
  target and when answering. Do not rely only on permissions captured when the
  notice was created.
- Never persist or deliver secret answers through the notification summary or
  email. For upstream questions marked secret, either provide a dedicated
  non-persisted response path with explicit review or reject them initially.
- Treat all model-provided labels and question text as untrusted: bound,
  sanitize, render as text/Markdown through the standard sanitizer, and never
  accept arbitrary notification action URLs.
- Build action links server-side from project/path/thread identifiers.
- Limit questions, options, text lengths, pending requests per turn/project,
  request creation rate, and reminders.
- Only root-thread requests are expected from Codex; reject or safely group
  unexpected subagent fanout.
- Do not let a project use notifications as an arbitrary cross-account email
  primitive. Charge external delivery to the responsible account and apply
  existing notification email abuse limits.
- Record request creation, delivery, answer actor/time, resolution reason, and
  failures without recording secrets.
- Do not expose project names, paths, prompt excerpts, customer PII, or action
  URLs on an operating-system lock screen by default.
- Browser permission denial must be nonfatal and must not trigger repeated
  permission prompts.

## Implementation Waves

### Wave 0: confirm protocol and fix completion semantics

- Pin the supported bundled Codex version and add protocol fixtures for
  request input and `serverRequest/resolved`.
- Audit every path that reads or writes `notifyOnTurnFinish`, including new
  thread, fork, restore, rename/behavior save, account reconnect, SyncDB
  conflict, and other Codex config edits.
- Add account completion default and tri-state thread override.
- Prove that no unrelated config update drops a thread override.
- Keep current completion notice creation and toast behavior working during
  mixed-version rollout.

### Wave 1: durable request input and inline UI

- Enable the app-server feature behind a CoCalc site flag.
- Implement validated server-request handling and durable request state.
- Add multibay event projection and answer routing.
- Render accessible blocking and nonblocking inline cards.
- Add global/project/thread attention indicators and resolution handling.
- Add trusted runtime guidance only after end-to-end handling is available.

### Wave 2: independent preferences and browser delivery

- Migrate notification preferences to independent channel dimensions.
- Relabel `ai` as **Codex and agents**.
- Add explicit Notification API permission/setup/test UI.
- Implement cross-tab leader election, native delivery, click routing,
  resolution cleanup, and direct-watching suppression.
- Add local Lite delivery.

### Wave 3: escalation and structured operator actions

- Add unresolved-attention email scheduling with cancellation checks.
- Add bounded reminder, coalescing, observability, and abuse limits.
- Integrate fresh-auth, VM approval, external login, and manual sign-off events
  from first-party tooling.
- Measure time-to-seen, time-to-answer, skipped deliveries, permission state,
  duplicates, and escalation outcomes.

### Wave 4: optional Web Push

- Perform a service-worker and push privacy/security design review.
- Add device subscriptions, revocation, key rotation, push payload minimization,
  and browser-closed delivery if the operational benefit justifies it.

## Validation Matrix

### Protocol and recovery

- Default-mode nonblocking request while Codex continues and completes other
  work.
- Plan-mode blocking request that resumes after answer.
- Answer, decline, cancel, app-server lifecycle cleanup, timeout, and duplicate
  answer races.
- Browser reload, hub restart, ACP worker restart, project-host preemption,
  project restart, and stale app-server responder.
- Turn completion/interruption before an answer and receipt of
  `serverRequest/resolved`.
- Thread fork/resume and legacy Codex versions without request-input support.

### Preferences and delivery

- Existing preference migration for every old mode.
- Account completion default on, explicit opt-out, and per-thread
  inherit/on/off.
- New thread, forked thread, restored thread, thread switch, and concurrent
  browser edits never reset the effective preference.
- Directly watched, visible-but-different-thread, hidden-tab, unfocused window,
  idle foreground, and multiple-tab cases.
- Browser permission default, granted, denied, revoked, and unsupported.
- Exactly one toast/native notification across multiple tabs and sessions.
- Email canceled when answered before delay, bounded reminder, and rate-limit
  behavior.

### Security and multibay

- Project-authenticated request cannot target a different account or project.
- Removed collaborator cannot open or answer a stale request.
- Source project and account home on different bays; project rehome and account
  home-bay change while pending.
- Host/ACP spoofing, duplicate IDs, oversized questions/options, hostile
  Markdown/HTML/URLs, secret fields, notification flood, and replayed answers.
- Native lock-screen text contains no sensitive details.

### Accessibility and browser behavior

- Controls queried by role/name, keyboard-only response, focus management,
  live-region behavior, screen reader labels, 200% zoom, 320-pixel reflow, and
  light/dark theme contrast.
- Native notification click focuses and routes correctly without creating
  duplicate CoCalc tabs where avoidable.

Run focused package tests, package typechecks, `pnpm -C src lint:frontend`, and
the relevant browser accessibility scenario for each implementation wave.

## Rollout and Rollback

1. Deploy schema and hub readers that understand old and new preferences.
2. Deploy project-host request handling with the app-server feature flag off.
3. Deploy static UI and enable completion-default migration first.
4. Enable request input for internal accounts on staging, then a production
   canary account.
5. Validate blocking/nonblocking lifecycle and preemption recovery before broad
   enablement.
6. Enable native browser delivery separately from email escalation.
7. Enable delayed email only after duplicate/rate-limit metrics are clean.

Rollback must be able to disable app-server request input and each external
delivery channel independently. Disabling the feature must not delete pending
or historical attention records. Older static clients should continue to see a
generic durable notification and deep link even if they cannot render the
inline response card.

## Completion Criteria

The project is complete when:

- Codex can issue both blocking and nonblocking input requests without an
  unsupported app-server error;
- a pending request survives normal CoCalc control-plane and project-host
  interruptions without being silently lost or falsely answered;
- the user receives one prompt notification through enabled channels when not
  directly watching;
- account-wide completion notification defaults on and no longer appears to
  reset while switching or creating threads;
- communication settings expose independent channels and explicit escalation
  policy;
- native browser notifications work after explicit permission with privacy-safe
  contents and cross-tab deduplication;
- multibay authorization, security/abuse tests, accessibility checks, and live
  canary tests pass.
