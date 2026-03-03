# CoCalc Git Review State Schema (Codex Git Browser)

## Purpose

Define concrete state, storage keys, and sync semantics for:

- commit review metadata (`reviewed`, note),
- inline diff comments,
- incremental submit-to-agent workflow,
- persistence across refreshes/projects/workspaces for the same commit.

This is design-only (no implementation code in this doc).

---

## Operator Principles

These product principles drive the git-browser + agent-review workflow:

1. **Context switching** should be easy
   - Agent work includes unavoidable wait states (tests/builds/long turns).
   - UI should make pausing/resuming threads cheap: clear thread identity,
     visual differentiation, and fast re-entry.

2. **Reading AI-generated code** should be first-class
   - Users should be able to inspect diffs, mark reviewed state, and leave
     durable comments tied to stable commit snapshots.
   - Review UX is not optional polish; it is core trust/safety infrastructure.

3. Optimize for **finishing problems end-to-end**
   - The system should encourage iterative review -&gt; feedback -&gt; follow-up turns
     instead of one-shot responses and early abandonment.
   - Submit-to-agent from structured review comments is a key mechanism for
     maintaining momentum to completion.

---

## Product Rule

Review annotations are **commit-only**.

- Inline comments are enabled only when viewing a real commit SHA.
- `HEAD` mode does **not** support inline review comments or review-note persistence.
- `HEAD` mode is for staging, inspecting uncommitted work, and committing.

Rationale:

- commit diffs are stable and portable across projects/clones;
- `HEAD` anchors are unstable and create ambiguous comment ownership;
- this keeps alpha behavior predictable and low risk.

---

## Storage Layout

## AKV Stores (account-scoped)

### Store A (canonical review store)

- name: `cocalc-git-review-v2`
- scope: `account_id`
- key:
  - `commit:<sha1-40>`

### Store B (legacy fallback)

- name: `cocalc-commit-review-v1`
- scope: `account_id`
- key: `<sha>`

Used only for migration fallback.

## localStorage

For commit review drafts:

- `cocalc:git-review:draft:v2:commit:<sha>`

For HEAD UI convenience only (non-review):

- optional `cocalc:git-head-ui:v1:<repo_fingerprint>`
  - commit message draft,
  - staging UI selections.

No HEAD review comments are persisted because HEAD has no review comments.

---

## Canonical Record Schema (commit-only)

```ts
type GitReviewRecordV2 = {
  version: 2;
  account_id: string;
  commit_sha: string; // full 40-char sha

  reviewed: boolean;
  note: string;

  comments: Record<string, GitReviewCommentV2>;

  // last successful "send to agent" watermark
  last_submitted_at?: number;
  last_submission_turn_id?: string;

  created_at: number;
  updated_at: number;
  revision: number; // increment on each persisted write
};

type GitReviewCommentV2 = {
  id: string; // uuid

  file_path: string;
  side: "new" | "old" | "context";
  line?: number; // rendered line anchor if available
  hunk_header?: string; // "@@ -a,b +c,d @@"
  hunk_hash?: string; // stable hash of hunk header + nearby lines
  snippet?: string; // small surrounding context shown in UI

  body_md: string; // markdown/rich-text serialized payload

  status: "draft" | "submitted" | "resolved";
  submitted_at?: number;
  submission_turn_id?: string;

  created_at: number;
  updated_at: number;
  local_revision: number;
};
```

---

## Merge & Sync Rules

## Load pipeline (commit view)

For selected commit SHA:

1. Load AKV record (if any).
2. Load localStorage draft (if any).
3. Merge by object timestamp/revision:
   - top-level fields: choose larger `updated_at`,
   - per-comment: choose larger `updated_at`, tie-break by larger `local_revision`,
   - tombstones (resolved/deleted) win by newer timestamp.
4. Render merged state.

For HEAD:

- do not load review/comment records.

## Write policy (commit view)

- On each user edit:
  - update in-memory state immediately,
  - write localStorage immediately (or short debounce, e.g. 250ms),
  - mark `dirty=true`.

- AKV flush:
  - periodic every 15s while dirty,
  - on explicit save action,
  - on drawer close,
  - on beforeunload best-effort.

- AKV writes store full record for that commit key (small, human-authored payload).

## Conflict policy

Last-write-wins by `updated_at` + `revision`; per-comment merge by `id`.

No hard locking required for alpha.

---

## Submit-to-Agent Semantics (commit view)

## Which comments are sent

Send only comments that are currently actionable:

- `status === "draft"` and
- (`submitted_at` missing OR `updated_at > submitted_at`).

## After successful send

For comments included in payload:

- set `status = "submitted"`,
- set `submitted_at = now`,
- set `submission_turn_id = <turn_id>`.

If a submitted comment is edited later:

- transition back to `status = "draft"`,
- include it in the next submit.

## Prompt payload format

Embed structured review payload in markdown fenced JSON:

```json
{
  "target": {
    "git_command": "git show --no-color -U3 <sha>"
  },
  "comments": [
    {
      "file_path": "src/foo.ts",
      "side": "new",
      "line": 124,
      "hunk_header": "@@ -120,6 +124,9 @@",
      "snippet": "const x = ...",
      "comment": "Please ...",
      "id": "..."
    }
  ]
}
```

---

## UI Mapping

## Commit mode

- show `Reviewed` checkbox + `note` editor,
- inline comments visible and editable,
- `Send review to agent` button enabled when actionable drafts exist.

## HEAD mode

- replace reviewed/note/comment UI with commit panel:
  - commit message input (placeholder:
    `or leave blank to let the agent write the message`),
  - buttons:
    - `Commit`
    - `Commit with AI Summary`
- no commit-on-blur.
- no inline review comments in HEAD mode.

### HEAD staging helpers

When viewing `HEAD`, show a compact file list for uncommitted and not-ignored paths:

- modified tracked files,
- deleted tracked files,
- untracked files.

Each row:

- file path,
- status label (`modified`, `added`, `deleted`, `untracked`),
- `Open` button.

For **untracked** files only:

- `Add` button (track this path),
- `Ignore` button (append exact path to `.gitignore`).

Recommended commands:

- list: `git status --porcelain=v1 --untracked-files=all`

Commit button behavior:

- `Commit` + nonempty input: direct `git commit -a -m` (all tracked changes only).
- `Commit` + empty input: create agent turn `"Please commit all tracked changes"`.
- `Commit with AI Summary`: always create agent turn; if text provided, require it as first line and include a detailed body.
- Untracked files are shown but explicitly excluded from this one-click commit path.

---

## Migration Plan

When loading commit `X` with no v2 record:

1. read legacy `cocalc-commit-review-v1` key `<sha>`,
2. map to `GitReviewRecordV2` with:
   - `reviewed`, `note`,
   - empty `comments`,
3. persist to `cocalc-git-review-v2` key `commit:<sha>`.

No destructive migration required.

---

## Minimal APIs (frontend service layer)

```ts
loadReviewRecord(commitSha): Promise<GitReviewRecordV2>
saveReviewRecord(commitSha, record): Promise<void>
saveDraftLocal(commitSha, record): void
loadDraftLocal(commitSha): GitReviewRecordV2 | undefined
collectActionableComments(record): GitReviewCommentV2[]
markSubmitted(record, ids, turnId, now): GitReviewRecordV2
```

For HEAD mode:

```ts
loadHeadUiDraft(repoFingerprint): HeadUiDraft | undefined
saveHeadUiDraft(repoFingerprint, draft): void
listHeadStatus(repoRoot): Promise<StatusEntry[]>
addPath(repoRoot, path): Promise<void>
ignorePath(repoRoot, path): Promise<void>
```

---

## Import / Export (Portability)

Add account-level import/export so review state can move between environments
(e.g., laptop -> launchpad) without copying sqlite files.

## Export scope

- Export **all** commit review records for current account from `cocalc-git-review-v2`.
- Include metadata for format version and export timestamp.

Example top-level shape:

```json
{
  "format": "cocalc-git-review-export-v1",
  "exported_at": 1760000000000,
  "records": {
    "commit:abc123...": { "...GitReviewRecordV2..." },
    "commit:def456...": { "...GitReviewRecordV2..." }
  }
}
```

## Import behavior

- Import file merges into current account state (never destructive replace by default).
- Per-key merge policy:
  - if key missing locally -> insert,
  - if key exists -> field/comment merge using existing timestamp/revision rules.
- Invalid/malformed records are skipped with per-record error reporting.

## UX entry points

- In git browser actions/menu:
  - `Export reviews (.json)`
  - `Import reviews (.json)`

## Safety

- Show summary before applying import:
  - `new keys`, `updated keys`, `skipped keys`.
- Keep one local backup snapshot before applying import for rollback.

---

## Chat Linkage Ideas (Planned, not yet implemented)

1. Commit-aware in-thread search shortcut:
   - In git browser, add a `Find in chat` action for selected commit.
   - It should open in-thread search and prefill commit SHA.
   - Search should include backend/offloaded chat messages.

2. Direct human commits should still be logged in chat:
   - For direct `git commit -a -m` path, append a chat message in the codex thread with commit SHA and subject.
   - This is a log-only chat event (no agent turn triggered).
   - Goal: keep commit context discoverable via chat search.

---

## Acceptance Criteria

1. Comments for commit `X` appear across different repo roots/workspaces for the same account.
2. HEAD mode does not expose inline review comments.
3. AKV updates no more than periodic flush + explicit events (not every keystroke).
4. Submit sends only changed draft comments since prior submission.
5. After submit, edited comments become draft again and can be re-submitted.

---

## Implementation Checklist (First Pass)

1. Add `GitReviewRecordV2` types + key helpers:
   - canonical AKV key helper for `commit:<sha>`,
   - localStorage helper for commit review drafts.
2. Build storage adapter module:
   - `loadRecord`, `saveRecord`, `loadLocalDraft`, `saveLocalDraft`,
   - merge function (AKV + local) with timestamp/revision policy.
3. Wire drawer state to adapter (read path):
   - load on open/commit change,
   - migrate from `cocalc-commit-review-v1` when needed.
4. Wire drawer state to adapter (write path):
   - local save on each edit (debounced),
   - AKV flush timer (15s) + on close + explicit save.
5. Enforce commit-only review mode:
   - hide/disable inline comment affordances and review form on `HEAD`.
6. Implement HEAD commit panel:
   - commit message input,
   - `Commit` and `Commit with AI Summary` actions.
7. Implement HEAD status helpers:
   - file/status list from `git status --porcelain`,
   - clear tracked vs untracked labeling,
   - untracked-only `Add` / `Ignore` controls,
   - one-click commit path remains tracked-only (`git commit -a`).
8. Implement submit flow (commit mode only):
   - collect actionable draft comments,
   - emit structured payload to agent turn,
   - mark submitted comments with `submitted_at`/`submission_turn_id`.
9. Add regression tests:
   - merge rules,
   - migration,
   - submit delta behavior,
   - HEAD mode excludes review comments.
10. Add dev-only telemetry/logs:

   - load/flush events and submit counts for rollout confidence.

11. Implement import/export:

   - account-wide JSON export,
   - merge import with dry-run summary and backup snapshot.
