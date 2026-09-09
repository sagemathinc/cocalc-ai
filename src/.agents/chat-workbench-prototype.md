# Chat Workbench Prototype

Status: implementation in progress on `feature/chat-workbench-prototype`.
Draft PR: https://github.com/sagemathinc/cocalc-ai/pull/509
Updated 2026-09-09. Usable text prototype; extended acceptance checks remain.
Revised to build on Patchflow syncdoc, the existing Slate Markdown editor,
and CoCalc's key:value blob storage, rather than adding parallel infrastructure.

## Decision In One Page

Build a small shared Markdown artifact inside an existing CoCalc agent chat.
The person can open it beside the conversation, edit it, highlight a passage,
comment on that passage, and have the agent update the same artifact in place.
Reloading preserves the result and its history.

The maintainer's Claude test is the interaction reference, not a specification
of Claude's internals. Their ChatGPT visualization test instead produced useful
interactive output but disconnected replacements on follow-up. Both patterns
have value; this prototype tests the shared-object pattern first.

The first milestone is deliberately text-only and must work with a real agent,
not just mocked messages. Once the maintainer can try that loop, add a bounded
2D plot through the same identity, revision, frame, and selection mechanisms.
Then separately qualify one browser-local SageJS experiment. Neither plotting
nor SageJS blocks delivery of the first usable text prototype.

Do not build another inbox, notebook engine, dashboard builder, generic layout
language, external-action system, or full artifact management application.

The collaboration engine already exists. Chat, Jupyter, and whiteboards use
CoCalc's syncdoc framework built on Patchflow: a distributed synchronized store
with merge semantics, not a CRDT. Structured fields and three-way-merged string
columns are sufficient building blocks here. This prototype adds artifact
identity, presentation, and a narrow agent interface to that machinery.

## First Acceptance Session

Use a disposable chat with fictional support questions:

1. Ask the agent: "Draft three short replies as an editable artifact. Do not
   send anything; I want to discuss and revise them with you."
2. The agent publishes a named artifact. Its message contains a compact card
   with a preview and Open action. Normal conversational explanation remains.
3. Open it in a right-hand chat frame. An existing terminal is not replaced.
4. Highlight a sentence and choose Comment. Focus moves to the originating
   thread's composer, with a removable chip identifying the artifact, revision,
   and passage. Existing composer text is preserved. Nothing sends yet.
5. Type "Ask which course they mean instead of promising a fix" and Send.
6. The agent reads that exact revision and updates the same artifact. The frame
   displays the requested revision automatically when safe, rather than opening
   another artifact or requiring a refresh. Offer See changes / Previous.
7. Edit the text directly using CoCalc's Slate editor, wait for its normal sync
   acknowledgement, then ask the agent to shorten the edited reply. The agent
   uses the live human-edited version, not its stale earlier draft.
8. Close/reopen the frame and reload the chat. Saved text and prior revisions
   remain available without rerunning the agent.

Success is this complete conversational loop. Beautiful cards without reliable
feedback and revision routing do not count.

## UI Decisions

- Inline card: title, revision, short plain-text preview, Open. Keep inline
  height bounded so updates do not shift the conversation being read.
- Workbench: one artifact, compact title/revision bar, Edit, and More. Use
  existing frame controls for resizing, expansion, and closing.
- Add a workbench frame to the existing chat frame editor. Explicit Open may
  reuse that chat frame's available workbench, but never replace an unrelated
  frame or discard an unsaved edit. Agent output does not rearrange the layout.
- Store explicit project, chat path, thread, artifact, and revision identities.
  Two chat frames work independently. Switching threads does not redirect an
  already-open artifact's feedback to the newly selected thread.
- Reuse CoCalc's Slate WYSIWYG Markdown editor and its Markdown source mode.
  Store Markdown in a mergeable string column, not serialized Slate nodes.
  Reuse the established remote/local editing and save behavior, with compact
  controls and a normal syncing/saved/error indicator. Do not introduce a
  textarea-first editor or a separate Save/Cancel versioning workflow.
- A visible Comment button supports selection and whole-artifact feedback.
  Preserve the selection when focus moves to the button. Keyboard selection,
  Comment, composer focus, chip removal, and return to the artifact must work.
- Comment attaches context; it does not approve or execute anything. There are
  no email-send, ticket-close, or external approval controls.
- Use existing Ant Design controls, UI_COLORS, and keyboard boundaries. Dark
  mode is required. On narrow screens use one pane with a clear return to chat.

### In-Place Updates Without Losing Work

Historical inline cards pin exact revisions. The open workbench follows the
current artifact unless the user explicitly chooses a historical revision.

Publish a completed agent edit as one logical update, not token-by-token partial
Markdown. The current view receives ordinary syncdoc updates; the existing
editor owns remote/local text merging. Do not add a wrapper that writes incoming
merged values back and creates synchronization feedback loops.

Preserve focus, selection, and scroll using the existing editor integration.
If a read-only passage is selected for feedback, pin that displayed snapshot
until the user dismisses the selection or chooses New revision available.
This freezes a view, not the authoritative store or other collaborators.
Historical views never silently switch to current. See changes is explicit,
using existing diff/history primitives where practical.

Do not implement a second revision DAG, sibling-head picker, merge editor, or
character synchronization protocol. Use Patchflow history and merge behavior.
Exercise concurrent human/agent edits, including overlapping changes: convergence
alone does not establish that an agent's stale rewrite preserved user intent.
The agent interface must make its editing base explicit (below).

## Minimal Data Contract

Use the existing live chat syncdb for artifact records and workbench references.
Do not write chat files directly, create a second authoritative JSON file, or
put authoritative content in localStorage.

Proposed records, not existing API names:

- Live artifact: schema version, stable artifact ID, owning thread ID, title,
  kind (Markdown initially), mergeable Markdown string, and producing-turn
  attribution. Keep structured metadata separate from the string column.
- Chat reference: artifact ID and exact published snapshot/version attached to
  a message/turn. A card can offer Open current while preserving what that turn
  actually showed.
- Workbench reference: project/chat/thread/artifact and current-versus-historical
  view, using existing frame state conventions. Local view state is not content.
- Submitted context: artifact and pinned snapshot plus selected quote and a
  validated anchor. Slate/rendered-text selection offsets are NOT automatically
  Markdown source offsets. Reuse an existing selection/source mapping if one is
  available; otherwise store UTF-16 offsets into a canonical plain-text snapshot
  alongside the exact Markdown snapshot. Disambiguate repeated passages rather
  than silently attaching to the first match. Bound selection to 8 KiB and reject
  excess rather than claiming a truncated selection is complete.

Initial limits: 32 KiB Markdown, 128 KiB serialized snapshot, bounded titles and
identifiers. Reject malformed/oversized data with useful errors. These are
prototype defaults, not benchmarks; large documents are out of scope.

Use existing syncdoc history for historical reads where its addressing and
retention guarantees suffice. P0 must verify those guarantees, not assume a hash
alone retrieves old content. If durable message references need additional
snapshots, retain bounded immutable publication/context snapshots in the same
store (or existing blob store). These are historical evidence, not a second
mutable authority or collaboration engine. Never snapshot every keystroke.

Snapshots are immutable by application convention, not tamper-proof records.
Validate imported/restored content as untrusted. Attribution identifies the
producing operation/turn; it does not certify model-authored claims as true.

Persist snapshot before reference. Retry interrupted publication idempotently
without duplicate cards or lost revisions. Missing data gets an unavailable
state, never a substituted artifact or latest revision.

Saved results ride on normal chat synchronization. If the chat is readable, its
self-contained artifact must not need Codex, a kernel, or another result service.
This does not promise uncached offline access or new stopped-project access.

Large static results belong in CoCalc's existing key:value blob machinery, as
with Jupyter outputs, with small typed references in syncdb. Reuse authorization,
loading, and export patterns; do not invent another blob service or store large
plot arrays in chat rows. Before enabling blob-backed results, specify retention
for referenced snapshots, copy/export behavior, and missing-blob UI. The small
Markdown milestone does not require a new blob-backed payload implementation.

## Agent And Composer Integration

Add a small typed interface to the existing project chat CLI/backend surface:

- create: explicit chat/thread/message-or-turn target, title, Markdown, and
  idempotency key; return stable artifact ID and published snapshot reference.
- read: current live artifact or exact snapshot; return Markdown and an opaque
  editing-base token usable by update. Read the live syncdoc, not its disk copy.
- update: artifact ID, editing-base token, bounded replacement or explicit text
  replacements, producing turn, and idempotency key; return the resulting
  snapshot and whether the edit was applied, rebased, or needs a fresh read.
- list: bounded artifacts in an explicitly named thread.

These names are conceptual; record exact API/CLI spelling during P0. Use
project-routed live chat operations, not browser scripting, scraped HTML, or
special Markdown interpreted as commands.

Start with a `project chat artifact` CLI command family backed by shared typed
operations, callable through the existing CLI scripting API as well. Exact
spelling is proposed, not implemented. Accept payloads through stdin or a file,
not giant shell-quoted arguments. This should work without an open browser and
without a separate model-specific tool transport. An agent-facing convenience
tool can wrap the same operations later; do not expose arbitrary syncdb set/delete.

### The Important Tool Boundary: Editing A Live Object

1. Agent reads the live artifact and receives its content plus editing base.
2. While it reasons, a human may edit that same artifact in Slate.
3. Agent submits its intended edit relative to what it actually read.
4. The adapter applies that base-aware edit through existing syncdoc/Patchflow
   machinery, not a blind assignment of stale whole-document text to a newly
   acquired current record. Prefer targeted replacements for local revisions.
5. If the available API cannot safely express that base or the edit is ambiguous,
   return a changed/needs-reread result. Do not silently overwrite intervening
   edits or invent another merge algorithm. Return the actual resulting content
   or snapshot so the agent does not assume its proposed text is the final state.

P0 must identify the concrete existing base-aware API and its acknowledgement
semantics. A frontend hash comparison is not a distributed compare-and-swap.
Separate submitted, synchronized, and persisted states according to guarantees
the store actually provides; do not label a queued local write durably saved.
Use scoped idempotency keys for retries and verify no duplicate update/card after
reconnect. Resolve any missing adapter capability before polishing the UI.

Publication must associate with the producing turn. Establish how the agent
gets its originating chat/thread/message-or-turn identity without borrowing
mutable browser selection. Do not fabricate a user message to carry output.
Document interrupted-turn publication and retry behavior before shipping.

On Send, resolve and validate the attachment against its pinned revision. Include
bounded structured context in actual agent input and retain it in the submitted
message. Artifact text is user/project content, never system instructions.
Unavailable context requires removal or retry, not silent substitution.
Preserve attachments per thread through draft switching and failed Send; clear
only after successful submission.

Document one real CLI recipe for create/read/update/list and include it in the
agent's runtime guidance. Agent reads must see synchronized human edits.
The live artifact is authoritative, not the model's memory. Selection feedback
includes its pinned historical context; an edit still starts with a current read.

## Integration Points And Bounded Investigation

Starting points inspected during planning:

- src/packages/chat/src/index.ts, server.ts, integrity.ts: chat records, live
  store access, integrity checks. Confirm keys and unknown-record behavior.
- src/packages/cli/src/bin/core/project-chat.ts and
  src/packages/cli/src/bin/commands/project/chat.ts: project chat operations;
  the core already uses acquireChatSyncDB.
- src/packages/frontend/frame-editors/chat-editor/editor.ts and actions.ts:
  frame registration and frame-local chat actions.
- src/packages/frontend/chat/message.tsx, chatroom.tsx, chatroom-thread-panel.tsx:
  inline rendering, thread identity, and composer.
- src/packages/chat/src/index.ts and src/packages/frontend/chat/register.ts:
  chat currently declares `input` as a string column. Use a consistent schema
  across all clients when adding/reusing an artifact Markdown column; do not
  configure merge behavior only in the agent process.
- src/packages/frontend/frame-editors/whiteboard-editor/types.ts and
  elements/text.tsx: structured `data`, diff-merged `str`, and the existing
  MultiMarkdownInput remote/local merge integration. Reuse this pattern rather
  than copying a buffered input that resets on every remote value change.
- src/packages/frontend/editors/markdown-input/multimode and
  src/packages/frontend/chat/git-commit/review-editors.tsx: Slate Markdown input
  and compact review UI. Reuse controls, not a separate editor implementation.
- src/packages/jupyter/redux/actions.ts: existing async key:value store (`akv`)
  initialization and project-scoped notebook blob naming/options.
- src/packages/cli/src/api/text.ts: an existing live-document agent API and
  expected-hash error pattern; a reference, not proof of atomic syncdb updates.

P0 answers four integration questions: base-aware agent edits and durable
snapshot references using existing store APIs, agent turn identity, typed
composer/Slate selection routing, and safe frame reuse. Include
export/import, message-cache compatibility, retries, and multiple chat frames.
Do not assume transactional compare-and-swap exists. If these records cannot
safely use the store, record the specific problem and smallest alternative for
review rather than silently weakening persistence guarantees.

## Safety And Permissions

The initial renderer/editor is existing Markdown/Slate under the untrusted,
sanitized content policy, never inherited trusted project-file rendering.
Formatting is supported; raw executable HTML, user SVG, JavaScript, and generic
renderer props are not. Disable uploads and external image/resource embedding
for this milestone; validate link protocols and pasted/imported content using
existing policies. Publishing and viewing never execute document contents.
Validate on both write and read/render, including historical snapshots.

Use existing project authorization and explicit ownership routing. Artifact data
uses the project data plane, not a new hub proxy. Read-only viewers cannot save
or invoke agents without existing permissions. Do not enable new public artifact
rendering or relax CSP. Older clients must not corrupt artifact records; confirm
their actual behavior in P0 rather than assuming they can render placeholders.

No new third-party dependency is expected for text. Later renderers/runtimes
need their own bounded review. A trusted package does not make all its input
features appropriate for the authenticated application origin.

## Delivery Checklist

### Implementation Notes (2026-09-09)

- Initial shared records and `project chat artifact create/read/update/list`
  commands are implemented. JSON writes use `--file <path>` or `--file -`.
  Explicit `--path`, `--thread-id`, and `--artifact-id` select the live document;
  payloads include `message_id`, `operation_id`, `title`, and `markdown`.
  Update additionally requires the exact `base` returned by read.
- Markdown reuses the existing `input` string column. Publications use a
  separate structured snapshot row, linked to an existing producing message.
  Retries do not roll back later edits. Locally observed stale bases are rejected;
  unseen concurrent changes still use Patchflow, not a claimed distributed CAS.
- Initial inline cards and a Slate workbench frame are wired. The frame supports
  current/published views and local edits. Selection feedback now pins rendered
  text offsets and the source snapshot, stages a removable account-scoped draft,
  and retains context on sent messages and in the pending-send outbox. The agent
  prompt includes that bounded context. The real-agent selection/update/human
  edit loop is verified below; extended acceptance remains open.
- No ordinary chat exposes creation controls. CLI create/update require
  `--experimental`; scripting requires `experimental: true` in open options.
  The gate is checked before opening the document. The frame type is hidden
  from ordinary menus and public editor selection. This is a rollout gate,
  not an authorization boundary for project code that can already edit files.
- Validation so far: shared chat suite and initial card interaction test;
  chat, CLI, and frontend package typechecks; frontend lint. Repeat after further
  changes. Connected-client overlapping edits and rotation retention still
  require validation. Browser integration and real-agent evidence appear below.
- Selection and workbench regressions now cover repeated rendered passages,
  Unicode offsets, out-of-artifact selections, background updates during a
  selection, keyboard focus changes before Comment, thread-targeted draft
  staging, removal, and sent-message thread validation. These are component
  tests; the live Slate/browser/agent evidence below supplements them.
- Agent context discovery is implemented as `project chat artifact context`
  with explicit `--message-date`; it rejects missing/ambiguous matches rather
  than choosing the latest message. Runtime guidance describes these commands.
  Backend scripting exposes `api.artifacts.open({ path, threadId,
projectIdentifier })` over the same operations. Installed runtime validation
  is recorded below; source/build tests alone do not prove deployment.
- Portable export/import now includes validated artifact rows and feedback.
  Import remaps thread/message identities and preserves exact snapshots; a
  filesystem fixture round-trip passes. Rotation's non-chat row retention was
  inspected, but a live rotation/artifact reload test is still outstanding.
- Real Patchflow document-level tests now cover independent concurrent
  human/agent text patches and publication retention. Legacy SyncDB serialization
  preserves artifact records. These do not replace the pending two-connected-
  client/Slate acceptance test. Feedback clearing is conditional on the submitted
  snapshot so delayed Send completion cannot erase newer feedback in that frame.
- The workbench now has a publication selector and explicit See changes view,
  lazy-loading the existing document diff viewer only on demand. Publication
  timestamps survive idempotent retries. A component regression checks that
  historical comparisons remain pinned during live updates.
- The maintainer's local Chromium is reachable via CDP on port 9222. Its
  authenticated Lite1b tab successfully opens the test project. Development
  build and real-agent acceptance evidence are recorded below.
- Full `pnpm -C src build:dev` completed. The disposable live chat is
  `/home/user/chat-workbench-prototype-20260909.chat` in project
  `1ce4fe78-19c7-40a8-a598-947975744cd9`, thread
  `8852a851-d2cd-4a56-8e11-68df1c2c1de4`. It was created through the chat CLI
  and opened in authenticated Chromium, not by writing chat JSON.
- The tools bundle built and host upgrade operation
  `471946eb-c686-4f09-a262-fb678d38e8d6` succeeded. The running project still
  initially exposed its old September 4 CLI. After the maintainer-approved
  restart (operation `93b99ae5-474b-4e83-83dd-81a418a045ad`), remote CLI help
  confirmed all artifact commands are available.
- A separate real-agent QA chat is `/home/user/chat-workbench-agent-qa-20260909.chat`,
  thread `9382a253-236b-4a0e-8c54-4f5a83c46ad9`, in that same project. The
  agent created `support-replies`; its card opened the workbench beside chat.
  It reported `replayed: true` for the identical retry. Browser selection of
  the first paragraph staged the exact passage chip and focused the originating
  composer. A follow-up was sent and its same-artifact update is under test.
  These observations do not yet complete the full acceptance matrix.
- Read-only component coverage confirms document visibility with disabled edit
  and feedback actions. This is UI regression coverage, not proof of backend
  permission enforcement or the pending live collaborator test.

### Agent Recipe For The Dev Acceptance Run

After upgrading the test runtime, confirm `exec-api` includes `api.artifacts`.
Use the runtime-provided exact CLI command with `exec --stdin` and this script
inside an actual agent turn in the disposable test chat:

```js
const doc = api.artifacts.open({
  path: process.env.COCALC_CODEX_CHAT_PATH,
  threadId: process.env.COCALC_CODEX_THREAD_ID,
  projectIdentifier: process.env.COCALC_PROJECT_ID,
  experimental: true,
});
const context = await doc.context(process.env.COCALC_CODEX_MESSAGE_DATE);
return await doc.create("support-replies", {
  message_id: context.message_id,
  operation_id: "initial-draft",
  title: "Support replies",
  markdown: "## Course question\n\nWhich course are you using CoCalc for?",
});
```

The follow-up turn must obtain its own context, `await doc.read("support-replies")`,
and call `doc.update` with that read's `base`, the same artifact ID, its own
producing message ID, and a fresh operation ID. Retry an interrupted operation
with the same payload and operation ID. Do not reuse the initial turn's message
ID for a new revision. The QA agent exercised this API against the live runtime,
including the current turn's context and a fresh read before its update.

### Remaining Milestones

- [ ] P0: Resolve four integration questions; record schema, commands, attribution,
      experimental gate, and exact focused test commands in this file.
- [x] P1: Implement create/read/update/list on live syncdb. Demonstrate real agent
      publication into a disposable chat, including a retried publication.
- [x] P2: Add inline cards, Markdown workbench using Slate and existing sync
      behavior, and published-snapshot/history views.
- [ ] P3: Add highlight/comment, thread-bound composer context, and safe in-place
      agent updates. Complete the acceptance session with a real agent.
- [ ] P4: Validate reload/reconnect, concurrency, keyboard/focus, themes, narrow
      layouts, virtualization, and multiple threads/frames.
- [ ] P5: Give the maintainer a runnable local/dev build, test chat link, and a
      three-step try-it recipe. Record findings before broadening scope.

### Live Acceptance Progress

The maintainer tried the prototype and confirmed the instant-opening shared
document experience. They reported imperfect flushing and an edit-mode height
regression. Commit `56ecf91fc5` gives the editor a flex-filled full-height layout
and explicitly flushes its current value on Read and Ctrl+S. Focused tests and
frontend typecheck/lint pass; an explicit static rebuild served this change.
Chromium inspection confirmed the full-height scrollable edit surface.

In the QA chat above, the real agent updated the selected notebook reply in
the same artifact. A human then appended a note through Slate; it survived a
full reload. A subsequent real-agent turn shortened another reply while
preserving the human note exactly and attached the publication to its new
response. A reused-runtime attribution issue discovered during this test was
fixed in `d661b868ed`, covered by all 70 app-server tests, and deployed with
host operation `a1ddc2a8-976b-4f74-b37b-b8eec2ceefc5`.

Two independent Chromium tabs of the QA chat also verified delivery of a final
typed line immediately after clicking Read. This proves that particular flush
path, not all simultaneous-edit or disconnect races. The remaining P4 matrix
is still open; the maintainer explicitly regards polished multi-user editing
as beyond the first prototype, but reported rough edges are retained here.

Follow-up verification: selecting Published 1 displayed the initial text rather
than the current human/agent-edited document. Commit `f8326a9424` removes a second
toolbar-height subtraction in the Markdown wrapper; live DOM measurements put
the editor bottom 12px above the frame bottom, exactly its outer padding. Both
Markdown adapter modes have regression coverage. Narrow navigation initially
failed live: bubbling button clicks reactivated the pane being left, and focus
was requested before the destination rendered. Commits `92e0efc98f` and
`cf430d4902` fix these separately. The 600px live round trip now opens a visible
artifact and returns focus to the `Ask Codex...` textbox. Closing the originating
chat frame still remains unverified;
the workbench currently obtains its syncdb through that frame's chat actions.

Focused commands (run from `src/packages/frontend`):

```sh
pnpm exec jest --runInBand chat/__tests__/artifact-merge.test.ts
pnpm exec jest --runInBand chat/__tests__/artifacts.test.tsx frame-editors/chat-editor/workbench.test.tsx
pnpm exec jest --runInBand editors/markdown-input/__test__/multimode-contract.test.tsx editors/markdown-input/__test__/multimode-stale-callback.test.tsx
pnpm exec tsc --build
```

From the repository root, run `pnpm -C src lint:frontend` and explicitly rebuild
the dev browser bundle with `pnpm -C src/packages/static build:dev` when needed.
The additional Patchflow regression checks that a received overlapping human
edit invalidates the agent's old base without writing a publication, and that
a fresh-read update preserves the human wording. It does not claim protection
from an unseen simultaneous write or replace the connected-client test.

Additional live acceptance (2026-09-09): with the account's Appearance preference
left on System, browser media emulation switched the workbench between dark and
light without changing its contents. Computed dark text/surface colors were
`rgb(230, 232, 235)` / `rgb(34, 37, 41)`; light was `rgb(48, 48, 48)` / white.
The dark Slate editor was also inspected visually and retained full height.
Media emulation was restored afterward. Screenshots inspected during this run:
`/tmp/workbench-light-acceptance.png`, `/tmp/workbench-dark-editor.png` (local
ephemeral evidence, not repository assets).

Closing the QA artifact frame removed its document surface. Reopening from the
latest chat card recreated the frame with byte-for-byte identical rendered text,
including the human note and two-tab test line. The revision menu still offered
all three publications. This verifies artifact-frame remount, not closing the
originating chat frame or chat-log rotation.

Rotation integration now has direct filesystem/SQLite coverage in
`packages/lite/hub/acp/__tests__/chat-offload.test.ts`: rotate a three-message
thread down to its retained root/recent message, confirm the producing middle
message is archived, reopen the head file, and validate the human-edited artifact
and exact original publication. All eight offload tests pass via
`pnpm exec jest --runInBand hub/acp/__tests__/chat-offload.test.ts` from
`src/packages/lite`. This tests actual rotation and disk reload, not a connected
browser during a maintenance rotation; that distinction remains open.

Use one feature branch with coherent commits and a draft PR when implementation
is requested. Keep behind an experimental feature gate. Production deployment
and external support/email actions are not part of this plan.

### Required Regression Evidence

- Duplicate publication, interrupted reference attachment, concurrent saves,
  missing revisions, import/restore validation, and legacy chat compatibility.
- Human edits while the agent reasons; independent and overlapping edits;
  stale-base rejection/rebase behavior; two live Slate clients; no remote-update
  echo loops or silent overwrite from a stale whole-document assignment.
- Selected passage reaches the correct thread/revision after thread switching.
  Unicode, repeated passages, and rendered Markdown/source differences are
  handled correctly; hostile-looking text remains non-executable content.
- Agent updates the same artifact; unsaved drafts, selections, historical views,
  and existing terminal frames are preserved.
- Scroll-away/remount, reload, and reconnect preserve saved results.
- Keyboard-only edit/comment/send, focus restoration, and no shortcut leakage.
- Relevant shared/CLI/frontend tests, typechecks, frontend lint, and a real
  authenticated browser session. A fixture alone does not prove integration.

Done means the maintainer can perform the text loop and judge whether it feels
as direct as their Claude experiment. No plot or widget is required to complete
this first milestone.

## Immediate Follow-Ups, Separately Gated

### Bounded Plot

Add plot2d through the same protocol: at most 8 series and 2,000 points, finite
coordinates, plain labels, stable point IDs. Use a fixed trusted renderer with
explicit field mapping, never arbitrary Plotly props. The existing
src/packages/frontend/components/plotly.tsx is a candidate adapter, not already
this validation boundary. Host-generated SVG/canvas is another option.

Selections attach IDs/values to chat, with a keyboard-accessible data-table
alternative. Test a real spectrum and revision of that same plot. Some simple
illustrations can remain independent inline outputs; not every answer needs a
persistent workbench.

### One Browser-Local SageJS Experiment

Use /home/user/upstream/sagejs/website/live/README.md, cell-controller.mjs, and
widget-manager.mjs as references. Its embed already has session lifecycle
operations and uses @cocalc/widgets. Review current interfaces rather than
copying the standalone app into CoCalc.

Qualify one result-owned runtime with approved controls, explicit Run/Resume and
Interrupt, and local parameter computation without another agent turn. Separate
saved preview from live session. Preserve controls and bound workers/memory; do
not allocate a runtime for every historical output.

Prepare/cache a pinned runtime when the agent chooses SageJS, overlapping
download/initialization with answer generation. Do not preload on unrelated
chats. Measure cold preparation, warm preparation, and interaction separately.
The maintainer observed a 70-second ChatGPT visualization turn; that motivates
overlap, not a claim about measured SageJS loading time.

WASM is not an XSS boundary. Choose restricted typed output or a separate-origin
runtime surface before enabling rich output or widget callbacks. General widget
compatibility, arbitrary HTML, task dashboards, and external action approval/
execution are separate milestones, not requirements hidden in this prototype.
