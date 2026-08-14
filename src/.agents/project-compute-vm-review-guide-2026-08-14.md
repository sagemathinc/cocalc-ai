# Project Compute VM v2 Review Guide

Status: implementation review and production-release guide as of 2026-08-14.

This is a map for reviewing the managed VM rewrite without reading the commits
or large files in arbitrary order. The normative product designs remain:

- [Project Compute VM v2 specification](./project-compute-vm-v2-spec-2026-08-12.md)
- [Windows Server support plan](./project-compute-vm-windows-support-plan-2026-08-13.md)

## Executive Model

A managed VM is an account-owned logical lease attached to one project. The
account home bay is authoritative for lifecycle, billing, provider work, and
agent grants. The attached project's owning bay is authoritative only for
project membership, its SSH key, and the managed `~/.ssh/config` block.

The hub is control plane. SSH, HTTPS, RDP-over-SSH, and file transfer go
directly between the project/client and VM.

Each v2 VM has:

- an immutable logical UUID, owner, project, operating system, and random DNS
  hostname;
- a replaceable provider instance generation;
- one persistent boot disk;
- an optional independent Linux home volume mounted at `/home/user`;
- a public IPv4 address retained while desired state is running and released
  on explicit stop;
- fixed public TCP ports 22 and 443;
- an itemized immutable price snapshot and funding lane; and
- a durable work queue, event history, instance history, and reconciliation
  state.

The guest receives no CoCalc account cookie, database credential, provider
credential, Cloudflare credential, or cloud service account.

## Recommended Review Order

### 1. Product contract and public types

Read:

- `src/.agents/project-compute-vm-v2-spec-2026-08-12.md`
- `src/.agents/project-compute-vm-windows-support-plan-2026-08-13.md`
- `src/packages/conat/hub/api/compute.ts`
- `src/packages/server/compute/types.ts`

Check that the public API exposes normalized provider-neutral fields and never
provider credentials or reusable secrets. Windows must remain GCP/x86-64/CPU
only in the first version. Linux supports GCP and Nebius, GCP ARM64, and
catalog-compatible GPUs.

### 2. Durable state and legacy boundary

Read:

- `src/packages/util/db-schema/compute-vms.ts`
- `src/packages/util/db-schema/compute-volumes.ts`
- `src/packages/util/db-schema/compute-resource-work.ts`
- `src/packages/util/db-schema/compute-vm-instances.ts`
- `src/packages/util/db-schema/compute-vm-turn-grants.ts`
- `src/packages/util/db-schema/compute-vm-orphans.ts`
- `src/packages/server/compute/contract.ts`
- `src/packages/server/compute/db.ts`
- `src/packages/server/compute/volume-db.ts`

Important distinction:

- owner/project list and mutation selectors return v2 rows only;
- billing, egress, expiry, emergency-stop, and periodic work select v2 rows
  only; but
- provider inventory intentionally includes pre-v2 rows so their instances and
  disks are not classified as orphans.

The positive v2 VM discriminator is allocated `public_hostname`, non-null
`bootstrap_revision`, and a valid `funding_mode`. The volume discriminator is
role `home` plus a valid funding lane. A stale queued work item also checks this
contract before doing anything.

### 3. Admission and API authority

Read `src/packages/server/conat/api/compute.ts` in this order:

1. `getCatalog`: live providers, OS choices, placement, funding eligibility,
   prices, and limits.
2. `createVolume`, `resizeVolume`, and volume deletion/funding.
3. `createVm`: owner home-bay routing, project membership, SSH authorization,
   placement validation, price snapshots, hostname allocation, and enqueue.
4. list/get methods: account ownership versus project-scoped discovery.
5. SSH and Windows RDP preparation.
6. start/stop/TTL/funding/machine/delete mutations.
7. orphan and agent-grant administration.

Every billable or destructive human action must require account authority and
fresh browser-backed authentication. Project ambient credentials can list and
use project-scoped data-plane access but must not become account billing
authority.

### 4. Provider-neutral lifecycle worker

Read `src/packages/server/compute/worker.ts` by flow, not top-to-bottom:

- `startComputeVmWorker` and queue claiming;
- `handleWork` contract gate and action dispatch;
- `provision`, `start`, `stop`, `remove`, and `reconcile`;
- `ensureVmPublicAddress`, `ensureVmDns`, and `releaseVmNetwork`;
- `markReady` and OS-aware readiness;
- Spot retry, Standard fallback, and return-to-Spot probing;
- VM/volume funding enforcement and billing reconciliation;
- serialized public-egress metering; and
- provider inventory plus delayed orphan remediation.

Core lifecycle expectations:

```text
create -> requested -> provisioning -> starting -> ready
ready -> stopping -> stopped
stopped -> starting -> ready
ready -> recovering -> ready              # Spot interruption
any active state -> deleting -> deleted
```

Review each provider mutation for observation before retry. A timeout must not
blindly create a second instance, disk, address, or DNS record.

### 5. Provider boundary and guest bootstrap

Read:

- `src/packages/server/compute/provider.ts`
- `src/packages/cloud/gcp.ts`
- `src/packages/cloud/nebius/provider.ts`
- `src/packages/cloud/nebius/client.ts`
- `src/packages/server/cloud/gcp/compute-vm-setup.sh`

`provider.ts` translates the normalized contract into provider calls and is
where GCP/Nebius differences should stop leaking upward. Review:

- stable address create/attach/release;
- provider instance identity, especially numeric GCP identity for egress;
- no guest service account;
- fixed firewall tags/rules and no public RDP 3389;
- persistent boot-disk reuse across provider generations;
- home-volume location and attachment fencing;
- Nebius provisional identities and 93 GB allocation increments;
- GPU-compatible images and driver readiness; and
- Linux cloud-init versus Windows PowerShell bootstrap quoting/idempotence.

Linux readiness verifies `user`, UID/GID, `/home/user`, bootstrap revision,
authorized keys, and the expected home mount. Windows readiness verifies the
administrator user, OpenSSH, Terminal Services, key ACLs, and bootstrap marker.
Readiness fails closed.

### 6. Pricing, funding, and egress

Read:

- `src/packages/server/compute/pricing.ts`
- pricing sections of `src/packages/server/conat/api/compute.ts`
- billing and egress sections of `src/packages/server/compute/worker.ts`
- `src/packages/util/db-schema/compute-site-funded-usage.ts`

The price snapshot itemizes compute, disk, public IPv4, Windows license, and
configured surcharge. Spot discounts compute, not the Windows license.
Compute and Windows licensing accrue only while running; boot and home disks
remain billable while stopped.

Funding lanes exactly follow dedicated-host policy:

- site-funded for site administrators;
- account prepaid when balance/membership permit; and
- account postpaid when membership and automatic billing permit.

GCP customer egress is $0.10/GB. Site-funded egress is paid by the site. Nebius
currently reports $0/GB. GCP metering uses the immutable numeric instance ID so
name reuse or provider generations cannot add another VM's traffic.

### 7. Project SSH and agent authority

Read:

- `src/packages/server/projects/managed-vm-ssh-config.ts`
- `src/packages/project/conat/api/system.ts` and its managed-VM SSH tests
- `src/packages/server/compute/ssh-authorization.ts`
- `src/packages/server/compute/turn-grants.ts`
- host/project compute authorization methods in the Conat API

When enabled, the project owns a bounded managed config block whose alias is
exactly the VM name. Thus `ssh foo` works from the attached project. Cross-bay
writes route through the project owning bay and project host.

Codex receives only an exact, expiring capability tied to project and turn.
Billable/destructive grants require fresh auth and carry provider, machine,
funding, TTL, hourly, and total-spend envelopes. No account session is copied
into the project.

### 8. CLI and frontend

Read:

- `src/packages/cli/src/bin/commands/vm.ts`
- `src/packages/frontend/project/compute-vms-cli.ts`
- `src/packages/frontend/project/compute-vms.tsx`
- `src/packages/docs/src/content/projects.ts`

CLI review should cover catalog discovery, account versus ambient-project
authentication, wait behavior, SSH key authorization, direct SSH, Linux
`rsync`, Windows `rdp`, machine changes while stopped, TTL, funding, volumes,
and JSON output.

Frontend review should follow user tasks:

1. create from catalog defaults;
2. filter OS/provider/architecture/GPU/region/machine compatibility;
3. review the exact disk and price confirmation;
4. observe state and provider errors;
5. connect using project alias first;
6. inspect running/stopped price and egress;
7. stop/start and edit machine type while stopped;
8. create similar, change funding/TTL, and delete; and
9. create, grow, and delete detached Linux home volumes.

## Destructive Boundaries

### Stop

- stops provider compute;
- preserves the boot disk and home volume;
- releases the public address;
- removes the DNS record but preserves the logical hostname string;
- removes the project SSH config block; and
- stops compute/Windows-license accrual while disk charges continue.

### Spot interruption

- preserves logical VM identity, boot disk, address, hostname, and project
  alias;
- retries Spot with bounded backoff;
- may use Standard for at most the authorized fallback window; and
- returns to Spot only through a capacity probe.

### Delete VM

- deletes provider instance, persistent boot disk, address, and DNS record;
- removes project SSH config;
- finalizes egress/billing state; and
- detaches but does not delete an independent home volume.

### Delete volume

- requires the volume to be detached;
- deletes the provider disk permanently; and
- must never be inferred from VM deletion.

## Existing Production VM Preservation

Production currently has one pre-v2 VM:

```text
name:          bench-1
logical id:    ea98aa5b-5e39-478d-a47b-2e9edc1c6e35
provider VM:   cocalc-vm-ea98aa5b5e39478da47b2e9e
zone:          us-south1-c
login/home:    ubuntu, legacy layout
boot disk:     cocalc-vm-ea98aa5b5e39478da47b2e9e-boot (20 GB)
work volume:   bench-1-work / 68cffcf8-58c6-4d92-ab4f-95f942fcb396
provider disk: cocalc-vol-68cffcf858c64d92ab4f95f9 (50 GB ext4)
mount:         /work
```

The v2 contract gate deliberately forgets this row operationally:

- it is not listed by v2 account/project APIs;
- v2 cannot start, stop, delete, bill, meter, expire, or reconcile it;
- stale queued work becomes a no-op; and
- inventory still treats the instance, boot disk, and work disk as expected,
  so orphan remediation cannot stop or delete them.

The provider may still preempt this Spot VM; v2 will not recover a quarantined
legacy instance. Preserve data before relying on it.

Recommended retirement sequence:

1. Copy and verify `/work` data into a new v2 `/home/user` volume or another
   independent backup.
2. Stop/delete the old provider VM manually only after verification.
3. Keep or delete the old work disk explicitly according to the verified copy.
4. Remove the quarantined database rows only after all provider resources have
   been intentionally resolved. Removing rows first would expose resources to
   delayed orphan remediation.

## High-Risk Review Checklist

- No provider mutation is retried without observation/idempotency.
- Provider instance identity cannot alias after preemption or recreation.
- A missing VM never implies that its persistent boot disk is disposable.
- An unknown disk or address is observed through a grace period before delete.
- Legacy rows remain protected inventory but cannot enter v2 work.
- Stop and Spot interruption have intentionally different address behavior.
- DNS failure degrades access but cannot destroy a healthy VM.
- Project SSH writes route to the project owning bay.
- Project collaborators do not gain account billing or destructive authority.
- RDP 3389 is never public; passwords require fresh auth and are not persisted.
- Windows licensing is present in both Spot and Standard running totals and
  absent from stopped totals.
- Site-funded resources produce no customer purchase.
- Nebius volume requested/effective sizes and prices use the same allocation
  increment.
- GCP GPU selections constrain machine, zone, image, and GPU together.
- Boot disks cannot silently clamp or claim to be growable.
- VM deletion never deletes a retained home volume.

## Focused Validation

Run at minimum:

```sh
cd src/packages/server
pnpm tsc --build
COCALC_TEST_USE_PGLITE=1 NODE_OPTIONS='--experimental-vm-modules' \
  TZ=UTC pnpm exec jest compute --runInBand

cd ../cloud
pnpm test -- --runInBand

cd ../cli
pnpm test -- vm --runInBand

cd ../../
pnpm lint:frontend
pnpm tsc
```

Before production, deploy and smoke on staging:

- hub/control plane and schema;
- static frontend/docs;
- project image/tools needed for managed project SSH and current CLI;
- Linux GCP x86-64 and ARM64;
- Linux Nebius CPU and GPU where quota permits;
- Windows GCP SSH and private RDP;
- Spot fallback, explicit stop/start, machine edit, delete;
- persistent home create/attach/grow/retain/delete; and
- provider inventory/orphan reports with no unexpected candidates.

Do not couple the first VM v2 production release to an ACP-worker rollout. ACP
and subagent activity can be merged in source while their worker artifact is
deployed independently after its own review and staging qualification.
