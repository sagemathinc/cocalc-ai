# (done) Beta Bug/UI Triage Plan - 2026-06-12

Source list: `/home/user/wstein-todo/wstein.tasks.md`.

Goal: turn the latest beta tester UI and release-readiness reports into a concrete fix queue. Fix one item per commit unless two items share a tightly localized root cause. Prefer visible, low-risk fixes first when they unblock beta testing, but keep policy and confusing core navigation ahead of pure polish.

## Intake Notes

- The source file currently has 14 reports.
- Most reports are frontend/UI issues, but several touch project policy, account settings, membership eligibility, project-host creation, project invite acceptance, and project resource warnings.
- Before changing auth, accounts, billing, projects, collaborators, project hosts, or control-plane APIs, read `src/.agents/scalable-architecture.md`.
- Use project-host/data-plane APIs directly for project file/process data where possible; do not route steady-state project data through hub APIs as a shortcut.
- For live validation, use the CoCalc CLI path exactly:
  `"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"`.
- Treat the screenshots in the source file as expected visual evidence, but validate against the live app when the issue is layout-sensitive.

## P0: Release Policy / Core Navigation / High-Confusion Workflows

### (done) P0-A: Disable AI Must Hide All New AI Entry Points

Symptom: project/course/account settings that disable AI only partially work. Old assistant buttons disappear, but the Agents flyout remains, new chats still offer AI mode by default, the Jupyter AI-agent kernel install button remains, and project-home is still AI-centric.

Impact: instructors and institutional customers rely on this setting for policy compliance. Partial enforcement will be interpreted as a broken promise.

Likely areas:

- course configuration flags for student projects
- account setting `Disable all AI integrations`
- project/store selectors for AI availability
- Agents flyout panel and project navigation
- chat creation mode defaults
- Jupyter AI assistant/kernel install UI
- project-home removal item `P0-B`

Plan:

1. Find the canonical frontend predicate used by existing assistant buttons to decide whether AI is allowed.
2. Audit every new AI entry point against that predicate: Agents flyout, chat new-file/create UI, Jupyter AI buttons, Jupyter agent-kernel install, project-home link, and assistant modals.
3. Add a shared helper if current checks are duplicated or ambiguous.
4. When AI is disabled, hide AI-first entry points rather than showing disabled controls unless a visible explanation is more helpful.
5. For chat creation, make non-AI chat the default and remove AI mode choices when AI is disabled.
6. For course student projects, verify the course-level disable flags propagate into the student project UI.
7. Do not spend time fixing project-home AI behavior if `P0-B` deletes that page first.

Validation:

- Focused frontend tests for the shared AI-allowed predicate if testable.
- Browser smoke with account-level AI disabled: no Agents flyout, no Jupyter AI assistant/kernel install controls, no AI chat default.
- Browser smoke with course/student-project AI disabled.
- Browser smoke with AI enabled to verify entry points still appear.

### (done) P0-B: Replace Project Home With Full Page Files At `/home/user`

Symptom: the Home button opens the project-home agent page. This creates three overlapping agent surfaces: project-home, Agents flyout, and `.chat` files. The project-home page is the least polished and makes it harder to reach the full page file explorer.

Impact: confusing default project landing flow in the first public release.

Likely areas:

- project left/top navigation home route
- project route handling and default file route
- project-home page/component
- project page initial redirect/open-file behavior
- tests or docs referencing project-home

Plan:

1. Identify the route and button action behind the project Home button.
2. Change Home to open the full page file explorer at `/home/user`.
3. Make `/home/user` file explorer the default landing page for a project where appropriate.
4. Delete or unregister the project-home agent page and remove dead imports/routes.
5. Confirm this does not break direct file URLs, project settings/info URLs, or flyout file explorer state.
6. Coordinate with `P0-A`: removing project-home also removes one disabled-AI violation.

Validation:

- Browser smoke: Home opens the full page file explorer rooted at `/home/user`.
- Browser smoke: reload project URL lands in files view instead of project-home when no specific file/page is requested.
- Frontend typecheck/lint to catch deleted route imports.

### (done) P0-C: CPU Warning Must Reflect Project Processes, Not Host Load

Symptom: the red CPU warning square next to the project icon can appear because the project host has high load, even when the current project processes are idle. The warning popover also has no explanatory content.

Impact: alarming false positive in a highly visible place. It can make users think their project is misbehaving when only the shared host is busy.

Likely areas:

- project tab/icon status badges
- project status/info/store resource metrics
- process list data used by project `/info`
- CPU usage warning threshold logic
- project info route/panel sorting

Plan:

1. Trace the red warning square code path and identify its metric source.
2. Replace host-level CPU/load average as the trigger with project-process CPU usage when available.
3. If process data is unavailable, prefer no warning over a misleading host-load warning.
4. Add popover content explaining that project CPU usage is high.
5. Add a button/link to open the full project `/info` process list.
6. If feasible, pass route state or query params so the process list opens sorted by CPU descending.

Validation:

- Browser smoke on a busy host with idle project: no warning.
- Browser smoke with an actual CPU-heavy process in the project: warning appears.
- Popover smoke: explanatory text and `/info` button work.

## P1: Core File Explorer / Agents / Admin Configuration

### (done) P1-A: Restore Parent Directory Row In Full Page File Explorer

Symptom: the `..` parent directory row is missing in the full page file explorer, though it appears in the flyout file explorer.

Impact: common navigation affordance missing in the primary file browser.

Likely areas:

- full page file explorer listing rendering
- flyout file explorer listing rendering
- checkbox/action row logic
- path navigator and listing virtualization

Plan:

1. Compare flyout and full page explorer listing row construction.
2. Reintroduce a `..` parent row in full page explorer for non-root directories.
3. Ensure the row navigates to the parent directory.
4. Ensure it has no checkbox and cannot be selected for file actions.
5. Preserve keyboard navigation and row highlighting behavior.

Validation:

- Browser smoke: full page explorer in a subdirectory shows `..`, clicking it navigates upward.
- Browser smoke: `..` cannot be selected or included in delete/download/copy/move actions.
- Browser smoke: root directory does not show a broken parent row.

### (done) P1-B: Unify `+ New` Quick Create Dropdown Across Full Page And Flyout

Symptom: the full page file explorer has a useful `+ New` dropdown, but the flyout does not. The quick-create dropdown contains inconsistent labels, random extra file types, deprecated `.sagews`, and differs from the customize modal.

Impact: new file creation is inconsistent and confusing in one of the most common workflows.

Likely areas:

- full page file explorer `+ New` button/dropdown
- flyout file explorer controls
- `+ New` page/customize modal
- quick-create file type preferences
- file association/create-file metadata

Plan:

1. Locate the canonical file type list used by the `+ New` page customize modal.
2. Make the quick-create dropdown use the same preferred/customized list.
3. Add the same dropdown to the flyout file explorer.
4. Add `Customize...` at the bottom of the dropdown, opening the same customize modal used by the `+ New` page.
5. Remove deprecated/unsupported `.sagews` from quick-create.
6. Remove unrelated second-section items that ignore quick-create preferences.
7. Normalize labels, e.g. use the same names for Agent Chat/Chat and Notebook/Jupyter notebook across the dropdown and customize UI.

Validation:

- Browser smoke: full page and flyout file explorers show the same quick-create options.
- Browser smoke: `Customize...` opens the same modal from both locations.
- Browser smoke: changing customize preferences changes the dropdown.
- Regression smoke: creating common file types from both dropdowns works.

### (done) P1-C: Make `+ New` Breadcrumb And Title Match Find

Symptom: the breadcrumb/current-directory path at the top of `+ New` is worse than the Find path component. The actual flyout title says `+ Create` instead of `+ New`.

Impact: visual inconsistency and terminology mismatch in adjacent file workflows.

Likely areas:

- `+ New` page/flyout components
- Find flyout/page breadcrumb component
- shared path navigator component
- project flyout title metadata

Plan:

1. Identify the breadcrumb component used by Find.
2. Reuse that component in `+ New` for current directory display.
3. Rename `+ Create` to `+ New` in the flyout title and any matching labels.
4. Keep route names and internal identifiers stable unless a visible label is wrong.

Validation:

- Browser smoke: `+ New` flyout/page shows the same breadcrumb style as Find.
- Browser smoke: title says `+ New`.
- Mobile/narrow smoke if the breadcrumb wraps or truncates.

### (done) P1-D: AI Assistant Modal Needs Agent Selector And Persistent Default

Symptom: clicking an AI assistant button, e.g. in Jupyter, uses a default agent without letting the user choose among their agents.

Impact: users with multiple agents cannot direct assistant work to the intended agent, which undermines the new agent model.

Likely areas:

- Jupyter assistant buttons/modals
- shared AI assistant modal components
- Agents flyout DKV index/query
- workspace default agent selection
- account/project/workspace preferences for recent/default agent

Plan:

1. Find the shared modal or flow used by Jupyter and other AI assistant buttons.
2. Reuse the same agent list source as the Agents flyout, including DKV index behavior.
3. Add a dropdown listing the user's available agents.
4. If no agents exist, show/use the default home/workspace agent exactly as current behavior would.
5. Pass the selected agent into the submit path.
6. Persist the selected agent as the future default for that workspace or user context.
7. Respect `P0-A`: do not show this selector when AI is disabled.

Validation:

- Browser smoke: assistant modal lists user's agents and default option.
- Browser smoke: selecting an agent changes the agent used by submit.
- Browser smoke: reopening the modal remembers the selected default.
- Browser smoke: no user agents falls back to current default behavior.

### (done) P1-E: Agents Panel `All Users` Should Become `Other Users`

Symptom: the Agents panel `All Users` button shows raw `account_id` for other users, and it includes the current user's agents.

Impact: confusing collaborator UI and unfinished presentation.

Likely areas:

- Agents flyout panel
- DKV agent index query/filter
- account/user display components
- collaborator/account lookup components

Plan:

1. Locate the `All Users` button and data query.
2. Rename it to `Other Users`.
3. Filter out the current account's agents from that view.
4. Replace raw `account_id` rendering with the existing React component for displaying a user by `account_id`.
5. Preserve current user's own agents in the primary/default view.

Validation:

- Browser smoke with at least two users' agents in a project/workspace.
- Verify current user's agents do not appear in `Other Users`.
- Verify other users render as names/emails/avatar component instead of raw UUIDs.

### (done) P1-F: Dedicated Host Creation Needs Cloudflare Region And GCP Disk Autogrow

Symptom: when creating dedicated hosts, the UI does not show the Cloudflare region. GCP main disk autogrow is available in the edit modal after creation but missing during original creation.

Impact: admins/users can create hosts with incomplete or wrong configuration.

Likely areas:

- project host creation modal/page
- project host edit modal
- cloud provider region metadata
- GCP disk/autogrow settings schema
- host creation RPC payload validation

Plan:

1. Read `src/.agents/scalable-architecture.md` before changing project-host control-plane paths.
2. Compare host edit modal fields with host creation fields.
3. Add Cloudflare region display/selection to creation where it is relevant.
4. Add GCP main disk autogrow controls to creation, matching edit modal semantics.
5. Ensure defaults match existing backend defaults and existing edit behavior.
6. Ensure the create RPC receives and persists the new fields.

Validation:

- Frontend typecheck/lint.
- Browser smoke: create-host modal shows Cloudflare region and GCP autogrow controls.
- If safe in dev, create a host config and verify fields appear in the resulting host edit modal.

### (done) P1-G: Target Course/Student Membership Tiers By Verified Instructor Domain

Symptom: there is no way to offer a special course/student membership tier only to instructors with a verified institutional domain such as UCLA, without showing it to all instructors.

Impact: institutional/package offerings clutter the generic store and cannot be cleanly targeted.

Likely areas:

- admin membership tier editor
- membership tier product/category schema
- instructor/student membership selection UI
- verified email/domain data
- membership tier filtering APIs/selectors

Plan:

1. Read `src/.agents/scalable-architecture.md` before changing account/billing/membership paths.
2. Identify the existing categories: admin-assigned only, free default, public store, public instructor-selected student tier.
3. Add an admin-editable allowlist of verified email domains to the membership tier Product section.
4. Interpret an allowlisted-domain student tier as visible only to instructors whose verified email domain matches.
5. Keep this as a UI/availability filter; no heavyweight security model is required by the current request.
6. Ensure the generic public store remains uncluttered.
7. Document or label the domain behavior clearly in admin UI.

Validation:

- Admin UI smoke: add/remove allowed domains on a tier.
- Browser smoke as instructor with matching verified domain: targeted tier appears for student selection.
- Browser smoke as instructor with nonmatching domain: targeted tier is hidden.

### (done) P1-H: Invite Acceptance Page Should Show Signed-In User

Symptom: the "Accept project invite for CoCalc Launchpad" page does not show who is signed in, so users may accidentally accept an invite as the wrong account.

Impact: account confusion in collaborator onboarding.

Likely areas:

- project invite accept page
- account store/current user display
- sign-in/out link on invite flow
- invite acceptance RPC/client

Plan:

1. Locate the project invite acceptance page.
2. Display the signed-in user's full name and email address near the accept action.
3. If the user is not signed in, keep the existing sign-in flow clear.
4. Add a switch-account/sign-out affordance if the page already supports it, or a clear link to account settings/sign-out if not.
5. Do not change invite acceptance authorization semantics.

Validation:

- Browser smoke signed in as user A: page displays user A name/email before accepting.
- Browser smoke signed out: page still asks for sign-in.
- Browser smoke accepting invite still succeeds.

## P2: Polish / Easy UI Consistency

### (done) P2-A: Move Jupyter Hover Tools To The Right

Symptom: Jupyter cell hover tools `Run`, `Agent`, and `Format` clutter the left side of cells. CoCalc.com places them on the right, which is cleaner.

Impact: visual clutter in a high-frequency editor.

Likely areas:

- Jupyter cell toolbar/button bar
- hover tool CSS/layout
- mobile/narrow responsive behavior

Plan:

1. Locate the Jupyter hover toolbar component.
2. Change layout to justify the hover tools to the right, matching cocalc.com behavior.
3. Verify markdown/code cells and selected/unselected states.
4. Ensure mobile/narrow layouts do not overlap cell content.

Validation:

- Browser smoke on a notebook with code and markdown cells.
- Visual check against the cocalc.com screenshot expectation.

### (done) P2-B: Make Top-Right Docs Tab Icon-Only

Symptom: `Docs` is the only top-right tab with a word label; the others are icons.

Impact: minor inconsistency and wasted horizontal space.

Likely areas:

- top navigation/right toolbar
- docs link/tab component
- tooltip/aria label

Plan:

1. Locate the top-right Docs tab component.
2. Replace visible text with an icon-only button consistent with neighboring tabs.
3. Preserve tooltip and accessible label so the icon-only control remains discoverable.

Validation:

- Browser smoke: Docs tab appears as an icon and still opens docs.
- Accessibility check: title/aria-label communicates "Docs".

### (done) P2-C: Add Keyboard Shortcut Tooltips To Chat Queue/Send/Steer Buttons

Symptom: chat queue/send/steer buttons do not consistently advertise keyboard shortcuts. Users will not discover Shift+Enter for queue/send and Ctrl+Enter for steer.

Impact: discoverability issue in core chat/Codex workflow.

Likely areas:

- chat composer submit/queue/steer buttons
- Codex running-turn composer state
- tooltip components
- platform-specific shortcut formatting

Plan:

1. Locate chat button components for Send, Queue, and Steer.
2. Add or normalize tooltips:
   - Send: `Shift+Enter`
   - Queue: `Shift+Enter`
   - Steer: `Ctrl+Enter`
3. Confirm the displayed shortcut matches actual keyboard handler behavior.
4. Avoid duplicate nested tooltips if one button already has tooltip wrapping.

Validation:

- Browser smoke normal chat state: Send tooltip shows `Shift+Enter`.
- Browser smoke queued/running Codex state: Queue/Steer tooltips show shortcuts.
- Keyboard smoke: shortcuts still work.

