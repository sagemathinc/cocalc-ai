# Beta Bug Triage Plan - 2026-06-09

Source list: `/home/user/wstein-todo/wstein.tasks.md`.

Goal: turn the newest beta tester reports into a release-focused work queue. Fix one bug per commit unless two reports share a localized root cause. Prioritize data loss, account/bootstrap lockouts, stuck workflows, and broken core editing before polish.

## Intake Notes

- The source file currently has 21 bug reports.
- Active scope below tracks 20 items.
- The ping/latency report is a duplicate of the 2026-06-08 `P2-D` work and is listed under `Already Covered`.
- Several items touch auth, project hosts, courses, or control-plane APIs; read `src/.agents/scalable-architecture.md` before changing those code paths.
- For live validation, use the CoCalc CLI path exactly:
  `"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"`.

## P0: Release Blockers / Data Loss / Lockouts

### (done) P0-A: Markdown Data Loss When Splitting Slate And CodeMirror

Symptom: in a new markdown file, type `foo`, press `Alt+Enter`, CodeMirror appears with `foo`, the Slate side is blanked, then CodeMirror is also blanked and the file contents are lost.

Impact: direct user data loss in a core editor.

Likely areas:

- `src/packages/frontend/frame-editors/markdown-editor/*`
- Slate/CodeMirror split-frame state synchronization
- frame-tree open/split handlers and markdown save debounce
- syncstring local/remote update application

Plan:

1. Reproduce with a fresh markdown file and capture frame-tree state, syncstring history, and Slate/CodeMirror content transitions.
2. Identify whether the blank content originates from frame split initialization, a stale Slate deserialize, or a save from an empty editor instance.
3. Fix by preserving the current syncstring text as the single source of truth during frame creation; do not patch with content heuristics.
4. Add a regression test that starts with unsaved local markdown content, opens the text frame, and verifies both frames retain the text.

Validation:

- Focused markdown editor/frame split test.
- Live smoke: fresh markdown file, type, `Alt+Enter`, wait for save, reload.

### (done) P0-B: Launchpad Initial Admin Bootstrap APIs Return 404

Symptom: creating the initial admin account in the Launchpad SEA binary fails because `/api/v2/auth/bootstrap`, `/api/v2/auth/requires-token`, and `/api/v2/auth/sign-up` return 404 HTML responses.

Impact: fresh Launchpad installs cannot complete first-admin onboarding.

Likely areas:

- `src/packages/next/pages/api/v2/auth/*`
- Launchpad/SEA server route mounting
- static bundle/API route inclusion
- bootstrap sign-up frontend API client

Plan:

1. Reproduce against a local SEA or equivalent Launchpad server and confirm which API routes are mounted.
2. Compare dev hub route registration with SEA route packaging.
3. Fix the missing route exposure or frontend API base mismatch.
4. Add a smoke test or package-level test that asserts the bootstrap auth routes exist in Launchpad mode.

Validation:

- Focused auth route test.
- Local fresh Launchpad bootstrap smoke through admin creation.

### (done) P0-C: Slate Crash After Editing Markdown In CodeMirror Side

Symptom: after editing a markdown file through the CodeMirror side and switching back to Slate, Slate can throw `Cannot resolve a DOM point from Slate point`.

Impact: editor crash and possible lost editing context.

Likely areas:

- Slate selection restore/focus code
- markdown text-to-Slate parse pipeline
- CodeMirror-to-Slate synchronization
- frame focus and stale selection state

Plan:

1. Reproduce with Slate and CodeMirror split frames, then capture selection path/offset before and after text-side edits.
2. Determine whether Slate selection is stale relative to the current Slate node tree after reparse.
3. Normalize or clear invalid selections before focus/scroll restoration; prefer a structural selection validity check over catching the DOM exception.
4. Add a unit test for restoring focus after the Slate document shape changes.

Validation:

- Focused Slate selection validity test.
- Live smoke: edit in text side, switch back to Slate, click/edit without crash.

### P0-D: Jupyter Cell Drag-And-Drop Reorder Is Nearly Unusable

Symptom: cells cannot be dragged reliably to the top or bottom, ordering feels broken, and dragged cells change to a visually broken style.

Impact: broken basic notebook editing workflow.

Likely areas:

- `src/packages/frontend/jupyter/*`
- notebook cell list virtualization
- drag/drop library integration
- cell drag preview styling and drop target calculation

Plan:

1. Reproduce top, bottom, and middle reorder failures in a notebook with enough cells to scroll.
2. Inspect current drag library assumptions against the virtualized cell list and scroll container.
3. Decide whether to repair the current implementation or switch to a simpler explicit drag-handle/reorder approach.
4. Fix visual drag preview so the dragged cell remains recognizable.
5. Add focused reorder tests for top, bottom, and same-list moves if the component can be tested outside the browser.

Validation:

- Browser smoke: reorder cells to top, bottom, and between distant cells.
- Verify notebook model order persists after save/reload.

### (done) P0-E: Launchpad 2FA Onboarding Catch-22 With Passkeys

Symptom: setting up only a localhost-bound passkey during onboarding can block later Cloudflare-hosted sign-in, and recovery-code sign-in does not allow adding a non-passkey 2FA method.

Impact: users can lock themselves out of practical administration.

Likely areas:

- 2FA settings and recovery-code auth flow
- passkey/WebAuthn domain handling
- account security UI gating around last method removal/addition
- Launchpad onboarding flow

Plan:

1. Reproduce the localhost passkey then DNS-hosted sign-in path.
2. Identify where recovery-code-authenticated sessions are blocked from adding TOTP/non-passkey methods.
3. Allow adding a domain-independent 2FA method after recovery-code sign-in while preserving fresh-auth requirements for destructive actions.
4. Ensure users still cannot remove the last working 2FA method without first adding another method.

Validation:

- Focused auth/2FA permission tests.
- Browser smoke: recovery-code sign-in, add TOTP, then sign in from DNS host.

### (done) P0-F: Course Invite URL Error Leaves Project Configuration Spinner Stuck

Symptom: adding a student with an invite message containing a URL shows an error, but the floating `configuring projects` progress remains stuck forever at 1.

Impact: course workflow appears permanently in progress after a validation error.

Likely areas:

- course student add/invite flow
- course project configuration task tracker
- frontend progress notification lifecycle
- backend validation errors for invite messages

Plan:

1. Reproduce with a course invite message containing a URL.
2. Trace whether project configuration tasks are created before validation or whether the frontend fails to decrement on error.
3. Move validation before task creation where possible; otherwise guarantee progress cleanup in error paths.
4. Improve the displayed validation message so the user can fix the invite text.

Validation:

- Focused course action test for validation failure cleanup.
- Live course smoke: failing invite clears progress; valid invite still configures projects.

### (done) P0-G: Failed Chat Resubmit Requires Copy/Paste

Symptom: after a chat/Codex message fails, the UI says the user can resubmit, but actually requires manually copying and pasting the failed message; after signing back in there is no simple retry-and-clear-error path.

Impact: frequent stuck workflow for chat/Codex users.

Likely areas:

- chat send/error state machine
- Codex agent message retry UI
- auth-expired recovery handling
- queued/running message state repair

Plan:

1. Reproduce with an auth-expired or intentionally failed chat message.
2. Identify the canonical message record state for failed user prompts.
3. Add an explicit retry action that reuses the original prompt, clears the old error state, and avoids duplicate sends.
4. Ensure retry works after re-auth and is disabled while an identical retry is already queued/running.

Validation:

- Focused chat state-machine test.
- Browser smoke: fail message, re-auth if needed, retry without copy/paste.

## P1: Core Workflows / High-Frequency UX

### P1-A: Project Host `Deploy Hub Latest` Does Not Deploy Missing Asset

Symptom: after making a new host version, clicking the blue `Deploy hub latest` button next to `Project host` fails unless `Project host bundle` is deployed first.

Impact: host upgrade workflow is misleading and easy to fail.

Likely areas:

- project-host drawer deploy actions
- host software artifact/version state
- backend deploy latest operation

Plan:

1. Reproduce the failing button path on a disposable host.
2. Determine whether the UI calls the wrong operation or the backend operation assumes the asset is already deployed.
3. Make the top-level deploy action deploy or ensure the required asset first, then roll out the project-host component.
4. Surface clear progress/errors for the asset deployment phase.

Validation:

- Focused host deploy operation test if feasible.
- Live host smoke: new version, one click deploy latest, project-host updated.

### (done) P1-B: CoCalc Plus Uses Port 5000 Even When Occupied

Status: Fixed. Plus now sets a free Lite `PORT` before loading the Lite server, preferring 5000 only when it can bind it.

Symptom: `cocalc-plus` advertises `localhost:5000` even when another process is already listening there, so the app fails to work.

Impact: broken local startup for common port conflicts.

Likely areas:

- `src/packages/plus/*`
- Lite server startup port selection
- SEA binary startup code

Plan:

1. Reproduce with port 5000 occupied.
2. Change startup to choose an available port, using 5000 only when free.
3. Ensure the printed URL and auth token use the actual bound port.
4. Add a test for occupied preferred port fallback.

Validation:

- Focused port-selection test.
- Local smoke with a dummy listener on 5000.

### P1-C: Copy From Timetravel Slate Markdown Loses Formatting

Symptom: copying from a past markdown version in timetravel loses formatting because the view is static rendered HTML instead of a read-only Slate view.

Impact: broken copy/paste workflow for recovering rich markdown content.

Likely areas:

- timetravel markdown renderer
- read-only Slate markdown renderer
- chat message rich copy precedent

Plan:

1. Compare timetravel markdown rendering with the fixed rich-copy path used in chat messages.
2. Render timetravel markdown through the same read-only Slate copy-capable path where possible.
3. Preserve selection/copy behavior without allowing edits.
4. Add a regression test for copying formatted markdown from read-only historical content if testable.

Validation:

- Browser smoke: copy bold/link/list/code from timetravel and paste into Slate.
- Focused renderer test if clipboard behavior can be isolated.

### P1-D: Mention Notification Emails Leak Raw HTML

Symptom: emailed `@mention` notifications include escaped raw HTML such as `<span class="user-mention" ...>`.

Impact: notification emails look broken and unprofessional.

Likely areas:

- mention notification formatting
- email notification body generation
- markdown/html sanitization for notifications

Plan:

1. Find the path that converts chat body with mention spans into notification email text.
2. Convert mentions to readable plain text or safe HTML before escaping.
3. Keep the original path/link information clear.
4. Add tests for mention email text and HTML output.

Validation:

- Focused notification formatting test.
- Local email preview or captured notification payload.

### P1-E: Docs Pages No Longer Render Markdown Code Nicely

Symptom: `/docs` integrated pages no longer render docs as markdown with syntax-highlighted fenced code blocks, inline backticks, and copy buttons.

Impact: docs quality regression and weaker self-host/onboarding guidance.

Likely areas:

- `src/packages/docs/*`
- public docs page renderer
- StaticMarkdown integration
- docs content loader

Plan:

1. Identify when docs content stopped going through markdown rendering.
2. Restore StaticMarkdown or equivalent markdown rendering for docs pages.
3. Ensure fenced code blocks get syntax highlighting and copy buttons.
4. Update docs tests to assert code block rendering, not just page text.

Validation:

- Focused public docs tests.
- Browser smoke of a docs page with fenced code and inline code.

### P1-F: CoCalc Plus Docs Include Non-Plus Content

Symptom: CoCalc Plus docs include content about multiple projects, collaborators, project hosts, and other non-Plus features.

Impact: confusing product-specific docs.

Likely areas:

- docs filtering/build pipeline
- CoCalc Plus docs route/content selection
- docs metadata/tags

Plan:

1. Inventory which docs pages should be visible in CoCalc Plus.
2. Add or use metadata tags for Plus-compatible docs.
3. Filter non-Plus pages from Plus docs navigation and search.
4. Ensure direct links to excluded docs behave intentionally.

Validation:

- Focused docs filtering test.
- Browser smoke in CoCalc Plus docs navigation.

### P1-G: Titlebar Close Button Disappears In Narrow Windows

Symptom: the upper-right `x` close icon in `frame-editors/title-bar` can disappear when the titlebar has too much content or the window is narrow.

Impact: users can get stuck without an obvious close control.

Likely areas:

- frame editor title bar layout
- CSS flex/min-width/overflow rules
- close button positioning

Plan:

1. Reproduce with a narrow frame and a busy titlebar.
2. Make the close control non-shrinking and always visible.
3. Let lower-priority title text/actions truncate before the close control.
4. Verify other titlebar actions remain reachable where possible.

Validation:

- Browser visual smoke at narrow widths.
- Component/layout test if existing titlebar tests support it.

### P1-H: CLI Auth Failure Should Suggest Or Trigger Login

Symptom: CLI commands that need an interactive auth cookie fail with `no auth cookie set` even when an API key is set, without suggesting `cocalc auth login`.

Impact: confusing CLI workflow, especially for commands needing browser-backed/fresh auth.

Likely areas:

- `src/packages/cli/*`
- auth profile resolution
- command error handling for fresh-auth/cookie-required operations

Plan:

1. Identify commands that require cookie/fresh auth and currently fail with the raw auth error.
2. Add a targeted hint for `cocalc auth login --api ...` when interactive auth is missing.
3. Consider auto-starting login only for interactive terminals and only when safe.
4. Add tests for the error message and command behavior.

Validation:

- Focused CLI auth error test.
- Manual CLI smoke with only `COCALC_API_KEY` set.

### P1-I: Backend Errors Need End-User Presentation

Symptom: frontend surfaces raw backend errors such as `Error - Error:` and `callHub: subject='...'`, which are meaningless to users.

Impact: poor UX across many failure paths.

Likely areas:

- frontend error notification helpers
- API/RPC error normalization
- details/toggle UI pattern

Plan:

1. Find the central error display path used by notifications/dialogs.
2. Add a normalization layer that removes redundant prefixes and extracts a readable top-level message.
3. Preserve raw technical details behind a details toggle.
4. Avoid hiding actionable backend validation messages.

Validation:

- Focused error formatting tests for representative RPC/backend errors.
- Browser smoke on one known backend error path.

### P1-J: Markdown Editor Reopens Closed CodeMirror Split After Refresh

Symptom: open `foo.md`, press `Alt+Enter` to split Slate/CodeMirror, close the CodeMirror side, close the file, refresh, reopen the file, and the CodeMirror text view appears again.

Impact: saved layout state is stale or incorrectly restored.

Likely areas:

- markdown editor frame tree persistence
- close-frame action persistence
- local view state save/restore

Plan:

1. Reproduce and inspect saved frame-tree/local view state before and after closing the CodeMirror side.
2. Determine whether closing the side fails to persist or reopening merges with stale defaults.
3. Persist the single-Slate frame tree after close and ensure refresh uses the latest saved state.
4. Add a frame-tree restore regression test.

Validation:

- Focused frame-tree persistence test.
- Browser smoke with split, close side, close file, refresh, reopen.

## P2: Polish / Small But Visible Regressions

### P2-A: Project Host Status Percent Wraps

Symptom: project host status card displays `75` and `%` on different lines.

Likely areas:

- project host status card layout
- percent/value CSS

Plan:

1. Find the status progress/value component.
2. Keep the percent value on one line with `white-space: nowrap` or a tighter layout.
3. Verify the card still fits narrow drawer widths.

Validation:

- Browser visual smoke in host drawer.

### P2-B: Chat Zoom Does Not Scale Fenced Code Blocks

Symptom: zooming the chatroom scales composer text but not code blocks in fenced code blocks, likely a Slate markdown rendering issue.

Likely areas:

- chat zoom/font-size state
- Slate markdown code block renderer
- rendered chat message CSS

Plan:

1. Reproduce with a message containing fenced code, then change chat zoom.
2. Identify whether code blocks use fixed font size or ignore inherited zoom CSS variables.
3. Make code blocks inherit the chat zoom/font-size while preserving monospace styling.
4. Check normal markdown editor code blocks are not unintentionally affected.

Validation:

- Browser visual smoke with multiple zoom levels.
- Focused style/component test if practical.

### P2-C: Sign-Out Confirm Buttons Are Reversed

Symptom: sign-out confirmation has `Cancel` on the wrong side; CoCalc convention is cancel on the left.

Likely areas:

- sign-out confirmation modal/popconfirm
- shared confirm helper defaults

Plan:

1. Locate the sign-out confirm component.
2. Reorder buttons to match CoCalc convention.
3. Confirm no shared helper change reverses unrelated dialogs unintentionally.

Validation:

- Browser smoke: open sign-out confirm and verify button order.

## Already Covered / Do Not Reopen From This List

### Done: Ping/Latency Layout And Project-Host Latency

The source list still contains the old ping-time layout and project-host latency report. This was handled in the 2026-06-08 beta plan as `P2-D`; do not create a duplicate task unless a new regression is reported.

