# Harden Realtime Collaborative Editing

## Status

Written 2026-09-30; implementation started the same day (see Progress Log). It builds on
PR #749 (`fix/slate-merge-duplication`), which fixed the two concrete bugs from
the incident below.

Related notes: [slate-sync.md](./slate-sync.md), [slate.md](./slate.md).

## Goal

Move from "no known sync bug" to justified confidence that a group of, say, ten
people can edit one Markdown file (or notebook) at the same time with a mix of
editors (Slate, CodeMirror, split frames) and unreliable networks, without
content being duplicated, lost, or silently reverted.

"Confident" here means: large randomized multi-client sessions, run
continuously, satisfy precise invariants, and every production incident becomes
a permanent regression test.

## Motivating Incident (2026-09-28)

Two people edited a Markdown file; one used Slate only, the other a Slate +
CodeMirror split. A table plus the list after it was inserted a second time
(twice), and a two-character list-marker edit ping-ponged between the clients.
Nobody typed or pasted the duplicate.

Decoding the conat-persist history and replaying it with patchflow reproduced
the corrupting patch byte-for-byte. Patchflow was not at fault. Two integration
bugs fed each other (details in PR #749):

1. A focused Slate editor applied remote changes with a block-signature patch
   whose list/paragraph signatures ignored structure. List-nesting changes were
   "applied" as no-ops, the editor recorded the remote markdown as its value, and
   its next save reverted the remote change.
2. `SimpleInputMerge` kept a render request that the editor never exactly
   reported, and later used one of its stale render candidates as the rebase base.
   The rebase replayed about 16 versions of already-saved local edits onto a remote
   value that already contained them: the duplication.

The problem appeared to stop when CodeMirror was closed, but everyone also
refreshed then, which clears both kinds of stale state. Both corrupting patches
came from the Slate-only client.

## Diagnosis Of The Bug Class

The core (patchflow) is small and deterministic. Bugs live in the integration
between the sync document and browser editors, because each integration keeps
private, separately updated copies of "what the document was":

- the Slate tree and `editor.markdownValue` (cached serialization)
- `SimpleInputMerge` `last`, `pending`, `requestedLocalUpdate`
- `lastSetValueRef`, `pendingRemoteRef`, block-patch deferral state
- the CodeMirror buffer and the actions-level `MergeCoordinator` base
- the redux store `value`

Correctness requires these copies to agree. Any skipped update, deferral,
debounce, or early return makes them disagree, and the next save turns the
disagreement into a patch. Some code even guesses the merge base
(`resolveLocal` picks the closest candidate by edit cost). Fixing one drifting
path at a time cannot produce confidence; the design permits drift.

## Principles

1. Every local edit records the exact document version it was derived from. Merges
   use that version's text from patchflow history; nothing guesses a base.
2. One reconciler per document per browser, owned by the editor actions. Editor
   frames are views: they report "edit from version V to text X" and accept
   "show version W".
3. Views must prove they applied a value. After applying remote content, a view's
   serialization must equal the target, or it is rebuilt from scratch.
4. Clients never publish suspicious patches silently. Automatic (non-typed)
   saves are checked against simple invariants before publication.
5. Every production incident's history is replayable and becomes a regression test
   with synthetic content (real documents are private and never committed).

## Workstreams

### 1. Headless Multi-Client Fuzzer (highest priority)

Simulate N clients in Node running the real integration code: Slate runs
headless, so the real `markdown_to_slate` / `slate_to_markdown`, block patch,
`SimpleInputMerge` (or its replacement), and real patchflow sessions can be
used. Connect them with a simulated network that delays, reorders, duplicates,
and partitions messages, and a virtual clock.

Random operations per client:

- typing bursts, deletions, pastes (including large blocks)
- structure edits: list indent/outdent, nested lists, tables, headings, marks,
  code blocks, math
- focus/blur, typing inside the merge-deferral window, reloads
- views: Slate-only, CodeMirror-only, Slate + CodeMirror split, two frames on the
  same file

Oracle: every inserted fragment contains a unique token such as `⟦c3·17⟧`
(client, sequence). After the network is quiet, assert:

1. convergence: all clients and the persisted document are identical
2. no duplication: no token appears more than once
3. no loss: every token that no client deleted is present
4. no silent revert: no client publishes a patch that reverts a remote patch it
   had already applied (reverting only by explicit undo/delete operations)
5. views agree: every view's serialization equals its reconciler's document

This oracle needs no "expected document", which is ill-defined under
concurrency, yet catches the duplication, loss, and revert classes seen so far.
Runs are seeded and deterministic; failures are replayable and should be
shrunk to minimal operation sequences. Target thousands of sessions per minute
in CI (a fixed seed set on every PR, randomized seeds nightly).

Acceptance: the 2026-09-28 bug pair, reintroduced on a branch, is found within
a small bounded number of runs.

### 2. Targeted Audit Of The Integration Layer

Enumerate every point where editor state and sync state meet, document the
invariant each assumes, and add a fuzzer scenario or unit test for each.
Starting list:

- `editable-markdown.tsx` `setEditorToValue`: every early return
  (`lastSetValueRef` skip, same-as-editor skip via cached `markdownValue`,
  no-op operations bookkeeping, block-patch deferral) and the `finally` that
  records the target markdown
- `applyMergedRemoteValue`: forced `saveValue(true)` serializing the tree
- debounced saves (`setSyncstringFromSlate`, `saveValueDebounce`) that may run
  after the tree or baseline changed
- the syncstring `change` handler paths (`local` echo, `source === "cm"`
  force-set, remote merge, deferred pending merge)
- the `value` prop path and `value_slate` path
- `SimpleInputMerge` state transitions (`noteSaved`, `noteLocalEcho`,
  `noteApplied`, `resolveLocal`, `previewMerge`)
- actions-level `MergeCoordinator`, `_suppress_remote_once`,
  `applyMergedBuffer`, and `set_syncstring_to_codemirror` pulling Slate markdown
  when a Slate frame is active
- multiple frames on one document; frame switching (`is_current`) saves
- other editors using the same helpers (markdown input, chat, whiteboard code,
  Jupyter cell inputs)

Also track the known side bug: `slateDiff` operations for some table/list
transitions drop inline math delimiters (caught today by the markdown
verification fallback, but it should be fixed and tested).

### 3. Base-Version Redesign (under the fuzzer)

Replace heuristic baseline tracking with explicit versions:

- editors emit `{ baseVersion, value }`; the reconciler computes
  `makePatch(text(baseVersion), value)` and commits it on top of the current head
  (patchflow working copies already model this)
- remote changes are delivered to views as `{ version, value }`; a view's value
  is only considered clean relative to the version it actually rendered
- remove `last`/`pending`/`requestedLocalUpdate` guessing and the edit-cost base
  selection
- unify CodeMirror and Slate integrations behind the same reconciler

Land incrementally behind the fuzzer, starting with the Markdown editor, then
other users of `SimpleInputMerge`.

### 4. Runtime Invariant Guards And Telemetry

- After applying a remote value, verify the view (as PR #749 now does for focused
  block patches) on every path, not just some.
- Before publishing an automatic (non-keystroke) save: refuse and resync if the
  patch reverts a just-received remote patch, or inserts a large block that
  already exists verbatim in the document without a paste event.
- In development and tests these guards throw; in production they refuse the
  save, resync the view, and emit telemetry (document id, versions, sizes, no
  content) so problems are visible before users report them.

### 5. Real-Browser Chaos Suite (Playwright)

The repo already has Playwright setups. Add a nightly suite:

- N browser contexts as different users against a real Lite server
- randomized layouts (Slate, CodeMirror, split, two frames on one file)
- real keyboard input, IME-like composition, clipboard pastes
- CDP network throttling and offline toggles, reloads mid-edit
- the same token oracle, checked against the server-side document
- on failure: keep the Playwright trace plus the conat-persist database

This catches what headless simulation cannot: contenteditable and focus
behavior, timing, and real event ordering.

### 6. Incident Replay Kit

Turn the tools used for the 2026-09-28 analysis into a supported script:

- decode a conat-persist stream database (zstd + msgpack)
- rebuild every version with patchflow
- flag patches that duplicate existing text or revert recent remote patches
- search for the exact `(base, local, remote)` triple that reproduces a suspect
  patch under a given merge algorithm

Every incident becomes a synthetic regression test.

## Order Of Work

1. Workstream 1 (fuzzer) and 6 (replay kit): days, not weeks; likely to find
   more bugs immediately and becomes the safety net.
2. Workstream 2 (audit), guided by fuzzer findings.
3. Workstream 4 (guards and telemetry) for fast production protection.
4. Workstream 3 (redesign) under the fuzzer.
5. Workstream 5 (browser chaos suite) for browser-only behavior.

## Exit Criteria

- The fuzzer runs on every PR (fixed seeds) and nightly (random seeds), including
  10-client sessions with mixed views, with zero oracle violations for an
  extended period.
- The nightly Playwright chaos suite is green with mixed layouts and network
  faults.
- No integration path merges against a guessed base.
- Guard telemetry in production shows no refused suspicious saves over a release
  cycle, or each one is explained and fixed.
- Every sync incident has a replayable regression test.

## Open Questions

- Jupyter notebooks (syncdb, cell inputs) versus string documents: which parts of
  the fuzzer and reconciler generalize?
- How to represent explicit undo/redo in the "no silent revert" invariant.
- Performance budget for view verification on very large documents (the current
  direct-replacement threshold is 250 blocks / 50,000 characters).

## Progress Log

### 2026-09-30

- Workstream 1 (fuzzer): `frontend/editors/slate/__test__/collab-fuzz/`.
  Each simulated client mounts a real `EditableMarkdown` as the Markdown frame
  editor does, backed by a real patchflow `Session` and a fake `SyncString`,
  over a seeded network that delays and reorders patches. Operations: token
  inserts and deletes through the Slate editor, structured block inserts,
  source-frame (CodeMirror-style) edits including list nesting and bold, and
  focus changes. Oracle: convergence, no duplicated token, no lost token (lost
  tokens are classified as "never committed", "removed by a cX commit", or
  "lost in merge"), and every editor shows its document (modulo whitespace).
  Knobs: `FUZZ_RUNS`, `FUZZ_SEED`, `FUZZ_STEPS`, `FUZZ_VERBOSE`,
  `FUZZ_TRACE_TOKEN`, `FUZZ_SLATE_DEBUG`, `FUZZ_MERGE_TRACE`,
  `FUZZ_STRICT_MERGE`. Seeds that found bugs run on every test run.
- Validation: with the PR #749 fixes reverted, all 40 of 40 seeds fail with
  duplication; with them applied, duplication disappears.
- Integration bugs found by the fuzzer and fixed, each with a regression test:
  1. `SimpleInputMerge` made a rebased merge (containing unsaved local edits)
     its baseline; a second remote update before the save dropped the edits.
  2. A stale `editor.syncCausedUpdate` (set by an external update that changed
     nothing) made the next local edit look remote; it was never saved.
  3. When the editor canonicalized a merged value, the next rebase used the
     merged value as its base and dropped uncommitted edits inside it. Render
     candidates now record their committed base.
  4. Rebasing from an older base with a fuzzy patch repeated committed
     changes; a stale deletion was applied to similar text elsewhere.
     `SimpleInputMerge` now uses `merge_prefer_local` (`@cocalc/util/dmp`), a
     diff3-style merge (line-level, refined per character inside overlapping
     lines, identical changes applied once, no fuzzy relocation, concurrent
     insertions kept, local wins only on true character overlap). Replaying the
     2026-09-28 incident through it yields one table even with the stale base.
- Workstream 6 (replay kit): `src/scripts/dev/sync-replay.mjs` (`summary`,
  `versions`, `explain`) with tests on a synthetic database; on the real
  incident it flags both duplicating patches and reproduces the corrupt
  version from its merge inputs.
- Core finding (not fixed; decision needed): patchflow computes a document by
  applying all patches in time order with fuzzy diff-match-patch patch
  application, including concurrent patches. A deletion whose context changed
  concurrently can be applied to similar text elsewhere while reporting
  success. Recorded as `sync/editor/generic/test/core-merge-limitations.test.ts`
  (`test.failing`). At 80 fuzz steps this accounts for most remaining losses
  (about a quarter of runs); the fuzzer reports them separately unless
  `FUZZ_STRICT_MERGE` is set. Options: merge concurrent heads with a diff3-style
  merge from their common ancestor (deterministically, e.g. earlier patch wins
  on true overlap), keeping fuzzy application only for linear history; this
  changes how existing histories replay, so it needs a versioned rollout.
- Other findings for the audit (not yet fixed):
  - A programmatic source-frame change within Slate's save debounce discards
    unsaved Slate edits (`forceSetEditorToValue` cancels the pending save).
  - An ordered list's start number can differ between the editor and its
    document (for example `2.` shown as `1.`); the next save renumbers it.
  - `slateDiff` operations for some list/table transitions drop inline math
    delimiters; the markdown verification fallback catches it.
- Later the same day, sweeps of 400 seeds at 80 operations each drove further
  integration fixes (each found by the fuzzer, with unit or pinned-seed
  regression tests): 5. Saves wrote the editor's serialized contents as-is. While a remote change
  was deferred (the user was typing) or not yet rendered, that reverted the
  remote change for everyone. Saves now use
  `SimpleInputMerge.mergeForSave`, merging the editor's uncommitted edits
  into the current syncstring value; deferred merges flush against the
  current value. 6. `merge_prefer_local` became a diff3 merge (stable spans, chunk contents
  compared, so the same net change expressed by differently decomposed
  diffs applies once; blank lines are not anchors; conflicts refined by
  semantic then raw character diffs; concurrent insertions kept; a
  whitespace-only side never overrides real content; otherwise local wins). 7. Slate applies merged values synchronously, but the render request stayed
  open and later merges/saves guessed an old candidate's base, duplicating
  text. `noteRendered()` settles it after Slate applied a merge.
- Sweep results (400 seeds, 80 operations, 2-4 clients) over the day:
  integration failures 30 -> 19 -> 16 -> 8 (2%). Remaining: a few "removed by
  a Slate commit" losses and the ordered-list numbering mismatch. The losses
  investigated so far are knock-on effects of the core merge: out-of-order
  delivery briefly garbles Markdown structure, a local edit makes Slate
  re-serialize the garbled block (for example escaping table pipes), and that
  canonicalization then wins a conflict against the corrected remote.
  Serializer canonicalization being indistinguishable from user edits is the
  motivation for Workstream 3. Core merge anomalies (not counted as failures)
  appear in about 22% of these extreme runs.
- Next steps: decide the core merge change (merge concurrent heads with diff3
  from their common ancestor); then Workstream 3 (edits carry their base
  version; canonicalization is not a user edit); Workstream 4 guards;
  Workstream 5 (Playwright, lite2b.cocalc.ai is available for it).
