# Project Host Metrics Plan

## Why This Is Core

CoCalc fundamentally overcommits project-host storage:

- a host may have thousands of assigned projects
- each project may have a nominal disk quota such as `10 GB`
- actual usage is usually far lower for the vast majority of projects
- growth is bursty and uneven

This means the system cannot be run safely using only:

- static host disk sizes
- per-project nominal quotas
- point-in-time free-space checks

The system must understand:

- current host resource state
- recent rate of growth
- active storage-heavy operations already in flight
- projected exhaustion risk

This is especially important for:

- project start reliability
- OCI image pulls
- RootFS pulls/restores
- backup restore
- future guarded automatic disk enlargement
- placement and rebalancing decisions

The metrics subsystem must be part of CoCalc itself, not only external Prometheus.
Prometheus can be added later as an export path, but the control plane, UI, and
`cocalc-cli` need direct access to the same data and derived decisions.

## Current State

What exists today:

- project-host heartbeat already updates the `project_hosts` row regularly
- current host metadata already includes live `host_cpu_count`, `host_ram_gb`,
  `host_session_id`, and version/build information
- `/hosts` already renders host list/card/detail views with live status
- there is no real host metrics time-series model
- there is no integrated host metrics UI beyond coarse status
- there is no host-local reservation ledger for storage-heavy operations
- there is no conservative low-disk admission control for OCI or RootFS pulls

So the system already has:

- a control-plane transport path
- a host object in the DB
- a host admin UI
- a CLI surface that can be extended

The missing piece is a first-class metrics model.

## Goals

### Product Goals

- Make host health visible in UI and CLI.
- Make storage-heavy operations fail fast when the host is likely to run out of
  disk.
- Use the same metrics for:
  - placement
  - admission
  - auto-grow
  - later rebalancing and drain decisions

### Technical Goals

- Collect metrics on every project-host with low overhead.
- Persist current metrics and recent history centrally.
- Support simple derived metrics such as growth rate and exhaustion forecast.
- Track both physical usage and CoCalc software reservations.

### Non-Goals For V1

- perfect forecasting
- full observability platform replacement
- arbitrary long-term high-resolution retention
- highly detailed per-process metrics

## Design Principles

1. Host-local measurement, hub-central persistence.
2. Conservative storage decisions are better than optimistic ones.
3. Time-series history matters as much as current values.
4. Btrfs-specific metadata pressure must be surfaced explicitly.
5. Reservation-based admission should be software-managed, even if Btrfs has
   quota primitives.
6. Everything surfaced in the UI should also be available in `cocalc-cli`.

## Metrics To Collect

### CPU

- `cpu_percent`
- `load_1`
- `load_5`
- `load_15`
- optionally `iowait_percent` later

Why:

- host saturation
- placement decisions
- understanding when OCI/RootFS activity is CPU-bound
- giving users better information about which shared host to select, or whether
  they want a dedicated host
- giving admins a better sense of shared-host resource utilization

### GPU

For hosts with one or more GPUs, add GPU metrics as part of the current
snapshot and history model.

- `gpu_count`
- `gpu_util_percent[]`
- `gpu_memory_used_bytes[]`
- `gpu_memory_total_bytes[]`
- optionally `gpu_temperature_c[]` later

Why:

- GPU hosts are expensive and should be monitored explicitly
- users need better information about which shared GPU host to choose
- admins need visibility into whether GPU hosts are actually utilized
- memory pressure on GPU hosts is often as important as CPU or RAM pressure

### Memory

- `memory_total_bytes`
- `memory_used_bytes`
- `memory_available_bytes`
- `memory_used_percent`
- `swap_total_bytes`
- `swap_used_bytes`

Why:

- startup reliability
- identifying pressure from image extraction, rustic, and project workloads

### Disk / Btrfs

Measure against `/mnt/cocalc` and the underlying btrfs filesystem.

- `disk_device_total_bytes`
- `disk_device_used_bytes`
- `disk_unallocated_bytes`
- `btrfs_data_total_bytes`
- `btrfs_data_used_bytes`
- `btrfs_metadata_total_bytes`
- `btrfs_metadata_used_bytes`
- `btrfs_system_total_bytes`
- `btrfs_system_used_bytes`
- `btrfs_global_reserve_total_bytes`
- `btrfs_global_reserve_used_bytes`
- `disk_available_conservative_bytes`
- `disk_available_for_admission_bytes`
- `reservation_bytes`

Why:

- Btrfs can fail due to metadata exhaustion while naive free-space still looks
  acceptable.
- `disk_available_for_admission_bytes` must subtract active software
  reservations.

### Project / Runtime Inventory

- `assigned_project_count`
- `running_project_count`
- `starting_project_count`
- `stopping_project_count`
- `rootfs_cached_image_count`
- optionally `rootfs_cache_bytes`
- optionally `podman_image_store_bytes`

Why:

- operational load and cache pressure
- later placement and rebalance heuristics

### Storage Admission State

- `active_oci_pull_count`
- `active_rootfs_pull_count`
- `active_restore_count`
- `active_publish_count`
- `reservation_bytes_total`
- `reservation_bytes_by_kind`

Why:

- a point-in-time free-space check is not enough when multiple large operations
  run in parallel

## Collection Strategy

### On The Project Host

Add a lightweight metrics collector under project-host, likely owned by the
master process.

Responsibilities:

- sample host metrics every `15s`
- maintain a small in-memory current snapshot
- maintain a small local ring buffer or sqlite-backed recent samples
- expose the latest snapshot for heartbeat publishing

Suggested data sources:

- CPU / load / RAM:
  - `node:os`
  - `/proc/meminfo` if needed for better memory detail
- Btrfs:
  - parse `btrfs filesystem usage` output for `/mnt/cocalc`
  - later prefer a machine-readable command if available
- Project counts:
  - local sqlite project table
  - later add “RAM used by each running project” as a local-only detailed view
- RootFS cache:
  - existing cache inventory code
- Storage reservations:
  - new local reservation ledger table

The collector should be resilient:

- failure to collect one category must not kill the heartbeat
- every sample should include `collected_at`
- include parse/version markers for Btrfs collectors so changes are diagnosable

## Hub Persistence Model

Use two layers.

### Layer 1: Current Snapshot On `project_hosts`

Store the latest sample summary in `project_hosts.metadata`, for example:

- `metrics.current`
- `metrics.collected_at`
- `metrics.health`
- `metrics.storage`

This makes current status cheap for:

- host list
- host drawer
- placement checks
- CLI summary commands

### Layer 2: Time-Series History

Add a new hub-side table, e.g.:

- `project_host_metrics_samples`

Suggested columns:

- `host_id`
- `collected_at`
- `cpu_percent`
- `load_1`
- `load_5`
- `load_15`
- `memory_total_bytes`
- `memory_used_bytes`
- `memory_available_bytes`
- `swap_total_bytes`
- `swap_used_bytes`
- `disk_device_total_bytes`
- `disk_device_used_bytes`
- `disk_unallocated_bytes`
- `btrfs_data_total_bytes`
- `btrfs_data_used_bytes`
- `btrfs_metadata_total_bytes`
- `btrfs_metadata_used_bytes`
- `btrfs_system_total_bytes`
- `btrfs_system_used_bytes`
- `btrfs_global_reserve_total_bytes`
- `btrfs_global_reserve_used_bytes`
- `disk_available_conservative_bytes`
- `disk_available_for_admission_bytes`
- `reservation_bytes`
- `assigned_project_count`
- `running_project_count`
- `starting_project_count`
- `stopping_project_count`
- `rootfs_cached_image_count`

Retention suggestion for V1:

- 30 days at 1-minute resolution

Ingest strategy:

- host sends a current snapshot with every heartbeat
- hub writes the `project_hosts.metadata.metrics.current` view immediately
- hub inserts a time-series sample only when:
  - at least 60 seconds elapsed since the previous sample for that host, or
  - a material change threshold is crossed

This keeps storage reasonable while still preserving useful curves.

## Derived Metrics

These should be computed centrally, not on the host.

### Growth Rates

Compute from the time-series:

- `disk_growth_bytes_per_hour_1h`
- `disk_growth_bytes_per_hour_24h`
- `metadata_growth_bytes_per_hour_1h`
- `metadata_growth_bytes_per_hour_24h`

Why:

- project hosts are intentionally oversubscribed
- the risk is not just current fullness but how quickly it is changing

### Exhaustion Forecast

Compute conservative projections such as:

- `hours_to_disk_exhaustion`
- `hours_to_metadata_exhaustion`

Only emit when growth is positive and signal quality is good.

### Placement / Admission Health

Derived booleans:

- `disk_risk = healthy | warning | critical`
- `metadata_risk = healthy | warning | critical`
- `admission_allowed = true | false`
- `auto_grow_recommended = true | false`

## UI Plan

### `/hosts` List

Add compact sparkline columns or badges for:

- CPU
- memory
- disk
- projects

Each row should also show current values:

- CPU percent
- memory percent
- disk percent or conservative available bytes
- running project count

Warnings:

- low disk
- low metadata headroom
- high growth rate
- active storage reservations

### Host Drawer

Add a detailed metrics section with:

- last hour sparklines
- current snapshot
- derived risk summary
- reservation summary
- recent automatic disk growth events later

### RootFS / Backup / Start UX

Longer term, use these host metrics in UX copy:

- “Host low on disk; pull blocked”
- “Host metadata pressure too high”
- “Waiting for storage reservation”

## CLI Plan

Expose the same data in `cocalc-cli`.

Suggested commands:

- `cocalc host metrics <host-id>`
- `cocalc host metrics <host-id> --window 24h`
- `cocalc host metrics list`
- `cocalc host storage <host-id>`
- `cocalc host reservations <host-id>`

Output modes:

- human summary
- JSON for automation and Codex workflows

Codex/admin usage should not require scraping UI text.

## Storage Admission Plan

Metrics collection should feed directly into a new host-local admission layer.

### Reservation Ledger

Add a host-local sqlite table for active storage reservations.

Columns:

- `reservation_id`
- `kind`
- `project_id`
- `op_id`
- `estimated_bytes`
- `created_at`
- `expires_at`
- `state`

Kinds:

- `oci-pull`
- `rootfs-pull`
- `backup-restore`
- `rootfs-publish`

Rules:

- reserve before large storage-heavy work starts
- subtract active reservations from conservative free space
- release on completion
- expire stale reservations after crash/restart

### Why Metrics First Still Makes Sense

Metrics and admission are tightly connected, but metrics should land first
because:

- the same metrics are needed regardless of the exact admission algorithm
- we need historical baselines to tune reservation margins
- growth-rate data is essential for deciding when to auto-grow

So the right order is:

1. collect and persist metrics
2. show current metrics and history
3. build reservation-based admission using those metrics

## Auto-Grow Plan

This is not a V1 metrics feature, but metrics should prepare for it.

Per-host or per-host-group config should support:

- `auto_grow_enabled`
- `current_disk_gb`
- `max_disk_gb`
- `growth_step_gb`
- `min_grow_interval_minutes`
- `grow_threshold_available_bytes`
- `grow_threshold_metadata_percent`

Expected policy:

- reservation fails
- if auto-grow allowed and below cap, grow disk
- wait for filesystem to observe new capacity
- retry reservation once
- otherwise fail cleanly

The initial implementation should start with GCP only.

Operational policy:

- likely early production providers are GCP and Nebius
- implement and enable guarded auto-grow on GCP first
- add Nebius only after its resize semantics are verified
- if a provider requires reboot for disk growth, keep larger headroom and use
  stricter thresholds there instead of pretending it behaves like GCP

## Implementation Phases

### Phase 1: Current Snapshot Plumbing

- add host metrics collector on project-host
- publish current metrics in heartbeat metadata
- expose them in hub Host API
- show current values in `/hosts`

Deliverable:

- operators can see current CPU, memory, disk, metadata, and project counts

### Phase 2: Time-Series History

- add `project_host_metrics_samples`
- ingest one-minute samples
- add basic sparklines to `/hosts`
- add CLI read paths

Deliverable:

- operators can see history and growth rates

### Phase 3: Derived Risk + Alerts

- compute growth rates
- compute exhaustion forecasts
- compute disk / metadata risk states
- show warning badges in UI and CLI

Deliverable:

- metrics become actionable, not just descriptive

### Phase 4: Storage Reservations

- add host-local reservation ledger
- wire OCI pull and RootFS pull through reservation admission
- return clear terminal no-space errors instead of looping

Deliverable:

- start/pull workflows stop failing catastrophically under low disk

### Phase 5: Guarded Auto-Grow

- add grow policy config
- implement GCP disk growth path
- surface grow events/history in UI and CLI

Deliverable:

- hosts recover automatically from predictable safe growth cases

## Validation Plan

### Metrics Accuracy

- compare CPU/memory against `top`, `free`, `uptime`
- compare disk/Btrfs values against `btrfs filesystem usage /mnt/cocalc`
- compare project counts against local sqlite and host inventory

### Time-Series

- verify samples persist at expected cadence
- verify sparklines match recent samples
- verify CLI JSON output is stable

### Stress

- run multiple OCI pulls and RootFS pulls in parallel
- verify reservations reduce available admission capacity
- verify operations fail fast when reservation cannot be granted

### Failure Modes

- collector command failure
- host restart with stale reservations
- DB outage during metrics ingest
- malformed Btrfs output

## Initial Decisions

- treat Ubuntu as the primary supported environment for the first Btrfs metrics
  collector
- keep raw one-minute samples for 7 days, then roll up
- defer `rootfs_cache_bytes` and `podman_image_store_bytes` until after current
  disk and metadata metrics land
- use growth-rate-derived risk in placement as soon as we have enough history
  to compute a coarse, conservative signal
- when host-local reservations survive a host restart in an uncertain state,
  surface an explicit unstable reservation tag with a popover explanation in UI
  and CLI

## Open Questions

- Which Btrfs command and parser shape are the most stable for Ubuntu across
  the versions we actually deploy?
- What is the best low-overhead source for per-project RAM usage on running
  projects?
- Does Nebius disk growth require reboot in the configurations we plan to run?

## Recommendation

Do metrics first, but do them in a way that directly prepares storage admission.

The next concrete task after this plan should be:

- Phase 1 current snapshot plumbing

That gives immediate operator value and produces the data we need to tune
reservation margins instead of guessing.
