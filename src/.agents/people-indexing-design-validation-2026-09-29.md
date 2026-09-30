# Demand-Driven People Indexing: Design And Validation

Date: 2026-09-29.
Status: user approved manual-only, scoped, cancellable Scan LROs on 2026-09-29,
in addition to the smaller initial-release contract below. The manual Scan
implementation and local validation are delivered; see the manual Scan delivery
section in the execution results for coverage and the remaining live deployment
validation. This is not production enablement.
The raw live btrfs generation candidate failed the no-change proof spike; see the
[execution results](people-indexing-validation-results-2026-09-29.md).
No capacity claims are made by this document.
Inspected baseline: `a60a05e8809ebb1e44a7038599b40170d079f408`.

Related plans:

- [Scalable control plane](scalable-architecture.md).
- [Collaborators workspace](collaborators-workspace-plan-2026-09-27.md).
- [People and content invitations](people-invitations-plan-2026-09-29.md).
- [Accessibility requirements](accessibility.md).

## 1. Decision And Scope

**Approved initial-release contract:** People is an eventually consistent
discovery cache of known collaboration resources. It may omit resources until
they are opened or explicitly scanned. It never determines permission to access
them. Keep project-owned catalogs, account-home personal state, and
`collaborators_enabled` during implementation and measured rollout.

This section and the initial-release gates below supersede broader requirements
in sections 2-13 for this release. Those sections are retained as historical
design and optional future work, not an automatic implementation backlog.
Do not keep pursuing their larger scope without a separate user decision.

The cost model must approach:

`source changes + active view demand + actual deliveries + bounded repair`

It must not approach:

`all historical memberships x timer frequency`.

An inactive account should mainly cost storage. It may incur work when somebody
actually invites or mentions it, when its permissions change, or during bounded
retention/deletion maintenance. Its existence alone must not require recurring
per-project RPCs, access-lease writes, or notification polling.

### Initial-Release Behavior

- Index supported resources through normal CoCalc open/write registration and
  existing dirty-source signals. Terminal-created files, restores and external
  edits need not be discovered automatically. Opening a resource or requesting
  Scan is the recovery path; catalog catch-up is distinct from filesystem discovery.
- Refresh account views only with live visible-view demand and bounded grace.
  Returning users catch up from retained project catalogs, not a filesystem scan
  of every project. Keep bounded repair of known catalog state; do not trigger
  full filesystem discovery merely because a view opens or an hour passes.
- Dormant accounts mainly cost storage. Genuine invitations/mentions, membership
  changes and bounded cleanup may still cause work. Offline delivery must not
  depend on an open People view or warm resource projection.
- Explicit human Scan is a scoped, cancellable long-running operation (LRO),
  never automatic in the initial release. It is authorized, single-flight,
  frequency-limited and best-effort under concurrent
  writes. Finished traversal does not certify a point-in-time filesystem snapshot,
  current-byte equality, or that every resource has reached every home view.
  Show unavailable, truncated, deferred and failed outcomes honestly. No scan
  starts project compute implicitly. Agent Scan stays denied until its scope is
  separately reviewed; it is not an initial-release requirement.
- Cached metadata may be stale or incomplete, but protected metadata and actions
  remain subject to current authorization under the existing reviewed policy.
  Never weaken authorization leases/fences to make discovery cheaper.
- Preserve canonical identities, aliases, pins/collection, follow/mute/read
  state, invitation lifecycle and pending notification obligations. Derived
  indexes and demand leases can be discarded and rebuilt after moves/restores.
  Do not transfer transient work simply to preserve seamless UX.
- Outstanding Scan work may be explicitly interrupted by topology changes, but
  never silently replayed or reported failed solely because of a timeout. Keep
  existing rehome guards until interruption/receipt handling is implemented and
  tested; this contract change does not authorize dropping durable receipts.

### Manual Scan Product Contract

Indexing and scanning are different operations. Normal supported create/open/write
activity continues registering and updating known resources automatically.
Filesystem Scan discovers historical or externally changed supported resources;
it is an explicit import/recovery operation, not a prerequisite for ordinary
collaboration. If a newly created supported conversation requires Scan to appear,
fix the registration/update path rather than normalize that workflow.

The user opens **Scan projects**, searches/selects projects (or selects all
eligible projects), reviews the selected count, and explicitly starts one LRO.
Resolve "all" to a fixed, authorized project set at submission; later projects
are not silently added. Persist that set and paginate large selections/results.
Projects excluded from this selection are not traversed by this operation.
Not scanning a project does not hide resources registered by ordinary activity;
global-view visibility preferences are a separate concern.

Expose familiar controls: scan availability enabled/disabled, explicit project
scope, start, inspect progress, and cancel. An administrator can disable new Scan
admissions server-side as well as hide the UI. Existing operations must remain
inspectable/cancellable; disabling admission does not discard receipts or
silently claim cancellation. Disabling Scan does not disable normal indexing,
revoke project access, or delete previously indexed resources.

**No automation ships initially.** No Scan on login, page open, host startup,
project startup, inactivity, elapsed time, or reenable. No automatic initial
bootstrap or periodic filesystem sweep, including legacy fallback paths. Bounded
execution/recovery of an already user-authorized LRO is not a new automatic Scan.
Future opt-in scheduling can reuse explicit scopes, frequency limits and LROs,
but requires a separate product/rollout decision; do not build that scheduler now.

### Scan LRO Design And Reuse

Use the existing LRO admission, persistence, worker, progress, cancellation and
UI conventions. Inspect these implementations before adding another state machine:

- `packages/server/lro/lro-db.ts` and `packages/server/conat/api/lro.ts`.
- `packages/server/projects/copy-worker.ts` for bounded multi-project work.
- `packages/server/projects/backup-lro.ts` for deduplication conventions.
- `packages/server/projects/start-lro-progress.ts` for progress conventions.
- `packages/server/inter-bay/start-lro-forward.ts` for routed operation identity.

Reuse infrastructure, not assumptions: verify its cancellation and expiration
semantics are sufficient for Scan. Adapt the existing per-project Scan receipts
and dispatch to the LRO, retaining ambiguous in-flight identities; do not create
a second independently authoritative execution path or replay old work merely
because the UI changes.

Proposed ownership: the requesting account's home bay owns the batch LRO and
selection; each project's owning bay authorizes and coordinates its scan; its
host traverses local storage. Route explicitly across bays. Keep traversal and
file contents off the hub; return bounded metadata/progress. Retain topology
guards until interruption and fencing are verified.

- **Single flight:** one active foreground Scan batch per requesting account across tabs,
  sessions and entry points. A second start returns the existing operation,
  without extending its selection or launching new work. Enforce this atomically
  server-side, not with a disabled button. Serialize per-project scans across
  accounts too; initially defer conflicting children rather than share execution
  with ambiguous cancellation ownership.
  As clarified on 2026-09-30, any host may disappear or be deprovisioned. An
  unavailable host must not indefinitely reserve the whole account. Its batch
  may end with an unavailable result while the project owner retains the exact
  unresolved execution and project reservation for background stop recovery.
  This is not successful cancellation or permission to replace that execution.
- **Frequency limits:** enforce account and project limits durably, plus bounded
  host/bay concurrency. Return the next eligible time. Cancellation, failures,
  browser reload and new request IDs must not bypass limits; an idempotent replay
  must not consume another admission. Choose documented initial intervals and
  concurrency from measured scan cost before enablement, not from DAU guesses.
- **Cancellation:** stop admitting queued children and signal running children.
  Confirmed stops become cancelled. If the host cannot be reached, end foreground
  processing with unavailable and explicit "stop unconfirmed" text; retain the
  owner job, cancellation intent, exact host/run identity and project reservation.
  Only an exact stop acknowledgment releases that project's reservation. The
  account can submit another batch for other projects after its normal cooldown.
  A timeout never means the remote execution stopped. Use bounded traversal checkpoints;
  measure cancellation latency. Cancellation is idempotent, does not undo already
  indexed metadata, and never deletes canonical user state.
- **Durability:** persist operation identity, fixed selection, child identities,
  progress and cancellation intent. Closing the dialog, refresh, disconnect or
  worker restart must not duplicate or lose the operation. Recover through the
  standard LRO interfaces. Observation timeouts mean unknown, not failed or safe
  to restart the affected project; reconcile/fence abandoned execution before
  replacement admission. A bounded, independently leased recovery worker keeps
  retrying the same stop identity, including after admission is disabled or the
  original account loses project access. It does not provision or start a host.
- **Progress:** show aggregate projects processed out of the fixed total, with
  separate successful, failed, unavailable, truncated and cancelled counts.
  Show per-project queued/running/cancelling/terminal details and actual counters
  where available. Do not invent percent-of-files or ETA for an unknown tree.
  A full progress bar means processing ended, not universal success, a filesystem
  snapshot, confirmed stopping of unavailable hosts, or completion of home-view catch-up.
- **Retry:** after terminal completion/cancellation and the frequency limit,
  allow explicit retry of selected unsuccessful projects as a new LRO. Never
  silently enqueue another batch. Recheck authorization at admission and dispatch;
  status/cancel access must not leak another account's selection or metadata.
  A retry that includes a project with unresolved stop recovery returns deferred
  for that project, without replacing the retained identity.
- **No implicit compute:** unavailable storage produces an honest per-project
  outcome, not project startup. Bound retries and surface deferred work. The UI
  remains keyboard accessible, supports narrow layouts, announces status without
  disruptive focus changes, and uses the existing LRO progress presentation.

### Manual Scan Validation And Delivery

1. Audit all discovery entry points and keep only normal known-source updates
   and explicitly admitted Scan work. Test idle time, login, page/project/host
   startup, and disable/reenable cause zero unsolicited filesystem scans.
2. Implement the LRO adapter and fixed project selection using existing
   infrastructure. Verify single-flight admission races across tabs/workers,
   cross-account project conflicts, authorization changes, frequency limits,
   and selection spanning owner bays. "All" must not mean only the visible page.
3. Verify cancel-before-dispatch, cancel-during-traversal, completion/cancel
   races, unreachable host, worker restart, duplicate requests and stale worker
   publication. Do not accept cancellation merely because an RPC timed out.
4. Validate the actual browser selection/progress/cancel/reopen/retry flow,
   including keyboard/focus, disabled controls, partial results, unavailable
   storage and truncation. Assert no compute starts and no resubmission on reload.
5. Measure bounded multi-project scan cost and cancellation latency; set initial
   frequency/concurrency defaults. Keep ordinary two-person collaboration
   validation independent: create -> invite/link -> accept -> collaborate ->
   find again must work without Scan.

The manual Scan implementation now replaces new admissions through the previous
single-project control. Existing per-project receipts remain authoritative for
retained work. See the execution results for the delivered implementation,
measured fixture envelope, and validation limitations. No deployment, live Scan,
automatic goal continuation, or production enablement follows from this document.

### Explicitly Deferred

Automatic discovery of arbitrary filesystem changes; provably unchanged-volume
scan avoidance; a stronger btrfs generation proof; snapshot-delta optimization;
reflect-sync integration; automatic initial/periodic full-volume scans; seamless
migration of scan jobs; and the full 100,000-DAU capacity/24-hour-soak program are
not initial-release gates. Do not claim any of those guarantees from the smaller
release. Revisit measured capacity before substantially expanding rollout.

### Initial-Release Gates And Next Work

1. **Audit and simplify the enabled path.** Inventory feature flags and worker
   startup. Keep automatic discovery bootstrap/periodic filesystem repair off;
   ensure the selected host mode does not retain legacy periodic full traversal.
   Remove or isolate unnecessary experimental machinery rather than enable it
   because it has tests. Existing implementations are not proof of alignment.
2. **Known-source vertical path.** Validate open/write -> project catalog -> active
   home view, missed-signal recovery via opening/explicit Scan, sleep and return.
   Unknown files may remain absent. No filesystem-completeness assertion needed.
3. **Security and durable state.** Preserve recipient binding, reviewed-send
   idempotency, authorization, private state and offline notification deduplication.
   Verify revoked access and expired catalog cursors on return. Keep unsupported
   canonical-state portability guarded; disposable demand must reacquire safely.
4. **Manual Scan LRO and honest UI.** Deliver the scoped selection, single-flight,
   frequency limits, durable cancellation and progress contract above using
   existing LRO infrastructure. Validate authorization, budgets, timeout
   inspection, retry identity, unavailable storage and concurrent writes. Copy
   must distinguish scan completion from snapshot consistency and view freshness.
   Check the actual browser flow and accessibility, not only component tests.
5. **Bounded cost and rollback.** Run identical active workloads against dormant
   populations, verify no recurring per-dormant-membership work, and measure a
   representative mixed workload at the intended initial rollout size. Exercise
   disable-after-data and reenable without an automatic scan storm. Report the
   measured envelope rather than claim 10k/100k DAU capacity.
6. **Release review.** Relevant package checks, development build, independent
   review of the actual enabled paths and an explicit canary decision are still
   required. No production enablement follows automatically from this document.

Current validation is useful but does not close these gates. In particular,
timer-driven automatic discovery tests validate a now-deferred path; they are
not a reason to ship that path. Demand-return and disposable-demand rehome tests
remain relevant. See the current audit in the execution results for open work.

Not included: a full-text index of arbitrary project files, automatic content
copying, changed project permissions, implicit agent execution, or a new global
database containing everybody's files. Username session binding/throttling and
the public-identity rollout decision remain separate security-review follow-ups.

## 2. Baseline And Cost Model

**Historical extended design follows.** Sections 2-13 describe the original,
larger scope. Requirements conflicting with section 1 are deferred, not release
obligations. Technical observations and strict authority rules remain useful.

These are code observations, not production measurements:

| Existing path                                                             | Behavior to change or preserve                                                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/postgres/collaborators/collaborators-projection.ts`    | Enumerates up to 500 eligible account/project memberships per seed pass without a recent-activity filter; completed projection jobs become due after 20 seconds.                            |
| `packages/server/collaborators/maintenance.ts`                            | Claims at most eight projection pages per pass, waits 100 ms afterward, and shares the pass with invitation and notification maintenance. Independent access-renewal workers already exist. |
| `packages/database/postgres/collaborators/collaborators-access.ts`        | Renews short-lived owner-authorized access leases; preserve the fail-closed security boundary, not universal renewal.                                                                       |
| `packages/project-host/collaborators-census.ts`                           | Historical traversal of eligible existing volumes; completed runs become eligible again after one hour. No compute start is necessary.                                                      |
| `packages/backend/collaborators/service.ts`                               | Bounded journal/discovery/extraction/retry pipeline to retain and adapt.                                                                                                                    |
| `packages/server/people/invite-maintenance.ts`                            | Bounded initial invitation backfill and durable lifecycle outboxes; not activity-filtered.                                                                                                  |
| `packages/database/postgres/collaborators/collaborators-notifications.ts` | Notification consumption currently depends on account collaboration access/projection state; cannot simply stop that state and expect offline delivery to work.                             |

At five eligible projects per continuously warm account, a 20-second projection
check interval implies the following logical demand, before access renewal,
notifications, source traversal, or initial multi-page catch-up:

| Warm accounts | Memberships | Desired checks/second | Desired checks/day |
| ------------: | ----------: | --------------------: | -----------------: |
|         3,000 |      15,000 |                   750 |         64,800,000 |
|        10,000 |      50,000 |                 2,500 |        216,000,000 |
|       100,000 |     500,000 |                25,000 |      2,160,000,000 |

These are not measured RPC counts. Requests can be local or batched. One current
maintenance loop has a zero-work theoretical ceiling of 80 projection pages per
second; real throughput is lower. Multiple processes/bays can add capacity, but
cannot remove unnecessary demand. Daily active users are neither concurrent
users nor the total historical accounts currently eligible for these workers.

Benchmark 10,000 and 100,000 DAU as workload shapes, not as a database row count.
For example, one hour of relevant daily activity corresponds to about 417 and
4,167 average concurrent users, respectively; classroom peaks must be tested
separately. Do not treat this illustrative session length as measured usage.

## 3. Authority And Durability Contracts

| State                                                                         | Authority                                             | Durability/rebuild rule                                                                                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Chat/artifact source bytes                                                    | Existing project-host storage                         | No source writes during ordinary scanning; preserve existing identity migration boundaries.                                              |
| Resource identity, source fences, room lifecycle, catalog revision/tombstones | Project owning bay                                    | Preserve durable identity and deletion floors; a catalog rebuild is not permission to mint new identities or resurrect retired rooms.    |
| Filesystem discovery journal/checkpoints                                      | Current host and exact volume identity                | Checkpoints accelerate recovery; lost local state requires fenced reconciliation against owner state, not loss of canonical work.        |
| Project membership and role                                                   | Project owning bay                                    | Never inferred from a name, stale projection, filesystem generation, or demand lease.                                                    |
| Private contacts, aliases, pins, follow/mute/read state                       | Account home bay                                      | Canonical personal state; never evicted with a disposable view.                                                                          |
| Access invitation lifecycle                                                   | Existing project invitation authority                 | Keep acceptance independent of view refresh and notification delivery.                                                                   |
| Collaboration invitation and recipient delivery/read state                    | Sender/recipient home according to existing contracts | Specify a retained canonical record before expiring send-operation receipts; do not rely on a table named "index" being reconstructible. |
| Materialized discovery results                                                | Account home bay                                      | Rebuildable, authorization-filtered cache with source/version watermarks.                                                                |
| Demand and fanout interest                                                    | Account home plus routed owner subscription           | Short-lived scheduling hints, never access grants; can expire without losing user state.                                                 |

Before changing cleanup, list every table as canonical, reconstructible, or
retry/receipt state. In particular, completed invitation operations currently
have a 90-day cleanup path, whereas invitation history is retained longer.
Choose an explicit canonical collaboration-invitation record or formally retain
the existing sender-owned record as authority, then provide a rebuild path.
Do not delete either until the relationship is implemented and tested.

A restored catalog or account cache must not become authoritative for current
ownership. Use project `owning_bay_id`, account `home_bay_id`, host `bay_id`, route
epochs, existing rehome fences, and generation-conditional acknowledgments.
Launchpad is the one-bay execution of these same contracts.

## 4. Account Demand, Sleep, And Return

Add account-home demand operations with typed, bounded consumer scopes:
`acquire`, `renew`, `release`, and inspection. Names are provisional Conat API
names, not existing commands. Derive actor identity server-side.

Proposed starting policy, subject to the validation gates:

- Consumer lease: 120 seconds, renewed no more often than every 30 seconds while
  an actual visible view or explicit programmatic query session needs freshness.
- Maximum 16 live consumer registrations per account. Aggregate overlapping
  scope into one account demand set; tabs must not multiply source polling.
- Retain a five-minute warm grace period after the last live consumer expires.
  Grace is scheduler state, not an extension of authorization.
- CLI one-shot queries create bounded catch-up demand; agents cannot create
  perpetual interest without an explicitly authorized, bounded renewal scope.
- Login, an open background tab, global badge rendering, and membership alone
  do not warm every project. Hidden views stop renewing. Server expiry remains
  authoritative if a browser disappears without releasing.
- Scope can be an explicit bounded project set or the global discovery view.
  A global view with thousands of projects must catch up in fair, paged slices;
  it must not synchronously fan out to all owners.

States are `cold -> catching_up -> warm -> grace -> cold`. Expiry stops catalog
refresh, membership enumeration, owner fanout interest, and access renewals for
that view. Keep durable personal state and opaque catch-up cursors. Cached
metadata can be reclaimed after a proposed 30-day cold interval using a bounded
GC queue; never reclaim canonical identities or pending delivery obligations.

On return, use an atomic watermark/subscription handoff so a change between
snapshot and subscription is not lost. Revalidate membership before exposing
protected cached metadata. If the incremental cursor has expired, resnapshot in
bounded pages and merge personal state by stable identity. Do not manufacture
new-message events from that historical snapshot. An unavailable owner means
partial/unavailable, not authoritative empty results.

Separate metadata freshness from access validity. Existing 60-second metadata
access leases remain an upper bound, and point opens/mutations still perform
authoritative checks. A long demand lease cannot extend an access lease.
Revocation events should invalidate faster when available; missed events still
fail closed at access expiry. Sleeping views have no renewable access grant.

Schedule indexed due rows and membership-change events, not perpetual sweeps of
all accounts. Activation may enumerate that account's memberships once in
bounded pages. Periodic repair may do limited keyset sweeps, with independently
capped budgets, but must not recreate hot jobs for dormant accounts.

## 5. Project Changes And Selective Fanout

Keep extraction and canonical catalog updates project-owned. Source writes
produce durable dirty intent; update the owner catalog only when relevant
metadata/relations change. Repeated writes coalesce without losing the newest
dirty generation. Catalog mutation plus its invalidation/outbox intent commit
atomically. Preserve distinct source activity/event identities for notifications.

Active homes register bounded expiring project interests, aggregated by
destination home bay where useful. The owner emits coalesced revision hints to
interested homes; each home fetches a project delta once per compatible
generation and applies it only to its active, currently authorized consumers.
No broadcast to every past collaborator for an unchanged project. Membership
and deletion invalidations use their own revision/event path, independent of
filesystem changes.

Hints are wakeups, not durable truth. Lost/duplicate/out-of-order hints recover
through durable cursors and batched revision checks for active interest sets.
Do not create one transport subscription per account/project or send file data
through the hub. Use the existing bay routing layer and bounded metadata pages.

Global sorting/search requires a completeness contract: partial catch-up cannot
claim global top results or exact totals. Return page watermarks, coverage, and
whether ordering/search covers the requested scope. Preserve project-scoped
fallback for large accounts. Source discovery coverage, owner ingestion, home
projection coverage, and authorization availability are separate dimensions.

High fanout is real work. A classroom change can require many active view updates
or actual notifications, but not repeated source parsing per recipient. Coalesce
resource revisions, budget per project/account/bay, and retain one latest dirty
target plus bounded continuation rather than one queue row per edit per account.

## 6. Generation-Aware Discovery And Optional Snapshots

Reuse the current sandboxed census, source journals, volume lifecycle locks, and
writer epochs. Existing integration points include:

- `packages/file-server/btrfs/subvolume-snapshots.ts`: `getGeneration`.
- `packages/file-server/btrfs/subvolume.ts`: identity and field reads, including
  explicit cache bypass.
- `packages/file-server/btrfs/subvolumes.ts`: `listWithIdentity` for evaluating
  host-level batched observation instead of a subprocess per account/project.
- `packages/project-host/sqlite/project-volumes.ts`: recorded volume identity.
- `packages/project-host/reconcile.ts`: running-project generation observation.
- `packages/project-host/collaborators-census.ts` and
  `packages/backend/collaborators/census*.ts`: persisted bounded traversal.

### Checkpoint Contract

A successful checkpoint binds project, owner/host epoch, filesystem and volume
UUID, root, observed content generation, discovery policy, extractor/schema
version, completed traversal, and acknowledged owner catalog watermark. Keep
separate observed, discovered, extracted, and published watermarks. Discovering
paths is not equivalent to indexing their contents or refreshing an account.

The cheap no-change path is allowed only when the validated filesystem token
matches a completed checkpoint, policy/extractor versions match, no dirty intent
or interrupted work remains, and the catalog still has the matching committed
state. Do not use time, directory mtime, cached command output, or a bare
subvolume number as proof of unchanged content. Do not compare generation
numbers across restored/replaced volumes as if they were one monotone timeline.

Prototype the exact btrfs visibility contract on the supported kernel/filesystem
configuration: in-flight writes, transaction commits, cached observations, and
before/after sampling. Equal samples must not be assumed sufficient if writes
within that observation window are not distinguishable. Use a validated commit
barrier or stable-read mechanism where needed, and measure its cost; never put a
filesystem-wide expensive sync in every account request. If proof is unavailable,
report uncertainty and reconcile conservatively. Pending dirty intent wins over
an equal filesystem token. A busy live volume need not become globally quiescent
to publish valid per-source results, but cannot receive a false all-current stamp.

### Scheduling Policy

- First use/new source/changed volume: enqueue bounded discovery, not a scan in
  the browser request. Do not automatically backfill every historical volume on
  rollout; operator backfill is a separately budgeted job.
- Normal writes: reconcile the known dirty source/path and affected parent
  directory. Watchers and mediated write hooks are hints; persist accepted
  intent before acknowledging it as recoverable.
- Warm projects: share host-level generation observations with existing work
  where valid. Start by testing a 60-second fallback observation interval when
  low-latency write signals are healthy; explicit Scan does not wait for it.
- Cold projects: remove hot watchers and periodic directory traversal. Reuse
  existing host inventory observations; otherwise schedule jittered generation
  checks with increasing backoff up to 24 hours as an initial policy. These
  bounded checks are per volume, never per historical collaborator.
- Archived/unavailable volumes: record deferred status and wake on placement,
  restore, or explicit demand. Never restore storage or start compute implicitly.
- Generation changed, path unknown: try a validated snapshot delta, else use the
  existing bounded census. Hash/parse only relevant candidate sources; unrelated
  build/log churn must not repeatedly trigger immediate full-tree walks. Backoff,
  coalesce, and expose coverage when a fallback must eventually traverse them.

### Snapshot Assistance

Use already available snapshots only as an accelerator. Snapshot creation is
throttled under load, so correctness and eventual catch-up cannot require a new
snapshot or a fixed snapshot cadence. Do not force snapshot creation from Scan.

Persist the exact snapshot identity/baseline if a validated delta implementation
can enumerate candidate creates, changes, renames, and deletions. A delta between
two snapshots proves nothing about later live writes. Reconcile the live tail
using dirty intent/generation checks and fall back when completeness is unknown.
Snapshot deltas identify candidates; existing source validation still decides
catalog changes and identity handling. A delete tombstone requires complete
evidence for its scope, not omission from a partial delta.

Borrow snapshot read leases only through existing retention/lifecycle controls,
with explicit byte/time limits. If a baseline is pruned, a snapshot disappears,
or a delta is unsupported/over budget, retain progress and use bounded traversal.
Do not pin snapshots indefinitely for dormant accounts. Benchmark delta cost
against traversal; do not assume snapshots provide a free file-change feed.

## 7. Explicit Scan RPC

Provisional shared Conat contract (not an installed API):

```typescript
requestScan({
  project_id,
  request_id, // stable idempotency UUID
  mode: "check" | "reconcile",
  source_id?, // optional existing typed source, not an arbitrary host path
}): {
  job_id,
  admission: "accepted" | "coalesced" | "throttled" | "unavailable",
  state,
  retry_after_ms?,
  observed_watermark?,
}
getScanStatus({ project_id, job_id }): ScanStatus
```

`check` performs a fresh validation and may finish unchanged. `reconcile` requests
a bounded inspection even if generation matches, for repair/debugging. Neither
bypasses quotas or authorization. "Immediate" means immediate admission and
priority over background census, not synchronous completion or unlimited I/O.

- Route account request to project owner, then the currently authorized host.
  Recheck access on admission, execution, and status reads. Preserve current
  collaborator-versus-viewer boundaries. No arbitrary traversal roots, shell
  commands, ignored-path overrides, mount crossings, or trusted operator flags.
- Humans use existing authenticated project authorization. Agents require a
  specifically reviewed project-scoped scan capability under their execution
  principal or connector grant; an agent mention or network membership is not
  permission. Do not broaden human-only APIs to enable this accidentally.
- Deduplicate atomically by principal/project/request ID and canonical arguments.
  Reuse with different arguments fails. Same-scope requests from different users
  coalesce into one job without exposing other requesters' identities.
- Maintain at most one executing scan plus one coalesced follow-up watermark per
  project. A request after the running job's captured boundary attaches to work
  covering that newer boundary; it must not receive a stale completion receipt.
- Initial limits to validate: burst two checks then one token/minute per actor
  and per project; full reconciliation at most once per project per five minutes.
  Also enforce host/bay/global admission, queue age/size, directory-entry/byte/time
  budgets, and fairness. Idempotent retries do not consume new scan tokens.
- Return structured throttling with retry timing. A timeout is unknown admission;
  inspect/retry the same identity, never create a new job automatically. Keep
  seven-day admission receipts initially and document expiry behavior; inspect
  status after expiry must not silently launch work.
- Status reads never schedule work. Poll adaptively or use an existing bounded
  change channel. Revoked callers cannot continue inspecting protected paths or
  progress. Rate-limit status polling separately.
- States distinguish queued, running, unchanged, partial, completed, deferred,
  failed, and disabled. Include counters, safe reason codes, captured boundary,
  owner ingestion watermark, and whether the requesting view has caught up.
  Do not report a fabricated percentage when total work is unknown.
- Scanning never sends invitations, runs agents/notebooks, creates rooms, starts
  compute, provisions absent storage, or changes membership. Existing legacy
  identity migration remains a separate explicitly controlled write boundary.

Add CLI and UI wrappers only after this service exists. Keyboard-operable Scan
controls show cooldown, durable job progress, and partial/deferred explanations;
follow the accessibility guide. Project-owned jobs are shared, so one user's
dismissal must not cancel another user's necessary work.

## 8. Reflect-Sync Evaluation

Inspected upstream `master`, resolving to
`4c1cf78ee362c0776fa6b8a005562e30a57fc2dd` on 2026-09-29.
This is a reuse assessment, not a claim that the library has been integrated or
audited for CoCalc's host boundary.

[`hotwatch.ts`](https://github.com/sagemathinc/reflect-sync/blob/4c1cf78ee362c0776fa6b8a005562e30a57fc2dd/src/hotwatch.ts)
provides bounded hot-directory watchers with TTL/LRU management, depth limits,
and a minimal-cover helper for overlapping paths. Evaluate these ideas for hot
projects; persist dirty intent outside watcher memory and turn watcher errors or
overflow into explicit reconciliation demand.

[`scan.ts`](https://github.com/sagemathinc/reflect-sync/blob/4c1cf78ee362c0776fa6b8a005562e30a57fc2dd/src/scan.ts)
supports restricted path scans, SQLite metadata, and emitted deltas. Evaluate a
narrow adapter or extraction of path-coalescing/restricted-scan logic, including
its tests. Do not assume its filesystem access or metadata heuristics satisfy
CoCalc's sandbox and generation-proof requirements.

The [upstream design](https://github.com/sagemathinc/reflect-sync/blob/4c1cf78ee362c0776fa6b8a005562e30a57fc2dd/DESIGN.md)
is useful background for combining observation and reconciliation. Keep
CoCalc's existing durable journals and owner/home protocols as the integration
boundary. Do not import two-way merge, rsync/SSH transport, sync-side identity,
or file-copy behavior into a metadata indexer.

The evaluation deliverable is a short keep/extract/depend decision with pinned
version, license/attribution review, dependency/runtime cost, sandbox adaptation,
and measured benefit. Prefer no new dependency unless the narrow prototype
demonstrates value over extending the existing census/journal.

## 9. Offline Events, Retention, And Portability

Before enabling account sleep, decouple real notification obligations from view
refresh. Append durable owner-side event intent with the source event, expand
actual authorized recipients in bounded pages using indexed membership/follow
state, and route to recipient homes. Direct mentions, follow/mute preferences,
membership cutovers, and provider idempotency retain existing semantics. Check
current authority before protected delivery; no disclosure from a stale view.

Queue work for real events, not a timer for every recipient/project. Coalesce
where semantics allow; do not drop distinct user-visible obligations as though
they were catalog invalidations. Bound pending retries, expose unresolved
outcomes, and provide an operator repair/dead-letter path without automatic
duplicate SMTP delivery. Do not change email frequency/digests in this project.

The existing source notification log has a 30-day pruning path. An account absent
longer than that must still receive durable obligations already committed for
it, while a discovery rebuild must not replay old events as new. Retention may
compact source history only after the chosen durable handoff rule; test dormant
recipients and unreachable home bays explicitly.

Lifecycle work needs three independently tracked horizons: transient deltas and
scan receipts, reconstructible account caches, and canonical invitations/private
state. Archive is not delete. Establish finite terminal-history policy and
deletion tombstones without erasing pending acceptance or idempotency evidence.
Test encryption-key rotation/recovery for private contact records, including
their keyed identity lookup, before claiming portable archival state.

Account rehome transfers canonical personal/delivery/catch-up state but does not
transfer an active access grant. Project rehome transfers identity/catalog/event
and scan-receipt state with new host/route fences. Local directory cursors may
restart safely. Existing People state currently blocks rehome; retain that guard
until every affected family has tested transfer/rollback/delete semantics.
Disabling People is not a way to bypass portability guards.

## 10. Isolation, Budgets, And Observability

Separate worker pools and queues for interactive point work/catch-up, actual
notification/invitation delivery, incremental extraction, and historical repair.
Use weighted fairness and reserved capacity, not strict priority that can starve
repair forever. No unbounded promise queues or global synchronous account fanout.
Retry with backoff/jitter and acknowledge only the claimed version/epoch.

Track rates and histograms, with bounded-cardinality dimensions:

- Active consumer/account/project interests; expirations and cold cache size.
- SQL calls, rows read/written, WAL bytes, RPC bytes, and transaction/lock latency.
- Logical changes versus deduplicated work versus actual recipient fanout.
- Generation observations, unchanged skips, directory entries, source bytes,
  snapshot-delta hits/fallbacks, watcher count/overflow, and extractor CPU.
- Queue depth and oldest age by class; retries, admission rejection, and per-job
  checkpoints. Log IDs/reason codes, not private source bodies or contact emails.
- Source-to-catalog, catalog-to-active-view, and notification latency separately.
- Unavailable/partial coverage, access-lease expirations, and repair completion.

Provide operator inspection for a specific authorized project/account: why work
is queued, what boundary is complete, what prevents catch-up, and how to request
bounded repair. A permanent generic "synchronizing" banner is not observability.

## 11. Validation Matrix And Initial Targets

All targets below are proposed acceptance budgets, not measured achievements.
Record exact hardware, storage, kernel/btrfs configuration, bay topology, build
SHA, dataset seed, concurrency, and workload rates. PGlite is useful for contracts;
use real PostgreSQL for query plans/locking/WAL and real btrfs for generation and
snapshot guarantees. Do not test on customer accounts or production volumes.

| Scenario                   | Required evidence                                                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle population            | Compare identical active workloads with 0, 100,000, and 1,000,000 additional dormant accounts. After initialization/GC, no per-dormant-account refresh RPCs or lease writes. Hot-worker operation counts change by no more than 5%; explain index-size effects separately. |
| Cold unchanged filesystems | Repeated due checks cause zero directory enumeration, source parsing, or source-file reads after a complete checkpoint. Measure the separate bounded cost of generation observation.                                                                                       |
| Relevant/unrelated writes  | Mediated edits, terminal writes, atomic replacements, mass build/log churn, deletion, rename, and watcher loss converge; unchanged relevant sources are not repeatedly parsed.                                                                                             |
| Generation correctness     | Writes within/across transactions, cache staleness, scan-time mutation, crash before/after checkpoint, restore/clone, new volume with repeated generation, and policy changes never produce a false complete checkpoint.                                                   |
| Optional snapshots         | Throttle all snapshot creation, prune the baseline, remove snapshots mid-job, and write after the latest snapshot. Normal dirty-source indexing continues; reconciliation succeeds by fallback or reports honest partial coverage.                                         |
| Demand lifecycle           | Multiple tabs/clients coalesce; hidden tabs, crashes, logout, and lost renewals expire demand. Grace never extends authorization. No global membership reseeding wakes sleepers.                                                                                           |
| Six-month return           | Expired delta cursor triggers bounded resnapshot, preserves pins/aliases/read state, checks revoked membership, and creates no historical notification storm.                                                                                                              |
| Offline recipient          | Deliver genuine invitation/mention while discovery is asleep, including absence beyond notification-log retention; no whole-account warming.                                                                                                                               |
| Scan admission             | Concurrent humans/agents, forged scope, expired grant, repeated IDs, changed arguments, new writes during coalescing, and status-poll floods respect shared budgets and exact outcome inspection.                                                                          |
| Rehome/deletion/outage     | Owner/home/host split, route changes, stale ACKs, unreachable bay, account/project deletion, and restore preserve fences and canonical data; no stale cache grants access.                                                                                                 |
| Failure and overload       | Slow filesystem/DB/provider, worker death, full quotas, and retry storms preserve durable state and fairness. A blocked scan cannot block invitation delivery.                                                                                                             |
| Feature flag               | Disable before use and after data exists: no new scans/demand admitted, workers checkpoint safely, existing hooks obey documented off behavior. Reenable gradually without duplicate notifications or a full-population stampede.                                          |

Load fixtures must include 10,000 and 100,000 DAU-shaped session traces, 10x
concurrency bursts, high churn, five-project typical users, and heavy-tail users
with 1,000 projects/100,000 projected resources. Include 150-student class bursts,
a 10,000-member shared project, many mostly empty private projects, and a few
large source trees. Parameterize edit/invite rates and source sizes; report a
capacity curve rather than one favorable point. Include enrollment bursts and
high event fanout, not just read-only browsing.

Initial healthy-load objectives for admitted, within-quota work:

- Metadata list/search first-page server latency: p95 <= 500 ms, p99 <= 2 s.
- Durable relevant source change to visible warm view: p95 <= 5 s, p99 <= 30 s.
- Scan admission/status response: p95 <= 500 ms; actual completion is a separate
  size-dependent measurement, with queue/deferred status visible immediately.
- Warm demand stops within five-minute grace plus one bounded scheduler pass
  after its final lease expires; expired authorization never waits for that pass.
- Real-event notification latency is no worse than the measured existing path;
  cold-account projection suspension must not introduce a new delay dependency.
- Returning typical account first authorized results: p95 <= 2 s from retained
  catalog data. Full discovery of unknown/unavailable storage has no fabricated
  two-second promise; measure catch-up by dataset size and show partial coverage.

Run at least a 24-hour mixed workload soak and a simulated six-month churn and
retention cycle. Report CPU/RAM/I/O and recurring work per active account, per
changed project, per delivered event, and marginal dormant account; also report
storage growth. Derive host/bay counts from measured saturation with headroom.
Do not extrapolate 100,000-DAU support from a fast unit test or merely raising caps.

## 12. Implementation Sequence And Gates

1. **Baseline and contracts.** Instrument current workers in an isolated fixture;
   record cost/freshness curves, table authority/retention inventory, and the
   generation/Scan/demand contracts. Review ownership/security boundaries before
   new mutation APIs. Gate: reproducible baseline and explicit unresolved risks.
2. **Filesystem proof and reuse spike.** Validate btrfs no-change detection and
   checkpoint crash behavior; test snapshots absent; evaluate narrow reflect-sync
   reuse. Gate: no false completeness and measured cold-scan avoidance. No broad
   worker replacement or new required dependency yet.
3. **Vertical prototype.** One project, two homes, two accounts: source change ->
   owner catalog -> active view -> sleep -> offline mention/invitation -> return.
   Include Scan, revocation, lost hints, expired history, and no snapshots. Gate:
   all contracts work together, not just isolated happy-path modules.
4. **Demand and event decoupling.** Implement expiring demand, indexed scheduling,
   project revision interests, batched delta fetch, and offline notification
   handoff. Remove universal renewal only after offline delivery passes. Gate:
   dormant population no longer creates recurring per-membership work.
5. **Bounded scanning service.** Integrate generation-aware host checks, dirty
   paths, opportunistic snapshot deltas, fallback census, RPC/CLI/UI admission,
   and structured progress. Gate: abuse/failure tests and accessible controls.
6. **Recovery and lifecycle.** Implement canonical rebuild, expired-cursor repair,
   retention/deletion, and People state portability. Gate: rehome/restore tests
   allow removing guards only for the actually supported state families.
7. **Scale and canary.** Run the full matrix/soak, independent review, package
   checks, full development build, and authenticated two-account browser tests.
   Gate: measured capacity report, rollback exercise, and explicit enablement
   decision. No agent delegation beyond the reviewed Scan scope is implied.

## 13. Migration And Rollback

Use additive schema and versioned checkpoints. Shadow-compute candidate catalog
results on a small operator-selected fixture first, without delivering duplicate
events or warming dormant accounts. Compare stable identities, revisions,
coverage, deletions, and notification decisions against the existing pipeline.

Cut over one accountable work family at a time under durable worker epochs so
old/new workers cannot both deliver. Initialize demand only for real consumers;
rate-limit existing backlog adoption. Preserve personal state and source/receipt
floors. Mixed-version components must reject unsupported protocol versions or
use a documented safe path, never reinterpret checkpoints as current authority.

Rollback disables new admissions, checkpoints/cancels bounded work safely, and
keeps canonical records and retry evidence. Do not blindly restore eager global
refresh if its load caused the rollback. Reads can expose explicit unavailable
or partial state while recovery proceeds; permission and acceptance correctness
take precedence over a cosmetically complete directory.

Document which maintenance remains while the UI flag is off: schema and existing
invitation capture triggers are not removed by hiding People. Required deletion,
retention, and pending-delivery handling need a deliberate policy and independent
bounded service, not accidental dependence on a page being enabled. Public
usernames/personal URLs are not currently covered by this flag and need their
own explicit rollout/security decision.

The initial deliverable is a reviewed design plus measured vertical prototype,
not a claim to have solved global indexing. Proceed to broad implementation only
when the prototype shows that cold users are cheap, active views are useful,
and missed signals remain recoverable without weakening authorization.
