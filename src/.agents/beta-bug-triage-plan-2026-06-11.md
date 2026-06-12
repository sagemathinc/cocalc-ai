# Beta Bug Triage Plan - 2026-06-11

Source list: `/home/user/wstein-todo/wstein.tasks.md`.

Goal: turn the newest beta tester reports into a release-focused work queue. Fix one bug per commit unless two reports share a localized root cause. Prioritize data loss, stuck workflows, compatibility regressions, policy enforcement, and cost-abuse release blockers before polish.

## Intake Notes

- The source file currently has 11 bug reports.
- Active scope below tracks all 11 reports.
- Several items touch accounts, project lifecycle, project hosts, billing, or control-plane APIs; read `src/.agents/scalable-architecture.md` before changing those code paths.
- Treat backend enforcement as canonical for verification, project start/create, billing balance edits, and project-host creation. Frontend hints are useful but not sufficient.
- Admin impersonation should reproduce target-user restrictions exactly, including email-verification blocks, so support can see the same actionable error the user sees.
- For live validation, use the CoCalc CLI path exactly:
  `"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"`.

## P0: Release Blockers / Data Loss / Stuck Core Workflows / Cost Abuse

### P0-A: Project Compression Can Produce Silently Broken Archives

Symptom: selecting several folders and using project file compression, or downloading multiple selected files through automatic compression, can produce a `.tar.gz` that appears successful but is truncated or otherwise broken when compression takes too long.

Impact: serious data-loss risk because users may believe they have a valid backup before deleting project data.

Likely areas:

- `src/packages/conat/files/file-server.ts`
- project file explorer compress/download actions
- project-host file download route and HTTP download helpers
- project `/tmp` btrfs subvolume creation/wipe helpers
- project-side archive command timeouts, progress reporting, and cleanup

Plan:

1. Reproduce with enough folders/files that compression exceeds the current timeout; verify with `tar -tzf` and compare archive contents.
2. Identify whether truncation is caused by a command timeout, stream cutoff, hub/project-host route timeout, or frontend download completion logic.
3. Generate archives through an incomplete temporary filename, then atomically move to the final name only after `tar` exits successfully.
4. Surface timeout, disk-space, permission, and quota failures clearly in the frontend; never present a failed archive as complete.
5. Replace hidden short timeouts with an explicit per-project compression budget similar to disk usage budget logic.
6. For multi-file download, prefer creating the temporary tarball under the project's `/tmp` and deleting it after download completion or failure.
7. Do not require project start. This flow is specifically needed for projects that cannot start due to quota, broken runtime state, or CPU-usage limits.
8. For stopped projects, ensure the project `/tmp` backing subvolume exists directly before compression. It often already exists, and project start can continue to be the path that wipes `/tmp`.
9. If `/tmp` creation fails, show a clear error and do not fall back to writing a confusing final archive in project storage.

Validation:

- Focused project file compression test for timeout/failure cleanup if the backend path is testable.
- Manual smoke with a large selected folder set: archive succeeds and `tar -tzf` is valid, or fails visibly with no final tarball.
- Manual smoke for stopped project multi-file download: project does not start, `/tmp` is created if needed, archive downloads, and the temporary tarball is removed after successful download.

### P0-B: Jupyter Evaluate Uses Stale Running Kernel After Project Stop

Symptom: run a notebook so the kernel is running, stop the project, then evaluate a cell. The frontend still believes the kernel is running and the cell appears stuck.

Impact: common notebook workflow can wedge with no clear recovery path; restarting the project can make the stale-state confusion worse.

Likely areas:

- `src/packages/frontend/jupyter/browser-actions.ts`
- `src/packages/frontend/jupyter/project-start.ts`
- `src/packages/frontend/project/project-start-warning.ts`
- `src/packages/frontend/frame-editors/jupyter-editor/actions.ts`
- Jupyter kernel state and project backend state synchronization

Plan:

1. Reproduce by stopping the project after a notebook reaches idle/running kernel state, then execute a cell.
2. Confirm whether execute bypasses `ensure_project_running` because stale kernel state says the notebook is live.
3. Require a fresh project-running check before cell execution, even if the stored kernel state is `idle` or `busy`.
4. Invalidate or downgrade kernel status when project backend state transitions away from running.
5. Show a clear "starting project before running notebook cells" state instead of leaving the cell pending indefinitely.

Validation:

- Focused Jupyter actions test for stopped project plus stale kernel state.
- Browser smoke: run cell, stop project, run cell again, project starts and execution continues or shows an actionable error.

### P0-C: Email Verification Enforcement Is Incomplete For Project Actions

Symptom: when email verification is enabled, an unverified user can still create or start projects, and may be able to create project hosts. The reporter saw this while impersonating another user; impersonation should reproduce the target user's restrictions exactly.

Impact: site policy enforcement is inconsistent, especially for self-hosted sites that require verified email before resource creation or runtime use.

Likely areas:

- account email verification state and site settings
- project creation APIs and frontend project creation flow
- project start APIs and `ensure_project_running`
- project-host creation APIs and admin/user host UI
- impersonation/fresh-auth/admin semantics

Plan:

1. Read `src/.agents/scalable-architecture.md` before changing project, account, or host control-plane APIs.
2. Reproduce with email verification enabled using a non-admin unverified account, then reproduce the same account through admin impersonation.
3. Enforce the block in backend/control-plane APIs for create project, start project, and create project host; do not rely only on disabled frontend buttons.
4. Return a user-facing error that explicitly says verification is required and includes a path/action to resend the verification email.
5. Ensure impersonation sees the same verification block and call to action, so support can diagnose the user's real issue.
6. Add frontend handling that turns the backend block into a clear verify-email call to action.

Validation:

- Focused backend/API tests for unverified account blocking each action.
- Browser smoke: unverified account sees actionable verify-email error; verified account can create/start normally.
- Impersonation smoke: support/admin acting as an unverified user gets the same verification error.

### P0-D: Admins Need A Supported Customer Balance Adjustment Flow

Symptom: admins need a safe way to add or remove customer account balance directly, with fresh 2FA, audit logging, user-visible notes, admin-only notes, and a central list of edits. Current voucher-based workarounds are operationally risky; recent voucher-related abuse on the legacy site makes this a release blocker because this feature lets us remove voucher functionality.

Impact: billing/support and cost-abuse risk. This is a supported admin-purchase/ledger workflow, not just a convenience UI.

Likely areas:

- admin user detail/purchases panel
- admin purchase page and recent admin-purchase audit log
- purchases/billing balance ledger
- audit log models and admin audit UI
- fresh-auth/2FA gate components
- course student payment/membership funding paths

Plan:

1. Read `src/.agents/scalable-architecture.md` before changing account/billing authority paths.
2. Identify the canonical purchase/balance ledger API and how admin purchases are recorded today.
3. Add an admin-only balance adjustment action in the admin user panel, requiring fresh 2FA.
4. Treat the adjustment as a special audited admin purchase: add a clear ledger line item, support positive and negative amounts, include a user-visible note, include an admin-only note, and record actor metadata.
5. Add or extend an admin purchase/audit page that lists recent admin purchases and balance edits by any admin.
6. Remove the deprecated `Minimum allowed balance` warning from the admin user panel once this replacement flow exists.
7. Verify course student membership payment can use available account credit where intended.
8. Defer deleting voucher functionality until this replacement flow is shipped and validated, then remove vouchers in a follow-up.

Validation:

- Focused backend tests for add/remove balance, fresh-auth failure, audit event, and user-visible line item.
- Frontend admin test for required notes, positive/negative adjustments, and recent admin-purchase listing.
- Manual smoke: admin adjusts balance, user sees public note, admin sees both notes and the global audit entry.

## P1: Compatibility / High-Frequency UX / Core Editing

### P1-A: CoCalc.com Jupyter Markdown Needs One-Time Escaped Delimiter Migration

Symptom: notebooks edited on cocalc.com may contain markdown with escaped parentheses/brackets such as `\(`, `\)`, `\[`, and `\]` that were literal-safe markdown there but become math delimiters in cocalc-ai.

Impact: imported or legacy notebooks can render markdown incorrectly after first open.

Likely areas:

- Jupyter notebook load/import normalization
- notebook metadata read/write
- markdown cell migration helpers shared with board/slide compatibility migration
- `src/packages/frontend/frame-editors/whiteboard-editor` schema-version migration precedent
- notebook save pipeline

Plan:

1. Detect cocalc.com-origin notebooks using `metadata.kernelspec.metadata.cocalc`.
2. Add `metadata.cocalc.schemaVersion = 1` after migration, and skip migration when that version is already present.
3. Reuse the whiteboard/slide schema-version migration helper or factor out a shared helper if needed.
4. On first open only, process markdown cells by removing backslashes only for `\(`, `\)`, `\[`, and `\]`, in the same way as the board/slide migration.
5. Do not add special rendering logic; convert the document data once so copy/paste and future edits behave consistently.
6. Preserve all non-markdown cells and unrelated notebook metadata.

Validation:

- Focused notebook migration test with cocalc.com kernelspec metadata and escaped delimiters.
- Idempotence test: opening a migrated notebook twice does not rewrite the markdown a second time.
- Browser smoke: legacy notebook renders literal parens/brackets correctly after first open/save.

### P1-B: Create Snapshot Modal Does Not Close After Creating Snapshot

Symptom: the create snapshot modal stays open after clicking the blue create button, even though a snapshot is created in the background. Users can click again and create duplicate snapshots.

Impact: confusing workflow and accidental snapshot spam.

Likely areas:

- project settings or storage UI snapshot modal
- `src/packages/conat/files/file-server.ts`
- project snapshot RPC wrappers
- frontend modal submit/loading lifecycle

Plan:

1. Locate the create snapshot modal and reproduce the stuck-open behavior.
2. Close the modal immediately after a successful create response.
3. Keep the modal open on failure and show the error.
4. Disable duplicate submits while the create request is in flight.

Validation:

- Focused modal test if available.
- Browser smoke: click create once, modal closes, one snapshot appears; failure keeps modal open with an error.

### P1-C: Membership Page Does Not Explain Verify-Email Requirement For Claimable Site License

Symptom: if a user has an unverified email address and a site-license membership they could claim after verification, the membership page does not clearly tell them to verify email to claim it. The app-level verify-email modal also does not explain that a site license may be waiting or that unverified accounts cannot create/start projects.

Impact: users can miss the reason to verify email and fail to claim available membership.

Likely areas:

- `src/packages/frontend/account/*`
- `src/packages/frontend/app/verify-email-banner.tsx`
- site-license claim eligibility frontend/API
- verify-email resend API/client

Plan:

1. Identify the account/membership data that indicates a pending claimable site license for an unverified email.
2. Add a prominent membership-page callout: "Verify your email to claim your site license" with a blue resend-verification button.
3. Add contextual reasons to the verify-email modal/banner when applicable: pending site license and blocked project actions.
4. Ensure resend verification handles success/failure clearly and rate limits gracefully.

Validation:

- Focused membership page rendering test for unverified account with claimable license.
- Browser smoke: click resend verification from the membership page and from the app-level verification prompt.

### P1-D: Closing The Last Editor Frame Should Close The File

Symptom: clicking the `X` in the upper-right of a frame title bar closes frames until the last frame, then resets all frames to the default layout instead of closing the file.

Impact: the close button behavior is surprising and can trap users in a file they expected to close.

Likely areas:

- `src/packages/frontend/frame-editors/frame-tree/title-bar.tsx`
- `src/packages/frontend/frame-editors/base-editor/actions-base.ts`
- editor frame-tree close/reset logic
- project `close_file` action

Plan:

1. Reproduce with a file that has a single remaining frame.
2. Change last-frame close to close the entire file and reset that file's saved layout to default for next open.
3. Preserve existing behavior for closing one frame out of a split layout.
4. Update or remove the tooltip that currently says closing all frames restores the default layout.

Validation:

- Focused frame-tree action test for single-frame close.
- Browser smoke: close last frame closes the file tab; reopening uses default layout.

### P1-E: Open Files List Mode Has No Close Button

Symptom: when the top navigation for files is in list mode, open files cannot be closed from the list because there is no close button, unlike the projects list.

Impact: users lose a basic file-tab management action in one navigation mode.

Likely areas:

- project open-file navigation/list-mode UI
- `src/packages/frontend/project/redux/actions.ts`
- open file order/list components
- project-list close button precedent

Plan:

1. Locate the list-mode open files dropdown/list component.
2. Add a close button per open file row using the existing `close_file` action.
3. Prevent row navigation from firing when the close button is clicked.
4. Match the projects list close affordance and keyboard/accessibility labeling.

Validation:

- Component test if the list-mode component is isolated.
- Browser smoke: list mode shows close button, closes one file, leaves other open files intact.

### P1-F: Whiteboard Slate/CodeMirror Text Editor Scrolls Instead Of Growing

Symptom: editing a whiteboard note with enough content causes the Slate/CodeMirror editor to switch to internal scrolling and stop growing. The whiteboard measures the editor height for static display, so the note renders with the wrong height.

Impact: whiteboard note editing/display becomes incorrect for longer markdown notes.

Likely areas:

- `src/packages/frontend/frame-editors/whiteboard-editor/elements/text*`
- `src/packages/frontend/editors/markdown-input/*`
- whiteboard element measurement and static display sizing
- existing grow-to-fit option used by tasks and Jupyter markdown cells

Plan:

1. Reproduce with a long Slate note on a whiteboard.
2. Compare the whiteboard markdown editor props with tasks and Jupyter markdown cells that already grow to content.
3. Pass the grow-to-fit/no-internal-scroll option through the whiteboard text editor path.
4. Verify CodeMirror mode and Slate mode both report the full content height to the whiteboard.

Validation:

- Focused component test if sizing props can be asserted.
- Browser smoke: long whiteboard note grows during edit and static display height matches content.

## P2: Polish / Operational UX

### P2-A: LaTeX Error Toast Gives No Useful Details

Symptom: opening a LaTeX file sometimes shows a toast/modal saying only "An error occurred" or similar, with no details or path to inspect the underlying error.

Impact: users cannot diagnose or report LaTeX editor failures.

Likely areas:

- `src/packages/frontend/frame-editors/latex-editor/*`
- shared frontend error notification helpers
- `src/packages/frontend/components/user-facing-error.ts`
- backend/project LaTeX compile/open error propagation

Plan:

1. Search for generic "An error occurred" paths used by LaTeX open/compile flows.
2. Improve the central error display to show the most useful top-level message and put raw technical details behind a details toggle.
3. Preserve privacy/security by not showing sensitive backend details unless already available to the user.
4. If no exact repro is possible, add defensive context around LaTeX editor open/compile failures so future reports include actionable details.

Validation:

- Focused error formatting tests for generic errors and nested backend errors.
- Manual smoke with a forced LaTeX open/compile error, confirming the toast includes actionable text and details.

