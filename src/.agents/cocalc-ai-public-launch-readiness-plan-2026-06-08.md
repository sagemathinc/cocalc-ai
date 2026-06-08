# CoCalc.ai Public Launch Readiness Plan, 2026-06-08

Status: active release-preparedness plan.

Target: soft public launch of `https://cocalc.ai` before the UCLA class usage
deadline on 2026-06-20, followed by broader user migration from `cocalc.com` in
late July / early August.

This plan is intentionally separate from the visible bug-burn list. Known
frontend/user-flow bugs should continue to be fixed in the bug-burn track. This
document focuses on launch safety: release channels, operational guardrails,
abuse controls, monitoring, rollback, and codebase audit scope.

## Launch Posture

Initial hosted deployment:

- Single-bay Rocket deployment.
- GCP `us-south1-a` or equivalent, similar to the `delta.cocalc.ai` deployment.
- Start with a non-spot VM, likely around `t2d-standard-8`.
- Use a fast network SSD disk.
- Add CPU project hosts in the US, Europe, and possibly Asia.
- Allow users to add dedicated hosts.
- Defer true multi-bay production until it has had another 1-2 months of
  focused testing and operational hardening.

Initial public-product posture:

- No registration token.
- Payment path is enabled.
- CoCalc Star and CoCalc Plus are available for free initially.
- Launch is soft: no broad announcement until operational confidence is high.
- Any feature that is visible but not ready must be hidden or feature-flagged.

Rationale:

- Single-bay reduces launch risk and preserves debugging simplicity.
- Vertical scaling should be enough for the first public traffic and UCLA class.
- Multi-bay correctness is strategically important, but it is not the right
  first-launch risk unless single-bay capacity is already exhausted.

## Definition Of Release-Ready

The system is release-ready only when all of these are true:

1. Known release-blocking user-visible bugs are fixed or explicitly
   feature-flagged out.
2. New releases do not auto-promote to default before manual validation.
3. Operators can roll forward, roll back, and disable risky entry points.
4. Backups are not just configured; at least one restore drill has succeeded.
5. Abuse and spend controls can stop runaway free usage without a deploy.
6. Monitoring shows whether the system is healthy before users report it.
7. A short, repeatable launch smoke test passes on the exact candidate build.

## Workstreams

### L0: Release Channels And Promotion

Problem:

- Today, "release" effectively means "latest". Publishing an artifact can make
  it immediately usable before it has been manually tested.

Target model:

- Every build remains immutable and addressable by release id.
- Installers and auto-update paths resolve a channel manifest, not "latest".
- Channels:
  - `dev`: optional fast-moving internal channel.
  - `candidate`: newly built release awaiting validation.
  - `stable`: default for public installers and normal users.
- Promotion from `candidate` to `stable` is a small metadata change, not a
  rebuild.
- Users and agents can still pin an explicit release id for debugging.

Products that need the model:

- CoCalc Star installer and local Lima installer.
- CoCalc Plus installer/update path.
- `cocalc-cli` install/update path.
- Hosted `cocalc.ai` deploy scripts.

Implementation sketch:

1. Define a release manifest schema:
   - channel name,
   - product,
   - release id,
   - commit sha,
   - artifact URLs,
   - sha256 values,
   - created timestamp,
   - promoted timestamp,
   - optional known-bad / revoked flag.
2. Publish release artifacts to immutable paths.
3. Publish channel manifests to stable URLs.
4. Make public install commands resolve `stable` by default.
5. Add explicit overrides:
   - `COCALC_RELEASE_CHANNEL=candidate`,
   - `COCALC_STAR_RELEASE=<release-id-or-url>`,
   - product-specific variants where already established.
6. Add a promotion command that updates only the manifest.
7. Add a rollback command that repoints `stable` to the previous known-good
   release.

Exit criteria:

- A release can be built and published to `candidate` without changing the
  default public install path.
- The exact candidate release can be installed and manually tested.
- Promotion to `stable` changes future default installs.
- A known-bad candidate can be revoked without deleting immutable artifacts.

### L1: Hosted Deployment Rollback And Kill Switches

Problem:

- Soft launch can still create sudden traffic or abuse. We need runtime controls
  that do not require a risky emergency deploy.

Required operator controls:

- Disable new account signup.
- Re-enable registration-token-only signup.
- Disable new project creation.
- Disable new free project starts while preserving paid/admin starts.
- Disable new dedicated-host purchases.
- Disable user-added dedicated hosts.
- Disable or restrict Codex/AI usage.
- Disable payment checkout if billing is misbehaving.
- Put the site in a read-mostly maintenance mode.

Implementation rule:

- Prefer admin settings / customize flags that are read dynamically.
- Avoid environment-only controls for emergency response unless systemd restart
  is safe and documented.

Exit criteria:

- Each kill switch has:
  - an admin UI or CLI path,
  - a clear owner,
  - a smoke test,
  - a user-facing failure message that is not a generic 500.

### L2: Backup And Restore Drills

Problem:

- Backups are only trustworthy after a restore has been tested.

Required backups:

- Postgres database.
- R2 buckets used for project backups, rootfs streams, runtime artifacts, and
  release assets.
- Deployment secrets and configuration.
- Caddy/TLS or ingress configuration if relevant.
- Billing/account critical metadata.

Planned operator backup:

- R2 buckets are backed up with `rclone` to encrypted office disks.

Required drills before launch:

1. Restore Postgres backup into a fresh non-production environment.
2. Restore at least one project backup from R2.
3. Restore at least one rootfs/image artifact.
4. Verify that release artifacts required for rollback are mirrored or
   recoverable.
5. Document the maximum expected data loss window.

Exit criteria:

- A written restore runbook exists.
- At least one end-to-end restore has succeeded using the runbook.
- The restore process does not require undocumented personal memory.

### L3: Monitoring And Alerting

Status: missing functionality / high-priority launch gap.

Problem:

- The system can appear healthy from the outside while control-plane queues,
  project starts, websocket reconnects, or billing paths are already failing.

Minimum launch dashboard:

- Hub process:
  - CPU,
  - memory,
  - event-loop lag,
  - request/RPC error rate,
  - websocket connection count,
  - websocket reconnect/disconnect rate.
- Postgres:
  - connection count,
  - slow queries,
  - lock waits,
  - transaction age,
  - database size,
  - replication/backup status if applicable.
- Project lifecycle:
  - project starts requested,
  - starts succeeded,
  - starts failed,
  - start duration percentiles,
  - stop duration percentiles,
  - running projects per host,
  - queued/starting projects per host.
- Project hosts:
  - online/offline status,
  - host pressure,
  - disk free,
  - memory pressure,
  - failed runtime reconcile,
  - project-host daemon restarts.
- Storage/backups:
  - R2 request failures,
  - rustic backup failures,
  - latest successful backup age,
  - snapshot/rootfs publish failures.
- Billing/payment:
  - checkout failures,
  - webhook failures,
  - purchase-session reconciliation failures,
  - spend-limit stops.
- Abuse:
  - signup rate,
  - project creation rate,
  - project start rate,
  - failed login rate,
  - AI/Codex request rate,
  - per-IP/account throttling events.

Minimum alerting:

- Hub process restart loop.
- Postgres unavailable.
- Project starts failing above threshold.
- No successful project backup in expected window.
- Billing webhook failures.
- R2 failures above threshold.
- Disk space below threshold on control plane or project hosts.
- Abnormal signup or project-create spike.

Implementation plan:

1. Inventory existing metrics/logging endpoints.
2. Add missing structured logs for the dashboard counters above.
3. Add a simple operator health page or CLI command for launch:
   - current bay health,
   - host health,
   - queue/backlog summary,
   - failed starts,
   - backup freshness.
4. Add Prometheus/OpenTelemetry-style export if already aligned with the
   deployment stack; otherwise start with a pragmatic internal health endpoint
   plus log-based dashboards.
5. Add synthetic probes:
   - sign in,
   - create project,
   - start project,
   - create file,
   - open terminal,
   - run trivial Jupyter cell,
   - stop project.

Exit criteria:

- An operator can answer "is the site healthy?" from a dashboard in under one
  minute.
- Project-start failures and websocket reconnect storms are visible without
  browser console access.
- Backup freshness is visible.

### L4: Abuse And Spend Controls

Problem:

- Public signup plus free Star/Plus plus hosted compute can attract both normal
  growth and abuse.

Required controls:

- Email verification for normal accounts.
- Per-IP and per-account signup throttles.
- Per-account project creation limits.
- Per-account running/starting project limits.
- Per-account AI/Codex limits.
- Per-host and global admission limits.
- Owner spend limits for dedicated hosts.
- Admin-visible abuse audit trail for:
  - account creation,
  - project creation,
  - project starts,
  - payment attempts,
  - invite/token use,
  - suspicious failures.

Launch defaults:

- Conservative free limits.
- Paid users can get higher limits, but not unlimited.
- Admins can raise limits manually.
- Dedicated-host owners can restrict their own hosts.

Exit criteria:

- A brand-new free account cannot create unbounded projects or starts.
- A bot cannot create unlimited accounts from one IP without hitting a throttle.
- A sudden traffic spike has a documented operator response.

### L5: User Flow Smoke Matrix

This track overlaps with the separate visible bug-burn effort, but the launch
gate needs a short stable smoke matrix.

Required user flows:

1. Signed-out landing page to signup.
2. Email verification or configured signup flow.
3. First project creation.
4. Project start/open convergence.
5. File create/edit/save/reopen.
6. Directory create/rename/delete.
7. Terminal open, command execution, reconnect.
8. Jupyter notebook create, kernel start, execute cell.
9. Chat/Codex authentication and one successful turn.
10. Invite collaborator by link or email.
11. Payment checkout for a small purchase.
12. Project stop/start cycle.
13. Snapshot/backup visibility and one restore/copy path.
14. Admin host view: host health, runtime control, project list.
15. Dedicated host add/remove or explicitly feature-flagged out.

Exit criteria:

- The smoke matrix passes on `candidate`.
- The same candidate is promoted to `stable`.
- Any skipped item has an explicit feature flag or release-scope decision.

### L6: Codebase Audit Strategy

Goal:

- Find release-risk surfaces systematically, without trying to read the whole
  monorepo line by line.

Audit passes:

1. Public unauthenticated routes:
   - signup,
   - auth callbacks,
   - public docs,
   - public project/share routes,
   - static assets,
   - API endpoints reachable without auth.
2. Dangerous authenticated RPCs:
   - billing,
   - host lifecycle,
   - project lifecycle,
   - collaborator changes,
   - public sharing,
   - secrets,
   - backups/restores,
   - admin settings.
3. Feature flag inventory:
   - flags that should default off,
   - flags that are dev-only,
   - flags that must be editable in production,
   - visible UI not backed by production-ready functionality.
4. Cost/spend paths:
   - project starts,
   - dedicated-host purchase/edit,
   - shared scratch,
   - AI/Codex service tier,
   - background reconciliation.
5. Data durability:
   - project file sync,
   - snapshots,
   - backups,
   - rootfs images,
   - chat/Codex durable state,
   - database migrations.
6. Multi-bay correctness:
   - ensure single-bay launch does not rely on shortcuts that make later
     multi-bay migration dangerous,
   - keep explicit owner/home/host bay routing where already designed,
   - document accepted single-bay assumptions.

Suggested search inventory:

```sh
rg -n "TODO|FIXME|HACK|temporary|dangerous|public|unauth|fresh.auth|fresh-auth|admin_only|feature.*flag|registration|payment|stripe|checkout|host.*delete|delete.*host|backup|restore|snapshot|secret|viewer|share" src/packages
```

The output should be triaged, not blindly fixed. Each finding becomes one of:

- release blocker,
- fix before launch,
- feature-flag/hide,
- accepted risk with reason,
- post-launch follow-up.

Exit criteria:

- Audit findings are recorded in a scoreboard.
- No `unknown` high-risk public/admin surface remains.

### L7: Load And Capacity Drills

Purpose:

- Establish safe initial limits and avoid discovering obvious overload during
  the UCLA class.

Required drills:

- 10 concurrent users on one host.
- 30 concurrent users on one host.
- Course-style creation/provisioning for 100 students.
- Bulk project starts with throttling.
- One project host intentionally overloaded enough to verify graceful
  admission/queue behavior.
- Hub restart while projects are running.
- Project-host restart while projects are running.

Measurements:

- Time to create projects.
- Time to start projects.
- Browser reconnect behavior.
- Hub CPU/memory/event-loop lag.
- Project-host memory and disk pressure.
- Failure messages shown to users.

Exit criteria:

- Initial free/default limits are based on measured safe capacity.
- Overload shows queue/admission messages, not random broken UI.

### L8: Migration From cocalc.com

This is not required for the first soft launch, but the plan must avoid blocking
late-July migration.

Required before migration:

- Clear migration UX.
- Account identity mapping.
- Project import/export path.
- Billing/subscription transition plan.
- User communication and rollback plan.
- Dry-run migration on internal accounts.

Release decision:

- Do not couple the initial `cocalc.ai` soft launch to full migration.
- Use summer usage to harden the new platform before directing all new signups
  or migrated users there.

## Suggested Execution Order

1. Finish visible bug-burn blockers in parallel.
2. Implement release channels and candidate/stable promotion.
3. Add minimum kill switches.
4. Build the minimum monitoring dashboard/health endpoint.
5. Perform backup restore drill.
6. Run abuse/spend audit and set conservative defaults.
7. Run candidate smoke matrix.
8. Deploy soft launch.
9. Run UCLA class readiness drill.
10. After soft launch, continue multi-bay and migration hardening.

## Immediate Next Actions

1. Create the release-channel manifest and promotion plan for Star/Plus/CLI.
2. Inventory existing admin settings that already function as kill switches.
3. Define the minimum health endpoint/dashboard data model.
4. Schedule one restore drill before public signup opens.
5. Create a release-readiness scoreboard from this plan with statuses.

