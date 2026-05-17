# Project Settings Redesign Plan

## Goal

Make the full project settings page feel coherent, navigable, and operationally useful without rewriting every settings control at once.

The current implementation in `src/packages/frontend/project/settings/body.tsx` is a two-column Bootstrap layout that drops existing panels into a long page. The project flyout in `src/packages/frontend/project/page/flyouts/settings.tsx` already has a better section model, but the full page still feels random because there is no information architecture, no persistent project status summary, and no visual distinction between routine settings, operational controls, recovery controls, and dangerous actions.

The redesign should preserve existing settings behavior first, then improve individual panels incrementally.

## Current Structure

The full page entry point is:

- `src/packages/frontend/project/settings/settings.tsx`
- `src/packages/frontend/project/settings/body.tsx`

The current full page renders:

- Warnings: `NonMemberProjectWarning`, `NoNetworkProjectWarning`
- Header: plain `Project Settings and Controls`
- Left column: `AboutBox`, `LauncherDefaults`, `SSHPanel`, `Environment`, `ProjectSecrets`, `Datastore`, `ProjectCapabilities`
- Right column: `ProjectControl`, `ManagedEgress`, `HideDeleteBox`

The flyout renders many of the same panels through `Collapse` sections:

- `AboutBox`
- `ProjectControl`
- `ManagedEgress`
- snapshot/backup/clone shortcuts
- `SSHPanel`
- `HideDeleteBox`
- `Environment`
- `ProjectSecrets`
- `Datastore`
- `ProjectCapabilities`

This is useful because the first redesign can reuse almost all existing panels and focus on page shell, grouping, labels, and status.

## Product Principles

1. Put the operational state where users can always see it.
2. Separate normal settings from controls that start/stop/move/archive/delete.
3. Prefer explicit sections over a long scroll of unrelated boxes.
4. Keep advanced or rare controls discoverable, but not in the first screen by default.
5. Do not hide existing functionality in the first release.
6. Use existing CoCalc patterns, data, and panels where possible.

## Proposed Information Architecture

Use these full-page sections:

- `overview`: title, description, appearance, project id, created date, bookmark/star, course ownership note.
- `collaborators`: collaborator list and roles. First release can link/open existing collaborator management instead of implementing a new editor.
- `resources`: state, host, start/stop/restart/move, idle timeout, quotas, member host/network status, root filesystem image.
- `environment`: launcher defaults, environment variables, project secrets, software capability checks.
- `network`: managed egress, internet/network status, public/proxy exposure summary when available.
- `recovery`: snapshots, backups, clone/copy, datastore where enabled.
- `ssh-api`: SSH panel and related access controls.
- `course`: course-specific restrictions and ownership notes, visible only for course projects.
- `maintenance`: admin/developer status, refresh features/configuration, boot log, low-level diagnostics.
- `danger`: hide, archive, delete, transfer ownership if/when available.

The exact labels shown to users should be concise:

- Overview
- People
- Resources
- Environment
- Network
- Recovery
- SSH & API
- Course
- Maintenance
- Danger Zone

## Layout

### Desktop

Use a three-region layout:

- Left sticky section nav, about 220px wide.
- Main content column, max width about 900-1050px.
- Right sticky project health rail, about 280-340px wide.

The left nav should show:

- Section icon
- Section label
- Optional status marker, e.g. warning dot for network disabled, backup stale, project archived.

The main column should use cards. Cards should be grouped under section headers and have short summaries. Avoid full-width unbounded setting boxes.

The right health rail should show:

- Project state and quick open/files action.
- Host/region label when available.
- Running time when running.
- CPU usage and memory/disk status when available.
- Disk quota summary.
- Network/internet status.
- Last backup and backup integrity/index status when available.
- Active collaborators/users if data is available.
- Short alert list: no network, non-member host, stale backup, host unavailable.

### Tablet / Narrow Width

Use two regions:

- Top sticky compact section nav.
- Main content.

Move project health rail into a collapsible top card.

### Mobile

Use:

- Top project summary card.
- Section dropdown or segmented nav.
- Single-column cards.

## Phase 1: Shell Redesign With Existing Panels

This is the lowest-risk release and should be implemented first.

### New Components

Add a small project settings shell:

- `src/packages/frontend/project/settings/page-shell.tsx`
- `src/packages/frontend/project/settings/section-nav.tsx`
- `src/packages/frontend/project/settings/health-rail.tsx`
- `src/packages/frontend/project/settings/section-card.tsx`

Keep styling local at first, either inline style constants or a small CSS module if this package pattern allows it. Use `COLORS` from `@cocalc/util/theme`.

### Body Changes

Replace the raw `<Row><Col sm={6}>...` layout in `body.tsx` with:

- Existing warnings at top.
- New header: project title, state pill, project id copy, quick actions.
- New shell with nav, main sections, and health rail.

Reuse the existing panels inside new sections:

- Overview: `AboutBox`
- Resources: `ProjectControl`
- Environment: `LauncherDefaults`, `Environment`, `ProjectSecrets`, `ProjectCapabilities`
- Network: `ManagedEgress` plus current no-network warning state
- Recovery: `Datastore` when enabled; add existing backup/snapshot/clone buttons if practical
- SSH & API: `SSHPanel`
- Danger Zone: `HideDeleteBox`

Do not redesign individual panels yet beyond wrapping them in cards and reducing redundant headers if easy.

### Section Navigation

Use anchor IDs and smooth scrolling:

- `#overview`
- `#resources`
- `#environment`
- `#network`
- `#recovery`
- `#ssh-api`
- `#danger`

Optional first release behavior:

- Use click-to-scroll only.
- Do not implement active-section tracking until Phase 2 unless trivial.

### Health Rail Data Sources

Use data already available in or near current components:

- Project state: `project.getIn(["state", "state"])`, `useTypedRedux({ project_id }, "status")`
- Host id: `project.get("host_id")`
- Host info: `useHostInfo(hostId)` or existing project host info store patterns
- Lifecycle: `getProjectLifecycleView`, `normalizeProjectStateForDisplay`
- Last backup: `project_map?.getIn([project_id, "last_backup"])` or `project.get("last_backup")`
- Quota/network/member values: `useRunQuota(project_id, null)`
- Course state: `useProjectCourseInfo(project_id)`

If a value is not reliably available, show `Unknown` or omit the row. Do not add new backend RPCs in Phase 1.

## Phase 2: Make Full Page And Flyout Share Section Definitions

The flyout already has a parallel model. After Phase 1 works, reduce drift by extracting a shared section registry:

- `src/packages/frontend/project/settings/sections.tsx`

This registry should describe:

- key
- label
- icon
- visibility predicate
- render function
- danger/maintenance/advanced flags
- flyout/full-page preferred placement

Then:

- Full page renders sections from the registry into cards.
- Flyout renders selected sections into `Collapse`.

This prevents adding future settings in one place but not the other.

## Phase 3: Redesign High-Impact Panels

Once the shell is stable, improve panel internals in this order.

### Resources

Split `ProjectControl` into smaller presentational units:

- status summary
- lifecycle actions
- host/rootfs details
- boot log/diagnostics

Keep the current `ProjectControl` API for compatibility. Internally, expose subcomponents usable by the health rail and Resources section.

### Backups And Recovery

Create a first-class recovery card that includes:

- Create snapshot
- Create backup
- Clone/copy project
- Last backup status
- Restore entry point if available
- Backup/index health if available

Use existing `CreateBackup`, `CreateSnapshot`, and `CloneProject` first. Do not invent restore behavior unless there is an existing component/API.

### Environment

Separate:

- Launcher defaults
- Environment variables
- Project secrets
- Software capability checks
- Root filesystem image

`ProjectCapabilities` is useful but visually dense; make it a compact status table with “ask Agent to install” actions still available.

### Danger Zone

Make all destructive flows visually consistent:

- muted warning intro
- separate rows for hide/archive/delete
- require existing confirmations
- never place danger actions next to normal controls

## Phase 4: Add Missing CoCalc-Specific Summaries

Only after the shell exists, consider adding small server/client data additions for summaries that make the page much more useful:

- backup freshness and verification status
- active user count
- storage/quota detail if current data is insufficient
- public sharing/app proxy exposure summary
- course relationship summary
- host region/availability summary

Each should degrade gracefully when unsupported.

## Visual Direction

Use a restrained technical palette:

- Slate/gray for structure.
- Teal/blue for normal interactive accents.
- Green for healthy state.
- Amber for warnings.
- Red only for destructive actions.

Avoid:

- Purple-first SaaS style.
- Large marketing hero blocks.
- Overly sparse generic cards.
- Hiding technical details that advanced users need.

Prefer:

- Compact cards with strong labels.
- Secondary explanatory text.
- Status badges.
- Inline actions near the data they affect.
- Clear distinction between status, settings, actions, and danger.

## Implementation Notes

### Compatibility

Keep all current settings reachable in Phase 1. A layout regression is acceptable only if functionality remains available and tests/screenshots catch it.

### Lite

Honor existing `lite` conditions:

- Hide SSH, Environment, Project Secrets, Datastore, Managed Egress, and ProjectControl sections as current code does.
- The shell should still work with a simplified Overview/Danger layout.

### Course Projects

Respect `useStudentProjectFunctionality` and `useProjectCourseInfo`:

- Disable/hide SSH where current code does.
- Show read-only title/description note from `AboutBox`.
- Add a Course section only when course metadata exists.

### Admin View

Preserve `AdminProjectSettingsWarning` in `settings.tsx`.

Admin project settings are already marked deprecated. The redesign should not invest in new admin-only behavior, but it must not break the current warning or render path.

## Testing Plan

### Unit / Component

Add or update focused tests where existing test infrastructure is available:

- section visibility under `lite`
- section visibility for student/course restrictions
- health rail handles missing host/status/backup values
- nav renders all visible sections and no hidden sections

### Frontend Validation

Run:

- `pnpm -C src prettier --write <changed files>`
- `pnpm -C src lint:frontend`
- focused frontend/project tests if applicable

For visual QA:

- Use a normal project with running state.
- Use a stopped/archived project.
- Use a course student project.
- Use a Lite project.
- Use a project without network/member host.

## Suggested Commit Sequence

1. Add shell components and wrap existing panels.
2. Add health rail from existing data only.
3. Add section nav and responsive behavior.
4. Extract shared section registry for full page and flyout.
5. Redesign Resources and Recovery internals.
6. Redesign Environment and Danger Zone internals.

The first three commits should already make the page materially better without changing backend behavior.

## Follow-Up Implementation Plan: Location And Health Rail

This section reflects the state after the first settings-page redesign commits
and the additional product decisions from review.

### Product Decisions

The current `Runtime` section should mean "operate the active runtime now":

- start
- stop
- restart
- runtime state
- boot/runtime diagnostics
- runtime sponsor controls

Do not change `RuntimeSponsorControls` in this pass. Another implementation
thread is actively working on runtime sponsor behavior.

Archive and move do not belong in ordinary runtime controls. Both are
disruptive location/lifecycle operations:

- Archive removes the active project from the host, deletes snapshots, and makes
  the project potentially much slower to access later because it must be
  restored from backup.
- Move makes the project unavailable for a while and also removes snapshots.
- Delete moves the project to "nowhere" from a user perspective.
- Hide changes whether the project appears in normal listings.

Use a separate `Location` section for these operations rather than overloading
`Danger Zone` with every disruptive lifecycle action. `Danger Zone` can remain
reserved for irreversible or deletion-oriented warnings if later needed, but
for the next pass the practical user-facing grouping should be:

- `Runtime`: start/stop/restart/current runtime diagnostics.
- `Location`: hide, move, archive, delete.

This grouping is more accurate than `Resources` or a broad `Disruptive Actions`
label because all four actions answer "where is this project and how reachable
is it?"

### Health Rail Principles

The health rail must not invent partial resource accounting. It should be a
compact summary and navigation surface for existing authoritative project tools.

Remove the current disk row that comes from `useCurrentUsage(...).disk_quota`.
That path is a quota/current-usage approximation and can be misleading for
CoCalc storage because CoCalc project storage includes live files plus retained
snapshot/history/storage categories. If any health-rail-only code was added
only to support that misleading disk display, delete it as part of the cleanup.

The health rail should instead surface:

- Storage from the same source as `DiskUsage`, i.e.
  `project/disk-usage/use-disk-usage.ts`.
- Network egress from `ManagedEgressRateSummary` or a small shared summary hook
  extracted from `purchases/managed-egress-history.tsx`.
- CPU/memory/process data from the existing project info/process monitor
  pipeline used by the Processes flyout and project info page.
- Backup freshness from existing project map backup state.
- Snapshot/backups entry points using the existing explorer open-directory
  actions.

Each row should link to or open the canonical detailed tool instead of becoming
a second incomplete implementation.

### Existing Programmatic Entry Points

Use these existing flows instead of hard-coded URLs:

- Snapshots directory: `redux.getProjectActions(project_id).open_directory(SNAPSHOTS)`
  with `SNAPSHOTS` from `@cocalc/util/consts/snapshots`.
- Backups directory: `redux.getProjectActions(project_id).open_directory(BACKUPS)`
  with `BACKUPS` from `@cocalc/util/consts/backups`.
- Create snapshot: open the snapshots directory and set
  `{ open_create_snapshot: true }`.
- Restore snapshot: open the snapshots directory and set
  `{ open_restore_snapshot: true }`.
- Configure snapshots: open the snapshots directory and set
  `{ open_snapshot_schedule: true }`.
- Create backup: open the backups directory and set
  `{ open_create_backup: true }`.
- Configure backups: open the backups directory and set
  `{ open_backup_schedule: true }`.

These flows already exist in
`project/explorer/misc-side-buttons.tsx` and related files. Reuse or extract
them so health-rail buttons behave like the existing "Open Snapshots" and
"Open Backups" controls. Avoid direct string URLs such as
`/projects/<id>/files/.snapshots/` in component logic.

### Four-Commit Implementation Sequence

#### Commit 1: Split Runtime And Location

Goal: move disruptive location/lifecycle operations out of `Runtime`.

Changes:

- Remove `ArchiveProject` and `MoveProject` from `ProjectControl`.
- Keep start, stop, restart, state, boot log, runtime diagnostics, and
  `RuntimeSponsorControls` in `Runtime`.
- Add a `Location` section to `sections.tsx`.
- Move hide, move, archive, and delete controls into the `Location` section.
- Preserve existing confirmations and disabled-state logic.
- Consider renaming the existing `danger` section id only if the routing impact
  is small; otherwise keep the old id internally and change the visible label
  in a compatibility-friendly way.

Validation:

- Focused settings/flyout tests.
- Typecheck and frontend lint.
- Manual visual check that archive/move are no longer adjacent to start/stop.

#### Commit 2: Replace Misleading Disk Health With CoCalc Storage Summary

Goal: use CoCalc storage accounting instead of filesystem/quota approximation.

Changes:

- Remove the health rail disk row based on `useCurrentUsage(...).disk_quota`.
- Reuse `useDiskUsage({ project_id })` or extract a small
  `DiskUsageSummary`/`useDiskUsageSummary` helper from the existing disk usage
  component.
- Render a compact storage row/card in the health rail using the same live,
  retained, visible, and quota values as `DiskUsage`.
- Add an action that opens the full disk usage modal/tool. The current
  `DiskUsage` component is clickable but visually too large for the health
  rail, so either add a compact/health mode or extract the summary and modal
  trigger into a smaller component.
- If health-rail-specific code was added only to support the old misleading
  disk display, delete it.

Validation:

- Disk usage component tests if touched.
- Health rail handles missing storage data and loading state.

#### Commit 3: Add Network Egress Summary To Health Rail

Goal: show the concrete network information already available in the Network
card.

Changes:

- Reuse `ManagedEgressRateSummary` directly if it fits the health rail.
- If not, extract a small shared hook/summary presenter from
  `purchases/managed-egress-history.tsx`.
- Keep the full Network section as the detailed view with history/modal.
- Health rail row should link/scroll to `#network` or open the egress history
  modal using the existing button component when practical.

Validation:

- Existing managed egress tests if touched.
- Health rail degrades cleanly when egress data is unavailable.

#### Commit 4: Add Process/CPU/Memory Summary And Recovery Links

Goal: make the health rail reflect active runtime load and recovery posture
using existing project info/process tooling.

Changes:

- Reuse the process monitor data source used by the Processes flyout/project
  info page, or extract a cheap summary helper if needed.
- Show compact CPU, memory/RSS, and process count. Avoid polling more often
  than the existing process monitor already does.
- Link/open the existing process monitor for details.
- Add backup and snapshot rows:
  - Backup row shows last backup when available and opens `.backups` using the
    existing `BACKUPS` open-directory action.
  - Snapshot row shows the most recent snapshot if that data is cheaply
    available; otherwise show a neutral "Open snapshots" row until a cheap data
    source exists.
  - Snapshot row opens `.snapshots` using the existing `SNAPSHOTS`
    open-directory action.
- The create backup flow should open `.backups` and set
  `open_create_backup`, so the running LRO is visible on the backups page.

Validation:

- Project info/process summary tests if helpers are extracted.
- Health rail tests for absent process data, stopped project, and running
  project.

## Follow-Up Implementation Plan: Runtime Sponsor Density

The upstream runtime sponsor work has landed, so the earlier "do not change
RuntimeSponsorControls" constraint is obsolete. The behavior is useful, but the
current full-page presentation is too text-heavy for the redesigned settings
page.

### Product Direction

Keep the runtime sponsor behavior exactly as implemented:

- project starts use the runtime sponsor's membership limits and priority
- collaborators may or may not consume sponsor slots
- automatic starts may be allowed or blocked
- owners/admins/sponsors keep the existing edit permissions
- existing Popconfirm flows and error handling remain in place

Change only the presentation:

- Render a compact status/settings card instead of several paragraphs.
- Use rows: `Sponsor`, `Collaborator starts`, and `Automatic starts`.
- Put primary state on the left and actions/switches on the right.
- Move long explanatory copy into concise secondary text or a small details
  popover.
- Preserve all existing disabled-state explanations and save errors.

### Suggested Commit

Commit 5: Compact runtime sponsor controls

Goal: reduce vertical space and make the runtime sponsor controls match the
row-based design language used by the rest of the redesigned settings page.

Changes:

- Refactor `RuntimeSponsorControls` into small internal row components.
- Keep `Use my membership` and `Stop sponsoring` actions adjacent to the
  current sponsor row.
- Replace paragraph blocks under each switch with one concise sentence and
  optional detail popover text.
- Keep permission and save-error alerts below the rows.

Validation:

- Focused settings/flyout tests.
- Start button tests if any shared sponsor wording/types are touched.
- Frontend typecheck and lint.

## Follow-Up Implementation Plan: Environment Card Redesign

The current Environment section is the most vertically expensive part of the
settings page. It mixes runtime image identity, project access, feature probes,
software availability, configuration, and low-level diagnostics into one long
stack. The redesign should not simply restyle the existing content; it should
separate summary, actions, and technical detail.

### Product Direction

The default Environment view should answer three questions in the first screen:

- What environment am I running?
- What can this environment do?
- Where do I go to change, refresh, or inspect it?

Everything else should be available through details, search, or expandable
technical sections.

Use this structure:

- Top summary strip: compact cards for runtime image, host, resources, storage,
  network, SSH, and features.
- Runtime Image card: current image name/version, short status, and right-side
  actions.
- Available Features card: grouped feature chips and search/show-all controls.
- Access cards: SSH and network/egress summaries with explicit actions.
- Diagnostics: collapsed by default, containing long probe output, raw config,
  package details, and other support/debugging information.

Do not show raw JSON, giant feature lists, or repeated paragraphs in the default
view.

### Information Architecture

#### Top Summary Strip

Render 4-6 compact cards at the top of the Environment section. Each card should
have:

- icon
- title
- primary value
- one short secondary line
- one obvious action when applicable

Suggested cards:

- `Runtime Image`: image name/tag, "Change" or "Details".
- `Host`: host display name and bay/region when available, "Host Details".
- `Resources`: CPU/RAM plan summary, "Open Runtime" or project info link.
- `Storage`: compact disk usage meter, "Disk Usage".
- `Network`: internet/member-host/egress status, "Egress".
- `SSH`: enabled/access status, "SSH Instructions" or "Manage Keys".

If a value is missing, omit the secondary line or show a neutral loading/unknown
state. Do not create new backend RPCs for the first pass unless no existing data
source exists.

#### Runtime Image Card

The image/runtime identity deserves its own focused card instead of being buried
inside a long environment dump.

Show:

- current image name prominently
- image tag/build/version when available
- short description if already available
- whether it is default/custom/unknown if that state exists
- right-side actions: `Change Image`, `Details`, or existing equivalent actions

Move long image metadata into an expandable `Technical details` area.

#### Available Features Card

Replace the current large feature/configuration presentation with grouped chips
and progressive disclosure.

Default view:

- Header: `Available Features`
- Header actions: `Refresh`
- Category groups:
  - `Languages`
  - `Notebooks`
  - `Terminals`
  - `Network`
  - `Storage`
  - `System`
- Show important available features as chips.
- Show counts, e.g. `Python`, `Jupyter`, `Terminal`, `Internet`, `Member Host`.

Expanded/search view:

- Search input filters features by label/key.
- `Show all` reveals the complete list.
- Missing features are hidden by default unless the missing state is actionable
  or surprising.
- Keep install/agent actions if they already exist, but put them beside the
  relevant feature row, not in paragraphs.

The refresh button belongs in the `Available Features` header, not at the top of
the whole Environment section.

#### Access Cards

Keep SSH and network separate from feature detection.

SSH card:

- enabled/disabled or available/unavailable status
- primary action to open SSH instructions or copy the command
- secondary action to manage keys if available
- no long explanation in the default card

Network card:

- internet access status
- member host status when relevant
- compact egress usage/rate summary if available
- action to open egress monitor/history

#### Diagnostics

Create a collapsed `Diagnostics` or `Technical Details` card at the bottom.

This is where the current verbose content belongs:

- raw feature probe output
- package/tool version details
- low-level runtime configuration
- long explanatory paragraphs
- support-oriented debug information

The collapsed header should make it clear that this is not normal user-facing
settings content.

#### Flyout Version

The flyout should use the same data and component vocabulary, but it should not
try to reproduce the full page layout inside a narrow panel. Treat it as a
compact operational summary with drill-down links.

Flyout default view:

- one small Environment status header
- 2-column mini-summary grid when width allows, otherwise single column
- Runtime Image row/card
- Available Features compact card with only the most important chips
- SSH and Network compact rows
- one collapsed `More environment details` section

Flyout-specific rules:

- No large diagnostics block by default.
- No full feature table by default.
- No multi-paragraph descriptions.
- Use right-aligned compact actions, e.g. `Details`, `Refresh`, `SSH`.
- Use `Show all` or `Open full settings` for dense information.
- Keep vertical budget low enough that the Environment flyout section fits in
  roughly one panel-height on a normal laptop.

Recommended flyout content:

- Runtime Image: image name/tag plus `Details`.
- Features: 6-10 high-signal chips and `Show all`.
- Network: internet/egress status plus `Egress`.
- SSH: status plus `Open`.
- Diagnostics: collapsed, labeled as advanced/support information.

The flyout should share the same components with the full page through a
`mode="page" | "flyout"` prop or equivalent, but mode should control density,
not behavior.

### Suggested Component Shape

Add a new presenter for the redesigned section and keep existing behavior behind
small adapters:

- `src/packages/frontend/project/settings/environment-overview.tsx`
- `src/packages/frontend/project/settings/environment-summary-card.tsx`
- `src/packages/frontend/project/settings/environment-feature-groups.tsx`
- optional: `src/packages/frontend/project/settings/environment-diagnostics.tsx`
- optional: `src/packages/frontend/project/settings/environment-compact-row.tsx`

The first pass can be implemented entirely inside one file if that is faster,
then split once the shape stabilizes.

Reuse existing components/data sources where possible:

- existing `Environment` component for feature probing/data loading
- existing `ProjectCapabilities` data/rendering logic, but expose a compact mode
- existing `DiskUsage` summary/modal trigger or the extracted health rail helper
- existing host details modal trigger
- existing SSH panel actions
- existing managed egress monitor/history action
- existing runtime/process/project info link for runtime details

Avoid introducing a new independent probe layer. The redesign should be a
presentation refactor first.

### Implementation Steps

#### Commit 1: Inventory And Extract Environment Data

Goal: identify exactly which current components provide which data and extract
minimal summary helpers without changing the UI.

Tasks:

- Read the current `Environment`, `ProjectCapabilities`, `SSHPanel`, runtime
  image, host details, disk usage, and managed egress components.
- Document the existing data sources in comments or this plan if there are
  surprises.
- Extract helper functions only where needed, e.g. feature categorization or
  compact disk/network summary.
- Add no new UX in this commit unless required for extraction.

Validation:

- Focused tests for extracted helpers if non-trivial.
- `pnpm -C src lint:frontend`
- `pnpm -C src tsc`

#### Commit 2: Add Environment Overview Shell

Goal: replace the one huge Environment stack with a structured overview while
preserving all existing functionality.

Tasks:

- Add `EnvironmentOverview`.
- Render the top summary strip.
- Render a Runtime Image card.
- Render compact SSH/network/storage cards using existing actions.
- Keep the old verbose components under a collapsed `Diagnostics` card so no
  functionality disappears.
- Wire the settings section to use `EnvironmentOverview` in the full page first.
- Design the new component API with flyout mode in mind, even if the first
  commit only renders page mode.

Validation:

- Full page settings smoke test if available.
- Flyout settings test if the shared environment section changes.
- `pnpm -C src lint:frontend`
- `pnpm -C src tsc`

#### Commit 3: Redesign Available Features

Goal: replace the dense feature list with grouped chips plus search/show-all.

Tasks:

- Categorize feature keys into the initial groups:
  `Languages`, `Notebooks`, `Terminals`, `Network`, `Storage`, `System`, and
  `Other`.
- Show only available/important features by default.
- Add search and `Show all`.
- Move `Refresh` into the `Available Features` card header.
- Preserve any existing "install with agent" or related actions.
- Hide unavailable features by default unless actionable.
- Add a compact feature-group rendering mode for flyout use:
  - fewer chips
  - no table by default
  - `Show all` reveals the same searchable detail UI as page mode

Validation:

- Unit tests for feature categorization if implemented as a helper.
- Render tests for empty/loading/error feature states if the component has test
  coverage.
- `pnpm -C src lint:frontend`
- `pnpm -C src tsc`

#### Commit 4: Collapse Diagnostics And Remove Redundancy

Goal: make the default Environment section fit on one normal screen.

Tasks:

- Move raw/verbose content into `Diagnostics`.
- Remove repeated explanatory text across Runtime Image, Features, SSH, and
  Network cards.
- Ensure there is one source of truth for each action:
  - image change/details
  - refresh features
  - disk usage
  - egress monitor
  - SSH instructions/keys
  - host details
- Ensure collapsed default view is useful without opening diagnostics.

Validation:

- Manual browser screenshot of full Environment section at desktop width.
- Verify each action still opens the existing modal/page.
- `pnpm -C src lint:frontend`
- `pnpm -C src tsc`

#### Commit 5: Share Compact Environment With Flyout

Goal: make the flyout and full page use the same compact environment summary
where practical.

Tasks:

- Add a `mode="page" | "flyout"` or equivalent prop to `EnvironmentOverview`.
- Use the same Runtime Image and Available Features summaries in the flyout.
- Render the flyout as a compact summary, not a scaled-down full page:
  - small Environment status header
  - mini-summary grid or stacked rows
  - compact Runtime Image row
  - compact Available Features chips
  - SSH and Network rows
  - collapsed `More environment details`
- Keep diagnostics short and collapsed.
- Use `Open full settings` or `Show all` for dense information.
- Ensure the refresh button remains near `Available Features` in both modes.

Validation:

- `project/page/flyouts/settings.test.tsx`
- Manual browser screenshot of flyout Environment section.
- Confirm the flyout Environment section no longer requires long scrolling for
  normal usage.
- `pnpm -C src lint:frontend`
- `pnpm -C src tsc`

### Design Rules For This Work

- The default Environment section should not require four screenshots.
- Summary cards should be systematic: title, value, secondary text, action.
- Long lists must support search or `Show all`.
- Raw diagnostics are allowed, but only behind an explicit collapsed section.
- Do not invent new terminology when existing user-facing labels work.
- Prefer `Available Features` over `Features and Configuration`.
- Full-page and flyout versions should share data and actions, but not identical
  density.
- Use `COLORS` from `@cocalc/util/theme`.
- Preserve existing security/access behavior. This is a presentation refactor,
  not a permissions change.
