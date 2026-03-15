# Workspaces In CoCalc

## Current Status

Workspaces are now a real feature, not just a prototype.

Implemented:

- account-scoped workspace records stored in project-scoped Conat DKV
- per-browser-tab workspace selection via `sessionStorage`
- flyout and full page workspace management
- `All tabs`, per-workspace, and `Unscoped` views
- longest-prefix path membership
- explicit follow-through when opening files or navigating directories outside the current workspace
- remembering the last open tab per workspace
- closing tabs within the current workspace
- drag-to-order tabs within a selected workspace
- manual workspace ordering with sections:
  - `Pinned`
  - `Today`
  - `Last 7 days`
  - `Older`
- shared theme editor modal, now reused for:
  - workspaces
  - projects
  - thread/chat settings
- canonical chat per workspace, including binding an existing chat
- backend and CLI workspace APIs:
  - `cocalc workspaces ...`
  - `api.workspaces ...`
- durable workspace notice thread in the canonical chat
- card-level workspace notices
- workspace card status for canonical chat:
  - `Codex running`
  - `Codex done`
  - `Codex error`
- stronger theme cues:
  - larger card media
  - image/icon in the activity bar
  - workspace colors on file tabs
  - mirrored tab activity on workspace cards

### Remaining Bugs / TODO

- [ ] At certain widths the cards change height based on activity/timeago. Card height should be fixed.
- [ ] Refresh still causes too much initial tab churn with many tabs across many workspaces. The UI should apply the selected workspace lens immediately and avoid visibly opening irrelevant tabs before hiding them.
  - The current implementation is much better than before because selected workspace state is restored early, but the underlying tab hydration is still global and noisy.
  - This should be solved as a UI/rendering optimization, not by making tab state workspace-local.
- [x] Surface activity from file tabs and Codex onto workspace cards.
  - Implemented:
    - canonical chat status on cards
    - mirrored tab activity on cards
  - Still worth improving:
    - richer workspace-level summaries
    - stronger notion of "all Codex work is done and ready for review"
- [ ] In Codex chat, make the default root for a new thread be the workspace root of the `.chat` file itself, not the current directory of the chat file.
  - [ ] Special-case the generated canonical workspace chat tab title so it does not just show a random filename.
  - [ ] Handle the generated canonical workspace chat file specially when deciding the default workspace root for Codex threads.
- [x] Extend `cocalc-cli` / backend APIs for workspaces.
  - Implemented:
    - `cocalc workspaces ...`
    - `api.workspaces ...`
    - backend message and notice support
  - Still worth improving:
    - richer inspection/debug output for live workspace UI state
- [ ] Theming: workspace-specific dark mode could be useful, independent of global Dark Reader / account appearance.
- [x] bug: it is not possible to drag-to-order tabs within a workspace
  - fixed by reordering the visible subset and projecting that back to the global tab order
- [x] bug: if I close a tab, cocalc switches to the next tab and focuses it, even if that is in a completely different workspace. Instead it should stick to the current workspace.
- [x] bug: the last open tab for each workspace must be remembered, so when you go back to that workspace, you see it again.
- [x] feature: pinned and non-pinned workspaces are now manually sortable, with sectioned presentation instead of mystery ordering.
- [x] Move the Delete button to be inside of "Edit" -- it's a very rare action.
- [x] Replace the "Show tabs" button by just clicking basically anywhere on the workspace card to select the entire card (except the drag handle).
- [x] show "Loading" when the workspaces are loading, instead of making it look like I don't have any.
- [~] There are some overall project-wide apps that should be workspace aware:
  - [x] Project log -- only show paths in a workspace
  - [x] Find -- `Workspace root` added
  - [~] New -- no special case added; current-directory behavior is probably sufficient for now
  - [x] Files -- done
  - [x] Agents -- restricted to agents whose chat is in the workspace
  - [x] Tabs -- done
- [ ] Instead of making the Processes page workspace-aware, surface process activity directly on workspace cards.
  - A workspace card should summarize processes associated to files/terminals/notebooks in that workspace.
  - The most useful first cut is CPU/memory at a glance for each workspace.
  - This is likely more useful than filtering the full Processes page.
- [x] open a file not in the workspace (e.g., project log, click link, etc.) and the URL changes to that file, but the file isn't shown. It is opened; it's just that we need to switch to "Unscoped" or the right workspace.
- [x] select a workspace and try to use the file browser. You cannot navigate to any other directory; you're stuck in the root of the workspace.

## Purpose

Introduce a new first-class concept of a **workspace** inside a CoCalc project.

A workspace is:

- account-specific
- scoped to exactly one CoCalc project
- defined by an absolute directory path inside that project
- used as a UI, navigation, and agent-focus boundary
- not a security boundary
- not a replacement for projects

This feature is intended to solve a real workflow problem:

- too many mixed tabs in one project
- repeated manual regrouping of files by repo or directory tree
- lack of a durable notion of "what I am working on right now"
- poor default scoping for agent chat/actions

This also aligns well with the external Codex/OpenAI notion of a workspace, which is typically a directory tree or repo root.

## Non-Goals

Initial implementation must **not** do any of the following:

- change permissions or file access rules
- create a new backend security boundary
- share workspaces between users
- force every file into a workspace
- close tabs when switching workspaces
- depend on Git, though Git roots may be suggested later
- support workspace nesting UI beyond a deterministic matching rule
- try to solve Launchpad cross-project grouping initially

## Core Definition

A workspace is an account-local record stored for a given `(account_id, project_id)` pair.

Canonical fields:

- `workspace_id: string`
- `project_id: string`
- `root_path: string`
- `theme: WorkspaceTheme`
- `pinned: boolean`
- `last_used_at: number | null`
- `chat_path: string | null`
- `created_at: number`
- `updated_at: number`
- `source: "manual" | "git-root" | "inferred"`

Rules:

- `root_path` must be an absolute path inside the project filesystem.
- `root_path` is the canonical matching key for membership.
- `workspace_id` should be stable and not derived directly from `root_path`.
- Two workspaces may overlap by path.

## Workspace Theme

Workspaces, projects, and agents all need a better shared theme model.
This should be designed now even if it is only partially implemented for the first workspace slice.

Canonical theme fields:

- `title: string`
- `description: string`
- `color: string | null`
- `accent_color: string | null`
- `icon: string | null`
- `image_blob: string | null`

Rules:

- `image_blob` must be a blob hash, not a URL and not raw data.
- The same theme schema should eventually be used for:
  - projects
  - agents
  - workspaces
- The same theme editor UI should eventually configure all three.

Rationale:

- users need strong visual cues to know where they are
- workspaces are only useful if they are visually distinct
- current project/agent theming is ad hoc and should converge

## Membership Rule

A file belongs to a workspace if its path has the workspace `root_path` as a prefix.

If multiple workspaces match a file path, use:

- **longest matching path prefix wins**

This rule applies to:

- tab filtering
- default agent routing
- workspace indicator choice
- future recent-file views

If no workspace matches, the file is:

- **unscoped**

## Tab Behavior

This is the first high-value user-facing feature.

When a workspace is selected:

- show only tabs whose paths resolve to that workspace
- do not close tabs outside the workspace
- keep all open file/editor state intact
- allow switching back to `All tabs`

Required views:

- `All tabs`
- one view per workspace
- `Unscoped`

Expected behavior:

- selecting a workspace is a **filter**, not a destructive action
- opening a file inside the selected workspace should keep it visible
- opening a file outside the selected workspace should either:
  - remain hidden until `All tabs` / the right workspace is selected, or
  - surface as unscoped if the product chooses that behavior explicitly

Implementation note:

- tab membership should be derived from file paths and current workspace records, not copied redundantly onto tab state

## Workspace Sidebar

Workspaces should have both:

- a flyout sidebar panel
- a full page

This should parallel the Agents UI.

### Sidebar behavior

The Workspaces button should:

- appear below the Home button
- display the current workspace icon when one is selected
- open a flyout list similar in spirit to the Agents panel

Each workspace entry should show:

- theme icon/image
- title
- pinned state
- recent usage signal
- root path as secondary text

Actions should include:

- select workspace
- create workspace
- pin/unpin
- edit theme
- set canonical chat
- delete workspace record

### Full page behavior

The full page should support:

- create/edit/delete
- manage theme
- inspect root path
- inspect recent/open tabs in the workspace
- manage canonical chat binding
- later: Git-root suggestions / inferred workspaces

## Agent Integration

This is the second major value area.

### Default routing rule

When an agent action is invoked from a file or tab:

- resolve the file path to a workspace by longest matching prefix
- if exactly one workspace matches, use that workspace context
- if none match, fall back to project-level behavior

Workspace context should provide:

- default working directory = `root_path`
- default chat = `chat_path` if configured
- workspace theme/identity for UI

### Canonical chat per workspace

Each workspace may have exactly one canonical chat binding.

This binding should be stored in workspace metadata, not inferred from random open tabs.

Why:

- agent behavior should be deterministic
- users should not have to reselect a chat repeatedly
- different repos/directory trees inside one project often need different agent threads and context

Initial requirements:

- workspace record may store `chat_path`
- file-triggered agent actions inside that workspace use that chat by default
- if `chat_path` is missing, fall back to existing project-level navigator/chat behavior

Non-goal for first slice:

- automatic migration of all existing project-level agent workflows

## Storage Model

Workspace records should be stored in an account-scoped store, similar in spirit to the Agents sidebar state.

Requirements:

- scoped by `(account_id, project_id)`
- not stored as plain files in the project by default
- available without requiring a browser tab to stay open
- cheap to read when building UI/sidebar state
- selected workspace should be per-browser-tab state, not shared project state

A Conat key/value store is a reasonable first target.

Implemented key shape:

- workspace records and ordering live in project-scoped Conat DKV, namespaced by account
- current selected workspace lives in browser `sessionStorage`
- a cached selected workspace record is also kept in `sessionStorage` to stabilize initial load

## Path Validity Rules

`root_path` must:

- be absolute
- be inside the project filesystem
- resolve to an existing directory at creation time

Later tolerance:

- if the directory is missing later, keep the workspace record but mark it invalid/stale in the UI

This supports cases where repos are moved or deleted without silently destroying user configuration.

## Suggested UX Rules

### Create workspace

Allow creation by:

- current file's containing directory
- arbitrary directory chooser/input
- later: suggested Git roots

Good default title sources:

- basename of `root_path`
- repository name if `.git` is present

### Selecting a workspace

Selecting a workspace should:

- filter tabs
- set current workspace for the current browser tab
- update the sidebar/top icon
- not change permissions
- not rewrite open files

### Switching back

`All tabs` must be easy to reach.

Do not trap users inside a workspace filter.

## Theme UI Convergence

A shared theme editor now configures:

- project theme
- workspace theme
- thread/chat theme

The remaining theming work is about stronger use of theme cues and any workspace-specific appearance ideas such as dark mode.

Potential shared UI fields:

- title
- description
- icon picker
- image blob picker
- primary color
- accent color
- live preview

Potential later visual uses:

- tab strip border/accent
- workspace button background/border
- canonical chat badge
- project/workspace card accents

## Launchpad Follow-Up

Initial implementation is project-local only.

Later, the Launchpad page may be augmented with workspace information.
This is explicitly a later phase.

Potential later ideas:

- show pinned/recent workspaces across projects
- jump directly into a workspace view from Launchpad
- show workspace-aware recent activity

This should not be in the first slice.

## Implementation Phases / Status

## Phase 1: Data model and tab filtering

Deliverables:

- workspace record type and storage
- selected workspace state per `(account_id, project_id)`
- create/select/edit/delete workspace records
- `All tabs` / per-workspace / `Unscoped` filtering
- workspace sidebar flyout
- basic full page

Status: done.

## Phase 2: Theme polish

Deliverables:

- richer workspace theming
- image blob support
- stronger visual cues in sidebar and filtered tab mode
- better create/edit UI

Status: mostly done.

## Phase 3: Agent routing

Deliverables:

- canonical chat binding per workspace
- file-triggered agent actions route to workspace chat when applicable
- workspace `root_path` becomes the default working directory for agent actions

Status: largely done, but Codex-thread default root behavior still needs polish.

## Phase 4: Suggestions and ergonomics

Deliverables:

- Git-root suggestions
- recent workspace heuristics
- better open-file / recent-file behavior inside a workspace

Status: partially done.

Current highest-value remaining work:

- reduce refresh/tab churn on initial load
- default Codex thread root to the workspace root when starting from a workspace chat
- display generated canonical workspace chats with a meaningful tab label
- fix card height bouncing
- surface process / CPU / memory summaries directly on workspace cards

## Phase 5: Launchpad integration

Deliverables:

- workspace visibility on Launchpad
- cross-project recent/pinned workspace surfacing

Status: intentionally deferred; probably not important.

## Implementation Notes

### Existing file associations and editor registration

Workspaces should not change file associations or editor registration.
They are orthogonal.

### Existing project model

Projects remain the top-level unit for:

- filesystem
- permissions
- compute/runtime
- collaboration

Workspaces are a UX and agent-scoping layer inside projects.

### Existing chat model

Workspace canonical chat should be layered on top of existing chat documents.
No changes to the chat storage model are required for the first phase.

## Risks

### Overlap ambiguity

Solved by the longest-prefix rule.

### Too much scope in first version

Avoid by not including:

- sharing
- Launchpad integration
- Git intelligence
- permissions changes
- complex automatic migration

### Visual confusion

Address through strong theme cues and explicit `All tabs` / `Unscoped` views.

## Recommended First Slice

Implement only:

- workspace record storage
- current workspace selection
- workspace flyout sidebar
- tab filtering
- basic create/edit/delete
- `All tabs` and `Unscoped`

This gives immediate value and validates the concept before touching deeper agent routing or theme convergence.
