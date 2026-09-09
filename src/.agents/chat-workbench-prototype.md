# Chat Workbench Prototype

Status: proposed for maintainer review; not implemented. Updated 2026-09-09.
This replaces the earlier two-renderer-first proposal in this file.

## Decision In One Page

Build a small shared text artifact inside an existing CoCalc agent chat.
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
7. Edit the text directly, Save, then ask the agent to shorten the edited reply.
   The agent uses the human-saved version, not its stale earlier draft.
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
- Start with escaped plain text preserving whitespace. Edit uses a standard
  multiline control with Save and Cancel, not a new rich-text editor. Markdown
  formatting is a later renderer decision.
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

Auto-display a completed agent revision only when following current, the update
descends from the displayed revision, and there is no unsaved edit or active
text selection. Do not stream partial rewrites into the document. Preserve focus
and scroll where possible; do not force-scroll to the changed passage. See changes
is an explicit action using existing diff primitives where practical.

Otherwise show a small New revision available action. An agent update cannot
overwrite a draft, steal focus, or change a historical view. Multiple heads are
a conflict, not permission to guess the preferred version.

No live character-level collaborative editing is required. Save creates a
revision; concurrent saves preserve both. Provide version selection and an
explicit resolution path without building a general merge editor. Guard
close/navigation when an unsaved draft would be discarded.

## Minimal Data Contract

Use the existing live chat sync store for small self-contained artifact records.
Do not write chat files directly, create a second authoritative JSON file, or
put authoritative content in localStorage.

Proposed records, not existing API names:

- Artifact revision: schema version, artifact ID, revision ID, parent revision
  IDs, thread ID, title, kind (text initially), payload, attribution, timestamp,
  and publication idempotency key.
- Chat reference: artifact ID and exact revision ID attached to a message/turn.
- Submitted context: artifact/revision plus selected text and offsets. Specify
  offsets as UTF-16 code units into the exact stored string; verify the quote
  matches. Bound selection to 8 KiB and reject excess rather than silently
  truncating and claiming to include the complete selection.

Initial limits: 32 KiB text, 128 KiB serialized revision, bounded titles and
identifiers. Reject malformed/oversized data with useful errors. These are
prototype defaults, not benchmarks; large documents are out of scope.

Revisions are immutable by application convention, not tamper-proof records.
Validate imported/restored content as untrusted. Updates name the parent actually
read. Retain concurrent sibling revisions; a resolution revision may name both
parents and contain the explicitly chosen text.

Persist revision before reference. Retry interrupted publication idempotently
without duplicate cards or lost revisions. Missing data gets an unavailable
state, never a substituted artifact or latest revision.

Saved results ride on normal chat synchronization. If the chat is readable, its
self-contained artifact must not need Codex, a kernel, or another result service.
This does not promise uncached offline access or new stopped-project access.

## Agent And Composer Integration

Add a small typed interface to the existing project chat CLI/backend surface:

- publish: explicit chat/thread/message-or-turn target, title, text, idempotency
  key; optional artifact ID and parents for an update.
- read: exact artifact/revision and current heads.
- list: bounded artifacts in an explicitly named thread.

These names are conceptual; record exact API/CLI spelling during P0. Use
project-routed live chat operations, not browser scripting, scraped HTML, or
special Markdown interpreted as commands.

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

Document one real tool recipe for publish/read/revise. Agent reads must see
human-saved revisions. The artifact is authoritative, not the model's memory.

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

P0 answers only four integration questions: live-store record semantics, agent
turn identity, typed composer attachment routing, and safe frame reuse. Include
export/import, message-cache compatibility, retries, and multiple chat frames.
Do not assume transactional compare-and-swap exists. If these records cannot
safely use the store, record the specific problem and smallest alternative for
review rather than silently weakening persistence guarantees.

## Safety And Permissions

The initial renderer is escaped text. No HTML, user SVG, JavaScript, external
resources, or generic renderer props. Publishing and viewing never execute the
contents. Validate on both write and read/render.

Use existing project authorization and explicit ownership routing. Artifact data
uses the project data plane, not a new hub proxy. Read-only viewers cannot save
or invoke agents without existing permissions. Do not enable new public artifact
rendering or relax CSP. Older clients must not corrupt artifact records; confirm
their actual behavior in P0 rather than assuming they can render placeholders.

No new third-party dependency is expected for text. Later renderers/runtimes
need their own bounded review. A trusted package does not make all its input
features appropriate for the authenticated application origin.

## Delivery Checklist

- [ ] P0: Resolve four integration questions; record schema, commands, attribution,
      experimental gate, and exact focused test commands in this file.
- [ ] P1: Implement publish/read/list and persistence. Demonstrate real agent
      publication into a disposable chat, including a retried publication.
- [ ] P2: Add inline cards, text workbench, Edit/Save/Cancel, and revision history.
- [ ] P3: Add highlight/comment, thread-bound composer context, and safe in-place
      agent updates. Complete the acceptance session with a real agent.
- [ ] P4: Validate reload/reconnect, concurrency, keyboard/focus, themes, narrow
      layouts, virtualization, and multiple threads/frames.
- [ ] P5: Give the maintainer a runnable local/dev build, test chat link, and a
      three-step try-it recipe. Record findings before broadening scope.

Use one feature branch with coherent commits and a draft PR when implementation
is requested. Keep behind an experimental feature gate. Production deployment
and external support/email actions are not part of this plan.

### Required Regression Evidence

- Duplicate publication, interrupted reference attachment, concurrent saves,
  missing revisions, import/restore validation, and legacy chat compatibility.
- Selected passage reaches the correct thread/revision after thread switching.
  Unicode offsets are correct and hostile-looking text remains literal data.
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
