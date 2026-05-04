**Plan**

I’d build this as a durable host recovery state machine, not more ad hoc logic.

**Goals**

- never show `running` unless the host is actually back
- recover spot hosts quickly
- cap outage time
- aggressively return from standard to spot to control cost
- survive hub restarts cleanly

**Phase 1: Durable Recovery Loop**
Use the existing cloud work queue, but make it schedulable.

Changes:

- add `not_before` to `cloud_vm_work`
- claim only due work items
- stop relying on the 5 minute / 30 minute reconcile cadence for restore timing

Reason:

- restore/backoff logic must survive hub restarts
- `setTimeout` is not enough
- this is the right primitive for `retry in 30s`, `probe again in 10m`, etc.

Files:

- [db.ts](/home/user/cocalc-ai/src/packages/server/cloud/db.ts)
- [worker.ts](/home/user/cocalc-ai/src/packages/server/cloud/worker.ts)
- [host-work.ts](/home/user/cocalc-ai/src/packages/server/cloud/host-work.ts)

**Phase 2: Explicit Per-Host Policy**
Store a host-owned policy in metadata, e.g. `metadata.spot_recovery_policy`.

Suggested fields:

- `spot_restore_retry_window_minutes`
- `spot_restore_backoff_seconds`
- `standard_fallback_enabled`
- `standard_fallback_min_minutes`
- `spot_probe_interval_minutes`
- `spot_return_requires_probe`
- `max_restore_attempts_before_fallback`
- `fallback_machine_type_override` (optional, later)
- `max_standard_runtime_minutes` (alerting, not enforcement)

Defaults:

- `x = 10`
- `y = 20`
- `z = 10`

These should absolutely be owner-adjustable.

Files:

- [hosts.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts.ts)
- [hosts-normalization.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-normalization.ts)

**Phase 3: Recovery State Machine**
Keep separate:

- `desired_pricing_model = spot`
- `effective_pricing_model = spot | standard`

And track recovery state, e.g. `metadata.spot_recovery_state`:

- `phase = idle | retrying_spot | running_standard_fallback | probing_spot | returning_to_spot`
- `outage_started_at`
- `attempt`
- `next_retry_at`
- `fallback_started_at`
- `last_probe_at`
- `last_probe_result`

Behavior:

1. spot interruption detected
2. host stays `off` or `starting`, never fake `running`
3. enqueue `start_spot` retries with backoff for up to `x` minutes
4. success only if:
   - provider says `RUNNING`
   - runtime refresh confirms it
   - host heartbeats / `project-host` becomes healthy
5. if not back by `x`, fallback to standard

Files:

- [spot-restore.ts](/home/user/cocalc-ai/src/packages/server/cloud/spot-restore.ts)
- [reconcile.ts](/home/user/cocalc-ai/src/packages/server/cloud/reconcile.ts)
- [host-work.ts](/home/user/cocalc-ai/src/packages/server/cloud/host-work.ts)

**Phase 4: Standard Fallback**
For GCP, use stopped-instance scheduling changes rather than creating a new logical host. That is the right fit here. GCP supports changing scheduling on a stopped VM via `instances.setScheduling`, and Spot semantics are documented separately:

- Spot VMs: https://cloud.google.com/compute/docs/instances/create-use-spot
- `setScheduling`: https://cloud.google.com/compute/docs/reference/rest/v1/instances/setScheduling

Behavior:

- when retry window expires:
  - stop if needed
  - change provisioning model to standard
  - start
  - verify
  - mark `effective_pricing_model=standard`

This preserves:

- host identity
- attached data disk
- existing assignment model

Files:

- [gcp.ts](/home/user/cocalc-ai/src/packages/cloud/gcp.ts)
- [types.ts](/home/user/cocalc-ai/src/packages/cloud/types.ts)
- [host-work.ts](/home/user/cocalc-ai/src/packages/server/cloud/host-work.ts)

**Phase 5: Probe And Return To Spot**
This should be aggressive, because cost matters.

Behavior:

- after `y` minutes on standard, enqueue `probe_spot`
- every `z` minutes after that:
  - create a same-shape, same-zone spot probe VM
  - if probe fails, keep standard host running
  - if probe succeeds:
    - delete probe
    - stop real host
    - switch real host back to spot
    - start and verify
- if switchback fails:
  - immediately return to standard
  - extend cooldown
  - continue probing later

I agree with you that auto-return should not wait for the host to be idle. Cost pressure is too high for that to be the default.

I would require:

- same zone
- same shape
for the probe in v1.

I would **not** do “smaller spot fallback” in v1. That is useful later, but it complicates the policy a lot.

**Phase 6: Observability**
Add explicit events:

- `spot_restore_retry_scheduled`
- `spot_restore_retry_failed`
- `spot_restore_fallback_standard`
- `spot_probe_started`
- `spot_probe_failed`
- `spot_probe_succeeded`
- `spot_return_started`
- `spot_return_failed`
- `spot_return_succeeded`

Surface in host UI/API:

- `desired_pricing_model`
- `effective_pricing_model`
- `recovery_phase`
- `outage_started_at`
- `fallback_started_at`
- `last_probe_result`

Files:

- [db.ts](/home/user/cocalc-ai/src/packages/server/cloud/db.ts)
- [hosts.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts.ts)

**What I Would Implement First**

1. `cloud_vm_work.not_before`
2. per-host recovery policy metadata
3. durable spot retry loop with real success criteria
4. GCP standard fallback via scheduling change
5. same-shape same-zone probe and return-to-spot
6. UI/API exposure

**What I Would Not Do Yet**

- smaller spot fallback
- cross-zone migration
- fleet-wide adaptive pricing policy
- reservation integration

Those are phase 2 features.

If you want, I can turn this plan directly into a concrete implementation checklist by file and schema change next.