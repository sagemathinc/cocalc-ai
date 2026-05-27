# Dedicated Project Host Shared Scratch Disk Plan

Status: implementation plan

Date: 2026-05-27

## Problem

Dedicated project hosts are incomplete for many ML and data workflows without a
large, fast, host-local shared filesystem.

Example failure mode:

- A user creates a dedicated GPU host.
- Their project has a small durable quota, e.g. 20 GB, because project data is
  backed up and portable.
- They need to download an 800 GB dataset for training.
- Today there is no CoCalc-supported place to put it.

This blocks an entire class of realistic GPU use cases.

## Product Model

Add a host-scoped **shared scratch disk**.

- It is attached to a dedicated project host.
- It is mounted on the host at `/mnt/cocalc-scratch`.
- It is mounted into every project container on that host at `/scratch`.
- It is shared by all projects running on that host.
- It is not backed up.
- It is not moved with projects.
- It is not included in project storage quotas.
- It is not restored from R2.
- It is billed as part of the dedicated host pay-as-you-go cost.

This is deliberately different from project storage:

- Project storage is durable, portable, backed up, and quota-managed.
- Shared scratch is large, fast, host-local working storage.

The UI must repeat this distinction wherever users can create, inspect, or use
shared scratch.

## Naming

Use:

- Host mount: `/mnt/cocalc-scratch`
- Project/container mount: `/scratch`
- User-facing label: `Shared scratch disk`
- Metadata field: `shared_disk_gb`

Do not make the mount path user-configurable initially. Configurable mount paths
increase support burden, documentation surface, and container launch complexity.

`/scratch` is the best user-visible name because it communicates "temporary,
large, local, not backed up" better than `/data` or `/shared`.

## Explicit Non-Goals For V1

Do not implement:

- Preserving scratch disks after host deprovision/delete.
- Attaching an old scratch disk to another host.
- Fast direct disk-to-disk copying.
- Cross-host scratch migration.
- Backups, snapshots, rustic storage, or R2 integration.
- Per-project quota enforcement inside `/scratch`.
- Shrinking a scratch disk in place.
- User-configurable mount paths.

If users want to shrink scratch storage, the supported operation is:

1. Delete the shared scratch disk and all data on it.
2. Create a new smaller shared scratch disk.

If users want to copy data elsewhere, that is a separate product feature. The
likely right future primitive is efficient project-to-project SSH/rsync, whether
projects are on the same host or different hosts.

## Data Model

Extend host machine metadata with:

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
  };
}
```

Notes:

- `shared_disk_gb` is the desired size.
- Provider runtime identifiers live in nested machine metadata, consistent with
  existing cloud runtime metadata.
- `shared_disk_mount` is stored for diagnostics, but V1 always uses
  `/mnt/cocalc-scratch`.
- `shared_disk_type` should default to the provider's current data disk type
  unless explicitly set.

## Validation

Create/update validation should enforce:

- `shared_disk_gb` absent or `0` means no shared scratch disk.
- If present, `shared_disk_gb` must be a positive integer.
- Minimum size should be provider-safe. Suggested default: 75 GB, matching the
  current managed host disk minimum.
- Maximum size should be bounded by cloud/provider limits and billing admission.
- Shrink is rejected with a clear message:
  `Shared scratch disks cannot be shrunk. Delete the scratch disk and create a new one.`
- Deleting scratch requires explicit confirmation because it deletes all data.

Provider-specific normalization:

- Nebius `ssd_io_m3` sizes must use the existing 93 GB increment normalization.
- GCP persistent disks can use normal GB sizes.

## Cloud Provider Provisioning

### GCP

In `GcpProvider.createHost`:

- If `shared_disk_gb > 0`, create or reuse a second non-boot data disk.
- Suggested disk name: `${spec.name}-scratch`.
- Attach it with `autoDelete: false`.
- Store `shared_disk_name` and, where available, disk selfLink/id in runtime
  metadata.

In `GcpProvider.deleteHost`:

- Default behavior: delete the scratch disk when deleting/deprovisioning the
  host.
- No preserve option in V1.
- Preserve logic should remain only for the durable project-host data disk.

In `resizeDisk` or a new provider method:

- Grow-only resize should be supported later.
- V1 can defer resize if needed, but create/delete must work.

### Nebius

In `NebiusProvider.createHost`:

- If `shared_disk_gb > 0`, create or reuse an additional disk named
  `${name}-scratch`.
- Attach it to the instance.
- Store the disk id as `shared_disk_id`.
- Normalize IO M3 sizes just like the durable data disk.

In `NebiusProvider.deleteHost`:

- Delete the scratch disk by default.
- Do not preserve scratch disk on deprovision/delete in V1.

Grow-only resize can be added after create/delete and mount behavior works.

### Other Providers

For Hyperstack/Lambda/self-host:

- Treat shared scratch as unsupported until explicitly implemented.
- UI should hide or disable the setting for unsupported providers.
- API validation should reject unsupported provider requests.

## Host Bootstrap

Update `src/packages/server/cloud/bootstrap-host.ts`.

Existing bootstrap prepares `/mnt/cocalc` for durable project-host data. Add a
separate flow for `/mnt/cocalc-scratch`.

Bootstrap behavior:

1. Detect whether a shared scratch disk is configured.
2. Discover the attached scratch block device robustly.
3. If the device has no filesystem, format it ext4.
4. Create `/mnt/cocalc-scratch`.
5. Mount it via `/etc/fstab` using UUID.
6. Ensure permissions suitable for shared multi-project use.

Initial permissions:

```sh
chmod 1777 /mnt/cocalc-scratch
```

Rationale:

- It is simple and predictable.
- It behaves like `/tmp`.
- It allows different project Unix users to write without coordination.
- The sticky bit prevents trivial deletion of other users' files in the same
  directory.

Possible later hardening:

- Create `/mnt/cocalc-scratch/projects/<project_id>`.
- Bind each project to its own project subdirectory by default.
- Add admin/user controls for sharing between projects.

Do not do that in V1. The core missing capability is large shared host-local
space.

## Project Container Mount

Where project podman containers are started, add:

- Host source: `/mnt/cocalc-scratch`
- Container target: `/scratch`
- Mode: read/write
- Only add the bind mount when the host has shared scratch configured and
  mounted.

Failure policy:

- If the host has `shared_disk_gb > 0` but `/mnt/cocalc-scratch` is missing or
  not mounted, project startup should fail with a clear host misconfiguration
  error.
- Do not silently start without `/scratch`; users may put critical workflow
  assumptions there.

Container UX:

- `/scratch` should exist when configured.
- `/scratch` should not count against project quota.
- `/scratch` should be writable by normal project users.

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

- Shared scratch should accrue cost even when the host is stopped if the cloud
  disk remains allocated.
- If the disk is deleted, billing for that line item stops.

## UI / UX

### Create Host

Add an optional section:

`Shared scratch disk`

Fields:

- Enable checkbox or size input.
- Size in GB.
- Disk type only if provider already exposes a meaningful disk type selector.

Copy:

> Adds a large host-local scratch filesystem mounted at `/scratch` in every
> project on this host. This storage is not backed up, not portable, and is
> deleted when the scratch disk is deleted.

### Host Details / Drawer

Show:

- `Shared scratch: 800 GB`
- `Mounted in projects at /scratch`
- `Not backed up`
- Usage if available
- Delete button with explicit confirmation

### Edit Host

Supported operations:

- Add scratch disk if none exists.
- Grow scratch disk if provider support is implemented.
- Delete scratch disk.

Unsupported operation:

- Shrink in place.

Shrink UX:

> Scratch disks cannot be shrunk in place. Delete this scratch disk, which
> deletes all data on it, then create a smaller one.

### Project Disk Usage

The project disk usage dialog should include a separate section when the project
is running on a host with shared scratch:

`Host shared scratch (/scratch)`

Show:

- Total scratch disk size.
- Used/free if cheaply available from the host.
- Warning that it is outside project quota and not backed up.

This must not be mixed into the project quota progress bar.

## CLI

Add host options:

- `--shared-disk-gb <gb>` for create/update where applicable.
- `host scratch delete --host-id <id>` or equivalent explicit destructive action.
- `host scratch info --host-id <id>` if useful for operations.

CLI output should label the disk as:

`shared scratch (/scratch, not backed up)`

## API / RPC

Areas to update:

- Host create payload types.
- Host edit/update payload types.
- Host normalization and validation.
- Cloud lifecycle create/start/delete.
- Billing/spend calculation.
- Host catalog/provider capability flags.

Provider capability should include something like:

```ts
shared_scratch_disk: {
  supported: boolean;
  growable?: boolean;
  disk_types?: string[];
}
```

## Operational Semantics

### Host Stop / Start

Scratch disk remains attached/preserved.

### Host Reboot

Bootstrap/fstab remounts `/mnt/cocalc-scratch`.

### Host Deprovision / Delete

Scratch disk is deleted in V1.

There is no preserve flag for scratch in V1.

### Project Backup

Ignored.

### Project Move

Ignored.

### Backup-All-Projects

Ignored.

### Host Recovery

If a cloud instance is recreated and durable host disks are reattached, scratch
disk reattachment is out of scope for V1 unless it naturally falls out of the
same runtime metadata flow. The V1 contract should not promise scratch recovery
across host recreation.

## Failure Modes

Handle explicitly:

- Scratch disk requested but not attached.
- Scratch disk attached but not formatted.
- Scratch disk mounted but not writable.
- Scratch disk missing during project start.
- Provider delete fails to delete scratch disk.
- Billing metadata says scratch exists but provider disk is missing.

Surface these in host status/diagnostics.

## Security And Isolation

V1 uses shared writable `/scratch`.

Implications:

- All projects on the dedicated host can read/write the same scratch filesystem.
- This is acceptable because dedicated hosts are explicitly owned/managed by a
  user or team.
- UI must call this "shared across projects on this host."

Do not enable shared scratch on public shared pool hosts until there is a clear
isolation model.

## Testing Plan

Unit tests:

- Host create validation accepts/normalizes `shared_disk_gb`.
- Host create validation rejects unsupported providers.
- Pricing includes shared scratch disk line item.
- Delete action requires explicit confirmation.
- Provider payload includes scratch disk metadata.

Provider tests:

- GCP creates a scratch disk when requested.
- GCP deletes scratch disk on host delete.
- Nebius creates a scratch disk when requested.
- Nebius deletes scratch disk on host delete.
- Nebius normalizes scratch disk size for IO M3.

Bootstrap tests:

- Generated script includes `/mnt/cocalc-scratch` setup when configured.
- Generated script does not touch scratch when not configured.
- Script formats only if no filesystem exists.
- Script uses UUID in fstab.

Frontend tests:

- Host create card shows scratch controls for supported providers.
- Price estimate includes scratch disk.
- Warnings mention `/scratch` and "not backed up."
- Project disk usage renders separate scratch section.

Smoke tests:

1. Create dedicated host with `shared_disk_gb=200`.
2. Start project on host.
3. Verify inside project:
   - `/scratch` exists.
   - `/scratch` is writable.
   - `df -h /scratch` shows the scratch disk.
   - Writing to `/scratch` does not increase project quota.
4. Start a second project on same host.
5. Verify both projects see the same `/scratch` contents.
6. Stop/start host.
7. Verify `/scratch` contents persist.
8. Delete scratch disk.
9. Verify project startup fails or `/scratch` disappears according to the final
   delete semantics.

## Rollout Plan

1. Implement for one provider first, probably GCP or Nebius.
2. Hide UI behind provider capability.
3. Dogfood with a small scratch disk.
4. Test on a GPU host with a real dataset workflow.
5. Add the second provider.
6. Add disk usage UI polish.
7. Only then expose broadly.

## Open Questions

- Should `/scratch` be visible in all projects on the host by default, or should
  projects opt in?
- Should `/scratch` be `1777`, or should we create per-project directories with
  a shared group?
- Should stopped host spend accounting show scratch disk cost separately from
  compute cost in more places?
- Should delete scratch require host stopped, or can we unmount and detach live?
- Which provider should be implemented first for the fastest dogfood path?

