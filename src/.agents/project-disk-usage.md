# Project Disk Usage Plan

Last refreshed: March 31, 2026

Status: planning document; current implementation is a placeholder proof of concept

This document is the working plan for replacing the current launchpad project
disk-usage widget with a more accurate, useful, and performant storage UX.

The current implementation is good enough to prove that `dust` can provide a
nice interactive summary, but it mixes together several different meanings of
"disk usage" that users care about for different reasons:

- how much of the project quota is actually counted,
- how much visible data they have under `/root`,
- how much scratch data they have under `/scratch`,
- how much writable overlay data exists because they installed software into
  the root filesystem,
- and where the large directories actually are.

Those are not the same thing, and collapsing them into one number leads to
confusing output such as:

- `Disk Usage: 7.6 GB out of 20 GB`
- while the same dialog also says `You are using 222.2 MB out of 20 GB`

That mismatch is real: the current widget is comparing `dust("/")` against the
project's hard quota usage, which is semantically wrong for launchpad projects
that have a root filesystem image mounted into `/`.

## Executive Summary

We should replace the current disk-usage widget with a first-class project
storage UI built around three distinct concepts:

1. Quota Usage

- authoritative and quota-relevant
- backed by Btrfs/qgroup or equivalent project-host accounting
- answers: "How close am I to running out of allowed space?"

2. Visible Storage

- apparent bytes visible to the user in the main writable locations
- primarily `/root` and `/scratch`
- optionally a distinct bucket for rootfs environment changes
- answers: "Where is my writable storage actually going?"

3. Space Breakdown

- interactive drilldown for finding large directories and hidden storage
- answers: "What should I clean up?"

The key product decision is:

- the top-level number should be quota-based,
- the explanatory breakdown should be location-based,
- and the cleanup UI should be path-based.

These should be presented together, but never conflated.

## Current State

### Frontend

The current frontend implementation lives in:

- [disk-usage.tsx](/home/wstein/build/cocalc-lite2/src/packages/frontend/project/disk-usage/disk-usage.tsx)
- [use-disk-usage.ts](/home/wstein/build/cocalc-lite2/src/packages/frontend/project/disk-usage/use-disk-usage.ts)
- [dust.ts](/home/wstein/build/cocalc-lite2/src/packages/frontend/project/disk-usage/dust.ts)
- [quota.ts](/home/wstein/build/cocalc-lite2/src/packages/frontend/project/disk-usage/quota.ts)

It currently does the following:

- runs `dust` from the browser-facing filesystem API,
- defaults the target path to `/`,
- requests a depth-1 tree,
- and separately fetches project quota usage.

This means the modal compares:

- apparent bytes of the merged runtime filesystem
- against
- hard quota accounting bytes of the project subvolume

Those numbers diverge significantly for launchpad projects using a rootfs image.

### Mount Points

The current component is mounted in:

- the full-page explorer:
  - [explorer.tsx](/home/wstein/build/cocalc-lite2/src/packages/frontend/project/explorer/explorer.tsx)
- the files flyout header:
  - [header.tsx](/home/wstein/build/cocalc-lite2/src/packages/frontend/project/page/flyouts/header.tsx)

So the files flyout is not completely missing disk usage today, but it only has
the tiny button version in the header. It does not expose the same primary
storage surface as the full explorer experience should.

### Backend / Accounting

Quota usage currently comes from:

- [projects.ts](/home/wstein/build/cocalc-lite2/src/packages/server/conat/api/projects.ts)
- [file-server.ts](/home/wstein/build/cocalc-lite2/src/packages/project-host/file-server.ts)
- [subvolume-quota.ts](/home/wstein/build/cocalc-lite2/src/packages/file-server/btrfs/subvolume-quota.ts)

This is the right basis for quota accounting. It should remain the
authoritative source for "counted toward quota."

### Dust Execution

The browser filesystem API ultimately runs `dust` through the sandbox backend:

- [index.ts](/home/wstein/build/cocalc-lite2/src/packages/backend/sandbox/index.ts)
- [dust.ts](/home/wstein/build/cocalc-lite2/src/packages/backend/sandbox/dust.ts)

This is useful for drilldown and space-finding, but it should not be the
primary source for quota state or overall project storage truth.

## Core Problems

### 1. One number is trying to mean too many things

Users need to know:

- quota usage,
- visible file usage,
- writable overlay usage,
- scratch usage,
- and large-directory breakdown.

The current widget tries to compress these into a single progress bar and one
modal header, which is why it feels wrong.

### 2. `/` is the wrong default scope

For launchpad projects with a rootfs image:

- `/` includes the base rootfs image,
- the base image is not "user storage" in the normal sense,
- user-installed software may appear under rootfs paths but actually be charged
  through writable overlay storage,
- `/root` and `/scratch` are the main user-facing storage locations.

So `dust("/")` is not the right default view for "your disk usage."

### 3. The current surface is not interactive enough

The current modal shows a flat one-level list of top children. It does not:

- adapt to the directory the user is currently browsing,
- distinguish `/root` from `/scratch`,
- explain rootfs overlay semantics,
- or help users safely navigate special storage locations.

### 4. The current architecture is too browser-driven

Running `dust` directly from the frontend is acceptable for a prototype, but it
is not a good long-term architecture for a project-wide storage UI.

We need:

- cheap, cached overview data,
- explicit refresh semantics,
- drilldown only on demand,
- and eventually a trend/history view.

### 5. Hidden and special directories need product-aware handling

A useful space-finder must help users locate:

- hidden directories,
- caches,
- package-manager data,
- notebook outputs,
- environment deltas,
- snapshots if they count,

without encouraging unsafe cleanup advice such as "delete `.local`."

## Product Goals

### Primary Goals

- Make it obvious how much project storage counts against quota.
- Make it obvious where the user's writable storage actually lives.
- Make it easy to discover the largest space consumers quickly.
- Make the same storage surface available in both full explorer and files
  flyout.
- Make the UI fast enough that it feels normal, not diagnostic.

### Secondary Goals

- Show enough nuance that quota behavior remains trustworthy even though Btrfs
  compression, deduplication, and snapshots complicate the exact meaning.
- Make special storage categories understandable:
  - `/root`
  - `/scratch`
  - environment changes
  - snapshots
- Provide a path toward trend/history visibility.

### Non-Goals For V1

- perfect byte-for-byte forensic accounting
- real-time per-directory live updates on every filesystem change
- a full storage-admin console inside every project
- replacing existing project quota settings UI

## Design Principles

1. Quota accounting is authoritative.
2. Visible storage and quota storage should be shown together, but labeled
   differently.
3. The summary should be project-wide; drilldown should be path-aware.
4. Special directories and environment deltas must be explained, not merely
   listed.
5. Fast cached overview; deeper analysis only on demand.
6. The flyout and full explorer should share the same storage model and visual
   language.

## Proposed UI Model

### Shared Surface

Replace the current small disk-usage button with a shared
`ProjectStorageSummary` surface used in:

- full-page file explorer
- files flyout

In the full explorer, this should appear as a compact summary strip above the
listing.

In the files flyout, this should appear directly below the flyout header/path
bar, not just as a small header icon button.

### Summary Strip

The strip should show at a glance:

- `Quota: 222 MB / 20 GB`
- `Home: 180 MB`
- `Scratch: 40 MB`
- optionally `Env changes: 35 MB`
- freshness, e.g. `updated 12s ago`

This keeps the primary meaning explicit:

- quota is the main limit,
- `/root` and `/scratch` are explanatory storage buckets.

### Expanded View

Clicking the strip should open a drawer or modal with three tabs:

1. Overview
2. Find Space
3. History

These do different jobs and should not be collapsed into one page.

### Overview Tab

The Overview tab should show:

- quota usage as the main large indicator
- a labeled breakdown of project storage buckets
- a short explanation of why visible usage and counted usage may differ

Suggested buckets:

- `Home (/root)`
- `Scratch (/scratch)`
- `Environment changes`
- `Snapshots`
- `Other counted storage`

The explanation should be precise and short, for example:

- compression and deduplication can make counted bytes lower than visible bytes
- snapshots may make counted bytes higher than current visible files suggest
- environment changes come from writable overlay data associated with installed
  software or system modifications

### Important Labeling Rule

The big headline must say something like:

- `Counted toward quota`

not simply:

- `Disk Usage`

That label change alone removes most of the current confusion.

### Find Space Tab

This is the interactive cleanup tool.

It should support:

- root selector:
  - `/root`
  - `/scratch`
  - `Environment changes`
- on-demand drilldown by directory
- sorting by size
- showing hidden directories by default in expert mode or with a toggle

The root selector is important because users think in those storage domains.

### Current Directory Awareness

This tab should be path-aware.

If the user is browsing:

- `/root/foo/bar`

then the drilldown should offer:

- `Current folder: /root/foo/bar`
- plus a way to jump back to `Project summary`

This is where current-directory sensitivity belongs, not in the top-level quota
summary.

### Special Directory Annotations

Some paths should never be shown as plain directory names with no explanation.

Examples:

- `.local/share/cocalc/...`
  - label as `Environment / installed software changes`
  - explain that deleting this blindly can break the environment
- cache-like paths:
  - `.cache`
  - package-manager caches
  - notebook checkpoints or outputs
  - these can be tagged as "usually safe to review/clean"

The product should help users make better cleanup decisions, not merely dump
directory sizes.

### History Tab

This tab should show:

- counted quota usage over time
- optionally `/root` and `/scratch` apparent usage over time later

The first version should only require:

- project-level quota usage samples

That gives the most important answer:

- "Am I trending toward the limit?"

This should not depend on repeated `dust` runs. It should come from cheap,
sampled accounting data.

## Data Model

We should explicitly model three layers of project storage data.

### 1. Project Storage Overview

Authoritative project-level summary, cached and cheap.

Suggested shape:

```ts
type ProjectStorageOverview = {
  collected_at: string;
  quota: {
    size_bytes: number;
    used_bytes: number;
    percent: number;
  };
  visible: {
    home_bytes?: number;
    scratch_bytes?: number;
    environment_delta_bytes?: number;
  };
  counted: {
    snapshot_bytes?: number;
    other_bytes?: number;
  };
  freshness: {
    overview_stale: boolean;
    reason?: string;
  };
};
```

This is the data used for the summary strip and Overview tab.

### 2. Project Storage Breakdown

Interactive tree data for one storage root.

Suggested shape:

```ts
type ProjectStorageBreakdownNode = {
  path: string;
  label: string;
  bytes: number;
  percent_of_parent?: number;
  kind?: "directory" | "file" | "special";
  annotation?: string;
  expandable?: boolean;
};
```

This should be fetched lazily for:

- `/root`
- `/scratch`
- environment-delta root
- current folder

### 3. Project Storage History

Sampled time-series data for trend visibility.

Suggested shape:

```ts
type ProjectStorageHistoryPoint = {
  at: string;
  quota_used_bytes: number;
  quota_size_bytes: number;
  home_visible_bytes?: number;
  scratch_visible_bytes?: number;
};
```

V1 can start with only:

- `quota_used_bytes`
- `quota_size_bytes`

## Storage Semantics

### Quota Usage

Use existing project-host/file-server quota accounting as the primary truth for:

- size limit
- counted bytes used

This is already the right source for:

- quota exhaustion
- enforcement
- warning thresholds

### Home Usage

Measure apparent bytes for:

- `/root`

This is what users usually mean by "my files."

### Scratch Usage

Measure apparent bytes for:

- `/scratch`

This should be separate because:

- it is user-controlled storage,
- it may be large,
- it is operationally different from `/root`,
- and users often forget it exists.

### Environment Changes

For projects using a rootfs image, we should surface writable overlay usage as a
separate category.

This is the right place to represent:

- package installs into the environment
- modifications under rootfs paths that consume writable storage

It should not be described simply as `/`.

Instead label it as:

- `Environment changes`

This is both more accurate and safer for users.

### Snapshots

If snapshots count materially toward quota, they should be shown as a first
class counted bucket.

Otherwise users will see unexplained quota growth and reasonably distrust the
entire widget.

## Backend Strategy

The long-term data flow should be:

1. project-host / file-server computes or exposes authoritative storage facts
2. hub exposes those facts through project APIs
3. frontend renders cached overview + on-demand drilldown

### Overview API

Add a dedicated API for project storage overview, separate from the current
quota-only endpoint.

Suggested operation:

- `projects.getStorageOverview(project_id)`

This should return:

- authoritative quota numbers
- cached visible bucket sizes
- freshness metadata

### Breakdown API

Add a dedicated breakdown API for one storage root or subtree.

Suggested operation:

- `projects.getStorageBreakdown(project_id, root, path?, depth?)`

This is where `dust` remains useful, but only on demand and only for the
requested subtree.

### History API

Add a dedicated history API:

- `projects.getStorageHistory(project_id, range?)`

This should not shell out to `dust`. It should come from sampled overview data.

## Performance Strategy

The current prototype shells out to `dust` from the frontend path. That is fine
for proving the idea, but not for the long-term product.

### Overview Must Be Cheap

The summary strip should feel immediate.

So overview data should be:

- cached server-side or host-side
- refreshed on a modest interval, e.g. `15s` to `60s`
- refreshed after meaningful file operations when possible

### Drilldown Must Be Lazy

The expensive operation is directory summarization, especially with many files.

So drilldown should be:

- on demand
- depth-limited
- cached per `(project, root, path, depth)`
- refreshable explicitly

### Backoff / Freshness

Every view should surface freshness:

- `updated 12s ago`
- `refreshing`
- `stale`

If a large `dust` run takes too long, the UI should:

- keep showing the previous cached result,
- mark it stale if needed,
- and avoid repeatedly rerunning expensive work.

### Suggested Cache Layers

1. project-host or file-server cache for overview snapshots
2. hub/API cache for short-lived reuse
3. frontend cache keyed by project/root/path

The expensive part should not be repeated by every browser tab.

## UX Rules

### Rule 1: Never Compare `dust("/")` To Quota

That is the main bug in the current placeholder.

### Rule 2: The Headline Is About Quota

The first number the user sees should answer:

- "How close am I to the limit?"

### Rule 3: The Breakdown Is About Places

The next thing the user should see is:

- `/root`
- `/scratch`
- environment changes
- snapshots

### Rule 4: The Cleanup Tool Is Path-Based

That is where `dust` belongs.

### Rule 5: Special Storage Must Be Explained

Do not present `.local/share/cocalc` or overlay-related paths as ordinary
folders with no explanation.

## Proposed Rollout

### Phase 1: Fix Semantics And Surface

- replace the current headline with quota-based labeling
- stop defaulting the visible-usage summary to `/`
- expose a proper shared summary strip in both explorer and files flyout
- keep the current modal/drawer simple

Deliverable:

- users no longer see rootfs size confused with project quota usage

### Phase 2: Add Explicit Buckets

- show separate `/root` and `/scratch` usage
- add environment changes when rootfs is in use
- add snapshot bucket if applicable

Deliverable:

- users can understand where their storage class is coming from

### Phase 3: Replace Flat List With Interactive Breakdown

- add lazy drilldown
- add current-folder mode
- annotate special directories

Deliverable:

- users can actually find and clean space safely

### Phase 4: Add History

- sample quota usage over time
- show a simple trend graph and recent slope

Deliverable:

- users can tell whether usage is stable, growing, or spiking

### Phase 5: Smarter Cleanup Guidance

- recommend safe cleanup areas
- explain risky areas
- potentially connect to snapshots / rootfs settings

Deliverable:

- space cleanup becomes understandable for non-expert users

## Open Questions

### 1. How should snapshots be presented?

We need to decide whether snapshots are:

- always shown as a counted bucket,
- shown only when materially nonzero,
- or surfaced with a secondary "why quota differs" explanation.

My bias is:

- show them when nontrivial.

User: agree

### 2. How do we compute environment-delta bytes robustly?

For rootfs-backed projects, we need a stable product definition of:

- which writable overlay paths count as `Environment changes`
- how to compute that size without exposing confusing implementation details

My bias is:

- keep the label product-level,
- hide low-level overlayfs path details from the user.

User: yes.

### 3. How fresh does the Overview need to be?

My bias is:

- overview freshness target: under 30 seconds
- breakdown freshness target: cached unless explicitly refreshed

### 4. Should `/tmp` appear at all?

My bias is:

- not in the primary summary
- optionally in the drilldown if it matters operationally

User: I can't remember how we implement /tmp in our projects.  Is it a ramdisk?  Is it just part of scratch or something else?  We should decide based on what it is.  I checked - it's a tmpfs (so a ram disk). 

## Immediate Next Slice

If we implement this plan incrementally, the first slice should be:

1. replace the current "Disk Usage" headline with quota-first semantics
2. unify the explorer and flyout surface into a shared summary strip
3. show separate `/root` and `/scratch` visible usage
4. stop using `/` as the default visible-usage root

That delivers the biggest product improvement with the least architectural risk.

