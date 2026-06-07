# Managed CPU Accounting Scope Plan

Status: planning. This extends `cpu-usage-accounting-abuse-plan-2026-05-30.md`
after discovering that account-funded dedicated project hosts must not consume a
user's shared managed-CPU budget.

## Problem

Managed CPU accounting currently records project-host CPU usage into
`account_cpu_usage_events` and uses the same event stream for:

- project start admission;
- user-visible account usage bars;
- admin/account CPU history;
- abuse and capacity investigation.

That is too coarse. A customer can pay explicitly for a dedicated project host,
including very large hosts such as 128 CPU machines. CPU used on that paid host
should not burn through their shared/global managed CPU budget, and it should not
block starts or make account usage bars look alarming.

However, turning CPU telemetry off entirely for paid dedicated hosts loses useful
operational data. Dedicated hosts can still run abusive workloads such as DDoS,
crypto mining, credential stuffing, password cracking, or runaway jobs. We want
to keep telemetry for abuse and diagnostics while excluding it from shared-budget
enforcement.

## Product Semantics

CPU usage events need an explicit accounting scope. The scope must be decided by
the hub/server at ingest time, based on authoritative host/project/account state,
not by trusting the project host.

Initial scopes:

- `shared_managed`: public/shared managed capacity. Counts toward managed CPU
  budgets, project start admission, and user-facing account CPU usage bars.
- `site_funded_dedicated`: dedicated or cloud capacity paid by the site/operator.
  Counts toward managed CPU budget unless we explicitly decide otherwise for a
  deployment. This keeps site-funded public/alpha pools protected.
- `account_funded_dedicated`: account-prepaid or account-postpaid dedicated host
  usage. Does not count toward shared managed CPU budgets. Remains visible in
  admin abuse/capacity history.
- `local_or_self_host`: Star, local development, Launchpad/local self-host, or
  other non-hosted capacity. Does not count toward hosted shared managed CPU
  budgets unless a deployment explicitly opts in.
- `unknown`: fallback for incomplete metadata. Treat as budget-counting only if
  we need backward-compatible safety; new code should avoid producing unknown.

The primary query invariant should be positive inclusion:

```sql
WHERE counts_toward_managed_cpu_budget = TRUE
```

Do not rely on negative filters such as `scope != 'account_funded_dedicated'`.
Positive inclusion is safer for future host types and null/backfill states.

## Data Model

Extend `account_cpu_usage_events`:

```sql
ALTER TABLE account_cpu_usage_events
  ADD COLUMN IF NOT EXISTS cpu_accounting_scope TEXT NOT NULL
    DEFAULT 'shared_managed',
  ADD COLUMN IF NOT EXISTS counts_toward_managed_cpu_budget BOOLEAN NOT NULL
    DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS host_funding_mode_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS host_tier_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS host_kind_snapshot TEXT;

CREATE INDEX IF NOT EXISTS account_cpu_usage_events_budget_account_time_idx
  ON account_cpu_usage_events(account_id, sample_ended_at DESC)
  WHERE counts_toward_managed_cpu_budget = TRUE;

CREATE INDEX IF NOT EXISTS account_cpu_usage_events_scope_time_idx
  ON account_cpu_usage_events(cpu_accounting_scope, sample_ended_at DESC);
```

Rationale:

- `cpu_accounting_scope` is human/debuggable and useful for admin grouping.
- `counts_toward_managed_cpu_budget` makes policy queries simple and safe.
- snapshot fields make historical events explainable even if host metadata later
  changes.
- defaults preserve existing behavior for old code during rolling deploys.

## Server-Derived Classification

Add a helper near membership CPU accounting, e.g.
`src/packages/server/membership/managed-cpu-scope.ts`:

```ts
type ManagedCpuAccountingScope =
  | "shared_managed"
  | "site_funded_dedicated"
  | "account_funded_dedicated"
  | "local_or_self_host"
  | "unknown";

type ManagedCpuAccountingClassification = {
  scope: ManagedCpuAccountingScope;
  counts_toward_managed_cpu_budget: boolean;
  host_funding_mode_snapshot?: "account-prepaid" | "account-postpaid" | "site-funded";
  host_tier_snapshot?: number;
  host_kind_snapshot?: string;
};
```

Classification inputs:

- `host_id` from the authenticated project-host call scope;
- `project_id` from the sample;
- `project_hosts.metadata.billing.funding_mode`;
- `project_hosts.tier`;
- provider/local/self-host metadata already used in host mapping;
- optionally project assignment as a sanity check.

Suggested rules:

1. If host is local/self-host/star, classify `local_or_self_host`, budget false.
2. If `metadata.billing.funding_mode` is `account-prepaid` or
   `account-postpaid`, classify `account_funded_dedicated`, budget false.
3. If `metadata.billing.funding_mode` is `site-funded`, classify
   `site_funded_dedicated`, budget true for now.
4. If host has a non-null `tier` and no dedicated billing mode, classify
   `shared_managed`, budget true.
5. If host metadata is missing, classify `unknown`, budget true for backward
   compatibility, and log rate-limited warning.

The project host may include metadata hints for debugging, but those hints must
not decide budget semantics.

## Ingest Changes

Update the project-host-to-hub CPU recording path:

- `src/packages/project-host/hub/system.ts`
  - include `host_id` in the forwarded argument type or rely on the existing
    callHub host scope, but make the server-side contract explicit.
- `src/packages/server/conat/api/system.ts`
  - pass the authenticated/forwarded host id through to
    `recordManagedProjectCpuUsage`.
- `src/packages/server/membership/managed-cpu.ts`
  - resolve account id as today;
  - resolve accounting classification before insert;
  - insert scope, budget boolean, and snapshot columns.

Security invariant:

- If a project host sends `host_id` in metadata or args, the server must prefer
  the authenticated call scope host id. A malicious or compromised host should
  not be able to mark samples as paid-dedicated for another host.

Rolling deploy behavior:

- Old project hosts still send the old payload.
- New hub code uses call scope or `opts.host_id`.
- Existing rows default to budget-counting until backfilled.

## Query Changes

### Start Admission

`src/packages/server/membership/managed-cpu-policy.ts` currently calls
`getManagedCpuUsageForAccount`, which sums all CPU events. Change the usage
aggregation to include only budget-counting events.

Preferred:

- make `getManagedCpuUsageForAccount` budget-only by default;
- add an option for admin/history queries when all scopes are needed:

```ts
getManagedCpuUsageForAccount({
  account_id,
  limit5h,
  limit7d,
  budget_only: true, // default
});
```

Project start admission should remain budget-only.

### User Account Usage Bars

Usage status and account overview should show budget CPU only, because the
purpose is to explain membership/shared-capacity limits.

If we later want to show paid dedicated usage, add a separate panel:

- "Shared CPU budget"
- "Dedicated host CPU activity"

Do not combine them.

### Admin CPU Overview And History

Admin abuse/capacity views should support both:

- budget CPU summaries, for "who is exhausting shared capacity";
- all-scope summaries, for "who is using a lot of compute anywhere".

Recommended UI/API fields:

- `cpu_accounting_scope`;
- `counts_toward_managed_cpu_budget`;
- grouped seconds by scope;
- optional filter: `budget_only`, `scope`, `include_non_budget`.

Default admin abuse scanning should include all scopes but display the scope
prominently so a paid host is not mistaken for shared-pool abuse.

## Bootstrap And Runtime Env

Do not make `COCALC_PROJECT_HOST_CPU_USAGE_MODE=off` the main correctness
mechanism. It is a sampling throttle, not a policy boundary.

Recommended bootstrap behavior:

- Keep CPU sampling enabled by default for hosted cloud project hosts.
- Optionally set slower sampling intervals for account-funded dedicated hosts if
  overhead becomes meaningful.
- Avoid hard-coding `COCALC_PROJECT_HOST_CPU_USAGE_MODE=observe` without
  considering host class; a future bootstrap helper can derive:
  - mode: observe/off;
  - interval;
  - source labels.

This keeps abuse visibility for account-funded dedicated hosts while preventing
shared budget impact through server-side classification.

## Backfill And Migration

Backfill existing rows after adding columns:

```sql
UPDATE account_cpu_usage_events events
SET
  host_funding_mode_snapshot =
    project_hosts.metadata #>> '{billing,funding_mode}',
  host_tier_snapshot = project_hosts.tier,
  cpu_accounting_scope = CASE
    WHEN project_hosts.metadata #>> '{billing,funding_mode}'
      IN ('account-prepaid', 'account-postpaid')
      THEN 'account_funded_dedicated'
    WHEN project_hosts.metadata #>> '{billing,funding_mode}' = 'site-funded'
      THEN 'site_funded_dedicated'
    WHEN project_hosts.tier IS NOT NULL
      THEN 'shared_managed'
    ELSE 'unknown'
  END,
  counts_toward_managed_cpu_budget = CASE
    WHEN project_hosts.metadata #>> '{billing,funding_mode}'
      IN ('account-prepaid', 'account-postpaid')
      THEN FALSE
    ELSE TRUE
  END
FROM project_hosts
WHERE events.host_id = project_hosts.id
  AND events.cpu_accounting_scope = 'shared_managed';
```

For missing hosts, leave existing events as budget-counting until manually
audited. This is conservative for release and avoids accidentally dropping
shared-pool CPU from enforcement.

## Tests

Add unit tests around the pure classifier:

- tiered shared host => `shared_managed`, budget true;
- account-prepaid host => `account_funded_dedicated`, budget false;
- account-postpaid host => `account_funded_dedicated`, budget false;
- site-funded host => `site_funded_dedicated`, budget true;
- local/star/self-host host => `local_or_self_host`, budget false;
- missing host metadata => `unknown`, budget true.

Add `managed-cpu` tests:

- recording stores scope and snapshot columns;
- budget aggregation excludes account-funded dedicated rows;
- budget aggregation includes shared/site-funded rows;
- admin overview/history can include all scopes and expose grouped scope
  totals.

Add start-policy tests:

- account over CPU budget is blocked on shared host;
- same account can start project on account-funded dedicated host if the host
  admission/billing policy otherwise permits it;
- site-funded host behavior remains budget-counting.

Add project-host forwarding tests:

- server uses authenticated host scope when present;
- caller-provided metadata cannot override budget scope.

## Rollout Plan

1. Add schema columns and classifier with tests.
2. Change `recordManagedProjectCpuUsage` to classify and insert scope data.
3. Change budget queries to positive inclusion on
   `counts_toward_managed_cpu_budget = TRUE`.
4. Update admin CPU APIs to expose scope/grouped totals without changing user
   usage bars.
5. Backfill existing events in dev/staging and inspect top accounts before
   production migration.
6. Revisit project-host sampling interval defaults after observing overhead.

## Acceptance Criteria

- CPU on account-funded dedicated hosts is recorded for admin visibility.
- CPU on account-funded dedicated hosts does not contribute to:
  - project start CPU admission;
  - user-visible shared managed CPU usage bars;
  - shared CPU remaining/reset calculations.
- CPU on shared managed hosts still behaves exactly as it does today.
- Site-funded host behavior is explicit and tested.
- Event rows are self-explanatory months later via scope and snapshot columns.

## Open Questions

- Should `site_funded_dedicated` count toward user membership CPU budgets, or
  should it be a separate site/operator budget? The conservative release choice
  is "counts", because site-funded capacity is still operator-paid shared
  capacity.  (ANS: counts)
- Should `local_or_self_host` CPU be recorded at all in hosted admin views? The
  likely answer is no for hosted production, but yes in local development if it
  helps exercise the pipeline.  (ans: we will not support `local_or_self_host` in hosted production, because of our security model, which is users do NOT have access to hosts directly, outside of podman containers.  it's good to record it for local deployments.)
- Should account-funded dedicated CPU appear in customer-facing dedicated-host
  dashboards later? It is useful, but should be separate from shared CPU budget
  UI.  (ans: not a priority; can defer -- one advantage is that it makes it clear that it is NOT included in their normal cpu usage gauge.)
