# Project Host Spot Instances Plan

Last refreshed: April 8, 2026

Status: design and implementation roadmap.

This note describes how CoCalc project hosts should support spot / preemptible
/ discounted interruptible VMs on both GCP and Nebius.

The goal is not just "let admins request a cheaper VM". The control plane,
project-host lifecycle, admin UI, CLI, and project placement UX must all
understand the tradeoff:

- lower cost
- materially higher interruption risk
- hosts may disappear underneath running projects

This document focuses on a practical first implementation that is safe,
operator-friendly, and extendable.

## Executive Summary

We should support spot instances as a first-class host lifecycle feature.

The core product direction is:

1. admins can create hosts as either on-demand or spot
2. the host list and host detail UI make this obvious
3. if a project host goes offline, the control plane checks the cloud provider
   to determine whether the host was interrupted
4. if a spot interruption happened and the host policy says to restore it, the
   control plane recreates or restarts the VM immediately
5. users choosing where to create or move projects are shown the host's risk
   and operating history, not just its name

The key implementation decision is:

- do not model this as only `spot: boolean`

Instead, introduce a small normalized host lifecycle model that can cover both
providers cleanly and can evolve later.

## Goals

- support spot / interruptible hosts on GCP and Nebius
- expose spot status consistently in host config, admin UI, and CLI
- detect cloud-driven interruption instead of treating every offline host the
  same
- automatically restore interrupted spot hosts when policy requires it
- expose meaningful spot tradeoff information to end users during project
  placement
- record enough history to understand whether a host is stable in practice

## Non-Goals

- full autoscaling
- full predictive rebalancing of projects before an interruption
- provider-agnostic abstraction of every VM feature
- solving all placement quality issues in this same change

Those can follow later. This phase is about foundational support.

## Why This Matters

The price delta for spot VMs is often large enough that we should expect to use
them heavily for:

- burst capacity
- lower-tier shared hosts
- experiments
- background / tolerant workloads

Without explicit support, spot VMs are dangerous because they fail like random
host outages. That is operationally noisy and deeply confusing for users.

We need the product to distinguish:

- ordinary host failure
- operator stop/delete action
- cloud spot interruption

## Normalized Model

Use a normalized host market/lifecycle model in the host description.

Recommended fields:

- `pricing_model: "on_demand" | "spot"`
- `interruption_restore_policy: "none" | "immediate"`
- `provider_lifecycle_kind: "standard" | "interruptible"`
- `provider_started_at?: timestamp`
- `provider_instance_id?: string`
- `provider_instance_generation?: string`

Operational fields that can be derived and cached:

- `uptime_s`
- `last_provider_state`
- `last_provider_state_checked_at`
- `last_interruption_at`
- `interruption_count_24h`
- `interruption_count_7d`

We can expose a convenience boolean in APIs/UI:

- `is_spot = pricing_model === "spot"`

But the persisted model should remain slightly richer than a bare boolean.

## Host Description Changes

The host description stored by the control plane should gain:

- market choice
- interruption restore policy
- provider-side runtime metadata

This host metadata must be available to:

- the `/hosts` admin page
- the host creation flow
- CLI host creation / update commands
- host detail / list views
- placement UIs for projects

NOTE: The `interruption_restore_policy` must strongly prefer "immediate" because users lose access to their files when the host is off, and the only way to move a project is to restore from the last backup, which could be a day old.

## Admin UI Changes

### `/hosts` Create / Edit

Add explicit controls:

- pricing model:
  - on-demand
  - spot
- interruption restore policy:
  - no automatic restore
  - restore immediately after confirmed cloud interruption  (strongly preferred) 
    Provider-specific copy should be shown inline:
- spot hosts may disappear unexpectedly
- running projects may be interrupted
- the system may automatically bring the VM back, but that is not the same as
  uninterrupted service

### `/hosts` Listing / Detail

Each host row should clearly show:

- spot vs on-demand
- how long the current VM has been running
- recent interruption count
- recent load history summary
- whether the current instance has been replaced recently
  Suggested compact labels:
- `spot`
- `on-demand`
- `uptime 3d 4h`
- `2 interruptions / 7d`

## CLI / Backend Host Creation

The CLI and backend host creation APIs should accept:

- `--pricing-model on_demand|spot`
- `--interruption-restore-policy none|immediate`
  The backend API should validate:
- `spot` may only be used with providers that support interruptible capacity
- restore policy is only meaningful for interruptible hosts
  The host spec saved in the database should preserve these values exactly.

## Provider Integration

Each provider integration must expose a normalized cloud lifecycle check.
Proposed provider adapter surface:

- `getInstanceLifecycle(host): Promise<{`
- `exists: boolean;`
- `state: "running" | "stopped" | "terminated" | "unknown";`
- `pricing_model?: "on_demand" | "spot";`
- `interruption_detected: boolean;`
- `started_at?: string;`
- `provider_instance_id?: string;`
- `reason?: string;`
- `}>`
  This is the key abstraction layer.
  The control plane should not need to know every provider-specific detail; it
  should only need a normalized answer about whether the current VM was likely
  interrupted by the cloud.

### GCP

Implementation work:

- provision spot hosts correctly through the existing GCP host creation path
- query instance state from the GCP provider integration when a host goes
  offline
- normalize whether the instance was interrupted vs stopped for some other
  reason

### Nebius

Implementation work:

- provision interruptible / spot hosts correctly in the Nebius path
- query instance state from Nebius APIs when a host goes offline
- normalize the same answer as GCP into the shared lifecycle model
  Important note:
- provider semantics should be revalidated during implementation rather than
  hardcoded from memory into this plan

## Offline Detection and Restore Flow

The control-plane offline path should become:

1. host heartbeat is missing
2. mark host as `suspect_offline`
3. query provider lifecycle state
4. classify the event:
   - cloud interruption
   - ordinary stop
   - deleted instance
   - unknown
5. if classification is `cloud interruption` and host policy is
   `interruption_restore_policy=immediate`, recreate or restart the host
6. record a host event and update interruption counters
   This must not be "every offline host gets restarted". The provider check is the
   decision point.

## Restore Semantics

For spot hosts, the system should treat restore as:

- bring back the same logical host record
- accept that the underlying VM instance may be a new provider instance
- update host runtime metadata accordingly
  That means the host record is durable, while the VM under it may be replaced.
  Questions to resolve in implementation:
- does the existing provisioner support restarting the same VM cleanly, or is
  recreate the correct operation?
- should the host record keep a stable `host_id` while the provider instance id
  changes?
  The likely answer is yes: stable CoCalc `host_id`, changing provider instance
  identity.

NOTE: Certainly on GCP and (probably on Nebius) the underlying disk is unchanged.   In particular, spot interrupt is basically the same as a "stop then start" cycle for us.  There's no need to do the full bootstrap (e.g., apt-get install, etc...).  The fully configured root filesystem should already be in place.   There are other clouds for which interruption is far more invasive, but that's not what we're considering here.

NOTE: Configuration could include a fallback instance type if the preferred instance type is not available.  E.g., prefer c2d-standard-8, but fall back to e2-standard-8 if c2d-standard-8 fails.  With GCP often one instance type is available but others aren't, and there's just a slight difference in speed between them.  It's better to make *something* available to users than nothing.  Obviously implementing this properly is complicated.

## Host Event History

We should record host lifecycle events explicitly.

Suggested events:

- `host.created`
- `host.started`
- `host.stopped`
- `host.offline_detected`
- `host.spot_interrupted`
- `host.restore_requested`
- `host.restore_succeeded`
- `host.restore_failed`

Each event should include:

- host id
- provider
- pricing model
- provider instance id if known
- timestamp
- short reason / classification

This is important both for operator debugging and for UI presentation.

## Project Placement UX

When a user creates or moves a project, the host choice UI should show more
than just the host name.

Recommended information per host:

- host name / label
- provider / region
- spot vs on-demand
- uptime
- recent interruption count
- recent load summary
- short spot warning if applicable

For example:

- `host-us-west1-a-17`
- `GCP us-west1-a`
- `spot`
- `uptime 18h`
- `3 interruptions / 7d`
- `load last 24h: cpu 28%, ram 42% avg`

### Spot Warning Copy

The wording should be blunt and short:

- cheaper host
- may be interrupted unexpectedly
- good for restart-tolerant work

### Load History

The placement UI should eventually show historical load metrics derived from
existing or planned host metrics. For the first phase, even a summary is enough:

- average CPU / RAM over recent windows
- current running project count
- optional recent max load

## Host Age / Uptime

We should surface:

- time since the current VM instance started

This matters because:

- a spot host that has been up for 9 days is qualitatively different from one
  that was recreated 10 minutes ago
- users can use uptime as a weak stability signal

## Recommended Phase Breakdown

### Phase 1: Schema and Visibility

Implement:

- host description fields
- backend validation
- CLI flags
- `/hosts` create/edit/list support
- host row display of spot vs on-demand

No restore automation yet.

Success criteria:

- admins can create spot hosts
- host list clearly shows which hosts are spot

### Phase 2: Provider Lifecycle Detection

Implement:

- GCP lifecycle query
- Nebius lifecycle query
- normalized offline classification
- host event logging for interruptions

Success criteria:

- when a spot host disappears, the control plane can distinguish interruption
  from generic offline behavior

### Phase 3: Automatic Restore

Implement:

- interruption restore policy
- immediate restore flow
- host event history updates
- operator logs / metrics

Success criteria:

- interrupted spot host is automatically brought back according to policy

### Phase 4: Placement UX

Implement:

- create/move project host chooser metadata
- uptime display
- interruption count display
- load history summary
- spot tradeoff copy

Success criteria:

- users can make informed host choices without needing admin-only knowledge

## Suggested Internal API Surface

Control-plane service methods:

- `classifyHostOffline(hostId): Promise<OfflineClassification>`
- `maybeRestoreInterruptedSpotHost(hostId): Promise<RestoreResult>`
- `getHostPlacementInfo(hostId): Promise<HostPlacementInfo>`

Suggested result shapes:

- `OfflineClassification = {`
- `  kind: "cloud_interruption" | "operator_stop" | "generic_offline" | "unknown";`
- `  provider_state?: string;`
- `  reason?: string;`
- `}`

- `HostPlacementInfo = {`
- `  host_id: string;`
- `  provider: string;`
- `  region?: string;`
- `  pricing_model: "on_demand" | "spot";`
- `  uptime_s?: number;`
- `  interruption_count_7d?: number;`
- `  load_summary?: { cpu_avg?: number; ram_avg?: number; project_count?: number };`
- `}`

## Metrics and Alerts

Add or derive metrics for:

- spot interruptions total
- restores attempted
- restores succeeded
- restores failed
- average restore duration
- hosts currently running as spot

Alerting ideas:

- repeated interruption loop on one host
- repeated restore failures
- provider lifecycle lookup failures

## Testing Plan

### Unit Tests

- host schema validation
- CLI argument parsing
- provider lifecycle classification
- restore policy decisions

### Integration Tests

- create spot host through backend
- render spot host in `/hosts`
- simulate host heartbeat loss and provider interruption classification
- simulate restore decision

### Smoke Tests

Per provider:

- create spot host
- start a project there
- verify host list labels and details
- simulate interruption path if feasible, otherwise validate on a real
  interruption incident

## Risks

### Risk: Repeated interruption loops

A spot host could be interrupted repeatedly.

Mitigation:

- track interruption frequency
- consider temporary cooldown after repeated immediate restore failures

### Risk: Users misunderstand spot stability

Mitigation:

- clear placement copy
- clear host labels
- interruption history visible in the UI

### Risk: Provider semantics differ subtly

Mitigation:

- keep provider-specific logic inside provider adapters
- normalize only the minimal lifecycle signals needed by the control plane

## Open Questions

- should restore always recreate, or sometimes restart the same provider
  instance?   ANS: always restart.  Shutdown is soft so should be safe, and the data is there; just starting the instance back up should be much faster than a full bootstrap.
- should spot hosts be excluded from some project tiers by policy? ANS: membership tiers will I think have a number of running projects users can have for each tier, and spot will be probably the lowest tier, so most available.  I'm not sure how to model this yet.
- should there be a future project-level preference like "avoid spot hosts"?  ANS: some membership tiers will only have spot instances.  Higher membership tiers will offer non-spot instances, and for them we can have a switch at the top of the host selector to not include spot instances.  It can be sticky, so when a user turns it on, it stays on for them.
- how much interruption history should be shown to end users vs only admins?  ANS: as much as we know should be _available_ to users, but don't show too much (they can click for more or see more in a tooltip).
- should host chooser rank on-demand hosts above spot hosts by default? ANS: should depend on the parameters of the membership tier -- i.e., we will have \$8/month and \$25/month users (say), and for \$8/month spot is all they get; for \$25/month they get on-demand too and for them on-demand should be listed higher.    Realistically, spot instance for _compute_ on GCP cost often roughly 1/10 th the price of on-demand, i.e., are massively cheaper... so it's much easier for us to offer them to users.  Also in my experience often spot instances -- suitably chosen -- will run a week or more no problem (in some locations for some cpu types!). So CPU spot instances are an extremely good value for users.... GPU instances are not. 

## Recommended First Implementation

If we want the highest-value first slice, do this:

1. add `pricing_model` and `interruption_restore_policy` to host descriptions
2. expose them in `/hosts` UI and CLI
3. implement provider-side offline classification for GCP and Nebius
4. automatically restore interrupted spot hosts
5. add spot labels, uptime, and interruption count to project placement UIs

That gets the main business value quickly while keeping the architecture sane.