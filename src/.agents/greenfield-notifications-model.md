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

## Design Principles

1. The owning bay of the source object owns the authoritative event.
2. The home bay of the target account owns the inbox row and read state.
3. Browser reads should come from an account-local inbox projection, not from a
   project-scoped source table.
4. Read/saved/archive mutations should never require writes back to a foreign
   project bay.
5. Delivery side effects should be decoupled from source-event persistence.
6. `mention` should become one notification kind, not the notification system.

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
- `payload_json JSONB`
- `created_at TIMESTAMP`

Notes:

- This replaces using `(time, project_id, path, target)` as the durable
  identity.
- For mentions, `event_id` should ideally be derived from an actual source
  object identity such as a chat message id or thread message id. If no stable
  object id exists, generate a real event UUID at write time.

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

This is a major simplification and a much better match for "home-bay connection
only".

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

### The browser model gets simpler

The browser just talks to home bay and sees account-local inbox rows.

It does not need:

- project-scoped notification reads
- foreign-bay read/write state mutation
- special-case source-table semantics

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

The first implementation should support:

- creating a mention notification event
- fanout to target accounts
- projecting to `account_notification_index`
- reading it in the browser inbox
- marking it read/saved in the home bay

Leave email/digest migration to the next slice if needed.

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

That is the correct abstraction boundary for a multi-bay system with
home-bay-only browser connections.
