# Dedicated Project Host Shared Scratch Disk Plan

Status: implementation plan

Date: 2026-05-27

## Problem

Dedicated project hosts are incomplete for ML and data-heavy workflows without a
large, fast, host-local shared filesystem.

Example:

- A user creates a dedicated GPU host.
- Their project has a durable project quota, e.g. 20 GB, for `/home/user` and
  the writable environment.
- They need to download an 800 GB dataset before training.
- Today there is no CoCalc-supported place to put it.

This blocks a major class of realistic GPU workflows.

## Core Product Contract

Add a host-scoped **shared scratch disk**.

- It is a cloud block disk attached to a project host.
- It is mounted on the host at `/mnt/cocalc-scratch`.
- It is bind-mounted into every project container on that host at `/scratch`.
- It is shared by all projects running on that host.
- It is not backed up by CoCalc.
- It is not included in project storage quota.
- It is not copied by project backup, project move, or backup-all-projects.
- It is billed as part of the dedicated host pay-as-you-go cost.
- It persists across host stop/start, reboot, and ordinary host edit/recreate
  workflows.

Product distinction:

- Project storage is durable, portable, backed up, and quota-managed.
- Shared scratch is large, fast, host-local working storage.

The UI must repeatedly state that `/scratch` is **not externally backed up**.
It must also avoid overstating risk: this is not a local SSD scratch disk that
randomly disappears on one drive failure. For the supported cloud disk types,
the data lives on provider-managed network block storage with provider-level
redundancy according to the selected disk type.

## Naming

Use:

- Host mount: `/mnt/cocalc-scratch`
- Project/container mount: `/scratch`
- User-facing label: `Shared scratch disk`
- Metadata field: `shared_disk_gb`

Do not make the mount path configurable in V1.

`/scratch` is the right user-visible name because it communicates "large,
working, host-local, not backed up" better than `/data`, `/shared`, or
`/local`.

## Scope Decisions

### V1 Must Support

- Create a host with a shared scratch disk.
- Add a shared scratch disk to an existing host.
- Grow/enlarge a shared scratch disk.
- Delete a shared scratch disk, destroying all data on it.
- Preserve scratch data across:
  - host stop/start
  - host reboot
  - editable host changes such as instance type changes
  - spot to standard and standard to spot transitions
  - provider workflows that recreate the VM while preserving host disks
- Mount shared scratch into all projects on the host after project restart.
- Show shared scratch in pricing, spend accounting, and host/project storage UI.

### V1 Must Not Support

- In-place shrink.
- Preserving scratch after explicit host deletion.
- Attaching a scratch disk from one host to another host.
- Fast direct disk-to-disk copying between scratch disks.
- Cross-host scratch migration.
- Backups, snapshots, rustic storage, or R2 integration.
- Per-project quota enforcement inside `/scratch`.
- User-configurable mount paths.
- Local SSD scratch options.

Shrink is intentionally modeled as delete and recreate:

1. Delete the shared scratch disk, destroying all data.
2. Create a new smaller shared scratch disk.

Fast data movement should be a separate future feature. The likely right
primitive is efficient project-to-project SSH/rsync, whether projects are on the
same host or different hosts.

## Lifecycle Requirements

The most important lifecycle requirement is:

> A user can stop a project host, edit any normally editable host setting, start
> it again, and not lose scratch data.

This includes instance type changes and spot/standard transitions. If an edit
path currently deletes and recreates the cloud VM, the scratch disk must be
treated like the durable host data disk: preserve the disk, reattach it, and
remount it.

Terminology:

- `host delete`: user intentionally deletes the project host.
- `host deprovision/recreate`: system deletes/recreates a VM as part of an edit
  or recovery workflow.
- `scratch delete`: user intentionally deletes the shared scratch disk.

Semantics:

- Host stop/start: scratch persists.
- Host reboot: scratch persists.
- Host edit/recreate: scratch persists.
- Host delete: scratch is deleted.
- Scratch delete: scratch is deleted, host remains.
- Project backup/move: scratch is ignored.
- Backup-all-projects: scratch is ignored.

## Data Model

Extend host machine metadata:

```ts
machine: {
  ...
  shared_disk_gb?: number;
  shared_disk_type?: string;
  metadata?: {
    ...
    shared_disk_id?: string;
    shared_disk_name?: string;
    shared_disk_device?: string;
    shared_disk_mount?: "/mnt/cocalc-scratch";
    shared_disk_filesystem?: "ext4";
    shared_disk_state?: "none" | "creating" | "attached" | "mounted" | "error";
    shared_disk_last_grow_from_gb?: number;
    shared_disk_last_grow_to_gb?: number;
  };
}
```

Notes:

- `shared_disk_gb` is desired size.
- `shared_disk_type` is provider-specific.
- Runtime identifiers live in nested machine metadata, consistent with existing
  cloud runtime metadata.
- `shared_disk_mount` is stored for diagnostics, but V1 always uses
  `/mnt/cocalc-scratch`.
- `shared_disk_filesystem` is always `ext4` in V1.

## Disk Types

Disk type is important and must be exposed for supported providers.

Do not support local SSD for `/scratch` in V1. Local SSD does not match the
product goal: scratch is not backed up, but it also should not disappear merely
because one physical disk fails or a VM is recreated.

### Nebius

Nebius has three relevant network disk types:

- Network SSD Non-replicated disk: one copy of data.
- Network SSD disk: two copies of data.
- Network SSD IO M3 disk: three copies of data and provider-specific size
  increments.

Default should be the two-copy network SSD option.

The UI may offer the one-copy option, but if it does, it must clearly warn that
it has weaker durability. It may be better to omit the one-copy option from V1
to avoid user confusion.

The UI should explain:

> `/scratch` is not backed up by CoCalc and is tied to this host, but with the
> default disk type it is stored on redundant provider network block storage,
> not ephemeral local SSD.

### GCP

Offer normal persistent disk types already supported by the host UI, e.g.
balanced and SSD. Do not offer local SSD for shared scratch.

### Other Providers

Hyperstack, Lambda, and self-host should be unsupported until explicitly
implemented.

## Validation

Create/update validation should enforce:

- `shared_disk_gb` absent or `0` means no shared scratch disk.
- If present, `shared_disk_gb` must be a positive integer.
- Minimum size should be provider-safe. Suggested default: 75 GB.
- Maximum size must respect provider limits and billing admission.
- `shared_disk_type` must be one of the supported provider disk types.
- Local SSD disk types must be rejected.
- Shrink is rejected with:
  `Shared scratch disks cannot be shrunk in place. Delete the scratch disk and create a smaller one.`
- Delete requires explicit confirmation.

Provider-specific normalization:

- Nebius IO M3 sizes use the existing 93 GB increment normalization.
- GCP persistent disks can use normal GB sizes.

## Cloud Provider Provisioning

### Provider Interface

Add provider methods or extend existing ones so scratch has explicit lifecycle
operations:

```ts
ensureSharedScratchDisk?(runtime, spec, creds): Promise<HostRuntimePatch>;
resizeSharedScratchDisk?(runtime, sizeGb, creds): Promise<HostRuntimePatch>;
deleteSharedScratchDisk?(runtime, creds): Promise<HostRuntimePatch>;
```

Avoid overloading the durable data disk resize method unless the implementation
remains unambiguous.

### GCP

Create:

- If `shared_disk_gb > 0`, create or reuse a non-boot disk.
- Suggested disk name: `${spec.name}-scratch`.
- Attach it with `autoDelete: false`.
- Store disk name/selfLink in runtime metadata.

Recreate/edit:

- If runtime metadata has a scratch disk name/id, reattach it to the new VM.
- Do not delete scratch during spot/standard or instance type transitions.

Grow:

- Resize the disk with the GCP disk resize API.
- Run `resize2fs` after the host sees the larger device.

Delete:

- Detach/unmount if necessary.
- Delete the scratch disk only for explicit scratch delete or host delete.
- Do not delete scratch during normal host edit/recreate.

### Nebius

Create:

- If `shared_disk_gb > 0`, create or reuse a disk named `${name}-scratch`.
- Attach it to the instance.
- Store the disk id as `shared_disk_id`.
- Normalize IO M3 sizes using the existing disk normalization logic.

Recreate/edit:

- If runtime metadata has `shared_disk_id`, reattach it to the new instance.
- Do not delete scratch during spot/standard or instance type transitions.

Grow:

- Resize the Nebius disk.
- Run `resize2fs` after the host sees the larger device.
- This is a V1 requirement.

Delete:

- Detach/unmount if necessary.
- Delete the scratch disk only for explicit scratch delete or host delete.
- Do not delete scratch during normal host edit/recreate.

## Runtime Add / Delete

Scratch disk provisioning cannot only happen during initial bootstrap.

V1 must support:

- Add scratch disk after a host already exists.
- Add scratch disk while the host is running.
- Delete scratch disk while the host is running.
- Grow scratch disk while the host is running when provider/filesystem support
  allows it.

Project visibility rules:

- Projects must be restarted to see a newly added `/scratch`.
- Deleting scratch requires stopping/restarting every running project that has
  mounted it.
- The host itself does not need to stop merely to add or delete scratch if the
  provider supports attach/detach while running.

Operationally, scratch add/delete should be long-running operations with clear
status and project restart guidance.

## Host Bootstrap And Reconcile

Update `src/packages/server/cloud/bootstrap-host.ts`.

Existing bootstrap prepares `/mnt/cocalc` for durable project-host data. Add a
separate flow for `/mnt/cocalc-scratch`.

Bootstrap and reconcile behavior:

1. Detect whether a shared scratch disk is configured.
2. Discover the attached scratch block device robustly.
3. If the device has no filesystem, format it ext4.
4. Create `/mnt/cocalc-scratch`.
5. Mount it via `/etc/fstab` using UUID.
6. Ensure `chmod 1777 /mnt/cocalc-scratch`.
7. If the configured size grew, run `resize2fs`.

Initial permissions:

```sh
chmod 1777 /mnt/cocalc-scratch
```

Rationale:

- It behaves like `/tmp`.
- It allows all project users on the host to write.
- The sticky bit prevents trivial deletion of other users' files in the same
  directory.

Possible later hardening:

- Create `/mnt/cocalc-scratch/projects/<project_id>`.
- Bind each project to its own project subdirectory by default.
- Add admin/user controls for shared directories.

Do not do that in V1.

## Project Container Mount

Where project podman containers are started, add:

- Host source: `/mnt/cocalc-scratch`
- Container target: `/scratch`
- Mode: read/write

Only add the bind mount when the host has shared scratch configured and mounted.

Failure policy:

- If `shared_disk_gb > 0` but `/mnt/cocalc-scratch` is missing or not mounted,
  project startup should fail with a clear host misconfiguration error.
- Do not silently start without `/scratch`, since users may depend on it.

Container UX:

- `/scratch` exists when configured.
- `/scratch` does not count against project quota.
- `/scratch` is writable by normal project users.
- All projects on the host see the same filesystem.

## Billing And Spend Accounting

Add shared scratch disk as a distinct pricing/spend line item.

Pricing display should show:

- Compute
- Durable project-host disk
- Shared scratch disk
- Public IPv4 / other provider charges

Spend accounting should include:

- `shared_disk_gb`
- `shared_disk_type`
- Provider-specific disk hourly rate
- Surcharge if dedicated host surcharge applies to storage

Important:

- Shared scratch accrues cost when the host is stopped if the cloud disk remains
  allocated.
- If scratch is explicitly deleted, billing for that line item stops.
- Stopped host spend should show storage costs separately from compute costs.

## UI / UX

### Create Host

Add section:

`Shared scratch disk`

Fields:

- Enable checkbox or size input.
- Size in GB.
- Disk type selector for GCP and Nebius.

Copy:

> Adds a large host-local filesystem mounted at `/scratch` in every project on
> this host. It is not backed up by CoCalc and does not move with projects. With
> the default disk type it uses redundant provider network block storage, not
> ephemeral local SSD.

### Edit Host

Supported operations:

- Add scratch disk if none exists.
- Grow scratch disk.
- Delete scratch disk.
- Change disk type only by delete/recreate unless provider supports safe
  in-place type migration.

Unsupported operation:

- Shrink in place.

Shrink UX:

> Scratch disks cannot be shrunk in place. Delete this scratch disk, which
> deletes all data on it, then create a smaller one.

Runtime operation guidance:

- Adding scratch requires restarting projects before they see `/scratch`.
- Deleting scratch requires stopping/restarting projects that mounted it.
- Growing scratch should not require restarting projects if the filesystem
  resize succeeds online.

### Host Details / Drawer

Show:

- `Shared scratch: 800 GB`
- Disk type and durability copy.
- `Mounted in projects at /scratch`
- `Not backed up by CoCalc`
- Usage and free space if available.
- Delete button with explicit confirmation.

### Public Pool Access UI

Do not block shared scratch on public/shared-pool hosts at the backend layer.

Instead, when an admin configures public/shared-pool access for a host with
scratch enabled, show a prominent warning:

> This host has shared `/scratch` storage. Every project placed on this host can
> read and write the same scratch filesystem. Only enable public/shared access
> if the users are meant to share this data, e.g. a trusted lab or class.

Rationale:

- Launchpad and lab deployments may intentionally use a "public" pool that is
  only public within a trusted group.
- This is a product/admin policy issue, not a reason to complicate backend
  semantics.

### Project Disk Usage

The project disk usage dialog should include a separate section when the project
is running on a host with shared scratch:

`Host shared scratch (/scratch)`

Show:

- Total scratch disk size.
- Used/free from `df`.
- Historical usage over time if cheap to collect.
- Warning that it is outside project quota and not backed up.
- Durability note based on disk type.

This must not be mixed into the project quota progress bar.

## CLI

Add host options:

- `--shared-disk-gb <gb>` for create/update.
- `--shared-disk-type <type>` for supported providers.
- `host scratch grow --host-id <id> --size-gb <gb>`
- `host scratch delete --host-id <id>`
- `host scratch info --host-id <id>`

CLI output should label the disk as:

`shared scratch (/scratch, not backed up by CoCalc)`

## API / RPC

Areas to update:

- Host create payload types.
- Host edit/update payload types.
- Host normalization and validation.
- Cloud lifecycle create/start/delete/recreate.
- Runtime scratch add/delete/grow LROs.
- Billing/spend calculation.
- Host catalog/provider capability flags.
- Project status/storage-info API for `/scratch` usage.

Provider capability should include:

```ts
shared_scratch_disk: {
  supported: boolean;
  growable: boolean;
  disk_types: Array<{
    value: string;
    label: string;
    durability: "single-copy" | "replicated" | "highly-replicated";
    default?: boolean;
  }>;
}
```

## Failure Modes

Handle explicitly:

- Scratch disk requested but not attached.
- Scratch disk attached but not formatted.
- Scratch disk mounted but not writable.
- Scratch disk missing during project start.
- Grow requested below current size.
- Grow provider API succeeds but `resize2fs` fails.
- Delete requested while projects are running and mounted.
- Provider delete fails to delete scratch disk.
- Billing metadata says scratch exists but provider disk is missing.
- Host recreate path fails to reattach scratch.

Surface these in host status/diagnostics.

## Security And Isolation

V1 uses shared writable `/scratch`.

Implications:

- All projects on the host can read/write the same scratch filesystem.
- This is expected for dedicated hosts and trusted shared pools.
- UI must say "shared across projects on this host."
- Backend should not special-case public pools, but admin UI must warn before
  enabling broad access.

## Testing Plan

Unit tests:

- Host create validation accepts/normalizes `shared_disk_gb`.
- Host create validation rejects unsupported providers.
- Host create validation rejects local SSD disk types.
- Host update validation rejects in-place shrink.
- Pricing includes shared scratch disk line item.
- Delete action requires explicit confirmation.
- Provider payload includes scratch disk metadata.

Provider tests:

- Nebius creates a scratch disk when requested.
- Nebius reattaches scratch on recreate/edit.
- Nebius deletes scratch only on explicit scratch delete or host delete.
- Nebius does not delete scratch on spot/standard transition.
- Nebius normalizes scratch disk size for IO M3.
- Nebius grows scratch disk.
- GCP equivalent tests after Nebius dogfood path works.

Bootstrap tests:

- Generated script includes `/mnt/cocalc-scratch` setup when configured.
- Generated script does not touch scratch when not configured.
- Script formats only if no filesystem exists.
- Script uses UUID in fstab.
- Script runs `resize2fs` after grow.

Frontend tests:

- Host create card shows scratch controls for supported providers.
- Nebius defaults to the two-copy network SSD disk type.
- Local SSD is not offered.
- Price estimate includes scratch disk.
- Warnings mention `/scratch`, "not backed up", and provider disk durability.
- Project disk usage renders separate scratch section from quota.
- Public pool access page shows a warning when scratch exists.

Smoke tests:

1. Create a Nebius dedicated host with `shared_disk_gb=200`.
2. Start a project on the host.
3. Verify inside project:
   - `/scratch` exists.
   - `/scratch` is writable.
   - `df -h /scratch` shows the scratch disk.
   - Writing to `/scratch` does not increase project quota.
4. Start a second project on the same host.
5. Verify both projects see the same `/scratch` contents.
6. Stop/start host.
7. Verify `/scratch` contents persist.
8. Change instance type or spot/standard mode through the normal edit flow.
9. Verify `/scratch` contents still persist.
10. Grow scratch from 200 GB to 300 GB.
11. Verify `df -h /scratch` shows the larger filesystem.
12. Add scratch to an existing running host.
13. Restart projects and verify `/scratch` appears.
14. Delete scratch with explicit confirmation.
15. Restart projects and verify `/scratch` is gone.

## Rollout Plan

1. Implement Nebius first.
2. Add provider capability and hide controls for unsupported providers.
3. Dogfood with a small scratch disk.
4. Dogfood on a Nebius GPU host with a real dataset workflow.
5. Add GCP.
6. Add project disk usage polish and usage history.
7. Expose broadly.

## Resolved Decisions

- First provider: Nebius.
- Project mount path: `/scratch`.
- Host mount path: `/mnt/cocalc-scratch`.
- Mount visible in all projects on the host.
- Permissions: `1777`.
- Grow is V1 required.
- Shrink is delete/recreate only.
- Delete scratch requires project restart, not host stop.
- Do not support local SSD.
- Do not block scratch on public pools in backend; warn in admin UI.

## Open Questions

- Should the one-copy Nebius disk type be offered at all, or hidden in V1?
- Should changing scratch disk type be supported as delete/recreate only?
- Should scratch usage be sampled by the host daemon or queried live by project
  storage-info?
- What is the exact provider-safe maximum scratch disk size for each disk type?

