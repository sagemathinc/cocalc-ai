# Jupyter artifacts in the Agents workspace

Status: implementation started after #640 merged. The shared read-only renderer
is extracted; the Agents notebook workflow is not yet implemented or release-ready.

## Integration audit (2026-09-22)

#640 is merged. This branch incorporates main and PR #668 targets main.

- `chat/open-result.ts` already routes files and artifact cards into persistent
  Workbench frames, with full-frame presentation on narrow screens.
- `frame-editors/chat-editor/workbench.tsx` sends both file entry points to
  `FileArtifact`. Do not add notebooks to its generic saved-file reader: that
  would miss unsaved changes in the authoritative live document.
- `jupyter/readonly-notebook.tsx` extracts the existing history CellList surface
  for reuse. It consumes an observed document, receives no editing/execution
  actions, and does not own a session. History uses this same renderer.
- `frame-editors/jupyter-editor/jupyter-actions.ts` opens `syncdbPath(path)`
  using `SYNCDB_OPTIONS`. `jupyter/browser-actions.ts` additionally owns
  `watchIpynb`, disk/RTC reconciliation, runtime subscriptions and widget state.
  A raw syncdb subscription alone does not initialize a never-opened notebook.
  Reuse this lifecycle rather than implementing a second import/watch policy.
- The compute Jupyter API explicitly prohibits its load/save methods for
  passive opening. Use project-host filesystem/session routing; artifact open
  must not start compute or execute cells.

Next slice: extract a reusable passive session owner from existing initialization
and reconciliation, then attach the read-only surface to both Workbench entry
points. Cover first-open, unsaved edits, multiple consumers, disconnect and
last-consumer cleanup. Never close a session owned by an open project editor.

Cell/output snapshot references, origin-bound feedback, execution freshness,
live export and browser acceptance remain unfinished. The renderer extraction
does not yet expose a notebook artifact UI or establish live-session behavior.

## Product goal

Conversation directs the work; a real notebook makes that work inspectable,
executable, and reusable. Users should complete a notebook analysis, review its
outputs, request a cell-specific correction, and obtain the result without
leaving Agents.

The notebook artifact references the actual project notebook and its live
session, not a second copy or a JSON preview. Reuse existing CoCalc renderers,
notebook session APIs, Workbench navigation, and contextual feedback. Preserve
normal project access and project-host data-plane routing.

## First workflow

1. Select an existing notebook or upload/select a CSV in the agent composer.
2. Ask the agent to explain, analyze, or revise it.
3. Open the notebook beside chat from a result card or ordinary notebook link.
4. Inspect rendered markdown, code, plots, tables, execution state, and errors.
5. Select a cell or output and ask the originating agent for a targeted change.
6. Inspect the revision and actual execution outcome, then download the normal
   `.ipynb` or choose Open in project for direct notebook editing.

Opening a notebook must never execute cells. Showing output does not establish
that the current code produced it, or that rerunning selected cells establishes
full reproducibility in a stateful kernel.

## Implementation checklist

- [x] Audit existing notebook renderers, session lifecycle, artifact locators,
      and contextual-feedback APIs; identify minimal integration seams.
- [ ] Open notebook cards and ordinary links in a reusable Agents result pane.
- [ ] Render the authoritative live notebook, including unsaved edits, without
      introducing a separate editor, notebook engine, or storage format.
- [ ] Provide stable cell/output selection references, capturing the inspected
      content/revision so concurrent changes do not silently retarget feedback.
- [ ] Send contextual feedback to the originating agent conversation, preserving
      drafts and distinguishing references from execution authorization.
- [ ] Display real execution state, errors, and stale/captured-output status;
      do not report success solely from agent prose.
- [ ] Preserve notebook/pane identity, useful selection, and scroll position
      across agent switches, pane close/reopen, reload, and reconnect.
- [ ] Provide download and Open in project using existing actions.
- [ ] Cover missing files, stopped/offline projects, permission loss, failed or
      cancelled runs, concurrent edits, deleted cells, and oversized outputs.
- [ ] Verify keyboard selection/feedback, focus restoration, narrow layouts,
      200% zoom, light/dark appearance, and reduced motion.
- [ ] Run focused tests, typechecks, frontend lint, and relevant runtime builds.
- [ ] Record observed end-to-end acceptance evidence before calling this done.

## Acceptance

Use a disposable notebook with an unsaved live edit. Explain and modify it from
Agents, run the intended cells, inspect a real execution failure, request a
correction tied to that cell, and inspect/download the corrected notebook.
Complete the workflow without navigating out of Agents or refreshing to make
updates appear. Verify that opening/reopening alone executes nothing and that
a concurrent edit is preserved or produces an explicit conflict.

## Not in the first slice

- Full embedded manual notebook editing or another project desktop.
- Universal artifact indexing or automatic discovery of arbitrary shell outputs.
- Sophisticated notebook revision comparison or a second history store.
- Dependencies on new connectors, alternative harnesses, or the mobile app.
- Automatic kernel restart/run-all, or claims of reproducibility without evidence.

## Delivery

Stack the planning PR on `feature/my-agents-workspace` (#640). After #640 merges,
retarget to main and verify the resulting diff. Implement in small reviewed
steps, with the notebook workflow as the next product slice rather than another
gate on the current Agents release.
