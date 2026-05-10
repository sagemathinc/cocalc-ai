# Dedicated Host Followups

Status: working followup note as of 2026-05-09.

This note records product and implementation followups that came out of manual
testing and release planning on 2026-05-09.

## Spend Exhaustion Policy

The current dedicated-host spend maintenance path in:

- `src/packages/server/project-host/spend-maintenance.ts`

stops hosts when the active funding lane is no longer valid.

That is not the final intended product behavior.

### Desired policy

For hosted `cocalc-ai`, when a user's dedicated-host spend cannot continue, the
system should:

1. ensure a final backup of all projects on the host
2. stop the host when the limit is close
3. deprovision the host when the hard spend limit is hit
4. avoid deleting user data as part of this path

The only acceptable data loss in this flow is loss of snapshots, not loss of
project data.

### Why this is acceptable now

Unlike the older `cocalc.com` policy problem, `cocalc-ai` has durable R2 rustic
backups. That changes the policy:

- we do not need to choose between runaway provider spend and immediate user
  data deletion
- we can preserve user data first, then stop/deprovision cloud resources

### Required implementation direction

This should go through the existing host drain path, not a custom stop-only
path:

- `src/packages/server/conat/api/hosts-drain.ts`

That path already has the right mechanism to bypass normal managed egress
limits for administrative drain backups:

- `managed_egress_override: "admin-host-drain"`

Relevant enforcement/bypass code exists in:

- `src/packages/project-host/backup-egress.ts`
- `src/packages/project-host/raw-network-egress.ts`
- `src/packages/server/projects/backup-worker.ts`

So the spend-exhaustion behavior should evolve toward:

- drain with final backup
- stop
- later deprovision

not:

- immediate stop with no guaranteed final backup

## Remaining Feature Blockers Before “Only Soak / Stress”

After the spend-exhaustion work is defined correctly, the remaining intentional
feature work should stay narrow:

- dedicated-host owner access control
- student pay
- minimal domain/site license

After those are in place, the remaining work should be stress testing,
operational hardening, and bug-fixing rather than new product surface area.

## GPU Runtime Validation Gap

Manual Nebius GPU testing found a real runtime usability gap:

- `nvidia-smi` sees the GPU
- PyTorch and TensorFlow did not successfully use the GPU
- the observed errors suggested version/runtime incompatibility

This strongly suggests a rootfs/bootstrap/runtime validation gap rather than a
pure cloud provisioning failure.

### Likely problem classes

- CUDA userspace mismatch
- container / Python package mismatch
- rootfs image not validated against the GPU driver/runtime stack
- bootstrap steps not installing or pinning the expected runtime pieces

### Release implication

This is exactly the kind of issue that will appear during hosted soak even when
the control plane itself works correctly.

The supported GPU offer needs:

- a known-good rootfs or image story
- a validation matrix for the supported frameworks we claim to support
- explicit smoke coverage beyond `nvidia-smi`

At minimum the smoke should cover:

- GPU visible via `nvidia-smi`
- PyTorch CUDA tensor allocation
- TensorFlow device visibility / basic GPU op

## Store / UI Coherence

Some product pages still read as a wall of loosely assembled React components.

The current store page is the clearest example.

This is not a launch-blocking architecture issue, but it is a first-impression
trust issue and should be treated as part of the final hosted polish/UX pass,
not ignored indefinitely.

The right framing is:

- no broad feature expansion
- yes to bounded coherence/usability work on user-facing purchase pages

