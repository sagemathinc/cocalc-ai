# GPU MIG Slice Pool Plan, 2026-05-27

## Goal

Treat a GPU project host as a pool of schedulable GPU slices rather than one
raw device. For H200-class shared hosts, use NVIDIA MIG so hundreds of users
can safely share expensive GPU capacity without the first project that starts
being able to consume all GPU memory and compute.

This is a multi-tenant isolation feature, not merely a UI feature. The end
state is:

- users see GPU access as isolated slices with clear memory/compute size;
- host placement and project start allocate a slice before the container starts;
- Podman sees only the allocated MIG device, never `nvidia.com/gpu=all`;
- finished/stopped projects release their leases;
- membership/project-host access policy controls which slice sizes a user may
  use and how many concurrent GPU projects they may run.

## Context

Current code has host-level GPU awareness, but not project-level GPU allocation:

- host creation/provider metadata can record GPU type/count;
- `src/packages/server/project-host/control.ts` currently calls
  `applyHostGpuToRunQuota`, which sets `run_quota.gpu = true` when the selected
  host has any GPU;
- `src/packages/project-runner/run/podman.ts` then passes
  `--device nvidia.com/gpu=all` when `config.gpu` is true;
- bootstrap installs `nvidia-container-toolkit` and periodically regenerates
  `/etc/cdi/nvidia.yaml`.

That is acceptable for single-tenant/dedicated GPU hosts, but it is not
acceptable for shared H200 hosts. A lower-priority user can start first,
allocate all VRAM, and leave no usable GPU for higher-priority users.

Relevant NVIDIA docs:

- MIG user guide:
  https://docs.nvidia.com/datacenter/tesla/mig-user-guide/
- Supported MIG profiles:
  https://docs.nvidia.com/datacenter/tesla/mig-user-guide/supported-mig-profiles.html
- NVIDIA Container Toolkit CDI support:
  https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html

## Product Model

User-facing language should avoid implying that a low-cost subscription grants
exclusive access to an entire H200.

Recommended wording:

> GPU access: isolated H200 slice, shared host, scheduled by availability.

Show:

- GPU model, e.g. `H200`;
- slice profile, e.g. `1g`, `2g`, `3g`, `4g`, `7g`;
- approximate GPU memory, e.g. `~18 GiB`, `~35 GiB`, `~70 GiB`, `full GPU`
  depending on actual H200 profile reported by the host;
- whether the slice is currently allocated, queued, or unavailable.

For membership tiers, expose entitlements as policy, not promises about exact
inventory:

- allowed GPU slice classes;
- maximum simultaneous GPU projects;
- queue priority;
- optional default slice class.

Example policy:

- Tier 0: no GPU slice by default, can use CPU-only hosts.
- Tier 1: small MIG slice when available, one concurrent GPU project.
- Tier 2: small or medium MIG slice, one or two concurrent GPU projects.
- Admin/owner: any available slice, can reconfigure host layout.

## Architecture Decision

Use MIG as the hard isolation boundary. Do not use MPS/time-slicing as the
primary product mechanism for arbitrary user containers.

Reasons:

- MIG gives hardware-enforced GPU memory isolation.
- MIG gives a simple user mental model: one project sees one bounded GPU slice.
- Podman/CDI can expose an individual MIG device.
- A project that leaks GPU memory or runs a runaway CUDA job cannot consume
  another project's slice.
- Priority is handled by scheduling/queueing and slice size selection, not by
  trying to emulate CPU cgroup shares on a raw GPU.

Keep raw full-GPU passthrough only for explicitly dedicated/admin hosts.

## Data Model

Add durable tables instead of hiding slice state in `project_hosts.metadata`.
Metadata is still useful for display, but leases need transactional semantics.

### `project_host_gpu_layouts`

One row per host layout generation.

Fields:

- `id UUID PRIMARY KEY`
- `host_id UUID NOT NULL REFERENCES project_hosts(id) ON DELETE CASCADE`
- `generation INTEGER NOT NULL`
- `mode TEXT NOT NULL`
  - `disabled`
  - `raw_full_gpu`
  - `mig`
- `desired_profile_set TEXT`
  - e.g. `h200-many-small`, `h200-mixed`, `h200-large`
- `observed_profile_set TEXT`
- `status TEXT NOT NULL`
  - `pending`
  - `applying`
  - `active`
  - `failed`
  - `draining`
- `details JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- unique `(host_id, generation)`

The active layout row is the latest row with `status = 'active'`.

### `project_host_gpu_slices`

One row per schedulable device.

Fields:

- `id UUID PRIMARY KEY`
- `host_id UUID NOT NULL REFERENCES project_hosts(id) ON DELETE CASCADE`
- `layout_id UUID REFERENCES project_host_gpu_layouts(id) ON DELETE CASCADE`
- `physical_gpu_index INTEGER NOT NULL`
- `gpu_uuid TEXT`
- `mig_uuid TEXT`
- `cdi_device TEXT NOT NULL`
  - e.g. the exact string passed to Podman `--device`
- `profile_name TEXT NOT NULL`
  - NVIDIA profile string observed on the host, e.g. `1g.18gb`
- `profile_class TEXT NOT NULL`
  - normalized class, e.g. `small`, `medium`, `large`, `full`
- `memory_mb INTEGER`
- `compute_slices INTEGER`
- `status TEXT NOT NULL`
  - `available`
  - `leased`
  - `draining`
  - `missing`
  - `disabled`
- `last_seen TIMESTAMPTZ`
- `details JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- indexes on `(host_id, status, profile_class)` and `(cdi_device)`

Do not infer availability from CDI alone. CDI is an input from the host; the
database is the allocator state.

### `project_host_gpu_slice_leases`

One row per project lease.

Fields:

- `id UUID PRIMARY KEY`
- `slice_id UUID NOT NULL REFERENCES project_host_gpu_slices(id)`
- `host_id UUID NOT NULL REFERENCES project_hosts(id) ON DELETE CASCADE`
- `project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE`
- `account_id UUID`
- `state TEXT NOT NULL`
  - `pending`
  - `active`
  - `releasing`
  - `released`
  - `expired`
  - `failed`
- `requested_profile_class TEXT`
- `queue_priority INTEGER NOT NULL DEFAULT 0`
- `leased_at TIMESTAMPTZ`
- `expires_at TIMESTAMPTZ`
- `released_at TIMESTAMPTZ`
- `release_reason TEXT`
- `details JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- partial unique index:
  - one active/pending lease per project;
  - one active/pending lease per slice.

This table is the fairness boundary. A start operation either owns a slice or
does not get GPU devices.

## Run Quota Shape

Replace the boolean GPU path for shared hosts with a structured runtime
allocation.

Keep compatibility:

```ts
run_quota.gpu = true;
```

means "request a GPU if the host supports it" at the policy level.

Add allocated runtime shape:

```ts
run_quota.gpu = {
  mode: "mig",
  slice_id: "uuid",
  cdi_device: "nvidia.com/gpu=...",
  profile_name: "1g.18gb",
  profile_class: "small",
  memory_mb: 18432,
};
```

For dedicated/raw full GPU hosts:

```ts
run_quota.gpu = {
  mode: "raw",
  cdi_device: "nvidia.com/gpu=all",
  exclusive: true,
};
```

Project-runner should never decide allocation policy. It only consumes the
resolved `run_quota.gpu` object and passes the exact CDI device to Podman.

## Host Agent / Bootstrap Work

### Bootstrap

Extend GPU bootstrap:

1. Install `nvidia-container-toolkit` as today.
2. Install a host helper, likely `/usr/local/sbin/cocalc-gpu-inventory`.
3. Generate CDI after MIG changes with `nvidia-ctk cdi generate`.
4. Report:
   - physical GPUs;
   - MIG mode enabled/disabled;
   - MIG instances;
   - profile names;
   - UUIDs;
   - CDI device names;
   - `nvidia-smi -L` output;
   - driver/CUDA library versions.

### MIG Layout Application

Implement layout application as an explicit host LRO, not as an implicit side
effect of project start.

Reason: changing MIG layout can destroy existing GPU instances and disrupt
running GPU workloads. It must be visible, auditable, and usually require
draining.

Host action:

```ts
configureHostGpuLayout({
  host_id,
  profile_set:
    "h200-many-small" |
    "h200-mixed" |
    "h200-large" |
    "raw_full_gpu" |
    "disabled",
  drain: boolean,
});
```

Implementation outline:

1. Reject if non-admin/non-owner.
2. If `drain` is false and GPU leases are active, reject.
3. Mark layout `applying`.
4. Tell host daemon to:
   - stop GPU projects if explicitly draining;
   - enable MIG mode if needed;
   - destroy existing MIG instances;
   - create requested MIG profile instances;
   - regenerate CDI;
   - report inventory.
5. Upsert slices from observed inventory.
6. Mark missing old slices `missing`/`disabled`.
7. Mark layout `active` or `failed`.

For first release, support one safe H200 default layout and admin-only
reconfiguration. Do not expose arbitrary free-form MIG profile creation to
ordinary users.

## Default H200 Layouts

Exact profile names must be read from the host because H100/H200 profile labels
and memory sizes differ by SKU. Internally use normalized classes so UI and
policy are stable.

Start with three named layouts:

### `h200-many-small`

Purpose: education, notebooks, small models, many concurrent users.

Shape:

- maximize count of smallest useful slices;
- use this for shared membership hosts by default.

### `h200-mixed`

Purpose: a few larger notebooks plus small users.

Shape:

- several small slices;
- one or two medium/large slices.

### `h200-large`

Purpose: admin/dedicated workloads.

Shape:

- one or two large slices;
- fewer concurrent users.

Do not overfit the first implementation to one exact profile string. Nebius,
driver version, and H200 variant can affect observed naming. The host should
report actual capabilities; the control plane should classify them.

## Allocation Algorithm

Allocation runs in the authoritative project bay/control-plane path before
`startProject` is sent to the project host.

Inputs:

- `project_id`
- `account_id`
- target `host_id`
- project `run_quota.gpu` request, if any
- membership entitlements
- host access/tier policy
- active leases on the host
- observed slice inventory

Steps:

1. If project does not request GPU, start CPU-only.
2. If host is not GPU-capable, either:
   - fail with clear `gpu_unavailable_on_host`, or
   - re-place the project onto an eligible GPU host if placement is automatic.
3. Resolve account entitlement:
   - allowed profile classes;
   - concurrent GPU project limit;
   - queue priority.
4. If account already has too many active GPU leases, fail or queue.
5. Select the smallest available slice satisfying the request and entitlement.
6. Create lease and mark slice `leased` in one DB transaction.
7. Inject allocated GPU object into `run_quota` for `client.startProject`.
8. If project start fails before container launch, release the lease.
9. If host reports project stopped, release the lease.

Selection policy:

- prefer smallest adequate slice;
- tie-break by least recently used slice;
- use membership priority only when there is contention/queueing, not to
  override an already active lease unless explicit preemption is implemented.

## Queueing and Preemption

First implementation should not preempt running GPU projects. Preemption is
expensive and user-hostile unless we build good UX.

MVP behavior:

- if no slice is available, project start returns a typed error:
  `gpu_slice_unavailable`;
- UI offers:
  - start CPU-only;
  - choose another host;
  - wait/retry later.

Follow-up:

- queued GPU starts with LRO progress;
- reclaim idle GPU projects more aggressively than CPU-only projects;
- optional soft preemption for lower-priority idle GPU projects.

The idle reaper is the right first fairness tool. It is much less surprising
than evicting active notebooks.

## Podman Runtime Changes

Change `src/packages/project-runner/run/podman.ts`.

Current:

```ts
if (config.gpu) {
  args.push("--device", "nvidia.com/gpu=all");
  args.push("--security-opt", "label=disable");
}
```

Target:

```ts
const gpuDevice = resolveConfiguredGpuDevice(config.gpu);
if (gpuDevice) {
  args.push("--device", gpuDevice.cdi_device);
  args.push("--security-opt", "label=disable");
  env.NVIDIA_VISIBLE_DEVICES = gpuDevice.visible_devices ?? "void";
}
```

Rules:

- boolean `true` should be rejected or mapped to raw only on explicitly
  dedicated hosts;
- structured MIG allocation is required on shared GPU hosts;
- never use `nvidia.com/gpu=all` for public/shared-pool H200 hosts;
- log allocated `slice_id`, profile, and CDI device, but not arbitrary
  user-controlled values.

Add validation:

- `cdi_device` must match an NVIDIA CDI device string from host inventory;
- reject shell metacharacters and whitespace;
- reject unknown `mode`.

## Host Daemon Changes

Add host daemon APIs:

```ts
getGpuInventory(): Promise<HostGpuInventory>
configureGpuLayout(opts): Promise<HostGpuLayoutResult>
```

`HostGpuInventory` should include:

```ts
{
  enabled: boolean;
  driver_version?: string;
  cuda_version?: string;
  mig_mode?: "enabled" | "disabled" | "unknown";
  physical_gpus: Array<{
    index: number;
    uuid?: string;
    name?: string;
    memory_mb?: number;
    mig_capable?: boolean;
  }>;
  slices: Array<{
    physical_gpu_index: number;
    gpu_uuid?: string;
    mig_uuid?: string;
    cdi_device: string;
    profile_name: string;
    memory_mb?: number;
    compute_slices?: number;
  }>;
  raw: {
    nvidia_smi_L?: string;
    nvidia_ctk_cdi_list?: string;
  };
}
```

The control plane stores normalized rows; the raw output is diagnostic only.

## Multibay Routing

GPU lease allocation is a project/host ownership operation.

Rules:

- the project owning bay is authoritative for project start intent;
- the host bay is authoritative for observed host inventory and leases;
- if project and host are in different bays, use inter-bay host routing APIs;
- do not allocate GPU slices by directly writing the local bay DB unless that
  bay owns the host or has routed through the host bay.

This follows the existing scalable architecture rule: route by explicit
ownership, not by whichever hub receives the request.

Implementation:

- add inter-bay methods for:
  - `allocateProjectGpuSlice`;
  - `releaseProjectGpuSlice`;
  - `getHostGpuInventory`;
  - `configureHostGpuLayout`;
- project start path calls allocation through host-owner routing.

## UI / UX

### Host List and Drawer

Show a compact GPU capacity summary:

- `GPU: H200 MIG 3/7 slices free`
- profile breakdown: `small 2 free, medium 1 free, large 0 free`
- layout: `many small`
- warning when raw full GPU mode is enabled on a shared host.

Host drawer GPU tab/card:

- physical GPU inventory;
- active layout;
- slice table with project/account lease owner;
- action to configure layout, admin-only;
- action to refresh GPU inventory;
- validation status: driver, CDI, MIG mode, test container.

### Project Settings / Resources

Replace boolean GPU display with:

- GPU request:
  - `None`
  - `Small isolated GPU slice`
  - `Medium isolated GPU slice`
  - `Large isolated GPU slice`
- current allocation if running:
  - profile;
  - memory;
  - host;
  - lease age.

### Project Creation / Host Selection

When a rootfs or selected workload requests GPU:

- prefer GPU hosts with available slices;
- show `GPU slice available` instead of just `GPU`;
- if no slices are available, make this explicit before project creation.

### User Error Messages

Use typed errors and direct copy:

- `No isolated GPU slice is currently available on this host. You can start CPU-only, choose another host, or try again later.`
- `Your membership allows small GPU slices; this project requested a larger slice.`
- `This host has a GPU, but it is not configured for shared MIG slices.`

## CLI / Ops

Add CLI commands:

```bash
cocalc host gpu inventory --host-id <host>
cocalc host gpu layout --host-id <host>
cocalc host gpu layout set --host-id <host> --profile-set h200-many-small
cocalc host gpu leases --host-id <host>
cocalc host gpu lease release --lease-id <lease>
cocalc host gpu validate --host-id <host>
```

`validate` should run an end-to-end smoke:

1. inspect physical GPU and MIG mode;
2. ensure CDI contains MIG devices;
3. allocate a test slice;
4. start a tiny test container with only that device;
5. run:
   - `nvidia-smi`;
   - Python `torch.cuda.is_available()` if image includes torch;
   - a minimal CUDA device query if available;
6. release lease.

## Security Considerations

- Never pass arbitrary user-provided CDI device strings to Podman.
- Only allocate devices observed from host inventory.
- Use DB leases for concurrency; in-memory maps are insufficient.
- On host heartbeat, reconcile:
  - leased slice missing from inventory;
  - project running without matching active lease;
  - active lease for stopped project;
  - duplicate active lease attempts.
- Do not expose raw `nvidia.com/gpu=all` on shared-pool hosts.
- Admin override paths must be audited.

## Failure Recovery

Cases to handle:

### Start Fails After Lease

Release lease in `finally` unless the project container is confirmed running.

### Host Restarts

Host reports inventory after restart. Reconcile:

- if MIG UUIDs changed but profile layout is equivalent, map leases by running
  container labels and CDI visibility where possible;
- otherwise mark leases `failed` and projects `gpu_unavailable` or stop them
  with a clear error.

### MIG Layout Changed Outside CoCalc

Host inventory no longer matches DB layout:

- mark layout `failed` or `drifted`;
- mark stale slices `missing`;
- stop allocating new GPU projects;
- show admin warning and require layout reconcile.

### Lease Leaks

Periodic sweeper:

- release active leases for projects not running on that host;
- expire pending leases older than a short timeout;
- mark leased slices missing if not observed for several heartbeats.

## Implementation Phases

### Phase 1: Inventory and Safe Podman Device Injection

- Add `GpuAllocation` type to project-runner configuration.
- Change project-runner to accept structured GPU config and pass exact CDI
  device instead of always `nvidia.com/gpu=all`.
- Keep boolean raw behavior behind an explicit env/host metadata flag for
  dedicated debugging only.
- Add tests for:
  - structured MIG device accepted;
  - boolean GPU rejected on shared mode;
  - CDI string validation.

### Phase 2: Host Inventory Reporting

- Add host daemon GPU inventory command/API.
- Extend bootstrap helper to report MIG/CDI state.
- Store observed inventory in new GPU tables.
- Add host drawer/admin summary.
- Add CLI `host gpu inventory`.

### Phase 3: Lease Allocator

- Add DB schema and allocator helpers.
- Add transactional allocate/release functions.
- Integrate allocation into `startProjectOnHost`.
- Release lease on stop/status reconciliation.
- Add tests for:
  - two projects cannot lease same slice;
  - membership profile restriction;
  - start failure releases lease;
  - stopped project releases lease.

### Phase 4: H200 Layout LRO

- Implement admin-only `configureHostGpuLayout`.
- Add host LRO worker path.
- Add CLI and host drawer controls.
- Validate against a Nebius H200 host.

### Phase 5: User-Facing GPU Selection

- Update project creation, host picker, and project settings.
- Add clear errors for no available slice.
- Add membership benefit copy for GPU slices.

### Phase 6: Queueing and Idle Reclaim

- Add optional queue for GPU starts.
- Add GPU-specific idle timeout/reclaim policy.
- Expose queue position and retry behavior.

## Testing Plan

Unit tests:

- allocator transaction race;
- lease release paths;
- run quota normalization;
- project-runner Podman args;
- host inventory normalization;
- entitlement/profile matching.

Integration tests on non-GPU dev:

- fake inventory and fake CDI devices;
- simulated host heartbeat drift;
- simulated start failure and lease cleanup.

Dogfood tests on Nebius H200:

1. Configure `h200-many-small`.
2. Verify inventory shows expected slices.
3. Start two projects with small slices.
4. In each project:
   - `nvidia-smi` only shows the assigned MIG device;
   - PyTorch sees one CUDA device;
   - memory visible is bounded to the slice.
5. Start more projects until slices are exhausted.
6. Verify next GPU start fails or queues with a clear message.
7. Stop one project and verify the lease is released.
8. Restart host and verify leases/inventory reconcile.

## Open Questions

- What exact shared H200 default layout should we use after first real Nebius
  inventory is observed?
- Should GPU requests be per-project settings, inferred from GPU rootfs images,
  or both?
- Should low-tier users be allowed to queue for medium/large slices or only
  start CPU-only when small slices are exhausted?
- How aggressive should GPU idle reclaim be compared to CPU-only project idle
  reclaim?
- Do we need per-account monthly GPU-hour budgets in addition to concurrent
  slice limits?

## Recommendation

Build MIG support as a first-class allocator before marketing shared H200 hosts.
The minimal safe release is:

- one admin-configured H200 MIG layout;
- one small slice profile exposed to ordinary users;
- transactional leases;
- Podman receives only the leased CDI device;
- no preemption/queueing yet, just clear unavailable errors and aggressive idle
  reclaim as a follow-up.

This gives a robust economic/product foundation without overbuilding a full GPU
marketplace in the first pass.
