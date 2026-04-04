# Greenfield Notification Model for Multi-Bay CoCalc

## Goal

Replace the current `mentions`-centric design with a bay-friendly notification
model that cleanly separates:

1. source events: something happened in a project
2. targeted fanout: which accounts should be notified
3. account inbox state: read, saved, archived, unread counts
4. side effects: email, digest, push, etc.

The main use case today is `@mention` in chat, but the new model should be
generic enough to cover future account-facing notifications.

This proposal is also intended to subsume most or all of the current central
`messages` system:

- [messages.ts](../packages/util/db-schema/messages.ts)
- [send.ts](../packages/server/messages/send.ts)
- [maintenance.ts](../packages/server/messages/maintenance.ts)

For `cocalc-ai`, the existing messages table looks more like a legacy inbox for
system/user notifications than a product we should preserve.

There is a third legacy source to account for as well:

- [file-use.ts](../packages/util/db-schema/file-use.ts)
- [init.ts](../packages/frontend/file-use/init.ts)
- [actions.ts](../packages/frontend/file-use/actions.ts)
- [store.ts](../packages/frontend/file-use/store.ts)

Today this drives the "recently edited documents and chat" popup plus the red
badge in the top bar. That feed is ambient, globally derived, and mostly
non-configurable noise. It should also be replaced by the new notification
model, not preserved.

There is a fourth notification-like source to account for:

- [news.ts](../packages/util/db-schema/news.ts)
- [init.ts](../packages/frontend/notifications/news/init.ts)
- [notification-news.tsx](../packages/frontend/notifications/notification-news.tsx)

This one is different. `news` is broadcast publication content, not a targeted
account event stream. It should still participate in a unified notification UI,
but it should not be implemented as eager per-account fanout to every CoCalc
account.

## Current Problem

The current `mentions` table is doing too many jobs at once:

- source event storage:
  - [mentions.ts](../packages/util/db-schema/mentions.ts)
- browser-facing inbox rows:
  - [table.ts](../packages/frontend/notifications/mentions/table.ts)
- per-user inbox state:
  - `users[account_id].read` and `users[account_id].saved`
  - [actions.ts](../packages/frontend/notifications/mentions/actions.ts)
- email work queue:
  - [handle.ts](../packages/server/mentions/handle.ts)
  - [notify.ts](../packages/server/mentions/notify.ts)

That design worked in a single-bay system, but it does not map cleanly onto the
new architecture:

- source events are project-owned
- inbox state is account-owned
- email policy is account-facing
- browser reads are account-local

The failed attempt to make `mentions` projection-backed exposed the real issue:
`mentions` is not the inbox model. It is an overloaded project-scoped source
table.

There is also a second, separate problem: CoCalc has a central `messages` table
that acts like an internal email system, with per-user bitset state,
reply/thread support, and email summaries. For the purposes of `cocalc-ai`, we
should not design around preserving that model either. Most of its real use is
"the system wants to tell somebody something", which belongs in the new
notification system.

## Design Principles

1. The owning bay of the source object owns the authoritative event.
2. The home bay of the target account owns the inbox row and read state.
3. Browser reads should come from an account-local inbox projection, not from a
   project-scoped source table.
4. Read/saved/archive mutations should never require writes back to a foreign
   project bay.
5. Delivery side effects should be decoupled from source-event persistence.
6. `mention` should become one notification kind, not the notification system.
7. Ambient analytics or presence data must not automatically become
   notifications. Account-facing notifications should be opt-in or explicitly
   authored.
8. Broadcast publication content such as news should not be modeled as eager
   per-account fanout. It needs a distinct publication/feed strategy.

## Proposed Model

### 1. `notification_events`

Authoritative immutable event rows, stored in the owning bay of the source
object.

One row means: "this thing happened".

Suggested fields:

- `event_id UUID PRIMARY KEY`
- `kind VARCHAR(64)`
  - initially `mention`
- `source_bay_id TEXT`
- `source_project_id UUID NULL`
- `source_path TEXT NULL`
- `source_fragment_id TEXT NULL`
- `actor_account_id UUID NULL`
- `origin_kind VARCHAR(64) NULL`
  - examples:
    - `project`
    - `system`
    - `account`
    - `admin`
- `payload_json JSONB`
- `created_at TIMESTAMP`

Notes:

- This replaces using `(time, project_id, path, target)` as the durable
  identity.
- For mentions, `event_id` should ideally be derived from an actual source
  object identity such as a chat message id or thread message id. If no stable
  object id exists, generate a real event UUID at write time.
- `source_project_id` being nullable is intentional. This is how we handle
  project-less notifications that today get shoved into the central `messages`
  system.

### 2. `notification_targets`

Target rows for account fanout, still authored on the source owning bay.

One row means: "account X should see event Y".

Suggested fields:

- `event_id UUID`
- `target_account_id UUID`
- `target_home_bay_id TEXT`
- `notification_id UUID`
- `dedupe_key TEXT`
- `created_at TIMESTAMP`
- primary key:
  - `(event_id, target_account_id)`

Notes:

- `notification_id` is the durable per-account notification identity that the
  inbox projection uses.
- This table is where source ownership and account fanout meet.
- For `@mention`, each mentioned account gets one target row.

### 3. `notification_target_outbox`

Outbox rows emitted from the source owning bay for downstream delivery to the
target home bay.

This is the multi-bay transport surface.

Suggested fields:

- `outbox_id UUID PRIMARY KEY`
- `target_home_bay_id TEXT`
- `target_account_id UUID`
- `notification_id UUID`
- `kind VARCHAR(64)`
- `event_type VARCHAR(64)`
  - examples:
    - `notification.upserted`
    - `notification.deleted`
- `payload_json JSONB`
- `created_at TIMESTAMP`
- `published_at TIMESTAMP NULL`

Notes:

- The current [notification-events-outbox.ts](../packages/database/postgres/notification-events-outbox.ts)
  is close in spirit, but it is still shaped too tightly around today's mention
  projection attempt.
- This new outbox should be explicitly about transport from owning bay to home
  bay.

### 4. `account_notification_index`

Home-bay account inbox projection. This is what the browser reads.

One row means: "this account currently has this notification in its inbox".

Suggested fields:

- `account_id UUID`
- `notification_id UUID`
- `kind VARCHAR(64)`
- `source_bay_id TEXT`
- `source_project_id UUID NULL`
- `summary_json JSONB`
- `state_json JSONB`
  - or explicit columns:
    - `read_at`
    - `saved_at`
    - `archived_at`
    - `dismissed_at`
- `created_at TIMESTAMP`
- `updated_at TIMESTAMP`
- primary key:
  - `(account_id, notification_id)`

Recommended summary shape for `mention`:

- `source_project_id`
- `path`
- `fragment_id`
- `actor_account_id`
- `description`
- `priority`

Recommended state shape:

- `read: boolean`
- `saved: boolean`
- `archived: boolean`

Notes:

- This table should become the browser-facing notification surface.
- The current [account-notification-index.ts](../packages/database/postgres/account-notification-index.ts)
  can be reused conceptually, but its payload contract should become generic and
  event-driven rather than "mirror `mentions` rows".

Recommended summary shape for non-project notifications:

- `title`
- `body_markdown`
- `severity`
  - `info`, `warning`, `error`
- `origin_label`
  - e.g. `System`, `Admin`, `Billing`
- `action_link`
  - optional deep link into app settings, billing, admin page, etc.
- `action_label`
  - optional CTA label

### 5. `account_notification_delivery_outbox`

Home-bay side-effect queue for email, digests, push, etc.

One row means: "consider sending or scheduling this account-facing delivery".

Suggested fields:

- `delivery_id UUID PRIMARY KEY`
- `account_id UUID`
- `notification_id UUID`
- `channel VARCHAR(32)`
  - `email`, later others
- `state VARCHAR(32)`
  - `pending`, `sent`, `skipped`, `failed`
- `attempt_count INT`
- `last_error TEXT NULL`
- `scheduled_at TIMESTAMP`
- `updated_at TIMESTAMP`

Notes:

- This replaces using `mentions.action` and `mentions.error` as the delivery
  control plane.
- Email policy becomes account-local, which is a much better fit.

### 6. `account_notification_rules`

Home-bay user preferences and subscription rules for derived notifications.

One row means: "this account wants notifications when this kind of thing
happens".

Suggested fields:

- `rule_id UUID PRIMARY KEY`
- `account_id UUID`
- `kind VARCHAR(64)`
  - examples:
    - `mention`
    - `file_changed`
    - `chat_activity`
- `scope_type VARCHAR(32)`
  - `project`
  - `path`
  - `path_glob`
  - `account`
- `scope_project_id UUID NULL`
- `scope_path TEXT NULL`
- `matcher_json JSONB`
  - future extension point
- `enabled BOOLEAN`
- `manual_only BOOLEAN`
  - for file edits by humans, not automation
- `created_at TIMESTAMP`
- `updated_at TIMESTAMP`

Notes:

- This is how we replace the current `file_use`-driven derived badge/feed.
- Notifications for file edits should only exist when the target account has
  explicitly configured such a rule.

### 7. `source_notification_rule_index`

Projected matcher index that makes home-bay notification rules available on the
source owning bay where events happen.

One row means: "for source scope X, account Y in home bay Z wants notification
kind K".

Suggested fields:

- `source_bay_id TEXT`
- `scope_type VARCHAR(32)`
- `scope_project_id UUID NULL`
- `scope_path_prefix TEXT NULL`
- `kind VARCHAR(64)`
- `target_account_id UUID`
- `target_home_bay_id TEXT`
- `rule_id UUID`
- `enabled BOOLEAN`
- `manual_only BOOLEAN`

Notes:

- This is the crucial extra layer needed for replacing `file_use` with a
  multi-bay-safe design.
- The source bay cannot efficiently evaluate home-bay preferences unless those
  preferences are projected into an index keyed by source scope.

### 8. `publication_events`

Canonical broadcast publication rows for public or semi-public feed content such
as product news, announcements, feature releases, and similar one-to-many
content.

One row means: "this publication exists".

Suggested fields:

- `publication_id UUID PRIMARY KEY`
- `kind VARCHAR(64)`
  - examples:
    - `news`
    - `announcement`
    - `feature_release`
- `channel VARCHAR(64)`
- `audience_kind VARCHAR(32)`
  - examples:
    - `public`
    - `signed_in`
    - `admins`
    - `segment`
- `audience_filter_json JSONB NULL`
- `title TEXT`
- `body_markdown TEXT`
- `summary_json JSONB`
- `published_at TIMESTAMP`
- `until TIMESTAMP NULL`
- `hidden BOOLEAN`

Notes:

- This can replace or subsume the current `news` table over time, but it should
  keep the same core semantics: one canonical publication, not 10 million
  per-account inbox rows.
- Publication rows are broadcast content, not targeted account events.

### 9. `account_publication_state`

Home-bay per-account state for broadcast/publication feeds.

One row means: "this account has this relationship to this publication feed or
publication item".

Suggested fields:

- `account_id UUID`
- `scope_kind VARCHAR(32)`
  - examples:
    - `channel`
    - `publication`
- `scope_value TEXT`
- `read_until TIMESTAMP NULL`
- `last_seen_at TIMESTAMP NULL`
- `dismissed_at TIMESTAMP NULL`
- `saved_at TIMESTAMP NULL`
- `enabled BOOLEAN`
- primary key:
  - `(account_id, scope_kind, scope_value)`

Notes:

- For current-style news, channel-level watermarks may be enough.
- If we later want per-item save/dismiss state, we can use
  `scope_kind='publication'`.
- This is much cheaper than eager fanout while still allowing a unified account
  UI.

### 10. `account_publication_preferences`

Home-bay opt-in/opt-out preferences for broadcast content.

Suggested fields:

- `account_id UUID`
- `channel VARCHAR(64)`
- `in_app_enabled BOOLEAN`
- `email_enabled BOOLEAN`
- `active_only BOOLEAN`
- `updated_at TIMESTAMP`

Notes:

- This is where "I want announcement notifications" or "don't show me feature
  releases" belongs.
- We can default these conservatively and avoid reproducing the current noisy
  feed behavior.

### 11. `active_account_publication_queue`

Optional bounded queue for lazy materialization of broadcast items into the
account inbox for active accounts only.

One row means: "this active account should be caught up on recent publications".

Suggested fields:

- `account_id UUID PRIMARY KEY`
- `reason VARCHAR(32)`
  - examples:
    - `signin`
    - `became_active`
    - `prefs_changed`
- `scheduled_at TIMESTAMP`
- `processed_at TIMESTAMP NULL`

Notes:

- This is the scalable alternative to creating notification rows for every
  account when a news item is published.
- If the product wants a single inbox list rather than a separate news feed, we
  can lazily materialize recent publications into `account_notification_index`
  for active opted-in accounts only.
- If the product is satisfied with a unified top-level counter but separate
  storage, the queue may be unnecessary and we can compute publication unread
  counts directly from `publication_events` plus account read state.

## Write Path for Mentions

### Current write path

Today chat mention submission writes directly into `mentions`:

- [mentions.ts](../packages/frontend/editors/markdown-input/mentions.ts)
- [methods-impl.ts](../packages/database/user-query/methods-impl.ts)

### Proposed write path

For an `@mention`, the write flow should be:

1. parse mention targets in the editor/chat path
2. send a backend command:
   - `notifications.createMention`
3. on the owning bay:
   - create one `notification_events` row
   - create one `notification_targets` row per target account
   - append one `notification_target_outbox` row per target home bay delivery
4. home-bay projector consumes target outbox rows and upserts
   `account_notification_index`
5. home-bay delivery maintenance optionally schedules email/digest side effects

Important:

- mention creation should not directly write account inbox state
- mention creation should not directly mutate email delivery state

## Browser Read and Mutation Model

### Browser reads

The notifications page should read `account_notification_index`, not `mentions`.

This means:

- the current "mentions tab" becomes:
  - `notifications` filtered by `kind = 'mention'`
- unread counter comes from account-local inbox state
- project-scoped deep links still work through `summary_json.path` and
  `summary_json.fragment_id`

### Browser mutations

`mark read`, `save`, `archive`, etc. should update only the home-bay inbox row.

That means:

- no more writes to `mentions.users`
- no need to synchronize read state back to the source owning bay

The current "recently edited docs" popup and top-bar badge should also become a
view over `account_notification_index`, not a direct view over `file_use`.

This is a major simplification and a much better match for "home-bay connection
only".

Broadcast content such as news is the one exception. It may still be rendered
through the same top-level notifications surface, but operationally it should
either:

- remain a broadcast feed with per-account read state, or
- be lazily materialized into inbox rows only for active opted-in accounts

It should not require eager per-account fanout at publish time.

## Unified UI Model

The product should have one top-level notification indicator, not separate
counters for messages, mentions, news, file activity, etc.

The right way to get that is not to force all sources into one write path. It
is to unify them at the account-facing read layer.

Recommended model:

- one top-level badge count exposed by the home bay
- count is the sum of:
  - unread targeted inbox notifications from `account_notification_index`
  - unread broadcast publications from `publication_events` +
    `account_publication_state`
- one account-facing notifications page that can filter by kind/source

This lets us present one coherent UI without requiring:

- 10 million fanout rows for news
- project-scoped browser reads for mentions
- global ambient file activity feeds

## Why This Is Better for Bays

### Source ownership stays where it belongs

The owning bay of the project or source object decides:

- what happened
- who should know about it
- what the source context is

### Account state stays where it belongs

The home bay of the account decides:

- whether it is unread
- whether it is saved
- whether it is archived
- whether email should be sent
- what broadcast publication channels are enabled
- what broadcast content has been seen

### The browser model gets simpler

The browser just talks to home bay and sees account-local inbox rows.

It does not need:

- project-scoped notification reads
- foreign-bay read/write state mutation
- special-case source-table semantics

For broadcast publications, the browser still only talks to the home bay. The
home bay can combine:

- account-local inbox rows
- account-local publication preferences/state
- canonical publication content

## How This Relates to the Existing Phase 2 Work

### Keep

- the idea of `account_notification_index`
- projector maintenance/status/rebuild tooling
- the idea of notification outbox transport

### Change

- stop treating current `mentions` rows as the durable notification model
- stop trying to make the current `mentions` user query projection-backed
- reshape the notification outbox to be explicitly target/home-bay oriented

### Deprecate

- `mentions.users`
- `mentions.action`
- `mentions.error`
- direct browser reads from `mentions`

## Migration Strategy

Because this is greenfield, the best path is replacement, not compatibility.

### Phase A: parallel model

1. add the new notification event/target/outbox tables
2. keep current mentions behavior unchanged
3. add a new mention creation path that writes both models, behind a flag

### Phase B: browser cutover

1. add a new browser-facing notification query from `account_notification_index`
2. implement filtering by kind and read/saved state
3. move unread badge to the new inbox rows

### Phase C: side-effect cutover

1. move email notification handling to the home-bay delivery outbox
2. stop using `server/mentions/handle.ts` for the new path

### Phase D: removal

1. stop writing new `mentions` rows for user-facing notifications
2. delete or freeze the old `mentions` notification UI
3. keep `mentions` only as temporary legacy data if needed, then remove it

## Suggested Initial Scope

Do not attempt "all notifications" first.

Start with exactly one greenfield kind:

- `mention`

Immediately after that, the next kind should be a replacement for central
system messages:

- `account_notice`
  - project-less, one-way, account-facing notification

After that, if we still want file-edit notifications, they should be added only
as explicit opt-in subscription-backed kinds:

- `file_changed`
- `chat_activity`

Broadcast/publication content should be a separate slice after those, not mixed
into the first targeted notification implementation:

- `publication.news`
- `publication.announcement`

The first implementation should support:

- creating a mention notification event
- fanout to target accounts
- projecting to `account_notification_index`
- reading it in the browser inbox
- marking it read/saved in the home bay

Leave email/digest migration to the next slice if needed.

News should come later as a separate publication-feed slice, because its scale
and semantics are different from targeted per-account notifications.

## Concrete API Proposal

### Owning-bay write API

- `notifications.createMention`
  - input:
    - `source_project_id`
    - `source_path`
    - `source_fragment_id`
    - `actor_account_id`
    - `target_account_ids[]`
    - `description`
    - `priority`
    - optional stable source message id
  - effect:
    - create one event
    - create N targets
    - append N outbox rows

### Home-bay inbox APIs

- `notifications.list`
- `notifications.markRead`
- `notifications.markUnread`
- `notifications.save`
- `notifications.unsave`
- `notifications.archive`
- `notifications.unarchive`

### Optional delivery APIs later

- `notifications.deliveryStatus`
- `notifications.retryDelivery`

## Replacing the Current `messages` System

### What `messages` does today

The current central `messages` system provides:

- a global inbox not scoped to projects
- sender/recipient semantics
- replies and threads
- state flags:
  - read
  - saved
  - starred
  - liked
  - deleted
  - expire
- periodic aggregate email summaries

Relevant code:

- [messages.ts](../packages/util/db-schema/messages.ts)
- [send.ts](../packages/server/messages/send.ts)
- [get.ts](../packages/server/messages/get.ts)
- [maintenance.ts](../packages/server/messages/maintenance.ts)

### What we should keep

Only the account-facing notification intent:

- the system wants to inform a user or admin about something
- some of those should produce email summaries or direct email
- some are not attached to any project

### What we should not preserve by default

For `cocalc-ai`, these should not be requirements for the new notification
system unless there is a concrete product need:

- inbox-style reply threads
- user-to-user direct messaging
- `liked`
- sender-side bitset state
- separate central inbox semantics

If true conversational messaging is ever needed, it should be a separate system,
not something overloaded into account notifications.

### Suggested replacement kinds

Add non-project notification kinds such as:

- `account_notice`
  - ordinary account-facing notice from the system
- `admin_alert`
  - account-facing or admin-facing operational alert
- `billing_notice`
  - billing/subscription/account warning or reminder

These are just notification kinds. They do not require a separate `messages`
backend.

## Replacing `file_use`-Driven Notifications

### What `file_use` does today

The current `file_use` system is not a deliberate notification model. It is an
ambient usage/activity table that records actions such as:

- `open`
- `edit`
- `read`
- `seen`
- `chat`
- `chatseen`

for every visible collaborator on many files, and then the frontend derives
notions like:

- `notify`
- `is_unread`
- `is_unseen`
- `is_unseenchat`

Relevant code:

- [file-use.ts](../packages/util/db-schema/file-use.ts)
- [actions.ts](../packages/frontend/file-use/actions.ts)
- [store.ts](../packages/frontend/file-use/store.ts)

This is useful as lightweight activity/presence/analytics data, but it is a bad
foundation for a notification system:

- it is globally derived rather than explicitly authored
- it is noisy by default
- it is not user-configured
- it depends on collaborator state for all files across all projects
- it would be difficult to make bay-correct without projecting vast amounts of
  low-value activity data

### Recommendation

Keep `file_use` only for:

- analytics
- presence
- lightweight local activity heuristics if still useful

Do not use it as the source of account notifications.

### Replacement model

If we want file-edit or chat-activity notifications, they should be
subscription-backed:

1. account sets a rule in `account_notification_rules`
2. rules are projected into `source_notification_rule_index`
3. source bay sees a file edit or chat activity
4. source bay matches only relevant subscription rules
5. source bay creates targeted notification events only for matching accounts
6. home-bay inbox projection surfaces them

This means:

- no notification unless the account asked for it
- no need to treat all ambient file activity as inbox-worthy
- scalable matching boundary:
  source bay only sees projected subscription matchers relevant to its source
  scope

### Example rule shapes

- "notify me when any collaborator edits any file in project P"
- "notify me when files under `work/clients/**` change in project P"
- "notify me when someone other than me edits this specific chat file"

### Important policy default

For `cocalc-ai`, file-edit notifications should default to off.

The current global recent-edits feed is mostly noise. The greenfield model
should only create account notifications for file activity when there is an
explicit user rule.

### Suggested replacement write API

Instead of calling `server/messages/send.ts`, new code should write notification
events such as:

- `notifications.createAccountNotice`
  - `target_account_ids[]`
  - `title`
  - `body_markdown`
  - `severity`
  - `action_link?`
  - `action_label?`
  - `dedupe_window?`

This covers the actual product need of most current `send_message` usage
without carrying forward the legacy inbox model.

### Email summaries

The current message summary worker in
[maintenance.ts](../packages/server/messages/maintenance.ts) should eventually
be replaced by delivery policies over `account_notification_index`, e.g.:

- send digest email for unread `account_notice` or `mention`
- skip notifications already marked read/archived before the digest window
- respect per-account delivery preferences

This is a much better fit than summarizing rows from a dedicated central
messages table.

## Non-Goals

- preserving the exact old `mentions` row shape
- preserving the old direct browser dependency on `mentions`
- keeping read/saved state on the owning project bay

## Recommendation

Treat `mentions` as a legacy single-bay implementation artifact and build the
new notification system around:

- immutable source events
- explicit target fanout
- home-bay inbox projection
- home-bay delivery side effects

Also treat the current central `messages` table as a legacy notification source
to replace, not as a system whose semantics we need to preserve in the new
multi-bay design.

Also treat `file_use` as a legacy activity/presence source, not as something
that should directly drive account notifications. Any future file or chat
notifications should be opt-in and subscription-backed.

That is the correct abstraction boundary for a multi-bay system with
home-bay-only browser connections.
