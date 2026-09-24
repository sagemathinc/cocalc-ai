# Project Snapshot and Backup Reliability Plan

Date: 2026-09-23

Status: staging implementation in progress; production unchanged. See the
[staging2 validation report](staging2-project-recovery-validation-2026-09-23.md).

## Decision and desired outcome

Treat timely, recoverable project history as a product reliability obligation.
Separate local snapshots from off-host backups, schedule them independently,
give projects funded by paying customers first access to constrained capacity,
and make every missed obligation visible. Host responsiveness remains a hard
constraint. When safe capacity is insufficient, report and add capacity or fix
the bottleneck; silently lengthening the backup interval is not an acceptable
resolution.

This plan covers project Btrfs snapshots and project Rustic backups. Bay
database backups have a separate implementation and health check. A local
snapshot does not protect against loss of its project host; an off-host backup
does.

## Evidence and current failure modes

- The September 23 investigation in the exported `lite4-2` ops thread reported
  4,837 projects eligible for a sweep on 16 running hosts. Its roughly 930
  projects with changed data older than 24 hours and no later recorded backup
  are _backup debt indicators_, not an exact count of late snapshots. The
  investigation was read-only and its numbers are a point-in-time observation,
  not a new baseline gathered by this plan.
- The [current scheduler](../packages/project-host/snapshot-backup-maintenance.ts)
  fetches at most 32 candidates per host every 15 minutes and runs snapshot
  maintenance before backup maintenance for each candidate. A slow backup can
  hold up all later snapshots; an overlapping sweep is skipped. Its hub query
  [sorts by backup debt](../packages/server/conat/host-status.ts), so projects
  outside the first page can remain invisible indefinitely, especially when
  new edits change ordering.
- [Storage admission](../packages/project-host/storage-admission.ts) defers
  scheduled work during lifecycle activity or I/O pressure. The present
  starvation override applies only to some overdue backups, not snapshots.
  Memory pressure can skip the entire sweep. These protections need measured
  recovery behavior and explicit debt accounting.
- [Rolling maintenance](../packages/file-server/btrfs/snapshots.ts) creates
  before pruning. [Rustic creation](../packages/file-server/btrfs/subvolume-rustic.ts)
  refuses a new backup when the entitlement count is already reached. The
  scheduled path in [file-server.ts](../packages/project-host/file-server.ts)
  passes that limit directly. Thus a project at its four-backup limit can fail
  every scheduled replacement. A separate `planBackupRetention` helper already
  supports create-before-delete for an explicit manual replacement path; reuse
  that policy carefully for rolling maintenance.
- A September 22 production health check in the local worktree (not part of
  this change set) found 18 projects with repeated quota failures while
  pruning snapshots.
  Their project history was stale despite healthy _bay_ backup/PITR status.
  The system must surface both failures independently.
- `projects.last_backup` and change generations are available centrally, but
  the latest successful local snapshot is not. Exact snapshot lateness and
  stage durations cannot be calculated cluster-wide today. An unavailable host
  must be reported as **unknown**, never as current.

## Reliability contract

1. **Success means recoverable data.** Record snapshot success only after the
   Btrfs snapshot is present and usable. Record backup success only after
   Rustic has committed a repository snapshot and its identity can be read
   back from the off-host repository. A queued, attempted, or locally staged
   operation is not success. Run regular restore drills to test more than
   metadata existence.
2. **No destructive replacement on failure.** Never delete the last known
   usable snapshot or off-host backup to make room for an attempted successor.
   Preserve manual/named snapshots and explicit retention rules. Handle
   zero/one-slot entitlements explicitly instead of claiming create-before-delete
   is possible when physical or product limits prohibit it.
3. **Due times are change-aware.** For enabled schedules, calculate the next
   due time from the last _successful_ recovery point, the configured interval,
   and the last confirmed data change/generation. Do not mark unchanged
   dormant projects late merely because time passed. Unknown change evidence
   triggers host reconciliation; it does not suppress work. Disabling a schedule
   is shown distinctly from a missed schedule.
4. **No hidden backlog.** Every enabled, provisioned, host-owned project must
   be examined during bounded reconciliation, even if it has been inactive for
   more than two days or is beyond an initial query page. A changed dormant
   project stays eligible until a suitable recovery point exists.
5. **Protect interactive work.** Snapshot discovery, pruning, Rustic scanning,
   uploads, and retries must run within documented CPU, memory, I/O, mutation,
   and concurrency budgets. Emergency host protection may defer work, but the
   debt remains visible and automatically retries when safe.
6. **Ownership is explicit.** The owning bay is authoritative for project
   schedule, membership, host assignment, and durable status. The assigned
   host is authoritative for local snapshot inventory and execution. Check
   ownership and volume generation before every operation and again before
   reporting success; a moved/archived project cannot be acted on by a stale
   host. Do not route project data through the bay.

### Initial service objectives to validate in the canary

These are proposed _targets_, not claims about current production. Measure
from due time to confirmed success for changed, enabled, host-available
projects. Report host outages and policy/egress blocks separately; do not erase
them from customer-visible delay.

| Class         | Local snapshot target                      | Off-host backup target                  | Immediate incident trigger                               |
| ------------- | ------------------------------------------ | --------------------------------------- | -------------------------------------------------------- |
| Paying-funded | 99.9% within 30 min after due over 30 days | 99.9% within 6 h after due over 30 days | Any project > 2 h snapshot debt or > 12 h backup debt    |
| Free-funded   | 99% within 4 h after due over 30 days      | 99% within 24 h after due over 30 days  | Growing oldest debt or repeated failure; capacity review |

Targets apply to the configured schedule; no promise of a 15-minute snapshot
exists when the frequent schedule is disabled. Each breach is counted even if
the aggregate percentage still passes. A successful backup's age and a missed
due time are separate measurements. Set the final targets from real duration
distributions and restore drills before calling the rollout complete; changing
them requires an explicit product/operations decision.

## Implementation

### 1. Establish accurate state and stage timings first

Add a versioned, bounded per-project maintenance ledger on the host, persisted
in its existing SQLite state and reconciled with Btrfs/Rustic after restart.
Store schedule revision, observed change/generation, last confirmed snapshot
time/name, last confirmed backup time/id, next due time, first due time, last
attempt, stage, outcome, reason code, retry time, and host ownership epoch.
Do not store credentials or user file contents. Publish compact status to the
owning bay through the host status channel; use a durable bay-side projection
for cluster queries and user display. Host reports carry host ID, generation,
timestamp, and staleness; older reports cannot overwrite newer successes.

Time separately: candidate discovery, Btrfs inventory/change detection,
snapshot creation, snapshot prune, Rustic scan/upload/commit, backup prune,
and index/reporting. Record queue wait and execution time, bytes scanned and
uploaded when available, and structured defer/failure reasons. Bound metric
cardinality by host, class, operation, and reason; keep project IDs in the
operator query, not time-series labels. Explicitly count unknown/stale reports.

Before setting capacity, gather a 7-day production baseline: due and completion
age distributions by paid/free class and host, p50/p95/p99 stage times, backup
bytes, retry rates, I/O pressure, host lifecycle latency, and restore success.
Use this to distinguish cheap Btrfs creation from expensive discovery/pruning
and from long Rustic uploads. The earlier investigation's snapshot count cannot
serve as that baseline.

### 2. Replace the capped combined sweep with two independent lanes

The owning bay provides a paged, deterministic host-owned project inventory
with schedule, storage entitlement, funding class, and current assignment.
Use keyset pagination by stable project ID (or a durable cursor), not a `LIMIT
32` query sorted by mutable timestamps. The host reconciles every page into
separate snapshot and backup due queues. On startup, assignment changes,
schedule changes, and at least once each hour, walk all assigned projects in
bounded pages; event updates accelerate normal operation. When the bay is
temporarily unavailable, keep processing already validated local queue items
with a bounded ownership lease, then pause mutations on lease expiry. Do not
start an unbounded host-wide scan at boot.

Each lane dispatches as soon as its work is due, not at the next 15-minute
combined sweep. Snapshot lane never awaits a Rustic backup. Backup lane has
its own concurrency and bytes-in-flight budget. Deduplicate per project and
operation across manual, scheduled, archive, and move actions, preserving the
existing lifecycle lock. Keep any Btrfs metadata mutation lock short; never
hold it through a full Rustic scan/upload. Re-check schedule, generation,
assignment, and admission just before a mutation, then report a typed skipped
outcome if state changed. Skip an unchanged project cheaply from its ledger;
periodic reconciliation still verifies ledger correctness.

Use bounded retries with jitter, classified by reason. A transient lifecycle
deferral should retry promptly after the quiet window, not wait for another
full sweep. Exponential backoff applies to repeated deterministic failures
such as quota, retention limit, repository auth, and egress policy; keep their
original due time and alarm state. One failing project cannot occupy the head
of a queue or all worker slots.

### 3. Prioritize the customer who funds storage

Define one server-side `storage_service_class` from the account responsible
for storage/managed-backup usage: `usage_account_id` when valid, otherwise the
project owner, with explicit course/sponsored-project tests. Resolve current
membership on the owning bay and refresh it on subscription/sponsor changes.
`runtime_sponsor_account_id` funds runtime admission and can differ from the
storage payer; do not infer paid storage priority from any paid collaborator.
Keep entitlement limits separate from dispatch priority. Within a class, use
the effective `shared_compute_priority` as a tie-breaker only after confirming
it belongs to the same funding contract, then order by due age. This requires
aligning the current host schedule query, which resolves limits from the owner,
with the actual storage entitlement policy rather than silently changing
entitlements during scheduler rollout.

Dispatch paying work ahead of free work within each lane. When both classes
are continuously due, reserve at least 80% of admission opportunities for
paying projects and at least 10% for free projects; lend unused shares to the
other class. Within paying work, use oldest-due-first with per-account round
robin so one customer's many projects cannot starve another's. Escalate paid
items approaching their objective. A nonpreemptible backup already running can
delay a newly due paid backup: measure that wait and size safe concurrency so
at least one slot is available for paying work when possible. Never raise
parallelism beyond the measured host I/O and memory envelope merely to honor
the split. If one slot is all a host can safely run, its finite execution time
and paid wait are part of capacity planning.

### 4. Keep hosts responsive without hiding debt

Retain storage admission, mutation-boundary checks, cgroups, and memory/I/O
pressure safeguards. Give snapshot create/inventory/prune and Rustic scan/upload
separate cost budgets and pressure decisions; do not classify all snapshots as
"free" because inventory and deletion can be slow. Under contention, admit a
small measured snapshot budget before any backup budget when safe, while
protecting lifecycle operations and interactive latency. Use hysteresis and
cooldowns to prevent stop/start thrashing. A critical host pressure or missing
pressure measurement blocks risky work and produces a visible reason; it
does not reset due times or mark the queue healthy.

Tune using controlled canaries, not a fleet-wide concurrency increase. Measure
project start/stop, file, terminal, Jupyter, and host heartbeat latency beside
backup throughput. Size each host using observed due work per hour multiplied
by stage-time distributions and bytes transferred, with explicit allowance for
burstiness and a target of at most 70% sustained use of its measured safe
maintenance budget. If demand exceeds that envelope for a day, trigger a
capacity action instead of waiting for a missed objective. Move projects or
add hosts, improve scan/upload efficiency, or adjust product schedules with an
explicit decision and user communication. Integrate with the existing
[I/O containment plan](./project-host-io-containment-plan-2026-07-20.md).

### 5. Repair retention and blocked recovery paths

For automatic rolling backups at the entitlement count, reserve one temporary
replacement slot _per project_ under its backup lock, create and confirm the
new off-host backup, then prune only eligible old automatic backups to the
normal limit. Reuse the create-before-delete model already present for explicit
replacements, but do not use an unrestricted `limit + 1` bypass. Account for
the temporary slot in repository capacity/egress admission; if capacity is
unavailable, keep the old backup and report `replacement_capacity_blocked`.
At a one-backup limit, retain the old backup until the new one is confirmed.
At a zero-backup entitlement, follow the documented policy for existing or
final recovery copies; do not invent a hidden recurring entitlement. Make
prune retryable after successful creation so a prune failure cannot cause an
endless creation loop. Do not delete named/manual or archive-pinned backups.

Snapshot replacement follows the same preservation rule. Fix quota-exhausted
Btrfs deletion with bounded, attributed cleanup headroom and verified
reconciliation, rather than retrying an identical failing prune hourly. Treat
repository credentials, object-store failure, managed-egress policy, project
volume unavailable, and quota exhaustion as distinct states. A temporary
policy block stays visible to the user and operations; an old recovery copy
must remain intact. Verify backup index and `last_backup` reporting after
success, including retries after hub disconnect, so a confirmed backup does
not remain falsely overdue.

Current architecture note: commit `fc7c75ebc5` replaced new SQLite backup
sidecar indexes with a bounded Rustic metadata browser. For new backups,
verify repository catalog listing and file browsing plus `last_backup` and
the confirmed backup ID in the owning bay; keep legacy index checks only for
older indexed backups. A null legacy index timestamp is expected for a new
backup and does not indicate missing recovery data.

### 6. Show actual protection to users and operators

Add a project history status beside the existing snapshot/backup schedule:
latest confirmed local snapshot, latest confirmed off-host backup, next due,
delay if overdue, current activity, and plain-language reason for a block.
Label host status stale/unknown and distinguish disabled schedules, unchanged
data, and active delays. Warn paying project owners/collaborators when either
objective is breached; link to the appropriate recovery/settings view. Avoid
promising a recoverable point before repository confirmation. Read
[accessibility.md](./accessibility.md) before UI work and cover status updates
with focused accessibility tests.

Add project recovery health to regular production checks, separate from bay
backup/PITR health. Show counts and oldest debt by bay, host, and class;
per-stage p95/p99 duration; completions, deferrals, failures, retry age;
unknown/stale host reports; pressure time; and restore-drill results. Page on
any paying project crossing the critical threshold, repeated failed paid
attempts, a paid queue with no completions, or missing host telemetry. Route
incidents to a named on-call owner. Create a daily report of oldest free and
paid debt and an operator command to inspect one project without reading user
files. Alert fatigue should be controlled by grouping shared host/repository
causes, not by suppressing affected-project counts.

### 7. Test recoverability and roll out in gates

**Gate A — visibility and immediate repair.** Instrument the existing worker
and publish paid/free backlog and unknown counts. Fix the full-entitlement
rolling backup failure and quota-blocked snapshot cleanup. Verify affected
projects recover or are explicitly escalated. Until telemetry is complete,
keep the earlier cluster estimate labeled approximate.

**Gate B — scheduler canary.** Implement paged reconciliation and independent
lanes behind per-host flags. Run shadow due/priority calculations first, then
enable on one representative host. Include a host with many projects and one
with sustained lifecycle activity. Compare actual recovery-point ages and
interactive p95/p99 latency with baseline for at least a week. Roll back the
new dispatcher without deleting ledger data or changing retention policy.

**Gate C — fleet and product health.** Roll out by bay/host cohort with
automatic stop gates for latency, pressure, error rate, or new backup age
regression. Enable paying-customer warnings and production health alerts only
when status semantics and freshness have been validated. Run a remote-only
restore drill for sampled backups, including paid projects and each repository
shard, before declaring the objective met.

Focused automated coverage must include: more than 500 eligible projects and
mutable due ordering; paid projects arriving behind a running free backup;
per-account fairness; a continuously failing first candidate; lifecycle and
memory/I/O deferrals with recovery; host/bay restart and ownership move;
membership and sponsor changes; disabled and unchanged projects; limit 4/1/0
replacement with upload failure and prune failure; quota-exhausted cleanup;
stale backup index/report replay; host telemetry missing; and snapshot creation
while a long backup is running. Exercise restore from a backup created by the
new path. Use focused package checks and frontend lint for the corresponding
implementation changes.

## Completion criteria

- All enabled, provisioned projects are covered by reconciliation; no fixed
  first page can monopolize dispatch.
- Paying-funded work demonstrably starts ahead of free work when both are due,
  with bounded free progress and per-account fairness.
- Snapshot success remains prompt while backups run, and host interactive
  latency stays within its existing production objectives during canaries.
- No scheduled replacement fails solely because the old valid backups fill
  the retention count; failed attempts preserve the last usable copy.
- Every late paying project appears in its own project status and in production
  health. Unknown host status is visible, not counted as success.
- Measured due-to-success results meet the agreed targets for 30 days, with
  regular successful off-host restore drills. If safe capacity cannot meet the
  targets, the incident and capacity plan remain open.
