# Chat Workbench: First Usable Prototype

Status: proposed implementation plan, not implemented. Written 2026-09-08.

## Product Question

Can an agent and a person work together on a concrete result without leaving
their conversation or operating another application?

Chat remains the narrative and command surface. A named result is something we
can inspect, select, revise, and discuss together. A frame is an optional larger
view of that result, not an inbox, dashboard, or notebook programmed in English.

The first version must let a real agent publish a plot or text, let the user
interact with it, and let the agent revise that same object in response. A
hardcoded UI fixture alone does not satisfy this plan.

## Scope And Explicit Non-Goals

Implement two result types:

- `plot2d`: bounded line/scatter series, labeled linear axes, point inspection,
  selection, and reset view. Enough for a function plot or a small matrix's
  eigenvalues in the complex plane.
- `text`: plain text with a title, readable inline preview, and an explicit
  Edit / Save / Cancel flow in the workbench. Enough for a proposed reply,
  explanation, or short draft. No actual email or support integration.

Both support revisions, inline presentation, opening in a chat frame, and an
explicit selection attachment to the composer. Source provenance is optional
but visible when provided. Existing execution tools produce the data; publishing
a result never executes code.

Do not include arbitrary HTML, user-authored SVG, raw Plotly specifications,
custom JavaScript, arbitrary layout descriptions, external image URLs, widget
module loading, external action execution/approval, or a new notebook engine.
Do not implement 3D, linked multi-view dashboards, a diagram editor, PiP, an
artifact browser, or a generalized task/progress system for this milestone.

Standard ipywidgets and local SageJS controls are plausible follow-ups, not
rejected directions. They must not delay the basic publish/inspect/revise loop.

## Two Acceptance Stories

### Plot

1. In a real agent thread, ask: "Plot this function" or "Help me understand the
   spectrum of this small matrix."
2. The agent computes using existing project execution/Jupyter tools, publishes
   a typed plot, and refers to the resulting inline card in its response.
3. The user reads it inline, then chooses Open in workbench. Chat stays visible.
4. The user selects points and chooses Ask about selection. A removable composer
   chip identifies the result, revision, and selection; nothing is sent yet.
5. The user asks a follow-up. The agent receives the exact selected IDs/values,
   reads the referenced result if needed, and publishes a revision of the same
   result rather than an unrelated second plot.
6. Earlier cards retain their original revisions. The workbench offers the new
   revision without interrupting active inspection.
7. Reload the chat. The plot and revision references still work without rerunning
   the computation or starting Codex.

### Text

1. The agent publishes a proposed reply as a text result, with fictional data.
2. The user opens it in the workbench, edits a sentence, and saves a revision.
3. The user selects text, attaches it to chat, and asks for a warmer tone.
4. The agent reads the saved revision and proposes an updated revision.
5. An unsaved user edit is never overwritten by an agent update or frame switch.
6. There is no Send email, Approve, or Execute button. This story tests shared
   drafting, not an external-action system masquerading as a text editor.

## Minimal UX Contract

- An inline result card has a compact title, revision indicator, useful preview,
  and Open in workbench. Additional provenance/download actions belong in More.
- Reuse the chat editor's existing frame tree. Add one `workbench` frame type.
  Explicit opening can create an adjacent split or reuse that chat frame's
  unpinned workbench. Never replace a terminal or another pinned resource.
- The frame is associated with its originating chat frame and thread. Two chat
  frames can inspect different threads/results without a global active target.
- The workbench shows one result at a time. Do not build tabs or a sidebar of all
  results yet. Existing frame controls provide resizing, closing, and expansion.
- Inline cards pin a revision. The workbench also pins a revision; show a small
  "New revision available" action rather than replacing what the user is reading.
  Human Save may select the just-saved revision, as an explicit user action.
- Result data/state is independent of React mounting. Opening a frame must not
  restart computation. View state (camera/range and selection) is local to the
  viewing session and keyed by result/revision, not a shared collaborator cursor.
- For a text selection, preserve offsets and exact selected text. For a plot,
  preserve stable series/point IDs and coordinates. Selection alone does not
  invoke the agent or grant permission for any action.
- Ask about selection adds a removable attachment to the originating thread's
  composer. It preserves the existing draft and waits for Send. Bind the pending
  attachment to that thread; do not leak it into another thread after navigation.
- Closing/reopening frames or virtualizing chat messages cannot discard saved
  results. Warn before discarding an unsaved text edit; agent updates do not steal
  focus, change scroll position, or resize an existing card unexpectedly.
- Use current CoCalc typography, Ant Design controls, `UI_COLORS`, keyboard
  boundaries, and appearance settings. On narrow screens use a single-pane
  result view with a clear return to chat rather than forcing three columns.

## Data And Persistence

Use explicit, versioned result records in the existing live chat sync store.
Small self-contained payloads avoid an additional blob service for this trial.
Do not write chat files directly or create a second authoritative JSON store.

Proposed records (names are new, not existing APIs):

- Revision: schema version, result ID, revision ID, parent revision IDs, thread
  ID, title, kind, payload, timestamp, actor/provenance, idempotency key.
- Chat reference: result ID plus exact revision ID, attached to a message/turn.
- Composer context: result/revision identity and bounded typed selection. Persist
  the reference and resolved selection in the submitted message for later audit.

Revisions are immutable at the application level. Treat them as untrusted project
content, not tamper-proof audit records. A source path is provenance, not an
instruction to fetch or execute it; a snapshot remains usable if the source moves.

Prefer deriving current heads from immutable parent-linked revisions. Concurrent
edits produce sibling revisions, never last-writer-wins destruction. Show a
conflict and let the user choose a version to continue from; preserving both is
sufficient for the prototype. Do not implement collaborative character editing.
Update requests name the parent revision they actually read.

Initial payload limits: 128 KiB serialized per revision, 32 KiB text, 8 series and
2,000 total points per plot. Require finite numbers, bounded labels, unique point
IDs, and known fields/enums. Reject unsupported kinds and oversized data with
actionable errors. These limits are prototype defaults, not performance claims.

The publication operation must be idempotent across tool retries. Persist the
revision before attaching its chat reference. Retry a missing reference without
duplicating the revision/card. Handle an interrupted agent turn explicitly:
either attach to its still-existing message or publish one clearly attributed
result message in the same thread; never select an unrelated active thread.

Existing chat synchronization governs stopped-project access. If the chat is
already readable, self-contained results must not require an extra kernel,
Codex process, or result service. Do not promise uncached offline access or a
new stopped-project transport. Project restart/reconnect must preserve results.

## Agent Interface

Extend the existing project chat CLI/backend scripting surface, rather than
requiring DOM scripting, browser auth, or manually generated Markdown markers.
Proposed operations:

- `publish`: explicit project/chat path/thread/message-or-turn target, typed
  payload, optional existing result ID and parent revision, idempotency key.
- `read`: exact result/revision, payload, provenance, and current heads.
- `list`: bounded results for one explicit thread, for recovery/discovery.

Publishing returns stable IDs and the created chat reference. It does not send a
new user prompt or trigger another agent turn. Agent instructions should explain
these operations with one plot and one text example. Their exact CLI spelling
must be settled during the API spike, before UI integration.

On user Send, resolve the selection against its pinned revision and include a
size-bounded, visibly attributed context block. Treat labels and text as untrusted
user/project data, never system instructions. If the revision cannot be read,
show a removable missing-context error rather than substituting current state.

Execution remains separate: existing live Jupyter APIs, shell tools, or SageJS
can compute results. Do not parse terminal output as executable frontend content.
Basic source opening should reuse the project editor; revision-specific source
claims require an actual pinned source reference, not just a mutable filename.

## Renderer And Security Boundary

The host owns the React renderers and all controls. Text is escaped plain text.
The plot schema is a deliberately small language, not a wrapper around arbitrary
renderer props or MIME output.

Inspect the installed plotting dependencies during the spike. Prefer adapting
an existing renderer with an explicit field-by-field conversion and fixed host
configuration. If this cannot be kept auditable and small, implement the limited
2D plot with host-generated SVG/canvas. Host-generated SVG is not user SVG input.
Do not expose HTML labels, images, URLs, templates, plugins, arbitrary config,
or callbacks. Do not pass the payload through with `{...payload}`.

Validate both before persistence and on rendering old/imported records. No new
runtime CDN dependencies or account-origin CSP relaxations. Set resource limits,
contain renderer errors, and provide a readable failure state without breaking
the conversation. A trusted library still processes untrusted inputs; this is
not a claim that typing eliminates renderer vulnerabilities.

Use existing project authorization and live-store access. Route by explicit
project ownership; steady-state result data follows the project data plane, not
a new hub proxy. Read-only viewers may inspect/select locally but not save
revisions or invoke an agent without existing permission. Public rendering is
not enabled in this milestone; unsupported clients show a safe placeholder.

## Code Map And Required Spike

Inspected starting points:

- `src/packages/chat/src/index.ts`, `server.ts`, `integrity.ts`: chat records,
  live-store access, and integrity validation.
- `src/packages/cli/src/bin/core/project-chat.ts` and
  `src/packages/cli/src/bin/commands/project/chat.ts`: existing project-routed
  chat operations. The core already uses `acquireChatSyncDB`.
- `src/packages/frontend/frame-editors/chat-editor/editor.ts` and `actions.ts`:
  frame registration and frame-scoped chat actions. Existing frame types include
  chatroom, terminal, TimeTravel, and search.
- `src/packages/frontend/chat/message.tsx`, `chatroom.tsx`, and
  `chatroom-thread-panel.tsx`: inline rendering, thread identity, and composer.
- `src/packages/frontend/components/plotly.tsx`: existing lazy Plotly wrapper;
  its generic prop spreading is not the proposed result security boundary.
- `/home/user/upstream/sagejs/website/live/README.md`, `cell-controller.mjs`,
  `widget-manager.mjs`: later session/widget integration. The staged widget
  runtime uses `@cocalc/widgets`; do not vendor the SageJS application into chat.

Before coding the main feature, resolve and record:

1. How additional records survive sync-store primary keys, integrity checks,
   export/import, message caches, unknown clients, and multiple chat frames.
2. How an agent invocation supplies stable originating thread and message/turn
   identity without borrowing mutable browser selection.
3. How to append idempotently and preserve concurrent revisions under the actual
   store semantics. Do not claim transactional compare-and-swap unless supported.
4. Which existing composer attachment mechanism can carry typed context, or the
   smallest explicit extension needed. Check submission and retry paths.
5. Which plot adapter can meet the constrained schema and accessible point
   selection requirements without adding a broad dependency/runtime surface.

These are bounded implementation questions, not a license to build a generic
artifact framework. If a constraint fails, record the specific blocker and a
smaller alternative instead of weakening persistence or authority boundaries.

## Implementation Sequence

- [ ] P0: Complete the spike above; settle schema, renderer, and CLI contract.
- [ ] P1: Implement validated revision storage and publish/read/list operations;
      exercise real publication into a disposable test chat without a browser.
- [ ] P2: Render plot/text inline cards and add the optional workbench frame;
      preserve per-frame identity and render useful failure/loading states.
- [ ] P3: Implement text revision editing, plot/text selection, composer context,
      and agent revisions. Complete both real end-to-end stories.
- [ ] P4: Test refresh/reconnect, concurrency, safety, accessibility, themes,
      narrow layouts, and virtualization. Record evidence and known limitations.
- [ ] P5: Have the maintainer use it on an actual task and assess whether the
      conversation is easier, not just whether the controls technically work.

Keep this under a developer/experimental feature gate until P4 passes. Record
the actual gate name and test commands in this file during implementation.
This plan authorizes neither production deployment nor external email actions.

## Tests And Definition Of Done

- Schema rejection: unknown fields/kinds, hostile strings, URLs in disallowed
  fields, nonfinite values, excessive payloads, malformed references.
- Persistence: idempotent retries, interrupted publication, sibling revisions,
  reload/reconnect, safe old-client behavior, and unchanged legacy chat messages.
- UI: user edits survive agent updates, selections bind to the correct revision
  and thread, references survive scrolling away/back, opening a result preserves
  the terminal, two chat frames do not cross-route, and close does not lose data.
- Accessibility: keyboard-only open/edit/save/cancel/context removal; accessible
  alternative to pointer-only point selection (e.g. a bounded data table);
  focus restoration, light/dark, narrow-screen and zoom checks.
- Live acceptance: a real agent publishes and revises a real computed plot; the
  user edits and discusses a text result. No source copying between separate apps.
- Run focused shared/CLI/frontend tests, relevant typechecks, and frontend lint.
  Use an authenticated browser for end-to-end evidence; fixtures alone do not
  demonstrate agent-to-chat integration. Do not send real support/email data.

Done means the two acceptance stories work durably and the user can judge the
interaction. It does not mean a general widget platform has been implemented.

## After The Prototype, Not Before

Evaluate a result-owned SageJS session with approved standard widget controls,
client-only parameter updates, and explicit lifecycle/resource limits. Evaluate
execution-backed task cards whose progress comes from measured events, not model
guesswork. Consider diagrams/whiteboards and full notebook source opening.

Support/email proposals need a separate action contract: exact payload revision,
recipients, authorization, approval invalidation, idempotent execution, and real
receipts. A plain text result must never imply that any of those exist already.
