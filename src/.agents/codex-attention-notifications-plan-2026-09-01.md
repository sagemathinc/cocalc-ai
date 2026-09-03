# Codex Attention and Completion Notifications Plan

Date: 2026-09-01

Revised: 2026-09-02 after review against upstream Codex main commit
`5a0419edb5ad720ae31fa1adf8b3b24c8f0c52c5`.

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
- inline response UI for synchronous Codex `request_user_input` requests and
  asynchronous Codex question messages;
- a first-party, typed attention action for CoCalc fresh-auth requirements;
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

CoCalc must consume the input mechanisms exposed by the bundled Codex
app-server instead of teaching the model about a CoCalc-only imitation. The
upstream checkout reviewed on 2026-09-02 supports two distinct question flows:

1. `item/tool/requestUserInput` is an experimental server-initiated JSON-RPC
   request. It carries required `isBlocking` state, expects a response on the
   exact held responder, and emits `serverRequest/resolved` when answered or
   cleared by turn lifecycle. In Default mode it is gated by the thread
   override `features.default_mode_request_user_input=true`.
2. `request_user_input_async` emits a completed agent-message item with
   `delivery="async"` and structured `questions`. The tool returns immediately;
   a later answer is a new normal user message, not a response to a held
   JSON-RPC request. Availability is model/catalog dependent and must be
   discovered from emitted protocol data rather than assumed.

These are separate protocol adapters into one CoCalc attention model. Do not
represent an asynchronous message as a pending app-server request, and do not
route its answer through `serverRequest/resolved`.

Current upstream Default-mode guidance may emit an ordinary final assistant
message when explicit non-permission input is required instead of using the
synchronous question tool. Do not guess that arbitrary prose or a trailing
question mark is a structured attention request. That case receives the normal
durable completion notification and deep link. Only an explicit synchronous
request, asynchronous structured question item, or trusted CoCalc action gets
pending **Needs attention** state.

The model knows these features are available because Codex registers their
tools in the model's tool schema. A CoCalc skill is not an appropriate
capability-negotiation mechanism: skills are optional context, may not be
loaded, and can be project-controlled. CoCalc should nevertheless add short
first-party runtime guidance after each end-to-end path works:

- follow the bundled Codex guidance for synchronous and asynchronous questions;
- use asynchronous questions only when useful authorized work can continue;
- do not use either question tool for permission or authentication escalation;
- use typed first-party CoCalc actions for fresh auth, external login, and
  supported approvals;
- never ask the user to paste passwords, access tokens, one-time codes, or
  other secrets into a question response.

This guidance belongs in CoCalc's trusted Codex runtime instructions, not in a
project skill. A documentation skill may mention the feature later, but the
feature must work without it.

Official public OpenAI documentation searches did not return documentation for
these experimental details. Protocol details in this plan come from the current
checked-out upstream Codex source and app-server README and must be rechecked
against the Codex version bundled for release. Generate or validate fixtures
from that bundled binary during the release build; do not maintain a
handwritten approximation of an experimental schema.

### Blocking is independent of notification urgency

Preserve app-server's `isBlocking` value exactly:

- A blocking request pauses the current turn until it is answered, declined,
  canceled, or cleared by app-server lifecycle.
- A nonblocking request creates the same durable attention item, but Codex can
  continue unrelated work while the request remains pending.

Both states require user-visible attention. `isBlocking` controls turn
behavior; it does not decide whether a notification is delivered. An
asynchronous question has no held responder and therefore uses a distinct
answer lifecycle even though it appears in the same attention UI.

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

The account default for Codex turn completion should be enabled. Replace the
unreliable legacy `notifyOnTurnFinish?: boolean` behavior with a new, separately
named per-thread tri-state override:

- `inherit` uses the account default;
- `on` always creates a completion notification;
- `off` suppresses it for that thread.

The legacy boolean has no provenance: current clients frequently materialize
`false` even when the user never opted out. Migration is therefore deliberately
asymmetric:

- legacy `true` becomes `on`;
- legacy `false` becomes `inherit`;
- a missing value becomes `inherit`.

Only the new tri-state field can represent an explicit `off`. New clients must
stop writing the legacy boolean. During mixed-version deployment, old clients
must not be allowed to overwrite the new field through an unrelated config
save. Persist the new thread override in a dedicated metadata field/row that
legacy ACP config writers do not replace; do not put the only authoritative
copy into an object that an old client rewrites wholesale. After the
compatibility window, remove the old toggle and field.

The UI must label account and thread scope clearly so changing threads cannot
look like a preference was mysteriously reset. The ordinary per-thread action
should read **Mute completion notifications for this thread**, not present an
ambiguous checkbox that appears to reset.

Always create the durable completion source event when effective notification
is on. Whether to show an intrusive toast, native notification, or email is a
delivery decision made later. “Directly watching” suppresses those intrusive
deliveries, not the source event. The inbox projection should coalesce repeated
completions by thread and avoid incrementing unread state for a completion the
account directly watched; event history remains available for audit and
recovery.

Define directly watching as all of the following at delivery time:

- the document is visible and focused;
- the relevant project and chat file are foregrounded;
- the relevant Codex thread is selected;
- the user has interacted with that page recently enough to rule out an idle
  foreground window.

If any condition is false, the user is not directly watching.

Watching state is a best-effort, expiring presence lease. It may suppress only
ephemeral delivery or mark a projected completion read; it must never suppress
creation of the durable source event. A stale lease must expire quickly so an
abandoned foreground tab cannot suppress later notifications or delayed email
indefinitely.

## Current State and Gaps

- `src/packages/ai/acp/codex-app-server.ts` enables app-server experimental
  APIs but does not enable default-mode `request_user_input` in thread config.
- `src/packages/project-host/codex/codex-project.ts` handles ChatGPT token
  refresh and rejects all other app-server server requests.
- Current CoCalc Codex item handling does not explicitly consume asynchronous
  agent-message `delivery` and structured `questions` as an attention request.
- Codex completion already creates a durable `account_notice` with
  `notice_type=codex_turn_completion`, a stable source ID, and a deep link.
- Completion creation currently depends on the per-thread
  `notifyOnTurnFinish` boolean and defaults to false. Multiple frontend and
  chat-client paths serialize absent/default state as literal false, so it
  cannot be treated as evidence of an explicit opt-out.
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

- `question`: synchronous app-server questions or asynchronous structured
  Codex question messages;
- `fresh_auth`: CoCalc fresh-auth approval is required;
- `external_login`: an external provider such as Google Cloud requires login;
- `approval`: a supported explicit approval flow;
- `manual_action`: a user must perform or verify an external action;
- `manual_test`: a release or workflow needs human sign-off.

Do not infer attention merely because an agent is quiet or a terminal process
is still running. Prefer structured app-server requests and structured CoCalc
CLI events. Pattern detection of selected CLI output can be a later fallback,
but it must never turn arbitrary terminal output into a trusted action link.

Store an independent `source_kind` so response routing is unambiguous:

- `codex_sync_question`: exact held app-server JSON-RPC request;
- `codex_async_question`: structured asynchronous agent-message item;
- `cocalc_action`: typed event from trusted first-party CoCalc code.

`attention_kind` controls presentation and policy. `source_kind` controls who
is authoritative and how an answer or completed action returns to the thread.

### Durable request state

Represent attention as a durable source record plus the existing notification
event and home-bay inbox projection. The source record needs:

- account, project, path, thread, and turn IDs plus source-specific identifiers:
  app-server request/tool IDs for synchronous questions, item ID for
  asynchronous questions, or an opaque server-owned action reference;
- `source_kind`, `attention_kind`, `is_blocking`, safe title, and safe summary;
- bounded structured questions and options;
- lifecycle state: `pending`, `answered`, `declined`, `canceled`, `resolved`,
  `expired`, `superseded`, or `stale`;
- creation, update, resolution, and optional expiration timestamps;
- response version/idempotency token;
- delivery/escalation timestamps;
- separate `seen_at`, `acknowledged_at`, and optional `snoozed_until` delivery
  state, none of which resolves the underlying request.

An answer transition must be atomic and idempotent so two browser tabs cannot
answer twice. Response behavior depends on `source_kind`:

- A synchronous answer routes to the exact live app-server request. Keep the
  record pending until `serverRequest/resolved`, which is authoritative for
  answer completion or lifecycle cleanup.
- An asynchronous answer is submitted as a new normal user message associated
  with the originating thread and question item. It never uses an old JSON-RPC
  responder. Mark it answered only after the durable message submit is
  acknowledged.
- A CoCalc action invokes its server-owned typed handler. The authoritative
  workflow result, not a model response or button click alone, resolves it.

Required lifecycle transitions are:

| Source                | Successful response                                                                                                                  | Lifecycle cleanup                                                                               | Runtime loss                                                                                                    |
| :-------------------- | :----------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| Synchronous question  | Store an idempotent submitted response, answer the held responder, then transition to `answered` only after `serverRequest/resolved` | Transition to `canceled`, `expired`, `superseded`, or generic `resolved` with a recorded reason | Transition to `stale`; never claim the old turn resumed                                                         |
| Asynchronous question | Submit one normal user message, then transition to `answered` after durable acknowledgement                                          | Transition to `superseded` or `canceled` according to explicit thread/item lifecycle            | Keep the durable question pending if the thread can still accept a new message; otherwise transition to `stale` |
| CoCalc action         | Invoke the typed handler, then transition to `resolved` only after its authoritative success result                                  | Transition according to the owning workflow's explicit cancel/expiry result                     | Re-resolve the server-owned action reference; stale project runtime alone must not fabricate success or failure |

If the runtime disappears before an answer is delivered, mark the app-server
request stale rather than pretending it was answered. Preserve the human
answer as an auditable response and offer a deliberate **continue with this
answer** action that starts or resumes the thread through the normal durable
ACP recovery path. That action creates a new ordinary user turn containing the
answer and a safe reference to the stale question; it does not attempt to
answer a dead JSON-RPC responder. The durability guarantee covers the attention
record and human answer, not indefinite survival of the original blocked Codex
turn.

### User experience

Render pending attention in four coordinated surfaces:

1. An inline card in the Codex thread with accessible question controls,
   answer/decline actions, blocking state, and resolution status.
2. A global **Needs attention** count and filter in the notification UI.
3. Project, chat, and thread indicators that deep-link to the inline card.
4. Toast, browser, and optional email delivery according to account policy.

The durable inbox/card, not a transient toast, is the primary record. An
authenticated completion row should show the project/thread label, success or
failure, completion time, elapsed time when available, and a bounded sanitized
summary of the final agent message when the browser can fetch that detail
directly from the owning project data plane. Do not copy the final message into
the account home-bay projection merely to enrich the row. It must always
deep-link to the exact thread. A pending attention toast must remain until the
user acts or dismisses it; ordinary completion toasts may expire because the
detailed durable row remains available.

Asynchronous question cards must say that Codex may continue while waiting and
that a reply starts a new user message. Blocking cards must say that the current
turn is paused. Trusted action cards must identify the CoCalc action and never
present a model-provided URL as authoritative. Important asynchronous changes
must use a polite live region; errors use an alert. Do not steal focus when a
request arrives. Opening a notification should focus the card, and completing
or dismissing a dialog must restore focus. All controls require keyboard
operation, visible focus, accessible names, 200% zoom support, and
320-CSS-pixel reflow.

## Delivery Policy

### Recommended defaults

| Event                                   | Inbox | Toast                         | Browser                      | Email                      |
| :-------------------------------------- | :---- | :---------------------------- | :--------------------------- | :------------------------- |
| Needs attention                         | On    | On when not directly watching | On when hidden and permitted | After 5 minutes unresolved |
| Turn completed                          | On    | On when not directly watching | On when hidden and permitted | Off                        |
| Turn failed after recovery is exhausted | On    | On when not directly watching | On when hidden and permitted | After 5 minutes unread     |

These are account defaults. Sites without email or native notification support
degrade to inbox and toast without blocking Codex.

### Escalation and deduplication

- Create one logical notification per stable attention request or completed
  turn.
- Deliver the first inbox event immediately.
- Preserve every completion source event, but coalesce the account-facing inbox
  projection by thread so repeated turns update one thread row rather than
  flooding unread notifications. Keep the latest completion time, unread
  count, failure/attention priority, and deep link.
- If not directly watching, show at most one toast or native notification per
  account across all open tabs.
- Before sending delayed email, re-read authoritative request and read state;
  skip if resolved, superseded, or explicitly acknowledged under an account
  policy that treats acknowledgement as enough. Mere `seen_at` does not cancel
  escalation. A deliberate snooze delays delivery until `snoozed_until`.
- Permit at most one delayed email and one optional reminder per request. A
  suggested reminder delay is 30 minutes; stop after that.
- Apply per-account and per-origin rate limits. Coalesce bursts from the same
  project/thread into one browser notification while preserving source-event
  history and the coalesced inbox projection.
- A completion that follows a pending asynchronous question does not resolve or
  replace that question. The thread projection prioritizes unresolved attention
  over ordinary completion while preserving both source events.

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

### Synchronous app-server questions

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

### Asynchronous Codex questions

1. Detect completed agent-message items with `delivery="async"` and bounded,
   structured `questions`.
2. Preserve the message/item/turn/thread IDs as the stable source identity and
   project it into the same attention UI without creating a fake app-server
   request ID.
3. Render suggested options plus free text. Do not imply the default option was
   submitted merely because upstream preselected it visually.
4. Submit the answer through the normal durable ACP user-message path with an
   idempotency key tied to the question item.
5. Mark answered only after message acknowledgement. Handle duplicate tabs,
   a superseding user message, thread deletion, and stale/restarted runtimes
   without attempting `serverRequest/resolved`.
6. Consume this item shape whenever the bundled Codex emits it, but do not
   assume every model/catalog exposes the asynchronous tool.

### Structured CoCalc actions

Structured CoCalc actions are not Codex questions. They originate in trusted
first-party services and contain a server-generated action reference, never an
arbitrary action URL supplied by the model. Implement a minimal fresh-auth
action in the first end-to-end release, then connect additional workflows:

- fresh-auth challenge/action reference from the CoCalc CLI or control plane;
- VM/operator approval requests already rendered in Codex chat;
- explicit external-login/manual-test requests emitted by first-party tooling.

For fresh auth, the card opens the existing CoCalc-owned fresh-auth flow. A
button click does not grant authority: the server verifies completion of the
bound challenge, refreshes only the intended authenticated CLI/runtime session,
and emits the authoritative result. Codex then receives a safe structured
success/cancel/failure message and may retry the failed operation. Never place
passwords, OTPs, cookies, tokens, or authorization URLs in model context,
notification content, or project-authored records.

The agent may continue other authorized work while a CoCalc action is pending.
A question answer must never silently grant fresh auth or perform a privileged
action; existing authenticated, fresh-auth, and approval boundaries remain
authoritative.

### Multibay ownership

- The project owning bay and ACP worker are authoritative for synchronous and
  asynchronous Codex question lifecycles.
- The service that owns a typed CoCalc action remains authoritative for action
  completion. In particular, only the existing authentication authority may
  declare a fresh-auth challenge satisfied.
- The target account home bay is authoritative for inbox projection,
  preferences, email scheduling, and browser delivery state.
- Route source events through the existing notification outbox/projection
  architecture; do not assume the local bay owns the account.
- Keep the home-bay projection privacy-minimal: stable IDs, safe user-chosen
  labels, event kind/state/timestamps, and deep-link routing data. Question text,
  final agent content, terminal output, and action details remain on the owning
  project data plane and are fetched directly by an authorized browser when it
  opens the card.
- Route answers/actions from the home bay to the owning bay with explicit
  project ownership lookup. The owning bay then dispatches according to
  `source_kind`: exact app-server responder, durable ACP user-message submit, or
  typed CoCalc action handler.
- Project/host credentials may create attention only for the account bound to
  the ACP session and project. They may not choose arbitrary recipients.
- Rehome and account-home-bay changes must transfer or reconcile pending
  records without duplicate delivery or lost answers.

Lite mode should render request input and use local toast/native notification
delivery. It may omit durable cross-device inbox and email until Lite has an
account notification service, but it must label that limitation and preserve
the local answer lifecycle.

## Preference Schema and Migration

Introduce a versioned preference schema that separates channels. During the
mixed-client window, store version 2 under a distinct setting key so an old
client writing the version 1 object cannot erase new fields. Readers prefer
version 2 and derive it from version 1 only when version 2 is absent; new
clients write version 2 only. Remove the compatibility key/path after old
static clients have aged out.

The schema must represent these dimensions independently:

- inbox enabled;
- toast enabled;
- browser notification enabled;
- email strategy (`off`, `immediate`, `digest`, or `unresolved_after_delay`);
- event class (`attention`, `completion`, `terminal_failure`);
- completion default enabled;
- optional escalation delay within site-defined safe bounds.

Migration requirements:

- map version 1 `immediate` to inbox enabled and immediate email for the event
  classes that existed under that category;
- map version 1 `digest` to inbox enabled and digest email for the event classes
  that existed under that category;
- map version 1 `off` to inbox enabled and email disabled;
- map version 1 `none` to inbox, toast, browser, and email disabled for that
  category; never turn old `none` into a delivery channel;
- use the new recommended defaults for newly introduced attention event
  classes unless the old category was explicitly `none`;
- never request browser permission as part of migration. The stored preference
  and browser/OS permission remain separate, and permission requires a user
  click;
- keep required security/billing policy unrelated to Codex unchanged;
- relabel stable category key `ai` without losing saved preferences;
- migrate legacy per-thread completion `true` to the new `on` field;
- migrate legacy per-thread completion `false` or missing to `inherit` because
  old writers materialized false without proving user intent;
- allow only the new tri-state field to create an explicit `off`;
- make the account completion default enabled for both existing and new
  accounts, while allowing immediate opt-out;
- make all config updates merge/CAS the new tri-state rather than replacing it;
- support rollback readers for the previous preference version without letting
  a version 1 writer overwrite version 2 during a mixed static/hub deployment.

The Communication settings UI should use a compact matrix of switches or
checkboxes with row and column labels, not a dropdown containing every channel
combination. Email timing can use a separate radio/segmented strategy control
because those choices are mutually exclusive. Browser permission state and
the CoCalc preference must remain visibly separate. When escalation is enabled,
pending cards and inbox rows should expose explicit **Acknowledge** and
**Snooze** actions; merely opening the notification panel is only `seen_at`.

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
- Only trusted first-party services may create `source_kind=cocalc_action`.
  Model output, project files, terminal output, and project credentials may not
  select an action kind, action handler, recipient, or challenge reference.
- Build navigation and action links server-side from validated identifiers.
  Bind fresh-auth challenges to the target account, intended authenticated
  session, action purpose, expiry, and one-time completion state.
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

- Pin the supported bundled Codex version and generate/validate protocol
  fixtures for synchronous request input, `serverRequest/resolved`, and
  asynchronous agent-message questions.
- Audit every path that reads or writes `notifyOnTurnFinish`, including new
  thread, fork, restore, rename/behavior save, account reconnect, SyncDB
  conflict, and other Codex config edits.
- Add the separately named account completion default and tri-state thread
  override. Migrate true to `on` and false/missing to `inherit`.
- Prove that no unrelated config update drops a thread override.
- Add thread-coalesced inbox projection and watched-completion read behavior so
  enabling the account default cannot flood the notification inbox.
- Keep the old field readable only for the bounded compatibility window; do
  not preserve the old ambiguous toggle as the product interface.

### Wave 1: durable questions, fresh auth, and inline UI

- Enable the app-server feature behind a CoCalc site flag.
- Implement validated synchronous server-request handling and durable state.
- Consume structured asynchronous question messages and answer them through
  the normal durable user-message path.
- Implement one minimal trusted `fresh_auth` action end to end using the
  existing CoCalc-owned fresh-auth UI and authoritative challenge result.
- Add multibay event projection and source-specific answer/action routing.
- Render accessible blocking, asynchronous, stale, and trusted-action cards.
- Add global/project/thread attention indicators and resolution handling.
- Add trusted runtime guidance only after end-to-end handling is available.

### Wave 2: independent preferences and browser delivery

- Migrate notification preferences to independent channel dimensions.
- Relabel `ai` as **Codex and agents**.
- Add explicit Notification API permission/setup/test UI.
- Implement cross-tab leader election, native delivery, click routing,
  resolution cleanup, and direct-watching suppression.
- Add local Lite delivery.

### Wave 3: escalation and additional structured operator actions

- Add unresolved-attention email scheduling with cancellation checks.
- Add bounded reminder, coalescing, observability, and abuse limits.
- Integrate VM approval, external login, and manual sign-off events from
  first-party tooling after the Wave 1 fresh-auth pattern passes security
  review.
- Measure time-to-seen, time-to-answer, skipped deliveries, permission state,
  duplicates, and escalation outcomes.

### Wave 4: optional Web Push

- Perform a service-worker and push privacy/security design review.
- Add device subscriptions, revocation, key rotation, push payload minimization,
  and browser-closed delivery if the operational benefit justifies it.

## Validation Matrix

### Protocol and recovery

- Default-mode synchronous request using the exact wire `isBlocking` value.
- Asynchronous question item while Codex continues and completes other work;
  answer arrives as a new durable user message.
- Plan-mode blocking request that resumes after answer.
- Answer, decline, cancel, app-server lifecycle cleanup, timeout, and duplicate
  answer races.
- Browser reload, hub restart, ACP worker restart, project-host preemption,
  project restart, and stale app-server responder.
- Turn completion/interruption before an answer and receipt of
  `serverRequest/resolved`.
- Stale responder preserves an answer but cannot falsely resume the old request;
  **continue with this answer** creates one new user turn.
- Thread fork/resume, model catalogs without asynchronous questions, and legacy
  Codex versions without synchronous request-input support.
- Fresh-auth challenge success, cancel, expiry, replay, wrong account/session,
  and authoritative failure after the UI reports completion.

### Preferences and delivery

- Existing preference migration for every old mode.
- Account completion default on, explicit opt-out, and per-thread
  inherit/on/off.
- Legacy true maps to on; legacy false/missing maps to inherit; only the new
  field can create off.
- Old version 1 preference/config writers cannot erase version 2 fields.
- New thread, forked thread, restored thread, thread switch, and concurrent
  browser edits never reset the effective preference.
- Directly watched, visible-but-different-thread, hidden-tab, unfocused window,
  idle foreground, expired presence lease, and multiple-tab cases.
- Hundreds of completions across one or many threads preserve source history
  while producing bounded, coalesced inbox rows and unread counts.
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
- Model/project attempts to manufacture `cocalc_action`, choose another
  recipient, inject a fresh-auth URL, or reuse a completed challenge fail.
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

1. Deploy the distinct version 2 preference/config storage and readers before
   any new writer. Confirm version 1 clients cannot clobber it.
2. Deploy project-host synchronous request handling, asynchronous item handling,
   and typed action plumbing with all new feature flags off.
3. Deploy static UI and canary the completion-default migration plus inbox
   coalescing for internal accounts before enabling it broadly.
4. Enable synchronous and asynchronous questions separately for internal
   staging accounts, then production canaries.
5. Enable the fresh-auth action for internal accounts only after its dedicated
   authorization/security tests pass.
6. Validate blocking, asynchronous, stale-runtime, and preemption recovery
   before broad enablement.
7. Enable native browser delivery separately from email escalation.
8. Enable delayed email only after duplicate/rate-limit metrics are clean.

The server-side rollout controls are intentionally opt-in. Set a value to `1`
only for the canary cohort being enabled:

- `COCALC_CODEX_ATTENTION_INPUT` for synchronous app-server questions;
- `COCALC_CODEX_ATTENTION_ASYNC` for asynchronous questions;
- `COCALC_CODEX_ATTENTION_FRESH_AUTH` for trusted fresh-auth actions;
- `COCALC_CODEX_COMPLETION_NOTIFICATIONS` for completion notice creation;
- `COCALC_CODEX_ATTENTION_EMAIL` for Codex notification email delivery.

Rollback must be able to disable synchronous app-server request input,
asynchronous-question projection, each typed CoCalc action, the completion
default, and each external delivery channel independently. Disabling a feature
must not delete pending or historical attention records. Older static clients
should continue to see a generic durable notification and deep link even if
they cannot render the inline response card. Version 1 preference writers may
continue writing their separate legacy key during rollback without corrupting
version 2.

## Completion Criteria

The project is complete when:

- Codex synchronous questions can use blocking/nonblocking wire semantics, and
  asynchronous questions render and accept a later normal user message;
- a pending attention record and submitted human answer survive normal CoCalc
  interruptions without being silently lost or falsely answered, while a dead
  app-server responder is explicitly stale rather than claimed recoverable;
- a trusted fresh-auth action can notify the account, open the CoCalc-owned
  flow, verify authoritative completion, and safely tell Codex to retry without
  exposing credentials or model-generated action links;
- the user receives one prompt notification through enabled channels when not
  directly watching;
- account-wide completion notification defaults on, uses bounded thread-level
  inbox projection, and no longer appears to reset while switching or creating
  threads;
- communication settings expose independent channels and explicit escalation
  policy;
- native browser notifications work after explicit permission with privacy-safe
  contents and cross-tab deduplication;
- multibay authorization, security/abuse tests, accessibility checks, and live
  canary tests pass.
