# TimeTravel UI Enhancement Spec

## Scope
This document defines a frontend-focused redesign and cleanup plan for TimeTravel UI across sources:
- TimeTravel (sync/patch history)
- Git history
- Snapshots
- Backups

Primary area:
- `src/packages/frontend/frame-editors/time-travel-editor/`

Related planning input:
- GitHub issue #8328: https://github.com/sagemathinc/cocalc/issues/8328

## Context and Constraints
- Snapshots and backups are now in scope.
- Snapshot browsing/indexing foundations are already implemented and live.
- Backup index lookup (versions by file+time) is fast, but fetching backup file content is slow.
- `lite` mode is single-user/local focused and should avoid nonessential remote-history complexity.

## Goals
1. Make mode/state obvious: source, single vs compare, rendered vs source text.
2. Make Git commit presentation similar to GitHub conventions.
3. Remove misleading terminology (especially current `Revert`).
4. Support snapshots and backups as first-class sources (with sensible gating/fallback).
5. Keep controls discoverable and efficient for common workflows.

## Non-Goals
- Backend patch storage redesign.
- Full visual redesign of all editors.
- Making backup content retrieval low-latency (this is backend/infrastructure).

## Terminology
Current `Revert` action is not Git revert; it sets current file content to displayed historical content and creates a new current revision.

### Required rename
- Use: `Restore This Version`
- Do not use: `Revert`

## UX Model

### Top Mode Row
Use explicit selectors (not ambiguous checkboxes):
- `Source`: `TimeTravel | Git | Snapshots | Backups`
- `View`: `Rendered | Source`
- `Display`: `Single Version | Compare Changes`
- `Slider Labels`: `Revision # | Timestamp`

Notes:
- In non-lite mode, Snapshots and Backups should appear as first-class options.
- In lite mode, unavailable/irrelevant sources may be hidden or disabled for simplicity.
- Keep unavailable choices visibly disabled when that improves discoverability.

### Revision Rows
- Single mode: one revision row + full summary.
- Compare mode: revision A row and revision B row + summaries.
- Keep diff slider below rows.

### Action Row
- Left: history loading controls when relevant.
- Center: slider.
- Right: `Restore This Version` (single mode only), plus export/open utilities.

## Git Source Enhancements

### Commit Metadata to Display
For selected commit:
- Subject
- Short hash (first 6-8 chars shown)
- Author name
- Timestamp (localized absolute; optional relative in tooltip)

### Additional files changed in commit
For selected commit, display a compact list of other changed files in that commit.
- Each file should be clickable.
- Clicking opens that file in a new tab and opens TimeTravel in Git mode at the same commit.

### Compare Mode Commit Log Modal
Add `Show commits in range` action:
- Shows compact commit list for selected range.
- Each row: short hash, subject, author, timestamp.
- Short hash click copies full hash.

## Snapshots and Backups Source UX

### Snapshots
- Treat as normal fast source in non-lite mode.
- Supports single/compare and regular timeline behavior where data permits.

### Backups
- Use two-stage UX due slow content fetch:
  1. Fast listing/search over indexed backup versions.
  2. Explicit fetch/open step for specific backup content.
- Surface loading/progress clearly; avoid blocking whole TimeTravel UI.

## Changes/Compare Semantics
- In compare mode, hide/disable restore action with explicit message:
  - `Choose one version first to restore.`
- Never imply a range restore operation.

## Date/Locale Policy
- Use account/user locale formatting for absolute timestamps.
- Avoid raw epoch/ms display in UI.

## Slider Hover
- Desired: show useful hover timestamp on slider positions.
- Known caveat: may be currently disabled due prior UI/performance/antd issues.
- Reintroduce only behind validation for performance and correctness.

## Data/Model Changes Needed
In `time-travel-editor/actions.ts`:
- Replace timestamp-keyed Git metadata assumptions with stable commit-entry model.
- Store: `hash`, `shortHash`, `authorName`, `authorEmail`, `subject`, `timestampMs`, `changedFiles[]`.
- Add APIs:
  - `gitCommit(version)`
  - `gitCommitRange(v0, v1)`
  - `gitCommitFiles(version)`

## Prioritized Implementation Checklist

### P0 (do first)
1. Rename action label and semantics cleanup (`Revert` -> `Restore This Version`) and remove restore from compare mode.
- Effort: Easy
2. Git single-commit header cleanup (subject, short hash, author, localized timestamp; remove punctuation artifacts).
- Effort: Medium
3. Remove raw epoch/ms text in compare metadata and normalize date rendering.
- Effort: Easy
4. Fix `Export` history JSON so `time_utc` is populated (currently null).
- Effort: Easy

### P1
4. Convert mode checkboxes to explicit selectors (`Source`, `View`, `Display`, `Slider Labels`).
- Effort: Medium
5. Implement stable Git commit metadata model in actions layer.
- Effort: Medium
6. Add `Show commits in range` modal with copy-full-hash behavior.
- Effort: Medium

### P2
7. Add “other files changed in commit” list and click-through open-at-same-commit flow.
- Effort: Hard
8. Integrate Snapshots as first-class source in selector for non-lite mode.
- Effort: Medium

### P3
9. Integrate Backups as first-class source with two-stage UX (fast index browse + explicit slow fetch).
- Effort: Hard
10. Reintroduce slider hover timestamp if performance/interaction is acceptable.
- Effort: Medium
11. Navigation icon/step semantics polish and control-row layout refinements.
- Effort: Medium

## Acceptance Criteria
- `Restore This Version` is the only restore label.
- Compare mode cannot trigger ambiguous restore behavior.
- Git single-commit view shows subject/hash/author/time in readable GitHub-like form.
- Commit range modal supports full-hash copy.
- Commit details include clickable changed-file list (when available).
- Timestamps are localized and never shown as raw epoch values.
- Snapshots and Backups are represented as source options (with mode-aware gating for lite/non-lite).

## Decisions Captured from Current Discussion
1. Confirm before restore in Git mode: **No**.
2. Range modal full hash copy: **Yes**.
3. Timestamp formatting locale-aware: **Yes**.
4. Snapshots first-class source now (non-lite): **Yes**.
5. Backups in scope now with distinct UX due slow content retrieval: **Yes**.
