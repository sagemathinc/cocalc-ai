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

