# Release Blocker Triage, 2026-05-24

Source list: `/home/user/scratch/wstein.md`.

Purpose: track the known pre-release blocker queue in one repo-visible place. Some items are bugs; others are product, architecture, or operational readiness work. Treat this as the working queue and update statuses as items are fixed, deferred, or split into dedicated plans.

Status values:

- `open`: not started or only loosely investigated.
- `active`: currently being investigated or implemented.
- `blocked`: needs an external decision, account, vendor, legal text, or production data.
- `done`: implemented, validated, and no longer release-blocking.
- `defer`: intentionally not required for first public release.

## Executive Priority

1. Project-host access and random assignment fallback.
2. GPU host validation for Nebius H200.
3. Project-host restart recovery for previously running projects.
4. Official project startup script support.
5. RootFS rustic repo sharding decision.
6. Standalone backup-all-projects host LRO.
7. Flyout file explorer LRO visibility.
8. RootFS scan detail links.
9. Membership tier benefit explanations.
10. Subscription free trial.
11. Account creation terms-of-service link.
12. Scheduled automation notification config.
13. Spot uptime dashboard and recovery banner.
14. Host runtime control page redesign.
15. Git browser sticky file path click behavior.
16. Terminal reconnect flash.
17. Codex file watch / TimeTravel load policy.

## Track A: Host Safety And Reliability

### 1. Project-Host Access And Random Assignment Fallback

Status: `done`

Severity: high.

Why it matters: host assignment is a security, cost, and correctness boundary. Users should not be placed onto public hosts they cannot see or are not entitled to use.

Known symptoms:

- Public host access policy now has admin-only settings on the host Access page.
- Policy includes shared-pool membership tier number and explanatory copy.
- Host list/card rows summarize whether the host is private/delegated or in the shared pool.
- Users previously could fail host visibility checks but still get assigned to hosts randomly due to a fallback. Backend fallback was fixed by making automatic start/move placement account-aware and safe-by-default without account context.

Expected outcome:

- Host eligibility is explicit and enforced in the allocator.
- Host visibility and host eligibility are consistent.
- Admin-only or tier-restricted hosts cannot be silently selected for ineligible users.
- The UI exposes the relevant public-host access policy.

Next action:

- Keep any future hard per-host/project public-pool limits as a follow-up under host runtime/access policy, not a release blocker for this item.
- Preserve regression coverage around fallback placement eligibility and admin-only public pool access when changing the host placement UI/API.

### 2. GPU Host Validation For Nebius H200

Status: `open`

Severity: high.

Why it matters: GPU hosts are expensive and user-visible. If `nvidia-smi` works but PyTorch/TensorFlow cannot see the GPU, the product offering is effectively broken.

Known symptoms:

- Creating a Nebius spot GPU host could submit a stale hidden GCP provider
  value, so the backend rejected the request with
  `host_pricing_unavailable` for provider `gcp` even while the browser showed
  a valid Nebius price. Fixed by submitting from the canonical normalized
  create draft instead of raw form values.
- `nvidia-smi` works.
- `pip install` of TensorFlow and PyTorch does not result in GPU-visible frameworks.
- Backup to R2 is slow, around 30-50 MB/s.
- Disk may also be slow.

Expected outcome:

- A repeatable GPU validation script or checklist.
- Clear image/runtime fix if CUDA userland libraries are missing or mismatched.
- Baseline disk and backup throughput numbers for this host class.

Next action:

- Reproduce on the target Nebius H200 host.
- Capture `nvidia-smi`, CUDA library paths, PyTorch CUDA diagnostics, TensorFlow GPU diagnostics, disk benchmark, and R2 upload benchmark.
- Decide whether this is an image issue, package install issue, runtime mount issue, or provider performance issue.

### 3. Project-Host Restart Recovery

Status: `open`

Severity: high.

Why it matters: host restarts should converge toward intended state. Previously running projects should come back without manual intervention, but not all at once.

Known requirement:

- When a project host restarts, projects that were running should automatically start again.
- Highest priority projects should start first.
- Starts must be throttled to avoid breaking the host after a restart.

Expected outcome:

- Persistent "should be running" or equivalent desired-state signal.
- Restart recovery worker that starts projects gradually.
- Priority ordering and rate limits.
- Tests covering restart reconciliation and no-thundering-herd behavior.

Next action:

- Trace current project runtime state persistence.
- Determine whether desired state already exists or must be introduced.
- Design a rate-limited host startup reconciliation loop.

### 4. Official Project Startup Script Support

Status: `done`

Severity: medium-high.

Why it matters: project restart recovery is more useful when users have a clear, documented place for idempotent startup setup.

Known code:

- `src/packages/project-runner/run/podman.ts`
- `src/packages/project-runner/run/startup-scripts.ts`
- `src/packages/frontend/project/settings/environment-overview.tsx`
- `docs/project-startup-script.md`

Known requirement:

- Canonical path is `~/.local/share/cocalc/startup.sh`.
- Logs are `~/.local/share/cocalc/startup.log` and `~/.local/share/cocalc/startup.err`.
- Project settings exposes the script and log files from Environment.
- Runtime creates a commented no-op template without overwriting user edits.

Expected outcome:

- A documented startup script path. Done in `docs/project-startup-script.md`.
- Project settings UI affordance to view/edit the startup script. Done.

Next action:

- Optional follow-up only: evaluate whether cron support is worth adding separately.

### 5. Standalone Backup-All-Projects Host LRO

Status: `open`

Severity: medium-high.

Why it matters: final host backups are currently embedded in stop/deprovision/drain flows. Operators need an explicit host action for backing up all projects.

Known requirement:

- Implement backup all projects on a host as a standalone LRO.
- Add a button only after backend/API action exists.

Expected outcome:

- Host-level backend/API action.
- LRO with progress and per-project error reporting.
- UI button wired to that LRO.

Next action:

- Locate stop/deprovision/drain backup logic.
- Extract or reuse a standalone host backup orchestration path.

### 6. Spot Uptime Dashboard And Recovery Banner

Status: `open`

Severity: medium.

Why it matters: users need visibility into spot reliability before choosing placement, and actionable context when a host is off or recovering.

Known requirement:

- Uptime dashboard for spot instances.
- Banner should show uptime history and options for more stable hosting.

Expected outcome:

- Host uptime history data source.
- UI surface in host selection and recovery banner.
- Clear upsell or migration path to stable hosting.

Next action:

- Identify existing host uptime/health data.
- Decide minimal first version: recent uptime percent and outage/recovery timestamps.

### 7. Host Runtime Control Page Redesign

Status: `open`

Severity: medium.

Why it matters: the runtime control page is powerful but cluttered and confusing, especially for host component upgrades.

Expected outcome:

- Clear primary actions.
- Separated diagnostic details from routine controls.
- Safer upgrade affordances with status and rollback context.

Next action:

- Defer until host access, allocation, and recovery semantics are correct.
- Then produce a focused UI redesign plan with screenshots.

## Track B: Storage, Backups, And RootFS

### 8. RootFS Rustic Repo Sharding Decision

Status: `open`

Severity: high.

Why it matters: if rootfs rustic repositories need sharding, the least painful time is before first public release.

Known concern:

- Repositories might become slow at scale.
- Sharding later could be operationally painful.

Expected outcome:

- Explicit decision: ship current layout with monitoring, or introduce shard layout now.
- Documented thresholds and migration plan if not sharding immediately.

Next action:

- Read existing `src/.agents/project-backup-rustic-r2-sharding-v1-2026-05-05.md` and benchmark notes.
- Estimate expected first-release scale.
- Decide whether to implement now or monitor.

### 9. RootFS Scan Details Link

Status: `open`

Severity: medium.

Why it matters: scan data exists but users get almost no details, which makes scanning feel opaque and frustrating.

Expected outcome:

- Provide link to detailed scan output.
- Details can be placed in the project.
- UI should make it clear where to inspect scanner findings.

Next action:

- Trace rootfs scanning output storage.
- Add a UI link to the existing detail artifact.

### 10. Codex File Watch / TimeTravel Load Policy

Status: `open`

Severity: medium.

Why it matters: Codex reading/writing files may cause file watching and TimeTravel load that is expensive and rarely useful.

Known concern:

- Potentially large load and complexity.
- The feature may not provide enough user value for default-on behavior.

Expected outcome:

- Measure or estimate load.
- Add a kill switch or config before removing behavior.
- Decide default policy for release.

Next action:

- Find the code path where Codex file IO triggers file watching/TimeTravel.
- Add instrumentation or a feature flag if no safe switch exists.

## Track C: Product And Legal Release Gates

### 11. Membership Tier Benefit Explanations

Status: `open`

Severity: high.

Why it matters: users cannot reasonably buy a membership tier if the UI only shows the tier name and price. This is a release blocker for paid launch because it affects trust, conversion, and support burden.

Known symptoms:

- Tier purchase/selection surfaces show the membership tier name and cost but not what the tier provides.
- This appears in several places, so fixing only one modal is not enough.

Expected outcome:

- Every user-facing membership purchase, upgrade, and tier-selection surface explains the tier benefits in plain language.
- Benefit copy is sourced from a shared definition, not duplicated across unrelated components.
- The UI distinguishes benefits, limits, and billing terms.
- Existing tier name and price display remains concise but is no longer the only information.

Next action:

- Find all membership tier purchase/selection surfaces.
- Identify the canonical tier-definition source.
- Add shared benefit metadata and render it consistently in the purchase UI.
- Include focused tests or snapshots for the core purchase surface.

### 12. Subscription Free Trial

Status: `open`

Severity: high if pricing launch depends on it; otherwise medium.

Why it matters: free trials may be required for subscription tier adoption.

Expected outcome:

- Trial policy defined.
- Billing implementation supports trial creation, expiration, conversion, and abuse controls.
- UI explains trial state clearly.

Next action:

- Define trial duration, eligibility, payment-method requirement, and abuse limits before implementation.

### 13. Terms Of Service Link On Account Creation

Status: `blocked`

Severity: medium.

Known issue:

- GitHub issue: https://github.com/sagemathinc/cocalc-ai/issues/13

Blocker:

- Requires terms of service text or canonical URL.

Expected outcome:

- Account creation page links to ToS once ToS exists.

Next action:

- Once ToS URL exists, add link to account creation page and any relevant sign-up copy.

## Track D: Chat, Codex, And Automation UX

### 14. Scheduled Automation Notification Config

Status: `open`

Severity: medium.

Why it matters: scheduled automations currently cannot be configured to produce notifications from the schedule config.

Expected outcome:

- Automation schedule config includes notification preference.
- Scheduled runs can notify when configured.
- Default should avoid notification spam.

Next action:

- Inspect automation config type and schedule UI.
- Add notification field, persistence, and delivery behavior.

### 15. Git Browser Sticky File Path Click Behavior

Status: `open`

Severity: low-medium.

Why it matters: clicking the sticky file path currently opens the file, which closes the git browser and is disruptive. Users often click it intending to copy the path.

Expected outcome:

- Clicking sticky file path copies the full path.
- Show notification that path was copied.
- Notification includes an `Open` button.
- Optional explicit open button on the right.

Next action:

- Locate sticky file path component in git browser.
- Change click handler to copy-first behavior.

## Track E: Core UI Workflow Polish

### 16. Flyout File Explorer LRO Visibility

Status: `open`

Severity: medium-high.

Why it matters: users can trigger long-running file operations from the flyout and see no feedback, while the full explorer does show LROs.

Known symptom:

- Flyout file explorer does not show file LROs.
- Full page explorer does.

Expected outcome:

- Flyout and full explorer show consistent LRO feedback.
- Backup and other file operations started from flyout have visible progress.

Next action:

- Compare full explorer and flyout explorer wrappers.
- Reuse the same LRO/status component in the flyout.

### 17. Terminal Reconnect Flash

Status: `open`

Severity: medium.

Why it matters: terminal often has full content, then briefly shows a Connecting screen, then returns to the same content. This is visually disruptive.

Expected outcome:

- Intermittent reconnect dims existing terminal content instead of blanking it.
- Keystrokes can be buffered or accepted where safe.
- If the new connected session is the same, preserve screen content without flashing.

Next action:

- Reproduce with controlled disconnect.
- Determine whether terminal session identity can be compared before replacing visible content.

## Recommended Work Order

1. Fix project-host access and assignment fallback.
2. Validate/fix Nebius H200 GPU image/runtime.
3. Implement project-host restart recovery.
4. Formalize project startup script support.
5. Decide RootFS rustic sharding.
6. Implement backup-all-projects host LRO.
7. Fix flyout file explorer LRO visibility.
8. Add RootFS scan detail links.
9. Add membership tier benefit explanations everywhere tiers can be selected or purchased.
10. Implement subscription free trial if product launch requires it.
11. Add ToS link after legal URL exists.
12. Add scheduled automation notification config.
13. Add spot uptime dashboard/recovery banner.
14. Redesign host runtime control page.
15. Polish git browser sticky path behavior.
16. Improve terminal reconnect behavior.
17. Decide Codex file watch / TimeTravel load policy.

## Update Log

- 2026-05-24: Initial triage created from `/home/user/scratch/wstein.md`.
- 2026-05-24: Added membership tier benefit explanations as a high-severity product release blocker.
