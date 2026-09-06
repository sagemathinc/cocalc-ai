# Git review modernization

Status: design and experimental Pierre preview, September 6, 2026. No renderer
migration or definition service has been approved by the prototype results yet.

## Objective

Make reading and discussing agent-produced code reliable across branches,
worktrees, historical documents, and long-running agent activity. Preserve rich
Slate comments with image paste, personal review records, keyboard navigation,
and responsiveness on large reviews.

## Existing surfaces

| Surface                                         | Input and current rendering                                                                                     | Integration constraint                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Git browser (`chat/git-commit-drawer.tsx`)      | `git show` / `git diff`, parsed patches, Prism, Virtuoso over files                                             | Comments, selected commits, review persistence, agent actions, search, scroll restoration                 |
| TimeTravel (`frame-editors/time-travel-editor`) | Two document versions, line-diff utility and CodeMirror                                                         | Preserve patchflow, Git, snapshots, backups, and specialized notebook/chat/Markdown viewers               |
| Codex activity (`chat/codex-activity.tsx`)      | `LineDiffResult` with content, operations, formatted line-number gutters and chunk boundaries; Prism/React rows | Often partial and uncommitted; cannot infer a Git revision or reconstruct complete files from these hunks |

The inline Markdown activity body also supports rich copy/paste. Replacing that
body's Slate renderer is not part of adopting a code diff renderer.

The Git browser's copy issue concerns copied `+`/`-` patch markers, not line
numbers. Clean source copying must preserve literal leading operators in the
source; stripping every leading plus/minus from selected text is incorrect.

TimeTravel already has `gitDoc`, `gitChangedFiles`, `openGitCommitFile`, and
specialized historical document viewers. However, `updateGitVersions` follows
the current checkout's file history, and `openGitCommitFile` requires the hash to
appear in that file's loaded history. Arbitrary-revision viewing must also work
when the file was unchanged in that commit, is off-branch, renamed, deleted, or
absent from the current checkout. Reuse and extend these APIs rather than
assuming the existing navigation method covers those cases.

## Phase 0: Pierre feasibility

Use `@pierre/diffs` through a small rendering adapter. The experimental preview
accepts either a patch or two complete text documents. It is loaded on demand
from the Git browser and TimeTravel. Opening freezes the input so an incoming
update cannot move temporary comments to a different revision. Its comments
are explicitly temporary and never enter the existing review store.

The initial dependency is pinned to 1.3.6: the 1.4 releases are younger than the
repository's three-day dependency age requirement on the evaluation date.
Evaluate newer versions normally after they meet that requirement.

The initial preview exercises CodeView, word highlighting, unified/split views,
old/new line navigation, and React annotations containing CoCalc's Markdown
editor. Full-document comparisons show expanded (virtualized) context so line
navigation reveals the requested line rather than a collapsed separator. Patch previews reject
line targets absent from supplied hunks; they do not read the working copy as
a substitute. The original renderer remains available for comparison.

### Acceptance gates

- Real large commits with many files, one huge file, long/minified lines,
  renames, deletions, Unicode paths, and malformed/truncated patches.
- Cold and warm opening latency, long main-thread tasks, memory, DOM size,
  scroll smoothness, and added lazy/initial bundle sizes on the same fixtures.
  Retain the existing 4 MB / 20,000-line Git transport/render limits until a
  separate bounded loading design is validated. A fast renderer alone does not
  eliminate transport/parsing limits.
- Configure and measure a bounded shared highlighting worker pool before
  concluding performance parity. The first integration uses the package's
  default highlighting path; its parse timer is not an end-to-end benchmark.
- Copy source text without patch markers/numbers, including actual leading
  operators, partial lines, old/new panes, and selection across virtual windows.
  Keep an explicit copy-patch action separate from source copying.
- Paste formatted Markdown and an image into an annotation; scroll it away and
  back, resize, change layout, and continue editing. Check text, upload
  completion, focus, and undo history separately. Surviving draft text does not
  prove that an unmounted editor's undo history or upload survives.
- Keyboard access to controls/annotations, Escape and focus restoration,
  account animation preference, zoom/reflow, and light/dark themes.
- Preserve existing comment anchors and saved reviews. Unmatched anchors must
  be visible as unmatched, never silently attached to the nearest line.
- Preserve safe treatment of untrusted code, paths, and commit descriptions.
  Syntax highlighting is not Markdown sanitization. Do not weaken existing
  sanitizer boundaries to accommodate the renderer.

Only after these gates pass, replace rendering and delete obsolete code.

### Manual evaluation and integration decision

The maintainer's initial hands-on evaluation found Pierre's diffs attractive,
fast enough for the tested reviews, and the side-by-side view particularly useful.
This supports proceeding with integration, not discarding CoCalc's review UI.
It is user acceptance evidence, not a large-file benchmark or full feature-parity
result.

Preserve the existing review shell and replace its rendering boundary. Track
parity explicitly: sticky current-file names, keyboard scrolling, commit
navigation (`j`/`k`), marking reviewed (`y`), diff search (`/` and find shortcut),
context expansion, font-size shortcuts, help, scroll restoration, saved review
anchors, and Slate comments including image paste and local undo. These are
existing product features, not optional polish to rediscover after migration.
The same command should target whichever renderer is active, not both.

The preview now enables Pierre's sticky headers and reuses CoCalc's scrolling
commands: Space/Shift+Space, Page Down/Up, arrow keys, and Home. The viewport is
keyboard focusable; comments and controls retain native key handling. Other
preview keys cannot invoke the underlying drawer's commit/review shortcuts;
Escape still closes the modal and restores trigger focus. Commit/review/search
commands belong in the integrated review shell, not this frozen-input modal.
Use Pierre's `github-light` / `github-dark` themes, following the browser color
preference. The browser regression checks actual rendered background colors in
both modes, not merely the React options.

## Phase 1: repository, history target, and working copy

Separate these identities:

- Repository: project plus resolved Git common directory.
- History target: full commit ID, branch tip, or pinned comparison endpoints.
- Working copy: optional registered worktree, needed for working changes and
  editing/actions, not for reading history.

Discover worktrees with `git worktree list --porcelain -z`, refs with
`for-each-ref`, and repository identity with `rev-parse`. Cache discovery briefly
per repository, refresh on demand, and inspect status only for the selected
worktree. Avoid recursive project-directory scanning and per-render ancestry
walks. Resolve abbreviated hashes to full object IDs before saving reviews.

Browsing refs must not run checkout/switch. A branch with no available worktree
still supports read-only historical viewing. Handle detached, locked, stale,
and removed worktrees explicitly. Cross-project discovery requires explicit
project context and normal access checks; a shared remote URL is not proof
that two directories are the same local repository.

For bare commit links, show the commit immediately. Prefer explicit originating
context; otherwise select a uniquely matching worktree when the current
checkout does not contain the commit. Show a chooser on ambiguity. Containment
after merging does not identify the original branch. Never switch contexts
silently while the user is composing review feedback.

Name both actions: "View at this revision" and "Edit in this worktree".
Review/commit agent requests carry the repository, selected worktree, commit or
comparison, and paths explicitly. Existing thread routing currently ignores a
requested working directory; resolve that mismatch before enabling cross-
worktree mutations. Do not silently repurpose a running agent's worktree.

## Phase 2: comparisons and TimeTravel

Offer combined diffs and individual commits against an explicit base. Pin the
resolved base/head IDs for the review, with explicit refresh when refs move.
Use merge-base comparisons for unmerged branch review, and recorded merge
parents or saved review endpoints to review an already integrated change.
Handle merge conflict resolutions explicitly; `--no-merges` must not hide them
from a complete release review. Branch upstream is not necessarily the PR base.

A shared historical source descriptor should identify:

```ts
type HistoricalLocation = {
  projectId: string;
  source: GitRevision | PatchflowRevision | SnapshotRevision | BackupRevision;
  path: string;
  line?: number;
  column?: number;
};
```

These are conceptual types, not a new production API. GitRevision includes
repository identity and full commit ID. Other variants include their source's
stable version identifier. Diff sides each have their own descriptor; deleted
files and renamed paths use the old side's location.

Extend TimeTravel to open an arbitrary descriptor without first finding it in
the current file-history slider. For missing diff context, load immutable file
contents lazily through existing project access/routing. Preserve rich document
viewers; Pierre would replace text diff rendering only. Snapshot/backup sources
retain their source-specific restore semantics.

## Phase 3: activity diffs and durable agent context

Keep explicit activity provenance: project, working directory, session/turn,
event ID/sequence, path, and known before/after content or blob identifiers.
An activity event is not automatically a Git commit and the live file may have
changed since it occurred. Do not synthesize complete document contents by
concatenating the existing sparse LineDiffResult lines.

Prefer a structured hunk adapter with numeric old/new line positions, or retain
the original unified patch upstream. Existing formatted gutters need an
explicit tested legacy adapter if reused. Incomplete events show their
limitations; lazy expansion must never fetch unrelated current contents.
Streaming updates should be coalesced and must not rebuild an entire multi-day
log or launch a new worker pool per event.

Agent commit links should carry originating repository/worktree/branch context
and a full hash. Review status is shared for the same immutable commit; a
changed/rebased commit or changed comparison requires review again. Later,
range-diff can help explain changes between reviewed versions.

## Future: definition lookup (not part of this implementation)

Reserve a renderer-independent token interaction that passes HistoricalLocation,
diff side, token range, and identifier to a resolver. The renderer knows where
the click occurred; it does not decide what the symbol means.

For `withBackupEvidenceAbort`, the eventual experience is a definition preview
with signature, source, revision, and an action to open that version in
TimeTravel. Deleted lines resolve against the old revision; added lines against
the new revision. For merge reviews, the old side is the selected parent/base.

Implementation stages, in increasing cost:

1. Search declarations in the exact historical file/tree, using syntax-aware
   indexing where available. Label candidates as search results when ambiguous;
   name matching alone is not semantic go-to-definition.
2. Resolve imports/exports for selected languages, initially TypeScript and
   JavaScript, against the same tree and configuration.
3. Provide semantic lookup with a language service over an isolated immutable
   revision filesystem or a bounded materialized workspace. Cache by repository,
   revision, language configuration, and dependency state. Account for missing
   generated sources, dependencies, and monorepo project references.

Do not send historical positions to an LSP attached to today's checkout and
present the answer as exact. Do not automatically checkout, install dependencies,
or execute repository setup to answer a read-only lookup. Unsupported languages
can offer honest revision-scoped search. Patchflow file revisions may lack a
consistent whole-project snapshot; activity patches may lack complete old/new
trees. In those cases, limit claims to available content and label any separately
requested working-copy lookup as current, not historical.

## Evaluation record

The initial prototype passed frontend TypeScript build and lint, the development
Rspack build, four focused Jest tests, and three Node tests against the real
pinned Pierre parser. Jest covers keyboard line navigation, missing-context
feedback, temporary draft state across layout changes, frozen preview input,
Escape dismissal, and trigger focus restoration. The renderer and Markdown
editor are mocked in Jest; those tests do not validate actual editor portals or
virtualization. The separate parser tests exercise sparse old/new coordinates,
full-document context, and a truncated hunk.

Run the focused tests with:

```sh
pnpm -C src/packages/frontend exec jest --runInBand components/diff-viewer
pnpm -C src/packages/frontend exec node --experimental-strip-types --test components/diff-viewer/pierre-model.test.mjs
```

The initial manual trial exposed missing viewport overflow styling and a file
selector that changed only the line-jump target. The follow-up gives CodeView its
own bounded scroll viewport, navigates immediately on file selection, and wraps
long lines by default with an explicit toggle. Split/unified settings update in
place; no renderer remount workaround is used. Annotation additions also publish
an item version: Pierre otherwise retains the old payload despite new React
item objects. Draft body edits remain React-only and do not change that version.

A standalone Chromium regression now exercises the actual React/Ant Design/Pierre
integration: wheel scrolling, file selection, line jumping, split/unified and
wrap updates, annotation draft preservation across a layout change, and width
containment at 1200, 600, and 320 pixels. It also verifies sticky filenames across
files, focused keyboard scrolling, editable spaces, background shortcut isolation,
and Escape/focus restoration using the real keyboard boundary. Only application services and the rich
editor are stubbed, so it does not validate real Slate behavior. Run it with:

```sh
node src/packages/frontend/components/diff-viewer/pierre-preview.browser-test.mjs
```

It defaults to `/usr/bin/chromium`; override with `CHROMIUM_PATH`. Full live-app
automation is still outstanding: hub discovery returned no active sessions and
dedicated spawning could not obtain cookie-backed authentication in this runtime.
Large-diff benchmarks, real Slate image-paste/undo, and virtualized source copying
remain acceptance gates. The preview is not a production renderer replacement.

Initial plan sources: https://diffs.com/, Pierre's package source and
https://pierre.computer/writing/on-rendering-diffs. Consult the installed pinned
version's APIs rather than assuming the latest main-branch documentation matches.
