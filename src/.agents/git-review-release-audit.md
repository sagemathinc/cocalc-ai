# Git review release audit

Companion to `git-review-modernization.md`. This is an evidence index, not a
replacement or reduction of its requirements. September 8, 2026; implementation
head `dd6d8f75ea`. Historical browser results retain the scope and limitations
recorded in the main plan.

## Current code and regression

| Requirement                    | Implementation and inspected evidence                                                                                                                                                                                                                                                                | Result                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Renderer-neutral identities    | `components/diff-viewer/review-model.ts` separates repository common directory, worktree, commit parent, comparison endpoints, working generation, source side and semantic location. Keys include target scope rather than display labels.                                                          | Inspected                                                               |
| Read-only repository browsing  | `git/read-service.test.ts` exercises real disposable repositories, unique/ambiguous/absent containment, detached/stale worktrees, literal paths, SHA-256, branch/tag ambiguity, pinned refs, merge parents, root commits, bounded concurrency/cache and unchanged checkout/index/dirty files.        | Current regression passed                                               |
| Worktree feedback routing      | `git/agent-worktree.test.ts` and real-Git validation reject stale HEAD/branch/path and changed navigation before dispatch. Main plan records two completed real cross-worktree executions and cleanup.                                                                                               | Component/service regression passed; live evidence recorded             |
| Branch and comparison UX       | `history-controls`, `branch-comparison`, `comparison-controls` and route tests cover searchable choices, merge visibility, pinned endpoints and edit-lock stale-result rejection. Main plan records exact message-anchor selection and fresh-tab comparison acceptance.                              | Current regression passed                                               |
| Existing review preservation   | `chat/__tests__/git-review-store.test.ts` and `git-target-review-store.test.ts` cover separate commit/target storage. Legacy-location tests preserve context evidence and expose unmatched anchors rather than guessing. Main plan records alias choice and two-window reconnect tests.              | 41 storage tests passed; anchor tests included in wider run             |
| Source copy, navigation, Trees | Legacy-location tests check literal leading operators and partial source columns; semantic scroll, search, tree expansion and header tests are in the wider run. Main plan records native clipboard across virtual windows, sticky headers, keyboard and narrow-layout acceptance.                   | Current regression passed; native browser evidence recorded             |
| Rich comments and uploads      | Main plan records real Slate delayed upload, image rendering after scroll, undo/redo, appearance/layout changes, two-window recovery and reconnect. Active editor lifecycle is retained outside recycled diff rows.                                                                                  | Live evidence recorded; not inferred from stubbed renderer tests        |
| TimeTravel                     | Shared text diff and historical Git source code remains separate from rich historical viewers and source-specific restore. Main plan records Git, patchflow, snapshot and backup comparisons/restores, plus rename/deletion sides.                                                                   | TimeTravel regression included in wider run; live evidence recorded     |
| Activity diffs                 | `activity-diff.tsx` lazy-loads Pierre. `activity-diff-source.ts` retains exact documents or validated sparse hunks and rejects incomplete inputs rather than reconstructing current files. `activity-pierre-diff.tsx` labels provenance and offers raw recorded data when no reliable source exists. | Inspected; 59 activity tests passed                                     |
| Activity context and producer  | Rendered activity tests retain an earlier event's directory after later terminal events; source tests cover sparse coordinates, operators, carriage returns and final newlines. ACP producer tests cover bounded read/write observations rather than atomic-snapshot claims.                         | 3 producer tests passed; frontend tests passed                          |
| Theme and worker lifecycle     | `highlighting-provider.tsx` uses a shared two-worker pool and failure reporting; Git renderer selects GitHub light/dark by resolved appearance. Main plan records worker cleanup/fallback, long-file benchmarks and production bundle comparisons.                                                   | Inspected; shared renderer regression passed; browser evidence recorded |
| Complete Classic removal       | No Classic renderer/selector or Prism references remain in the inspected Git review, TimeTravel diff and activity surfaces. Missing historical activity sources use an explicit raw-data disclosure, not another renderer.                                                                           | Inspected                                                               |
| Recent reading UX              | Main plan records outer-to-inner reading scroll at 768px, fixed commit subject, current Ant Design checkbox tests and localStorage details preference. Browser preference test covers native keyboard, commit changes and reload in both states.                                                     | Accepted and tested                                                     |

Current runs: 276 tests / 50 suites for Git review, shared diff, TimeTravel and
Git service; 59 tests / 6 suites for activity; 41 tests / 2 suites for storage;
3 tests / 1 suite for the ACP diff producer. Frontend typecheck and lint pass.
These counts describe distinct selected suites, not the entire monorepo.

## Release gates still being checked

- Current-head hosted CI run `34188828947` is in progress. Do not substitute the
  preceding head's successful frontend/build lanes for current-head completion.
- Finish the requirement-by-requirement source/evidence cross-check, including
  the plan's packaging, transport-limit and recovery details. Recorded live
  evidence is not a claim that every browser scenario was rerun at this head.
- Earlier intermittent loading/disappearance observations remain unreproduced,
  with bounded diagnostics retained. Three fresh-tab archived-context runs and
  current selectable-comparison runs passed. No demonstrated root-cause fix is
  claimed for the earlier observations.

Definition lookup/LSP, automatic Git checkout/stash/merge, global repository
discovery and GitHub PR synchronization remain explicitly excluded by the main
plan. No user-facing line-number jump control or Classic rollback option is
required; the maintainer explicitly rejected those.
