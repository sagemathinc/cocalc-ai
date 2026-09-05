# Bounded Project Backups and Oversized Files

Date: 2026-09-05.

Status: implementation plan revised after policy review. This document edit
does not authorize implementation, deployment, or source deletion. Numeric
limits and production rollout decisions still require separate approval.

## Scope and Policy

Protect managed-project hosts from unbounded backup work without building a
new membership-quota product. Deliver resource containment and safe lifecycle
admission first, then improve and qualify Rustic sparse restoration, then ship
a fixed file-size policy with honest exclusion reporting. Sparse-safe restore
is a required deliverable, not an optional follow-up to the size limit.

The user-facing rule is:

> Files larger than the managed-project apparent-size limit are excluded from
> backups and cannot be recovered from archives that exclude them. Use a
> dedicated VM for workloads requiring larger files.

- Use one centrally configured positive integer limit in bytes, independent of
  membership and physical disk usage. Files exactly at the limit remain eligible.
- Apply it consistently to managed projects on shared and private hosts. Keep
  self-hosted deployment configuration explicit; do not silently impose the
  hosted-site policy on CoCalc Star.
- Allow ordinary sparsity. NumPy arrays, geospatial data, and other legitimate
  files can be sparse without FUSE or filesystem mounts. Test apparent size,
  not a sparsity ratio or presumed user intent.
- Do not change file creation, writes, physical disk charging, scratch behavior,
  or runtime quotas. An OS-wide file-size limit is not the solution here.
- Keep three decisions separate: whether a file is backed up, whether a user
  has acknowledged its warning, and whether an operation may omit it.
  Acknowledging a warning never grants permission to lose or skip data.
- Defer membership tiers, per-project size overrides, a rich report-browser UI,
  and lossy manual moves/archives. Include simple per-file warning acknowledgements
  and an explicit non-default path-copy exclusion option. Dedicated VMs remain
  the escape hatch, not an excuse for silently incomplete operations.

## Incident and Verified Findings

Two orphaned Rustic 0.11.1 processes on us-south-1 spent roughly 15 hours reading
separate snapshot copies of `70T`: a 70 TiB apparent-size file with zero allocated
blocks. Each read tens of terabytes and blocked cache maintenance. Both were
terminated with operator-authorized SIGTERM. The user reportedly deleted the
file, but retained snapshots and retry state may still reference it. Intent is
not established; this plan does not authorize further incident cleanup.

The backup API already defaults to a 30-minute timeout. A local process test
confirmed that the fallback executor's `!child.killed` check can suppress
SIGKILL even while the child remains alive: that property records signal
delivery, not exit. Production also uses a privileged wrapper; this finding
alone does not establish the incident's cause. Both execution paths need work.

Current backup-success reporting and archive eligibility do not distinguish
policy exclusions. Adding a Rustic flag without updating those consumers is
not a safe implementation.

### Sparse Restore Reproduction

A disposable local test on Btrfs with installed Rustic 0.11.1 used two files,
an isolated repository/configuration, and no production data. After backup and
restore, content hashes matched but allocation expanded:

| Fixture                                      | Apparent size | Source allocated | Restored allocated |
| -------------------------------------------- | ------------- | ---------------- | ------------------ |
| Sparse file with three 4 KiB nonzero islands | 64 MiB        | 12 KiB           | 64 MiB             |
| Entirely holes                               | 32 MiB        | 0                | 32 MiB             |

Files were synchronized before measuring `st_blocks * 512`. The fixture and
repository were removed. The installed `restore --help` exposes no sparse
option. This proves dense restoration in this tested path; it is not a test of
production quota enforcement or the complete archive/dearchive RPC.

Consequently, a 10 GiB sparse file can fit in a 4 GiB project but fail restoration
under that quota. A tiny deduplicated backup is not evidence of a small restore.
The per-file cap alone does not solve this: multiple smaller sparse files can
also exceed the quota when restored. Preserve the backup, but do not equate
content completeness with permission to delete the source.

Even a hypothetical 100 GiB cap permits a file using only 1 MiB to expand toward
100 GiB on restore, stranding an otherwise small project behind its quota. This
is a data-access risk, not merely a backup-performance issue. The cap bounds
work; improving the restore path protects recoverability. Both are required.

### Upstream Sparse Support: Available, Not A Complete Solution

[rustic_core PR #530](https://github.com/rustic-rs/rustic_core/pull/530) was opened
July 5 and merged July 24, 2026. It shipped in
[Rustic 0.11.4](https://github.com/rustic-rs/rustic/releases/tag/v0.11.4) on August
18 with rustic_core 0.13.0. The `rustic2` checkout at `143d073` also includes the
feature through its pinned core dependency. The feature is opt-in:
`restore --sparse by-content`; upgrading the binary alone leaves dense behavior.

A second disposable Btrfs test used the official 0.11.4 Linux musl release,
checked against its published SHA-256, to restore backups created by 0.11.1:

| Fixture                             | Source allocated | 0.11.4 default | 0.11.4 `--sparse by-content` |
| ----------------------------------- | ---------------- | -------------- | ---------------------------- |
| 64 MiB, three 4 KiB nonzero islands | 12 KiB           | 64 MiB         | 1.5 MiB                      |
| 32 MiB, entirely holes              | 0                | 32 MiB         | 0                            |
| 16 MiB, 4 KiB nonzero every 64 KiB  | 1 MiB            | 16 MiB         | 16 MiB                       |

All fresh-destination content hashes matched. This verifies compatibility with
these old backups, not every production repository. The implementation skips
entirely zero backup chunks, not zero ranges within mixed chunks, explaining the
remaining inflation. It does not preserve the original filesystem extent map.

There is also a reproduced correctness failure: after filling an existing
32 MiB destination file with `0xa5`, restoring the zero-only backup with
`--sparse by-content --verify-existing` returned exit 0 and "restore done" but
the content hash was wrong. The same test without sparse mode restored correctly.
The inspected core code skips zero-chunk writes while `set_length` opens with
`truncate(false)`, leaving old bytes in those ranges. Do not enable this option
for in-place restores. A fresh, inaccessible staging tree avoids this specific
case, but copy/merge paths and resumed partial restores need equal scrutiny.

Required direction: fix both overwrite correctness and mixed-chunk inflation
in Rustic, pursue focused upstream PRs, then qualify the resulting pinned
binary in CoCalc. These restore-writer improvements do not require a repository
format change: the bytes are already available. Phase 2 below makes them a
release prerequisite. This plan itself does not authorize opening PRs or deploying
a binary.

This restore-only feature does not prevent the original 70 TiB backup from
reading holes. Apparent-size/work limits and process supervision remain needed.

### Copy Transport Findings

`server/projects/copy.ts` currently uses local copies, a bounded remote tar
path, and a Rustic fallback. Defaults are 64 MiB compressed, 256 MiB logical,
and 20,000 files for the tar path, not one universal 100 MB switch. The fallback
can create a whole-project backup and then restore only the selected roots.
Checking that a root directory exists in that backup does not establish that
all its descendants were included. A new exclusion flag must cover this path,
snapshot reuse, queues, and local copies, not just ordinary backup creation.

## Phase 1: Resource Containment

This phase introduces no policy exclusions or new permission to delete data.

1. Give each backup/copy/restore a supervised lifetime covering its entire
   sudo/helper/Rustic process tree. Enforce deadlines across privilege boundaries, preferably in
   a root-owned per-job service/cgroup. Handle cancellation, worker death, and
   service replacement; escalate using actual exit state, not `child.killed`.
2. Enforce internal CPU/memory/I/O, runtime, and per-project/per-host concurrency
   budgets. A new worker must not retry while its predecessor is still running.
   Confirm exit before releasing job locks or deleting its temporary snapshot.
3. Add a bounded metadata preflight on the same immutable snapshot Rustic reads.
   Bound traversal time, entry count, and aggregate apparent bytes before reading
   contents. Respect normal backup exclusions; do not follow symlinks or cross
   unintended mounts. Initially count each regular-file directory entry's size
   toward admission, conservatively including hard links, with overflow-safe
   arithmetic and bounded memory.
4. On budget exhaustion or incomplete inspection, fail with a durable reason and
   preserve source data. Bound retries across worker restarts and put repeatedly
   over-budget projects into operator review instead of an endless retry loop.
   Cheap, rate-limited preflights may detect when changed data fits again.
5. Coordinate with cache-maintenance work already in progress. Locks must protect
   active repository users without an unrelated job blocking all cache cleanup.

Stage worker death, timeout escalation, concurrent retries, and huge-apparent
inputs before a small production canary. Verify healthy backups still restore,
the host remains responsive, and failed jobs cannot satisfy archive readiness.

## Phase 2: Improve Rustic and Qualify Sparse-Safe Restore

This is a core part of the project, not a best-effort upgrade to 0.11.4. Until
qualified, conservative admission must preserve the live source rather than
archive it into a backup that cannot be restored under its entitlement. Phase 1
containment may ship independently; completing the size-policy rollout may not
substitute permanent rejection of ordinary sparse files for this work.

1. Add focused upstream regressions and fixes for zero ranges over existing
   nonzero data, including resumed partial restores. Clear only ranges being
   replaced; do not blindly truncate a file whose matching chunks the planner
   intends to reuse. Preserve correct final length and propagate I/O failures.
2. Handle zero ranges inside mixed chunks, not just wholly zero chunks. Create
   holes during writing, not after dense allocation has already exhausted quota.
   Coalesce suitable ranges without erasing neighboring nonzero bytes. Guarantee
   byte contents, not an identical original extent map or preallocation layout.
3. Target Linux/Btrfs for CoCalc qualification. Use the safe `nix` hole-punching
   interface (`FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE`) where existing bytes
   must be cleared. Keep platform-specific code isolated for upstream. CoCalc's
   sparse-required restore must return an explicit error if required operations
   are unsupported; never fall back silently to dense writes. An upstream
   portability fallback must not weaken this CoCalc contract.
4. Integrate a pinned, tested Rustic/core version and explicit sparse mode into
   every managed restore entry point: backup recovery, archive/dearchive, moves,
   and Rustic-based path copies, including privileged and fallback execution.
   Verify old snapshots with the new reader; re-backing up user data must not be
   necessary to benefit from improved restoration. Mixed-version hosts must
   reject unsupported operations before lifecycle side effects, not ignore flags
   or retry densely.
5. Restore into fresh host-controlled staging inaccessible to project processes.
   Reserve and enforce its real quota/headroom, validate contents and metadata,
   then publish without a dense intermediate copy. Preserve original sources and
   existing destinations on failure. Exercise interruption/retry and hard-link
   handling even with staging; a reused partial tree is not a fresh destination.
6. Gate staging and production canaries on actual Btrfs quota-enforced round
   trips, including a sub-cap 10 GiB sparse file in a 4 GiB project, mixed-chunk
   files, and old backups. Measure peak staging usage and final quota accounting.
   A successful exit or small repository is not proof. Only promote the path
   after these tests pass; do not treat this plan or upstream merge as deployment
   approval.

Backup-side hole skipping is separate follow-up work, not a prerequisite for
this restore fix and not a replacement for apparent-size/work limits. An
extent-aware zero-chunk fast path may avoid reading/hashing long holes without
changing the format, but the current format still records each chunk reference.
A disposable 0.11.4 backup of a 32 MiB all-hole file contained 64 references to
one zero chunk. At that default chunking, 70 TiB needs about 147 million
references (4.375 GiB for raw 32-byte IDs alone). Bound metadata, memory, entries,
aggregate work, and runtime even if zero processing becomes faster.

### Alternative to Prototype: Pack Sparse Files Before Rustic

Evaluate encoding each sparse file as its logical size, extent map, and packed
data in a private backup staging snapshot, then decoding after Rustic restores it.
Rustic would process the packed size rather than the logical zero stream, avoiding
both hole reads and millions of repeated zero-chunk references. Prefer testing an
existing format, such as per-file GNU tar PAX sparse 1.0, before inventing one;
[GNU tar supports seek-based hole detection and sparse extraction](https://www.gnu.org/software/tar/manual/html_node/sparse.html).
Do not turn the whole project into one opaque archive.

Use one private writable Btrfs staging snapshot instead of creating it read-only
as the current code does. Keep it inaccessible to project processes, perform
original-file policy checks and encoding there, then make that same snapshot
read-only before Rustic reads it. No second clone is required, and transformation
must not modify the live project. A tiny packed representation cannot bypass
logical-size, entry/extent, or decode budgets. Hole detection must distinguish
real holes from merely compressed/allocated data.

This changes CoCalc's stored-file representation, even if it leaves Rustic's
repository format unchanged. Prototype versioned, host-authored encoding metadata,
collision-safe names, hard-link/metadata preservation, bounded validated decoding
into fresh staging, and quota enforcement. All restore/copy/browse/download and
offline recovery paths must recognize encoded files; old workers must fail closed,
not return packed bytes as the original file. Document recovery using standalone
tools and test incremental backup behavior as well as full round trips.

This is an alternative to investigate, not a selected encoding or permission to
change production backups. It would not retrofit existing unencoded backups, so
the required Rustic restore improvements and historical-recovery tests still
apply. Compare total lifecycle complexity against an upstream hole-aware backup
optimization before choosing either approach.

The [disposable sparse-packing experiment](experiments/sparse-packing/README.md)
passed round trips and small-edit deduplication with Rustic 0.11.1 and 0.11.4.
It also exposed an incremental-work requirement: regenerating unchanged packed
files loses Rustic's metadata fast path even when no new file blobs are stored.
Reusing a persistent packed tree avoided this; reflink-copying it to fresh file
inodes did not. Qualify cache identity through actual Btrfs snapshots, without
weakening ordinary-file change detection, before choosing this architecture.
Keep cache storage bounded and evictable. Deterministic encoding also needs work:
the tested PAX sparse output included process IDs; GNU sparse output was stable.

## Restore Capacity and Early Admission

Use a conservative dense-restore bound only as an interim rejection guard until
the Phase 2 sparse-aware path passes its capacity/correctness gates. This bound
is not permission to attempt a dense restore that might strand the project.
Improve Rustic rather than build a parallel restore system; neither the existing
flag nor an apparent-size cap is proof of recoverability.

1. From the immutable source or trusted backup manifest, calculate retained
   apparent bytes and entry counts with bounded, overflow-safe arithmetic.
   Count hard-linked paths conservatively unless the deployed restore path is
   verified to preserve their sharing. Do not substitute repository compressed
   size, source allocated blocks, or current source quota usage for this bound.
2. Check the destination quota and host data/metadata headroom, including existing
   destination data, staging, filesystem overhead, and concurrent reservations.
   Archive admission uses the project's restore entitlement, not the entire
   host's free disk. Retain the required restore capacity in archive metadata;
   later quota reductions must not silently strand an archive under a promise
   of same-quota restoration.
3. Before deleting an archive's source, require evidence that the retained data
   fits the supported restore layout and quota. A guessed metadata margin is not
   proof: validate the conservative capacity calculation against the deployed
   Btrfs quota mode, or require a supervised, quota-enforced disposable restore
   of that backup while the source still exists. If neither can establish
   readiness within work budgets, block archival and retain the source.
   Moves additionally verify the actual destination restore before source cleanup.
4. Apply admission on the backend before stopping the runtime, changing placement
   or lifecycle state, dispatching a move/archive, or writing copy destinations.
   A UI-only check is insufficient. Bounded inspection/snapshot work may run as
   a distinct preflight while the project remains usable. Report known exclusions
   and capacity errors there, not halfway through the requested operation.
5. Bind admission to the exact source version, policy, destination, and quota.
   Revalidate under the existing operation guards at execution and before
   destructive finalization. Copies may use their captured immutable version.
   Moves/archives must cover all source edits through final quiescence, including
   writes from outside the runtime; a stopped container alone is not a write fence.
   Repeat admission for changed data. On failure preserve the source and recover
   any temporary stopped state; never delete new data based on an older snapshot.

For the 4 GiB project / 10 GiB sparse-file example, if the file is below the
per-file cap, the backup can be complete but the archive is not ready under the
initial dense model. Reject the archive before stopping it, explain the restore
capacity requirement, and leave the file intact. Do not silently classify it as
oversized or exclude it just because it would not restore. If it exceeds the cap,
the separate exclusion and archival rules below apply. Lowering the cap to the
project quota is not a solution to aggregate inflation.

A qualified sparse-capable path may relax this conservative rejection only with
validated allocation evidence for the retained data, not source `st_blocks` alone.
Create holes during restoration; densely restoring and punching afterward is too
late for quota exhaustion. Test hard links, reflinks, compression, metadata, and
staging as well: preserving holes alone does not guarantee identical allocation.

Historical backups remain recoverable evidence, not disposable failures. On an
over-quota restore, preserve the backup and existing destination, fail clearly,
and offer operator-assisted recovery or a verified sparse-capable path. Do not
raise production quotas without bounds or retry dense restores indefinitely.

## Phase 3: Size Exclusions and Evidence

1. Run a bounded metadata-only inventory and select the site-wide limit from
   measured impact. Validate and capture the effective policy per job; project
   code must not be able to raise or bypass it. A missing required hosted-site
   policy is an error, not an unlimited fallback.
2. Extend preflight to record regular files above the limit without reading their
   contents. Count eligible files against the aggregate work budget. Budget
   exhaustion still fails the job; do not choose additional files to discard.
3. Enforce identical exclusions in the privileged wrapper and fallback. Verify
   `--exclude-larger-than` against the deployed Rustic/core versions, including
   units, the exact boundary, parent snapshots, hard links, and restore behavior.
   Local `/home/user/upstream/rustic` may differ from the installed version.
4. Persist a trusted exclusion report linked to the source snapshot and resulting
   backup ID: effective limit, policy version, relative paths, apparent sizes,
   reasons, timestamp, and counts. Store it with protected backup metadata, not
   as user-editable project evidence, and retain it after host-data deletion.
   Stream the full report; keep control-plane and UI summaries bounded.
5. Propagate explicit outcomes through backup status, scheduling, archive, move,
   copy/restore, and `last_backup` consumers before enabling any exclusions.
   Tie freshness to the captured source snapshot, not a later live-tree state.

Use exactly these semantic outcomes:

- `complete`: the normal backup scope was preserved, with no size exclusions or
  operational failures.
- `partial_policy_exclusions`: all eligible data and the linked exclusion report
  were successfully preserved. Do not present this as a complete project backup.
- `failed`: timeout, budget exhaustion, unreadable data, incomplete scan, failed
  upload/report persistence, or other unknown outcome. Never deletion authority.

A backup process exiting successfully is not sufficient evidence of completeness.
Do not interpret legacy or missing exclusion metadata as proof that a newly
enabled exclusion workflow succeeded. Keep operation readiness separate from
these backup outcomes: `complete` does not mean the restore fits its quota.

### Acknowledgeable Warnings

- Show collaborators the limit, excluded count, sample paths, and a downloadable
  full report. Explain that these files are not backed up and will not be present
  in any archive/copy that explicitly excludes them. Do not guess importance from
  extensions: a database may be disposable, and a GIS file may be irreplaceable.
- Provide per-file checkboxes: "I understand this file is not backed up." Allow
  the prominent warning to collapse once that user acknowledges all current
  exclusions. Keep a quiet backup-status indicator and the report accessible.
  Do not make a large banner permanently non-dismissable.
- Store acknowledgements per account/project/file version and policy version,
  using bounded host-derived metadata identity, not content hashing of huge files.
  A new backup ID alone must not reset an unchanged file's acknowledgement.
  New, replaced, modified, or newly excluded files require a new acknowledgement;
  uncertainty must not silently hide a new warning. One collaborator's choice
  must not silence other collaborators. Bound acknowledgement storage and requests.
- Acknowledgement changes presentation only. It neither marks the backup complete
  nor permits a lossy move/archive, opts into a partial copy, or replaces notice
  for automatic archival. An incomplete scan still reports unknown coverage.
- Distinguish "now eligible, awaiting backup" from protected. Historical partial
  backups retain their exclusion reports even after current files or limits
  change; increasing the limit does not retroactively repair them.

## Archival and Migration Rules

- Reject ordinary backup-based moves and user-requested archives during preflight
  when the required backup would have exclusions or cannot satisfy restore
  capacity. Do not stop a project and only then discover a known policy failure.
  Explain that users must resolve the files and complete a new eligible backup.
  Warning acknowledgement cannot bypass this; no lossy manual operations here.
- Transfer paths that preserve all files may continue; the size cap must not turn
  an otherwise lossless whole-project migration into a lossy one. Such paths still
  need source-version and destination-capacity checks; offline backup-only moves
  cannot assume source sparsity or missing legacy metadata makes them safe.
- Keep automatic deletion with exclusions disabled until separately approved
  policy, advance notices, and an existing-file grace period are in place.
  A banner alone is not notice to absent users. Future reductions in the cap
  also require an explicit transition, not immediate disposal of existing data.
- After that gate, only otherwise-eligible inactive free projects may use a
  verified partial backup for automatic archival. Preserve paid-collaborator and
  publication protections in `project-archive-lifecycle-plan-2026-08-22.md`.
  Recheck authoritative eligibility and matching source/backup/report evidence
  before deletion; an intervening edit, placement change, or upgrade invalidates
  stale readiness. The retained subset must satisfy the same restore-capacity
  requirement as a complete archive; approving omissions does not waive that.
- Operational failures, missing evidence, and aggregate-budget exhaustion always
  block destructive finalization. Restoring an approved partial archive must
  visibly disclose its exclusions.

Explicit compromise: many sub-limit files can still exceed aggregate budgets
and block archival. Pause expensive retries and surface these cases for operator
resolution. This plan does not guarantee unattended archival of every adversarial
filesystem and does not infer permission to discard files from a timeout.

## Cross-Project Path Copy

Default: copy all requested content or reject known policy violations before
copying anything. Add a typed `exclude_oversized: boolean` option, default `false`,
with an unchecked UI option such as "Copy with oversized files excluded" and an
explicit CLI equivalent. This is scoped to one copy request, not a project-wide
exclusion preference or permission to delete source files.

1. Authorize source reads and destination writes, then run the shared bounded
   preflight on an immutable source version for every selected subtree. Return
   a structured error listing the limit, count, representative excluded paths,
   and an authorized report when the option is false. The user can retry with
   the option explicitly enabled. Do not silently switch it on in a fallback.
2. Preflight all requested destinations before starting local `cp`, archive
   creation/content transfer, or queued destination writes. The same request
   policy applies to same-host `cp`, remote tar, and Rustic, so placement does not
   change omission semantics. Check retained aggregate work and destination
   restore headroom even when the file-exclusion option is true. Transport-specific
   limits may select a different safe transport; they never authorize omission.
3. Use one shared manifest/guard, not divergent scanners for each transport.
   Prefer a scoped transient backup of the requested paths for the Rustic path,
   so an unrelated oversized file elsewhere cannot turn a small copy into an
   unbounded whole-project backup. Copy-only artifacts must not advance project
   backup freshness or be treated as complete archive candidates.
4. If reusing a whole-project backup, intersect its trusted exclusion report with
   the selected subtrees, and validate scope and source freshness. A selected
   directory's presence is not enough. Missing/legacy evidence requires bounded
   verification or a new scoped artifact, never assumed completeness. Exclusions
   outside the authorized selection must not leak filenames or block an otherwise
   complete selected copy. Any remaining whole-project backup path stays bounded.
5. Carry source identity, selection, effective policy, option, and exclusion report
   through RPCs, durable queue records, retries, and destination workers. Workers
   revalidate capabilities, authority, and capacity; old workers must reject
   unsupported policy rather than ignore it. Treat manifests/paths as untrusted
   at privilege boundaries; escaping symlinks or dereferencing cannot bypass scope.
6. With explicit opt-in, omit only the oversized files in the admitted selection.
   If any are omitted, finish as `partial_policy_exclusions` with the report
   available; enabling the option with no exclusions still permits `complete`. If all
   selected content is excluded, return a clear no-content result, not "copied".
   Never delete existing destination files at excluded paths, even in overwrite
   mode. No acknowledgement or option excuses unreadable data or failed scans.
7. Stage bounded destination work before publication, preserving existing data on
   failed restores. Recheck/reserve quota against concurrent destination writers.
   Do not promise distributed atomicity across multiple destinations: an unexpected
   later failure reports each destination's actual outcome. Known policy failures,
   however, must be caught before any destination is modified.

Do not advertise a backup-file cap as a universal write/file-size restriction.
Here it is an explicit managed cross-project-copy admission rule as well as a
backup rule; ordinary in-project filesystem operations are unchanged.

## File Counts and Btrfs Limits

Btrfs's supported qgroup/squota interfaces limit extent space, not the number of
files in a subvolume. Inodes are allocated dynamically from metadata space; there
is no supported `max_files=10000000` subvolume setting to enable. See the official
[qgroup reference](https://btrfs.readthedocs.io/en/latest/btrfs-qgroup.html) and
[filesystem limits](https://btrfs.readthedocs.io/en/latest/ch-fs-limits.html).

- Implement a bounded entry-count admission limit for backup, copy, and restore
  work. Count directories and symlinks as well as regular files; count directory
  entries rather than only unique inodes so hard links cannot bypass traversal
  budgets. Ten million is a candidate ceiling, not an approved or cheap default.
- Use rate-limited metadata inventory and alerts for excessive counts, incomplete
  coverage, and host metadata pressure. Do not rescan millions of entries on each
  UI request or fall back to unbounded enumeration to produce an error report.
- These controls limit CoCalc-managed work, not arbitrary file creation inside a
  running container. Periodic detection or denying a future project start is not
  a race-free inode quota. Do not claim that existing disk quotas provide an exact
  file-count limit or add FUSE to obtain one.
- Track hard file-creation enforcement as separate kernel/filesystem architecture
  work. Until supported, retain this explicit defense-in-depth gap and an operator
  response for metadata-exhaustion abuse; do not automatically delete user files.

## Implementation Boundaries

Starting points, relative to the repository root:

- `src/packages/server/cloud/bootstrap/bootstrap.py` and
  `src/packages/project-host/project-rustic.ts`: privileged supervision and guard.
- `src/packages/backend/sandbox/exec.ts`, `rustic.ts`, and
  `src/packages/backend/execute-code.ts`: fallback execution and timeout handling.
- `src/packages/file-server/btrfs/subvolume-rustic.ts` and
  `src/packages/project-host/file-server.ts`: immutable staging, preflight, reports,
  backup outcome publication, and all copy transports.
- `src/packages/file-server/btrfs/restore-staging.ts` and quota management:
  bounded staging, real quota enforcement, and restore capacity evidence.
- `src/packages/server/projects/change-tracking.ts`,
  `archive-lifecycle-policy.ts`, `archive.ts`, `move.ts`, and `copy.ts`: audit
  freshness and destructive/restore consumers; retain existing lifecycle checks.
- `src/packages/project-host/rustic-cache-maintenance.ts`: job/cleanup coordination.
- Upstream `rustic_core` restore planning and `local_destination` range writes:
  zero-range correctness and mixed-chunk sparsity; CoCalc binary packaging and
  restore callers must pin and require the qualified implementation.
- Copy RPC types, `copy-db.ts`, queue consumers, CLI, and frontend copy controls:
  default-preserving option propagation and truthful per-destination results.

Follow `scalable-architecture.md`: the owning bay authorizes project lifecycle
operations and records bounded status; route host work through the host's bay.
Resolve existing account-based archival protections through account home bays.
Hosts scan and back up data; serve detailed reports via authorized project-host
or storage interfaces, not bulk hub proxying. Keep filenames private and safely
encode arbitrary names, including invalid text encodings and glob characters.
Route per-user warning preferences through account ownership; they are not
project lifecycle authority. Cross-project copies may span both hosts and bays.

Read `accessibility.md` before implementing warnings/downloads. A new interactive
quota administration interface and report browser are not prerequisites.

## Release Gates and Acceptance

Deploy resource containment and conservative restore/admission guards first,
after staging verification; they do not depend on implementing sparse restore.
Next complete Phase 2: qualify improved Rustic on Linux/Btrfs, canary the managed
sparse-required restore paths, and verify host capability enforcement. Do not
declare the plan complete or enable Phase 3 exclusions without that gate; the
file cap does not protect against restore expansion even for eligible files.
For Phase 3, first ship backward-compatible outcome consumers, upgraded
bootstrap/helpers and hosts, and the warning/copy UI with exclusions disabled.
Inventory and canary the policy, then enable it only on hosts with verified
enforcement/reporting capabilities. Do not fall back to unguarded execution on
old hosts. Approval to exclude from backups is separate from approval to delete
source data during automatic archival. No runtime change is deployed by this plan.

Acceptance tests must demonstrate:

- Huge-apparent sparse inputs are rejected/excluded without reading their holes;
  exact-boundary files round-trip correctly within admitted capacity.
- In a disposable quota-enforced staging project, test a 10 GiB sparse file in a
  4 GiB quota, both above and below the chosen cap, and many sub-cap sparse files
  whose retained logical total exceeds quota. Dense restores must be blocked
  before archive/move side effects, regardless of small repository size or a
  warning acknowledgement. The qualified sparse path must successfully round-trip
  admitted fixtures whose actual restored usage fits, including through the full
  archive/dearchive RPC; rejecting all sparse files is not a passing result.
  Smaller scaled fixtures belong in routine CI.
- Measure content integrity, allocated blocks, actual quota accounting, and peak
  staging usage, not just restore exit status. Exercise privileged and fallback
  restores, tar, and `cp`, including zero-only/mixed/trailing holes, pre-existing
  destination data, hard links, reflinks, compression, and quota changes.
- Retain the 0.11.4 sparse overwrite reproduction as a regression test. Restoring
  zeros over nonzero bytes, including after interrupted/retried restores, must
  reproduce the backup exactly; `--verify-existing` is not a post-restore check.
  Test fresh sparse restores from old snapshots and mixed-chunk allocation, too.
  Sparse-required capability failures and old binaries must never trigger dense
  fallback. Exercise the final staging-to-destination transfer as well as Rustic.
- Both execution paths enforce policy; worker death, ignored SIGTERM, privileged
  children, service replacement, and retry recovery leave no orphaned workers.
- Many eligible files and large directory trees hit bounded admission limits
  without unbounded memory, content reads, or automatic retry storms.
- Hostile filenames, symlinks, hard links, scan/upload/report failures, and policy
  changes cannot forge completeness or permit unsupported source deletion.
- Complete/partial/failed outcomes reach all lifecycle consumers; blocked moves,
  mixed host versions, cross-bay operations, intervening edits/upgrades, and
  partial restores preserve the specified safety and warning behavior.
- Spies/order tests show rejected move/archive preflights never call stop,
  placement mutation, destination start, or source deletion. Repeat admission
  when the source changes; stale evidence cannot authorize finalization.
- Acknowledging an unchanged excluded file collapses that user's warning across
  backups, but new/replaced/changed files warn again. Other collaborators, backup
  outcomes, historical reports, and archive/copy authorization are unaffected.
- Copy defaults reject an excluded descendant before any destination writes;
  explicit opt-in excludes only admitted oversized paths and preserves existing
  destination files at those paths. Cover local/tar/Rustic selection, fallback,
  reused partial snapshots, outside-selection exclusions, retries, old workers,
  cross-bay authorization, and full-selection exclusion. Aggregate limits and
  unknown failures remain errors even with the option enabled.

Rollback disables exclusions or partial archival without removing historical
reports/warnings, weakening Phase 1 containment, or resuming unbounded retries.
If the qualified sparse implementation must be withdrawn, block dependent
archive/move finalization and preserve recovery sources; do not route its archives
through an unqualified dense reader. Retain the qualified recovery artifact and
its version metadata for operator-assisted recovery where safe to use.
Never benchmark large sparse-content reads against production.

## Remaining Operator Decisions

- The single hosted-site size limit, internal work budgets, and canary cohort,
  informed by bounded inventory and staging measurements, including entry-count
  limits and a validated restore overhead/reservation policy.
- Explicit defaults for self-hosted deployments.
- Notice/grace rules for existing files, including unreachable users, and the
  separate go/no-go decision for automatic archival with exclusions.
- The pinned Rustic/core fix set, capacity evidence, and sparse-restore canary
  rollout approval. Doing Phase 2 is required; only its specific implementation
  and deployment approval remain open. Unmodified 0.11.4 is not sufficient.
