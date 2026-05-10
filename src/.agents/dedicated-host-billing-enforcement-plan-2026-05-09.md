# Dedicated Host Billing Enforcement Plan

Status: proposed implementation plan as of 2026-05-09.

This plan defines the billing-risk enforcement behavior for managed dedicated
hosts.

The core policy is:

- do not silently exceed configured prepaid/postpaid exposure limits
- do not surprise users with much larger charges than their account limits imply
- do not destroy the only copy of user data
- do stop provider spend before it grows beyond the accepted risk window
- do keep final project data recoverable from normal R2 backups

## Current Starting Point

The metered purchase-session infrastructure already exists.

The current flow is documented in:

- `src/.agents/dedicated-host-purchase-path-trace-2026-05-09.md`

Important current files:

- `src/packages/server/conat/api/hosts.ts`
- `src/packages/server/conat/api/hosts-cloud-lifecycle.ts`
- `src/packages/server/project-host/admission.ts`
- `src/packages/server/project-host/spend.ts`
- `src/packages/server/project-host/spend-maintenance.ts`
- `src/packages/server/purchases/create-purchase.ts`

Current maintenance behavior:

- reconcile or close metered purchase sessions
- stop a running host when its active funding lane is exhausted

Current gap:

- exhaustion currently maps directly to provider stop
- it does not yet drive a drain/final-backup path
- it does not yet model warning, grace, recovery, or deprovision timing

## Design Goals

### User trust

Users should always be able to answer:

- why is my host at risk?
- when will it stop?
- when will the persistent disk be deprovisioned?
- what can I do to recover?
- has my project data been backed up?

### Cost control

CoCalc should not keep paying for:

- running VMs after billing is not allowed
- persistent disks indefinitely after payment is unrecoverable
- provider resources whose user-facing spend cap has already been reached

### Data safety

Billing enforcement must not delete the only copy of user data.

The intended final path is:

1. warn
2. drain and run final backups
3. stop the host
4. keep persistent disk briefly
5. deprovision provider resources
6. leave projects recoverable through normal R2 backup/archive mechanisms

After deprovision, R2 backups should be treated as normal archived project data,
not as a special dedicated-host billing artifact.

## Enforcement State Machine

Add an explicit billing enforcement state under `project_hosts.metadata.billing`.

Recommended field:

```ts
metadata.billing.enforcement = {
  state:
    | "ok"
    | "at_risk"
    | "draining"
    | "stopped_billing_blocked"
    | "deprovision_pending"
    | "deprovisioned_recoverable";
  reason_code?: string;
  reason?: string;
  first_detected_at?: string;
  at_risk_at?: string;
  drain_requested_at?: string;
  drain_completed_at?: string;
  final_backup_status?: "unknown" | "running" | "succeeded" | "failed";
  final_backup_completed_at?: string;
  stopped_at?: string;
  grace_until?: string;
  deprovision_after?: string;
  deprovision_requested_at?: string;
  deprovisioned_at?: string;
  recovery_actions?: Array<
    "add_funds" | "fix_payment" | "support_limit_increase"
  >;
}
```

This should stay in host metadata for v1 unless query patterns prove a real need
for indexed columns.

### `ok`

Meaning:

- host billing is valid
- current lane is allowed
- no enforcement action is pending

Transitions into `ok`:

- user adds prepaid funds
- user fixes payment / usage subscription
- site admin increases the relevant limits
- support manually clears a resolved enforcement state

### `at_risk`

Meaning:

- billing is still active, but the system predicts the host cannot safely keep
  running through the configured safety window
- user should be alerted
- starts/resizes that increase exposure should be blocked

Typical reasons:

- prepaid balance runway too low
- prepaid 5-hour window nearly exhausted
- prepaid 7-day window nearly exhausted
- postpaid 5-hour window nearly exhausted
- postpaid 7-day window nearly exhausted
- postpaid unbilled exposure near limit
- usage subscription or payment method became invalid
- price became unavailable

This state should record:

- reason code
- current hourly rate
- relevant limit and usage snapshot
- predicted stop time if available
- recovery actions

### `draining`

Meaning:

- the host should no longer accept new project placements
- the system is running a final drain/final-backup flow before provider stop

Required behavior:

- route through host drain:
  `src/packages/server/conat/api/hosts-drain.ts`
- pass `managed_egress_override: "admin-host-drain"` when the drain is
  administrative
- block new starts/resizes/placements except recovery actions

Final backup completion should be explicit:

- `final_backup_status = "running"`
- then `succeeded` or `failed`

If final backup fails, the system should not silently proceed to destructive
deprovision. It should stop compute if needed, record the failure, and require
operator review before deleting persistent storage.

### `stopped_billing_blocked`

Meaning:

- provider compute has been stopped
- persistent disk may still exist and still cost money
- user cannot start the host until billing is repaired or support changes limits

Allowed recovery actions:

- add prepaid funds
- fix payment method / usage subscription
- support request leading to admin limit increase

On recovery:

- re-run admission
- if allowed, clear enforcement state or set it to `ok`
- allow normal start/reprovision flow

### `deprovision_pending`

Meaning:

- persistent provider resources are still present
- final backup succeeded or operator explicitly allowed continuation after
  reviewing a failed backup
- grace period has expired or is close to expiring
- user should receive final warning before disk deprovision

This state should record:

- `deprovision_after`
- final backup status
- recovery actions

### `deprovisioned_recoverable`

Meaning:

- provider VM/disk/snapshots have been deprovisioned
- metered purchase session is closed
- host cannot be restarted in place
- projects are recoverable from normal backup/archive paths

This is not data deletion.

The UI should make this distinction explicit:

- "Provider disk removed"
- "Project data recoverable from backups"

## Funding Lanes And Limits

The current system has:

- prepaid lane
- postpaid/credit lane
- 5-hour rolling usage limit
- 7-day rolling usage limit
- postpaid unbilled exposure limit
- monthly closing/statement cycle

Existing code:

- `getDedicatedHostWindowUsageLocal(...)`
- `getDedicatedHostPostpaidUnbilledExposureLocal(...)`
- `isDedicatedHostLaneCurrentlyAllowed(...)`
- `rotateDedicatedHostPostpaidSegmentForClosingDateLocal(...)`

### Prepaid

Prepaid should be controlled by both:

- balance runway
- rolling usage windows

The system should not wait for exact zero balance.

Recommended logic:

- compute current hourly cost
- compute available prepaid balance
- compute hours of runway
- compute remaining 5-hour and 7-day window capacity
- enter `at_risk` when any runway/capacity falls below the configured drain
  safety window
- enter `draining` before the balance or window reaches hard exhaustion

Recommended v1 defaults:

- warn when runway is below 2 hours
- begin drain when runway is below 1 hour
- stop immediately if the lane is already exhausted

These should be settings, not hard-coded permanent policy.

### Postpaid

Postpaid should be controlled by:

- rolling 5-hour credit spend
- rolling 7-day credit spend
- unbilled exposure
- payment method / usage subscription health
- monthly closing/statement rotation

The system should not allow postpaid spend to exceed the configured exposure
limit by a large margin.

Recommended logic:

- compute current hourly cost
- compute remaining room in 5-hour and 7-day credit windows
- compute remaining unbilled exposure room
- estimate runway to the earliest limiting cap
- enter `at_risk` when runway is below the warning window
- enter `draining` before any hard cap is crossed

Failed monthly payment should not immediately deprovision. It should move active
hosts into the same at-risk/drain/stop/deprovision path.

### Site-funded

Site-funded hosts are not charged to a user account and should not use the
account-level prepaid/postpaid enforcement path.

They still need provider-cost observability and operator alerts, but they should
not be stopped by user funding-lane exhaustion.

## Support / Admin Recovery

Recovery is not limited to user self-service payment actions.

A support request can lead to a site admin increasing limits.

The policy snapshot already reads membership limits and server settings. That
means recovery can be implemented by re-evaluating admission after an admin
changes:

- membership tier usage limits
- account membership
- postpaid unbilled limit
- site funding mode

UI and operator tools should list recovery actions as:

- add prepaid funds
- fix payment method / automatic billing
- contact support for a limit increase

Admin/operator tools should make it easy to see:

- limiting window
- current usage
- current hourly rate
- projected time to stop/deprovision
- whether final backup succeeded

## Notifications

This plan should use existing notification mechanisms where possible.

Minimum notification events:

- host enters `at_risk`
- drain/final backup starts
- host stopped due to billing
- persistent disk deprovision is scheduled
- deprovision completed
- recovery succeeded
- final backup failed

Notifications should include:

- host name
- provider/region
- current hourly rate
- reason
- next action and time
- recovery actions

Avoid wording that implies data has been deleted when only provider resources
have been stopped or deprovisioned.

## UI Requirements

Host list/card/edit modal should show billing enforcement status.

Minimum visible states:

- `Billing at risk`
- `Final backup running`
- `Stopped: billing required`
- `Disk removal scheduled`
- `Provider disk removed; projects recoverable from backup`

Start/restart behavior:

- blocked when state is `at_risk`, `draining`,
  `stopped_billing_blocked`, or `deprovision_pending`
- allowed after admission succeeds and enforcement is cleared
- reprovision from backup is a separate path once state is
  `deprovisioned_recoverable`

The UI should always show the recovery actions:

- add funds
- fix payment
- contact support for a limit increase

## Implementation Plan

### Phase 1: Policy model and pure evaluation

Add a pure evaluator, likely in:

- `src/packages/server/project-host/spend-enforcement.ts`

Inputs:

- host row
- current billing metadata
- account policy snapshot
- hourly rate
- current time
- configurable thresholds

Output:

- next enforcement state
- reason code
- recovery actions
- recommended action:
  - none
  - notify
  - request drain
  - request stop
  - request deprovision

This evaluator should be heavily unit-tested before wiring it to side effects.

### Phase 2: Metadata persistence

Extend the metadata updates in:

- `src/packages/server/project-host/spend-maintenance.ts`

to preserve and update:

- `metadata.billing.enforcement`

The first implementation can keep state in metadata. Add DB columns only if
operator queries become painful.

### Phase 3: Replace stop-only exhaustion with drain-first enforcement

Replace or wrap:

- `requestHostStopForExceededLane(...)`

with a state-aware helper.

New behavior:

- if still safely billable, reconcile purchase session and stay `ok`
- if nearing exhaustion, write `at_risk` and notify
- if drain threshold reached, request host drain
- after drain/final backup succeeds, request provider stop
- after grace expires, request deprovision

The drain request should use:

- `src/packages/server/conat/api/hosts-drain.ts`
- `managed_egress_override: "admin-host-drain"`

### Phase 4: Final backup result tracking

The drain path must expose enough result data for spend maintenance to know:

- drain requested
- drain running
- drain completed
- final backups succeeded
- final backups failed

If current LRO result shape is insufficient, extend it narrowly.

The enforcement loop must not proceed from `draining` to destructive
deprovision after backup failure without explicit operator review.

### Phase 5: Grace and deprovision

Add configurable grace settings.

Recommended v1 settings:

- billing warning runway: 2 hours
- drain runway: 1 hour
- persistent disk grace after stop: 24-72 hours

The exact values can be site settings or environment-backed settings. They
should be visible to operators.

Deprovision should:

- close purchase sessions
- enqueue provider deprovision
- mark host as deprovisioned/recoverable
- preserve backup/archive metadata

### Phase 6: UI surface

Update frontend host components to show enforcement state:

- `src/packages/frontend/hosts/components/host-list.tsx`
- `src/packages/frontend/hosts/components/host-card.tsx`
- `src/packages/frontend/hosts/components/host-edit-modal.tsx`
- `src/packages/frontend/hosts/hooks/use-hosts-page-view-model.ts`

The UI should be explicit about the current provider spend state and recovery
path.

### Phase 7: Tests and smoke

Backend unit tests:

- pure evaluator tests for prepaid runway
- prepaid 5-hour window near/exhausted
- prepaid 7-day window near/exhausted
- postpaid 5-hour window near/exhausted
- postpaid 7-day window near/exhausted
- postpaid unbilled exposure near/exhausted
- payment method removed
- usage subscription removed
- admin limit increase recovery
- final backup failure blocks deprovision

Integration-ish tests:

- spend maintenance writes enforcement metadata
- spend maintenance requests drain instead of immediate stop
- closed purchase sessions remain correct
- deprovision happens only after grace and final backup success

Smoke tests:

- prepaid host runs, enters at-risk, drains, stops, recovers after funds added
- postpaid host runs, hits unbilled exposure, drains, stops, recovers after
  support limit increase
- backup failure case requires operator review
- deprovisioned host can restore projects to another host from backup

## Product Policy Decisions Still Needed

Before implementation, decide:

- exact warning runway: your 2 hours seems fine
- exact drain runway: your 1 hour seems fine.
- exact persistent disk grace: choose something (3 days?) and make it a constant; we can change the code later if it is bad.
- whether deprovision after backup failure is ever automatic: NO
- who receives notifications for shared/collaborative hosts: owner, who has to pay for it.
- whether admin limit increases clear enforcement automatically or require an
  explicit retry/recover action: good question, especially because there could easily be multiple hosts, and maybe only one should get cleared (?). It seems simplest though to make it automatic.

Recommended defaults for first hosted release:

- warning runway: 2 hours
- drain runway: 1 hour
- persistent disk grace: 48 hours
- backup failure: operator review required before deprovision
- admin limit increase: next maintenance pass clears enforcement if admission
  succeeds

## Non-Goals

This plan does not redesign:

- purchase rows
- statement generation
- R2 backup retention
- project backup sharding
- provider catalog/pricing

It builds on existing metered purchase sessions and changes the enforcement
behavior around them.
