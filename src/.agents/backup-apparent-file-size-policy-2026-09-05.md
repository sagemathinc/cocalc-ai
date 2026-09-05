# Bounded Project Backups and Oversized Files

Date: 2026-09-05.

Status: proposal for later discussion. No implementation or production policy
change is authorized by this document. Numeric limits and rollout policy remain
undecided.

## Incident and Motivation

Two orphaned Rustic 0.11.1 backup processes on us-south-1 spent roughly 15 hours
reading separate snapshot copies of a file named `70T`. Its apparent size was
70 TiB (76,965,813,944,320 bytes), with zero allocated blocks. Each process had
read tens of terabytes of logical data. Both survived their original parent,
consumed backup resources, and prevented cache maintenance from proceeding.
The operator-authorized termination of both processes completed with SIGTERM.

The operator reports that the free account used CoCalc only briefly and has now
deleted the offending file. Intent is not established by the file alone. No
account deletion or further incident cleanup is requested by this plan. Existing
snapshot copies and scheduler state would need separate inspection before
assuming retries cannot encounter the same file.

Any user could reproduce this resource amplification. Physical disk quotas do
not bound the logical work required to read sparse or highly compressed files.
Deleting this one file does not solve the underlying problem.

## Proposed Product Contract

Introduce a project quota named **Maximum backed-up file size**, measured in
apparent bytes, independently of physical disk usage.

- Membership tiers provide defaults through the existing entitlement/quota
  resolver; authorized administrators can override the effective project limit.
- This is a backup eligibility limit, not a filesystem creation limit. It must
  not change writes, runtime limits, disk charging, or the ability to use a file.
- Files larger than the effective limit are omitted from backups and explicitly
  reported. Files exactly at the limit remain eligible.
- Treat all regular files alike; do not require a sparsity heuristic. A large
  database and a sparse file have the same apparent-size eligibility test.
- Never label a snapshot with policy exclusions as a complete backup.
- Changing limits does not rewrite historical backup completeness. Raising a
  limit does not establish protection until a subsequent backup includes files.
- Do not add an OS-wide file-size limit: it would also affect scratch space and
  still would not cover host-side writers or aggregate backup work.

No tier values are selected yet. Define units, override precedence, validation,
legacy defaults, and any self-hosted opt-out explicitly before implementation.
Membership changes must not silently turn previously protected files into
immediately disposable data.

## Backup Guard and Evidence

Scan metadata in the same immutable snapshot that Rustic will read. Do not
read file contents to detect oversize, follow symlinks outside that snapshot,
cross unintended mount boundaries, or modify users' files.

The scan should produce a durable manifest tied to the snapshot and policy
version: relative path, apparent size, exclusion reason, effective limit,
timestamp, and counts. Keep UI summaries bounded and paginate full manifests.
Handle arbitrary filenames safely, including newlines, glob metacharacters,
invalid text encodings, and hard links; no shell interpolation or executable
HTML in reporting.

Investigate Rustic's `--exclude-larger-than` as a matching enforcement guard.
Verify exact boundary semantics, units, directory traversal, and installed
version behavior. Do not assume a preflight manifest and CLI exclusions agree
without tests. Check local `/home/user/upstream/rustic`, its core dependency,
and current upstream before choosing the implementation. Sparse restore
behavior remains to be verified, not assumed.

Distinguish these outcomes explicitly:

- Complete: all supported source data was successfully backed up.
- Complete with policy exclusions: supported data succeeded, with a durable
  manifest; the project backup is visibly incomplete from the user's viewpoint.
- Failed/unknown: timeout, unreadable files, interrupted scan, upload failure,
  or unavailable evidence. This is not permission to discard source data.

Prefer unambiguous internal names such as `partial_policy_exclusions` over
overloading existing success fields. Audit every consumer of backup success,
especially archive, restore, migration, and `last_backup` indicators.

## Project Warning and Restore UX

Display a prominent non-dismissible banner across the project, not just in its
backup settings. Show a bounded list of paths and sizes, the effective limit,
and a link to the full exclusion report. All collaborators should see it while
authorized to access the project.

Suggested wording, subject to the final retention policy:

> These files exceed this project's maximum backed-up file size and are not
> backed up. They will be permanently lost if this project is automatically
> archived under its retention policy. Delete unneeded files or move them to
> storage suitable for large files.

Recommend `/scratch` with an explicit temporary/no-backup warning, or a dedicated
VM with its backup responsibilities clearly stated. Verify the actual scratch
restart lifecycle and dedicated-VM backup policy before publishing exact claims.

A refresh/rescan can detect deletion or changed eligibility. Distinguish
"no longer oversized, awaiting backup" from "successfully backed up". Historical
partial snapshots retain their warnings even after current exclusions resolve.
Restoring a partial archive must show that excluded files cannot be recovered;
persist the manifest somewhere that survives deletion of the source host data.

## Retention and Migration Decisions

An unsupported file must not provide a permanent veto on automatic archival.
However, policy exclusions and operational backup failures are different.

Proposed distinction for discussion:

- Scheduled archival of eligible inactive free projects may discard explicitly
  excluded files after an announced policy/grace period, provided supported
  files and the exclusion manifest were successfully preserved and verified.
- User-requested archive or migration that would lose excluded files requires
  acknowledgement of the exact exclusions before source deletion. Bind the
  acknowledgement to the snapshot/manifest and policy; invalidate it if the
  relevant source or exclusions change.
- A migration path that actually preserves all files need not lose them merely
  because the backup-size limit exists. Audit transfer mechanisms individually.
- Timeouts, unknown entitlement, incomplete scans, and backup/storage failures
  do not qualify for the policy-exclusion exception.

Preserve the paid-collaborator and publication protections in
`project-archive-lifecycle-plan-2026-08-22.md`. This proposal does not newly
authorize automatic archival of paid projects. Recheck authoritative eligibility
before destructive finalization, including a paid upgrade during a grace period.

Decide advance notices, existing-project grace periods, downgrade behavior, and
the handling of missing email delivery before enabling source deletion with
exclusions. A banner alone is not notice to someone who never returns.

## Resource and Abuse Controls

A per-file limit is necessary but insufficient. Many eligible files can still
create enormous logical workloads. Bound metadata traversal, aggregate logical
input, backup runtime, retries, and per-project/per-host concurrency. Define
hard-link accounting and avoid unbounded in-memory filename lists.

Exhausting a work budget should initially fail safely with an operator-visible
reason, not silently create additional disposable exclusions. Any policy for
discarding aggregate-budget overflow requires a separate explicit decision.

Ensure worker cancellation, death, and host-service replacement terminate the
associated backup process tree, with bounded graceful termination and safe
escalation. Recover durable job state after restart without overlapping retries.
Coordinate cache retention with active repository users through appropriate
locking; an unrelated long backup should not block all cache maintenance.

## Architecture and Implementation Map

Follow `scalable-architecture.md`: the project's owning bay authorizes and stores
project policy/state; entitlement resolution uses authoritative account home
bays. The host's bay routes work to the owning project host. Do not infer paid
status from local account rows or bypass inter-bay routing.

Hosts perform snapshot scans and backup data-plane work. Send bounded durable
status to the control plane; serve authorized detailed evidence through scoped
project-host/storage interfaces rather than proxying bulk file data through hubs.
Keep manifests private to authorized project collaborators/admins, and avoid
leaking filenames in global logs or notification previews.

Starting points to inspect, not a final change inventory:

- `src/packages/file-server/btrfs/subvolume-rustic.ts`: snapshot staging lifecycle.
- `src/packages/backend/sandbox/rustic.ts`: Rustic invocation and option validation.
- `src/packages/project-host/rustic-cache-maintenance.ts`: active-job coordination.
- Existing membership/quota resolution, backup state, archive/move/restore
  finalization, and project-wide frontend layout.

Read `accessibility.md` before UI implementation. Define mixed-version behavior:
old hosts lacking guard/manifest support must not receive newly enabled
destructive exclusion workflows. Missing evidence must never imply completeness.

## Phased Delivery and Verification

1. Verify upstream behavior and trace all backup-dependent deletion paths.
2. Implement tested limits, manifests, and process/resource containment behind
   explicit rollout controls; no automatic source deletion with exclusions yet.
3. Add quota/admin configuration, persistent banner, backup/restore indicators,
   and dry-run fleet inventory. Select tier limits from measured impact.
4. Stage end-to-end tests and a small canary; review false positives, overhead,
   incomplete-state propagation, and mixed-version compatibility.
5. Only after product-policy approval and notice/grace requirements are met,
   enable the scheduled-archive exception for eligible free projects.

Tests must cover tiny-allocated/huge-apparent files without reading their holes,
boundary sizes, ordinary large files, many sub-limit files, hostile filenames,
symlinks, hard links, scan errors, worker death, duplicate retries, quota changes,
cross-bay authorization, stale acknowledgements, failed manifest persistence,
partial restore, and source preservation after any operational failure.

Rollback may disable new partial archival, but must retain existing manifests
and warnings. It must not restart unbounded backup attempts on known oversized
inputs. No large sparse-content benchmark should run against production.

## Open Questions for the Next Review

- What per-tier apparent-size limits and admin override rules should apply?
- What aggregate budgets protect hosts without excluding normal workloads?
- Which default and opt-out semantics fit self-hosted deployments?
- What notice/grace period applies to existing files and membership downgrades?
- How frequently should current exclusions be rescanned and warnings refreshed?
- Where should manifests live so archive restore remains independent of hosts?
- What exact acknowledgement and retention policy should govern data loss?

This document intentionally leaves these decisions open for the operator to
mull over. Do not implement or deploy the policy merely because the plan exists.
