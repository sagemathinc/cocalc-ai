# Beta Bug Triage Plan - 2026-06-08

Source list: `/home/user/wstein-todo/wstein.tasks.md`.

Goal: resolve the current beta tester bug set in small, reviewable commits. Prioritize release blockers, data/control-plane correctness, and high-frequency UX regressions before cosmetic polish.

## Principles

- Fix one concrete bug per commit unless two bugs share the same localized root cause.
- Reproduce or inspect the specific UI/code path before changing behavior.
- Prefer focused unit/component tests for pure logic and targeted live smoke tests for browser-only regressions.
- For project/host/auth/billing/course behavior, read `src/.agents/scalable-architecture.md` before changing backend or control-plane code.
- For live validation, use the current CoCalc CLI path exactly:
  `"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"`.

## Priority Order

### (done) P0-A: Project Start EACCES Updating `.ssh/authorized_keys`

Solution: wontfix -- it's a 1-off problem to manually fix on a case-by-case basis.

Symptom: project start fails with `EACCES: permission denied, open '/mnt/cocalc/project-.../.ssh/authorized_keys'`.

Impact: critical beta blocker. Existing projects or user-created `authorized_keys` can fail to start, and users do not know to manually delete the file.

Likely areas:

- `src/packages/project/control/*`
- project startup SSH key setup code
- project host file ownership helpers
- rootfs/project directory ownership migration code

Plan:

1. Find the recently added startup code that writes `.ssh/authorized_keys`.
2. Confirm which user owns the project directory and which process/user writes the file.
3. Fix writes to happen as the correct project user, or repair file ownership before writing if that is the intended invariant.
4. Handle pre-existing `.ssh` and `authorized_keys` with restrictive or wrong ownership without failing project start.
5. Add a focused test for a project with pre-existing `authorized_keys` owned by the project user and one with repairable wrong ownership.

Validation:

- Focused server/project-control test.
- Live start of a disposable project with a pre-created `.ssh/authorized_keys`.

### (done) P0-B: Course Instructor/Student Pay Configuration Missing

Symptom: course UI does not expose instructor/student pay configuration, though backend implementation likely exists.

Impact: critical for beta testing course billing configuration.

Likely areas:

- `src/packages/frontend/course/*`
- `src/packages/frontend/course/settings/*`
- student-pay membership/course billing UI
- course configuration Conat/RPC APIs

Plan:

1. Locate existing student-pay/instructor-pay backend and frontend code.
2. Determine whether UI is hidden by feature flag, missing from course settings, or not wired to the current course model.
3. Restore or add the course setting UI with explicit save/load behavior.
4. Ensure permissions are correct: only course owners/admins can change the pay mode.
5. Add tests for loading, changing, and persisting the course pay configuration.

Validation:

- Focused course frontend tests.
- Live course settings smoke with both instructor-pay and student-pay values.

### (done) P0-C: Slate Markdown Duplicate Insertions

NOTE: we *thought* we fixed this yesterday but did not.  It's much better now, but still broken.  It's a lot more obviously broken on ipad, but I've hit this in chrome just now.  The solution absolutely CANNOT be stupid heuristic and "don't merge if upstream matches us". That's so dumb. Take a step back and PROVE THINGS RIGOROUSLY.  Understand the patchflow algorithm.  We will do this right.

Symptom: typing `(done)` once in a single Slate markdown frame can produce `(done) (done)`.

Impact: potential silent content corruption in markdown editing.

Likely areas:

- `src/packages/frontend/editors/slate/*`
- `src/packages/frontend/frame-editors/markdown-editor/*`
- Slate-to-syncstring save/apply pipeline
- local echo vs remote patch handling

Plan:

1. Reproduce with a single Slate frame and capture sync history plus Slate operation logs.
2. Identify whether the duplicate comes from local operation replay, remote patch application, or save debounce using stale content.
3. Fix the source of double-application; do not add content-based duplicate heuristics.
4. Add a regression test around a single local insert that receives its own persisted patch.

Validation:

- Focused Slate markdown sync test if available.
- Live single-frame markdown edit smoke.

## High-Value UX / Core Workflow

### (done) P1-A: Slate Markdown TOC Jump Then Click Scrolls To Old Selection

Symptom: clicking a table-of-contents entry jumps to the right heading, but clicking that heading scrolls back to the previously selected location if Slate was not focused before the programmatic scroll.

Likely areas:

- Slate markdown editor focus/selection handling
- table-of-contents click handling
- scroll-into-view hooks for Slate selection

Plan:

1. Reproduce with a markdown file containing a nontrivial TOC.
2. Trace focus and selection state before and after TOC programmatic scroll.
3. Prevent stale selection from being scrolled into view when the next user click is intended to create a new selection.
4. Prefer a focus/selection state fix over suppressing all selection scroll behavior.

Validation:

- Browser smoke: TOC jump, click heading, verify no jump back.
- Focused test for stale selection scroll suppression if feasible.

### (done) P1-B: Workspace / Project-Home Chat Uses `.local/...` As Working Directory

Symptom: workspace and project-home chats stored under `$HOME/.local/...` make the selected tab's working directory `.local/...`, which is confusing for agents.

Likely areas:

- chat file tab title/current-directory derivation
- workspace chat special-case code
- project page selected-file working directory logic

Plan:

1. Find the existing special case that changes workspace chat tab titles.
2. Apply the same classification to current-directory derivation.
3. For workspace/project-home chats under `.local/...`, use workspace root or `$HOME` as cwd.
4. Ensure ordinary `.chat` files outside the special path still use their containing directory.

Validation:

- Focused current-directory derivation test.
- Live workspace/project-home chat tab smoke.

### (done) P1-C: Jupyter Slate Markdown Input Cannot Scroll / Is Too Short

Symptom: Slate markdown editing in Jupyter has a limited vertical input height and cannot scroll, making editing annoying.

Likely areas:

- Jupyter markdown cell Slate editor wrapper
- shared Slate composer/editor sizing
- task composer precedent for grow-to-content behavior

Plan:

1. Compare task Slate composer sizing to Jupyter Slate markdown cell sizing.
2. Change Jupyter Slate markdown input to grow naturally like tasks instead of being a fixed-height unscrollable region.
3. Confirm this does not break notebook cell layout, selection, or keyboard shortcuts.

Validation:

- Browser smoke with a long markdown cell in Jupyter.
- Focused component/style test if practical.

### (done) P1-D: Download File Does Not Require Project Start

Symptom: frontend prompts to start a stopped project before downloading a file, even though download does not require project start.

Likely areas:

- file explorer download action
- project file download URL generation
- legacy start-before-file-operation guards

Plan:

1. Trace download click path and identify the legacy start guard.
2. Remove start requirement only for download/read paths that are served without project runtime.
3. Keep start requirement for operations that genuinely need a running project.
4. Add a test for download action from a stopped project not prompting start.

Validation:

- Focused file action test.
- Live stopped-project file download smoke.

### (done) P1-E: Agent Flyout PNG Link Does Not Open

Symptom: clicking a PNG link in the left agents flyout does nothing, while the same link works in the main chat file.

Likely areas:

- agents flyout chat message link renderer
- chat file attachment/link open handling
- project file open route normalization

Plan:

1. Compare link rendering and click handlers between main chat and agents flyout.
2. Ensure flyout links route through the same project file opener as main chat.
3. Add a regression test for image/file links rendered inside the agents flyout context.

Validation:

- Browser smoke: click PNG link from flyout and main chat.
- Focused link handler test if the renderer is testable.

## Fast UI Polish / Safety Batch

### (done) P2-A: Host Drawer Access Control Add Button Height Mismatch

Symptom: after selecting a user in the host access-control dropdown, the selected item height makes the `Add` button no longer align with the select.

Likely areas:

- host drawer access-control component
- account/user select option and selected-label rendering

Plan:

1. Find selected user label rendering in the host access-control dropdown.
2. Constrain selected item/avatar row height to match the select control, likely 22px as observed.
3. Verify dropdown option rendering remains readable and does not regress the empty-state alignment.

Validation:

- Browser visual smoke in host drawer.
- Component snapshot/style test only if existing pattern supports it.

### (done) P2-B: Remove Redundant Docs Cards Below Main TOC

Symptom: docs page has image cards below the main table of contents that are redundant and make scrolling through docs harder.

Likely areas:

- docs landing page / docs index component
- docs card grid data/component

Plan:

1. Identify the docs page section below the main TOC.
2. Remove the redundant image card section while keeping the improved TOC.
3. Confirm the page still has clear navigation and no layout gaps.

Validation:

- Frontend lint/typecheck.
- Browser smoke of docs landing page.

### (done) P2-C: Site License Pool Remove Needs Confirmation

Symptom: removing a site license pool is a red danger button but has no confirmation.

Likely areas:

- site license admin/settings UI
- license pool management component

Plan:

1. Locate the remove pool button and delete handler.
2. Wrap it in `Popconfirm` or equivalent existing confirmation pattern.
3. Ensure the destructive action is not triggered by accidental click and still reports errors correctly.

Validation:

- Focused component test if available.
- Browser smoke: click remove, cancel, confirm.

### (done) P2-D: Ping Time Layout And Project-Host Latency Visibility

Symptom: ping time value is not aligned with label; project-host ping times are not visible where host connection choices are shown.

Likely areas:

- connection/network status component
- project host selector/dropdown
- existing ping/latency measurement state

Plan:

1. Fix current ping label/value layout first as a small CSS/layout change.
2. Find whether project-host latency is already measured client-side or needs a lightweight measurement.
3. If measured, surface it in the project-host dropdown.
4. If not measured, add a minimal non-blocking ping path only if the API already supports it; otherwise split into a follow-up implementation plan.

Validation:

- Browser visual smoke for current ping display.
- Live host dropdown smoke showing project-host latency when available.

## Closeout - 2026-06-09

All items in this 2026-06-08 beta batch have either been fixed and verified, or explicitly closed as non-code/manual remediation. Keep this file closed; new beta tester reports are tracked in `beta-bug-triage-plan-2026-06-09.md`.

