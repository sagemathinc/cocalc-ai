# Workspaces In CoCalc

### Bugs/Issues

- [x] select a workspace and try to use the file browser.  You cannot navigate to any other directory; you're stuck in the root of the workspace.
- [x] show "Loading" when the workspaces are loading, instead of making it look like I don't have any.
- [ ] open a file not in the workspace (e.g., project log, click link, etc.) and the URL changes to that file, but the file isn't shown.  It is opened; it's just that we need to switch to "Unscoped" or the right workspace.
- [ ] feature: It would be EXTREMELY nice for the pinned workspaces to be sortable (i.e., drag-n-drop to reorder them), rather than ordering them by a mystery value.   In general, drag and drop is ideal for all of this.  We have some nice existing sortable list react components in the frontend already.  We can hopefully figure out where to store the sort order info (not localStorage - it should be in the dkv data; one option would be a position parameter that is part of the data, and we ensure positions are unique on sort end, another would be just an extra key in the dkv with the sorted list). 
- [ ] Move the Delete button to be inside of "Edit" -- it's a very rare action.
- [ ] Replace the "Show tabs" button by just clicking basically anywhere on the workspace card to select the entire card (except the drag handle).
- [ ] Theming: it would be nice to have a dark mode option; I think antd has some options for that.  We also have a dark mode switch in account prefs that uses Dark Reader.    But workspace dark mode would be nice since it is specific to a workspace, not the whole UI or all workspaces. 
- [ ] File tabs have a way of surfacing activity, e.g. when a codex turn is running, a terminal is changing, a notebook is running, this gets pinged.  Some of this info should be surfaced clearly in the workspace cards.   Also, it would be extremely helpful to surface that no codex turn is running in any agent in a workspace... i.e., all codex turns are done.  This is extremely critical information for making best use of parallel codex sessions. 
- [ ] There are some overall project-wide apps that could be workspace aware:
  - Project log -- only show paths in a workspace
  - Processes -- only show processes in a workspace (e.g., they are associated often to terminals and notebooks which belong to workspaces).
  - Find -- pretty obvious
  - New -- obvious
  - Files -- already done
  - Agents -- restrict to agents whose chat is in the workspace
  - Tabs -- already works

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

A Conat key/value store is a reasonable first target.

Likely key shape:

- namespace for workspace records by account and project
- separate key for current selected workspace per `(account_id, project_id)`

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
- set current workspace for the project/account
- update the sidebar/top icon
- not change permissions
- not rewrite open files

### Switching back

`All tabs` must be easy to reach.

Do not trap users inside a workspace filter.

## Theme UI Convergence

Longer-term, a single theme editor should configure:

- project theme
- workspace theme
- agent theme

This should use the same underlying fields and the same editing experience.

First version may implement only the workspace editor, but it should use the shared theme schema from day one.

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

## Implementation Phases

## Phase 1: Data model and tab filtering

Deliverables:

- workspace record type and storage
- selected workspace state per `(account_id, project_id)`
- create/select/edit/delete workspace records
- `All tabs` / per-workspace / `Unscoped` filtering
- workspace sidebar flyout
- basic full page

This phase alone should already be highly useful.

## Phase 2: Theme polish

Deliverables:

- richer workspace theming
- image blob support
- stronger visual cues in sidebar and filtered tab mode
- better create/edit UI

## Phase 3: Agent routing

Deliverables:

- canonical chat binding per workspace
- file-triggered agent actions route to workspace chat when applicable
- workspace `root_path` becomes the default working directory for agent actions

This is where workspaces become deeply useful for Codex and other agents.

## Phase 4: Suggestions and ergonomics

Deliverables:

- Git-root suggestions
- recent workspace heuristics
- better open-file / recent-file behavior inside a workspace

## Phase 5: Launchpad integration

Deliverables:

- workspace visibility on Launchpad
- cross-project recent/pinned workspace surfacing

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