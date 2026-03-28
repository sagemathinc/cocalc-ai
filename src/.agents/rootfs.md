# RootFS Status And Launch Checklist

This document replaces the earlier RootFS launch plan that was written before
the rustic migration landed. It is intentionally short and product-oriented.

Last refreshed: March 28, 2026

## Executive Summary

RootFS is no longer a plan-only feature.

The core hosted workflow now works:

- projects run on managed immutable RootFS releases,
- users can publish the current project RootFS state,
- publishes store as rustic snapshots,
- managed releases use the rustic `snapshot_id` as their immutable identity,
- cross-host restore/cache works,
- host-local quota bookkeeping is now durable and no longer blocks publish,
- global and per-host concurrency controls now exist and have initial tuning
  data behind them.

The older btrfs-send-first architecture described in the original version of
this document is no longer the intended direction. The current technical source
of truth is [rootfs-rustic.md](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-rustic.md).

## Current Product State

### Working Today

- Managed RootFS catalog and immutable release registry.
- Project creation and project settings support managed RootFS selection.
- Users can publish current RootFS state from a project.
- Publish runs as an LRO with visible progress.
- Managed releases restore into host cache and can be used on other hosts.
- Host UI shows cache inventory and allows pull/delete operations.
- Instructors choosing RootFS for student projects is now implemented.
- Hosted RootFS publish/restore has initial exact-manifest and hardlink
  verification coverage.
- Self-hosted RootFS publish/restore through launchpad `rest-server` has now
  passed a live two-host smoke.

### Important Technical Decisions Now In Effect

- Rustic is the primary managed RootFS storage backend.
- Managed releases are identified by rustic `snapshot_id`, not by a custom
  full-tree SHA-256.
- Publish reads directly from the merged overlay view.
- Btrfs remains important locally for lowerdirs, overlays, cache entries, and
  host-local snapshots, but not as the main network distribution format.
- RootFS publish parallelism is now controlled by:
  - a high global safety cap,
  - and a separate per-host cap derived from host CPU count.

### Remaining Gaps

- Cross-region RootFS snapshot replication.
- Broader verification matrix for more real workloads:
  - `conda`
  - `pnpm`
  - `pip`
  - mixed scientific stacks
  - cross-region restore
- Catalog/admin lifecycle polish for official/public/collaborator images.
- Cleanup/removal of the remaining old btrfs delta assumptions and legacy
  storage-era codepaths.
- Vulnerability scan metadata integration for official images.

## Launch-Critical Product Requirements

These still stand.

### Image selection

Users must be able to choose from:

- official images,
- their own images,
- collaborator-published images with a warning,
- public images with a stronger warning.

Projects must bind to an exact immutable managed release, not just a mutable
alias.

### Official image lifecycle

Admins must be able to:

- promote an image to official,
- demote an official image,
- control whether it is prepulled,
- deprecate or hide catalog entries without breaking existing projects,
- remove an image from user-facing views immediately while deferring hard
  deletion until no projects use it,
- inspect provenance and usage,
- inspect vulnerability-scan status for official images.

### Project workflow

Changing the RootFS image for a project must remain allowed at any time. That
means:

1. stop the project,
2. unmount the current RootFS,
3. switch to the selected cached managed release,
4. restart the project.

### Host workflow

The host UI must show:

- which managed images are cached locally,
- how much space each image uses,
- how many projects are using each image,
- whether an image is official / prepulled / locally stale,
- pull and delete controls.

## Launch Checklist

### Already Done

- Managed RootFS publish/restore works in hosted development.
- Cross-host start smoke has passed.
- RootFS publish no longer spends time computing a separate whole-tree digest.
- Manifest-based fidelity verification exists.
- Worker admission and quota handling are no longer naive bootstrap versions.

### Next High-Value Work

1. Expand verification to more real package-manager workloads.
2. Keep self-hosted `rest-server` RootFS smoke in the ongoing regression mix.
3. Finish official-image/admin lifecycle polish.
4. Add cross-region replication.
5. Remove remaining btrfs-delta-era complexity.

## Document Relationship

Use the docs like this:

- [rootfs-rustic.md](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-rustic.md)
  is the active technical status and implementation document.
- This file is the shorter launch/product checklist.

If these documents disagree on storage/backend details, `rootfs-rustic.md`
wins.
