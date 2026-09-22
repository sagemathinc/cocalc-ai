# My Agents Workspace: First Implementable Slice

Status: revised proposal for review, outside git. No implementation or release is
authorized by this document alone. Revised around explicitly registered agents,
New Agent, persistent mounted workspaces, and the owner's product feedback.

Assumption: agent messaging and the artifact work in
[PR #509](https://github.com/sagemathinc/cocalc-ai/pull/509) are fully available in
the implementation branch. Integrating or completing those branches is outside
this plan.

Concept: [workspace mockup](my-agents-workspace-mockup.png), generated using
[this imagegen prompt](my-agents-workspace-mockup-prompt.md). The lower New Agent
detail is a separate screen state, not a permanent panel. The image illustrates
the layout; existing CoCalc frame controls and theme remain the implementation
foundation.

## 1. Outcome

Make **My Agents** the primary working page for explicitly registered agents
across projects, with artifacts and terminals alongside the conversation. Put it
before **Projects** in the main navigation. Provide a default-off experimental
page preference; explain that enabling it also makes this the normal home page.

The first useful session is:

> Open CoCalc, create an agent in a selected project and directory, ask it to
> revise a document, edit and comment on the result, inspect a file or PR, use a
> terminal, switch to another agent, and return without losing work or opening
> a project page.

Projects still supply compute, files, collaboration, permissions, and billing.
The workspace uses those existing services behind the scenes. Show the selected
project and sharing context compactly; managing a project is an optional action.

The measure of success is completing this workflow, not adding another directory
of links or recreating the entire project desktop inside a new page.

## 2. Deliberately Bounded Scope

Explicit registration is the core product model, not a temporary discovery
shortcut. Only registered named agents belong on My Agents. Ordinary chats may
continue to exist elsewhere without appearing here. Do not scan project
filesystems or plan to automatically include every titled chat later.

An agent has a durable database identity and its existing Conat endpoint. Reuse
those records rather than introducing a second identity registry. Its `.chat`
file, thread, project, and default working directory describe the implementation
and execution context. They do not determine its position or hierarchy in the UI.
Two registered threads in one file and an agent in a different file are peers.
This slice embeds project-backed agents; external sending installations remain
in their existing management UI, not a new remote-execution workspace.
Display a useful agent name/title with its handle secondary where helpful.
Registration alone does not approve agent-to-agent communication or start a turn.

Included:

- A left agent list, New Agent button, search, pins, last-access order, and manual
  ordering. URLs and browser history remember the selected agent.
- New Agent in an existing project and chosen working directory, with a blank
  composer immediately available and registration completed before first send.
- Full existing single-thread chat: history, composer, streaming, attachments,
  questions, approvals, stop controls, and messaging when enabled.
- All artifact types and operations already supported by PR #509, displayed
  within this workspace: collaborative documents, file/image/PDF previews,
  proposed-action review, and GitHub comparisons.
- A real project terminal, opened by the user or represented as a terminal
  artifact produced by an agent, using the existing terminal component.
- Per-agent drafts and workspace state, with visited workspaces kept mounted
  when switching agents. Storage layout stays out of the user's mental model.
- A persistent, discoverable link to connection and installation management.

Deferred:

- Automatic discovery of unregistered chats is a non-goal, not a promised future
  feature. Search over registered-agent content can be a separate later index.
- Creating projects and automatic compute placement. New Agent initially uses
  existing projects, with an explicit link to create a project when none exist.
- New artifact formats other than the small terminal descriptor, interactive-app
  hosting, and embedded notebook
  editing unless those already work through the supplied components.
- A global live-status/inbox service, automatic coordination, and response SLAs.
- General file browsing, project administration, and a replacement desktop.

Plots supported by the existing image or artifact renderers work here. Notebook
execution and new interactive plot runtimes remain later extensions of the same
workspace, not acceptance requirements for this slice.

## 3. User Experience

### Navigation and Layout

Add `/agents` as an application route, separate from account settings. For opted-in
accounts, put **My Agents** to the left of **Projects** and use it for the normal
home destination. Preserve explicit document links, sign-in return URLs, and
normal back/forward navigation. In plain language: selecting an agent changes
the workspace, and the address lets the user bookmark or return to that agent.

The left panel starts with **New Agent** and search. Default organization is
**Pinned** (manually ordered) followed by **Recent** (last opened by this human,
not last message from an agent). Include a **Custom order** mode with drag handles
and accessible Move up/Move down actions. Store this organization as personal
account metadata; do not change collaborators' layouts. Avoid reordering under
the pointer or during keyboard selection. Optional grouping by project/directory
can follow real usage; it must not turn chat files into visible containers.

Desktop layout: the agent list on the left, selected agent chat in the
main area, and the existing artifact/terminal frame area alongside it. Reuse frame
tabs and resizing instead of introducing another layout engine. Start with chat
plus one companion area; multiple artifacts can use tabs within that area.

The chat header shows title, optional handle, project, and sharing information.
Provide **Open in project** as an escape hatch. Opening an artifact or terminal
from this workspace keeps the user here; that explicit escape hatch navigates to
the project.

On narrow screens show one area at a time, with clearly labelled ways to return
to the agent or list. Hide rather than unmount visited workspaces. Preserve
selection and drafts during transitions.

Integrate agents and their frames with existing
[Quick Navigation](https://cocalc.ai/docs/documentation/quick-navigation):
double-Shift (or the configured shortcut), search, frame previews, numbered frame
selection, and focus restoration. Do not build a competing command palette.

### New Agent

Clicking **New Agent** immediately shows a blank composer. Directly above it,
show selectors for **Project** and **Working directory** with sensible last-used
defaults, plus an editable name with a unique suggested value. Selecting a
CoCalc project already specifies where execution happens; do not add a redundant
local/remote selector. Branch/worktree selection can reuse an existing supported
control, but is not a new git-worktree feature in this slice.

Creating a new agent uses the existing chat creation and registration APIs. A
hidden chat file is fine; the user need not select one. On **Create & send**,
create/resolve the backing thread and registered identity, then submit the first
prompt through the ordinary execution path. Reuse stable creation identifiers
across failures and double-clicks so retries do not make duplicate agents. A
successful registration followed by a failed send leaves a usable agent and its
draft. An uncertain send must not be blindly resubmitted.

Opening the blank composer or creating storage must not itself start execution
or grant connections. Validate writable project access and directory through
existing APIs. If registration needs a backend adjustment to work independently
of the messaging admission flag, separate only metadata registration, not the
permissions to connect, send, or execute.

### Selection and Context

Selecting an agent immediately displays its cached display information, then
loads its actual thread and companion views. File reading/writing and chat
history access do not require starting the project compute container. Opening a
chat must not trigger compute startup. Prompt execution, code evaluation, and
terminals do need compute and use the existing authorization/startup rules.
Distinguish loading content from starting compute and explain any blocked action.

Use a bounded recent-thread snapshot while full history loads where this improves
first paint without duplicating the chat engine. Essential's `@cocalc/chat-client`
already supports selected-thread snapshots and bounded initial history. Assess
reuse for preview; replacing the full editor with the Essential UI is not required.

Artifact feedback retains the originating project, chat, thread, artifact, and
revision. Changing the selected chat never retargets feedback. An explicit action
to comment from another context returns to the originating conversation.

An artifact update does not steal focus or replace an unrelated terminal. Existing
human editing, revision, and approval behavior from PR #509 remains intact.

The terminal belongs to the selected conversation's project. Show its working
directory and project; choose the thread's configured directory where available,
otherwise the normal project default. Switching views must not kill a terminal
process or cancel a running agent. Reattachment uses existing terminal session
semantics; do not imply processes survive a project restart.

Support a terminal artifact as a small typed descriptor of a project, directory,
and terminal/session reference, rendered through the existing terminal frame.
An agent may expose a session it already started using its normal tools, or
suggest a command such as `gh auth login`. A suggested command is visible and
requires an explicit Run action; merely viewing, restoring, or previewing an
artifact must not execute or rerun it. Never include credentials in descriptors
or cached terminal output in account preview metadata. The regular Open Terminal
control remains useful too. Route supported `open [path]` links through the host
adapter to the full project at that path as an explicit escape hatch.

### Empty and Unavailable States

An empty list foregrounds New Agent. Also explain how to register/name an existing
chat. If the user has no project, link to existing project creation and return
to the draft afterwards; do not redesign compute provisioning here.
A missing thread, unavailable project, revoked access, or unavailable artifact
gets a specific state and an explicit retry where appropriate. Do not silently
select a different chat or substitute another artifact revision.

Directory availability is not an execution status. Only show running, completed,
or waiting-for-you when an existing authoritative activity source provides that
information. Otherwise omit the indicator or say status is unavailable. Extending
activity infrastructure is not required to ship this slice.

## 4. Implementation Boundary

### Database Registry, Personal Organization, and Preview

Use `useNamedAgents` / `listNamedAgents` to populate the list. Those APIs already
return project, path, and thread references. Resolve content through its existing
project owner/host routing. The account's home bay remains authoritative for its
personal directory.

Use the existing agent UUID/endpoint as identity, not its name or file path.
Renaming a handle or moving storage must not create a new sidebar identity.
Keep the authoritative project identity and personal account directory distinct:
registration records are not a substitute for current access checks.

Extend the appropriate existing personal record with last-opened time, pinned
state, and custom order. Debounce/coalesce last-opened writes; do not write on
every render or stream event. These preferences live at the account's home bay.
Project data access still resolves the project's owning bay and host.

A small PostgreSQL display cache is useful: agent title, last activity time,
and a bounded last-message excerpt with message/revision ID and freshness time.
Proposal: at most 2 KiB UTF-8 of plain text per agent; no transcript, rich HTML,
attachments, or terminal content. Paginate directory responses; fetch preview
text only for visible rows/selected agent, not an unbounded directory dump.
Coalesce preview updates at message completion or a modest interval, never every
token. The project chat remains the content source of truth.

Treat cached text as project content, not harmless account metadata. Serve it
only after current project access checks, invalidate it on access loss and
known message edits/deletions, and clear obsolete identity/account records using
existing lifecycle rules. Never use a stale preview to overwrite chat content or
prove task completion. Show its freshness while live data loads. If reliable
invalidation would demand a new synchronization service, ship title/time plus an
authorized recent-thread fetch first rather than an unsafe copied-content cache.

Listing agents must not open a syncdoc or start compute for each entry. Fetch
content on selection, not for every registered agent.

Treat the directory's messaging-enabled field separately from ordinary chat
access. Existing named metadata can be read for management when messaging is
disabled. Verify that opening an otherwise accessible chat still works with the
messaging admission gate off; leave all messaging actions behind their existing
checks.

### Embedded Workspace

Extract or adapt the smallest existing chat-frame host needed to mount a selected
conversation without foregrounding the project page. The unit to embed includes
the frame actions that PR #509 uses to open artifacts and the terminal.

Do not mount an entire hidden ProjectPage or fork ChatPanel into a second chat
implementation. Supply a narrow host adapter for workspace navigation, opening
companions, visibility/focus, and view persistence. Keep the standard project
host of the same components working.

Existing syncdoc, ChatActions, terminal, and artifact behavior remain the source
of truth. Presentation state must be isolated by account and conversation even
when two views share one chat document. In particular, opening My Agents must
not change the selected thread or layout in an already-open project editor.

Logical view key: account ID + stable agent endpoint/UUID, resolved to its backing
project/path/thread. The two threads in one file case is an internal isolation
test, not a separate user-facing navigation concept. If storage cannot be
resolved, show that fact rather than silently navigating elsewhere.

Use existing document ownership/reference-counting facilities so closing a
workspace view does not close a syncdoc still used by a project editor. Separate
view lifetime, document lifetime, and server execution lifetime.

### Persistence and Resource Use

Keep composer drafts and artifact feedback in the existing draft mechanisms.
Use existing account/browser workspace preferences for small view descriptors:
selected conversation, pane arrangement, open artifact references, revision
selection, and terminal session references. Content stays in its existing store.
Check that reused frame persistence is personal rather than a shared document
layout. Do not put file bytes or new credentials in these preferences.

Lazily mount an agent's workspace when first visited, then keep it mounted and
hide/show it when switching. This follows normal CoCalc editor behavior and
preserves DOM-owned scroll, terminal, selection, and frame state. There is no
two-view cap and no automatic unmount on each switch. Do not eagerly mount every
registered agent. Use existing visibility hooks to suspend unnecessary layout
work, focus handlers, and announcements in hidden views without cancelling
execution or breaking document synchronization.

Measure memory over realistic sessions. Explicit Close workspace can release
resources without deleting the agent or stopping its work. Long-inactive
workspace eviction is a possible later optimization, not a first-slice
requirement; it needs independent validation of pending edits and DOM restoration.

Reconnect to live data when restoring a view. Never save a stale restored document
snapshot back over current collaborative content. Account switching disposes old
subscriptions and uses the new account's view/draft namespace.

### Native Client Later

Keep agent identity, directory, creation, recent-history, and artifact descriptors
in typed headless APIs, not browser frame objects. The web adapter supplies the
existing frame tree; a future React Native app supplies native agent/chat/artifact
views and opens unsupported project tools on the website. Native work is not
part of this slice and does not require a universal UI framework now.

### Authority and Small New Surfaces

The intended architecture introduces no new principal, grant, cross-project
authority, or execution sandbox. Reuse all existing permission and execution
checks. It is mostly frontend composition, not entirely frontend: personal
ordering/preview fields and creation orchestration may need small typed backend
changes with ownership classification and bounded payloads.

Review the new wiring rather than assume there is no risk: cached snippets must
not leak removed access, project/directory selection must route to the intended
project, and terminal artifacts must not become executable content on view.
Hidden DOM is not an access-control mechanism; access loss must withdraw content
using the existing session lifecycle. Existing shared-project collaborator trust
remains unchanged. Interactive-app hosting is a separate later origin, permission,
and lifecycle design; do not add it incidentally to this slice.

## 5. Source Map

Inspect these existing components first; names below identify source areas, not a
requirement to preserve every current interface:

| Area                             | Starting points under `src/packages`                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Current directory and management | `frontend/account/my-agents-page.tsx`, `frontend/agents/api.ts`                                                               |
| Current project navigation       | `frontend/agents/open-agent.ts`, `frontend/projects/actions.ts`                                                               |
| Application routing/navigation   | `frontend/app/route-components.ts`, application page registry and top navigation                                              |
| Chat and frame host              | `frontend/chat/chatroom.tsx`, `frontend/frame-editors/chat-editor/editor.ts`, `frontend/frame-editors/chat-editor/actions.ts` |
| Artifacts from PR #509           | `frontend/chat/open-artifact.ts`, `artifact-browser.tsx`, `use-artifact-feedback.tsx`, chat workbench frames                  |
| Terminal                         | `frontend/frame-editors/terminal-editor` and existing session lifecycle                                                       |
| Drafts                           | `frontend/chat/use-chat-composer-draft.ts` and artifact feedback state                                                        |
| Directory routing                | `conat/agents/personal.ts`, `server/agents/personal.ts`                                                                       |
| Bounded recent-thread loading    | `chat-client`, `essential-frontend/src/chat-surface.tsx`                                                                      |
| Documentation                    | `docs` package under `src/packages/docs`; add an integrated My Agents guide                                                   |

PR #509's `openArtifact` currently uses the chat's frame-tree actions and origin
frame ID. Preserve that relationship in the embedded host. Merely rendering a
ChatPanel without its companion frame machinery is insufficient.

## 6. Delivery Sequence

1. **Prove the embedded host.** Behind a development route, open one existing
   thread with its existing frame actions, an editable artifact, and a terminal.
   Verify concurrent access through its original project editor. If this requires
   forking the chat engine or broadly rewriting the project framework, stop and
   reassess the boundary before adding directory UI.
2. **Add the registry-backed sidebar and New Agent.** Wire the existing named
   directory, personal pins/recent/custom order, search, agent URL, creation with
   project/directory, and failure-preserving drafts. Add only the necessary
   metadata endpoints, keeping ownership explicit. Keep
   connection/installations management at its current settings route, linked from
   the workspace. Avoid a new permissions UI in the main layout.
3. **Finish persistent workspaces and previews.** Exercise two projects and two
   registered threads in one chat file. Connect draft persistence, artifact-origin
   routing, terminal artifacts, view descriptors, and shared document references.
   Keep visited workspaces mounted. Add bounded display metadata and assess the
   recent-thread loading path; test stopped-compute browsing. Integrate agents
   and frames with Quick Navigation.
4. **Expose for real usage.** Add a default-off account preference under AI,
   **Enable My Agents Page (Experimental)**, independent of the messaging opt-in.
   Link to a new guide in `src/packages/docs` describing creation, organization,
   artifacts, terminals, and project escape hatches. Explain normal home behavior
   in the preference help text. Use existing preference plumbing, not a new
   feature-flag service. Opting out hides the page, not agents or approvals.
5. **Qualify and hand off.** Run the focused component/integration checks and
   the live session below. Produce a short usage note and record the tested source
   revision, environment, evidence, and any limits.

Each step should be a reviewable commit. Keep the independent messaging release
candidate pinned while developing this work on a separate branch based on the
combined, available foundations.

## 7. Acceptance Checks

### Required Live Session

Prepare three named chats: two threads in one `.chat` file in project A and one
chat in project B. Include a second human collaborator and a read-only account.

1. Open My Agents with an empty directory, click New Agent, select a project and
   directory, and create/send. Verify one registered agent and one first prompt
   under double-click, creation failure, and uncertain-send cases. Pin and reorder
   agents; refresh and verify personal organization. Unregistered chats stay out.
2. Enter agent A, send a request, and use an existing question/approval control.
   Verify streaming and stop behavior match the normal project chat.
3. Publish a Markdown artifact. Edit it directly, select a passage, comment, and
   have the agent update the same artifact using the human-edited version.
4. Open an image/PDF/file reference, proposed-action card, and GitHub comparison
   supported by PR #509. Existing actions and contextual feedback work here.
5. Open a terminal manually and through a terminal artifact in the correct
   directory. A suggested command waits for explicit Run. Reopening an artifact
   does not rerun it. Verify `open [path]` reaches the full project at that path.
6. Leave unsent composer text and artifact feedback in A. Switch to B and the
   second thread in A's chat file. Return and verify correct drafts, artifacts,
   terminal references, and layout. No send or feedback targets the wrong thread.
7. Open the same chat in its normal project editor and edit collaboratively.
   Content converges without coupling thread selection or layout between views.
8. Reload a selected-workspace URL. Restore the conversation and saved view/draft
   references without resubmitting a prompt or rerunning an external action.
9. While an agent runs, leave its view. It keeps running and its visited workspace
   stays mounted. Visit several agents and return: scroll, selections, terminal
   output, and frame layout remain intact. Hidden frames do not steal focus.
10. Exercise a stopped project, denied startup, lost access, missing artifact,
    account switch, and reconnect. State remains understandable and work is not
    silently sent, dropped, or redirected.
11. Use the read-only account: preserve existing readable content and allowed
    artifact views; editing, terminals, and execution follow existing permissions.
12. Disable messaging admissions and verify ordinary authorized chat remains
    usable, New Agent registration remains distinct from grants, messaging is
    rejected, and management stays accessible.
13. With project compute stopped, read chat history and edit an allowed file
    without starting compute. Sending a prompt or opening a terminal invokes the
    normal startup path. Display preview freshness; never claim loading is running.
14. Use Quick Navigation to find an agent and focus its numbered artifact or
    terminal frame. Confirm existing shortcut preferences and focus restoration.

### Automated and Usability Evidence

- Focused routing tests for explicit links, selected-thread restoration, home
  preference, browser navigation, and Open in project.
- Mutable-state tests for delayed project opens, rapid A/B switching, account
  switching, artifact feedback origin, and stale responses. Avoid frozen store
  mocks that cannot reproduce lifecycle changes.
- Shared-document/view lifetime tests, including hiding and explicitly closing
  one view while another editor still uses its document. Preserve failed-send
  drafts, mounted state across switching, and clear account state on sign-out.
- Creation/registration retry behavior, personal ordering isolation, preview
  size limits and permission invalidation, and terminal descriptor restoration
  without replay. Test actual mutable state, not only call expectations.
- Changed controls tested by accessible role/name, with keyboard selection,
  focus restoration, dialog handling, and editor shortcut boundaries.
- Frontend typecheck and `pnpm -C src lint:frontend`; applicable chat/artifact and
  shell tests. Run the navigation accessibility audit documented in
  `src/.agents/accessibility.md`.
- Check light/dark themes, 200% zoom, and a 320-CSS-pixel viewport. Use existing
  themed controls and `UI_COLORS`.
- Measure cold directory load and warm switching with a realistically populated
  directory. Record requests, mounted editor counts, and browser memory across
  repeated switches; do not load one editor or poll one project per list row.

The two-project workflow is required. If a multibay test environment is available,
put A and B in different bays; otherwise record that qualification gap and retain
the existing owner-routing paths throughout implementation.

## 8. Completion and Next Decision

This slice is complete when William and Blaec can perform the required work from
My Agents, the normal project editor still works, the checks above pass, and the
opt-in can be turned off without losing content or changing messaging approvals.
No production deployment or feature enablement follows automatically from it.

Collect concrete friction: reasons to leave the workspace, creation obstacles,
missing companion tools, organization needs, switching delays, and lost context.
Possible next slices are interactive-app artifacts, deeper search over registered
agents only, git-worktree controls, or a native client. Explicit registration
remains the product rule, not a workaround to remove. Choose the next scope from
usage rather than expanding this first implementation.

