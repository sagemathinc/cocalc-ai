# RootFS Launch Plan

This document is a detailed implementation plan for the RootFS image system that
CoCalc needs for launch.

It is written against the current state of the repo on March 21, 2026:

- projects already run on overlayfs over a selected rootfs image,
- project snapshots and restore now preserve rootfs and HOME correctly,
- there is now a managed RootFS catalog in Postgres,
- there is now an immutable RootFS release registry in Postgres,
- project creation and project settings now use the managed catalog,
- projects currently store both a runtime image ref and a managed image id,
- users can publish RootFS state from a project via UI, CLI, and LRO,
- hosts have a RootFS cache UI and RPCs for list/pull/delete,
- cross-host distribution works today through a hub-local artifact backend,
- R2 artifact storage is not implemented yet,
- course image selection is not implemented yet,
- incremental release storage is not implemented yet.

The goal of this plan is to turn RootFS into a first-class product primitive,
not just a freeform container-image string.

## Executive Summary

My view is:

1. This is a launch-critical feature, not a nice-to-have.
2. The hosted product should stop thinking in terms of arbitrary mutable OCI
   tags and instead think in terms of immutable RootFS releases.
3. R2 plus btrfs send streams should be the primary distribution format for the
   hosted product.
4. OCI images should still matter, but mainly as build input and fallback
   import format, not as the runtime identity of what a project uses.
5. The correct model is:
   - official images,
   - user-owned images,
   - collaborator-published images,
   - public images,
     with different trust/warning levels.
6. Projects must store the exact immutable RootFS release they use.
7. Admin promotion, prepull, host inventory, and course-level image selection
   are all part of the minimum launch architecture.
8. Changing the image for a project must remain allowed at any time.

The single most important design choice is this:

- users browse catalog entries,
- projects store resolved immutable releases.

That distinction is what makes promotion, reproducibility, and lowerdir
stability work.

## Current Status

As of March 22, 2026, the RootFS effort has moved from plan-only into a real
vertical slice.

### Implemented

- managed RootFS catalog rows and immutable release rows exist centrally,
- project creation can select managed RootFS images,
- project settings can:
  - switch images,
  - save catalog metadata,
  - publish current project RootFS state,
- publish runs as an LRO with visible progress and persistent error display,
- CLI support exists for:
  - listing images,
  - saving catalog entries,
  - publishing project RootFS state,
  - waiting on the publish LRO,
- host cache inventory exists with pull/delete controls,
- cross-host distribution works for managed releases,
- there is now a useful non-R2 fallback path via the central hub, which is
  relevant for self-hosted deployments without managed object storage.

### Implemented but not yet in the final shape

- project binding still includes a runtime image string in addition to the
  managed id; this should keep moving toward exact release binding,
- artifact transport currently uses the hub-local backend instead of R2,
- publish currently materializes a full tree before send; incremental release
  storage is still future work.

### Not implemented yet

- R2-backed artifact storage and retrieval,
- official build pipeline producing canonical hosted artifacts,
- course image selection,
- collaborator/public lifecycle moderation polish,
- dependency-aware incremental release storage and GC,
- production-grade benchmark and soak data on production-like host disks.

### Immediate next win

The next big milestone should be:

1. bring R2 into the artifact path,
2. rerun publish/download/create benchmarks end-to-end,
3. do those benchmarks on hosts with production-level disks rather than tiny
   dev disks.

## Work Section: Durability

RootFS operations on the project-host are now good enough to build product
workflows on top of, but they are still mostly **retryable** rather than truly
**durable/resumable** across a project-host daemon restart.

This needs to be part of the RootFS project, not treated as optional cleanup.

### Current durability shape

- hub/database-backed metadata actions are mostly durable:
  - catalog edits
  - hide/block/delete
  - central release GC
- host-executed RootFS work is usually not resumable:
  - RootFS publish/materialize/send/upload
  - managed artifact download/receive
  - project start while caching/switching RootFS
- many host paths are reasonably retry-safe, but a daemon restart can still:
  - fail the active operation,
  - leave temporary Btrfs subvolumes behind,
  - leave stale overlay mounts behind,
  - leave incomplete multipart uploads/download state behind.

### Required durability work

We should implement the following in a deliberate hardening pass.

1. Host draining / maintenance mode

- before an admin restart or software rollout, mark the host as draining,
- stop accepting new RootFS publish/cache/start work,
- wait for active RootFS operations to finish or time out cleanly,
- expose this state in host/admin UI and CLI.

2. Persisted host-side RootFS jobs

- represent long host-side RootFS work as explicit durable jobs in host-local
  sqlite,
- on project-host startup, reconcile incomplete jobs and decide whether to:
  - resume,
  - roll back,
  - or mark failed with a clear reason,
- do not rely on in-memory RPC call stacks as the only state for long work.

3. Startup scrubbing and recovery

- on project-host startup, scrub stale:
  - `.managed-rootfs-receive-*`
  - `.rootfs-publish-tree-*`
  - `.rootfs-artifact-*`
  - stale overlay mountpoints
- keep the scrubber conservative and scoped to paths we created.

4. Better multipart transfer recovery

- uploads/downloads do not need perfect byte-range resume immediately,
- but they should at least:
  - detect abandoned multipart sessions,
  - abort or reclaim them,
  - and fail with a state that can be retried automatically.

5. LRO recovery semantics

- make it clear which RootFS LROs are:
  - resumable,
  - retryable,
  - or terminal after restart,
- after host restart, hub-side workers should reconcile outstanding RootFS
  operations instead of leaving ambiguous UI state.

6. Failure-injection testing

Add explicit tests for restarting/killing the project-host during:

- RootFS publish before artifact upload,
- RootFS publish during multipart upload,
- managed artifact download,
- incremental receive,
- project start while switching/caching RootFS,
- host cache GC.

7. Worker concurrency tuning

- do not treat the current RootFS worker parallelism defaults as final product
  settings,
- `1` is a conservative bootstrap value, not necessarily the right long-term
  number,
- empirically tune at least:
  - RootFS publish parallelism,
  - RootFS restore/cache parallelism,
  - RootFS GC / prune parallelism,
- account for:
  - host disk throughput,
  - CPU and memory pressure,
  - object-storage / rest-server bandwidth,
  - the fact that one wedged operation must not block all later work,
- make the tuned limits configurable per deployment or host class rather than
  baking in one universal number.

### Exit criterion

The durability milestone is complete when an admin can restart a project-host in
the middle of RootFS activity and the system reliably does one of:

- cleanly finishes the operation,
- cleanly resumes it,
- or cleanly fails it and leaves the next retry safe and obvious.

## Product Requirements

The system must support all of the following.

### Required image sources in project creation

When creating a new project, a user must be able to choose from:

- official images,
- their own images,
- images published by their collaborators, with a small warning,
- general public images, with a big warning.

### Required admin workflows

Admins must be able to:

- promote an image to official,
- demote an official image,
- mark whether an image is automatically prepulled to new project hosts,
- deprecate or hide an image from the catalog without breaking existing
  projects,
- remove an image from all user-facing views immediately, while deferring hard
  deletion until no projects use it,
- inspect the provenance and usage of an image,
- inspect vulnerability scan status and scan provenance for official images.

### Required host workflows

The project-host UI must show, per host:

- which images are cached locally,
- how much disk space each image uses,
- how many projects are using each image,
- whether the image is official / prepulled / locally stale,
- buttons to pull and delete a cached image.

### Required course workflow

Instructors must be able to specify the RootFS image that student projects use.

### Required publication workflow

Users must be able to publish their own images.

For launch, "publish image" should mean publishing a captured immutable RootFS
release, not merely sharing an arbitrary mutable OCI tag with others.

### Required distribution model

Official and published images must be stored in R2 using btrfs send streams so
that project hosts can receive them efficiently and exactly.

### Required security metadata

We are not implementing vulnerability scanning itself inside RootFS, but the
metadata model must support it from the start. For at least official releases,
we need to store:

- scan status,
- scanner/pipeline name,
- scan completion time,
- summary counts / human summary,
- optional report URL or opaque scanner metadata.

Promotion of official images should eventually depend on either a recent clean
scan or an explicit admin override.

### Required image switching workflow

Changing the RootFS image for a project must remain allowed at any time.

This means:

1. stop the project,
2. fully unmount the current rootfs,
3. switch to the selected lowerdir and the matching per-image upperdir,
4. restart the project.

Users must be able to switch back later. When they do, the old per-image
changes under `/` become visible again. Changes in `/root` and `/scratch` are
separate from this and remain governed by HOME and scratch behavior.

## What I Think We Should Build

The right model is not "an image is a Docker tag". The right model is:

- a RootFS release is an immutable filesystem artifact,
- a catalog entry is a mutable publishing/view layer around that release.

This means we need to separate:

- exact runtime identity,
- product labeling and promotion,
- regional artifact replicas,
- local host cache state.

That implies at least:

- one central table for immutable image releases,
- one central table for publishing/catalog metadata,
- one central table for artifact replicas,
- one host-side inventory model for local cache state.

## Terminology

These names matter because they remove ambiguity.

### RootFS release

An immutable filesystem artifact that can be mounted as the lowerdir for a
project.

Examples:

- official CPU image build for `2026.04`,
- official GPU image build for `2026.04`,
- a user-published customized Sage/Julia environment captured from a project.

### Catalog entry

A mutable, user-facing listing that points at one RootFS release and controls:

- visibility,
- labels,
- optional theme,
- warnings,
- whether it is official,
- whether it should be prepulled.

### Image family

A product concept such as:

- official CPU,
- official GPU.

A family has many releases over time.

### Catalog version metadata

Catalog entries should optionally carry:

- `family`
- `version`
- `channel`
- `supersedes_image_id`

This is a product-layer concept, not a storage-layer concept.

It exists so the UI can express:

- what series an image belongs to,
- whether a newer version exists,
- whether an entry is stable/beta/nightly,
- and what older catalog entry it should upgrade from.

This must remain separate from `parent_release_id`, which exists only for
incremental storage and transport.

### Publish scope

Who can discover/select a catalog entry:

- private,
- collaborators,
- public,
- official.

### Content key

The exact immutable key for a RootFS release. This is what the project must
bind to.

## Exact Identity and Immutability

The lowerdir of a project must not change under the project's feet.

Therefore:

- a project must never store "latest",
- a project must never store a mutable Docker tag as its only identity,
- a project must store an immutable release id and content key.

### Recommended immutable identity

The primary identity of a RootFS release should be:

- `content_key = sha256(canonical_full_filesystem_tree_bytes)`

This key represents the complete logical RootFS content, independent of how we
store or transport that release.

This does **not** mean we stop hashing the btrfs send stream artifacts. It
means we separate:

- logical release identity: `content_key`
- exact stored artifact identity: `btrfs_stream_sha256`, `tar_zst_sha256`, etc.

That distinction becomes necessary once incrementals exist, because the same
logical release may have more than one transport artifact over time.

and the system should also store:

- `artifact_kind`
  - `full`
  - `delta`
- `artifact_format`
  - `btrfs-send`
  - `btrfs-send-incremental`
  - `tar-zst`
- `artifact_sha256` for the exact stored artifact,
- `artifact_bytes`,
- `parent_release_id` and `parent_content_key` when the artifact is
  incremental,
- `oci_digest` if the release came from an OCI image,
- `tree_sha256` or equivalent manifest hash if we later want stronger
  filesystem-level verification,
- exact architecture,
- gpu/cpu capability,
- release metadata.

Why split release identity from artifact identity:

- a project must bind to the full logical release, not one particular transport
  artifact,
- the same release may later have both a full artifact and one or more
  incremental artifacts,
- incremental storage should not change the identity of the release,
- it avoids coupling release identity to whichever parent chain happened to be
  chosen at publish time.

### Project binding rule

Projects should store:

- `rootfs_image_id` or `rootfs_release_id`,
- `rootfs_content_key`,
- optionally the source display label for UX only.

The project record must not depend on a mutable alias after creation.

### Promotion rule

Admin promotion of a newer official image should affect:

- new projects,
- explicit user switches,

but must not silently mutate the lowerdir of existing projects.

### Architecture rule

Each RootFS release should correspond to exactly one architecture.

I do not think a true runtime "multi" RootFS release is useful here, because
these are real Linux filesystems with architecture-specific binaries. The
catalog can group sibling amd64 and arm64 releases under one family, but the
project must always bind to one exact release for one exact architecture.

## Data Model

I recommend three central logical models:

1. immutable RootFS releases,
2. mutable catalog/publishing state,
3. regional artifact replica state,
4. per-host cache state.

This can be implemented as three central Postgres tables plus one host-local
inventory table mirrored via RPC. For launch, I recommend central Postgres for:

- releases,
- catalog,
- artifact replicas,

and host-local sqlite plus RPC for cache state.

## Proposed Postgres Tables

### 1. `rootfs_releases`

Immutable release rows.

Suggested fields:

- `release_id UUID PRIMARY KEY`
- `created TIMESTAMP`
- `last_edited TIMESTAMP`
- `status TEXT`
  - `building`
  - `ready`
  - `failed`
  - `deprecated`
  - `deleted`
- `owner_id UUID NULL`
  - null for system-owned official builds
- `origin_project_id UUID NULL`
- `origin_snapshot_name TEXT NULL`
- `origin_type TEXT`
  - `official-build`
  - `project-publish`
  - `imported-oci`
- `family TEXT NULL`
  - `official-cpu`
  - `official-gpu`
  - null for ad hoc user images
- `version TEXT NULL`
- `label TEXT`
- `description TEXT`
- `theme JSONB NULL`
- `arch TEXT`
  - `amd64`
  - `arm64`
- `gpu BOOLEAN`
- `content_key TEXT UNIQUE`
- `parent_release_id UUID NULL REFERENCES rootfs_releases(release_id)`
- `parent_content_key TEXT NULL`
- `artifact_kind TEXT`
  - `full`
  - `delta`
- `artifact_format TEXT`
  - `btrfs-send`
  - `btrfs-send-incremental`
  - `tar-zst`
- `btrfs_stream_sha256 TEXT UNIQUE`
- `btrfs_stream_bytes BIGINT`
- `tar_zst_sha256 TEXT NULL`
- `tar_zst_bytes BIGINT NULL`
- `oci_ref TEXT NULL`
- `oci_digest TEXT NULL`
- `r2_bucket TEXT`
- `r2_prefix TEXT`
- `manifest JSONB`
  - release metadata, packages, notes, build info
- `build_log JSONB`
- `build_error TEXT NULL`
- `deprecated BOOLEAN`
- `deprecated_reason TEXT NULL`

Important rule:

- `content_key`, `arch`, `gpu`, and the stream checksums are immutable once the
  release is `ready`.

Important incremental rule:

- `parent_release_id` must point to another immutable release, not to a mutable
  catalog entry,
- `content_key` always describes the full logical tree,
- the parent pointer only describes how one artifact can be reconstructed
  efficiently.

### 2. `rootfs_catalog_entries`

Mutable publish/presentation rows.

Suggested fields:

- `entry_id UUID PRIMARY KEY`
- `release_id UUID REFERENCES rootfs_releases(release_id)`
- `created TIMESTAMP`
- `last_edited TIMESTAMP`
- `owner_id UUID NULL`
- `scope TEXT`
  - `private`
  - `collaborators`
  - `public`
  - `official`
- `warning_level TEXT`
  - `none`
  - `small`
  - `big`
- `active BOOLEAN`
- `official BOOLEAN`
- `prepull BOOLEAN`
- `featured_rank INTEGER`
- `label TEXT`
- `short_label TEXT NULL`
- `description TEXT`
- `theme JSONB NULL`
  - use the existing shared theme structure for image blob, color, secondary
    color, icon, and title
- `notes TEXT NULL`
- `published_at TIMESTAMP NULL`
- `promoted_by UUID NULL`
- `review_status TEXT`
  - `unreviewed`
  - `reviewed`
  - `official`
  - `blocked`
- `review_notes TEXT NULL`

This table is what drives the picker UI.

### 3. `rootfs_release_artifacts`

Immutable or append-only replica rows for where release artifacts actually
exist.

Suggested fields:

- `artifact_id UUID PRIMARY KEY`
- `release_id UUID REFERENCES rootfs_releases(release_id)`
- `content_key TEXT`
- `backend TEXT`
  - `r2`
  - `hub-local`
- `region TEXT NULL`
- `bucket_id UUID NULL REFERENCES buckets(id)`
- `bucket_name TEXT NULL`
- `bucket_purpose TEXT NULL`
- `artifact_kind TEXT`
- `artifact_format TEXT`
- `artifact_path TEXT`
- `artifact_sha256 TEXT`
- `artifact_bytes BIGINT`
- `status TEXT`
  - `pending`
  - `ready`
  - `failed`
  - `deleted`
- `replicated_from_artifact_id UUID NULL`
- `error TEXT NULL`
- `created TIMESTAMP`
- `updated TIMESTAMP`

Important rule:

- a release is global and immutable,
- artifact rows describe where transport copies of that release exist,
- same-region publish and cross-region lazy replication should be modeled here,
  not by making the release itself regional.

### 4. Optional alias table: `rootfs_aliases`

This is not strictly required on day one, but it becomes useful if we want
stable names like:

- `official/cpu/current`
- `official/gpu/current`
- `official/cpu/2026.04`

Suggested fields:

- `alias TEXT PRIMARY KEY`
- `release_id UUID REFERENCES rootfs_releases(release_id)`
- `created TIMESTAMP`
- `last_edited TIMESTAMP`
- `owner_id UUID NULL`
- `kind TEXT`

If we do not add this at first, the same behavior can live in
`rootfs_catalog_entries`.

## Existing Table Changes

### `projects`

Add:

- `rootfs_image_id UUID NULL`
- `rootfs_content_key TEXT NULL`

Because this launchpad system is effectively greenfield, I do not think we
should contort the schema around legacy compatibility. We can do a hard cut and
update the code to use structured RootFS ids and content keys directly.

### `accounts`

Replace or augment:

- `default_rootfs_image`
- `default_rootfs_image_gpu`

with:

- `default_rootfs_image_id`
- `default_rootfs_image_gpu_id`

### Course settings

Wherever course configuration currently lives, add:

- `rootfs_image_id`
- optionally `rootfs_content_key`

The course should select a catalog entry or image release, and student-project
creation should resolve that to an immutable release.

## Host Cache Model

Hosts need their own cache inventory model, whether persisted centrally or only
locally.

For launch, I recommend:

- host-local sqlite for the authoritative cache inventory,
- admin RPC for querying/managing it from the hub UI.

### Suggested host cache fields

- `content_key TEXT PRIMARY KEY`
- `image_id UUID NULL`
- `label TEXT`
- `arch TEXT`
- `gpu BOOLEAN`
- `path TEXT`
- `disk_bytes BIGINT`
- `stream_sha256 TEXT`
- `cached_at TIMESTAMP`
- `last_used TIMESTAMP`
- `project_count INTEGER`
- `running_project_count INTEGER`
- `prepull BOOLEAN`
- `official BOOLEAN`
- `status TEXT`
  - `present`
  - `pulling`
  - `failed`
  - `deleting`
- `error TEXT NULL`

### Host cache rule

Deletion of a cached local image is only a host-cache operation. It must not
delete the central image record or R2 artifact.

### Project image switch rule

Each project should have one upperdir namespace per RootFS release. That is
already the right model conceptually, and we should preserve it explicitly.

This is what makes the following behavior work:

- a user switches from image A to image B,
- files they changed in `/` under image A are no longer visible,
- they later switch back to image A,
- those previous system-level changes become visible again.

This is important and desirable behavior, not an implementation accident.

## Distribution Format

For the hosted product:

- primary distribution format: btrfs send stream in R2,
- secondary fallback format: tar.zst in R2,
- tertiary fallback: OCI pull/import path for bootstrap and recovery.

### Transport strategy

We should support both of the following artifact-upload modes:

- staged upload
  - `btrfs send` to a local file, then upload that file
- direct streaming upload
  - `btrfs send` streamed directly into the R2 multipart uploader

My recommendation is:

- keep both modes in the design,
- use direct streaming as the preferred hosted steady-state path,
- keep staged upload as a fallback/debug path and for self-hosted situations
  where disk is fast but uplink bandwidth is poor.

Why keep both:

- direct streaming avoids an extra local write plus read and may be materially
  better on slow cloud disks,
- staged upload is simpler to retry, inspect, and resume operationally,
- we already have working file-based send/receive code, so it is a good first
  R2 implementation path and a useful fallback forever.

### Region strategy

We should make region a property of the artifact replica, not of the release.

Recommended policy:

1. publish a new release into the same region as the publishing host first,
2. record that as a regional artifact replica,
3. when another host needs the release:
   - prefer a same-region replica,
   - otherwise use any ready replica,
4. after a successful cross-region restore, enqueue background replication into
   the local region.

This gives us:

- fast local restores when replicas exist,
- correct fallback behavior when they do not,
- a simple path to demand-driven replication,
- a clean upgrade path later for proactive replication of official/prepull
  images.

### Bucket strategy

For now, RootFS artifacts should reuse the existing per-region backup buckets,
but under a dedicated prefix or subdirectory, e.g.:

- `rootfs/releases/<content_key>/full.btrfs`

This avoids creating a second regional bucket fleet while still keeping RootFS
artifacts logically separated from backup data.

### Why this is the right choice

Because the official CPU image will likely be large. Even if it is only
"moderate" in OCI terms, registry pull plus layer unpack is often much slower
than downloading a single content-addressed filesystem artifact and receiving it
into btrfs.

That especially matters for:

- new host bootstrap,
- prepull,
- disaster recovery,
- multi-region rollout,
- self-host launchpad setup.

### Incremental release strategy

We should support incremental releases, but not as a Docker-style runtime layer
stack.

The runtime model should stay simple:

- each project mounts one materialized lowerdir for one immutable release.

The storage model should be incremental:

- a release may have an optional parent release,
- the release content is still identified by its own full `content_key`,
- the stored btrfs artifact may be:
  - a full send stream,
  - or an incremental send stream relative to the parent.

This gives the desired behavior:

- start from a 20 GB release,
- make 100 MB of changes,
- publish a child release,
- only store roughly the changed extents as the new artifact.

On hosts, the natural implementation is:

1. materialize the parent release as a btrfs subvolume,
2. make a writable btrfs snapshot,
3. apply the new merged RootFS onto it with reflink-friendly copy plus
   `--delete`,
4. freeze it as a readonly release snapshot,
5. compute the child `content_key`,
6. upload either a full or incremental btrfs send stream.

This is much better than trying to expose Docker-like runtime layers to the
rest of the system.

### Incremental retention and GC rule

Because child releases depend on parent releases:

- we must never hard-delete a release that still has child releases,
- we must never hard-delete a release that any project still references,
- user-facing delete should first hide/block the catalog entry,
- actual artifact GC should happen only after dependency and project reference
  counts drop to zero.

We should also periodically squash long chains:

- create full checkpoint releases every N generations or after a size ratio
  threshold,
- keep delta chains shallow enough that bootstrap and recovery remain fast.

### Canonical layout in R2

For each `content_key`:

- `rootfs/<content_key>/full/image.btrfs`
- `rootfs/<content_key>/full/image.btrfs.sha256`
- `rootfs/<content_key>/delta/from/<parent_content_key>/image.btrfs`
- `rootfs/<content_key>/delta/from/<parent_content_key>/image.btrfs.sha256`
- `rootfs/<content_key>/image.tar.zst`
- `rootfs/<content_key>/image.tar.zst.sha256`
- `rootfs/<content_key>/manifest.json`

`manifest.json` should include:

- `content_key`
- `parent_content_key`
- `arch`
- `gpu`
- `label`
- `family`
- `version`
- `oci_ref`
- `oci_digest`
- `artifact_kind`
- `artifact_format`
- `btrfs_stream_sha256`
- `btrfs_stream_bytes`
- `tar_zst_sha256`
- `tar_zst_bytes`
- `build_time`
- `build_host`
- `parent_release_id`

### Host local layout

Use content-addressed directories:

- `/btrfs/rootfs/<content_key>/`

This directory is the lowerdir that project overlayfs mounts use.

## Self-Hosted Basic Mode

We should be explicit that managed RootFS publishing and distribution requires
the site to configure the object-storage path properly.

For launchpad sites that do not configure the managed RootFS artifact path,
there should be a degraded self-hosted mode:

- basic OCI / Docker image selection only,
- no official/user/collaborator/public managed catalog,
- no publish/promote/prepull guarantees,
- no expectation of fast cached btrfs distribution,
- clear warning that mileage may vary.

This should be documented plainly in the product and admin UI.

## Build and Publish Workflows

There are two different ways RootFS releases should enter the system.

### A. Official build workflow

Input:

- controlled Dockerfile / build recipe / OCI base.

Output:

- canonical btrfs subvolume,
- btrfs send stream uploaded to R2,
- `rootfs_releases` row,
- optional catalog entry,
- optional prepull flag.

Recommended official launch scope:

- exactly two official families:
  - `official-cpu`
  - `official-gpu`

With releases:

- CPU:
  - amd64
  - arm64
- GPU:
  - amd64 only

### B. User publish workflow

Input:

- a project,
- optionally a specific snapshot,
- optionally current state.

Output:

- canonical RootFS release built from that project's effective rootfs,
- uploaded to R2,
- `rootfs_releases` row,
- `rootfs_catalog_entries` row with requested scope.

### Important publication rule

For correctness, "publish RootFS image" should operate on a stable captured
state, not a live mutable mount.

Recommended publish path:

1. Choose source:
   - existing snapshot, or
   - current project state.
2. If current project state is chosen:
   - create a safety snapshot first.
3. Build from snapshot material:
   - reconstruct the effective merged rootfs,
   - materialize it into a canonical btrfs subvolume,
   - compute `content_key`,
   - compute exact artifact hash and byte count while exporting,
   - upload to R2 using either:
     - staged file upload, or
     - direct streaming upload,
   - create DB rows.

This avoids races with a live changing upperdir.

## Canonicalization Rules

The same logical filesystem content should always produce the same
`content_key`, or as close to that as practical.

We therefore need a canonical build/export step that normalizes:

- ownership,
- permissions,
- timestamps where practical,
- xattrs that matter,
- directory ordering.

This can evolve, but it must be versioned.

Add:

- `format_version`

to the release metadata so we can change canonicalization later without lying
about identity.

## Visibility and Trust Model

The UI requirements imply four trust tiers.

### Official

- no warning,
- promoted/admin-reviewed,
- optionally prepulled,
- default choice for most users.

### Own

- no warning,
- user-owned,
- always visible to owner.

### Collaborator

- small warning,
- visible when the image owner is a collaborator of the current user.

### Public

- big warning,
- visible broadly,
- clear indication that the site has not necessarily reviewed it.

### What counts as a collaborator

At first, use a simple definition:

- owner of the image shares at least one project with the viewing user.

That is easy to explain and good enough for launch.

## Project Creation UX

The project creation picker should stop being:

- curated images versus custom image string.

It should become:

- official,
- my images,
- collaborator images,
- public images.

There can still be an advanced import path later, but not as the primary hosted
product workflow.

### Picker behavior

For each card/row, show:

- label,
- owner,
- official/private/public badge,
- architecture,
- GPU badge,
- approximate size,
- description,
- warning text if collaborator/public,
- whether it is already cached on the selected host, if known.

### Selection rule

When the user clicks create:

- resolve the chosen catalog entry to a concrete `image_id` and `content_key`,
- write those to the project,
- persist the display label separately if helpful for UX.

### Update to newer official release

Users should also be able to explicitly switch from one official release to a
newer official release.

That should be treated as an explicit image change, not an invisible background
mutation.

## Project Settings UX

Project settings should support:

- viewing the exact current image release,
- switching to a different image,
- switching back to a previously used image,
- updating to a newer official release explicitly,
- seeing the warning tier,
- seeing if a restart is required,
- publishing the current project rootfs as a reusable image,
- viewing provenance:
  - owner
  - source project
  - family/version
  - release id
  - content key

The old freeform custom image text area should not be the default hosted path.

## Course Management UX

Course settings need:

- a RootFS selector using the same catalog model,
- preferably a filter that emphasizes official and instructor-owned images,
- a warning if the selected image is collaborator/public instead of official.

When creating student projects:

- resolve and write the exact `image_id` and `content_key`.

When distributing assignments:

- keep assignment distribution separate from image selection,
- but ensure all student projects are created from the chosen image.

## Admin UX

Admins need a RootFS management screen with:

- all images,
- filters by scope, owner, arch, gpu, family, status,
- promote / demote official,
- set / unset prepull,
- deprecate / hide,
- view build logs and provenance,
- see usage counts:
  - total projects
  - active projects
  - host cache footprint

This should not be buried in generic site settings.

### Delete versus garbage collect

We need to distinguish:

- hide/delete from catalog,
- actual artifact garbage collection.

The control-plane states should be explicit:

- `hidden`: remove from normal user-facing pickers immediately,
- `blocked`: do not allow new selection or child publishes,
- `deleted`: soft-delete the catalog entry immediately,
- `pending_delete`: release is waiting for safe GC,
- `blocked` on the release: deletion was requested, but blockers still exist,
- `deleted` on the release: all central replicas were reclaimed.

If an image is reported, illegal, or otherwise needs to disappear, admins
should be able to remove it from all user-facing views immediately. However,
the actual R2 artifact and Postgres release row should only be hard-deleted
after no projects are still using that release.

### First implementation slice

The first delete/GC slice should not try to reclaim storage yet. It should:

1. add explicit catalog-entry lifecycle state:
   - `hidden`
   - `blocked`
   - `deleted`
2. add explicit release lifecycle state:
   - `gc_status`
   - `delete_requested_at/by`
   - `delete_reason`
3. add release scan metadata:
   - `scan_status`
   - `scan_tool`
   - `scanned_at`
   - `scan_summary`
4. implement safe delete-request RPCs that:
   - immediately hide + soft-delete the catalog entry,
   - compute deletion blockers,
   - mark the underlying release `pending_delete` or `blocked`,
   - do **not** yet delete replicas or host caches.

The next slice after this should add a GC sweep that:

- rescans releases in `pending_delete`,
- rechecks blockers,
- deletes central hub-local/R2 replicas when still safe,
- marks the release `deleted`,
- leaves host-cache eviction lazy.

## Host UI

The project-host UI should have an Images tab.

For each cached image:

- label,
- content key,
- arch,
- gpu,
- disk usage,
- number of projects using it,
- number of running projects using it,
- last used,
- official/prepull badges,
- status.

Operations:

- pull now,
- delete local cache,
- inspect details.

Deletion must be blocked if:

- a running project is using the image,
- a mounted overlay is currently using the lowerdir.

## Project Host Runtime Changes

The current host/runtime path takes a freeform image string and normalizes it.
That needs to change.

### New runtime contract

Project-host start should receive:

- `image_id`
- `content_key`
- optional label and metadata

The host then:

1. ensures `/btrfs/rootfs/<content_key>` exists locally,
2. fetches from R2 if missing,
3. mounts overlayfs using that lowerdir,
4. records refcounts and usage.

### Project image change flow

Changing a project's image should be a normal supported operation:

1. stop the project,
2. fully unmount the rootfs,
3. select the new lowerdir by `content_key`,
4. switch to the corresponding upperdir namespace for that image,
5. restart the project.

The UI should explain that:

- changing image changes what is visible under `/`,
- `/root` and `/scratch` are not thrown away by this operation,
- switching back later makes the previous per-image `/` customizations visible
  again.

### Retained project RootFS states

We cannot model project RootFS usage only as `projects.rootfs_image`.

Why:

- the runtime stores per-image upperdirs under image-specific paths,
- a project can switch from image `A` to image `B` and later switch back,
- if we GC `A` only because `projects.rootfs_image = B`, we break rollback.

The product policy should therefore be:

- each project retains one `current` RootFS state,
- each project may also retain one `previous` rollback RootFS state,
- switching `A -> B` promotes `B` to `current` and demotes `A` to `previous`,
- replacing the current image again evicts the older previous rollback state.

Important implementation note:

- this bounded retention policy must eventually apply both to metadata and to
  the actual per-image upperdirs on disk
- otherwise a project may accumulate stale historical upperdirs under
  `/root/.local/share/...` even though only `current` and `previous` are
  guaranteed by product semantics
- we have implemented the bounded retained-state model centrally, but we have
  not yet implemented automatic deletion of older on-disk upperdirs after they
  fall out of the retained `current | previous` set
- this should be added as explicit host-side cleanup work, with the important
  safety rule that the old data will still remain recoverable for a while via
  snapshots even after the live upperdir namespace is removed

This should be modeled centrally in a dedicated table, not hidden in the
filesystem:

- `project_rootfs_states(project_id, state_role, runtime_image, release_id, image_id, set_by_account_id, created, updated)`

Notes:

- `state_role` is currently bounded to `current | previous`
- `set_by_account_id` records who explicitly selected that retained RootFS
  state for the project
- this answers questions such as whether an instructor, student, or another
  collaborator changed the project's RootFS
- when a current state is demoted to previous during a switch, its existing
  `set_by_account_id` should be preserved
- the new current state gets the account id of the actor who performed the
  switch

GC implications:

- managed release GC must count references from `project_rootfs_states`, not
  only `projects.rootfs_image`
- a release cannot be hard-deleted while any project retains it as either
  `current` or `previous`
- for compatibility during rollout, GC queries should union both the retained
  state table and the legacy `projects.rootfs_image` column until all projects
  have explicit rows

### OCI fallback

For self-host recovery and bootstrap:

- if R2 artifact is missing or unavailable,
- and the image has OCI metadata,
- optionally fall back to OCI import/build path.

But for the hosted product, the steady-state path should be R2 plus btrfs.

## Bootstrap for New Launchpad Sites

A new launchpad should bootstrap from a small minimal image, then build out its
usable RootFS collection.

### Initial bootstrap behavior

1. Start with a minimal base, e.g. `buildpack-deps:noble-scm`.
2. Bring up the control plane.
3. Build or import the official RootFS families for that site:
   - CPU amd64
   - CPU arm64
   - GPU amd64 if the site supports GPUs
4. Upload artifacts to that site's R2.
5. Register them in Postgres.
6. Mark the desired prepull set.

This is better than pretending a site begins life with a broad external OCI
catalog that it does not control.

## Official Image Strategy

I no longer think we should begin with one very large official CPU image that
tries to satisfy every use case.

The better launch strategy is:

- start with a minimal official CPU base that is essentially build essentials
  plus what CoCalc fundamentally requires to function,
- build richer official images on top of that system using the same publish and
  test workflow,
- keep the official GPU family separate and explicit.

That gives us:

- a small bootstrap/default image,
- a clear path to publish/test richer official images such as Sage or
  course-specific environments inside actual projects,
- less pressure to get one giant image perfect before RootFS itself is usable.

## Official Image Families

For launch, the system should explicitly support exactly two official families.

### Official CPU

Ubuntu-based, starting from a minimal build-essentials-oriented base with what
CoCalc fundamentally needs to function.

Additional richer official CPU images can then be published through the same
system and tested in actual projects.

The point is not to force one giant image to be the only official answer.

Minimum initial shape:

- build essentials,
- a small set of core CoCalc runtime requirements.

Architectures:

- amd64
- arm64

### Official GPU

Same base plus GPU stack, likely including:

- CUDA runtime pieces,
- PyTorch,
- TensorFlow,
- related GPU tooling.

Architecture:

- amd64

## Greenfield Cutover Strategy

This launchpad system is greenfield enough that we should not spend serious
effort preserving legacy test data or compatibility rows.

Instead:

- define the new structured RootFS schema cleanly,
- update the code to use `image_id` plus `content_key`,
- discard or recreate old testing projects as needed,
- avoid carrying forward `rootfs_image TEXT` as the primary model.

## API and RPC Work

We need new control-plane APIs in at least these groups.

### RootFS catalog

- list images visible to current user
- list official images
- list my images
- list collaborator images
- list public images
- get image details
- publish image
- update publish scope
- delete/hide image
- promote/demote official
- set/unset prepull
- deprecate/hide

### Host cache

- list host cached images
- pull image to host
- delete image from host cache
- report image usage counts

### Project actions

- set project image by `image_id`
- publish project rootfs as image
- resolve current project image details

### Course actions

- set course image
- provision student projects with selected image

## Security and Abuse Controls

Public RootFS images are powerful. Even if they mainly affect the user choosing
them, the site should still have guardrails.

### Required controls

- owner attribution on every image,
- published timestamp,
- review status,
- ability for admins to hide/block images,
- warning banners on collaborator/public images,
- scan/build metadata for official images,
- optional site setting to disable public images entirely,
- per-account or per-membership limits on:
  - total published image bytes,
  - total image count,
  - optionally which publish scopes are allowed.

### Hosted recommendation

For the hosted launch, I would support:

- official,
- own,
- collaborator,
- public

but keep an admin kill switch for public images if moderation becomes painful.

### Deletion policy

The system should support an image lifecycle like:

- `active`
- `hidden`
- `blocked`
- `pending_gc`
- `deleted`

`hidden` or `blocked` removes it from view immediately. `pending_gc` means no
new selections are allowed and background cleanup can remove artifacts once no
projects still reference the release.

## Benchmarks We Need

The detailed benchmark matrix and execution plan now live in
[rootfs-benchmarks.md](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks.md).
That file should be treated as the source of truth for benchmark scenarios,
metrics, and result capture as the RootFS pipeline evolves.

Because distribution format choice matters, we should benchmark:

1. Baseline host disk performance before any RootFS test:
   - sequential read throughput,
   - sequential write throughput,
   - random read/write IOPS or latency,
   - filesystem-level throughput on the actual btrfs data volume.
2. Publish time for representative images:
   - merged-tree materialization,
   - snapshot freeze,
   - `btrfs send`,
   - content hashing,
   - total end-to-end publish LRO time.
3. Artifact upload time:
   - current hub-local fallback path,
   - R2 upload path once implemented.
4. Artifact download plus import time:
   - R2 download plus `btrfs receive`,
   - R2 download plus `tar.zst` extract time.
5. OCI pull plus unpack time for the official CPU image.
6. OCI pull plus unpack time for the official GPU image.
7. Host bootstrap time with:
   - no prepull
   - CPU prepull
   - CPU plus GPU prepull
8. Cross-host first-use and repeat-use timings:
   - publish on host A,
   - create on host B with empty cache,
   - create again on host B with warm cache.
9. Disk amplification:
   - raw expanded rootfs size
   - btrfs send stream size
   - tar.zst size
10. CPU overhead during import.

This should be measured on:

- Nebius,
- GCP,
- at least one CPU host class,
- at least one GPU host class.

And for the next serious round, the hosts should have production-like disks.
Tiny dev disks are useful for correctness testing, but they are not a good
proxy for a launch configuration where disk throughput may dominate parts of
the RootFS pipeline. We should explicitly record the disk class and size for
every benchmark result.

## Operational Metrics

We should collect RootFS-specific metrics from day one.

### Control-plane metrics

- image publish success/failure
- image build duration
- image promotion events
- picker usage by scope
- image selection frequency

### Host metrics

- cached images per host
- total disk bytes used by images
- per-image disk bytes
- cache hit rate
- pull duration
- receive duration
- delete duration
- running project count per image

### Product metrics

- official versus own versus collaborator versus public selection rates
- how often students/instructors use course-specified images
- how many published user images exist
- how many are shared publicly

## Rollout Plan

This is large enough that it needs phases, but all phases below are still part
of the launch-critical RootFS effort.

### Phase 0: Lock the model

- finalize terminology,
- finalize immutable identity,
- finalize official family model,
- decide whether `rootfs_aliases` ships in v1 or later.

Status:

- mostly complete

### Phase 1: Central schema and APIs

- add `rootfs_releases`,
- add `rootfs_catalog_entries`,
- add project/account/course references,
- add theme support,
- add APIs to list/select/promote/publish.

Status:

- largely implemented for projects and catalog
- course references still missing

### Phase 2: Official build pipeline

- turn the existing `src/rootfs-images/` effort into an official-image pipeline,
- stop centering it on GCP Spot as the product architecture,
- make its output the canonical R2 btrfs artifact plus DB registration.

Status:

- not done
- this should now be re-scoped around R2-backed releases, not the older
  parallel GCP image builder as product architecture

### Phase 3: Incremental release storage

- add parent-child release tracking,
- emit full or incremental btrfs send streams as appropriate,
- receive incremental artifacts on hosts,
- add chain-depth controls and periodic checkpointing,
- enforce dependency-aware artifact GC.

Status:

- designed
- not implemented

### Phase 4: Host download/cache/runtime

- fetch by `content_key`,
- cache in content-addressed directories,
- expose host inventory RPC,
- add host UI.

Status:

- mostly implemented through the current hub-local artifact backend
- R2 fetch is the next major missing piece

### Phase 5: Project picker and settings UX

- replace freeform custom-first UI with managed catalog sections,
- wire project creation to `image_id` plus `content_key`,
- add publish-image flow from project settings,
- add explicit image change / switch back / update workflow.

Status:

- implemented for project creation and project settings
- still needs more lifecycle polish around sharing/admin workflows

### Phase 6: Admin workflows

- promote/demote official,
- prepull flags,
- deprecate/hide,
- inspect provenance and usage.

Status:

- partial
- basic catalog/admin controls exist, but this needs dedicated admin polish

### Phase 7: Course integration

- course image selection,
- student-project provisioning with exact release binding.

Status:

- not implemented

### Phase 8: Benchmarking and hardening

- measure OCI versus btrfs receive,
- measure full versus incremental btrfs send/receive,
- confirm host bootstrap timings,
- confirm prepull policy,
- run soak/load tests around image churn and cache pressure.

Status:

- correctness-oriented baseline measurements exist
- next real benchmark round should happen after R2 is in place and on better
  disks

## Suggested Launch Acceptance Criteria

I would not call this launch-ready until all of the following are true.

### Product correctness

- projects can be created from official, own, collaborator, and public images,
- projects store exact immutable image bindings,
- existing projects are not silently changed when official images are promoted,
- users can publish images from projects,
- instructors can assign images for course student projects.

### Operational correctness

- hosts can pull and delete cached images safely,
- running projects prevent unsafe cache deletion,
- prepull on new hosts works,
- cache usage is visible in the UI.

### Distribution

- official images are stored in R2 as btrfs streams,
- hosts can receive them directly,
- fallback paths are tested.

### Safety

- images have provenance,
- public/collaborator warnings are clear,
- admins can hide/block/deprecate images,
- public image handling has a kill switch if needed.

### Performance

- measured btrfs receive path is fast enough for launch,
- host bootstrap timing is known,
- prepull policy is chosen from data, not guesses.

## Open Questions

These do not block writing code, but they should be resolved early.

### 1. One table or two central tables?

I strongly prefer:

- immutable release table,
- mutable catalog table.

It is cleaner and matches the product model.

wstein: agree

### 2. Do we ship `rootfs_aliases` in v1?

Probably not required, but likely useful quickly.

wstein: no need; greenfield

### 3. How strict is canonicalization at launch?

We need a versioned answer, but not necessarily perfect mathematical
deduplication on day one.

wstein: no opinion

### 4. Do we allow arbitrary OCI import in hosted UI?

My recommendation is:

- not as the main launch path,
- maybe admin-only or hidden behind advanced/self-host mode.

wstein: admin/self host makes very good sense.

### 5. What is the exact collaborator visibility query?

Start simple with shared-project collaborators.

wstein: exactly what you guessed; the UI could list links to the actual collab projects for verification.

## Recommended Immediate Next Step

Before implementing everything, define the precise v1 schema and contracts for:

- `rootfs_releases`,
- `rootfs_catalog_entries`,
- `projects.rootfs_image_id` plus `rootfs_content_key`,
- parent-child release storage contracts for incremental btrfs artifacts,
- host cache inventory RPC,
- project creation picker sections.

That is the foundation. Once that is locked, the rest of the system can be
built coherently instead of as a pile of ad hoc image-string features.
