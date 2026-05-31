# CPU Usage Accounting And Abuse Plan

Status: implemented through Phase 4 for release-blocker item 14 in
`release-blocker-triage-2026-05-29.md`. Phase 5 Codex-assisted triage is
explicitly deferred until after launch and real abuse patterns are available.

## Goals

Implement durable CPU usage accounting that supports:

- abuse detection for crypto mining, password cracking, bot workloads, and
  other sustained compute misuse;
- free-tier product psychology: users can burst onto real hardware, but heavy
  sustained usage creates a clear reason to upgrade;
- capacity planning and project rebalancing based on actual CPU-hours;
- admin investigation workflow with durable annotations so known legitimate
  compute is not repeatedly surfaced as high-priority abuse.
- combined abuse review of CPU and excessive egress, since high egress can be a
  red flag even when managed egress limits already cut off further traffic.
- user-visible current usage windows so users can understand their 5-hour and
  7-day compute/network budgets before they hit a start or egress limit.

Non-goals for the first release:

- automatically killing already-running projects because they used too much CPU;
- trying to classify abuse automatically from CPU alone;
- exact process-level attribution inside a project;
- billing users for CPU as a metered line item.

## Product Semantics

Measure CPU in CPU-seconds and render it as CPU-hours.

Examples:

- 1 core for 1 hour = 1 CPU-hour.
- 32 cores for 10 minutes = about 5.3 CPU-hours.

This preserves the ability for free users to experience powerful machines while
making sustained heavy compute consume their free budget quickly.

Policy behavior:

1. Always record usage for running projects when measurement is available.
2. Show admin visibility before enforcing hard behavior.
3. For free/trial users over the configured 5-hour or 7-day CPU budget, block
   new project starts with a clear upgrade/cooldown message.
4. Do not stop running projects in v1.
5. Paid accounts have much higher limits, but still appear in accounting and
   abuse/capacity views.
6. Admin annotations can reduce or suppress abuse priority, but must not delete
   or hide raw usage.

## Existing Code To Reuse

Managed egress provides the closest existing accounting/policy shape:

- `src/packages/server/membership/managed-egress.ts`
  - durable per-account events;
  - project-to-usage-account attribution;
  - 5-hour and 7-day window aggregation;
  - history/admin summary patterns.
- `src/packages/server/membership/managed-egress-policy.ts`
  - effective membership limit resolution;
  - allow/block policy return value.
- `src/packages/project-host/raw-network-egress.ts`
  - project-host side sampler loop;
  - monotonic counter delta handling;
  - best-effort hub recording;
  - optional start policy check.
- `src/packages/project/project-info/server.ts`
  - existing cgroup v1/v2 CPU usage counters;
  - v1 `cpuacct.usage` in nanoseconds;
  - v2 `cpu.stat usage_usec`.
- `src/packages/project-runner/run/limits.ts`
  - existing podman CPU limit configuration.

The CPU implementation should be a parallel resource accounting pipeline, not a
special case embedded in egress.

## Multibay Model

CPU samples originate on a project host. A project host belongs to a bay, and a
project belongs to an owning bay. Account-facing usage and membership policy
must ultimately be attributed to the project usage account, which may have a
home bay.

Required routing model:

1. Project host samples project CPU.
2. Project host calls its hub/owning-bay system API with `project_id`,
   `host_id`, CPU delta, and sample metadata.
3. Owning bay resolves the project usage account using the same semantics as
   managed egress.
4. If the account home bay is not local, route or replicate the usage event to
   the authoritative account home bay.
5. Admin dashboards that are account-centric should query account-home data or
   a global/admin aggregate, not assume the local bay has all usage.

Launchpad is the one-bay special case, so the same code path should work
without cross-bay routing.

Open design decision:

- If managed egress currently records account usage only on the local bay,
  either align CPU with that existing limitation for v1 or first factor a
  shared multibay `recordAccountResourceUsage` routing helper. The latter is
  cleaner if CPU is used for global abuse dashboards.
- Account rehome must either move account-owned usage history or route it to the
  account home bay before multibay relies on it for policy. That includes
  `account_cpu_usage_events`, future account-level CPU abuse annotation tables,
  and the existing `account_managed_egress_events` if egress policy/admin views
  are made account-home authoritative. This is not a Launchpad blocker because
  Launchpad has one bay, but it belongs in the account rehome checklist.

## Data Model

Add a new durable event table rather than overloading egress:

```sql
CREATE TABLE IF NOT EXISTS account_cpu_usage_events (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  project_id UUID,
  host_id UUID,
  cpu_seconds DOUBLE PRECISION NOT NULL,
  sample_started_at TIMESTAMPTZ,
  sample_ended_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'project-host-cgroup',
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS account_cpu_usage_events_account_time_idx
  ON account_cpu_usage_events(account_id, sample_ended_at DESC);

CREATE INDEX IF NOT EXISTS account_cpu_usage_events_project_time_idx
  ON account_cpu_usage_events(project_id, sample_ended_at DESC);

CREATE INDEX IF NOT EXISTS account_cpu_usage_events_host_time_idx
  ON account_cpu_usage_events(host_id, sample_ended_at DESC);
```

Use `DOUBLE PRECISION` for CPU seconds because samples are naturally fractional
after converting cgroup microseconds/nanoseconds. Clamp invalid or tiny deltas
server-side.

Suggested TypeScript API:

```ts
recordManagedProjectCpuUsage({
  account_id?: string;
  project_id?: string;
  host_id?: string;
  cpu_seconds: number;
  sample_started_at?: Date;
  sample_ended_at?: Date;
  metadata?: Record<string, unknown>;
}): Promise<{ recorded: boolean; account_id?: string }>;
```

Window aggregation:

- `managed_cpu_5h_seconds`
- `managed_cpu_7d_seconds`
- remaining seconds when limits are configured
- reset timestamps and human reset durations
- grouped usage by project and host for admin views

## Membership Limits

Extend effective membership usage limits with CPU budgets:

- `cpu_5h_seconds`
- `cpu_7d_seconds`

Render these as CPU-hours in UI.

Initial policy recommendation:

- Free/trial: small but burst-friendly quota.
- Paid: much higher quota, effectively non-blocking for normal users.
- Admin/known internal/test accounts: overrideable through existing membership
  or entitlement override mechanisms.

Avoid hardcoding product values in the sampler. The project host should ask the
hub for policy when it needs a start decision.

## Project-Host Sampling

Add a project-host CPU sampler loop analogous to raw network egress.

Sampling source options:

1. Preferred: read each project container process tree CPU usage directly from
   `/proc` on the host. Do not attribute the shared project-pool cgroup counter
   to every project; current rootless podman hosts can put all project
   containers in one `/cocalc-project-pool` cgroup.
2. Alternative: ask project runtime/status for the existing cgroup CPU total.
3. Fallback: skip recording and log at debug/warn rate-limited levels.

Sample keying:

- Track previous sample by a stable runtime key, not only `project_id`.
- Include enough identity to detect container restart:
  - `project_id`;
  - podman container ID if available;
  - pid or cgroup path;
  - host ID.

Delta rules:

- first sample for a runtime key establishes the baseline and records nothing;
- positive deltas are recorded;
- negative deltas mean counter reset/restart, so reset baseline and record
  nothing for that interval;
- implausibly huge deltas should be clamped or dropped with a warning;
- if project disappears, remove its previous sample.

Recommended interval:

- default 60 seconds;
- configurable with `COCALC_PROJECT_HOST_CPU_USAGE_INTERVAL_MS`;
- skip overlapping loop iterations.

Metadata to include:

- cgroup version;
- cgroup path or container ID when safe;
- pid when useful;
- CPU core limit if known;
- sample interval milliseconds;
- sampler version.

## Start Policy

Add:

```ts
getManagedProjectCpuPolicy({
  account_id?: string;
  project_id?: string;
}): Promise<{
  account_id?: string;
  allowed: boolean;
  blocked_by?: "5h" | "7d";
  managed_cpu_5h_seconds?: number;
  managed_cpu_7d_seconds?: number;
  cpu_5h_seconds?: number;
  cpu_7d_seconds?: number;
}>;
```

Project start behavior:

1. Before starting a project, check CPU policy.
2. If no account or no policy is available, allow start and log best-effort
   failure. This avoids control-plane outages causing false denial.
3. If over CPU limit, block start with a message that explains:
   - CPU budget is exhausted;
   - when the 5-hour or 7-day window resets;
   - upgrade increases compute budget;
   - running projects are not affected by this start check.

Do not stop already-running projects in v1.

## Abuse Triage Annotations

Add a first-class admin annotation system for CPU/account abuse review. Do not
bury this only in free-form account notes.

Suggested table:

```sql
CREATE TABLE IF NOT EXISTS account_abuse_review_annotations (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  project_id UUID,
  category TEXT NOT NULL,
  disposition TEXT NOT NULL,
  priority_adjustment TEXT NOT NULL DEFAULT 'normal',
  reason TEXT NOT NULL,
  evidence JSONB,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_by UUID,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS account_abuse_review_annotations_account_idx
  ON account_abuse_review_annotations(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS account_abuse_review_annotations_active_idx
  ON account_abuse_review_annotations(account_id, category, expires_at)
  WHERE revoked_at IS NULL;
```

Initial categories:

- `cpu`
- `egress`
- `storage`
- `signup`
- `payment`
- `general`

Initial dispositions:

- `legitimate`
- `suspicious`
- `abusive`
- `needs_followup`
- `false_positive`

Initial priority adjustments:

- `suppress`
- `lower`
- `normal`
- `raise`
- `urgent`

CPU dashboard behavior:

- Raw usage always remains visible.
- If an active `cpu` annotation has `suppress`, the account/project should not
  appear in default "needs investigation" views.
- If it has `lower`, show it lower in the queue and display the reason.
- If it has `raise` or `urgent`, keep it prominent even if usage is moderate.
- Expired or revoked annotations no longer affect priority, but remain visible
  in audit history.

Required fields:

- `reason` must be non-empty.
- `created_by` must be the admin account ID.
- `evidence` should capture current CPU windows, top projects, and a short
  snapshot of why the admin made the decision.

Suggested defaults:

- Legitimate research/teaching compute annotation: expires in 90 days.
- False positive: expires in 30 days.
- Known abusive: no default expiration, but still revocable.

This makes "I inspected it and it is legitimate number theory" durable,
auditable, and operationally useful without hiding the underlying signal.

## Admin UI

Add a CPU abuse/capacity panel, likely near existing admin user/account tools
and managed egress views.

Views:

1. Top accounts by CPU-hours in 5h and 7d.
2. Top projects by CPU-hours in 5h and 7d.
3. Top accounts/projects by managed egress in 5h and 7d.
4. Combined CPU-plus-egress abuse queue, weighted toward free/trial accounts
   and accounts without active suppress/lower annotations.
5. Free/trial accounts over thresholds.
6. Host-level CPU-heavy projects for capacity planning.
7. Accounts hidden/lowered by active annotation.
8. Recently annotated accounts.

Each row should show:

- account name/email and account ID;
- membership/free/trial/paid status;
- 5h CPU-hours;
- 7d CPU-hours;
- top project(s);
- host(s);
- managed egress in the same windows;
- current annotation/disposition if any;
- action buttons:
  - "Mark legitimate";
  - "Needs follow-up";
  - "Mark abusive";
  - "Edit annotation";
  - "Open account";
  - "Open project".

Annotation UI:

- require a reason;
- offer expiration choices: 7d, 30d, 90d, 1y, no expiration;
- show current CPU snapshot in the confirmation dialog;
- require fresh auth if the action escalates to `abusive`, `urgent`, or causes
  account/project restriction. Simple `legitimate/lower/suppress` annotations
  can be normal admin-auth if existing admin notes do not require fresh auth.

## Codex-Assisted Review

Codex can help summarize likely legitimacy, but must not be the authority.

Suggested workflow:

1. Admin opens a CPU-flagged account/project.
2. "Analyze project activity" gathers safe metadata:
   - process names/command lines if already visible to admins;
   - recent file names/extensions;
   - recent project activity;
   - CPU windows;
   - egress/storage signals.
3. Codex produces a short triage summary:
   - likely legitimate;
   - likely suspicious;
   - unknown;
   - supporting evidence.
4. Admin chooses annotation disposition and writes/reviews reason.

Do not expose private file contents to Codex automatically unless that is already
allowed by existing admin/Codex policy and clearly indicated in the UI. This usage of codex should also be done using the proper API key, so that appropriate privacy contracts are in place.

## Notifications And User Messaging

Users should have a self-service view of their current usage windows:

- 5-hour CPU-hours used, limit if configured, remaining, and reset estimate;
- 7-day CPU-hours used, limit if configured, remaining, and reset estimate;
- 5-hour and 7-day managed egress usage, using the existing egress window data;
- recent CPU/egress events where useful for explaining why a limit was reached.

When a project start is blocked due to CPU budget:

- explain this is a compute budget, not a data-loss event;
- show CPU-hours used and limit;
- show reset time;
- link to upgrade;
- avoid accusations of abuse.
- explain that user still has read/write access to files -- they just can't use terminals, notebooks, latex, codex.

Example:

> This account has used 14.2 of 12 CPU-hours in the last 5 hours. Existing
> running projects are not stopped, but starting another project is paused until
> the window resets or you upgrade.

Admin abuse dashboard language should be sharper:

- "Needs review"
- "Known legitimate"
- "Suppressed until DATE"
- "Marked abusive by ADMIN on DATE"

## Security And Abuse Considerations

- Sampling must be best-effort but tamper-resistant: project code should not be
  able to reset or forge host-side counters.
- Never trust project-provided CPU deltas without host-side validation.
- Store raw event history; annotations only affect prioritization.
- Admin annotations must be audited with admin account ID and reason.
- Do not let non-admins see abuse annotations.
- Do not expose admin-only CPU abuse labels to the flagged user.
- Be careful with PII/private project content in Codex-assisted review.
- Use existing fresh-auth primitives for actions that restrict accounts or
  materially change trust status.

## Rollout Plan

Phase 1: accounting only

- [x] Add server table and record/query functions.
- [x] Add project-host sampler. It defaults to observe mode on project hosts and
      can be disabled with `COCALC_PROJECT_HOST_CPU_USAGE_MODE=off`.
- [x] Add tests for delta handling, counter reset, missing cgroups, and server
      aggregation.
- [x] Add debug/admin-only way to inspect recorded CPU usage.
- [x] Add current CPU window usage to membership usage status so user-facing UI
      can render it with the existing membership usage surface.
- [x] Render current CPU window usage in user and admin membership usage
      summaries.
- No start blocking.

Phase 2: admin visibility

- [x] Add top CPU accounts/projects dashboard.
- [x] Add 5h/7d filters.
- [x] Add managed egress accounts/projects in the same review panel as an abuse
      signal.
- [x] Add host/project drilldowns for capacity planning.
- [x] Add admin CPU history graphs for global, account, and project-scoped
      trends, reusing the managed egress history modal shape.
- [x] Add copyable Markdown summaries. CSV export is deferred until offline
      reporting becomes a demonstrated need.

Phase 3: annotations

- [x] Add abuse review annotation table and RPCs.
- [x] Add admin UI actions.
- [x] Integrate active annotations into dashboard priority.
- [x] Add audit/history display.

Phase 4: start policy

- [x] Add membership CPU limit fields/effective limits.
- [x] Add CPU policy resolver.
- [x] Add project start preflight check.
- [x] Enable blocking for configured CPU budgets. Policy evaluation failures
      fail open with a warning so control-plane outages do not cause false
      denial.
- [x] Configure built-in membership-tier CPU budgets. Free has a small
      burst-friendly quota; paid tiers have much higher defaults and remain
      adjustable through membership tier settings and account entitlement
      overrides.

Phase 5: Codex-assisted triage

- [deferred] Add optional "analyze" action only after launch, once manual
  review has produced real examples of cocalc-ai abuse patterns.
- [deferred] Keep the admin as the final decision maker.

## Validation

Unit tests:

- CPU delta calculation:
  - first sample records nothing;
  - positive delta records;
  - negative delta resets baseline;
  - container ID change resets baseline;
  - missing cgroup does not crash loop.
- Server recording:
  - rejects non-positive/NaN deltas;
  - resolves project usage account;
  - computes 5h/7d windows;
  - handles account_id override only where authorized.
- Policy:
  - free over 5h blocks;
  - free over 7d blocks;
  - paid limit allows;
  - missing account allows best-effort.
- Annotations:
  - active suppress lowers dashboard priority;
  - expired suppress has no effect;
  - revoked suppress has no effect;
  - reason required;
  - non-admin rejected.

Integration/smoke tests:

- start a project, burn CPU, confirm CPU events appear;
- restart project, confirm no giant duplicate delta;
- stop/start host sampler, confirm no duplicate first-sample charge;
- mark account legitimate and confirm it drops from default review queue;
- exceed free limit and confirm new start is blocked with user-safe message;
- confirm already-running project is not stopped.

Operational validation:

- compare sampled CPU-hours against host/project status CPU totals for a known
  workload;
- verify overhead of sampling many running projects;
- verify dashboard query performance with indexes;
- verify multibay routing once account/project home split is available.

## Open Questions

1. Should CPU usage attribute to the project owner, runtime sponsor, or another
   explicit usage account in all cases? Recommendation: reuse the managed egress
   project usage account resolver for consistency. (ANS: Yes, whatever is chosen by egress, do the same.)
2. Should annotations be account-only, project-only, or both? Recommendation:
   support account annotations with optional project scope. (ANS: agreed -- account is what matters; project is metadata)
3. Should known-legitimate annotations affect start limits? Recommendation: no
   by default; they affect abuse priority only. Use membership/entitlement
   overrides for actual quota changes. (ANS: agree; they do not impact runnig; that's what "ban" or membership overrides are for.)
4. Should paid users ever be start-blocked by CPU budget? Recommendation: keep
   limits very high initially and use dashboard review instead. (ANS: agreed; our plan is no noticeable limits on paying users. We may have some limit on the cheapest tier. the point is to keep this flexible. There may be a lot of people running cocalc-ai sites and give them the tools to decide their own policies.)
5. Should the first implementation be a generic resource usage framework?
   Recommendation: share helpers where obvious, but implement CPU concretely.
   Avoid over-generalizing before the second resource type is proven. (ANS: yes, just cpu and also egress for the abuse monitoring. Also though we will eventually use this data for capacity planning, that's not needed for V1.)

## Suggested Initial Implementation Slice

The smallest useful first PR:

1. Add server-side CPU event table and `recordManagedProjectCpuUsage`.
2. Add 5h/7d CPU usage aggregation for an account.
3. Add focused tests.
4. Add project-host sampler in record-only mode.
5. Add a simple admin-only query/list for top CPU accounts.

This gives immediate abuse and capacity visibility without risking user-facing
false positives.
