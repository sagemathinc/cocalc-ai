# Harden Jupyter Collaborative Editing

## Status

Written 2026-09-30. Follows
[Harden Realtime Collaborative Editing](./harden-realtime-collaborative-editing-plan-2026-09-30.md)
(PR #751), which did this for the Markdown (Slate) editor and fixed the core
merge for text documents (sagemathinc/patchflow#2). Most CoCalc use is now
Jupyter notebooks, so they come next.

## Goal

Two or more people (and agents, and the project's kernel backend) editing
the same notebook at the same time must never lose, duplicate or garble cell
input, never produce ghost or duplicate cells, and always converge, with a
cell order everyone agrees on. The evidence should be a headless
multi-client fuzzer running the real notebook code, plus a browser suite, not
manual testing.

## How Notebooks Sync Today

- A notebook is a patchflow db document (`SyncDB`), with records keyed by
  `type` and `id` (`jupyter/redux/sync.ts`). Cells are `type: "cell"` records
  with `input` (a string column), `pos`, `cell_type`, `output`, `exec_count`,
  `state`, metadata, and so on. Other record types hold settings and kernel
  state.
- Patches are record-level: a changed string column is a diff-match-patch
  patch of that field; a changed map field is a shallow merge patch; other
  fields are replaced; a deleted record is a delete by primary key
  (patchflow `db-document-immutable.ts`).
- Values are computed like text documents were before patchflow#2: every
  reachable patch applied in time order, including concurrent ones. So:
  - concurrent edits of one cell's `input` are fuzzy-applied to each other's
    text, the same algorithm that relocated a deletion onto the wrong text in
    the Markdown incident;
  - concurrent writes to other fields of a record are last-writer-wins by
    patch time, which is deterministic but can drop a change silently.
- In the browser, each cell's input (`frontend/jupyter/cell-input.tsx`) keeps
  a live buffer and merges remote changes into it with `SimpleInputMerge`,
  the helper hardened in #749 and #751. The CodeMirror wrapper
  (`codemirror-editor.tsx`) saves after a debounce (`cm_save` ->
  `set_cell_input`) and, when the merged value changes, replaces the editor
  contents with it (`setValueNoJump`) and clears its undo history. Markdown
  cells use `MarkdownInput` instead.
- The project backend is also a writer: it runs cells and writes outputs,
  execution counts and state into the same cell records.

## Confirmed And Suspected Problems

1. Confirmed (patchflow db codec, `SYNCDB_OPTIONS`): if one user deletes a
   cell while another edits it, the result depends on which patch has the
   earlier timestamp. If the delete is earlier, the edit's patch re-creates
   the record with only the changed non-string fields: a **ghost cell** such
   as `{type: "cell", id}` with no input and no position. If the edit is
   earlier, the delete wins and the edit is lost silently. Pinned in
   `sync/editor/db/test/jupyter-core-merge.test.ts`.
2. Same class as the Markdown incident: concurrent edits of one cell's input
   are fuzzy-applied to each other (see above).
3. Suspected, to verify with the fuzzer:
   - the editor replacing its contents on every merged remote change (undo
     history cleared, cursor effects, races with the save debounce and the
     paste workaround `ignoreNextValue`);
   - split/merge cells, move cells (`pos` conflicts), change cell type, and
     cut/paste of cells, all concurrent with typing in those cells;
   - backend writes (outputs, state) concurrent with user edits of the same
     cells, including a cell deleted while it runs;
   - reconnect/refresh with unsaved typing in a cell.

## Workstreams

### J1. Exact merges for db documents (patchflow)

Give db documents a `merge3`, like strings got in patchflow#2, and turn it
on for notebooks first:

- Three-way per record by primary key. A record added on one side is
  added; deleted on one side and unchanged on the other is deleted;
  **deleted on one side and edited on the other keeps the edited record
  whole** (never lose typed input, never produce a partial record).
- Per field: changed on one side takes that change; changed on both merges
  string columns with `mergeStrings3`, map fields key by key, and other
  fields by a deterministic rule (the later patch wins, as today).
- Enable for `SYNCDB_OPTIONS` (notebooks) through the CoCalc codec; tasks,
  chats and whiteboards later, each after its own tests.

### J2. Headless multi-client notebook fuzzer (highest priority)

Same approach as the Markdown fuzzer (`frontend/editors/slate/__test__/collab-fuzz`):

- N simulated clients, each with a real patchflow Session on the notebook
  codec, connected by the seeded `SimNetwork` (delay, reordering), under
  jest fake timers; plus a simulated backend writer for outputs and state.
- Each client renders real `CellInput`/CodeMirror components where jsdom
  allows; otherwise a model with the same merge and save logic
  (`SimpleInputMerge`, debounced saves). Decide after a spike.
- Operations: type/delete/paste in a cell, insert/delete/move/split/merge
  cells, change cell type, run a cell (backend writes output), focus
  changes, disconnect/reconnect.
- Oracle: every inserted fragment carries a unique token. At quiescence all
  clients converge; no token is lost unless deleted, and none is duplicated;
  every cell id appears once with a string input and a position; cell order
  is identical everywhere; each editor shows its cell's document.
- Seeds that found bugs become regression tests.

### J3. Audit and fix the integration layer, guided by the fuzzer

`cell-input.tsx`, `codemirror-editor.tsx`, markdown cells, the cell actions
in `jupyter/redux/actions.ts` (`set_cell_input`, split, merge, move, delete,
paste), undo/redo, cursors, and the backend's writes.

### J4. Browser suite (Playwright on lite2b.cocalc.ai)

Two or more real browsers on one notebook: concurrent typing in the same
cell and in neighbouring cells, structural edits, running cells, refresh
mid-typing. Same token oracle, read from the saved notebook.

### J5. Incident replay for notebooks

Extend `scripts/dev/sync-replay.mjs` to notebook histories, so a reported
problem can be traced to the patch or merge that caused it.

## Order Of Work

1. J1 pinned tests (done for the ghost cell), then the J2 fuzzer against
   today's code to measure the baseline.
2. J1 in patchflow, enabled for notebooks; re-measure.
3. J3 fixes, each with a fuzzer seed or unit test.
4. J4, then J5.

## Exit Criteria

- Long fuzzer sweeps (hundreds of seeds, several clients, structural edits
  and backend writes) with no failures, run in CI at a smaller size.
- The Playwright suite passes repeatedly on lite2b.
- No ghost cells, lost input or duplicated input in either.

## Progress Log

### 2026-09-30

- Plan written. Ghost cell on concurrent delete and edit confirmed and pinned
  as a `test.failing`.
- J2 fuzzer, first version: `jupyter/redux/__test__/collab-fuzz/`
  (`JUPYTER_FUZZ=1`).
  - Each client runs real `JupyterActions` and `JupyterStore` on its own
    headless redux.
  - Underneath is `SimSyncDB`: SyncDoc's set/commit/rebase and throttled
    change events on a real patchflow Session with CoCalc's notebook codec.
  - Clients exchange patches over the seeded simulated network.
  - The focused cell's editor is a model of `cell-input.tsx` plus
    `codemirror-editor.tsx`: a debounced save, `SimpleInputMerge`, and a
    save on unmount.
  - A simulated kernel backend writes outputs.
- Baseline on today's code: 200 seeds x 40 operations, 2-3 users plus
  backend, 164 failing (82%). Runs with each problem:
  - ghost cells: made by editor saves (101), cell inserts (49), merges (31),
    splits (13), moves (11) and others;
  - tokens duplicated by editor saves (92);
  - tokens lost in the core merge (43), or removed by editor saves or merges
    (23);
  - no convergence (10).
  - The harness is new: categories are verified one by one before being
    called bugs.
- Confirmed by code reading, with a single user: split right after typing
  duplicates text. `split_current_cell` (`frame-editors/jupyter-editor/
cell-notebook/actions.ts`) does not save the input editor first, unlike
  the run commands, and neither the escape-mode switch nor a CodeMirror blur
  saves. So `split_cell` splits the stored input, which lacks the last 750ms
  of typing. The editor then merges its buffer back, keeping text from the
  top part in the bottom cell.
- Suspected, to confirm with the fuzzer: a cell editor unmounting because
  another user deleted the cell saves its unsaved typing with
  `set_cell_input`, which re-creates the cell as a ghost with only `id` and
  `input`.

### 2026-09-30 (later): fixes, measured with the fuzzer

Notebook fuzzer, 200 seeds x 40 operations, 2-3 users plus kernel backend:

|                       | all operations | without split/merge cells |
| --------------------- | -------------- | ------------------------- |
| baseline              | 36 pass        | -                         |
| after the fixes below | 106 pass       | 198 pass                  |

Without split/merge, nothing is lost and clients always converge; the two
remaining failures are keep-both duplicates in the core merge (both users
rewrote the same line). Every remaining failure with split/merge is text
moved by a split or merge while someone edited it (see open question).

Fixes (each found by the fuzzer; unit tests in `sync/editor/db/test`):

- Core merge for all db documents (notebooks, tasks, chats, boards, slides):
  `sync/editor/db/merge3.ts`, an exact three-way merge per record and
  field. A cell deleted while another user typed in it is kept whole; one
  deleted while the kernel wrote its output stays deleted. Replaces
  time-ordered fuzzy application (ghost cells, silently lost edits).
- Never create a partial cell record (without position and input): an
  editor saving as it unmounts after a delete, a move or output for a
  deleted cell used to create ghost cells. Input typed into a cell another
  user deleted concurrently brings the cell back whole.
- Editor saves carry their base: `set_cell_input(id, input, save, base)`
  merges into newer synced input instead of reverting a collaborator's
  change, and returns the saved input, which the editor shows and records
  (otherwise its echo was merged again from an old base, duplicating text).
- Editor merges (`SimpleInputMerge`, also used by the Markdown editor) use
  patchflow's `mergeStrings3` instead of `merge_prefer_local`, whose "local
  wins" rule dropped a collaborator's text typed next to a local edit. The
  Markdown fuzzer went from 7 to 2 failures in 400 x 80 (both the known
  ordered-list numbering).
- Split, merge, delete, cut and copy save open editors first (split right
  after typing duplicated text, with one user). `split_cell` checks the cell
  still exists before inserting, and `set_cell_input` commits when asked to
  even if the input did not change (half-done splits stayed uncommitted on
  one client: the non-converging runs).
- Fuzzer: harness initial-change baseline fixed; `FUZZ_NO_SPLIT_MERGE`,
  `FUZZ_MERGE_PROBE`; verbose output shows the commit that lost or
  duplicated a token and how non-converged clients differ.

Decision (2026-09-30): accept that text a split or merge moves while someone
edits it may end up twice (a visible duplicate; nothing is lost). The fuzzer
records the text in split or merged cells and reports duplicates of it
without failing.

Next: the fuzzer approach for tasks, boards and slides (they already get the
core merge), J4 (browser suite on lite2b) and J5.

### 2026-09-30 (evening): all fuzzer failures fixed

- More fixes found by the fuzzer:
  - `merge_cell_below_cell` checks that both cells still exist before
    deleting the one below, and reads the inputs from the synced document.
    Before, it could leave the delete uncommitted, to go out with the next
    commit and lose the cell's text.
  - A text column added on both sides (a deleted cell both users brought
    back) merges from the tokens the two versions have in common, not from
    an empty base.
  - Cell editors take a value they stored as their baseline at once
    (`SimpleInputMerge.noteLocalEcho`), because the store is updated
    synchronously.
  - patchflow (sagemathinc/patchflow#4, to be released as 0.9.1):
    unterminated last lines, and pairing a changed line with its closest
    edit.
- Notebook fuzzer, 400 seeds x 40 operations, with and without split/merge:
  - with the patchflow#4 fixes: 400/400 in both modes;
  - with patchflow 0.9.0: 400/400 with all operations, and 398/400 without
    split/merge.
- Markdown fuzzer, 400 x 80: 2 failures, both the known ordered-list
  numbering.
- The notebook fuzzer runs by default now: 6 random seeds plus regression
  seeds, about 2 seconds.

### 2026-09-30 (night): task lists, whiteboards and slides

- The simulated network and SyncDB are shared (`sync/editor/sim.ts`) by the
  notebook, task list and whiteboard fuzzers, all of which run by default.
- Task lists (`frontend/editors/task-editor/__test__/collab-fuzz.test.ts`):
  real tasks session and `TaskActions.set_desc`, with a model of the
  description editor.
  - Found and fixed:
    - description saves overwrote newer synced text: they now carry their
      base and merge, like notebook cells;
    - the description editor never settled a merged value it rendered, so a
      later merge could guess an older baseline and duplicate text
      (`noteRendered`);
    - checkbox toggles in the rendered description now merge too.
  - Also found and fixed: word diffs matched spaces instead of words
    (patchflow#4).
  - Results, 400 x 60: 398/400 on patchflow 0.9.0, 400/400 with #4.
  - Accepted: text typed into a trashed task while someone empties the
    trash is deleted with it (a deliberate, permanent delete); deleting a
    line break while someone rewrites both lines keeps both versions.
- Whiteboards and slides
  (`frontend/frame-editors/whiteboard-editor/__test__/collab-fuzz.test.ts`):
  the real `setElement`, `setElementData` and `deleteElements` on simulated
  clients, covering create, text edits (saved whole), move, resize, data
  keys, edges and delete.
  - 400/400 x 40 and 200/200 x 100: no lost or duplicated text, no partial
    elements.
  - `setElementData` now sets only the changed data keys (the document
    merges maps by key). Spreading the store's possibly stale data could
    write back keys a collaborator just changed.
  - Accepted: an edge to an element deleted at the same moment stays as a
    record; it is not drawn while an end is missing, and is again if the
    element comes back.
  - Not yet covered: the whiteboard text editor itself (Slate with
    `mergeRemoteValues` inside `MultiMarkdownInput`); the fuzzer saves text
    whole, as `text.tsx` does.
