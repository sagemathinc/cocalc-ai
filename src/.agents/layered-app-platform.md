# Layered App Platform: First Cut With Tasks And Interface Boundaries

This note proposes a concrete first step toward a layered app platform in CoCalc.

The goal is not to redesign all editors and apps at once.
The goal is to do one focused refactor well enough that it becomes the pattern for later work.

The first two pieces are:

- `tasks` as the first real app package
- explicit interfaces for the hard swappable dependencies that tasks needs

This is the minimum cut that directly helps agent workflows while also improving application organization, without requiring a broad frontend extraction first.

## 1. Why This Exists

CoCalc currently has a recurring split for major applications:

- backend/domain logic in one place
- frontend React/UI code in another
- frame/editor registration and integration in a third

This pattern exists in both `chat` and `jupyter`, and it works well enough for first-party development, but it does not scale cleanly to:

- CLI support
- export/import support
- headless document operations
- optional browserless workflows
- managed app backends
- user-installable or swappable app implementations
- agent-written applications

For agents, the main problem is not aesthetics. It is search cost and boundary confusion.

An agent should be able to answer quickly:

- what package owns this document type?
- what is the canonical headless model?
- what is shared infrastructure versus app-specific code?
- how do CLI/export/import hook in?
- what code can run without a browser?

Tasks is the best place to solve this first because:

- it is much simpler than chat or jupyter
- it already wants headless operations for CLI and agents
- it already wants export/import
- it currently depends on frontend-oriented markdown editing/rendering and shell services in awkward ways

## 2. Core Architectural Decision

Do **not** make `tasks` depend on all of `packages/frontend`.

Instead, use a layered structure:

1. platform packages
2. app packages
3. frontend shell/workbench

Dependency direction must be:

- platform packages do not depend on app packages
- app packages depend on platform packages
- `packages/frontend` depends on app packages and platform packages

In other words, the frontend shell hosts apps. It should not be the library that every app must depend on.

## 2.1 Dependency Style At The App Boundary

Package boundaries alone are not enough.
For app-level integration points, prefer **interfaces and adapters** over hard dependencies on a specific host implementation.

That means the tasks app should not assume one exact markdown editor package or one exact shell package.
Instead, it should depend on small contracts such as:

- a markdown editing surface
- a markdown rendering surface
- a tasks host/services surface
- a sync session surface

Then the current CoCalc frontend can provide default implementations of those contracts.

This is the intended perspective:

- app packages define what they need
- platform packages provide reusable implementations
- the frontend shell wires concrete implementations together

This keeps the design plugin-like without requiring a full third-party plugin system immediately.

It also avoids the wrong dependency shape:

- `tasks -> packages/frontend`

The better shape is:

- `tasks -> contracts`
- `ui-markdown -> markdown implementation`
- `packages/frontend -> adapters and shell wiring`

Use direct imports for stable low-level libraries and pure utilities.
Use interface-based dependency injection for volatile host-provided capabilities.

Examples of things that should usually remain direct imports:

- pure parsing/serialization helpers
- utility functions
- small deterministic libraries

Examples of things that should usually be provided via contracts:

- markdown editor components (e.g., based on slate, prosemirror, etc.)
- source code editing (e.g., based on codemirror, monaco, etc.)
- static markdown rendering
- workbench/app-framework services
- sync session providers (e.g., our patchflow based implementation; maybe something else based on yjs later)
- dialogs/notifications if app-specific UI actions require them

## 3. Scope Of This First Refactor

This document is intentionally narrow.

In scope:

- define the first contract boundaries for the hard dependencies that tasks needs
- define the first app package for tasks
- define how export/import/CLI fit into that app package
- define migration phases that can be done incrementally

Not in scope:

- moving chat to the new structure now
- moving jupyter now
- designing external plugin loading in full
- designing managed app lifecycle in full
- solving all frontend package layering at once

The purpose is to validate a concrete pattern.

## 4. Proposed Package Structure

### 4.1 Interface First, Implementation Second

Do **not** start by extracting Slate or Markdown code just because it is shared.

Start by defining the contracts that tasks actually needs.
Then keep the current frontend implementation behind adapters until the contracts are stable.

This is important because the main goal is not code movement.
The main goal is to make the app boundary explicit and swappable.

Only after the contracts are clear should we decide whether a shared implementation package is worth extracting.

A future package such as `src/packages/ui-markdown` may still make sense, but it is not the first step.
The first step is to define the markdown/editor and host interfaces precisely enough that tasks can depend on them instead of on raw frontend code.

### 4.1.1 First Contracts To Define For Tasks

The tasks app should not import the markdown implementation everywhere directly.
Instead, it should define a narrow contract for what it needs.

At minimum, the tasks app should eventually have host-facing interfaces for:

- markdown editor component
- static markdown renderer
- mostly-static markdown renderer
- task host/workbench services
- sync session provider

These interfaces should be small and explicit.
Do not pass all of app-framework as one giant dependency bag.

The frontend shell should provide the default adapters for those contracts using the current first-party UI stack.

This gives the tasks app:

- better testability
- lower coupling
- easier future swappability
- a more plugin-like shape for agents and later third-party apps

#### Markdown surface required by tasks today

Based on the current task description editor and renderers, the markdown contract needed by tasks is not that large.

Tasks currently needs something equivalent to:

- an editable markdown surface with:
  - `value`
  - `onChange`
  - `getValueRef`
  - `fontSize`
  - `onShiftEnter`
  - `onFocus`
  - `enableUpload`
  - `enableMentions`
  - `height`
  - `placeholder`
  - `autoFocus`
  - `onSave`
  - `onUndo`
  - `onRedo`
  - `minimal`
  - `disableBlockEditor`
  - optional style props such as `modeSwitchStyle`
- a mostly-static markdown renderer with:
  - `value`
  - `searchWords`
  - optional `onChange`
  - `selectedHashtags`
  - `toggleHashtag`
- a static markdown renderer with at least:
  - `value`
  - optional style props

That is already much more concrete than saying "tasks depends on Slate".
Tasks actually depends on a markdown editing/rendering surface with a fairly small contract.

This is a strong argument for defining a `MarkdownSurface` interface first and only later deciding how the default implementation is packaged.

#### Host services required by tasks today

The task app also needs a host/workbench contract, but again it should be minimal and explicit.

Examples include:

- document state access
- mutation dispatch
- key handler enable/disable hooks
- undo/redo/save hooks
- sync session access
- fragment/navigation support if still required

The current frontend implementation can satisfy this through adapters around existing app-framework and syncdb code, without making the tasks app depend on all of `packages/frontend`.

### 4.2 New Tasks App Package

Create the first real app package.

Suggested name:

- `src/packages/apps/tasks`

This should be a real package with its own:

- `package.json`
- `tsconfig.json`
- tests

This package should eventually own all task-specific behavior.

Suggested internal structure:

- `src/model/`
- `src/sync/`
- `src/frontend/`
- `src/export/`
- `src/import/`
- `src/cli/`
- `src/manifest.ts`

This is not because every app must have exactly those directories forever.
It is because these are the capabilities tasks already needs.

## 5. Tasks App Responsibilities

The tasks app package should own:

### 5.1 Canonical document model

This includes:

- task row schema
- parsing and serialization of `.tasks` JSONL
- normalized task record shape
- indexing by task id
- helpers for hashtags, due dates, completion state, ordering

This code must be headless and usable from:

- frontend
- CLI
- import/export code
- tests

### 5.2 Task mutation operations

Examples:

- mark done / not done
- update description/content
- append note/content
- create task
- delete/archive task if supported
- search/select/filter tasks

These operations should be expressed in a way that is usable both:

- against in-memory document state
- through a syncdoc-backed live session

### 5.3 Syncdoc integration

Tasks needs a headless syncdoc session layer.

This is necessary so CLI operations can:

- participate in RTC
- avoid filesystem autosave races
- work without a browser session
- remain low latency after the first connection

This sync layer should be app-specific in `packages/apps/tasks`, but built on shared syncdoc/conat primitives.

### 5.4 Frontend rendering and UI behavior

This includes:

- the task editor React components
- task-specific view logic
- task-specific commands/toolbars

This UI code should use the markdown surface and host adapters defined by the tasks app boundary, with the current frontend stack providing the default implementation.

### 5.5 Export and import

Tasks should own:

- `cocalc export tasks`
- `cocalc import tasks`
- canonical exported machine-readable files
- future UI export actions for tasks

This matters directly for agent workflows.

### 5.6 Fast CLI operations

Tasks is also the first target for headless syncdoc-based CLI editing.

Examples:

- `cocalc tasks set-done`
- `cocalc tasks update`
- `cocalc tasks append`
- `cocalc tasks add`

These should use a live syncdoc-backed session, not file rewriting.

## 6. Why Tasks Must Be Its Own App Package

Tasks now needs all of the following at once:

- frontend editor behavior
- headless model logic
- syncdoc session logic
- export/import logic
- CLI logic
- eventual app manifest/registration

If tasks remains spread across `packages/frontend` and CLI/export code elsewhere, then:

- app ownership remains unclear
- agents keep paying high search costs
- app-local reasoning stays hard
- refactors stay fragile

Making tasks its own package solves that.

## 7. Why Interfaces Must Be Defined First

Right now, tasks is blocked from being a clean app package because a significant part of its editor behavior is tied to concrete frontend implementations.

The first mistake would be to respond to that only by moving code around.
If the contracts remain implicit, we still have tight coupling, just in a different directory.

So the correct first step is:

- define the interfaces for the hard dependencies
- provide adapters from the current frontend implementation
- keep code movement secondary to contract clarity

This matters especially for the markdown editor dependency.
There are many plausible implementations of "a markdown editor".
What tasks needs from one is much narrower than the full feature set of Slate or CodeMirror.

Once that interface is explicit, we gain:

- a clean app boundary
- easier testing
- easier future swaps of the markdown implementation
- clearer agent understanding of what is actually required

After that, shared implementation extraction becomes an optimization and organizational improvement, not a prerequisite.

## 8. Relationship To `packages/frontend`

`packages/frontend` should gradually become the shell/workbench, not the library every app depends on.

Its role should be things like:

- frame tree
- top-level layout
- global menus
- project/account/session integration
- app loading and hosting
- cross-app shell state

What it should not become:

- the place where app-local business logic lives
- the place where app-specific import/export logic lives
- the package that all apps must depend on

For this first refactor, it is acceptable for `packages/frontend` to continue hosting tasks integration points while the app package is introduced.
But the long-term direction should be clear.

## 9. App Manifest Direction

Do not overbuild plugin loading yet.
But do establish the idea that an app has a manifest and capabilities.

For tasks, the eventual manifest should be able to answer:

- file types handled: `.tasks`
- frontend frame/editor entrypoint
- export support
- import support
- CLI support
- whether a live syncdoc session is supported

This is enough to orient both humans and agents.

It also creates a clean path to later support:

- swappable implementations
- user-installed editors/apps
- managed apps

## 10. Agent Integration Requirements

The architecture should make these workflows first-class:

### 10.1 Export / work / import

Agents are often better at working against exported local trees than against remote stateful APIs.

Tasks already demonstrates this.

A tasks app package should keep export/import logic close to the document model so agents can:

- export tasks
- modify canonical task records
- import back safely

### 10.2 Fast live task operations

For simple actions, full export/import is too heavy.

Agents also need low-latency direct commands.

A headless syncdoc-backed tasks session allows:

- safe live edits
- no browser dependency
- reuse across multiple operations
- natural use by bug-hunt/reporting skills

### 10.3 Discoverability

Agents need to know where task behavior lives.

A single app package plus explicit host/editor interfaces is far better than scattered logic across:

- `packages/frontend/...`
- export code
- import code
- CLI code
- sync helpers

## 11. Concrete Migration Plan

### Phase 1: Define package boundaries and contracts

Create:

- `src/packages/apps/tasks`

And define the first contracts for:

- markdown editing/rendering
- tasks host/workbench services
- sync session access

Do not move everything immediately.
Just establish ownership, required interfaces, and default adapters.

### Phase 2: Move headless task model into the tasks app package

Move or reimplement:

- parsing/serialization
- normalized record types
- task indexing
- mutation helpers

This code should be testable without React.

### Phase 3: Move task export/import ownership into the tasks app package

Keep using the shared export core in `packages/export`, but make tasks-specific logic owned by the tasks app package.

The pattern should be:

- shared export core stays generic
- tasks app provides tasks-specific exporter/importer logic

### Phase 4: Add syncdoc-backed CLI task session

Add a tasks CLI session layer that:

- opens the document over syncdoc/conat
- uses a reusable timed resource
- supports multiple low-latency mutations

This is the most important phase for agent productivity.

### Phase 5: Move remaining task frontend editor code behind the app boundary

Only after the contracts are stable should we decide whether a shared implementation package such as `ui-markdown` or `ui-slate` should be created.

If the adapters prove clean and the implementation is clearly reused, then extracting that package becomes low-risk and justified.

### Phase 6: Optional shared implementation extraction

If the earlier phases succeed, then extract the shared markdown implementation into a dedicated package such as `ui-markdown`.

That extraction should follow the interfaces, not define them.

At this point the frontend shell should mostly be hosting the tasks app, not owning its logic.

## 12. What Success Looks Like

This first refactor is successful if:

- there is a real `packages/apps/tasks` package
- there is a clear markdown/editor contract and default adapter implementation
- tasks no longer depends directly on all of `packages/frontend`
- the headless task model is reusable from CLI and export/import code
- fast syncdoc-backed CLI task operations are possible
- the organization makes task ownership obvious to an agent

Success does **not** require:

- moving chat/jupyter immediately
- building a full third-party plugin runtime
- unifying every editor in one shot

## 13. Non-Goals For This First Cut

Do not try to solve all of these now:

- full external plugin loading
- all app manifests for all file types
- generic managed-app lifecycle
- full jupyter/chat migration
- broad reorganization of every frontend package

This first cut should earn the right to generalize.

## 14. Why This Is The Right First Experiment

Tasks is small enough to move.
The markdown editor dependency is obviously important enough to make explicit via interfaces.
Agents already need both export/import and fast live task editing.

That makes this the highest-value, lowest-risk first example of a layered app platform in CoCalc.

If this goes well, it becomes the pattern for later work on:

- chat
- board/slides
- course files
- explorer
- eventually managed-app-backed editors
