# Jupyter + Slate Plan

## Goal

Build a Slate-based Jupyter frame that feels like editing one continuous document, while keeping `.ipynb` cell data canonical.

1. Canonical state stays in Jupyter (`cells`, `cell_list`, runtime/kernel state).
2. Slate is an interaction surface, not a second source of truth.
3. Code output/runtime UI continues to use existing Jupyter components/actions.
4. Cursor/navigation should work across the whole notebook as one editor experience.

## Strategy Pivot

The initial row-per-cell Slate prototype was useful for proving compatibility, but it is not enough UX-wise.

New primary direction:

1. Use one Slate editor per notebook frame.
2. Represent notebook cells as top-level Slate elements with stable `cell_id`.
3. Render code output/prompt/tooling from existing Jupyter components attached to those elements.
4. Map Slate structural edits back to canonical Jupyter cell operations.

The current row prototype remains a bridge/fallback while implementing the single-document model.

## Non-Goals

1. Replacing the canonical ipynb model.
2. Rebuilding kernel/runtime plumbing.
3. Introducing parallel execution semantics in this project.
4. Requiring CodeMirror per-cell for baseline editing.

## Canonical Mapping Requirements

For every top-level Slate cell element:

1. `cell_id` maps to Jupyter cell id.
2. `cell_type` maps to Jupyter cell type (`markdown`/`code`/`raw`).
3. Input text maps to `set_cell_input(cell_id, input)`.
4. Runtime/output metadata is read from canonical cell/runtime state.
5. Structural operations map to insert/delete/move/type-change actions.

No persisted notebook state should live only in Slate-specific structures.

## Current Foundation

1. Frame wiring and actions:
   - [src/packages/frontend/frame-editors/jupyter-editor/editor.ts](./src/packages/frontend/frame-editors/jupyter-editor/editor.ts)
   - [src/packages/frontend/frame-editors/jupyter-editor/actions.ts](./src/packages/frontend/frame-editors/jupyter-editor/actions.ts)
2. Current Slate prototype frame:
   - [src/packages/frontend/frame-editors/jupyter-editor/markdown-notebook.tsx](./src/packages/frontend/frame-editors/jupyter-editor/markdown-notebook.tsx)
3. Slate editor stack:
   - [src/packages/frontend/editors/slate/block-markdown-editor-core.tsx](./src/packages/frontend/editors/slate/block-markdown-editor-core.tsx)
   - [src/packages/frontend/editors/slate/block-row-editor.tsx](./src/packages/frontend/editors/slate/block-row-editor.tsx)
   - [src/packages/frontend/editors/slate/editable-markdown.tsx](./src/packages/frontend/editors/slate/editable-markdown.tsx)
4. Jupyter runtime/output components:
   - [src/packages/frontend/jupyter/cell-output.tsx](./src/packages/frontend/jupyter/cell-output.tsx)
   - [src/packages/frontend/jupyter/prompt/input.tsx](./src/packages/frontend/jupyter/prompt/input.tsx)
5. Canonical model and ipynb I/O:
   - [src/packages/jupyter/redux/store.ts](./src/packages/jupyter/redux/store.ts)
   - [src/packages/jupyter/redux/actions.ts](./src/packages/jupyter/redux/actions.ts)
   - [src/packages/jupyter/ipynb/import-from-ipynb.ts](./src/packages/jupyter/ipynb/import-from-ipynb.ts)
   - [src/packages/jupyter/ipynb/export-to-ipynb.ts](./src/packages/jupyter/ipynb/export-to-ipynb.ts)

## Implementation Plan

## Phase A: Stabilize Bridge Prototype

Purpose: keep momentum and safety while pivot work begins.

1. Keep `jupyter-slate` frame selectable and usable.
2. Keep canonical writeback path (`set_cell_input`) for edits.
3. Keep shortcut plumbing through frame actions.
4. Keep crash hardening in place (selection normalization + row error boundary).

Acceptance:

1. No notebook-wide crash from single-row Slate failure.
2. Edits/run shortcuts continue to work as bridge mode.

## Phase B: Single-Document Slate Data Model

1. Define top-level Slate element schema for notebook cells:
   - `jupyter_cell_markdown`
   - `jupyter_cell_code`
   - `jupyter_cell_raw`
2. Include `cell_id` and minimal cell metadata on each element.
3. Build projection from canonical (`cell_list`, `cells`) -> Slate document.
4. Build reverse mapping from Slate edits -> canonical actions.

Acceptance:

1. One Slate editor shows entire notebook.
2. Every cell maps to canonical id and round-trips safely.

## Phase C: Single-Editor Rendering + Input UX

1. Replace row-per-cell editor mounts with one editor instance.
2. Implement renderers for the new cell elements.
3. Use Prism/fenced-code style editing for code cells.
4. Preserve markdown always-editable flow.

Acceptance:

1. Cursor and selection move naturally across cell boundaries.
2. No per-cell focus/selection traps.

## Phase D: Attach Existing Jupyter Runtime UI

1. Render input prompt/execution state in cell element chrome.
2. Render `CellOutput` below code cell content based on canonical cell state.
3. Keep `more_output`/scrolled/collapsed semantics unchanged.

Acceptance:

1. Output/running indicators match classic notebook behavior.
2. Runtime state still syncs across tabs.

## Phase E: Structural Ops + Commands Parity

1. Insert above/below.
2. Delete/move cells.
3. Type change (`markdown`/`code`/`raw`).
4. Split/merge behaviors mapped to canonical operations.
5. Run/interrupt/restart/halt command parity from single editor context.

Acceptance:

1. Cell list integrity maintained under all operations.
2. Time travel/history stays coherent.

## Phase F: Test Coverage

1. Add Slate-Jupyter Playwright suite for:
   - run state sync,
   - queued/running transitions,
   - kernel restart/interrupt behavior,
   - external on-disk edits,
   - metadata persistence (`last_runtime_ms`, etc.).
2. Add focused unit tests for mapping logic and structural ops.

Acceptance:

1. Failing regressions are reproducible quickly via tests.

## Phase G: Rollout

1. Keep classic notebook default.
2. Keep `jupyter-slate` as explicit mode while hardening.
3. Gradually widen usage after parity + stability thresholds.

## Progress Snapshot

Implemented now:

1. `jupyter-slate` frame registration and typing.
2. Bridge renderer with canonical output integration.
3. Canonical input writeback from Slate rows.
4. Shift+Enter/Alt+Enter bridge shortcut wiring.
5. Selection and crash hardening patches.
6. Deprecated notebook-level `set_cur_id` call removed.
7. Separate experimental `jupyter-slate-top-level` frame with one Slate editor and canonical cell sync bridge.
8. Separate experimental non-block single-editor frame (`jupyter-singledoc`) with canonical cell sync bridge and run shortcuts.
9. Added a new Slate element type `jupyter_code_cell` (reusing code-block rendering/editor pipeline) to enable direct notebook-cell element projection.

Still outstanding (high priority):

1. Dedicated `jupyter_cell_*` Slate element schema (cell ids as first-class structure).
2. Structural op parity in Slate context.
3. Inline output/prompt chrome inside the single-editor schema.
4. Dedicated Playwright coverage for Slate Jupyter mode.

## Concrete Task Checklist

- [x] Add `jupyter_slate_notebook` frame type and wire editor spec.
- [x] Implement bridge read/write prototype over canonical cells.
- [x] Add crash/selection hardening needed for prototype viability.
- [x] Remove deprecated notebook-level `set_cur_id` usage.
- [ ] Implement single Slate editor with `jupyter_cell_*` top-level elements.
- [x] Add separate experimental top-level Slate frame (`jupyter-slate-top-level`) as a bridge.
- [x] Add separate experimental non-block single-editor frame (`jupyter-singledoc`) as a bridge.
- [ ] Attach prompt/output chrome to those elements.
- [ ] Map structural edits to canonical insert/delete/move/type actions.
- [ ] Reach run/interrupt/restart/halt parity in single-editor mode.
- [ ] Add Playwright + unit tests for Slate Jupyter mode.
- [ ] Document user-facing behavior differences and shortcuts.
