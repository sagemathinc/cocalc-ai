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
10. Added `value_slate` / `set_slate_value` path in `EditableMarkdown` so notebook frames can project canonical cells directly into Slate nodes (without markdown parse/serialize as the transport layer).

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

## 2026-02-21 Strategy Refresh (Execution Plan)

This section supersedes tactical prioritization above for current work.

### Core Strategy

Treat canonical Jupyter state as the source of truth and enforce one strict projection rule:

1. Every top-level Slate node is exactly one notebook cell wrapper:
   - `jupyter_markdown_cell`
   - `jupyter_code_cell`
2. Every wrapper has stable `cell_id`.
3. Sync is projection/reconciliation between:
   - canonical notebook cells (`cell_list` + `cells`)
   - top-level Slate cell wrappers
4. No other top-level node types are allowed after normalization.

### Sync Invariants ("must always hold")

1. No structural mutation from stale local snapshots.
2. No new cell creation unless a user edit explicitly requires it.
3. No duplicate `cell_id` in Slate or canonical projection.
4. Canonical and Slate converge after debounce window.
5. Running a cell always uses latest canonical input (flush pending Slate first).

### Phased Checklist

#### Phase 1: Correctness Guardrails

Goal: eliminate feedback loops and phantom-cell creation under mixed edits.

Tasks:

1. Add explicit sync assertions/counters in single-doc reconciliation path.
2. Keep stale-structural-apply reject logic; tighten metrics and logs.
3. Add deterministic mapping checks for create/delete/reorder paths.
4. Ensure copy/paste always remaps duplicated `cell_id` values.

Acceptance:

1. No uncontrolled cell growth in classic+slate split tests.
2. No duplicate `cell_id` after random edit/paste sequences.
3. Convergence proven by automated tests (below).

#### Phase 2: Selection + Navigation Model

Goal: make editing feel like normal Slate while preserving cell semantics.

Tasks:

1. Harden top-level gap cursor behavior and keyboard transitions.
2. Complete arrow/home/end boundary behavior between cell wrappers.
3. Preserve continuous range selection across cell boundaries.
4. Remove focus-jitter from debounced sync and run-cell actions.

Acceptance:

1. Cursor movement is deterministic across many cells.
2. No frequent focus loss while typing.
3. Selection operations do not trigger structural surprises.

#### Phase 3: Cell UX Parity

Goal: make single-doc behavior equivalent to practical notebook workflows.

Tasks:

1. Solidify run shortcuts (`Shift+Enter`, `Alt/Mod+Enter`) including next-cell focus behavior.
2. Finalize keyboard/new-cell semantics at gap cursor.
3. Keep code output anchored under the matching code cell.
4. Keep per-cell chrome state consistent (one active chrome at a time).

Acceptance:

1. User can author and run notebooks end-to-end in single-doc mode.
2. Visual/runtime state matches classic notebook expectations.

#### Phase 4: Cross-View Robustness

Goal: guarantee safe coexistence of classic jupyter and slate single-doc views.

Tasks:

1. Exercise simultaneous edits in classic/slate frames and separate browsers.
2. Validate conflict behavior under blur/focus/debounce timing races.
3. Ensure no stale selection/state API calls in classic frame actions.

Acceptance:

1. Long mixed editing sessions converge with no duplication/loss.
2. Classic view remains stable while slate edits stream in.

#### Phase 5: Cell-Type and Metadata Hardening

Goal: avoid breaking notebooks with non-standard content.

Tasks:

1. Preserve and round-trip `raw` and uncommon cell metadata safely.
2. Clarify unsupported cell-type rendering policy in single-doc.
3. Verify metadata retention through structural edits and paste.

Acceptance:

1. No silent metadata loss in save/load/sync workflows.
2. Unsupported types degrade safely (not crashy/destructive).

### Playwright-First Verification Plan

Primary policy: implement feature + deterministic test in the same change whenever possible.

Test suites to maintain in [src/packages/lite/playwright/jupyter/jupyter.spec.ts](./src/packages/lite/playwright/jupyter/jupyter.spec.ts):

1. Typing sync:
   - slate typing persists to canonical without duplication
   - debounce convergence with no feedback loops
2. Structural sync:
   - insert/delete/move from slate converges in classic view
   - classic structural edits converge in slate view
3. Cross-view run semantics:
   - run from slate executes latest canonical source
   - next-cell insertion/focus behavior is deterministic
4. Clipboard/id safety:
   - copied/pasted cells get unique ids
   - bulk paste does not clone ids
5. Selection/navigation:
   - gap cursor insertion flows
   - boundary arrow/home/end behavior

### Manual QA Gate (after Playwright pass)

Before marking any phase complete, run manual split-view checks:

1. Classic + slate in one browser (split frame).
2. Classic + slate in two browsers on same notebook.
3. Medium/large notebook (200-600 cells) typing and run behavior.
4. Randomized mixed edit stress for 2-5 minutes with no structural drift.

### Execution Notes

1. Prefer small commits per phase objective, each with matching tests.
2. Keep drag-and-drop work parked unless explicitly prioritized.
3. If a regression is found, add a failing Playwright case before patching.
