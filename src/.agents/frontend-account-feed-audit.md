## Frontend Account-Scoped Realtime Audit

Date: 2026-04-04

This audit focuses on **frontend account-scoped live data paths** that still
use `Table` / `sync_table` / database changefeeds instead of the new shared
home-bay account feed.

It intentionally excludes:

- project-local sync paths in `project_store.ts`
- editor-local/project-local changefeeds
- backend-only or admin-only implementation details unless they affect a
  normal signed-in browser session

## Already moved to the shared account feed

- `projects`
  - `/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/actions.ts`
  - `/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/table.ts`
- `users` / collaborators
  - `/home/wstein/build/cocalc-lite4/src/packages/frontend/users/table.ts`
- notifications
  - `/home/wstein/build/cocalc-lite4/src/packages/frontend/notifications/mentions/actions.ts`

These now use:

- snapshot/bootstrap from projection-backed queries
- `dstream(account-feed)` for live deltas
- `history-gap` => explicit resync

## Remaining account/global changefeed-backed surfaces

### 1. Account row

- `/home/wstein/build/cocalc-lite4/src/packages/frontend/account/table.ts`
- bootstrap:
  - `/home/wstein/build/cocalc-lite4/src/packages/frontend/account/table-bootstrap.ts`

What it does:

- drives the core signed-in account store
- emits `is_ready`
- carries important account-scoped state:
  - `home_bay_id`
  - billing/balance fields
  - names/email
  - editor settings / other settings
  - `unread_message_count`

Assessment:

- **This is the most important remaining account-scoped changefeed.**
- If we want one real home-bay browser channel, this is eventually a feed
  candidate.
- However, it is also a central readiness/bootstrap dependency, so it should be
  migrated carefully, not opportunistically.

Recommendation:

- **Move to account feed later**, but not before we define the right core
  account event contract.
- This is a real Phase 3/4 target, not something to leave indefinitely.

### 2. Messages inbox

- `/home/wstein/build/cocalc-lite4/src/packages/frontend/messages/redux.ts`

What it does:

- `messages` and `sent_messages` live tables
- central account inbox UI

Assessment:

- Architecturally, this is account-scoped and would fit the account feed.
- Product-wise, the future of central messages is not settled. We already think
  this system may be replaced by the greenfield notification model.

Recommendation:

- **Do not invest in an account-feed migration yet.**
- Either:
  - leave as-is temporarily, or
  - later replace it as part of the messages -> notifications decision
- This should not block Phase 3 completion.

### 3. Groups

- `/home/wstein/build/cocalc-lite4/src/packages/frontend/groups/redux.ts`

What it does:

- user-owned / user-visible groups table
- low-frequency CRUD and membership editing

Assessment:

- Account-scoped, but not a high-frequency top-level UI surface.
- Not worth spending shared account-feed complexity on right now.

Recommendation:

- **Explicit refresh is fine.**
- If needed later, convert to a small RPC-backed refresh path rather than a
  changefeed-preserving compatibility layer.

### 4. News

- `/home/wstein/build/cocalc-lite4/src/packages/frontend/notifications/news/init.ts`

What it does:

- subscribes to `news`
- computes unread count relative to account setting `news_read_until`

Assessment:

- This should not be treated like targeted per-account notifications.
- It belongs to the separate publication/publications design we discussed.

Recommendation:

- **Do not move this to the account feed as-is.**
- Replace later using the `publication_events` / per-account publication state
  model.
- Separate source, shared badge/page is fine.

### 5. File use

- `/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/table.ts`
- `/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/init.ts`
- `/home/wstein/build/cocalc-lite4/src/packages/frontend/file-use/actions.ts`

What it does:

- global collaborator file activity popup/badge
- noisy and mostly configuration-free

Assessment:

- We explicitly do **not** want to preserve this as a realtime account-feed
  feature.
- The correct replacement is explicit, rule-based notifications, not a global
  changefeed of collaborator activity.

Recommendation:

- **Do not migrate.**
- Either leave temporarily or retire when the new notification rules model is
  implemented.
- If anything is needed short-term, a manual refresh button is enough.

### 6. System notifications

- `/home/wstein/build/cocalc-lite4/src/packages/frontend/system-notifications.ts`

What it does:

- admin/system-wide notification table
- uses local storage to suppress repeated alerts

Assessment:

- Not a normal account-scoped browser surface.
- Small, special-purpose, likely admin-ish.

Recommendation:

- **Leave alone for now.**
- No Phase 3 work needed here.

## Direct `sync_table(...)` usages that are not part of the account-feed target

### Admin project views

- `/home/wstein/build/cocalc-lite4/src/packages/frontend/project/settings/settings.tsx`
- `/home/wstein/build/cocalc-lite4/src/packages/frontend/project/page/common.tsx`

What they do:

- open `projects_admin` synctables for admin-only project views

Assessment:

- project-scoped, admin-only, explicitly local to one viewed project

Recommendation:

- **Explicit refresh is fine.**
- Do not move these to the account feed.

## Dead or transitional code to remove

### Legacy MentionsTable

- `/home/wstein/build/cocalc-lite4/src/packages/frontend/notifications/mentions/table.ts`

Assessment:

- The new notifications page no longer uses the `mentions` database table as
  its live source.
- This class is now legacy scaffolding.

Recommendation:

- **Delete this path** once imports and any remaining callers are cleaned up.

## Recommended next steps

### High priority

1. Remove the dead legacy mentions-table frontend path.
2. Decide whether the `account` row should be the next shared account-feed
   migration target.

### Medium priority

3. Replace or retire `file_use` instead of migrating it.
4. Leave `messages` alone until the product decision is made.

### Low priority

5. Convert `groups` to explicit refresh if the current changefeed becomes a
   maintenance problem.
6. Leave admin project views and system notifications alone.

## Bottom line

After projects, collaborators, and notifications, the only **core**
account-scoped changefeed left is the **account row itself**. Most of the other
remaining frontend changefeed users should **not** be migrated to the shared
account feed:

- `file_use`: retire/replace
- `messages`: product decision first
- `news`: publication model, not account-feed deltas
- `groups`: refresh is fine
- admin project views: refresh is fine
