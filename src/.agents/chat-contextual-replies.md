# Contextual Replies And Artifact References

Status: expanded design for maintainer review, 2026-09-11. Not implemented.
Parent: [Chat Workbench Prototype](chat-workbench-prototype.md).
Existing objects and acceptance: [Chat Workbench Objects](chat-workbench-objects.md).
PR #509 stays draft. This document defines the next slice; it does not authorize
unrelated external actions or declare the original prototype fully accepted.

## Product Decision

The shared operation is a conversation about something specific, not merely
"artifact feedback." A target may be an assistant message, an artifact, a file,
a selected PDF proof, a notebook output, or several objects together.

Acceptance sentence:

> I see something, point to it, explain what I want, and the agent understands
> exactly what I meant. I can inspect the change without losing my place.

Users should not need to reconstruct context by copying and pasting content
that CoCalc already knows. Ordinary copy/paste remains available. Chat remains
the conversation and orchestration surface, not another dashboard or inbox.
Artifacts remain durable collaborative objects in native frame tabs.

### Decisions Carried Forward

- Reuse Patchflow syncdoc for shared objects and submitted conversation data.
  Patchflow is not a CRDT. Keep mergeable text separate from structured fields.
- Reuse Slate, the existing private draft controller/browser fallback/backend
  store, the existing assistant expandable-context convention, and normal chat
  sending/queueing. Do not invent a parallel execution or conversation service.
- Drafts are private. Never persist unsent comment text, selections, attachments,
  or review decisions in the shared chat SyncDB or agent-readable project files.
- General comments do not require a selection or a small text snapshot. Images,
  PDFs, large files, and unsupported previews can still be discussed.
- Preserve the main composer draft when sending from a local comment editor.
- Source identity and destination thread are distinct and explicit. Opening a
  different browser frame or changing the selected thread cannot redirect Send.
- Keep typed first-party renderers. Plugins, arbitrary HTML/JS renderers, and
  user-extensible bridge APIs are out of scope.

## Findings Motivating This Slice

Verified in source and the live QA chat, not inferred from product mockups:

- File comments currently require a text snapshot at most 32 KiB and disable
  binary files. The UI stages one feedback object above the main composer,
  making users infer where to type; a second staged object replaces the first.
- `use-chat-composer-draft.ts` uses the shared draft controller, account-scoped
  backend AKV and browser fallback. Its current retention is 14 days; reuse does
  not imply indefinite retention or guaranteed persistence before a save ack.
- `message.tsx` contains an old inline reply editor. The maintainer believes it
  is dead legacy threaded-chat code. Audit reachability before reuse; it is not
  evidence that the desired interaction exists.
- On September 10, the icosahedron generation returned a saved PNG and a blob
  reference, but the agent did not attempt artifact publication. On September
  11, a follow-up inspected a Markdown-only installed artifact API; listing
  failed with `unsupported or missing artifact`. It copied the PNG and called
  it an artifact, but no image artifact row was published. This is evidence of
  an integration/capability gap and a possible version mismatch, not proof of
  the precise cause of the list failure.
- The original image request also carried previously staged fictional support
  review context. The agent explicitly declined to execute those proposals.
  Context visibility and review-specific sending are acceptance requirements.

Evidence location: `/home/user/chat-workbench-agent-qa-20260909.chat` in project
`1ce4fe78-19c7-40a8-a598-947975744cd9`, thread
`9382a253-236b-4a0e-8c54-4f5a83c46ad9`. Original image assistant message:
`348536ae-c92d-405d-8041-05804fee00d5`; follow-up:
`34959986-2aed-4d3a-a256-cba3b3bda1f0`.

Local QA auth was recovered through the existing loopback `auth elevate --dev`
bootstrap with a new explicit account/profile and refreshed hub env. No project
restart was needed. Use that supported path or typed browser approval when auth
expires; do not repeatedly retry stale profiles, extract browser cookies, or
ask the maintainer to paste secrets.

## Interaction Specification

### Reply Beside A Selection

1. Selecting text in a supported assistant response or workbench preview reveals
   a small Reply/Comment action near the selection. Selection alone never steals
   focus, blocks copying, or sends anything. Support keyboard selection too.
2. Activating it captures the target and opens a compact local Slate comment
   editor. Show the quote or thumbnail, source title, captured-version status,
   and destination thread. Do not require opening the main composer to type.
3. Preserve that captured target if browser selection changes, the agent streams
   more output, the artifact refreshes, or another collaborator edits it.
4. Send posts one ordinary chat message with structured context through the
   existing authorized send/outbox path. It must not submit, clear, or append
   unrelated main-composer text or unrelated pending action approvals.
5. Confirm accepted/queued/sent/error accurately. Keep the reader's scroll,
   frame, and artifact state. Offer View conversation; do not navigate away
   automatically after success.
6. Add to composer is an explicit secondary action: append the text/reference
   to the intended private draft, preserving its existing content. Transfer only
   after the destination draft acknowledges persistence, avoiding lost drafts.

Toolbar Comment uses the same editor for whole-object feedback, including
images and files whose preview is unavailable. If Send is unavailable, explain
why (for example no writable destination), rather than disabling it because the
source is not editable. A user may read a document but lack permission to post
to a chosen chat; check both authorities independently.

Use a bottom sheet or anchored panel on narrow layouts instead of an overflowing
popover. Escape dismisses without discarding a saved draft and restores focus;
Discard is separate and explicit. Preserve document selection visually where
possible after focus moves. Avoid stacking many simultaneous popup editors.

### Main Composer References

- An Attach artifact control opens the existing searchable artifact browser in
  multi-select mode. Add a single Artifacts... entry to the existing `@` menu;
  do not replace people/agent mentions or flood that menu with every artifact.
- Each attachment is an independently removable chip with a quote/thumbnail,
  source title, version status, and expandable details. Open returns to its
  workbench/source, not a bare filename in an unrelated tab.
- Appending preserves text and all other attachments. Identical references can
  deduplicate, but different selections or revisions of one object are distinct.
- Source references may span threads in the same authorized chatroom. They do
  not change the destination thread. Cross-project attachment is deferred until
  independently authorized copy/routing semantics are specified.
- Review/approval context is visually and semantically distinct from ordinary
  references. Merely attaching an action list does not approve its proposals.
  Pending decisions must never silently ride along with an unrelated message;
  require an explicit review submission/confirmation showing exact decisions.
- Capability help distinguishes Existing artifacts from What you can create.
  Include examples and actual limitations; do not advertise deferred renderers.

Copy reference (rich Slate with readable Markdown link fallback), drag/drop,
short IDs, and multiple simultaneously open local comment drafts in the UI are
later conveniences. Stable identity belongs in the contract now; users should
not have to memorize hashes to compose a request.

## Shared Reference Contract

Design direction, not finalized exported TypeScript names. Review and freeze a
versioned schema in Phase 1 before wiring independent producers to it.

| Part             | Required meaning                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Source           | Explicit project, chat/path where relevant, thread, and message/artifact/file identity. A message need not become an artifact.                |
| Captured version | Exact publication, message revision, live capture, verified Git/TimeTravel revision, or explicitly unversioned locator.                       |
| Target           | Discriminated whole-object or selected-text target initially; PDF region, cell/output, image rectangle, and Git lines are adapter extensions. |
| Evidence         | Bounded quote and surrounding context, authorized snapshot/blob reference when needed, and visible availability/completeness status.          |
| Presentation     | Host-owned title, thumbnail/quote summary, source link, and expandable context details. Never arbitrary renderer props.                       |
| Response         | Private draft ID, Markdown text, ordered references, explicit destination, and a stable submission operation ID.                              |

Text targets need the exact selected quote, bounded surrounding text, and offsets
in a declared representation (for example UTF-16 rendered plain text), bound to
that captured representation. Rendered offsets are not Markdown/source offsets.
Repeated passages must remain distinguishable. A content hash detects mismatch
but is not an address from which lost bytes can magically be recovered.

Do not require whole-file text in every feedback object. For large documents,
capture the selected passage plus bounded context and a revision/locator. Whole
file questions can carry a locator with an honest snapshot status. Budget each
reference and the aggregate message, including serialization overhead. Keep an
explicit excerpt-too-large flow; never silently claim a truncated selection is
complete. Concrete count/byte limits must be tested against existing draft,
message, blob and model-input budgets in Phase 1, not guessed independently.

Images require actual visual input for the agent, not merely an image pathname.
Resolve whether the existing generated blob is suitable for durable retention
and authenticated agent input. Otherwise capture displayed bytes through the
existing blob machinery. Do not refetch a mutable file on Send and describe its
new bytes as the image the user saw. If exact capture fails, retain the draft and
offer retry or an explicitly labeled reference-only alternative.

Large binary payloads do not belong inline in SyncDB, localStorage, or prompt
JSON. Define snapshot ownership, ACLs, retention, orphan cleanup, copy/export,
and unavailable states before enabling blob-backed comment capture. Private
draft captures must not create publicly accessible blobs or shared document
records before submission. If no suitable private blob path exists, completing
that boundary is a prerequisite, not a reason to weaken draft privacy.

Submitted reference metadata and quotes become visible to the destination
conversation's readers. Disclose this sharing boundary when attaching content.
Recheck source and destination access on submission/resolution. Stored context
is untrusted data, never instructions with elevated priority or authority.

### Revisions And Relationships

- Editing an existing diagram/image normally preserves artifact identity and
  creates a new published version. Making a separate variant creates a new ID.
- Reserve typed relationships such as derived-from and related-to. A derivative
  points to the specific source revision when known, not silently to its latest.
- Relationships are provenance/navigation, not transitive access grants,
  automatic model-context expansion, execution dependencies, or certified truth.
- Handle missing/cyclic/duplicate references without recursive loading. Reject
  invalid self-derivation; apply count/depth limits to any future traversal.
- Relationship creation/navigation UI is deferred. Do not fabricate lineage for
  existing artifacts or add a new graph service for this slice.

## Draft And Submission Lifecycle

Use `DraftController`, `AkvDraftAdapter`, and the existing composer draft hooks.
Keep normal composer and local comment draft identities independent. Namespace
by the existing account/project/chat/destination scope plus a stable comment
draft ID; source selection alone is not a unique draft key. Audit browser cache,
backend adapter, logout/account switch and attachment caches as one boundary.

Persist the text and reference set as one coherent private draft snapshot.
Expose saving/saved/error state and the existing retention policy. Capture a
selection only when the user starts commenting or explicitly attaches it;
do not save arbitrary clipboard content or every selection in the background.

Reopening a source should offer Resume comment draft. Also provide a way to
recover pending comments when the original source is gone. Dismiss, Escape,
frame closure, refresh, temporary disconnect and resizing must not discard an
acknowledged draft. Two-tab conflicts follow the existing controller's conflict
handling; never blindly overwrite a newer draft with stale popup state.

Send uses a stable operation/message identity so double clicks, reconnects, and
ambiguous responses can be reconciled through the existing outbox. Clear only
the exact accepted draft revision, not a newer edit typed during submission.
Failure retains text and references. Removing/transferring an attachment while
sending must not mutate the already captured outgoing message.

The agent-running case reuses existing steering/queue semantics and exposes
which action will happen. Do not create a hidden second agent turn or interrupt
an unrelated thread. Reuse assistant expandable context and normal send policy;
do not blindly reuse the possibly dead legacy inline reply path.

## Renderer Adapters, Not A Universal Annotation Engine

One first-party comment editor and submission path, with adapters that expose
what can be selected, how to capture evidence, and how to reopen its source.

| Surface                        | Next slice                                               | Later adapter work                                                                                                           |
| ------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Assistant response             | Selected passage and whole-message reply                 | Additional message kinds after testing streaming, edits and virtualization                                                   |
| Markdown/text artifact or file | Selection/local comment; bounded excerpts for large text | Safe re-anchoring and richer change review                                                                                   |
| Raster image                   | Whole displayed image comment and visual model input     | Normalized rectangular selections, zoom/actual-size inspection                                                               |
| PDF                            | Whole-file reference comment; explicit capability label  | pdf.js page/text/region targets for questions such as "explain this proof"                                                   |
| Notebook                       | Deferred                                                 | File reference with notebook-aware read-only preview, output-only mode, stable cell/output targets and Open notebook at cell |
| Mermaid                        | Existing Markdown code-block rendering may be reused     | Diagram-first presentation, source toggle, export and node/source-ID targets                                                 |
| Git/PR/action object           | Whole-object discussion, without approval side effects   | Adapt existing pinned line reviews and batched comments to the common envelope                                               |

For PDF discussion, store annotations/targets with the conversation; writing
notes into the PDF is a separate feature. CoCalc's existing pdf.js annotation
layer currently handles links, so richer PDF integration requires real work.
Do not assume the file artifact's current browser PDF embed exposes selections.

Notebook preview uses existing live notebook/session or approved read-only
rendering APIs, not a raw JSON edit/read shortcut for live state. Opening it
must not start a kernel or run cells. Output-only view, Show code, and the full
editor escape hatch are presentation modes, not a replacement notebook engine.
Read-only is not an XSS boundary; rich outputs must obey the qualified renderer
policy. Arbitrary HTML/JS, ipywidgets and live kernel callbacks remain deferred.

Preserve the Git viewer's specialized line comments and batch review workflow.
Common context transport is not a reason to rewrite a useful diff UI. Keep
repository identity, full revision SHAs, before/after side, path and line anchors.

For positioning, evaluate existing range positioning plus AntD controls against
Floating UI's virtual-element/inline-range support. Positioning is not draft
storage, source anchoring or accessibility. Follow the shared keyboard boundary,
focus restoration, light/dark theme, animation and 320px reflow guidance.

## Agent Capability And Runtime Alignment

First resolve the observed installed interface/list failure on the actual QA
project. Check CLI, scripting declarations, shared validators, project service,
and runtime guidance together; local checkout success alone is insufficient.
Read supported versions/kinds from a bounded first-party capability description
or the existing help/API declarations. Make unsupported kinds/versions explicit
and keep one malformed record from hiding an otherwise usable catalog.

In an artifact-enabled conversation, a persistent generated image should
normally be published as a file/image artifact, using the exact generated
result and originating turn. Publication is successful only after the typed
API returns identity and readback confirms it, not because a PNG was copied.
Use stable retry IDs, preserve user-selected themes, and retain IDs on revision.

Update the CoCalc skill and injected guidance together after confirming deployed
capabilities. Do not edit the imagegen skill as a substitute for CoCalc
integration. A host-owned Open in workbench action based on structured image
tool results is a later fallback if agent publication is omitted. It must not
scrape Markdown, duplicate a card already published for the result, or silently
publish outputs from unrelated tools/threads.

## Implementation Phases And Gates

All unchecked items below are future work, not existing acceptance evidence.

### Phase 1: Contract And Runtime Qualification

- [ ] Review this plan; define exact versioned reference/draft/submission schemas,
      byte/count budgets, image transport and private snapshot ownership.
- [ ] Trace current assistant context, composer outbox, draft controller and
      permission checks. Determine whether legacy inline reply code is reachable.
- [ ] Reproduce and fix installed artifact capability/list mismatch. Run typed
      create/read/update/retry against all currently supported kinds in the real
      agent project. Record versions and actual failure cause.
- [ ] Specify compatibility: decode v1 artifact feedback as one reference;
      preserve source/quote/review semantics; do not invent missing snapshots.
      Do not drop old private drafts or automatically turn pending decisions into
      outgoing approvals. Unknown future kinds remain visible as unsupported.

Gate: schema/compatibility tests and an actual agent-created image card, not a
hand-created fixture alone. Keep public rendering and cross-project expansion
disabled until separately qualified.

### Phase 2: Complete Local Reply Loop

- [ ] Implement shared local comment editor, private persistence/recovery, and
      normal send/outbox integration without touching the main composer draft.
- [ ] Add selection action to assistant messages and text/Markdown previews.
- [ ] Add whole-object comments, captured raster image input, and large-file
      excerpt/reference feedback without the whole-file 32 KiB restriction.
- [ ] Verify focus, positioning, virtualized/unmounted source handling, streaming
      responses, submit failures, running-agent behavior and concurrent edits.

Gate: select -> comment -> send -> agent revision works on message text, a large
document, and the generated icosahedron. Image edits use the inspected image;
the artifact retains identity. Send preserves main draft and reading position.

### Phase 3: Multi-Reference Composer And Discoverability

- [ ] Add composer attachment control, `@` Artifacts... entry, multi-select
      browser, removable context chips and expandable details.
- [ ] Implement Add to composer as an acknowledged, lossless draft transfer.
- [ ] Make pending review/approval submissions explicit and prevent unrelated
      requests from accidentally carrying old decisions.
- [ ] Add concise capability help tied to actual supported kinds; keep normal
      human/agent mentions, search and native artifact tabs working.

Gate: attach two artifacts and ask for consistency, then combine a quoted
assistant passage and an artifact. No lost text, implicit thread changes,
duplicate context or unrelated approvals.

### Later, Separately Gated

PDF page/region feedback; notebook output-only preview and cell targets;
Mermaid source/node interactions; Git batch feedback adapter; relationship UI;
copy-reference and drag/drop; image region selection; verified history recovery,
export and file relinking. Plotly/SageJS experiments remain future work. Do not
let those expansions block the focused reply loop or imply plugin support.

## Acceptance Matrix And Release Gate

| Scenario                   | Required evidence                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant passage reply    | Select with mouse and keyboard; local editor captures exact quote; source keeps streaming/changes without changing outgoing context.                            |
| Large compliance/plan file | File over 32 KiB supports selected excerpt and whole-file question; bounded context is accurate and completeness is labeled.                                    |
| Generated image revision   | Agent creates a real card; user comments on displayed image; correct image reaches the model; revision preserves ID and prior reference.                        |
| Private draft              | Type locally, dismiss, close frame, reload/reconnect, and resume; second collaborator cannot read draft text or captures through shared state.                  |
| Composer independence      | A valuable existing main draft and its attachments remain unchanged after sending a local reply; transfer appends rather than replaces.                         |
| Multi-reference request    | Two artifacts, or message quote plus artifact; per-item remove/inspect; same artifact with different selections is not incorrectly deduplicated.                |
| Routing                    | Change selected thread, use split/full frames and cross-thread sources; Send retains explicit destination and correct source provenance.                        |
| Failure and retry          | Blob upload/send failure, double click, ambiguous ack, edit during send; no lost draft, duplicated turn or silently substituted snapshot.                       |
| Review isolation           | Reproduce the fictional-review-plus-image-request situation; pending decisions are visible and cannot silently piggyback on unrelated Send.                     |
| Permissions                | Test two actual accounts, viewer/writer differences, revoked access, imported/restored untrusted context and missing blobs. Mocks alone do not close this gate. |
| Accessibility/layout       | Keyboard-only open/type/send/Escape/recover, copy selection, focus return, 320px width, 200% zoom, light/dark and multiple native frames.                       |
| Existing behavior          | Artifact editing/search, native tabs, old feedback, assistant context, ordinary mentions, Git line reviews and action review safeguards remain intact.          |

Run focused shared-schema/draft/send/renderer tests, package typechecks,
`pnpm -C src lint:frontend`, and the relevant build/startup-budget checks.
Use the dedicated QA chat/browser, not the maintainer's unrelated drafts.
Never send real support replies or mutate GitHub as part of these tests.

Keep a dated record distinguishing tests, observed live behavior and unresolved
findings. Keep PR #509 draft until maintainer review, these focused acceptance
gates, and earlier outstanding collaborator/viewer checks pass. Format changes
are still affordable, but that does not justify destroying prototype content.

## Implementation Map

- Shared artifact validation/publication/feedback: `../packages/chat/src/artifacts.ts`.
- Private drafts: `../packages/frontend/chat/use-chat-composer-draft.ts`,
  `../packages/frontend/drafts`, and `use-artifact-feedback.tsx`.
- Message rendering/current send context: `../packages/frontend/chat/message.tsx`
  and `chatroom.tsx`. Audit dead inline-reply code before reusing it.
- Artifact selection/discovery: `../packages/frontend/chat/artifact-selection.ts`,
  `artifact-browser.tsx`, `artifact-catalog.ts`, and `open-artifact.ts`.
- Workbench adapters: `../packages/frontend/frame-editors/chat-editor/workbench.tsx`
  and the file/action/PR/commit artifact components beside it.
- Future qualified renderers: Slate Mermaid code blocks, latex-editor pdf.js
  components, and existing read-only/live notebook rendering paths.
- Agent integration: `../packages/cli/skills/cocalc/SKILL.md`, CLI artifact
  operations/exec declarations, project-host deployment, and
  `../packages/ai/acp/codex-app-server.ts` runtime guidance.
- Required frontend guidance: [Accessibility](accessibility.md). Control-plane
  changes must follow [Scalable Architecture](scalable-architecture.md).

Before implementation, confirm final schema names/budgets, snapshot retention
and the default running-agent send action with existing product behavior.
Do not use those bounded decisions as a reason to build a generic plugin,
annotation, workflow, or storage platform.
