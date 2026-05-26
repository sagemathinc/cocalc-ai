# Docs Private Notes And Stars Spec

Status: implemented v1
Date: 2026-05-25

## Goal

Add per-account private docs state so users can mark useful docs pages, keep
private notes about them, and later search/filter their own annotations.

This should feel like the private git review note UI, but it must be
account-global rather than project-scoped:

- stars and notes are private to the signed-in account
- state follows the account across projects
- state is stored on the account home bay
- export/import works efficiently and can be used for backup, debugging, and
  account migration verification
- this appears only inside the signed-in app docs; the public landing-page docs
  remain static and do not show private notes or stars

## User Experience

Each docs detail page should include a compact private-state box near the top of
the page, after the title/summary/visual hook and before the documentation body.

The v1 box includes:

- a star toggle for the page
- an Add Note button that opens a private note composer on demand
- a list of existing private notes for that page
- save/edit/delete controls for each note
- a short privacy line: "Private to you. Export creates a JSON backup or
  transfer file only when you choose."

The visual style should be close to the git review private note box in chat:
quiet border, white background, small status text, Markdown editing, and
minimal chrome. The implementation should reuse the mature git review editor
primitives where possible instead of recreating focus/blur/save behavior.

## Index And Search UX

The docs index should expose filters:

- All
- Starred
- Unstarred
- With notes

Search should include:

- docs title
- summary
- body text
- private note text

When a result matches private notes, the UI should make that clear, e.g.
"matched your private notes", without mixing private note text into the public
docs content.

Category filters should combine with star/note filters. Example: a user can
open Teaching docs and show only unstarred pages, then star pages as they read
through them.

## Non-Goals

Do not make notes collaborative.

Do not store notes in project files.

Do not send notes to Codex, agents, support, or collaborators by default.

Do not require a project id to read or write this state.

Do not make stars public recommendations or product analytics in this first
version.

Export/import is for portability and backup, not collaboration. The motivating
workflow is: use CoCalc site X for a while, export docs state as a JSON blob,
then import that state on CoCalc site Y or keep it as a trustworthy local
backup.

## Data Model

Use two logical record types: page state and note records.

Page state is one record per docs entry:

```ts
type DocsPageStateV1 = {
  version: 1;
  account_id: string;
  entry_id: string;
  slug: string;
  starred: boolean;
  starred_updated_at?: number;
  last_viewed_at?: number;
  created_at: number;
  updated_at: number;
  revision: number;
};
```

Private notes are separate records, not a single note blob on the page state:

```ts
type DocsPageNoteV1 = {
  version: 1;
  account_id: string;
  note_id: string;
  entry_id: string;
  slug: string;
  body_md: string;
  body_hash: string;
  created_at: number;
  updated_at: number;
  deleted_at?: number;
  revision: number;
};
```

Use `entry_id` as the durable docs identity. Store `slug` as a repairable
display/routing hint because slugs can change.

Use one note id per note. New notes get a random stable id. Imported notes keep
their ids when possible.

`body_hash` should be a stable hash of normalized note text. It is used only for
deduplicating imports when the same note arrives with different ids.

## Storage

Use account-scoped Conat persistence, following the git review store pattern:

- account-private data lives in the account home bay
- the frontend accesses it through the account DKV/conat-persist helpers
- bulk export/import uses the shared account DKV path, not many single-record
  RPC calls

Suggested store name:

```ts
const DOCS_PRIVATE_STATE_STORE = "cocalc-docs-private-state-v1";
```

Suggested keys:

```ts
page:<entry_id>
note:<entry_id>:<note_id>
```

This keeps filtering by page simple and makes full export/import efficient.

## Account Home Bay Requirement

This state is account-owned, not project-owned. It must move when an account's
`home_bay_id` moves.

Implementation status: account-scoped conat-persist/DKV state now moves during
account rehome. The local multibay smoke test moved account
`aedd0458-e4ed-426f-9ecc-67886d097608` from `bay-1` to `bay-0` after creating
docs private state. The `cocalc-docs-private-state-v1.db` files moved to the
new home bay, the old bay copy was removed, and the frontend preserved the
starred docs page and note after browser refresh.

Expected account move behavior:

1. Stop or fence writes for the account state being moved.
2. Copy the account-scoped conat-persist directory from the old home bay to the
   new home bay.
3. Verify copied data is readable from the new home bay.
4. Switch `home_bay_id`.
5. Resume writes on the new home bay.
6. Delete the old copy only after verification and successful cutover.

The exact implementation may differ, but the invariant must hold: account-level
private docs state and git review state follow the account home bay.

## Import And Export

Export format:

```ts
type DocsPrivateStateExportV1 = {
  kind: "cocalc-docs-private-state-export-v1";
  version: 1;
  exported_at: number;
  pages: DocsPageStateV1[];
  notes: DocsPageNoteV1[];
};
```

Export should:

- include all page state records for the account
- include all non-deleted notes by default
- optionally include deleted tombstones for debugging if a future UI needs that
- sort pages by `updated_at` descending, then `entry_id`
- sort notes by `updated_at` descending, then `entry_id`, then `note_id`

Import should merge:

- page state by `entry_id`
- notes by `note_id`
- duplicate notes by `body_hash` within the same `entry_id`

Page state merge rules:

- `starred` is resolved by the newer `starred_updated_at`
- `last_viewed_at` keeps the newer timestamp
- `slug` is updated to the current local docs slug when the `entry_id` exists
- `updated_at` becomes the max relevant timestamp

Note merge rules:

- if a local note with the same `note_id` is newer, keep local
- if an imported note with the same `note_id` is newer, keep imported
- if note ids differ but `entry_id` and `body_hash` match, treat as duplicate
  and keep the newer timestamp/metadata
- if note text differs, keep both notes
- do not create duplicate visible notes for identical imported text

Import should return counts:

```ts
{
  importedPages: number;
  importedNotes: number;
  skippedPages: number;
  skippedNotes: number;
  deduplicatedNotes: number;
  totalPages: number;
  totalNotes: number;
}
```

## Reuse From Git Review

The git review code already solved several hard problems:

- account-scoped conat-persist storage
- bulk export/import
- local draft behavior
- robust Markdown note editing
- focus/blur/save/cancel ordering
- tests around persistence and import/export

Do not copy this code wholesale.

Extract or share small generic pieces where they are genuinely common:

- account-private DKV bulk helpers
- import/export sorting and result shapes
- sanitized record helpers
- private Markdown note editor primitives

Git review remains commit-specific. Docs private state remains docs-entry
specific. The shared layer should not know about commits or docs pages.

## Frontend Components

Recommended modules:

- `frontend/docs/private-state/store.ts`
- `frontend/docs/private-state/types.ts`
- `frontend/docs/private-state/import-export.ts`
- `frontend/docs/private-state/private-notes-panel.tsx`
- optionally a shared `frontend/account-private-state/*` helper if refactoring
  git review first proves clean

The docs browser should load private state once per signed-in account and pass
the relevant page state/notes into detail and index components.

Anonymous users should see public docs without private-state UI.

Public landing-page docs should also omit private-state UI even when a browser
has an active signed-in session. Private notes and stars are an in-app reading
workflow, not part of the SEO/public docs surface.

If private state fails to load:

- docs still render
- the private box shows a small unavailable/error state
- users should not lose local edits silently

## Tests

Unit tests should cover:

- sanitize page state records
- sanitize note records
- export order
- import page-state merge by timestamps
- import note merge by `note_id`
- import note dedupe by `entry_id` + `body_hash`
- slug repair when local docs contain the `entry_id`
- no project id required
- anonymous users do not render private controls
- search can match note text
- starred/unstarred/with-notes filters

Integration/UI tests should cover:

- star a docs page, reload, star persists
- create/edit/delete a private note
- note text appears in docs search results for that account
- exported data imports into a fresh account store without duplicates

Home-bay tests should cover:

- account move includes account-scoped conat-persist data, or
- account move explicitly fails release validation until that migration exists

## Rollout Plan

1. Done: Audit account home bay move behavior for account-scoped conat-persist/DKV
   data.
2. Done: Extract minimal reusable helpers from git review storage/import/export if
   the extraction is straightforward.
3. Done: Implement docs private state storage and import/export.
4. Done: Add the private notes/star panel to docs detail pages.
5. Done: Add docs index filters and note-aware search.
6. Done: Add import/export UI.
7. In progress: Add validation tests and browser checks.

## Open Questions

- Should deleted notes be kept as tombstones forever, for a limited period, or
  only during import/export conflict handling? (ANS: I'm fine with just a limited period; it's not a big deal -- these are just private notes.)
- Should `last_viewed_at` be part of the first UI, or only stored for future
  "read/unread" workflows? (ANS: It would be nice to have some subtle UI once we have this that indicates the doc has been read before, and also if there were updates after that.)
- Where should import/export controls live: docs index toolbar, account
  settings, or both? (ANS: just docs index toolbar -- like with git review. Where you can find it, basically.)
- Should note search show snippets, or only indicate that private notes matched? (ans: just say there's a match)
