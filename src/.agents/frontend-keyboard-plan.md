# Frontend Keyboard Handling Plan

This document captures a concrete plan to make keyboard handling in the
CoCalc frontend more explicit, more local, and easier to debug.

It is motivated by real regressions we just hit:

1. typing in a floated agent over a Jupyter notebook in command mode still
   triggered notebook `j/k` movement
2. keyboard ownership was split across several unrelated mechanisms
3. the immediate bug was easy to misdiagnose because React propagation was not
   the real source of truth

## Problem Summary

Right now keyboard ownership is spread across several patterns:

1. page-level active handlers in `src/packages/frontend/app/actions.ts`
2. editor-specific enable/disable logic, e.g. Jupyter and task editors
3. ad hoc `stopPropagation()` in overlays and inputs
4. window click heuristics that decide whether the notebook should re-focus

This creates two recurring problems:

1. there is no single place that answers "who owns keyboard input right now?"
2. overlays can suppress one path but still leak through a different path

The Jupyter command-mode regression is a good example:

1. the notebook shortcut path lives in `src/packages/frontend/jupyter/keyboard.ts`
2. notebook focus reclamation also lives in `src/packages/frontend/jupyter/cell-list.tsx`
3. floated UI sits on top of the notebook, so geometry-based click logic can
   re-focus the notebook underneath it

## Goals

1. one explicit, searchable abstraction for "this subtree owns keyboard input"
2. DOM ancestry should determine keyboard ownership, not screen-rectangle overlap
3. global handlers should have one shared early-return check
4. new overlays/flyouts/docks should opt in by adding one wrapper, not custom hacks
5. future debugging should make it obvious why a global shortcut did or did not run

## Non-Goals

1. replacing every existing shortcut implementation in one pass
2. rewriting all editor focus plumbing immediately
3. removing `set_active_key_handler(...)` before we have a stable replacement

## Proposed Architecture

## 1. Shared Keyboard Boundary

Add a small shared frontend utility layer, likely under:

- `src/packages/frontend/keyboard/`

Initial pieces:

1. `KeyboardBoundary` React component
2. `useKeyboardBoundary()` hook
3. `isInsideKeyboardBoundary(eventOrElement)` helper
4. `getEventPath(event)` helper with safe `composedPath()` fallback

The boundary should:

1. mark its subtree with a standard attribute, e.g.
   `data-cocalc-keyboard-boundary="overlay"`
2. optionally clear page-level active handlers when focus enters
3. optionally stop click/mousedown propagation from reaching window-level focus
   reclaim logic

This gives one standard answer to:

- "Is this event inside an overlay/editor surface that should suppress
  underlying global shortcuts?"

## 2. Shared Global Shortcut Gate

Any window/global keyboard handler should call one shared guard first.

For example:

1. `shouldSuppressGlobalShortcuts(evt)`
2. internally checks:
   - `isInsideKeyboardBoundary(evt)`
   - `document.activeElement`
   - known editable targets (`input`, `textarea`, `select`, contenteditable)
   - any future keyboard owner state

This should be used in at least:

1. `src/packages/frontend/jupyter/keyboard.ts`
2. any other page-level shortcut owners that can conflict with overlays

## 3. Stop Using Geometry for Ownership

The Jupyter `window_click` logic in:

- `src/packages/frontend/jupyter/cell-list.tsx`

currently uses click coordinates and notebook rectangle overlap to decide
whether to focus or blur the notebook.

That is brittle for floating UI because:

1. the click is visually on the dock
2. the coordinates are still inside the notebook rectangle underneath it
3. the notebook reclaims focus even though the user never meant to click it

Replace that with DOM-target-based logic:

1. if the event target is inside a keyboard boundary, do not focus the notebook
2. otherwise, decide notebook focus based on actual DOM ancestry when possible
3. only fall back to geometry if there is no usable DOM target information

## 4. Optional Next Step: Explicit Keyboard Owner

After the boundary layer is working, add a slightly more explicit owner model in
page state.

For example:

1. current owner = `jupyter` | `dock` | `flyout` | `modal` | `none`
2. owner reason = `"focus entered dock"`, `"modal opened"`, etc.

This does not need to be the first step, but it would make debugging much easier
and reduce hidden state in `set_active_key_handler(...)`.

## Implementation Plan

## Phase 1: Add Shared Boundary Utilities

Files:

1. new `src/packages/frontend/keyboard/` helpers
2. minimal docs/comments

Deliverables:

1. `KeyboardBoundary`
2. `isInsideKeyboardBoundary(...)`
3. `shouldSuppressGlobalShortcuts(...)`

Acceptance:

1. no app behavior changes yet, just shared primitives and unit tests

## Phase 2: Make Jupyter Respect the Boundary

Files:

1. `src/packages/frontend/jupyter/keyboard.ts`
2. `src/packages/frontend/jupyter/cell-list.tsx`

Changes:

1. early-return from command-mode/global shortcuts if event target or active
   element is inside a keyboard boundary
2. update `window_click` notebook focus logic to ignore boundary clicks
3. prefer DOM ancestry to geometry

Acceptance:

1. command-mode Jupyter no longer responds to keys typed inside dock/flyout/modal
2. notebook does not reclaim focus from overlaid UI after clicking inside it

## Phase 3: Migrate Known Overlay Surfaces

Use the shared boundary instead of bespoke handling in:

1. `src/packages/frontend/project/page/agent-dock.tsx`
2. `src/packages/frontend/project/page/flyouts/body.tsx`
3. `src/packages/frontend/project/new/navigator-shell.tsx`
4. `src/packages/frontend/project/page/content.tsx` for side-chat-next-to-editor
5. any other floating chat/drawer/modal surfaces discovered during audit

Acceptance:

1. each overlay uses the same wrapper/hook
2. no local keyboard workaround should be needed unless behavior is truly special

## Phase 4: Audit Other Global Handlers

Search and review:

1. project/page-level handlers
2. chat global handlers
3. explorer/project-nav handlers
4. any editor-specific window listeners

Goal:

1. all window/global handlers should either use the shared gate or document why
   they do not

Acceptance:

1. grep audit shows one recognizable pattern rather than several incompatible ones

## Phase 5: Add Regression Coverage

Tests should include:

1. unit tests for `isInsideKeyboardBoundary(...)`
2. unit/component tests for `KeyboardBoundary`
3. Jupyter-focused regression tests for boundary suppression
4. browser smoke test for the exact repro:
   - open multi-cell notebook
   - enter command mode
   - open agents flyout
   - float a session
   - focus composer
   - type `j` / `k`
   - verify selected notebook cell does not move

Existing local tests that proved useful:

1. dock focus suppression test
2. dock click propagation suppression test
3. navigator-shell focus suppression test

## Phase 6: Add Debugging Ergonomics

Add a lightweight dev-only keyboard debug mode.

Possible pieces:

1. `window.__cocalcKeyboardDebug = true`
2. logs for:
   - owner changes
   - boundary hits
   - why a global shortcut was suppressed
   - why a notebook/flyout reclaimed focus
3. optional small debug helper:
   - `window.__cocalcKeyboardState()`

This would have made the recent bug much faster to diagnose.

## Suggested Commit Sequence

1. `frontend/keyboard: add shared keyboard boundary helpers`
2. `jupyter: suppress global shortcuts inside keyboard boundaries`
3. `jupyter: stop notebook refocus on boundary clicks`
4. `frontend: migrate floating dock and flyout surfaces to keyboard boundary`
5. `frontend: migrate navigator and side-chat overlays to keyboard boundary`
6. `frontend: add keyboard boundary browser smoke and debug helpers`

## Immediate Concrete Wins

If only the first three phases land, future fixes get much easier because:

1. there is one shared concept to grep for
2. an overlay bug becomes "is it inside a boundary?" instead of
   "which of four keyboard systems is winning?"
3. Jupyter command-mode behavior becomes locally explainable
4. new floating surfaces can opt in with one wrapper

## Likely Touched Files

Core:

1. `src/packages/frontend/keyboard/*`
2. `src/packages/frontend/app/actions.ts`

Jupyter:

1. `src/packages/frontend/jupyter/keyboard.ts`
2. `src/packages/frontend/jupyter/cell-list.tsx`

Overlay surfaces:

1. `src/packages/frontend/project/page/agent-dock.tsx`
2. `src/packages/frontend/project/page/flyouts/body.tsx`
3. `src/packages/frontend/project/new/navigator-shell.tsx`
4. `src/packages/frontend/project/page/content.tsx`

Tests:

1. new `src/packages/frontend/keyboard/__tests__/*`
2. Jupyter/browser smoke coverage

## Recommended First Milestone

If this work is split into one narrow first milestone, it should be:

1. create shared keyboard boundary helpers
2. update Jupyter keyboard gate and click-focus logic to respect them
3. migrate floated agent dock and flyout body
4. add one exact browser smoke for Jupyter command mode + floating agent

That is the smallest milestone that would likely prevent a repeat of the bug we
just debugged.
