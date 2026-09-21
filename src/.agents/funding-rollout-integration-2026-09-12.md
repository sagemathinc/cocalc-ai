# Funding Rollout Startup Integration

Current consumer: `server/compute/funding/rollout.ts`, called by allocation
preview/proposal/review and `approval-sponsorship.ts` at financial approval.
Reductions, revocations, closure, settlement, status, and owned summaries do not
require readiness. `compute_sponsorship_enabled` defaults off independently of
the VM and transfer flags. Do not conflate the transfer flag with this flag.

## Required Owners And Exports

- Lagrange: export `verifyFundingAccountWriters(): Promise<FundingRolloutEvidence>`
  from `server/compute/funding/account-writer-rollout.ts`. This must inspect the
  actual hold-aware account writer fence/coverage, including legacy purchase,
  refund, membership, renewal, automatic top-up, transfer, and project admission
  writers. Evidence must not claim an old writer is safe merely because one new
  hub is alive. Own the separate default-off transfer feature flag.
- Nietzsche: export `verifySponsoredResourceWriters(): Promise<FundingRolloutEvidence>`
  from `server/compute/funding/resource-writer-rollout.ts`. Inspect explicit
  deployment/bay namespace isolation (including orphan sweeps, DNS, VM/volume
  queue workers) and exclusion of old workers. A namespace alone does not prove
  another old worker sharing the database cannot consume the queue.
- API owner will connect these exports in `rollout-startup.ts`, invoked by
  approval service initialization (called by `server/conat/index.ts`). This startup module is
  also needed by a separately launched approval process. Do not self-register
  providers twice. The consumer supports idempotent startup/disposal.

The startup module now registers the concrete isolated-QA provider for both
checks. Production/multibay providers must replace that branch with validated
deployment/version and credential-rollout attestation, not a boolean override.

## Evidence Contract

Import `FundingRolloutEvidence` from `@cocalc/util/compute-funding-rollout`:

```ts
{
  protocol_version: 1,
  enforced: boolean,
  evidence_id: string, // non-secret identifier of inspected fence/deployment
  as_of: string,      // ISO inspection time, no older than 30 seconds
  expires_at: string  // ISO, must remain enforced until this instant
}
```

Missing/unreachable/stale/mismatched evidence fails closed. The internal
`computeFundingGetRolloutCapabilities` method is actually registered on the
bay-service-only funding subject. The consumer checks every configured and
registered bay, bounded at 32 bays / concurrency 4 / 5-second RPC timeout. No
public client can inject evidence. Approval uses an in-process, short-lived,
unforgeable proof and rechecks the uncached feature flag under a transaction row
lock. Providers must hold their exclusion guarantees through evidence expiry.

## Isolated QA

`isolated-qa-rollout.ts` now inspects the current hub's compiled writer modules,
their protocol versions and mtimes relative to process start, and exact live
PostgreSQL `data_directory`, Unix socket directory, and database. It accepts
`smc` on its dedicated cluster. It does not enumerate `/proc`, inspect unrelated
process environments, require TCP, or require a database migration. The local
operator explicitly guarantees one writer deployment and owns this worktree;
this dev-only trust is not represented as production fleet exclusion proof.

Before restarting hub19200, Main configures:

```text
COCALC_FUNDING_ISOLATED_QA=yes
COCALC_FUNDING_QA_DATABASE=smc
COCALC_FUNDING_QA_WORKTREE=/home/user/cocalc-course-funding-v2
COCALC_FUNDING_QA_PG_DATA_DIRECTORY=<absolute live data_directory for pg-f8e1c8e3>
COCALC_FUNDING_QA_PG_SOCKET=<absolute Unix socket directory for pg-f8e1c8e3>
COCALC_FUNDING_QA_DEPLOYMENT_ID=<same explicit COCALC_COMPUTE_DEPLOYMENT_ID>
```

The pool's actual socket host must equal the expected directory and PG must
report that exact single socket directory. Development compute environment and
one-bay catalog are required. Evidence expires after five seconds and binds the
PID, process start, compiled modules, PG cluster start, bay and namespace.
`compute_sponsorship_enabled=yes` is separately needed; it remains default off.
Keep settlement/closure workers running even when admission is disabled.

## Public Contract Changes

- `getCourseSummary()` includes optional `sponsorship: {enabled,available,reason?}`;
  absent means unavailable in the UI.
- `getOwnedPools()` is the same payer-only projection plus stored course IDs on
  every pool. Account Balance mounts Sponsored Budgets with existing management.
- `listSources()` includes `available_usd = max(0,min(pool remainder,grant remainder))`.
- Pool-change preview includes server-derived `requires_course_access`, also
  used to gate expanded commitments and exempt financial-owner cleanup.

No commits or external disclosure; these changes remain coordinated locally.
