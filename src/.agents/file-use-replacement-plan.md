# File Use Replacement Plan

## Status

DONE as of 2026-04-06.

`file_use` has been removed from the active source tree and replaced by:

1. `document_presence`
   - realtime ephemeral viewer/editor presence
   - used by avatars / users-viewing

2. `document_activity`
   - explicit recent-activity fetch path
   - backed by `file_access_log`

3. chat-native unread state
   - no longer derived from `file_use`

The old `file_use` browser synctable, Redux store, schema definition, CRM table,
and backend product write/read path are gone.

## Completed End State

- no browser `file_use` synctable
- no browser `file_use` Redux store
- no backend `record_file_use` / `get_file_use` product path
- no `file_use` schema entry in `src/packages/util/db-schema`
- recent document activity uses explicit fetch over `file_access_log`
- live presence uses `document_presence`
- chat unread does not depend on `file_use`

## Goal

Remove the legacy `file_use` synctable/changefeed path and replace it with:

1. `document_presence`
   - ephemeral realtime presence for "who is viewing/editing this document"
   - used by avatars in editors and explorers
   - not stored in `file_use`

2. `document_activity`
   - explicit fetch for the bell panel / recent document activity
   - backed by query/RPC, not a frontend live table
   - eventually backed by `file_access_log` plus derived state

3. `chat unread`
   - derived from chat state itself, not piggybacked on `file_use`

The end state should have:

- no browser `file_use` synctable
- no `file_use` top-bar counter derived from a changefeed
- no avatar/chat-indicator dependency on the `file_use` table
- one notifications page and one notifications counter

## Historical Starting State

### Frontend live table

This section describes the pre-migration architecture.

`file_use` is currently initialized as a normal synctable:

- [init.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/init.ts)
- [table.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/table.ts)

The store does three jobs at once:

- activity panel sorting/filtering
- bell unread count
- active users / recent users for specific files and projects

That logic lives in:

- [store.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/store.ts)

### Historical write paths

These wrote to `file_use` before the migration:

- file open
  - [project_actions.ts:1007](/home/wstein/build/cocalc-lite4/src/packages/frontend/project_actions.ts:1007)
  - [open-file.ts:563](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/open-file.ts:563)
- editor touch/edit
  - [generic/client.ts:38](/home/wstein/build/cocalc-lite4/src/packages/frontend/frame-editors/generic/client.ts:38)
- file client mark
  - [file.ts:24](/home/wstein/build/cocalc-lite4/src/packages/frontend/client/file.ts:24)
- chat seen/read
  - [chat/utils.ts:141](/home/wstein/build/cocalc-lite4/src/packages/frontend/chat/utils.ts:141)

### Historical read paths

#### Live presence-ish consumers

- avatars in files / project explorer / activity flyout
  - [users-viewing.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/account/avatar/users-viewing.tsx)
- document chat indicator
  - [chat-indicator.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/chat/chat-indicator.tsx)

#### Bell panel / recent activity UI

- [app/notifications.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/app/notifications.tsx)
- [page.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/page.tsx)
- [viewer.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/viewer.tsx)
- [info.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/info.tsx)
- [util.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/util.ts)

### Backend persistence

At the time this plan was written there were two distinct backend mechanisms:

1. `file_use`
   - current mixed-purpose table
   - schema in [file-use.ts](/home/wstein/build/cocalc-lite4/src/packages/util/db-schema/file-use.ts)
   - postgres accessors in [file-access.ts](/home/wstein/build/cocalc-lite4/src/packages/database/postgres/paths/file-access.ts)

2. `file_access_log`
   - append-ish access log already exists
   - also accessed in [file-access.ts](/home/wstein/build/cocalc-lite4/src/packages/database/postgres/paths/file-access.ts)
   - course/file-use-times features already depend on it via [file-use-times.ts](/home/wstein/build/cocalc-lite4/src/packages/server/conat/api/file-use-times.ts)

## Problems With Current Design

1. `file_use` conflates three unrelated concerns.
   - live presence
   - unread/seen state
   - recent activity list

2. The data model is awkward for Postgres.
   - `users` is a JSON blob
   - per-user state and per-document state are mixed together
   - writes are implemented as insert + jsonb merge

3. The frontend depends on live changefeed semantics for a panel that does not need it.

4. Chat unread currently depends on document activity state.
   - [chat/utils.ts:141](/home/wstein/build/cocalc-lite4/src/packages/frontend/chat/utils.ts:141)
   - [chat-indicator.tsx:83](/home/wstein/build/cocalc-lite4/src/packages/frontend/chat/chat-indicator.tsx:83)

5. The bell count is still a separate category/counter even though the product direction is:
   - one notifications page
   - one counter

## Replacement Architecture

## A. Document Presence

### Purpose

Show other users who are actively viewing/editing a given document.

### Scope

- replaces the `UsersViewing` dependency on `file_use`
- may optionally replace the live collaborator aspect of `ChatIndicator`
- does not power unread state
- does not power the bell panel

### Data shape

Suggested payload:

```ts
interface DocumentPresenceEvent {
  project_id: string;
  path: string;
  account_id: string;
  mode: "open" | "edit";
  ts: number;
}
```

### Transport

- ephemeral pub/sub stream
- keyed by `project_id + path`
- TTL-based presence
- browser sends heartbeats while a document is open

### Behavior

- presence expires automatically after a short TTL, e.g. 30-60 seconds
- edit mode can be refreshed more frequently than open mode if useful
- no database persistence required

### First migration target

Rewrite:

- [users-viewing.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/account/avatar/users-viewing.tsx)

So it no longer reads:

- `redux.getStore("file_use")?.get_active_users(...)`

Instead it should subscribe to the new presence service for:

- a specific file
- or a project-wide aggregate if needed later

## B. Chat Unread

### Purpose

Drive the red/new chat state in:

- [chat-indicator.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/chat/chat-indicator.tsx)

### Current problem

Today chat unread is derived from:

- `file_use.users[account_id].chat`
- `file_use.users[account_id].chatseen`
- `file_use.users[account_id].read`

That is the wrong abstraction.

### Replacement

Use chat-native state:

- newest chat timestamp for `(project_id, path)`
- user's last chat-seen timestamp for `(project_id, path, account_id)`

Minimal product behavior:

- `isNewChat = last_chat_seen < newest_chat_time`

### Notes

- This does not require threaded-discussion complexity.
- It only needs "has this file’s chat changed since I last looked?"

## C. Document Activity Panel

### Purpose

Replace the current bell panel:

- [page.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/page.tsx)

with an explicit-fetch surface.

### Product direction

This should be folded into notifications rather than living as a fully separate live category.

Possible end-state naming:

- `Recent Document Activity`

inside the notifications page.

### Fetch model

No changefeed.

Load on:

- opening the notifications activity section
- explicit refresh click
- optional gentle polling while visible

### Suggested RPC

Either:

- `account.listRecentDocumentActivity`

or:

- `projects.listRecentDocumentActivity`

The account-scoped form is cleaner for the UI because the current panel is account-centric.

### Response shape

```ts
interface RecentDocumentActivityRow {
  project_id: string;
  path: string;
  last_activity: Date;
  last_actor_account_id?: string;
  has_unread_edits: boolean;
  has_unread_chat: boolean;
  active_users?: Array<{
    account_id: string;
    last_used: Date;
    mode: "open" | "edit";
  }>;
}
```

The `active_users` field is optional if we want to render avatars inside the panel without a second fetch.

### Implementation shortcut that was used

The initial RPC/panel split happened before the final schema deletion. After the
activity panel was moved to explicit fetch, the remaining `file_use` runtime
paths were deleted.

## Persistence Plan

Do not keep `file_use` long term.

### Keep

- `file_access_log`
  - for access history
  - for course exports
  - for long-term analytics

### Replace

- live presence from `file_use`
  - replaced by ephemeral pub/sub

- unread/seen per-file state from `file_use`
  - replaced by explicit per-user document-activity state if the panel still needs it
  - or reduced to lightweight "last_seen" metadata

- bell list query from `file_use`
  - replaced by RPC query over:
    - `file_access_log`
    - chat state
    - possibly a new summary table if query cost becomes a problem

### If a summary table becomes necessary

Prefer a new table with one row per `(account_id, project_id, path)` and explicit columns, instead of reviving `file_use`.

Example:

```ts
document_activity_summary(
  account_id,
  project_id,
  path,
  last_open_at,
  last_edit_at,
  last_chat_at,
  last_seen_at,
  last_chat_seen_at
)
```

That is much cleaner than `users: jsonb`.

## Migration Order

All phases below are complete.

## Phase 1: Split out live presence

Status: DONE

### Deliverable

`UsersViewing` no longer depends on `file_use`.

### Work

1. Add a small document presence service.
2. Publish heartbeats from open editors.
3. Subscribe from:
   - [users-viewing.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/account/avatar/users-viewing.tsx)
4. Leave the bell panel untouched for now.

### Success criteria

- avatars continue to appear for concurrent viewers
- `file_use` is no longer required for that

## Phase 2: Split chat unread off `file_use`

Status: DONE

### Deliverable

`ChatIndicator` no longer reads `file_use`.

### Work

1. Add chat-native unread tracking.
2. Replace:
   - [chat/utils.ts:141](/home/wstein/build/cocalc-lite4/src/packages/frontend/chat/utils.ts:141)
   - [chat-indicator.tsx:83](/home/wstein/build/cocalc-lite4/src/packages/frontend/chat/chat-indicator.tsx:83)

### Success criteria

- document chat button still turns red/new when appropriate
- no `file_use` read path remains in chat UI

## Phase 3: Move the panel to explicit fetch

Status: DONE

### Deliverable

The recent document activity panel no longer uses a synctable/changefeed.

### Work

1. Add RPC for recent document activity.
2. Replace:
   - [file-use/init.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/init.ts)
   - [file-use/table.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/table.ts)
3. Convert [page.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/page.tsx) and [viewer.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/viewer.tsx) to fetch/refresh.
4. Collapse the bell counter into the main notifications counter.

### Success criteria

- opening the panel fetches fresh data
- refresh button works
- no `file_use` synctable is created in the browser

## Phase 4: Delete `file_use`

Status: DONE

### Deliverable

No browser or server product path depends on the `file_use` table.

### Work

Completed:

1. Removed the frontend store/table layer and renamed the surviving action shim
   to `document_activity`.
2. Removed `file_use` dependencies from presence, chat unread, and the activity UI.
3. Removed backend `record_file_use` / `get_file_use` product usage.
4. Deleted the schema and remaining CRM/admin compatibility surfaces.

## Risks / Notes

1. `UsersViewing` may currently rely on project-wide aggregation behavior from `get_active_users`.
   - If that is still needed in explorer/activity views, the presence service should support project-level aggregation or a separate helper query.

2. Course exports already use `file_access_log`, not `file_use`.
   - That is good and reduces migration risk.

3. We should not invent a new generic changefeed abstraction for this.
   - The right shape is one small presence mechanism plus one explicit fetch model.

4. `file_use` currently updates project `last_edited` side effects indirectly via `db.touch` in the schema hook.
   - Preserve any truly needed touch/log side effects when removing writes.

## Result

This plan is complete and can now be treated as historical documentation of the
migration rather than an active implementation plan.
