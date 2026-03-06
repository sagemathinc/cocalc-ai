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
6. keyboard-first navigation between file tabs and frames should be possible
   without the mouse
7. accessibility work should benefit from the same keyboard model, not compete
   with it

## Non-Goals

1. replacing every existing shortcut implementation in one pass
2. rewriting all editor focus plumbing immediately
3. removing `set_active_key_handler(...)` before we have a stable replacement
4. solving every accessibility issue in the frontend in one project

## Scope Decision: Tab/Frame Navigation

This is in scope, but it should be sequenced after the boundary/global-handler
cleanup starts to land.

Reason:

1. adding more global shortcuts before ownership rules are explicit will make
   conflicts worse
2. once boundaries and suppression rules are shared, tab/frame shortcuts become
   much easier to implement safely
3. the same work directly helps accessibility because it reduces mouse-only
   navigation paths

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

## 5. Navigation Commands as First-Class Actions

Tab/frame navigation should not be implemented as ad hoc DOM key handlers in
each widget. It should be an explicit command layer on top of page/project/frame
state.

Initial targets:

1. next file tab
2. previous file tab
3. next frame in current tab
4. previous frame in current tab
5. focus tab strip
6. focus frame strip / frame switcher
7. close current tab/frame via keyboard where already supported conceptually

Likely homes:

1. page-level actions for top-level tab navigation
2. frame-tree actions for per-file frame navigation
3. a shared shortcut registry so bindings are discoverable and testable

This should be designed so the command is separate from the binding:

1. command: `focusNextFileTab`
2. default binding: something chosen later

That separation is better for:

1. accessibility
2. future remapping
3. command-palette style invocation
4. testing

## 6. Accessibility Alignment

The keyboard plan should explicitly help mouse-free navigation.

That means:

1. keyboard focus must be visible and stable
2. tab strips and frame controls need semantic focus targets
3. roving tabindex or equivalent patterns should be used where arrow-key
   navigation makes sense
4. command shortcuts must not be the only path; keyboard focus traversal must
   also work
5. browser smoke tests should include mouse-free navigation flows

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

## Phase 5: Add Keyboard Navigation Commands

Files likely involved:

1. `src/packages/frontend/app/actions.ts`
2. page tab state/actions
3. frame-tree actions/components
4. tab-strip and frame-strip UI components

Deliverables:

1. explicit commands for next/previous file tab
2. explicit commands for next/previous frame in the current tab
3. keyboard focus entry points for tab/frame controls
4. a small shortcut registry or command table for these actions

Implementation spec:

1. distinguish command identity from keybinding identity:
   - commands are stable API, e.g. `focusNextFrame`
   - bindings vary by host/runtime, e.g. browser vs Electron
2. introduce a small command table with:
   - `id`
   - `label`
   - `scope`: `global-nav` | `shell` | `local`
   - `isEnabled()`
   - `run()`
   - `bindings`: array of host/platform-specific bindings
3. treat tab/frame navigation as `global-nav`, not ordinary shell shortcuts:
   - they should be allowed from most focused surfaces
   - they must use non-text chords, never bare letters
   - they must not depend on the user first clicking a toolbar
4. separate direct activation from focus movement:
   - `activateNextFileTab`
   - `activatePreviousFileTab`
   - `focusNextFrame`
   - `focusPreviousFrame`
   - `focusFileTabStrip`
   - `focusCurrentFrameRoot`
5. prefer standard accessible widget behavior once focus lands:
   - tab strip behaves as a proper tablist
   - left/right arrows move between tabs
   - `Home` / `End` jump to first/last tab
   - `Enter` / `Space` activate if selection and activation are separated
6. define "frame" narrowly at first to keep Phase 5 reviewable:
   - file tab strip
   - page toolbar / project shell header if present
   - primary editor/frame
   - right-side flyout or floating dock if visible
   - bottom panel if visible
7. every navigable frame must expose a stable keyboard entry point:
   - a focusable root or anchor element
   - visible keyboard focus styling
   - a deterministic order for `focusNextFrame` / `focusPreviousFrame`

Binding profile spec:

1. browser profile:
   - prefer chords that do not conflict with major browser tab/window shortcuts
   - initial default should emphasize pane/frame movement first:
     - `F6` => `focusNextFrame`
     - `Shift+F6` => `focusPreviousFrame`
   - file-tab activation commands should exist immediately, but browser-default
     bindings may be conservative or omitted until conflict testing is done
   - browser users can still move across file tabs without the mouse by:
     - using `F6` to reach the tab strip
     - then using standard tablist arrow-key behavior
2. Electron/native-shell profile:
   - keep the same command ids
   - add conventional document-navigation aliases even if they would conflict
     with browser chrome in a normal tab
   - likely aliases to support:
     - `Ctrl+Tab` / `Ctrl+Shift+Tab` for next/previous file tab
     - platform-native tab aliases where appropriate, e.g. macOS document-tab
       conventions
   - this profile should be additive, not a forked keyboard architecture
3. command-palette exposure:
   - every Phase 5 command should be invokable without its shortcut
   - shortcut help should show the active binding profile for the current host

Behavior spec:

1. `focusNextFrame` / `focusPreviousFrame` must work from editors, notebooks,
   chat surfaces, and overlays because they use non-text chords
2. direct file-tab activation commands should preserve the focused-surface type
   when reasonable:
   - if invoked from an editor, land in the newly active tab's main editor/frame
   - if invoked from the tab strip itself, keep focus in the tab strip
3. when a frame becomes active by keyboard, the destination must be obvious:
   - visible focus ring
   - scroll into view if needed
   - no silent state change with focus left behind elsewhere
4. floating vs docked UI should not change the command model:
   - a visible right-side agent surface is just another frame in the cycle
   - the same commands should work whether that surface is docked or floating
5. boundary suppression still applies to ordinary shell shortcuts, but not to
   `global-nav` commands that use approved non-text chords

Implementation order inside Phase 5:

1. add the command table and host-aware binding registration
2. add `focusNextFrame` / `focusPreviousFrame` with `F6` / `Shift+F6`
3. make the file tab strip a real keyboard target with arrow-key navigation
4. add `focusFileTabStrip` and `focusCurrentFrameRoot`
5. add direct next/previous file-tab commands
6. enable conservative browser bindings only after live conflict checks
7. add Electron-only standard aliases when the desktop runtime is active

Acceptance details:

1. browser users can navigate across visible frames with `F6` / `Shift+F6`
2. browser users can reach the tab strip and move across file tabs without a mouse
3. the command table can expose stronger standard aliases in Electron later
   without any redesign
4. keyboard navigation does not depend on whether a panel is docked, floated,
   or rendered in a flyout
5. keyboard navigation bindings are documented and discoverable in the UI

Acceptance:

1. a user can move between file tabs without the mouse
2. a user can move between frames within a tab without the mouse
3. command bindings do not fire while typing in editors/inputs/overlays

## Phase 6: Add Accessibility-Focused Navigation Hardening

Deliverables:

1. visible focus states for tab/frame navigation targets
2. tab/frame controls exposed as proper keyboard-focusable UI
3. roving tabindex or equivalent behavior where arrow-key navigation is desired
4. audit of obvious mouse-required paths in page/tab/frame navigation

Acceptance:

1. accessibility audits can traverse core tab/frame UI without requiring a mouse
2. power users can navigate the same UI quickly by keyboard

## Phase 7: Add Regression Coverage

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
4. future tab/frame navigation keyboard tests

## Phase 8: Add Debugging Ergonomics

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
6. `frontend/navigation: add file-tab and frame navigation commands`
7. `frontend/navigation: add accessible focus targets for tab/frame UI`
8. `frontend: add keyboard boundary browser smoke and debug helpers`

## Immediate Concrete Wins

If only the first three phases land, future fixes get much easier because:

1. there is one shared concept to grep for
2. an overlay bug becomes "is it inside a boundary?" instead of
   "which of four keyboard systems is winning?"
3. Jupyter command-mode behavior becomes locally explainable
4. new floating surfaces can opt in with one wrapper
5. tab/frame navigation shortcuts can be added without creating another layer
   of shortcut conflicts

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

Navigation:

1. page tab strip components/actions
2. frame-tree title bar / frame switching components
3. any reducers/actions that track active file tab or active frame

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

## Recommended Second Milestone

After the first milestone lands, the next milestone should be:

1. add explicit next/previous file tab commands
2. add explicit next/previous frame commands
3. expose focusable tab/frame targets for keyboard-only use
4. add smoke tests that move across tabs/frames without the mouse

That is the smallest milestone that starts paying down the long-standing
power-user and accessibility complaints without mixing everything into one
unreviewable refactor.
