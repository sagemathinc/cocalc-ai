# Greenfield Notifications Implementation Plan

## Goal

Implement the new multi-bay notification system in a sequence that:

1. delivers value early with `mention`
2. does not require preserving the old `mentions` data model
3. keeps browser reads home-bay-local
4. leaves broadcast/publication content such as `news` as a later, separate
   slice

This plan is intentionally narrower and more execution-oriented than
[greenfield-notifications-model.md](./greenfield-notifications-model.md).

## Non-Goals for the First Slice

Do not do these in the first implementation:

- replace `news`
- replace `file_use`
- replace all central `messages`
- move email digests to the new system
- support every notification kind
- preserve the old `mentions` write/read model indefinitely

The first slice should prove the architecture, not boil the ocean.

## First-Slice Product Scope

The first slice should support exactly two account-facing kinds:

- `mention`
- `account_notice`

`mention` proves:

- source-bay-owned event creation
- fanout to one or more target accounts
- home-bay inbox projection
- browser read/update from the home bay only

`account_notice` proves:

- project-less notifications
- replacement path for some `send_message`-style system notices

## Proposed Tables

## Source-Bay Tables

### `notification_events`

Authoritative immutable source events.

Suggested columns:

- `event_id UUID PRIMARY KEY`
- `kind TEXT NOT NULL`
- `source_bay_id TEXT NOT NULL`
- `source_project_id UUID NULL`
- `source_path TEXT NULL`
- `source_fragment_id TEXT NULL`
- `actor_account_id UUID NULL`
- `origin_kind TEXT NULL`
- `payload_json JSONB NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Suggested indexes:

- `(kind, created_at DESC)`
- `(source_project_id, created_at DESC)` where `source_project_id IS NOT NULL`

Invariants:

- immutable after insert except maybe rare admin repair tools
- owned by the source/owning bay only
- `source_project_id` nullable for project-less events

### `notification_targets`

Fanout table from source event to target accounts.

Suggested columns:

- `event_id UUID NOT NULL`
- `target_account_id UUID NOT NULL`
- `target_home_bay_id TEXT NOT NULL`
- `notification_id UUID NOT NULL`
- `dedupe_key TEXT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Suggested constraints and indexes:

- primary key `(event_id, target_account_id)`
- unique `(target_account_id, notification_id)`
- index `(target_home_bay_id, created_at DESC)`
- optional unique `(target_account_id, dedupe_key)` where `dedupe_key IS NOT NULL`

Invariants:

- exactly one target row per `(event_id, target_account_id)`
- `notification_id` is the durable account-facing id
- target rows are authored on the source bay only

### `notification_target_outbox`

Transport surface from source bay to target home bay.

Suggested columns:

- `outbox_id UUID PRIMARY KEY`
- `target_home_bay_id TEXT NOT NULL`
- `target_account_id UUID NOT NULL`
- `notification_id UUID NOT NULL`
- `kind TEXT NOT NULL`
- `event_type TEXT NOT NULL`
- `payload_json JSONB NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `published_at TIMESTAMPTZ NULL`

Suggested indexes:

- `(target_home_bay_id, published_at, created_at)`
- `(target_account_id, created_at DESC)`

Invariants:

- append-only transport log
- projector consumes `published_at IS NULL`
- payload must contain everything the home bay needs to upsert inbox state

## Home-Bay Tables

### `account_notification_index`

Browser-facing inbox projection.

Suggested columns:

- `account_id UUID NOT NULL`
- `notification_id UUID NOT NULL`
- `kind TEXT NOT NULL`
- `source_bay_id TEXT NOT NULL`
- `source_project_id UUID NULL`
- `summary_json JSONB NOT NULL`
- `read_at TIMESTAMPTZ NULL`
- `saved_at TIMESTAMPTZ NULL`
- `archived_at TIMESTAMPTZ NULL`
- `dismissed_at TIMESTAMPTZ NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`

Suggested constraints and indexes:

- primary key `(account_id, notification_id)`
- `(account_id, created_at DESC)`
- `(account_id, read_at, archived_at, created_at DESC)`
- `(account_id, kind, created_at DESC)`

Invariants:

- this is the canonical browser-facing inbox row
- browser state mutations change only this table
- no write-back to source bay for read/save/archive

### `account_notification_delivery_outbox`

Later slice. Not required for the first browser cutover.

Suggested columns:

- `delivery_id UUID PRIMARY KEY`
- `account_id UUID NOT NULL`
- `notification_id UUID NOT NULL`
- `channel TEXT NOT NULL`
- `state TEXT NOT NULL`
- `attempt_count INT NOT NULL DEFAULT 0`
- `last_error TEXT NULL`
- `scheduled_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

This should be introduced only after the inbox path is proven.

## Canonical Payload Shapes

### `mention`

`notification_events.payload_json`

```json
{
  "kind": "mention",
  "description": "Harald mentioned you in chat",
  "priority": "normal",
  "message_id": "uuid-or-null"
}
```

`notification_target_outbox.payload_json`

```json
{
  "notification_id": "uuid",
  "kind": "mention",
  "source_bay_id": "bay-0",
  "source_project_id": "uuid",
  "summary": {
    "description": "Harald mentioned you in chat",
    "path": "work/chat.chat",
    "fragment_id": "uuid-or-null",
    "actor_account_id": "uuid",
    "priority": "normal"
  },
  "created_at": "timestamp"
}
```

### `account_notice`

`notification_events.payload_json`

```json
{
  "kind": "account_notice",
  "severity": "info",
  "title": "Subscription expiring soon",
  "body_markdown": "Your subscription will expire in 3 days.",
  "action_link": "/settings/subscription",
  "action_label": "Open subscription settings"
}
```

`notification_target_outbox.payload_json`

```json
{
  "notification_id": "uuid",
  "kind": "account_notice",
  "source_bay_id": "system-bay",
  "source_project_id": null,
  "summary": {
    "title": "Subscription expiring soon",
    "body_markdown": "Your subscription will expire in 3 days.",
    "severity": "info",
    "origin_label": "Billing",
    "action_link": "/settings/subscription",
    "action_label": "Open subscription settings"
  },
  "created_at": "timestamp"
}
```

## Required APIs

## Source-Bay Write APIs

### `notifications.createMention`

Input:

- `source_project_id: UUID`
- `source_path: string`
- `source_fragment_id?: string`
- `actor_account_id?: UUID`
- `target_account_ids: UUID[]`
- `description: string`
- `priority?: "low" | "normal" | "high"`
- `stable_source_id?: string`

Behavior:

1. resolve target accounts to home bays
2. insert one `notification_events` row
3. insert one `notification_targets` row per target account
4. append one `notification_target_outbox` row per target

Return:

- `event_id`
- `notification_ids[]`

### `notifications.createAccountNotice`

Input:

- `target_account_ids: UUID[]`
- `severity: "info" | "warning" | "error"`
- `title: string`
- `body_markdown: string`
- `origin_label?: string`
- `action_link?: string`
- `action_label?: string`
- `dedupe_key?: string`

Behavior:

1. create one project-less `notification_events` row
2. create one target per account
3. append one outbox row per target

Return:

- `event_id`
- `notification_ids[]`

## CLI Requirements

CLI support should be part of the initial implementation, not an afterthought.

Reasons:

- it makes Codex/session automation much easier
- it makes local testing and smoke testing much easier
- it provides a clear stable surface for admin/debug workflows
- it forces the new API shape to be explicit and scriptable

The CLI should target the home bay by default for inbox actions and the
appropriate source/home bay for creation actions via the same RPC APIs the
browser/server will use.

### First-slice CLI commands

These should exist as soon as the corresponding RPCs exist.

#### Inbox commands

- `cocalc notifications list`
  - options:
    - `--kind <kind>`
    - `--state unread|saved|archived|all`
    - `--limit <n>`
    - `--json`
- `cocalc notifications counts`
  - options:
    - `--json`
- `cocalc notifications mark-read <notification-id>...`
- `cocalc notifications mark-unread <notification-id>...`
- `cocalc notifications save <notification-id>...`
- `cocalc notifications unsave <notification-id>...`
- `cocalc notifications archive <notification-id>...`

#### Creation/debug commands

- `cocalc notifications create-account-notice`
  - options:
    - `--account <account-id>` repeatable
    - `--severity info|warning|error`
    - `--title <text>`
    - `--body <markdown>`
    - `--origin-label <text>`
    - `--action-link <path-or-url>`
    - `--action-label <text>`
    - `--dedupe-key <text>`
    - `--json`
- `cocalc notifications create-mention`
  - mostly for testing/dev, not ordinary end-user use
  - options:
    - `--project <project-id>`
    - `--path <path>`
    - `--fragment-id <id>`
    - `--actor <account-id>`
    - `--target <account-id>` repeatable
    - `--description <text>`
    - `--priority low|normal|high`
    - `--json`

#### Admin/projector commands

- `cocalc notifications rebuild-index --account <account-id>`
- `cocalc notifications drain-outbox`
- `cocalc notifications status`

Notes:

- `create-mention` is especially useful for Codex-driven test flows.
- `create-account-notice` is useful both for development and eventually for
  replacing some ad hoc `send_message` admin/system flows.
- JSON output should be first-class on all commands so agents can consume it
  directly.

## Home-Bay Inbox APIs

### `notifications.list`

Input:

- `kind?: string`
- `state?: "unread" | "saved" | "archived" | "all"`
- `limit?: number`
- `offset?: number`

Return:

- `rows[]`
- `unread_count`
- `saved_count`

Reads only `account_notification_index`.

### `notifications.counts`

Input:

- optional kind filters

Return:

- `total_unread`
- `by_kind`

This is the API that should eventually back the one top-level badge.

### `notifications.markRead`

Input:

- `notification_ids: UUID[]`

Behavior:

- set `read_at` if null
- update `updated_at`

### `notifications.markUnread`

Input:

- `notification_ids: UUID[]`

Behavior:

- set `read_at = NULL`
- update `updated_at`

### `notifications.save`

Input:

- `notification_ids: UUID[]`

Behavior:

- set `saved_at = NOW()`
- update `updated_at`

### `notifications.unsave`

Input:

- `notification_ids: UUID[]`

Behavior:

- set `saved_at = NULL`
- update `updated_at`

### `notifications.archive`

Input:

- `notification_ids: UUID[]`

Behavior:

- set `archived_at = NOW()`
- update `updated_at`

## Projector / Maintenance Responsibilities

### Source Bay

- append outbox rows transactionally with event/target writes
- expose admin rebuild/drain/status only if actually useful
- no browser reads from source tables

### Home Bay

- consume `notification_target_outbox`
- upsert `account_notification_index`
- maintain lag/status metrics
- expose inbox APIs to browser

## Browser Cutover Plan

### Phase 1: parallel backend

1. add the new tables
2. add `notifications.createMention`
3. dual-write `mention` from the chat/editor path behind a flag
4. project to `account_notification_index`
5. add CLI commands for create/list/read-state/debug flows
6. add admin rebuild/status tools

Success condition:

- new notification rows appear in `account_notification_index`
- CLI can list and mutate them
- no browser reads depend on them yet

### Phase 2: new browser inbox path

1. add new frontend notifications store/query against `notifications.list`
2. render a `mention` section from inbox rows
3. drive unread badge from `notifications.counts`
4. keep old mentions UI behind a fallback flag

Success condition:

- user can see and mutate mention notifications entirely via the new path
- the same flows can be exercised from CLI for automation/tests

### Phase 3: first account notices

1. replace one low-risk `send_message` path with `notifications.createAccountNotice`
2. render it in the same unified notifications page
3. verify project-less notifications behave correctly

Success condition:

- at least one legacy message flow is removed from the critical path

### Phase 4: remove old mention UI/write path

1. stop browser reads from `mentions`
2. stop browser mutations of `mentions.users`
3. stop new writes to `mentions` for the migrated path

Success condition:

- `mention` is fully served by the new system

## Publications / News Plan

This is deliberately later and separate.

`news` should not be forced into the first targeted-notification slice.

Recommended later sequence:

1. add `publication_events`
2. add `account_publication_state`
3. add `account_publication_preferences`
4. expose a home-bay unread publication count
5. unify the top-level badge as:
   - targeted inbox unread
   - plus unread opted-in publications

Only if the product explicitly wants inline news items in the inbox should we
add lazy materialization for active accounts.

## Immediate Next Coding Tasks

1. create `notification_events`, `notification_targets`, and
   `notification_target_outbox`
2. implement `notifications.createMention`
3. implement home-bay projector into `account_notification_index`
4. add `notifications.list`, `notifications.counts`, and `notifications.markRead`
5. add first-slice `cocalc notifications ...` commands
6. add a minimal new frontend notification list behind a flag

## Open Questions

1. What stable source identifier should mention notifications use?
   - ideally actual chat message id / thread item id
2. Should `account_notice` allow replies?
   - recommendation: no, not in the first system
3. Do we want one generic `notifications.create` API or explicit kind-specific
   APIs?
   - recommendation: explicit APIs first
4. Should the initial browser cutover replace the current notifications page or
   add a new experimental page?
   - recommendation: existing page, behind a feature flag
