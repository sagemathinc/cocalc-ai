# Complete Workflows From The Agents Page

Date: 2026-09-19

Status: implementation in progress. The first file/code workflow slice is live
and accepted; the reusable resource picker and later workflow slices remain.

## Objective

Make `/agents` a place where a user can request useful work, observe progress,
inspect the result, request changes, and obtain the finished output without
leaving the page. Success means completing real workflows, including their
review and revision steps, rather than merely receiving a message that the
agent finished.

Keep the conversation central. Open work beside it on wide screens and in a
reversible full-screen pane on small screens. Retain `Open in project` for the
full project environment. Avoid adding a second permanent file tree or another
always-visible layer of chat navigation.

## Existing Foundation

Code inspection shows that the Agents workspace embeds the real `.chat` frame
editor through `EmbeddedProjectFile`. Its chat actions advertise Workbench
capability, and published artifacts can open beside the conversation through
the existing frame tree.

Reuse these implementations:

- Agents embedding and navigation: `packages/frontend/agents/workspace-page.tsx`.
- Artifact publication cards and frame opening: `packages/frontend/chat/artifacts.tsx`
  and `packages/frontend/chat/open-artifact.ts`.
- Workbench documents, versions, comments, files, commits, PRs, and action lists:
  `packages/frontend/frame-editors/chat-editor/workbench.tsx` and its renderers.
- Git review: `packages/frontend/chat/git-commit-drawer.tsx`.
- Contextual replies and durable feedback drafts: existing chat feedback code.
- Execution, notebook manipulation, builds, file access, and agent messaging:
  their existing project-host and CLI services.

File previews currently cover bounded saved text, Markdown, source files, raster
images, and PDFs. They are not general live editors; `.ipynb` is not currently a
supported file-artifact preview. Ordinary `Open file` actions can navigate into
the project. These are concrete gaps to address, not capabilities to assume.

Related documents: [Workbench objects](chat-workbench-objects.md),
[contextual replies](chat-contextual-replies.md),
[publication smoke tests](workbench-publication-smoke.md), and
[earlier release evidence](workbench-first-release.md). Resource selection must
also align with the grouped picker and narrow provider authority in the
[agent connectors plan](agent-connectors-implementation-plan-2026-09-19.md).
Reuse their machinery and unresolved applicable checks. Historical evidence is
not proof that the current Agents integration passes.

## Workflow Scope

| Workflow                           | Required experience inside Agents                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Fix, implement, or refactor code   | Inspect changes, test evidence, and a revision; review the resulting commit when requested.                     |
| Diagnose a failed command or build | See the failure and relevant logs, request a fix, and inspect the next run.                                     |
| Create a report or LaTeX document  | Inspect source and rendered output, comment, rebuild, and download.                                             |
| Analyze a CSV or make a plot       | Select or upload input, inspect a data sample and plot, request a change, and download results.                 |
| Research or generate images        | Inspect cited findings or generated files and iterate on them.                                                  |
| Review Git changes or a PR         | Inspect the exact comparison and return contextual feedback to the originating agent.                           |
| Explain or modify a notebook       | Select the notebook, inspect rendered cells and outputs, and ask for a targeted revision.                       |
| Review proposed actions            | Inspect and revise proposals, record review decisions, and distinguish those decisions from execution outcomes. |
| Coordinate agents                  | Use the existing Agent Session and message UI while keeping each result associated with its producing agent.    |

Manual multi-file editing, interactive terminal sessions, and exploratory live
notebook use can initially use `Open in project`. Their later embedding should
reuse the real CoCalc applications.

## Decisions

1. **Keep work reachable from the conversation.** Both published artifacts and
   ordinary supported file links should open in the Agents workspace. Publishing
   a special card must not be required just to inspect a file the agent created.
2. **Make observed results available automatically.** The platform records a
   bounded result manifest for each turn from structured runtime/service events.
   Agent-written summaries and curated publications supplement that record.
3. **Describe evidence accurately.** A command exit code is not automatically a
   test result. A working-tree change is not automatically attributable to this
   agent. Missing evidence is unknown, not success or an empty clean result.
4. **Reuse Workbench and editors.** Extend their navigation and result adapters;
   do not build a parallel artifact store, diff viewer, or notebook engine.
5. **Preserve context.** Opening a result, switching agents, and returning to chat
   must retain drafts, selection context, scroll position, and useful open panes.
6. **Keep permissions as they are.** Opening a result uses normal project access.
   Review decisions use existing semantics and do not become generic execution
   authorization. Project data continues through the existing data plane.

## Delivery Plan

### 1. Complete One File And One Code Workflow

- [x] Audit existing link handlers, artifact controls, Git review, download,
      upload/attachment, and project-file selection from the Agents surface.
- [x] Add a shared open-result action that carries project, path or artifact,
      source agent/thread, and any exact revision available.
- [x] Route supported files and diffs into the existing Workbench beside chat.
      Keep explicit `Open in project` and usable download actions.
- [x] Make input selection practical: choose an existing project file or upload
      one, and show exactly which file the request references. Reuse existing
      upload and attachment services.
- [ ] Treat the first project-file control as a bridge to a reusable resource
      picker, not as the final discovery UI. Expose resources from `@` through a
      clear submenu/group. Define a provider boundary so project files are the
      first provider and authorized Google Drive or later connector resources
      can use the same interaction without granting broader access or copying
      remote data into the project merely to make it selectable.
- [x] Keep result panes scoped to the agent conversation, with Agents-specific
      layout preferences independent of the normal project desktop. Reuse an
      already-open result rather than creating duplicate panes on every click.
- [x] Verify a report-to-PDF workflow and a failing-test-to-reviewed-fix workflow
      through one revision each before expanding the result UI.

This first slice delivers useful workflows even before automatic result
collection is complete. It also exposes which evidence is actually missing.

Live acceptance on `lite1b.cocalc.ai` used the Agents page without a refresh:

- The document workflow created LaTeX and PDF files, diagnosed an initially
  unavailable build dependency, built the PDF, opened it beside chat, downloaded
  it, requested a title revision, and refreshed the existing result pane.
- The code workflow began with a failing Node test, fixed the implementation,
  displayed the source beside chat, requested input validation and another test,
  reran successfully, and preserved a pre-existing unrelated file byte-for-byte.
- Existing-file selection and upload both insert an explicit project-file link
  into the draft. This control is intentionally an interim bridge. The unchecked
  resource-picker item above remains required for `@` discovery and later narrow
  connector providers.

### 2. Collect And Render Observed Turn Results

- [ ] Define a small, versioned turn-result manifest keyed by project, chat,
      thread, and producing turn/message. Reuse existing artifact references and
      runtime identifiers rather than copying their payloads.
- [ ] Include typed entries for observed file changes, command/build/test runs,
      generated outputs, commits/PRs, and explicit artifact publications. Each
      entry carries its evidence source, observation time, locator, and revision
      or digest where available. Large content stays outside the manifest.
- [ ] Populate entries incrementally from structured runtime events and existing
      typed services. Support turns that run for hours or days. Finalize the
      manifest on completion, failure, cancellation, or interruption while
      retaining partial results.
- [ ] Deduplicate event replay and reconcile reconnects by stable event/result
      identity. Manifest collection failure must not fail or repeat agent work.
      The UI should say when result collection is incomplete.
- [ ] Use a bounded repository baseline/final comparison where available as
      supplemental evidence. Preserve pre-existing dirty changes and identify
      untracked files. Label unattributed changes as observed project changes;
      do not claim ownership when a human or another agent may have edited them.
- [ ] Render a compact results group in the turn, visible with activity hidden:
      changed files, outputs, and available run evidence. Group related entries,
      cap initial display, and expand logs/details on demand.
- [ ] Integrate curated artifact cards with the result group so the same output
      is not shown twice. Plain conversational turns need no empty results card.

The first collector only promises evidence exposed by existing structured
channels. Arbitrary shell commands cannot reliably reveal every produced file,
external action, or test outcome. Display generic command evidence when that is
all that is known; add specific adapters only for the workflows that need them.

### 3. Complete Review And Revision

- [ ] Reuse contextual comments for text passages, code/diff lines, errors, and
      supported image selections. Every comment identifies the source file or
      artifact, originating thread, and the displayed revision or snapshot.
- [ ] Keep comments attached to the version the human actually inspected when
      the agent changes a file concurrently. Label saved-file previews separately
      from live editor contents and pinned historical comparisons.
- [ ] Return revisions to the originating conversation even after switching
      agents or maximizing a result pane. Preserve private drafts on close and
      refresh; show real submission and failure states.
- [ ] Refresh a revised output without discarding the user's place. Use exact
      pinned comparisons for commits and PR review, with an explicit action to
      move to newer changes.
- [ ] Reuse proposal review controls where applicable. Show approval/rejection
      and execution status separately; do not add an approval gate to every file.

### 4. Notebook Review

- [ ] Add a notebook result view using existing notebook renderers and the live
      notebook session API. Include stable cell references, visible outputs,
      execution state, and errors.
- [ ] Clearly label captured output versus current live state. Reading or
      opening a result must not execute cells.
- [ ] Support selecting a cell or output and asking the agent to explain or
      revise it. Agent operations use the live notebook state rather than
      filesystem JSON that may lag behind unsaved changes.
- [ ] Validate one complete notebook explanation/modification/review workflow.
      Keep interactive notebook editing in the project until embedding the real
      editor has its own tested lifecycle.

## Release Landing Plan

Land the current Agents and first-workflow slice before expanding the workflow
scope. The branch is already large enough that adding another vertical slice
would increase merge, review, deployment, and rollback risk without proving the
existing product surface in production.

### P0 Release Gates

- [x] Freeze feature scope at the current Agents workspace, Workbench, file/code
      workflow, and Agent Session capability. Defer result manifests, notebook
      review, connector providers, and autonomous coordination.
- [x] Provide an explicit `Remove from Agents` action that retires the named
      registration and frees its quota slot without deleting the `.chat`
      conversation, artifacts, or historical Agent Session records. Retired
      members become unavailable for subsequent session delivery.
- [x] Reconcile the branch with `origin/main`, resolve conflicts by preserving
      the shared chat/project behavior, and rerun focused checks after the final
      merge result. Do not stack more feature work on the pre-merge branch.
- [x] Complete a security review of account-home and project-owning-bay routing,
      human session binding, Agent Session membership and revocation, RPC
      admission/execution, identity recovery, blob/attachment access, replay and
      idempotency, bounded payloads, denial behavior, and secret-safe logging.
      Handle any suspected vulnerability through the private process in
      `SECURITY.md` rather than documenting it on the public branch.
- [ ] Validate schema upgrades from the previous release and a rollback that
      leaves new tables inert. Confirm older clients fail closed or degrade
      safely when they encounter the new Agent and Workbench records.
- [x] Run package typechecks, focused server/frontend tests, frontend lint, the
      full development build, and dependency/version consistency checks from the
      reconciled tree.
- [ ] Exercise the release matrix in both Lite and hub-backed Launchpad: create,
      name, copy, remove, and re-register agents; hit and recover from quota;
      send, queue, interrupt, reload, and reconnect; upload/select files and
      paste images; open/revise/download artifacts; change projects/directories;
      create, pause, modify, and close Agent Sessions; verify denied and expired
      authority paths.
- [ ] Check keyboard operation, focus restoration, 200% zoom, narrow layouts,
      light/dark appearance, reduced motion, and screen-reader names for every
      new menu, dialog, drawer, status indicator, and composer control.
- [ ] Define staged rollout, observability, and rollback: feature availability,
      quota and authorization denial metrics, RPC outcome/latency metrics,
      Workbench/open-file failures, blob resolution failures, and a way to turn
      off new Agent messaging without disabling ordinary `.chat` files.

Release-audit evidence after reconciling `origin/main`:

- The full development build and dependency consistency check pass.
- Focused merged frontend/account tests pass (89 tests), along with the HTTP
  external-agent approval tests (4 tests).
- The complete Conat agent/RPC/attachment suite passes (104 tests), the server
  agent/security suite passes (103 tests, with 2 environment-specific skips),
  project-host agent tests pass (13 tests), and the complete CLI suite passes
  (822 tests).
- Frontend lint passes. The security audit also restored registry visibility for
  the three expansive Agent Session mutations and updated transactional external
  enrollment coverage for add-member failure and revocation rollback.

### Terminology

Keep **Agent Session** for the current bounded membership, authorization, and
delivery channel. A session can connect two or more agents, but it does not by
itself schedule work, choose delegates, or pursue a shared objective.

Reserve **Agent Swarm** for a future autonomous coordination construct that may
create or use one or more Agent Sessions. Renaming the current security boundary
to “swarm” would imply orchestration behavior it does not have and make support,
audit, and permission language less exact.

## Acceptance And Release

Use disposable fixtures and the Chromium browser on port 9222 against
`lite1b.cocalc.ai`. Record build/runtime versions, model/payment source, exact
steps, observed failures, and evidence. Do not mark a workflow complete based
only on an agent's final prose or unit tests.

| Scenario  | Completion criterion                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code      | Start with a failing test and a pre-existing unrelated edit; inspect the failure, fix diff, successful rerun, and a requested revision without leaving Agents. The unrelated edit remains intact. |
| Document  | Create LaTeX and PDF, view both, request a specific change, inspect the rebuilt PDF, and download it.                                                                                             |
| Data      | Upload or select a CSV, inspect a plot, change one plotting requirement, and download the revised output.                                                                                         |
| Git       | Inspect local changes or an existing PR at explicit base/head revisions, comment on a line, and review the revision in the originating conversation.                                              |
| Notebook  | Explain a notebook with unsaved live changes, modify a referenced cell, run the intended cells, inspect outputs, and request a correction.                                                        |
| Proposals | Review fictional support drafts, change one and reject another; show decisions without sending external messages.                                                                                 |
| Long turn | Open an intermediate result while the agent is running, submit contextual feedback, and inspect the eventual revision.                                                                            |

For the shared paths, verify switching away and back, a network interruption,
replay without duplicate cards, reload recovery, a failed/cancelled turn, missing
or oversized output, and concurrent edits. Normal completion and one revision
must work without requiring a refresh. Check keyboard access, narrow layouts,
light/dark appearance, and return of focus to the conversation.

Use focused automated coverage for result identity/replay, evidence semantics,
navigation/context retention, and feedback revision binding. Run the relevant
package checks and frontend lint. Keep paid model smoke tests separate from CI;
keep external service mutations out of fixtures.

Ship in the slices above. Each slice needs an observed end-to-end workflow and
its failure behavior before the next is called complete.

## Future Ideas Explicitly Excluded From This Plan

- A complete project desktop, terminal manager, or always-visible file explorer
  inside Agents.
- A new notebook engine or full interactive notebook embedding in the first
  release of these workflows.
- Universal discovery of arbitrary shell side effects or perfect attribution
  of concurrent filesystem changes.
- Automatic publication/execution of external actions inferred from a result
  card, including sending email, merging PRs, or deploying applications.
- A workflow language, task scheduler, manager-agent hierarchy, or a rewrite of
  Agent Sessions and messaging.
- Implementing new connector backends, public artifact sharing, cross-project
  artifact references, or an application-preview hosting platform. The shared
  resource-picker boundary and `@` entry point are in scope so later connector
  providers do not require another composer UI.
- A second history/versioning system or a claim that editable project chat
  history is an immutable audit record.
