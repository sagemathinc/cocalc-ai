# Release Blocker Triage, 2026-05-29

Overall status: `active`

Source list: `/home/user/scratch/wstein.md`.

Purpose: track the current unsolved pre-release blocker queue in one repo-visible place. Some items are bugs; others are product, architecture, operational readiness, abuse prevention, or UX hardening work. Treat this as the active queue and update statuses as items are fixed, deferred, or split into dedicated plans.

Status values:

- `open`: not started or only loosely investigated.
- `active`: currently being investigated or implemented.
- `blocked`: needs an external decision, account, vendor, legal text, or production data.
- `done`: implemented, validated, and no longer release-blocking.
- `defer`: intentionally not required for first public release.
- `closed`: the overall triage document is complete and no longer active.

## Current Release Read, 2026-05-30

The original blocker list is no longer primarily a bug queue. Most concrete
bugs found in the first triage pass are fixed. The remaining release risk is
mostly operational readiness and configuration UX:

- fresh-site setup has a known-good path but too many wrong turns,
- membership tier configuration is still too confusing for safe production use,
- project-host software upgrade controls are too CLI-dependent,
- invite/access flows need manual validation,
- and admin activity/search correctness still matters for support and abuse
  response.

The best next investment is the first-run site setup checklist/wizard described
in `src/.agents/site-setup-checklist-wizard-plan-2026-05-30.md`. It captures the
validated Launchpad/Rocket setup path and should prevent many of the deployment
mistakes discovered during dogfood.

## Active Release Queue

1. Implement the site setup checklist/wizard V1.
2. Clean up membership tier editor/configuration enough for safe admin use.
3. Restore project-host artifact upgrade controls in the host UI.
4. Manually validate project invite/access-request flows and close or fix them.
5. Fix admin user search "Active never" for known active users.
6. Reproduce the browser resume retry storm; fix if still reproducible, or split
   it into a bounded follow-up with telemetry/guards.

## Deferred Or Not Required For First Public Release

These are important, but should not block the next release unless scope changes:

- CPU usage accounting and abuse enforcement.
- Self-hosted Launchpad without Cloudflare or GCP.
- Cross-region project move polish, unless cross-region moves are explicitly
  part of the next release promise.
- Project-host daemon upgrade UX polish.

## Track A: Deployment And Launchpad Readiness

### 1. Deploy New Dogfood Site

Status: `done`

Severity: high.

Why it matters: a fresh dogfood deployment is the fastest way to expose real deployment friction, multibay assumptions, and operational gaps before public release.

Known requirement:

- Fresh dogfood site deployed from scratch.
- Systemd-based Rocket deployment path exercised.
- Project-host creation, provider setup, rootfs publishing, and project startup
  tested end to end.
- Track all setup steps and friction from start to finish.
- Reduce deployment friction discovered during the process.

Expected outcome:

- A working dogfood site with project hosts.
- A reproducible deployment checklist.
- Bugs and manual steps discovered during deployment are either fixed or tracked separately.
- Operators can repeat the deployment without relying on hidden local knowledge.

Next action:

- Treat this item as complete for the original release-blocker triage.
- Continue follow-up work under
  `src/.agents/site-setup-checklist-wizard-plan-2026-05-30.md`.
- Use the next fresh multibay deployment to validate the setup wizard/checklist
  model rather than expanding this item.

### 2. Launchpad SEA Startup Crash

Status: `done`

Severity: critical.

Why it matters: Launchpad SEA currently fails at startup, so the self-contained distribution path is broken.

Known symptom:

- Running `cocalc-launchpad-1.0.2-x86_64-linux` unpacks assets, prints config, then crashes inside bundled `@electric-sql/pglite`.
- Error is `current transaction is aborted, commands ignored until end of transaction block`.
- The failing query is creating `site_license_domain_locks`.
- This may be fallout from security or site-license changes.

Expected outcome:

- Launchpad SEA starts from a clean install.
- Existing local launchpad data either migrates cleanly or fails with an actionable repair message.
- Site license database migrations are idempotent and do not poison the transaction after one failure.
- SEA startup has a focused regression test or packaging smoke test.

Next action:

- Reproduce with the built SEA artifact and a fresh `data_dir`.
- Reproduce with the existing failing `data_dir` if available.
- Inspect launchpad database migration/bootstrap code around `site_license_domain_locks`.
- Fix transaction handling so one migration failure does not cascade into opaque PGlite errors.

### 3. Self-Hosted Launchpad Without Cloudflare Or GCP

Status: `defer`

Severity: high.

Why it matters: self-hosted Launchpad may have regressed during recent security hardening, especially outside the current Cloudflare/GCP assumptions.

Deferral note:

- The current validated dogfood path intentionally depends on Cloudflare and
  hosted cloud project hosts.
- This remains important for self-hosted product quality, but should not block
  the next release while the Cloudflare/GCP/Nebius path is the supported path.

Known requirement:

- Test self-hosted Launchpad on a local VM with SSH.
- Do not rely on Cloudflare or GCP.
- Fix fallout from not exercising this path recently.

Expected outcome:

- A documented local-VM Launchpad smoke test.
- Launchpad can run self-hosted without Cloudflare/GCP-specific assumptions.
- Any required network, SSH, auth, and certificate setup is explicit.

Next action:

- Keep as a post-release/self-hosted validation track.
- Revisit after the site setup checklist/wizard makes the primary setup path
  reliable.

## Track B: Project Hosts, Runtime, And Cross-Region Operations

### 4. Project Move Between Regions Is Still Bad

Status: `defer`

Severity: high.

Why it matters: cross-region project moves are a core multibay/project-host workflow. They currently work only after confusing failures and manual recovery, which is not release quality.

Deferral note:

- This is not required for the next release unless cross-region project moves
  are explicitly part of the release/demo promise.
- Fresh multibay deployment should still exercise ordinary bay/host placement,
  but this item should not compete with setup wizard and membership-tier work.

Known symptoms:

- Moving projects between regions is described as "totally horrible" while technically working.
- Prior testing showed confusing flicker, transient permission errors, failed first attempts, and projects needing restart after move.
- It is unclear whether this needs polish or a deeper redesign.

Expected outcome:

- Cross-region project move has a predictable state model and user-visible progress.
- Permission state converges without requiring hard refresh or manual restart.
- Failed moves are recoverable and explain the next safe action.
- The UI does not claim success before the destination project is usable.

Next action:

- Keep as a follow-up multibay UX/reliability track.
- Reopen as active only if the next release requires cross-region project moves.

### 5. Restore Project-Host Artifact Upgrade Controls

Status: `open`

Severity: high.

Why it matters: admins currently cannot upgrade project-host software artifacts from the UI, which makes production operations brittle and CLI-dependent.

Known symptom:

- CLI command works, e.g. `cocalc host upgrade spot-utah --artifact tools --hub-source --wait`.
- The UI previously exposed upgrade controls, but simplification removed them.

Expected outcome:

- Host runtime/control UI exposes artifact lifecycle controls.
- Admin can select available versions for:
  - tools
  - project bundle
  - project-host
- Choices are sorted newest-first and limited to a useful recent history.
- UI clearly distinguishes making an artifact available versus promoting it as default.

Next action:

- Locate current host runtime "Software lifecycle detail" cards.
- Identify backend/API calls already used by the CLI.
- Add minimal dropdown controls with safe confirmation and status feedback.

### 6. Project-Host Daemon Upgrade UX

Status: `defer`

Severity: medium-high.

Why it matters: project-host daemon upgrades are not necessarily smooth. Users on affected projects need realistic expectations when host software is changing.

Deferral note:

- Useful polish, but less important than restoring admin artifact controls and
  making first-run setup deterministic.
- Keep as a follow-up once upgrade controls are back in the UI.

Known concern:

- Current UI may imply daemon upgrades are seamless.
- Users may see instability without context when a daemon changes versions.

Expected outcome:

- Host UI communicates that daemon upgrades can affect active projects.
- Projects running on a host with an active daemon upgrade show an indicator or banner.
- The messaging is accurate without creating unnecessary alarm.

Next action:

- Revisit after project-host artifact upgrade controls are restored.
- Use the restored upgrade state as the source for any project-visible banner.

## Track C: Browser, Reconnect, And Collaboration Reliability

### 7. Browser Resume Retry Storm And Stuck Documents

Status: `open`

Severity: high.

Why it matters: after laptop suspend/resume, documents and chats can become unusable until refresh. A retry storm showing millions of sent messages suggests a serious reconnect/backpressure bug.

Release read:

- This is the most bug-shaped remaining item.
- It should be fixed if still reproducible. If it cannot be reproduced quickly,
  split out bounded retry/telemetry guard work and do not let it block setup and
  membership configuration work.

Known symptoms:

- After laptop resume, documents did not work.
- UI showed approximately 2 million sent messages.
- Chats are often stuck loading after resume.
- Browser refresh fixes the issue.
- Terminals to projects still worked.

Expected outcome:

- Browser resume does not create unbounded send/retry accumulation.
- Documents and chats reconnect or fail into a clear recoverable state.
- Retry counters and queues are bounded.
- Refresh is not required for normal resume recovery.

Next action:

- Reproduce with controlled suspend/offline simulation.
- Inspect Conat/browser-session reconnect queues and retry accounting.
- Add guards against unbounded retry accumulation.
- Add telemetry/logging for reconnect queue growth.

### 8. Chat Typing Indicator Uses Wrong Thread Title

Status: `done`

Severity: medium.

Why it matters: typing indicators are collaborative context. Showing the wrong thread title makes chat feel inconsistent and can mislead users in multi-thread chatrooms.

Known symptom:

- In human chat with two users, when user X starts typing, the other user sees "X is ..." with the wrong thread title.
- Suspected fallout from chat data structure changes and stale title lookup logic.

Expected outcome:

- Typing indicators resolve the current thread title using the current chat thread data model.
- Cross-user typing state is scoped to the correct thread.
- No stale or fallback thread titles are shown.

Next action:

- Reproduce with two browser sessions and two human chat threads.
- Locate typing indicator state and title resolution.
- Update title lookup to use the current thread identity.

### 9. Chat TimeTravel Crash

Status: `done`

Severity: critical.

Why it matters: opening TimeTravel from chat can permanently crash the chatroom until state is cleared or code is fixed. This is a high-impact release blocker.

Known symptom:

- Open any chatroom.
- Click TimeTravel and navigate around.
- Chatroom crashes.
- Browser refresh immediately crashes again.
- Stack includes `chat-log.tsx:1070`, where code does `virtuosoRef.current?.scrollToIndex({ index: Number.MAX_SAFE_INTEGER })`.
- Error is `Cannot read properties of undefined (reading 'current')`.

Expected outcome:

- Chat TimeTravel can be opened and navigated without crashing.
- Chatroom refresh after TimeTravel state is safe.
- Scroll-to-bottom logic tolerates absent or unmounted Virtuoso refs.
- Regression test covers TimeTravel mode or missing Virtuoso ref.

Next action:

- Reproduce locally in a chatroom.
- Inspect `chat-log.tsx` around the failing effect and TimeTravel render path.
- Guard ref usage and ensure TimeTravel state does not reuse live-chat scroll effects incorrectly.

## Track D: Jupyter, Slate, Files, And Generated Media

### 10. Jupyter Agent Cell Move Duplicates Content

Status: `done`

Severity: high.

Why it matters: agent-driven notebook editing must be trustworthy. A correct CLI cell move that doubles content feels data-corrupting and undermines confidence.

Known symptom:

- Agent used the CoCalc CLI to move a Jupyter cell.
- Resulting notebook showed duplicated content/cells.
- Live notebook state is the source of truth for this workflow.

Expected outcome:

- Programmatic cell move mutates the live notebook exactly once.
- Browser/live state and saved notebook do not diverge or replay the move twice.
- Notebook CLI/API examples are safe for agents.

Next action:

- Reproduce using `cocalc project jupyter exec` against a test notebook.
- Inspect notebook mutation API behavior for move operations.
- Determine whether duplication comes from API semantics, sync replay, or agent script misuse.
- Add a regression test or documented safe recipe.

### 11. Imagegen Generated Images Too Large In Chat

Status: `done`

Severity: low-medium.

Why it matters: generated images currently dominate chat messages and make results harder to scan.

Known symptom:

- Imagegen2 generated image output renders at `max-width: 100%`.
- Desired CSS is `max-width: 50%; max-height: 100%; object-fit: contain; width: 1254px;`.

Expected outcome:

- Generated image output in chat is capped to a more reasonable default width.
- Images remain clickable/viewable at full size where appropriate.

Next action:

- Locate the "Generated image" chat rendering component/CSS.
- Change max width from 100% to 50%.
- Add a focused visual/CSS regression if practical.

### 12. Slate Gap Cursor Missing After Trailing Code Block

Status: `done`

Severity: medium.

Why it matters: users can get stuck inside a fenced code block at the bottom of Slate content, which makes editing feel broken.

Known symptom:

- Open a Slate editor that is not in block mode, e.g. a task.
- Put a fenced code block at the bottom.
- Cursor cannot move below the code block.
- Editing the code block causes the gap cursor to appear.

Expected outcome:

- A gap cursor or equivalent insertion affordance is available below a trailing fenced code block immediately.
- Existing Slate code block behavior is preserved.

Next action:

- Reproduce in task Slate editor.
- Inspect gap cursor plugin/render logic around trailing void/code blocks.
- Ensure document normalization or decoration creates the after-block insertion target.

## Track E: Access, Invites, Accounts, And Admin

### 13. Improve Project Invite And Access Request Flow

Status: `open`

Severity: high.

Why it matters: project invite and access upgrade flows are common first-run collaboration paths. Broken project pages for invited users create a poor onboarding experience.

Current read:

- Implementation is believed to be mostly done.
- This remains open because it has not been manually validated end to end.
- If manual testing passes, mark this item `done` without expanding scope.

Known requirements:

- If a user visits a project they were invited to, they should be able to accept the invite directly there.
- If a user is not invited but visits a project URL, they should be able to request to join.
- If a user is a project viewer, they should be able to request full collaborator access.
- The "Read only" tag should become a clear clickable affordance explaining read-only mode and offering "request collaborator access".
- Request collaborator access could also be in the side-rail flyout menu.

Expected outcome:

- Project URL access page handles invited, not-invited, and viewer states explicitly.
- Invite acceptance does not require hunting through email or another page.
- Access requests notify project owners/admins through a clear channel.
- Open a project URL into a project that the user is NOT a collaborator or viewer of doesn't feel broken - instead of provides a clear statement that of the user's relationship to the project (none), and the option to request an invitation for collab or viewer access.   The UI _is_ allowed to show:
  - title of the project
  - name of the project owner
  Showing that will require probably a specific RPC.  It should not show the description, other collab viewer names, or any email addresses. 

Next action:

- Manually test invited-user accept flow from a project URL.
- Manually test not-invited access request from a project URL.
- Manually test viewer requesting collaborator access.
- Mark done if those paths work; file focused bugs only for failures.

### 14. CPU Usage Accounting And Abuse Detection

Status: `defer`

Severity: high.

Why it matters: free tier, free trials, and unblocked egress create real abuse risk. CPU accounting is needed both for enforcement and for detecting mining/password-cracking behavior.

Deferral note:

- This is important for abuse hardening, but it is a larger accounting and
  enforcement project.
- It should not block the next release if provider setup, membership tiers, and
  operational admin paths are otherwise sane.

Known requirements:

- Track total CPU usage over time.
- Membership tiers can define max CPU usage per 5 hours and per 7 days.
- Global usage limits are preferred over per-project if practical.
- Admin dashboard lists top CPU users.
- Admins can tag users as known-good with reason/vouch context.
- Paying customers can have high limits; free users likely need stricter limits.

Expected outcome:

- CPU usage is measured and stored per account/project over useful windows.
- Membership tiers can define CPU usage limits.
- Abuse dashboard highlights heavy CPU users.
- Enforcement or throttling behavior is clear and safe.

Next action:

- Split into a dedicated abuse/accounting plan before implementation.
- Start with admin visibility before hard enforcement when this is resumed.

### 15. Membership Tier Editor Cleanup

Status: `open`

Severity: high.

Why it matters: membership tiers define billing, quotas, and system protection. A confusing or wrong editor risks bad pricing, bad limits, and support issues.

Known symptoms:

- Current tier editor is a confusing mess.
- Many parameters are exposed incorrectly or unclearly.
- There is no cost guidance for maximum or expected cost per user.

Expected outcome:

- Tier parameters are grouped and named according to how they affect users and costs.
- Each parameter has clear help text and validation.
- Editor shows cost estimates for maximum possible user cost and expected cost.
- Throttling and quota parameters are understandable.

Next action:

- Inventory membership tier schema fields.
- Classify fields into billing, storage, compute, limits, marketing, and internal controls.
- Redesign editor sections and add estimated-cost calculations.

### 16. Admin User Search Shows Active Never For Active Users

Status: `open`

Severity: medium-high.

Why it matters: admin search is used for support, abuse triage, and operational debugging. Incorrect activity status wastes operator time.

Known symptoms:

- Admin search shows "Active never" for active users.
- A prior fix improved this but did not fix it on `alpha.cocalc.ai`.
- Better long-term UI would show a 30-day active-days grid similar to project host reliability visualization.

Expected outcome:

- Admin user search accurately reports recent user activity.
- If feasible, admin user rows include a compact recent-activity visualization.
- Activity data source is consistent with actual browser/project usage.

Next action:

- Reproduce on alpha with a known active account.
- Compare `last_active` source with actual account/session activity tables.
- Fix the immediate incorrect "Active never" display before adding the 30-day grid.

### 17. Project Creation Modal Auto-Popup

Status: `done`

Severity: medium.

Why it matters: automatically popping the project creation modal used to make sense, but now conflicts with email verification and a more deliberate onboarding flow.

Known symptom:

- Project creation modal pops up often, e.g. when a user has no projects.
- The explicit "create project" button is already clear and prominent.

Expected outcome:

- The project creation modal only opens when the user explicitly clicks the button or follows an explicit create-project action.
- First-run project page remains understandable without forced modal display.

Next action:

- Locate auto-popup logic for empty project lists.
- Delete or disable it.
- Verify first-run page and email verification flow still guide users clearly.

### 18. User Favicon Shows Question Mark Until Profile Opens

Status: `done`

Severity: low-medium.

Why it matters: account identity should initialize correctly on first load. A question-mark favicon/avatar until profile open feels broken.

Known symptom:

- On first load, user favicon/avatar appears as `?`.
- Opening the user's profile causes the correct identity icon to appear.

Expected outcome:

- User favicon/avatar data is loaded during normal account initialization.
- Opening profile is not required to populate the favicon/avatar.

Next action:

- Reproduce from a fresh browser session.
- Compare account/user profile data loaded at app start versus profile page load.
- Move required favicon/avatar data into initial account query or lazy-load it where the favicon renders.

## Closure Criteria

- All active release-queue items are `done` or explicitly split into dedicated
  implementation plans.
- Deferred items are not required for the next release and have a clear reason
  for deferral.
- Fresh-site setup is tracked under
  `src/.agents/site-setup-checklist-wizard-plan-2026-05-30.md`.
- No item remains `open`, `active`, or `blocked` without an explicit next
  action.

## Update Log

- 2026-05-29: Initial triage created from `/home/user/scratch/wstein.md`.
- 2026-05-30: Reclassified the queue after the successful dogfood Rocket setup.
  Most concrete bugs are done; remaining active work is setup wizard,
  membership configuration, host software controls, invite/access validation,
  admin activity correctness, and browser resume verification. CPU accounting,
  self-hosted no-Cloudflare Launchpad, cross-region move polish, and daemon
  upgrade messaging are deferred from the next release unless scope changes.
