# Bounded Project Backups and Oversized Files

Date: 2026-09-05.

Status: implementation plan revised after policy review. This document edit
does not authorize implementation, deployment, or source deletion. Numeric
limits and production rollout decisions still require separate approval.

## Scope and Policy

Protect managed-project hosts from unbounded backup work without building a
new membership-quota product. Deliver resource containment first, then a fixed
file-size policy with honest exclusion reporting.

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
- Defer membership tiers, per-project overrides, a rich report-browser UI, and
  per-operation acknowledgement tokens. Dedicated VMs are the escape hatch.

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

## Phase 1: Resource Containment

This phase introduces no policy exclusions or new permission to delete data.

1. Give each backup a supervised lifetime covering the entire sudo/helper/Rustic
   process tree. Enforce deadlines across privilege boundaries, preferably in
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

## Phase 2: Size Exclusions and Evidence

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
enabled exclusion workflow succeeded.

Display a persistent project-wide warning for collaborators, with the limit,
count, sample paths, and a downloadable full report. Explain the impact on
backups and archives and direct exceptional workloads to a dedicated VM. Before
enabling lossy archival, explicitly warn that excluded files will be permanently
lost on that operation. Distinguish "now eligible, awaiting backup" from protected.
Historical partial backups keep their warnings when current files or limits
change; increasing the limit does not retroactively repair them.

## Archival and Migration Rules

- Ordinary backup-based moves and user-requested archives must stop when the
  required backup has exclusions. Explain that users must resolve the files and
  complete a new backup. Do not build lossy-move acknowledgements in this phase.
- Transfer paths that preserve all files may continue; the size cap must not turn
  an otherwise lossless migration into a lossy one.
- Keep automatic deletion with exclusions disabled until separately approved
  policy, advance notices, and an existing-file grace period are in place.
  A banner alone is not notice to absent users. Future reductions in the cap
  also require an explicit transition, not immediate disposal of existing data.
- After that gate, only otherwise-eligible inactive free projects may use a
  verified partial backup for automatic archival. Preserve paid-collaborator and
  publication protections in `project-archive-lifecycle-plan-2026-08-22.md`.
  Recheck authoritative eligibility and matching source/backup/report evidence
  before deletion; an intervening edit, placement change, or upgrade invalidates
  stale readiness.
- Operational failures, missing evidence, and aggregate-budget exhaustion always
  block destructive finalization. Restoring an approved partial archive must
  visibly disclose its exclusions.

Explicit compromise: many sub-limit files can still exceed aggregate budgets
and block archival. Pause expensive retries and surface these cases for operator
resolution. This plan does not guarantee unattended archival of every adversarial
filesystem and does not infer permission to discard files from a timeout.

## Implementation Boundaries

Starting points, relative to the repository root:

- `src/packages/server/cloud/bootstrap/bootstrap.py` and
  `src/packages/project-host/project-rustic.ts`: privileged supervision and guard.
- `src/packages/backend/sandbox/exec.ts`, `rustic.ts`, and
  `src/packages/backend/execute-code.ts`: fallback execution and timeout handling.
- `src/packages/file-server/btrfs/subvolume-rustic.ts` and
  `src/packages/project-host/file-server.ts`: immutable staging, preflight, reports,
  and backup outcome publication.
- `src/packages/server/projects/change-tracking.ts`,
  `archive-lifecycle-policy.ts`, `archive.ts`, `move.ts`, and `copy.ts`: audit
  freshness and destructive/restore consumers; retain existing lifecycle checks.
- `src/packages/project-host/rustic-cache-maintenance.ts`: job/cleanup coordination.

Follow `scalable-architecture.md`: the owning bay authorizes project lifecycle
operations and records bounded status; route host work through the host's bay.
Resolve existing account-based archival protections through account home bays.
Hosts scan and back up data; serve detailed reports via authorized project-host
or storage interfaces, not bulk hub proxying. Keep filenames private and safely
encode arbitrary names, including invalid text encodings and glob characters.

Read `accessibility.md` before implementing warnings/downloads. A new interactive
quota administration interface and report browser are not prerequisites.

## Release Gates and Acceptance

Deploy Phase 1 independently after staging verification. For Phase 2, first ship
backward-compatible outcome consumers, upgraded bootstrap/helpers and hosts, and
the warning UI with exclusions disabled. Inventory and canary the policy, then
enable it only on hosts with verified enforcement/reporting capabilities. Do not
fall back to unguarded execution on old hosts. Approval to exclude from backups
is separate from approval to delete source data during automatic archival.

Acceptance tests must demonstrate:

- Huge-apparent sparse inputs are rejected/excluded without reading their holes;
  ordinary sparse files and exact-boundary files round-trip correctly.
- Both execution paths enforce policy; worker death, ignored SIGTERM, privileged
  children, service replacement, and retry recovery leave no orphaned workers.
- Many eligible files and large directory trees hit bounded admission limits
  without unbounded memory, content reads, or automatic retry storms.
- Hostile filenames, symlinks, hard links, scan/upload/report failures, and policy
  changes cannot forge completeness or permit unsupported source deletion.
- Complete/partial/failed outcomes reach all lifecycle consumers; blocked moves,
  mixed host versions, cross-bay operations, intervening edits/upgrades, and
  partial restores preserve the specified safety and warning behavior.

Rollback disables exclusions or partial archival without removing historical
reports/warnings, weakening Phase 1 containment, or resuming unbounded retries.
Never benchmark large sparse-content reads against production.

## Remaining Operator Decisions

- The single hosted-site size limit, internal work budgets, and canary cohort,
  informed by the bounded inventory and staging measurements.
- Explicit defaults for self-hosted deployments.
- Notice/grace rules for existing files, including unreachable users, and the
  separate go/no-go decision for automatic archival with exclusions.
