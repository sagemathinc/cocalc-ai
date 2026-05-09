# Dedicated Host Purchase Path Trace

Status: working trace note as of 2026-05-09.

Purpose:

- document the current end-to-end dedicated-host purchase/billing path
- identify where billability is decided
- identify where purchase sessions are opened/updated/closed
- make the remaining monthly-billing / failed-charge work easier to scope

## High-Level Flow

For dedicated cloud hosts, the current create/start path is:

1. frontend sends `hosts.createHost` or `hosts.startHost`
2. server checks entitlement and dedicated-host admission
3. server estimates hourly cost from the provider catalog
4. server resolves the funding mode / funding lane
5. server persists host billing metadata
6. server opens or reconciles a dedicated-host metered purchase session
7. background maintenance keeps the session aligned with current status/rate
8. when the host is no longer billable, the session is closed

The system is already much closer to “metered purchase session” semantics than
to “simple one-time purchase” semantics.

## Frontend Entry Point

Create flow:

- `src/packages/frontend/hosts/hooks/use-host-create.ts`

`onCreate(...)` builds the payload and calls:

- `hub.hosts.createHost({...payload, browser_id})`

That is the main browser entry into the billable dedicated-host path.

## Public API Entry Point

Create flow:

- `src/packages/server/conat/api/hosts.ts`
- `createHost(...)`

This function currently does the important top-level policy checks:

- fresh auth for interactive billable actions when appropriate
- membership / product entitlement via `requireCreateHosts(...)`
- requested funding mode validation via
  `assertRequestedHostFundingModeAllowed(...)`
- dedicated-host admission via `assertDedicatedHostAdmissionForAccount(...)`

Then it delegates to:

- `createHostInternalHelper(...)`

Start flow:

- `src/packages/server/conat/api/hosts.ts`
- `startHost(...)`

This re-checks dedicated-host admission and delegates to:

- `startHostInternalHelper(...)`

## What Decides Whether A Host Is Billable

The core billability predicate lives in:

- `src/packages/server/project-host/admission.ts`

The key predicate is:

- `isBillableDedicatedHostCloud(cloud)`

Current intent:

- self-host / local providers are not treated as billable dedicated cloud hosts
- managed providers such as GCP and Nebius are billable

This predicate is used both at create/start time and in the background spend
maintenance path.

## Admission / Funding-Lane Decision

Main file:

- `src/packages/server/project-host/admission.ts`

Important functions:

- `getDedicatedHostPolicySnapshotLocal(...)`
- `evaluateDedicatedHostAdmission(...)`
- `assertDedicatedHostAdmissionForAccount(...)`
- `selectDedicatedHostFundingLane(...)`

Current admission factors include:

- membership capability
- active 2FA
- stored payment method
- account balance
- usage subscription posture
- dedicated-host usage window
- postpaid unbilled exposure
- requested funding mode

This is where the system currently decides whether the account may use:

- `site-funded`
- `account-prepaid`
- `account-postpaid`

## Create-Time Billable Session Resolution

Main file:

- `src/packages/server/conat/api/hosts-cloud-lifecycle.ts`

Key function:

- `resolveBillableHostSessionConfig(...)`

This function:

1. checks whether the provider is a billable dedicated cloud
2. estimates the hourly rate with
   `estimateDedicatedHostRateUsdPerHour(...)`
3. throws `code: "host_pricing_unavailable"` if pricing is unknown
4. loads the dedicated-host admission snapshot
5. resolves the final funding mode / funding lane for the session

The resolved shape is effectively:

- `site-funded`
- `account-prepaid` + `prepaid` lane + hourly rate
- `account-postpaid` + `credit` lane + hourly rate

## Create-Time Host Persistence

Main file:

- `src/packages/server/conat/api/hosts-cloud-lifecycle.ts`

Key function:

- `createHostInternalHelper(...)`

Current create-time behavior:

1. normalize the requested host/provider config
2. resolve the billable session config
3. insert the `project_hosts` row
4. persist host billing metadata derived from the session
5. if billable and not `site-funded`, reconcile the purchase session
6. enqueue the provider provisioning work

The persisted host metadata is the bridge between control-plane lifecycle and
purchase/session lifecycle.

## Start-Time Reconciliation

Main file:

- `src/packages/server/conat/api/hosts-cloud-lifecycle.ts`

Key function:

- `startHostInternalHelper(...)`

Start currently re-runs the same essential billing logic:

- resolve billable session config again
- update metadata billing fields
- reconcile the dedicated-host purchase session again

That is good: it means create and later restarts both converge onto the same
billing truth rather than assuming old state is still valid.

## Where Hourly Cost Comes From

Main file:

- `src/packages/server/project-host/spend.ts`

Key function:

- `estimateDedicatedHostRateUsdPerHour(...)`

Provider-specific estimators currently include:

- `estimateGcpRateUsdPerHour(...)`
- `estimateNebiusRateUsdPerHour(...)`

These load the latest cached provider catalog from:

- `cloud_catalog_cache`

They also apply provider surcharge settings, so the host purchase path already
uses the customer-facing sell rate rather than raw provider cost.

## Where Purchase Sessions Are Created And Updated

Main file:

- `src/packages/server/project-host/spend.ts`

Core dedicated-host purchase/session functions:

- `listOpenDedicatedHostPurchasesLocal(...)`
- `closeDedicatedHostPurchaseSessionLocal(...)`
- `reconcileDedicatedHostPurchaseSessionLocal(...)`
- `rotateDedicatedHostPostpaidSegmentForClosingDateLocal(...)`
- `reconcileDedicatedHostPurchaseSessionForAccount(...)`
- `closeDedicatedHostPurchaseSessionForAccount(...)`

Session identity conventions:

- `service = "dedicated-host"`
- `tag = "dedicated-host:<host_id>"`

Important architectural point:

- purchase mutations happen on the account home bay
- if the current bay is not the home bay, the code forwards through inter-bay
  service calls

So the dedicated-host billing path is already aligned with the broader
cross-bay purchases architecture.

## Where Charges Are Recorded

Main file:

- `src/packages/server/purchases/create-purchase.ts`

Dedicated-host charges are recorded as rows in:

- `purchases`

They are not stored in a separate dedicated-host billing table.

The dedicated-host purchase rows are metered purchases with fields such as:

- `cost_per_hour`
- `period_start`
- `period_end`
- `cost`

The session is opened with a rate and a start time, and the final cost is
materialized when the session is closed or rotated.

This is important for the next billing step:

- “monthly billing / renewal” will likely be built on top of existing purchase
  session segmentation and statement generation, not a totally separate billing
  system

## Background Spend Maintenance

Main file:

- `src/packages/server/project-host/spend-maintenance.ts`

Entry point:

- `runDedicatedHostSpendMaintenancePass()`

Current responsibilities:

- scan candidate dedicated hosts
- close purchase sessions for hosts that are no longer billable
- re-estimate current hourly cost
- update billing metadata
- reconcile purchase sessions when rate/lane/status changes
- stop hosts whose funding lane or pricing is no longer valid

The enforcement helper today is:

- `requestHostStopForExceededLane(...)`

That means the current implementation is closer to:

- “stop when billing can no longer continue”

than to:

- “drain, ensure final backup, stop, then deprovision on hard limit”

## Current Gap Relative To Desired Product Behavior

The largest semantic gap is not basic metering. The metering path already
exists.

The main gap is end-of-funds/end-of-lane behavior.

### Current behavior

- close or reconcile purchase session
- request host stop when billing cannot continue

### Desired behavior

- route through host drain
- ensure final backup completes
- use `managed_egress_override: "admin-host-drain"` when needed
- stop the host near the limit
- deprovision at the hard limit
- preserve user data in backups rather than deleting it

Relevant drain/backup path anchors:

- `src/packages/server/conat/api/hosts-drain.ts`
- `src/packages/project-host/backup-egress.ts`
- `src/packages/project-host/raw-network-egress.ts`
- `src/packages/server/projects/backup-worker.ts`

## Practical Reading Order For Implementation

If implementing recurring-host billing semantics next, the shortest useful
reading order is:

1. `src/packages/server/conat/api/hosts.ts`
2. `src/packages/server/conat/api/hosts-cloud-lifecycle.ts`
3. `src/packages/server/project-host/admission.ts`
4. `src/packages/server/project-host/spend.ts`
5. `src/packages/server/project-host/spend-maintenance.ts`
6. `src/packages/server/purchases/create-purchase.ts`
7. `src/packages/server/purchases/statements/*`

That is the minimal path for understanding:

- who is allowed to buy
- what hourly rate is used
- where the metered session opens
- where it is reconciled
- where it is closed
- where the current stop-on-exhaustion policy needs to change

