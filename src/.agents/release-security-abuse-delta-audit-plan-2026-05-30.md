# Release Security and Abuse Delta Audit Plan

Status: started, 2026-05-30.

This is a changed-surface security and abuse audit for work landed after the
2026-05-11 release security audit. It does not replace the earlier broad pass;
it uses that pass as the baseline and focuses attention on recently changed
authority boundaries, resource-cost paths, and operational tooling.

Baseline references:

- [release-security-abuse-audit-plan-2026-05-11.md](./release-security-abuse-audit-plan-2026-05-11.md)
- [release-security-abuse-scoreboard-2026-05-11.md](./release-security-abuse-scoreboard-2026-05-11.md)
- [security-audit-pass-2026-05-23.md](./security-audit-pass-2026-05-23.md)
- [scalable-architecture.md](./scalable-architecture.md)
- [release-security-abuse-delta-scoreboard-2026-05-30.md](./release-security-abuse-delta-scoreboard-2026-05-30.md)

## Goal

Find release-blocking security and abuse regressions introduced by recent
feature work, especially where a new mode, API, or UI changed who can trigger
expensive or privileged work.

Primary recent surfaces:

1. Project viewer/read-only mode and project-host viewer file services.
2. Viewer-compatible `cocalc-cli` project file commands.
3. Project access request and requester-blocking flow.
4. Shared scratch disk creation, resize, pricing, and host admission controls.
5. Codex app-server fast mode/service-tier plumbing.
6. ACP queued/running state and turn config visibility.
7. Launchpad SEA startup and PGLite transaction behavior.
8. Host upgrade/deploy selection tooling.
9. Notification, email, and project-log additions.
10. Public project URL landing and invite/access-request flows.

## Audit Rules

Every item must converge to one of:

1. a code fix,
2. a focused test or smoke check,
3. a documented accepted residual risk with owner and reason,
4. a specific follow-up issue with severity and reproduction steps.

For each changed surface, record:

- actor identity and auth mechanism,
- authoritative bay or project host for the decision,
- target scope,
- privilege transition or resource consumed,
- rate/usage/admission limit,
- idempotency and retry behavior,
- audit trail or user-visible notification,
- whether project-local code, viewer code, browser code, CLI code, or operator
  tooling can reach it.

Use the multibay control/data-plane rule as a first-pass filter:

- Account decisions route to the account home bay.
- Project metadata decisions route to the project owning bay.
- Host and project data-plane decisions route to the project host or host bay.
- Project data should not be proxied through the hub unless there is an explicit
  documented exception.
- Narrower access modes should normally use narrower project-host subjects or
  services, not hub-mediated shortcuts.

## Severity Model

- `critical`: can cause large spend, cross-account/project data access, global
  auth bypass, destructive admin action, or broad infrastructure degradation.
- `high`: privilege escalation, reliable single-account DoS, project-host
  boundary break, unbounded worker/runtime use, or high-volume spam.
- `medium`: missing audit/logging, confusing UI that can cause risky action,
  retry/idempotency bug, or constrained leak/abuse path.
- `low`: local-only issue, documentation/test gap, or nuisance with clear
  mitigation.

## Status Model

- `unknown`: not audited in this delta pass.
- `investigating`: actively being inspected.
- `finding`: concrete issue found; fix or risk decision needed.
- `fixed`: code fix landed and focused validation passed.
- `guarded`: protections exist, but broader policy or manual validation remains.
- `accepted-risk`: explicitly accepted for this release with reason.
- `deferred`: not release-blocking; follow-up item should exist.

## Phase 0: Changed-Surface Inventory

Goal: create a release-gating inventory of code touched since the May 11 audit.

Commands:

```sh
git log --since=2026-05-11 --oneline -- src/packages
git log --since=2026-05-11 --name-only --pretty=format: -- src/packages | sort -u
rg -n "viewer|read_policy|readOnly|viewer fs|getListing|readFile|requestProjectAccess|project_access_request|blocked_requester" src/packages
rg -n "shared_disk|scratch|auto-grow|autogrow|disk_type|serviceTier|fast|flex|priority|queued|running|acp|codex" src/packages
rg -n "fresh-auth|DANGEROUS_RPC|dangerous|admin|operator|impersonat|upgrade|deploy|host" src/packages/server src/packages/conat src/packages/frontend
rg -n "rate|limit|quota|cooldown|admission|COUNT\\(\\*\\).*INTERVAL|queue|worker" src/packages/server src/packages/database src/packages/project
rg -n "createNotification|notification|email|invite|collab|access request|project_log" src/packages/server src/packages/frontend src/packages/database
```

Deliverables:

- Initial scoreboard rows for each recent high-risk surface.
- One owner/next-check entry for every `unknown` or `finding` row.

## Phase 1: Project Access Authority

Goal: prove non-members, viewers, collaborators, owners, and blocked requesters
hit the right authority boundaries.

Checks:

1. Public project URL: unauthenticated users must sign in before seeing project
   title, owner, avatar, description, collaborator list, or request controls.
2. Non-members can request viewer or collaborator access; default is viewer.
3. Existing viewers can request collaborator access only.
4. Access approval honors the project collaborator-management setting.
5. Requester blocking prevents repeated requests and notification spam.
6. Access request notifications, project-log entries, and email fanout do not
   leak more metadata than invites.
7. All access-request mutations route to the project owning bay.
8. Project list, pending invites, and project landing pages consistently label
   viewer/collaborator/owner relationships.

Validation targets:

- Focused server tests for request limits, blocking, approval authorization, and
  multibay routing.
- Focused frontend tests for requester menus and signed-in/non-member landing.
- Manual browser test for non-member, viewer, collaborator, owner, and blocked
  requester.

## Phase 2: Viewer Project-Host Data Plane

Goal: prove viewer mode is read-only and uses direct project-host data-plane
services with narrow capabilities.

Checks:

1. Viewer `getListing` filters hidden paths without hiding ancestor entries
   needed to reach allowed nested paths.
2. Viewer file reads and previews cannot write, create, compile, execute,
   start runtime, start terminal, start Jupyter kernels, run Codex, access SSH,
   access secrets, or alter settings/collaborators.
3. Viewer browser UI hides write/runtime affordances without relying on hidden
   buttons as the only enforcement.
4. Viewer `cocalc-cli` list/cat/get use viewer-safe APIs and deny write/runtime
   commands explicitly.
5. Viewer endpoint deny tests cover runtime/start, app-server/proxy, terminal,
   Jupyter, Codex/ACP, SSH, secrets, snapshots/backups, settings, and
   collaborator-management paths.
6. Read-only reload/refresh paths only re-fetch allowed data.

Validation targets:

- Project-host endpoint deny tests.
- CLI viewer smoke tests for list/cat/get and write denial.
- Browser smoke test as a real viewer on a project with sparse read policy.

## Phase 3: Spend and Resource Admission

Goal: prove recently added spend/resource paths are bounded before expensive
work starts and are priced consistently in all enforcement loops.

Checks:

1. Shared scratch disk creation, resize, auto-grow, edit, and delete all require
   the correct owner/admin authority and route to the host bay.
2. Scratch disk pricing is included in host purchase sessions, host edit
   estimates, spend maintenance, background enforcement, and UI warnings.
3. Shared scratch auto-grow is gated by provider capabilities and admission
   checks before cloud resize.
4. Codex fast mode is off by default, visible in UI/activity logs, and only sent
   to app-server when explicitly requested.
5. ACP durable turn creation, running claims, retry/recovery, and queued/running
   status transitions are bounded and idempotent.
6. Notification/email/project-log fanout has duplicate suppression and spam
   limits for repeated access requests or repeated failures.

Validation targets:

- Focused tests for scratch cost estimates and edit/delete authorization.
- Manual Codex turn checking standard versus fast service tier in logs.
- Focused ACP status test for queued-to-running transition and retry behavior.

## Phase 4: Local, Launchpad, and PGLite Modes

Goal: prove one-bay/local shortcuts are deliberate and do not alter real
Postgres behavior.

Checks:

1. PGLite-specific transaction serialization or direct-sync paths are gated on
   PGLite/local mode only.
2. Real Postgres security-state, account-state, and project-state sync behavior
   remains unchanged.
3. Launchpad SEA startup works with bundled assets and does not depend on
   filesystem assumptions that fail in a single executable.
4. Unit tests that use PGLite do not hide real Postgres behavior differences.

Validation targets:

- Focused server/database tests for PGLite-only branches.
- Launchpad SEA smoke run.
- Spot review of guards around PGLite feature detection.

## Phase 5: Operator and Admin Tooling

Goal: prevent high-privilege tooling from exceeding the operator's explicit
selection or bypassing fresh-auth classification.

Checks:

1. Host upgrade/deploy UI and RPCs apply only the selected components.
2. Dangerous public hub RPC registry covers new admin/destructive-looking RPCs.
3. Scratch disk, host, RootFS, backup, secret, and settings mutations have
   fresh-auth where comparable existing operations require it.
4. Operator CLI commands do not reuse stale local dev/hub env credentials.
5. Admin or maintenance jobs do not recompute spend or access state using
   incomplete fields.

Validation targets:

- Dangerous RPC registry test.
- Host upgrade selection test or manual browser smoke.
- Focused review of admin maintenance queries touched since May 11.

## Phase 6: Dependency, Defaults, and Release Config

Goal: catch regressions outside product logic.

Checks:

1. `pnpm -C src version-check` is clean.
2. Dependency advisories are reconciled with production reachability.
3. New environment defaults fail closed for public signup, project access,
   scratch disk limits, Codex fast tier, viewer mode, and browser automation.
4. New docs or examples do not encourage deploying unsafe local defaults behind
   a public proxy.

Validation targets:

- `pnpm -C src version-check`.
- Package-local typechecks/tests for touched packages.
- Dependency advisory review if lockfiles changed.

## Manual Validation Matrix

Run after the focused code audit narrows open findings:

1. Signed-out project URL opens sign-in only.
2. Signed-in non-member requests viewer access, then collaborator access.
3. Blocked requester cannot request again and cannot spam notifications.
4. Viewer browses sparse read policy, opens markdown/chat/pdf/notebook/tex, and
   fails terminal/Jupyter runtime/Codex/settings/collaborator attempts.
5. `cocalc-cli` as viewer can list/cat/get allowed files and cannot write or
   run.
6. Scratch disk high-cost create/edit fails without admission and logs a clear
   reason.
7. Codex standard turn logs no fast app-server tier; explicit fast turn logs the
   accepted fast/flex tier and shows config in activity log.
8. Host upgrade UI upgrades exactly selected components.
9. Launchpad SEA starts cleanly on a fresh local run.

## Closeout Criteria

The delta audit can close when:

1. every scoreboard row is `fixed`, `guarded`, `accepted-risk`, or `deferred`,
2. every `critical` or `high` `finding` has a code fix or accepted risk signed
   off in the notes,
3. focused tests or smoke checks exist for each fixed `critical` or `high`
   issue,
4. manual validation matrix results are recorded in the scoreboard,
5. any remaining `deferred` items have concrete owner/next-action text.
