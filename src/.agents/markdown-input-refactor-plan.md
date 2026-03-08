# Markdown Input Refactor And Quality Plan

This document captures a concrete phased plan to improve the quality,
predictability, and long-term maintainability of the frontend multimode markdown
editor in:

- `src/packages/frontend/editors/markdown-input/`

It is motivated by a recurring pattern in recent bug fixes:

1. the public API of the markdown input looks simple and declarative
2. real behavior depends on hidden timing, mode-specific retries, stale refs,
   and editor-specific quirks
3. fixes that look correct from the outside often fail because the wrapper does
   not actually provide the guarantees it appears to provide

This plan is intentionally broader than a one-off bug list. The goal is to make
the markdown editor a reliable primitive that can be used across CoCalc and in
future apps, including chat, comments, notes, notebook cells, task descriptions,
and agent-facing workflows.

## Current Scope

Right now the multimode markdown editor supports exactly two editing backends:

1. WYSIWYG via Slate
2. plain text markdown via CodeMirror 5

This plan assumes those remain the starting point, but it explicitly allows for
replacing one or both backends if that is the highest-confidence path to a
better component.

In particular, the plan should support evaluation of:

1. CodeMirror 6 as the likely plain-text successor
2. Monaco only if a strong product reason appears
3. ProseMirror-based markdown editing as a serious rich-text alternative
4. lighter editor options if they better fit embedded markdown editing

## Problem Summary

The central issue is architectural, not cosmetic.

`src/packages/frontend/editors/markdown-input/multimode.tsx` presents one public
component over two editors with very different models for:

1. focus and blur
2. selection and cursor positions
3. undo and redo
4. lifecycle timing
5. imperative control
6. mode switching

The wrapper currently compensates for that mismatch with hidden heuristics.
That is the root reason the component feels buggy and hard to trust.

Examples in the current code:

1. global LRU state cache for mode and selections:
   `multimode.tsx`
2. stale callback suppression using synchronous refs:
   `multimode.tsx`
3. blur suppression via 100ms timeout:
   `multimode.tsx`
4. delayed retry loops to restore or translate selection across modes:
   `multimode.tsx`
5. mount-only `onModeChange` effect plus manual calls in `setMode(...)`:
   `multimode.tsx`
6. explicit hacks for Slate layout and edit-bar overlap:
   `multimode.tsx`
7. limited dedicated multimode test coverage:
   `src/packages/frontend/editors/markdown-input/__test__/`

The CodeMirror side is also not a trivial leaf:

- `src/packages/frontend/editors/markdown-input/component.tsx`

It mixes focus management, uploads, mentions, cursor sync, auto-grow, merge
logic, keyboard bindings, and editor registration.

The Slate side is larger still, and already has its own control and selection
abstractions:

- `src/packages/frontend/editors/slate/editable-markdown.tsx`
- `src/packages/frontend/editors/slate/control.ts`
- `src/packages/frontend/editors/slate/playwright/harness.tsx`

## Primary Goals

1. make the public contract of the markdown editor explicit and trustworthy
2. make focus, blur, selection, and undo deterministic enough to test
3. support embedded-editor contexts that need self-contained undo/redo
4. support document-editor contexts that may want host-level undo/redo
5. isolate editor-specific behavior behind adapter boundaries
6. make backend replacement possible without rewriting every consumer
7. make browser and unit testing straightforward
8. reduce timing-based hacks and retry loops
9. improve agent-friendliness and automation reliability

## Non-Goals

1. rewriting Slate and CodeMirror integrations from scratch in one pass
2. migrating all consumers at once
3. choosing a new editor backend before we have contract and test coverage
4. polishing every markdown UX issue before fixing the architecture

## Why This Matters For CoCalc

The markdown input sits in workflows that are unusually sensitive to focus,
selection, and undo correctness:

1. chat and agent prompting
2. editing message comments
3. git commit notes and review workflows
4. notebook-adjacent text editing
5. task descriptions
6. embedded side panels and floating UI

These are exactly the places where:

1. users send quickly after editing
2. focus often moves across overlays and panels
3. accidental blur or selection loss is disruptive
4. users expect undo to be local and reliable
5. automation and browser tests need stable behavior

## Design Principles

## 1. The Wrapper Must Be Honest

If the public API says:

1. `isFocused`
2. `onBlur`
3. `onUndo`
4. `controlRef`
5. `cacheId`

then the component must define exactly what those mean in each backend and under
mode switching. Hidden best-effort behavior is not sufficient.

## 2. Editor Capabilities Must Be Explicit

Slate and CodeMirror do not expose the same capabilities cleanly. The wrapper
should stop pretending they do.

Instead, each backend should declare capabilities explicitly, e.g.:

1. local undo stack support
2. markdown-position selection mapping
3. focus without selection restoration
4. selection restore readiness
5. support for rich-text toolbar commands

## 3. Focus And Selection Are Core Data, Not UI Details

Most of the current bugs come from treating focus and selection as incidental.
They should be first-class state with explicit transitions and tests.

## 4. Undo/Redo Must Be Designed Per Context

There are at least two valid undo models:

1. document-level undo owned by the host application
2. local editor undo owned by the embedded markdown component

The component must support both intentionally.

## 5. Replacement Should Be Possible

The wrapper should become stable enough that CoCalc can:

1. keep Slate and CM5 temporarily
2. replace CM5 with CM6 later
3. replace Slate with ProseMirror or another rich-text editor later
4. migrate backend-by-backend instead of rewriting every consumer

## Current Architecture Risks

The following are concrete current risks that should drive the refactor.

## Hidden Timing And Retry Logic

`multimode.tsx` currently uses:

1. mount-time callback refs
2. stale callback guards
3. `setTimeout` retries for selection restore
4. `setTimeout` retries for cross-mode selection application

This makes focus and selection bugs intermittent, environment-dependent, and
hard to test.

## Blur Is Heuristic, Not State-Driven

`ignoreBlur` in `multimode.tsx` suppresses blur callbacks for 100ms around mode
switch interactions. This is fragile around:

1. toolbar clicks
2. send flows
3. touch input
4. future popovers and menus

## Undo Is Underspecified

Today:

1. CodeMirror can use its own undo stack or forwarded callbacks
2. Slate routes undo through action callbacks
3. the multimode wrapper does not clearly define who owns undo in embedded
   contexts

This is why undo is currently broken or inconsistent in places like comment and
note editing.

## Selection Persistence Is Opaque

The selection cache in `multimode.tsx` stores editor-specific selection objects
in a shared LRU keyed by `project_id`, `path`, and `cacheId`.

Problems:

1. the stored shape differs by backend
2. validity is not checked in a principled way
3. restore is best-effort and failure is swallowed
4. the cache contract is not documented for callers

## Layout And Windowing Coupling

The current wrapper includes explicit comments admitting hacks:

1. forcing `disableWindowing={true}` in Slate because selection clicking breaks
2. hard-coded edit-bar padding because controls overlap content

These should be treated as design debt, not permanent facts.

## Public API Smells

Examples:

1. mode name `"editor"` really means Slate rich-text mode
2. `controlRef` is backend-specific and largely untyped
3. `registerEditor` exposes a cursor API that is too thin for real control
4. `isFocused` is intended to be declarative but only works reliably in some
   paths

## Proposed Target Architecture

## 1. Split Shell From Backends

Create a small host shell that owns:

1. mode state
2. toolbar and mode switch UI
3. focus ring and visual state
4. cache policy
5. undo ownership policy
6. analytics/debug hooks

Each editor backend should be a separate adapter implementation.

Suggested directory shape:

- `src/packages/frontend/editors/markdown-input/`
  - `shell.tsx`
  - `types.ts`
  - `adapters/`
    - `codemirror5.tsx`
    - `slate.tsx`
    - `codemirror6.tsx` later
    - `prosemirror.tsx` later

## 2. Introduce A Real Adapter Contract

Define a typed internal adapter interface, for example:

1. `mount`
2. `focus`
3. `blur`
4. `hasFocus`
5. `getValueNow`
6. `setValueNow`
7. `getSelection`
8. `setSelection`
9. `selectionToMarkdownPosition`
10. `selectionFromMarkdownPosition`
11. `undo`
12. `redo`
13. `canUndo`
14. `canRedo`
15. `flushPendingChanges`
16. `supportsLocalUndo`
17. `supportsMarkdownPositionSelection`
18. `destroy`

The adapter should return typed errors or capability failures instead of forcing
the shell to guess.

## 3. Make Focus Semantics Explicit

The shell should define exactly these states:

1. unfocused
2. focused with visible caret
3. temporarily interacting with internal controls
4. programmatic focus requested but backend not yet ready

This should replace timeout-based `ignoreBlur` behavior.

## 4. Make Selection Transitions Explicit

Selection handling should be split into:

1. backend-native selection state
2. markdown-position bridge state for cross-mode switching
3. persistence policy for cache restore

Cross-mode switching should be an explicit state transition:

1. capture source selection
2. map to markdown position if supported
3. mount target backend
4. wait for target-ready signal
5. apply selection once
6. surface failure deterministically if mapping is impossible

This is better than repeated timeouts.

## 5. Define Undo Ownership

Undo and redo should be driven by an explicit policy:

1. `undoOwner = "local-editor"`
2. `undoOwner = "host-document"`
3. `undoOwner = "consumer-provided"`

For embedded editors such as:

1. chat composer
2. message comment editor
3. git note editor

the default should be local editor undo.

For large document editors that integrate with a broader document model, host
undo may still be the right choice.

## 6. Add A Stable Imperative Control Surface

The current `controlRef` is too backend-specific. Replace or wrap it with a
documented imperative API:

1. `focus({ preserveSelection?: boolean })`
2. `blur()`
3. `getValue()`
4. `setValue(value, opts?)`
5. `getSelection()`
6. `setSelection(selection, opts?)`
7. `undo()`
8. `redo()`
9. `switchMode(mode, opts?)`
10. `getMode()`

The shell can still expose backend-specific escape hatches separately if truly
needed, but consumers should not depend on them by default.

## Backend Strategy

## Plain Text Markdown

### Short Term

Keep CM5 working behind an adapter while contract and tests are built.

### Medium Term

Evaluate CodeMirror 6 as the likely replacement target.

Reasons:

1. modern extension model
2. better long-term maintenance story
3. improved selection and state modeling
4. better integration possibilities for local undo and commands

### Monaco

Do not make Monaco the default plan.

Use it only if strong product requirements appear, such as:

1. richer IDE-style editing beyond markdown
2. extension ecosystem needs that CM6 does not satisfy
3. a proven benefit that justifies heavier bundle/runtime cost

## Rich Text / WYSIWYG

### Short Term

Keep Slate working behind an adapter while contract and tests are built.

### Medium Term

Evaluate ProseMirror-based markdown editing seriously.

Reasons:

1. strong document model
2. mature plugin ecosystem
3. potentially clearer control over selection and transactions
4. good fit for markdown-aware rich-text editing

Do not switch by default until we validate:

1. markdown fidelity
2. selection mapping quality
3. embedded-editor focus behavior
4. undo behavior in local contexts
5. migration cost for existing Slate-specific features

## Evaluation Criteria For Any Backend

Any replacement candidate should be evaluated against:

1. deterministic focus behavior
2. deterministic selection behavior
3. self-contained local undo/redo
4. markdown round-trip fidelity
5. ease of embedded use in panels, chats, and dialogs
6. testing ergonomics
7. browser automation ergonomics
8. bundle size and performance
9. accessibility support
10. maintainability and ecosystem health

## Testing Strategy

This project should start by improving tests, not by rewriting internals.

## 1. Contract Tests

Add editor-agnostic tests for the shell contract:

1. `isFocused=true` focuses the editor
2. programmatic blur does not trigger false external state changes
3. mode switch preserves value
4. mode switch preserves selection when mapping exists
5. mode switch degrades predictably when mapping does not exist
6. `cacheId` change isolates stale callbacks and stale selections
7. `switchMode(...)` emits one consistent mode-change signal
8. local undo/redo works when enabled

These tests should run against both adapters where meaningful.

## 2. Embedded-Context Tests

Add focused tests for the high-risk real consumers:

1. chat composer
2. message comment editing
3. git commit note editing
4. task description editor

Key flows:

1. send after editing
2. retain or restore focus when appropriate
3. blur on toolbar interaction does not commit accidentally
4. undo/redo stays local to the editor
5. switching tabs or threads does not leak stale callbacks

## 3. Browser Repro Tests

Add browser-level smoke tests for behaviors that are hard to trust in unit
tests alone:

1. send in markdown mode preserves expected focus behavior
2. send in Slate mode preserves expected focus behavior
3. switching modes around an existing selection behaves predictably
4. undo/redo in embedded comment editors does not escape to the host page
5. opening popovers/toolbars does not trigger fake blur or value loss

## 4. Harness Improvements

Reuse and extend the existing Slate harness under:

- `src/packages/frontend/editors/slate/playwright/harness.tsx`

Add a similar harness for the multimode wrapper so we can run the same scenario
against multiple backend combinations.

## Phased Implementation Plan

## Phase 0: Document The Contract And Freeze Regressions

Deliverables:

1. document the current and target public contract
2. list known regressions and current workarounds
3. add failing or characterization tests for high-risk flows

Priority test cases:

1. send-after-edit focus in markdown mode
2. send-after-edit focus in Slate mode
3. mode switch selection preservation both directions
4. blur suppression around mode switch
5. local undo/redo in comment-like embedded editors

Acceptance:

1. we can reproduce the current weirdness in tests instead of rediscovering it
   via manual bug reports

## Phase 1: Extract Types And Adapter Boundary Without Behavior Change

Deliverables:

1. `types.ts` for shell and adapter contracts
2. adapter wrappers around existing CM5 and Slate implementations
3. shell owns mode state and visual chrome

Rules:

1. no product-visible changes required yet
2. do not replace backends yet
3. preserve current behavior where possible, but route through typed adapters

Acceptance:

1. multimode code is smaller and easier to reason about
2. backend-specific control logic is no longer mixed throughout one component

## Phase 2: Focus And Blur Cleanup

Deliverables:

1. remove `ignoreBlur` timeout heuristics
2. implement explicit internal-interaction state for toolbar/mode switching
3. define one focus lifecycle across backends
4. clarify the semantics of `isFocused`, `autoFocus`, and imperative `focus()`

Acceptance:

1. toolbar interaction does not emit false blur
2. send/reset flows do not require speculative focus pulses
3. focus behavior is consistent enough to test in both backends

## Phase 3: Selection And Mode-Switch Cleanup

Deliverables:

1. replace pending selection retry loops with ready-based application
2. define a typed markdown-position bridge
3. validate selection persistence and failure paths explicitly
4. reduce or replace opaque selection caching

Acceptance:

1. selection restore and cross-mode handoff are deterministic
2. failure to map selection is explicit and harmless
3. no repeated `setTimeout` retries are needed for normal flows

## Phase 4: Undo/Redo Architecture

Deliverables:

1. explicit undo ownership policy
2. local undo by default for embedded editors
3. host-controlled undo hooks where appropriate
4. tests for comment editors, git note editors, and chat-local editors

Acceptance:

1. undo and redo in embedded editors work in both modes
2. host-level undo is opt-in, not accidental
3. Slate no longer has special-case broken undo behavior in these contexts

## Phase 5: Consumer Cleanup

Target consumers:

1. chat composer
2. chat message/comment editors
3. git commit note editor
4. task editing surfaces

Deliverables:

1. remove consumer-side compensating hacks
2. adopt the new imperative API where needed
3. simplify focus handling in callers

Acceptance:

1. recent bug-fix patterns no longer require guessing about editor internals
2. consumers rely on documented behavior, not timing luck

## Phase 6: Backend Evaluation Spike

This phase is a deliberate evaluation, not a commitment to rewrite.

Tasks:

1. build a minimal CM6 adapter spike
2. build a minimal ProseMirror-based markdown WYSIWYG spike
3. run both against the same harness scenarios
4. compare against existing CM5 and Slate adapters

Evaluate:

1. focus stability
2. selection stability
3. local undo/redo quality
4. markdown fidelity
5. bundle/runtime cost
6. migration difficulty

Decision:

1. keep current backend
2. replace plain-text backend only
3. replace rich-text backend only
4. replace both over time

## Phase 7: Incremental Migration

If a replacement backend wins:

1. migrate one mode first
2. keep the shell contract stable
3. convert highest-value consumers first
4. leave escape hatches for unsupported features only temporarily

Acceptance:

1. consumers do not need large rewrites to benefit from the new backend

## Recommended Immediate Priorities

If work begins now, the best order is:

1. Phase 0 characterization tests
2. Phase 1 typed adapter extraction
3. Phase 2 focus/blur cleanup
4. Phase 4 undo/redo architecture for embedded editors
5. Phase 3 selection/mode-switch cleanup

Reason:

1. recent bugs are dominated by focus and hidden lifecycle behavior
2. undo/redo is a product requirement for embedded editors
3. selection cleanup becomes easier once adapters and focus semantics are
   explicit

## Exit Criteria

This project should only be considered successful when all of the following are
true:

1. the multimode wrapper has a documented, typed contract
2. focus and blur behavior is reliable in both markdown and rich-text modes
3. mode switching is deterministic and tested
4. embedded-editor undo/redo works in both backends
5. consumers no longer need speculative workaround code
6. browser automation can drive the editor predictably
7. we have enough abstraction to evaluate or replace backends safely

## Notes For Future Agent Work

This component should be treated as infrastructure, not just UI.

For an agent or automation workflow, the important properties are:

1. deterministic imperative control
2. reliable focus after rerender or send/reset
3. clear ownership of undo/redo
4. stable value reads without race conditions
5. explicit mode and selection transitions
6. reproducible browser-test hooks

That means future work should prefer:

1. fewer hidden retries
2. fewer swallowed failures
3. smaller adapter boundaries
4. stronger test harnesses
5. explicit contracts over convenience props that only work sometimes
