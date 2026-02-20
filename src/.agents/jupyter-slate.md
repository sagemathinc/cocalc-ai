# Jupyter + Slate Plan

## Goal

Implement a new Slate-based Jupyter frame that:

1. Uses the existing Jupyter notebook data model as canonical (`cells`, `cell_list`, runtime state, kernel state).
2. Reuses current Jupyter execution/output/rendering components and actions.
3. Provides non-modal, Slate-native editing/navigation for markdown and code input.
4. Does **not** introduce a new canonical storage format (no markdown/fenced-file source of truth).

## Non-Goals

1. Replace the current cell notebook UI.
2. Change `.ipynb` import/export semantics.
3. Add true parallel cell execution.
4. Rebuild kernel/runtime plumbing.

## Key Constraint

Notebook cell structure remains canonical in syncdb/ipynb.

- Every edit from the Slate frame maps to `set_cell_input`, `set_cell_type`, insert/delete/move operations on existing cell ids.
- Outputs remain cell-bound and rendered by existing Jupyter output components.
- Kernel/run/queue/running states remain driven by existing Jupyter store/actions/runtime-state.

## Existing Foundation (already in repo)

1. Jupyter frame and actions
   - [src/packages/frontend/frame-editors/jupyter-editor/editor.ts](./src/packages/frontend/frame-editors/jupyter-editor/editor.ts)
   - [src/packages/frontend/frame-editors/jupyter-editor/actions.ts](./src/packages/frontend/frame-editors/jupyter-editor/actions.ts)
   - [src/packages/frontend/frame-editors/jupyter-editor/cell-notebook/cell-notebook.tsx](./src/packages/frontend/frame-editors/jupyter-editor/cell-notebook/cell-notebook.tsx)
   - [src/packages/frontend/frame-editors/jupyter-editor/cell-notebook/actions.ts](./src/packages/frontend/frame-editors/jupyter-editor/cell-notebook/actions.ts)
2. Placeholder frame candidates
   - [src/packages/frontend/frame-editors/jupyter-editor/markdown-notebook.tsx](./src/packages/frontend/frame-editors/jupyter-editor/markdown-notebook.tsx)
   - [src/packages/frontend/frame-editors/jupyter-editor/singledoc-notebook.tsx](./src/packages/frontend/frame-editors/jupyter-editor/singledoc-notebook.tsx)
3. Slate block editor stack
   - [src/packages/frontend/editors/slate/block-markdown-editor-core.tsx](./src/packages/frontend/editors/slate/block-markdown-editor-core.tsx)
   - [src/packages/frontend/editors/slate/block-row-editor.tsx](./src/packages/frontend/editors/slate/block-row-editor.tsx)
   - [src/packages/frontend/editors/slate/use-block-row-renderer.tsx](./src/packages/frontend/editors/slate/use-block-row-renderer.tsx)
4. Existing Jupyter input/output rendering
   - [src/packages/frontend/jupyter/cell-input.tsx](./src/packages/frontend/jupyter/cell-input.tsx)
   - [src/packages/frontend/jupyter/cell-output.tsx](./src/packages/frontend/jupyter/cell-output.tsx)
   - [src/packages/frontend/jupyter/output-messages/message.tsx](./src/packages/frontend/jupyter/output-messages/message.tsx)
5. Canonical notebook model and runtime metadata
   - [src/packages/jupyter/redux/store.ts](./src/packages/jupyter/redux/store.ts)
   - [src/packages/jupyter/redux/actions.ts](./src/packages/jupyter/redux/actions.ts)
   - [src/packages/jupyter/ipynb/import-from-ipynb.ts](./src/packages/jupyter/ipynb/import-from-ipynb.ts)
   - [src/packages/jupyter/ipynb/export-to-ipynb.ts](./src/packages/jupyter/ipynb/export-to-ipynb.ts)

## Proposed UX Model

Single notebook view rendered as rows, one row per notebook cell.

1. Markdown cell row
   - Slate rich markdown editing always available (no double-click mode switch).
2. Code cell row
   - Slate code-block editing for input.
   - Existing Jupyter prompt + run state badge/timing.
   - Existing Jupyter `CellOutput` rendered immediately below input in-row.
3. Raw cell row
   - Slate/plain text editor row with no output.
4. Notebook chrome
   - Keep current top toolbar/menu commands and frame integration.

## Data Model Mapping (critical)

Define a row view-model projected from canonical notebook state:

1. Row identity: `row.id = cell.id` (stable).
2. Row kind: `cell_type`.
3. Row input text: `cell.input`.
4. Row runtime state: `state/start/end/exec_count/last` from canonical cell+runtime overlay.
5. Row output: `cell.output` + `more_output`.

No row owns persisted state outside canonical cell records.

## Implementation Plan

## Phase 0: Plumbing + Frame Registration

1. Add a new Jupyter frame type in editor spec (e.g., `jupyter_slate_notebook`).
2. Wire this frame into [src/packages/frontend/frame-editors/jupyter-editor/editor.ts](./src/packages/frontend/frame-editors/jupyter-editor/editor.ts) with commands/button set initially matching current Jupyter frame.
3. Implement frame component in [src/packages/frontend/frame-editors/jupyter-editor/markdown-notebook.tsx](./src/packages/frontend/frame-editors/jupyter-editor/markdown-notebook.tsx) (or new dedicated file) that receives the same `jupyter_actions` and frame actions as `CellNotebook`.

Acceptance:

1. User can switch to new frame type from frame tree.
2. Frame mounts with notebook state available and no runtime regressions.

## Phase 1: Read-Only Render Prototype (No Editing Yet)

1. Build `SlateNotebookView` that maps `cell_list` + `cells` into ordered rows.
2. For markdown/code/raw:
   - Render static Slate markdown for input text.
3. For code:
   - Render existing [src/packages/frontend/jupyter/cell-output.tsx](./src/packages/frontend/jupyter/cell-output.tsx) using canonical cell record.
4. Render existing prompt/timing state for code rows (reuse existing prompt/timing components where possible).

Acceptance:

1. Visual row order exactly matches `cell_list`.
2. Outputs update live as cells run in this frame.
3. Multi-tab sync is correct for running/queued/done states in this frame.

## Phase 2: Input Editing (Canonical Writes)

1. Markdown rows:
   - Enable Slate editing and write back via `jupyter_actions.set_cell_input(id, value, true)`.
2. Code rows:
   - Start with plain Slate code-block editing.
   - Same writeback path: `set_cell_input`.
3. Raw rows:
   - Text editing via same writeback path.
4. Preserve existing read-only protections:
   - `metadata.editable=false`, notebook read-only state.

Acceptance:

1. Editing any row updates canonical cell input and syncs cross-tab.
2. Undo/redo and save behavior remain frame-tree consistent.
3. No drift between this frame and classic cell notebook for input values.

## Phase 3: Row-Level Notebook Operations

Implement notebook operations using existing notebook actions, not local row hacks:

1. Insert above/below.
2. Delete cell.
3. Move cell up/down.
4. Change cell type (markdown/code/raw).
5. Split/merge behavior:
   - Markdown split/merge can map cleanly through input text.
   - Code split/merge maps to existing cell ops and input updates.

Acceptance:

1. All operations preserve stable cell ids where expected.
2. `cell_list` integrity preserved.
3. Time travel/history remains valid.

## Phase 4: Run/Interrupt/Restart Semantics in Slate Frame

1. Connect Shift+Enter / Alt+Enter semantics to existing run actions from notebook frame actions.
2. Respect current behavior for:
   - run current, run and advance, run selected.
   - queued/running indicators.
3. Ensure kernel commands (`interrupt`, `restart`, `halt`) are wired through existing actions.

Acceptance:

1. Behavior matches current notebook semantics.
2. Existing Playwright run-sync tests can be adapted and pass for Slate frame.

## Phase 5: Output UX Parity and Performance

1. Keep output rendering delegated to existing Jupyter components.
2. Ensure large output and more-output flow works unchanged.
3. Add row virtualization strategy if needed:
   - Virtualize rows, not output messages internals.
   - Keep mounted row identity stable enough to avoid editor focus churn.

Acceptance:

1. No regression in big notebook scrolling or output rendering.
2. No stale output artifacts while running.

## Phase 6: Metadata + Attachments + Advanced Cell Features

1. Preserve cell metadata behavior:
   - tags, slideshow, nbgrader, attachments.
2. For markdown attachments:
   - keep existing `attachment:` URL transform behavior compatible.
3. Ensure toolbar actions still operate on selected/current row id.

Acceptance:

1. Metadata tools operate correctly in Slate frame.
2. ipynb import/export unchanged and lossless relative to existing behavior.

## Technical Design Notes

## 1. Reuse Jupyter actions/store directly

Do not add a second notebook state store.

- `jupyter_actions.store` remains source for rows.
- `jupyter_actions` methods remain source for mutations.

## 2. Row component structure

Proposed components:

1. `JupyterSlateNotebookFrame` (frame-level wiring).
2. `JupyterSlateRowList` (maps canonical cells to rows, selection model).
3. `JupyterSlateRow` (single cell row shell).
4. `JupyterSlateInput` (Slate editing surface by cell type).
5. Existing `CellOutput` for code outputs.

## 3. Keyboard model

Avoid reintroducing modal semantics in this frame.

1. Normal typing/editing always works.
2. Notebook commands use explicit shortcuts and row context.
3. Keep shortcut conflicts deterministic and documented.

## 4. Selection model

Start simple:

1. Single active row id + optional multi-row selection set.
2. Integrate with existing frame actions gradually.
3. Avoid attempting full cross-row text-range selection initially.

## Risk Register

1. Focus churn from row virtualization + Slate editors.
   - Mitigation: start without virtualization; add only after correctness.
2. Shortcut conflicts with existing Slate keyboard handlers.
   - Mitigation: centralize Jupyter-specific bindings in frame container.
3. Split/merge edge cases across code/markdown/raw.
   - Mitigation: phase-gate and high-coverage tests.
4. Output rendering performance if every row mounts heavy output.
   - Mitigation: lazy render outputs for offscreen rows.

## Test Plan

## Unit tests

1. Row mapping from canonical `cells` + `cell_list`.
2. Writeback logic for `set_cell_input`.
3. Cell operation adapters (insert/delete/move/type change).
4. Shortcut dispatch (shift+enter/alt+enter/run selected).

## Playwright e2e (new suite)

1. Run state sync across tabs in Slate frame.
2. Queued/running/done indicators in Slate frame.
3. Kernel interrupt/restart and rerun in Slate frame.
4. External on-disk edits while open (same policy as main frame).
5. Metadata persistence checks (`last_runtime_ms`, tags, etc.).

## Manual checks

1. Large notebook scroll and responsiveness.
2. Mixed markdown/code notebooks.
3. Attachments and rich output types.
4. Time travel opens and scrub behavior for Slate frame.

## Rollout Strategy

1. Hide behind feature flag/frame type initially.
2. Keep classic frame default.
3. Dogfood internally on selected notebooks.
4. Promote to broader use after e2e parity threshold.

## Concrete Task Breakdown (for execution tracking)

- [x] Add `jupyter_slate_notebook` frame type and wire editor spec.
- [x] Implement read-only row list with code outputs.
- [ ] Implement markdown/code/raw input editing with canonical writes.
- [ ] Hook run/interrupt/restart/halt commands.
- [ ] Implement row operations (insert/delete/move/type).
- [ ] Add Playwright suite for Slate notebook frame.
- [ ] Add performance pass (virtualization/lazy output if needed).
- [ ] Add docs/help for keyboard and behavior differences.

## Decision Summary

This is feasible now and the architecture is clean **if** we keep notebook cells canonical and treat Slate as an alternative interaction surface over the same model.
