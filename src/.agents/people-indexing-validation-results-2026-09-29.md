# People Indexing: Initial Execution Results

Date: 2026-09-29. This is an initial gate report, not a completed scaling rollout.

## Current Completion Audit

The user approved the smaller initial-release contract in section 1 of the
[design plan](people-indexing-design-validation-2026-09-29.md). It supersedes the
original broad gates; this is a scope decision, not evidence of completion.

The next step is an enabled-path audit and simplification, not additional
automatic filesystem-discovery machinery. Automatic discovery bootstrap and
periodic full-volume repair are deferred. Demand-driven catch-up of known
catalog resources, explicit best-effort Scan, strict authorization, and durable
personal/invitation/notification state remain in scope.

| Initial-release gate        | Current evidence and outstanding work                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enabled-path simplification | Host startup now defaults to known-source/explicit census mode, with focused and multibay coverage. Home-worker flag selection and full idle/rollback behavior still need auditing. Do not enable automatic bootstrap/repair.            |
| Known-source vertical path  | Source/projection tests exist; validate the selected known-source-only configuration end to end, including explicit recovery of missed writes.                                                                                           |
| Security and durable state  | Retention return and disposable-demand account-rehome acceptance pass. Preserve existing authority and canonical-state portability guards; review the actual release diff.                                                               |
| Explicit Scan and UI        | Admission, dispatch and component tests exist. Best-effort completion wording is tested in the accessible status region. Real browser flow and disabled/unavailable cases need final validation. Agent Scan remains denied and deferred. |
| Bounded cost and rollback   | One-project activation has identical measured logical work at 0/100k/1m dormant memberships. Representative mixed load, full enabled-path idle behavior and disable/reenable validation remain open. No DAU capacity claim.              |
| Release review              | Full development build passes at 408f6c2b0f. Independent review of selected paths and an explicit canary decision remain required. No rollout is authorized by the plan revision.                                                        |

The following extended-scope audit and chronological results are historical
evidence, not instructions to continue implementing deferred work. The failed
btrfs marker proof remains a reason not to use that shortcut; obtaining a better
marker is no longer a release prerequisite. No existing code or guard was
removed merely by changing this document.

## Historical Extended-Scope Audit

Before the user-approved scope reduction, the seven implementation gates were:

| Plan gate               | Evidence and remaining work                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline/contracts      | Isolated baseline, metrics and authority work exist. Full workload cost/freshness curves remain unproven.                                                                                                                                       |
| Filesystem proof/reuse  | The raw btrfs generation proof failed. No safe generation-equality shortcut is enabled; validated cold-scan avoidance remains unresolved.                                                                                                       |
| Vertical prototype      | Timer-driven initial discovery and later active-demand repair pass isolated multibay acceptance, including 1,000 cold memberships and no compute starts. The complete sleep/offline-event/return matrix and failure cases remain open.          |
| Demand/event decoupling | Demand scheduling, durable revision delivery and shared page fetching have prototype coverage; this is not a production capacity result. Live demand is capped at 16 separately from a 256-record retained-grace churn bound.                   |
| Bounded Scan service    | Human admission/routing, status budgets, durable host dispatch, CLI and accessible component-level UI controls are implemented and tested. Agent scope, complete progress/watermarks, cold-volume repair and whole-system capacity remain open. |
| Recovery/lifecycle      | Rehome guards remain necessary. Full canonical rebuild, transfer/rollback, restore and retention/deletion coverage are not proven.                                                                                                              |
| Scale/canary            | Query fixtures are not DAU traces. The 10k/100k workloads, burst/fanout matrix, 24-hour soak, six-month churn simulation, browser matrix and explicit enablement decision remain outstanding.                                                   |

The remaining frontier includes generation-aware/cold-volume reconciliation,
full lifecycle recovery, reviewed agent scope, live browser validation, and
workload/soak measurements. Keep default-off behavior and portability guards
until the corresponding gates actually pass. The chronological sections below
retain earlier limitations as historical observations; later sections may
supersede them, but do not imply that a whole gate is complete.

## Implemented

- Added Prometheus counters for memberships enumerated, projection claims,
  access claims, and access-batch attempts in the existing maintenance workers.
- Added projection outcome counts, serialized page bytes, and fetch/apply latency.
  Labels contain only fixed work/outcome categories, not account IDs, project
  IDs, paths, or error text. These are logical work counts, not network RPC or
  SQL statement counts. An empty result can still contain control metadata.
- Added a reproducible PostgreSQL characterization fixture using the existing
  isolated owner/two-home/host harness. It does not connect to the live database.
- Added an opt-in real-btrfs probe with a small read-only ioctl helper. It creates
  and removes only its own temporary fixture; it never freezes a volume, changes
  mount flags, forces a filesystem-wide sync, or creates/deletes snapshots.

Production scheduling, access leases, and scan policy are unchanged. Notification
delivery now supports owner-supplied attention without a resource projection, as
described below. No demand or Scan mutation API has been enabled.

## Measured Results

The initial PostgreSQL fixture passed: 1,000 synthetic dormant memberships plus
one harness account were enumerated as 1,001 rows on each of two complete seed
rounds. All 1,001 acquired scheduling records without a user opening People.
This demonstrates the recurring enumeration problem; it is not a capacity test
or a measurement of daily active users. The initial test took 48.8 seconds,
including isolated PostgreSQL and four-process startup/cleanup, so that duration
must not be interpreted as seed-query latency.

The expanded baseline suite also passed (two tests): forcing the next due pass
for an unchanged view caused another actual owner `projectPage` call, and the
worker's empty-page metrics reflected both passes. The harness advances due
timestamps for determinism; this does not measure real-time refresh frequency.

The btrfs probe observed generation `1300140` before and after each of:

1. Creating a file, writing bytes, and fsyncing the file.
2. Overwriting bytes and fsyncing the file.
3. Truncating the file and fsyncing the file.
4. Renaming the file.
5. Unlinking the file.

The volume identity remained the same. This is a counterexample to treating
equality of live `BTRFS_IOC_GET_SUBVOL_INFO` generations as proof of unchanged
source bytes. It does not disprove a stronger storage-layer marker sampled under
appropriate barriers, nor compare immutable snapshots. A run in which the
generation changes would also not establish safety: this probe reports such a
result as inconclusive, not a passed no-change contract.

## Gate Decision

Do not enable a raw-generation scan shortcut. Identify and validate the stronger
storage-layer observation contract first, or use conservative dirty/census
reconciliation without advertising provable unchanged coverage. In particular,
do not record a live traversal as a stable snapshot merely because its starting
and ending generation samples match.

No stronger marker has been identified. Continue the demand/offline-delivery
prototype with conservative census as its discovery adapter; the failed proof
blocks the generation shortcut, not that independent work. A future marker must
pass the same adversarial write cases before replacing this adapter.

Do not stop dormant-account projection/access work yet. Offline notification
consumption still depends on that state. The next integrated prototype must
demonstrate independent offline delivery before changing this policy.

Gate 1 is partially implemented, not closed: full table-by-table retention
inventory, query/WAL instrumentation, and load/freshness curves remain. Gate 2
has identified a failed candidate proof. Gates 3-7 remain open: integrated
demand/offline delivery prototype, bounded Scan RPC/CLI/UI, recovery/rehome,
100,000-DAU load testing, and the 24-hour soak remain outstanding. No capacity or
merge-readiness claim follows from these small tests.

## Reproduction

From `src/packages/server`, with workspace outputs built:

```sh
pnpm exec tsc --build
COCALC_COLLABORATORS_ACCEPTANCE=1 pnpm exec jest --runInBand --runTestsByPath collaborators/indexing-baseline.acceptance.test.ts
COCALC_BTRFS_PROBE_ROOT=/path/on/btrfs pnpm exec jest --runInBand --runTestsByPath collaborators/btrfs-generation.acceptance.test.ts
```

The PostgreSQL fixture requires PostgreSQL binaries available through `pg_config`.
The btrfs fixture requires a C compiler and Linux btrfs headers. It fails rather
than silently passing on an unsupported filesystem or denied ioctl. Its
structured stdout contains observations and an explicit conclusion. Neither
fixture runs without its explicit opt-in environment variable.

Validation for this change-set: server `tsc --build` passed; two new PostgreSQL
baseline tests passed; the btrfs observation test passed and reported an unsafe
generation-equality candidate; all six existing multibay/historical acceptance
tests passed. Formatting and `git diff --check` passed. No full development build,
browser test, large-scale load test, or soak was run.

## Demand Store Preparation

Added `packages/database/postgres/collaborators/collaborators-demand.ts` as an
explicitly installed prototype store. It is not registered in production schema
startup, exposed as a public RPC, or consumed by maintenance yet. It does not
change notification delivery or grant access to any project.

The store uses the account-home/rehome transaction fence, samples database wall
time after acquiring the lock, and supports canonical project scopes (up to 100
IDs per consumer) or global interest. Leases last 120 seconds, with renewal no
more frequently than 30 seconds and five minutes of grace. Acquisition retries
do not extend active leases; expired/released leases cannot renew. New lease
tokens fence delayed releases of previous registrations. Inspection reports
active/grace/cold scheduling interest, not whether content is caught up or
authorized. The integrated scheduler must distinguish catching-up from warm.

The initial prototype conservatively capped live **plus retained grace registrations** at
16 per account, bounding rapid acquire/release churn as well as live tabs. A
client can reuse a consumer registration after release. This is stricter than
the plan's live-consumer-only ceiling; reassess during UI integration rather
than silently allowing unbounded grace rows. An expiry index supports bounded
500-row cleanup without enumerating historical accounts. This initial combined
cap is superseded by the separate live/retained bounds described below.

Five real-PostgreSQL acceptance tests pass: idempotent acquisition/throttled
renewal, release/expiry/stale-token behavior, concurrent admission bounds,
wrong-home/banned-account rejection, and scope aggregation/account isolation.
Database and server typechecks pass. Reproduce with:

```sh
COCALC_COLLABORATORS_ACCEPTANCE=1 pnpm exec jest --runInBand --runTestsByPath collaborators/demand.acceptance.test.ts
```

The integrated gate remains open. Next: establish durable offline event delivery
without projection leases, then wire authenticated demand admission and indexed
scheduling into the two-home prototype. No scale/rollout gate has been passed.

## Notification Resource-Projection Independence

Owner-routed notification pages now include bounded recipient-specific attention
facts: membership epoch, history floor, full participation result, and legacy
follow/mute defaults. The home receiver validates the membership epoch and uses
these facts instead of requiring the conversation resource index to be current.
Explicit personal follow/mute choices remain authoritative. Older owner replies
without these facts retain the existing projection-based path.

This does **not** bypass authorization: the home access row is still locked and
its captured request ID, granted generation, and database-time expiry are still
checked. The owner still checks current ownership, room, actor, recipient, and
membership history. There is no new public notification endpoint. Deleted
catalog conversations are skipped rather than exposed through retained events.

An isolated real-PostgreSQL two-home test creates a followed conversation, deletes
the recipient's resource index, sends a live reply, and runs notification work
without projection maintenance. It receives exactly one notification, leaves the
resource index empty, preserves the follow preference, and creates no duplicate
on retry. All six existing multibay/historical acceptance tests also pass.
Focused database, server, and util suites pass (25, 37, and 20 tests respectively).

Remaining dependency: access rows/leases and recurring cursor polling. The next
step is a durable owner event-to-recipient work handoff with event-triggered
authorization, not suspending access renewal prematurely. The new acceptance
test proves independence from the resource index only; it does not prove cold
accounts incur zero recurring work or that offline obligations survive retention.

## Durable Owner Fanout Prototype

Live event ingestion can now capture fanout intent in the same transaction as
the event, under `COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE=1` (default off).
Owner-side expansion uses bounded keyset pages, stable recipient obligation IDs,
and membership epochs/history floors. It excludes the actor and later joiners.
A per-project pending-obligation cap defers expansion without advancing its
cursor. This prototype expands eligible project members; selective follower
fanout and its scaling costs remain to be addressed.

Retention holds the contiguous event-log prefix at the earliest unexpanded event
or pending recipient obligation. Rehome serialization includes expansion state
and recipient obligations. The new queue is not yet drained by an authenticated
recipient-home delivery/acknowledgment service, and capture must remain opt-in
until that service and its failure behavior are validated.

Two isolated real-PostgreSQL acceptance tests pass: live ingestion captures one
obligation without recipient projection work, retries deduplicate, wrong-owner
expansion fails, and aged pending events cannot be pruned. A synthetic paging
seam checks multi-page expansion and excludes a post-event joiner. The retention
test deletes an obligation directly in its fixture to simulate handoff; this is
not proof of a production acknowledgment path.

Validation: server TypeScript build, 25 database notification tests, 7 ownership
manifest tests, 8 populated rehome transfer tests, and 20 rehome preflight/legacy
tests pass. The five-test multibay suite initially had a post-rehome convergence
failure, then passed on rerun. Its cause is not established; bounded fixture
diagnostics were added to capture access/index state if it recurs.

The ownership inventory now also classifies ten existing runtime People tables.
Canonical private state and delivery/idempotency obligations remain explicitly
unsupported for rehome until a tested handoff exists; existing guards remain.

Next: authenticated routed recipient delivery and durable acknowledgment,
event-triggered authorization independent of projection leases, demand/scheduler
integration, and disabled/mixed-version recovery. Scan, filesystem reconciliation,
scale/soak validation, and the overall rollout gates remain incomplete.

## Owner Delivery Claims

The prototype now supports service-internal claim and settlement transactions.
Claims contain at most 25 obligations, use a 60-second database-clock lease
obtained after ownership/rehome locking, and preserve stable event/recipient
identity across retries. Claiming moves the due time to lease expiry so indexed
selection does not repeatedly visit in-flight work. Source facts are fetched in
one bounded batch rather than one query per recipient.

Acknowledgment deletes only a matching, unexpired claim; retry releases it with
a five-second delay. Expired, superseded, and repeated acknowledgments cannot
delete another worker's obligation. Both operations resolve the local project
ownership row under the existing rehome fence. No public RPC exposes these
functions, and a claim is not a grant of recipient access.

This is the owner-side work protocol, not yet an end-to-end delivery protocol.
The authenticated home receiver, current event-specific authorization, durable
home acceptance, and routing remain to be integrated before enabling capture or
suspending cold-account access renewal. Fixture acknowledgments do not prove
actual recipient delivery.

Validation: server TypeScript build and seven ownership tests pass. All three
real-PostgreSQL fanout tests pass, including concurrent bounded claims, expired
and superseded tokens, retry delay, wrong-owner rejection, and a running-rehome
fence on both claim and acknowledgment. No end-to-end routing or scale gate is
claimed by these tests.

## Exact-Obligation Owner Authorization

An internal inter-bay method now resolves a single retained obligation at the
current project owner rather than advancing a recipient view cursor. It binds
the obligation ID to project, account, and membership epoch; checks current
recipient/actor membership, the join cutover, room identity, and a live canonical
conversation; and returns persisted source intent with current attention facts.
Missing source data for a pending obligation throws for retry rather than being
treated as successful delivery. The service checks the feature flag and current
directory route before the database ownership/rehome fence. No public account or
project-host method exposes it.

The isolated two-home PostgreSQL test calls this method over the inter-bay
fabric from the recipient home while its access and resource indexes are empty.
It checks exact event identity, mismatched recipient/epoch/ID rejection, and
removal followed by rejoin without reviving old-epoch work. All three fanout
acceptance tests, 29 API tests (including disabled-feature rejection), and the
server TypeScript build pass.

This supplies owner authorization, not a replacement home authorization lock.
Next is the recipient-home transaction that reconciles this result with current
invalidation and personal attention state, commits the existing notification
graph idempotently, and only then permits owner acknowledgment. Capture remains
default-off; no cold-account or overall scale gate is complete.

## Event-Triggered Home Delivery

The internal receiver now resolves the recipient's home, captures a one-shot
home fence, and fetches exact retained intent from the current owner. It checks
the request token, captured generation state, and a database-clock 60-second
deadline after taking the access-row lock. The shared personal-attention and
notification-graph transaction then handles follow/mute policy and stable-event
deduplication. The existing projection/lease delivery path remains unchanged.

For a cold recipient this creates only an unscheduled fence row: no access
generation or lease is granted, and both view and renewal due times are infinity.
Missing home membership is retried, not mistaken for a definitive owner
revocation. The base account-project membership projection is still required;
the People conversation index is not. This is not yet a general elimination of
historical-account maintenance.

A bounded per-project worker claims up to 25 obligations, routes to their homes,
and settles only returned terminal receipts. Exceptions and unknown replies
retain obligations with retry delay; stable graph identity prevents duplicate
notifications after a lost reply. The worker is callable internally but is not
yet wired into the production demand/owner scheduler. Prototype capture remains
default-off pending that integration and broader failure/scale validation.

Validation: TypeScript build, 28 database notification tests, and 52 server
API/notification tests pass. Four isolated PostgreSQL acceptance tests pass.
The live fanout test creates exactly one notification without warming the
recipient view, retries as a duplicate, loses a reply after commit while keeping
the obligation, then processes definitive removal/rejoin revocation through the
real receiver and token-checked settlement. Pending-event retention releases
only after that settlement. The original projection-independent path also passes.
Additional rehome and concurrent invalidation end-to-end cases remain necessary;
unit tests reject expired, superseded-token, and changed-generation responses
before any personal-state write.

## Opt-In Owner Notification Scheduler

Live ingestion now marks a project-owned notification due time in its event
transaction. An indexed due-project query selects at most eight projects, skips
known frozen rehomes, and claims each under the project ownership fence. Each
pass expands one bounded recipient page and delivers at most four recipients
concurrently. All attempts are awaited; settlement failure retains work. The
project claim retries after 60 seconds, and successful completion recomputes its
next due time from pending expansion/recipient obligations or clears the marker.
No account or membership population is enumerated to find due delivery work.

The maintenance service has a separate one-second fanout timer, gated by both
`collaborators_enabled` and the prototype environment switch. It does not wait
for the discovery maintenance loop. Scheduler fields are included in project
rehome serialization. The new queue remains opt-in, and existing recurring
discovery/access workers are not yet replaced by demand scheduling.

The controlled real-PostgreSQL maintenance-pass test follows a live source write
through scheduling, expansion, home delivery and acknowledgment, leaving the
recipient resource index empty and the finished project marker null. Populated
rehome transfer coverage preserves the due time and claim. This is not a scale,
timer-load, or broad disabled-after-data validation gate. Older prototype data
without project due markers still needs an explicit bounded repair/migration
path before any mixed-version enablement.

Validation: server TypeScript build, 37 API/rehome tests, and four real-PostgreSQL
scheduler/fanout acceptance tests pass. The scheduler test also passes with an
explicit disable after ingestion and reenable before delivery, preserving queued
work. The completed project returns no job on another maintenance pass. These
tests do not establish fairness or throughput under the planned load matrix.

## Authenticated Demand Admission

Shared types and account-authenticated acquire/renew/release/inspect methods now
route demand to the current account home. Both public admission and internal
home methods require the People flag and `COCALC_PEOPLE_DEMAND_PROTOTYPE=1`.
Maintenance startup installs the prototype store only when opted in. The
transport binds the caller's account ID and rejects anonymous, project, host,
and agent principals; scoped programmatic agent admission remains a separate
unfinished requirement, not implicit authority granted by this API.

Demand still registers interest only. It does not create access rows, enumerate
memberships, or grant metadata access. Standalone Lite reports the operation as
unsupported. The ownership manifest classifies leases as rebuildable ephemeral
account-home scheduling state; clients reacquire at the current home rather
than treating old-home leases as durable user state.

Validation: server and Lite TypeScript builds, seven transport-policy tests,
30 server API tests, seven ownership tests, and six isolated PostgreSQL demand
tests pass. The authenticated path ignores forged account IDs and prevents a
second account from releasing the first account's lease. Store coverage retains
quota, renewal, expiry, grace, wrong-home, and banned-account cases.

Next remains activation/catch-up scheduling and visible-view integration, then
retiring universal enumeration/renewal. The prototype's 16-registration cap
included grace rows at this checkpoint; that mismatch is now addressed below.
No account sleep or scale
gate is passed by admission alone.

## Bounded Demand Activation

New demand admission atomically queues an account-local keyset cursor. An indexed
dispatcher visits at most eight due accounts, and each account transaction
schedules at most 100 authorized memberships within its live/grace scope. Scope
IDs alone cannot create access: the base membership projection must list the
account as owner/collaborator. Scheduling creates no granted generation or lease.

Admission retries preserve an existing cursor; if ephemeral activation state was
lost, reacquisition recreates it without extending the lease. Demand expiry
before a pending page cancels activation. A completed cursor has no due time,
so idle accounts are not revisited by this dispatcher. The activation table is
classified alongside ephemeral demand in the ownership inventory.

Opt-in maintenance now runs activation, but deliberately still runs the legacy
seed/refresh path. Demand-aware projection/access job selection, membership
change signals, visible-view renewal, state cleanup, and atomic catalog-interest
handoff remain to be integrated before removing that path. This checkpoint does
not establish zero recurring cost for cold accounts or the full return protocol.

Validation: server TypeScript build, 30 API tests, seven ownership tests, and
eight real-PostgreSQL demand tests pass. New cases cover one-project pages,
scope/membership filtering, retry cursor preservation, expiry cancellation,
idle dispatcher behavior, and reacquisition after activation-state loss.

## Demand-Aware Job Selection Prototype

Activation now marks separate account projection/access due queues. Claims begin
with one indexed due account, then select bounded project jobs within current
live/grace scope using account-leading indexes. Expired interest clears that
account's due marker instead of repeatedly revisiting its historical access
rows. Demand still grants no access: ordinary owner validation and lease limits
remain unchanged.

An additional `COCALC_PEOPLE_DEMAND_SCHEDULER_PROTOTYPE=1` switch, together with
both prior demand and event-fanout switches, opts into this selection and skips
the legacy membership seed and cursor-notification polling. Missing any switch
retains the old behavior. This cutover is for isolated prototype validation,
not mixed-version deployment: pre-cutover intent repair, membership-change
signals, and client visible-view demand are still prerequisites.

The existing cleanup query still examines historical projection rows, and
catalog compaction/other maintenance has not been redesigned here. Therefore
absence of seed work or owner RPCs is not evidence of zero dormant database
cost. Bounded lifecycle cleanup, fair-load measurements, and the full 100k/1M
dormant fixtures remain required before claiming that scaling invariant.

Validation: server TypeScript build, 30 API tests, nine PGlite access-fence tests,
and ten real-PostgreSQL demand tests pass. The new cases exclude cold accounts
and out-of-scope projects from both claim paths, clear queues on grace expiry,
and run two maintenance passes over 1,000 eligible cold membership/access rows
without seed work, grant claims, or project-page/access-refresh/notification-page
RPCs. Source-writer traffic is independent and is not counted as account refresh.

## Bounded Historical Cleanup Prototype

With all three prototype switches enabled, projection cleanup now persists a
keyset cursor and examines at most 20 candidate access keys per minute. An
immediate maintenance retry preserves the cursor rather than traversing more
historical memberships. Exhausting the keyspace resets the cursor for a later
repair pass; skipped row locks are revisited on a subsequent cycle. Access
leases continue to gate reads independently of eventual metadata deletion.
The default legacy path is unchanged.

This is a logical candidate and cadence bound, not yet a measured physical I/O
bound: PostgreSQL query plans at 100k/1M dormant memberships still need validation.
It does not implement retention GC, account lifecycle cleanup, or the remaining
catalog and membership-change integration.

Validation: server TypeScript build and all ten real-PostgreSQL demand tests
pass. The 1,000-cold-membership maintenance test additionally verifies that the
first pass advances exactly 20 ordered keys and an immediate second pass leaves
the persisted cursor unchanged. Formatting and diff whitespace checks pass.

## Dormant Population: PostgreSQL Cleanup Plans

Added `packages/server/collaborators/dormant-scale.acceptance.test.ts`, explicitly
opted into with both `COCALC_COLLABORATORS_ACCEPTANCE=1` and
`COCALC_PEOPLE_SCALE_ACCEPTANCE=1`. It runs in the isolated multi-bay PostgreSQL
fixture, not the live development database. It grows synthetic dormant accounts
with one membership each to 0, 100,000, and 1,000,000, leaving all access rows due.
It analyzes the tables and explains the exact production cleanup SQL, shared
with the test rather than copied into a separate benchmark approximation.

Measured PostgreSQL 18 results from this run:

| Dormant memberships | Candidate buffers | Stale-check buffers | Candidate execution ms | Stale-check execution ms |
| ------------------: | ----------------: | ------------------: | ---------------------: | -----------------------: |
|                   0 |                 0 |                   0 |                  0.014 |                    0.081 |
|             100,000 |                23 |                 240 |                  0.028 |                    0.207 |
|           1,000,000 |                 4 |                 240 |                  0.031 |                    1.092 |

Buffers are root-plan shared hits plus reads, not distinct pages or physical
disk operations. The lower candidate count at one million is not a claim that
larger datasets are faster: visibility/cache and plan choices affect this
measurement. The fixture checks a generous fixed ceiling of 2,000 buffers per
query; its machine-readable output includes full analyzed plans for diagnosis.
Both populated sizes use indexed lookups rather than a population traversal.

At each size, two actual maintenance passes leave the dormant rows intact,
create no grant claims, and make no owner project-page, access-refresh, or
notification-page calls. All three scale tests passed in 252 seconds including
fixture startup and population. Server TypeScript build also passed.

This evidence closes the initial empty/100k/1M cleanup-query measurement gap,
not the overall scaling gate. It measures the first keyset page, one membership
per account, no concurrent active view load, and no bulk stale-row deletion.
Deep cursors, heavy-tail membership distributions, active/cold competition,
other maintenance queries, retention, storage growth, DAU traces, and the soak
remain required. Millisecond timings here are observations, not production
latency guarantees.

## Membership Feed To Demand Scheduling

Under the three demand/event scheduler prototype switches, both the local
account-project projector and remote-home project-feed upserts now schedule the
affected project for matching live/grace demand. This closes the case where an
already-open view finishes activation and then joins a new project: no consumer
restart or universal membership seed is needed. Out-of-scope, cold, banned,
deleted, and viewer-only memberships do not qualify for this scheduling path.

The targeted access job and account due markers coalesce with existing work;
they do not reset the account activation cursor or allocate a job per event.
Only due times are changed, never access grants or authorization generations.
The local projector uses its existing transaction. In prototype mode the remote
home upsert uses an account-home/rehome-fenced transaction, including both the
membership projection and scheduling writes. Default legacy behavior remains
unchanged. Queue-before-access lock order matches activation and claims.

This consumes existing membership feed delivery; it does not make best-effort
remote forwarding durable or solve missed-event recovery. Owner revision
interests, atomic catalog subscription handoff, faster revocation hints, visible
client demand, and migration/repair remain incomplete. Existing access checks
and lease expiry still bound authorization independently of scheduling.

Validation: server TypeScript build, 12 real-PostgreSQL demand tests, five
existing server project-feed tests, and nine PGlite local projector tests pass.
Coverage includes post-activation membership arrival, duplicate feed delivery,
scope/role/expiry exclusion, no issued grant, preservation of the completed
activation cursor, and rollback of membership plus queue writes when an
injected access-job constraint failure occurs, followed by successful retry.

## Visible People View Demand

The account-home revision check advertises optional `demand_supported` only
when all three scheduler prototype switches are enabled. The People page now
uses that capability to acquire account-bound discovery demand, renew every
30 seconds while visible, and release when hidden, inactive, unmounted, or
changing scope. Server lease admission/expiry remain authoritative. Revision
polling also stops while the document is hidden and resnapshots on return.

Demand follows the retained visible list's project filters, including its
selected project when needed; opening a detail pane must not put a still-visible
global list to sleep. The Invites-only view requests no discovery demand.
Neither login nor global badge code acquires a lease through this integration.
Legacy servers and Lite do not advertise the capability and retain their
existing path. This is not mixed-version rollout approval.

Lease calls retain the existing account/client binding. Effect transitions
serialize acquisition, renewal, and release so a late acquire is released before
a returning view reuses its consumer. A failed best-effort release falls back to
server expiry. The same mounted consumer is reused across hide/show transitions;
the then-existing grace-inclusive cap needed revision for repeated component
remounts. Separate live/retained admission bounds are now covered below.

Validation: server and frontend TypeScript builds, frontend lint, 50 focused
frontend tests, 30 server API tests, and 12 real-PostgreSQL demand tests pass.
Coverage includes hidden polling suspension, renewal cadence, release/reacquire,
late acquisition ordering, no admission for Invites/legacy capability, account
switches, and prototype-only capability advertisement. Existing page interaction
tests also pass; no new controls or focus behavior were introduced. Live browser
and multi-tab/multi-account demand tests remain outstanding, as do programmatic
query sessions, owner revision subscriptions, and the broader validation gates.

## Explicit Host Census Adapter

Added an explicit-only scheduling mode to the existing host census producer,
selected by `COCALC_PEOPLE_CENSUS_EXPLICIT_PROTOTYPE=1`. In this mode inventory
enumeration and the hourly automatic rescan loop do not admit work. Already
admitted bounded traversal and candidate/report handoff still run. The default
inventory mode is unchanged. Do not deploy this switch as a complete cutover:
first-use demand, dirty-path reconciliation, and owner Scan admission still need
to feed it before historical discovery can be disabled safely.

The internal host adapter accepts a fixed-root reconciliation request with a
stable run ID and replacement CAS. It rechecks enabled state, host/owner
authorization, persistent volume identity, and lifecycle generation before
admission; only the background worker opens files. Existing run IDs replay
without resetting work, replacements share a five-minute project cooldown,
pending traversal/candidates return busy, and unacknowledged report intent
defers replacement. A busy run is not claimed to cover a newer request boundary.
Store capacity and normal traversal limits remain in force. Missing volumes
are not provisioned, compute is not started, and no snapshot is requested.

This is an internal building block, not the public Scan contract. It does not
yet supply actor quotas, seven-day admission receipts, cross-request coalescing
and follow-up watermarks, bay/global admission, public RPC/CLI/UI, or scoped
agent authorization. Nor does it treat the failed raw btrfs generation candidate
as a no-change proof. Explicit reconciliation still uses conservative traversal.

Validation: project-host TypeScript build and 19 focused host tests pass,
including the existing 1,000-stopped-project discovery/restart fixture. New
cases advance the cold explicit-mode clock over three days without inventory
enumeration or file access, admit work without opening files, verify replay
across restart, enforce busy/cooldown/replacement behavior, and reject disabled,
owner-denied, missing-volume, and replaced-volume requests. These use the real
SQLite census store; filesystem/owner boundaries in the new admission tests are
controlled mocks, not a live owner-to-host RPC or btrfs proof.

## Internal Reconciliation Control Routing

Added version-one request/status methods on the privileged host-control API,
including the inter-bay host-control declarations, method registration,
destination handlers, and routed host client. Routing resolves the host's bay;
it does not assume the caller's local database or host is authoritative.
The host prototype switch remains required. Unsupported versions and malformed
identities fail before reaching the adapter, and caller-provided root/limit
fields are not forwarded.

Status rechecks enabled state, owner authorization, lifecycle generation, and
volume identity, then returns only discovery progress for the exact current
run. An unknown/superseded run returns unknown without creating work. Finished
discovery is labeled `discovered`, not complete owner ingestion or visible-view
freshness. Status never opens the project filesystem or starts compute.

These methods are not installed on an account or agent API. The owner-side
actor admission/receipt/coalescing service is still missing, so this is not a
public Scan implementation or an authorization grant for agents. Real
authenticated cross-bay transport and mixed-version rollout validation remain
outstanding; routing tests here use mocked bridge clients.

Validation: project-host TypeScript build (including changed referenced
packages) and 47 focused tests pass: 23 host adapter/control tests, 19 Conat
transport tests, and five routed host-client tests. New cases verify method
registration at the destination bay, preservation of run identity, no compute
start/create on forwarding, disabled/version/identity rejection, traversal-option
stripping, inert unknown-run status, and owner/volume/disable checks on status.

## Owner Scan Admission Store Prototype

Added an explicitly installed, currently unexposed owner-side store for Scan
admission. Project-owner locking serializes concurrent requests; request IDs are
scoped to authenticated account and project, and retries return the original
seven-day receipt. Changed arguments and retained expired IDs fail rather than
silently launching new work. Receipt inspection never admits work. Both replay
and inspection recheck current project membership and owning-bay authority.

Queued requests coalesce; running work receives a five-minute admission cooldown
before one follow-up slot can be queued. There are at most two job slots and
4,096 retained receipts per project. This is a conservative prototype: the
cooldown currently starts at admission, not actual host execution. Receipt
cleanup, dispatcher/settlement, actor and project token buckets, bay/global
budgets, and follow-up observation boundaries are still outstanding. No public
API or startup schema installation invokes this store.

These tables are project-owned durable state, not disposable view caches.
Project rehome refuses movement while this state exists until transfer support
is implemented. The server TypeScript build and 12 focused tests pass (five
PGlite admission tests and seven table-ownership tests). This does not validate
real concurrent PostgreSQL contention or end-to-end host dispatch.

### Shared Project Admission Budget

The owner store now persists a project-wide token bucket: burst two, refill one
token per minute, with database time sampled under the project lock. Different
collaborators share it; stable retries return before charging it. Throttled
requests do not create receipts or jobs. Backward clock movement does not refill
the bucket. A unique project/state index also prevents duplicate queued or
running slots. The retained-receipt cap is now 11,000 instead of 4,096, enough
for seven days at the allowed project rate plus headroom.

This is not the actor-wide limit: that must be enforced at account home across
projects and bays, rather than a per-owner approximation. Host/bay/global limits,
status-poll budgets, dispatch, and receipt cleanup remain outstanding; public
admission remains unexposed. Budget state is project-owned and included in the
unsupported-rehome guard. Seven PGlite admission cases cover concurrent burst
admission, shared actors, refill, free replay, and backward-clock behavior in
addition to the earlier authorization and receipt cases.

### Bounded Receipt Reclamation

New project-budget-eligible admissions now reclaim at most 64 expired receipts
using a project/expiry index in the same transaction. Replay, status reads, and
throttled calls do not perform retention work. There is no per-project cleanup
timer: a cold project keeps bounded expired rows until its next admission or
project deletion, without recurring traversal. Live receipts remain unchanged.

Deduplication is guaranteed only during the seven-day retention window. A
retained expired ID is rejected, but once reclaimed it cannot be distinguished
from a new ID. Clients must inspect unknown outcomes within retention and must
not retry expired IDs to discover their outcome. Inspection after reclamation
returns unknown and never launches work. A stronger forever-reject-old-ID
contract would require a versioned timestamped request identity or retained
tombstones; this implementation does not claim one.

The focused retention case injects 80 expired rows, proves replay/inspection
leave them untouched, verifies a new admission removes exactly 64, and checks
that throttled requests do not continue cleanup. Host execution, receipt job
status retention, and end-to-end client expiry UX remain unimplemented.

### Owner Execution Boundary

Added an internal queued-to-running transaction that requires a live matching
request receipt and current collaborator authority. It commits a stable start
timestamp before host transport; repeated/concurrent starts return the same
job and boundary instead of allocating another run. A queued follow-up cannot
start while another job is running. Subsequent admission uses the persisted
start timestamp for its conservative cooldown rather than queue creation time.

This boundary is dispatch preparation, not proof that the host began or captured
the filesystem. No caller is wired yet. The future dispatcher must route to the
current authorized host, preserve this job identity across ambiguous outcomes,
and implement leases, settlement, and durable last-execution cooldown after
completed jobs leave the active slots. Ten focused PGlite tests and the database
TypeScript build validate this checkpoint, not end-to-end execution.

### Follow-up Admission Versus Execution Cooldown

Corrected the prototype to admit one follow-up immediately behind running work
(subject to project tokens), rather than requiring the caller to retry after
five minutes. A durable `last_started_at` in the project budget now enforces the
five-minute execution cooldown independently of active-job retention. Stable
start retries do not change that timestamp. Both check and reconcile use this
conservative limit until a no-change proof is validated.

Free slots are selected explicitly, so after slot zero settles and slot one
starts, a newer follow-up can occupy slot zero without a key collision. Eleven
PGlite tests and the database build pass, including simulated settlement showing
that deleting the old job does not bypass cooldown and that alternating slots
remain bounded to one running and one queued. Actual settlement and host
dispatch are still absent; this test deliberately deletes the old job directly
and is not end-to-end completion evidence.

### Host-bound Discovery Settlement

Execution preparation now pins the current project host; missing hosts cannot
start, and a replacement host requires explicit recovery rather than replaying
the old run. An internal settlement transaction checks current writer authority
and the pinned host, records `discovered` or `failed` separately from immutable
admission receipts, then releases the active slot. Matching repeated reports
are idempotent while receipts remain; conflicting reports fail. Discovery is
deliberately not labeled owner-ingested or view-current.

Thirteen focused PGlite tests and the database TypeScript build pass. New tests
cover queued-job rejection, wrong-host authorization, replacement-host fencing,
repeated/conflicting reports, slot release, and unchanged admission replay.
This store is still not wired to host transport or a worker. Host migration
recovery, real dispatch/settlement, and final ingestion/view watermarks remain
required; no end-to-end Scan completion is claimed.

### Read-only Discovery Status

Added internal job-ID status inspection with current owner/member authorization
and a caller-owned live receipt. It distinguishes unknown, queued, running,
discovered, and failed without host RPC, admission, retention mutation, or token
charging. Running status becomes unknown after host replacement. Historical
discovery results remain readable during receipt retention, but never claim
that owner ingestion or the user's view has caught up.

Fifteen focused PGlite tests and the database build pass. Lifecycle coverage
reads status before admission, while queued/running, after settlement, and after
expiry; separate coverage denies revoked access and hides jobs from a current
collaborator without their own receipt. This internal store still needs public
status rate limits, richer progress/freshness state, worker integration, and
live validation before the plan's Scan contract is complete.

### Internal Owner-to-host Dispatch Step

Persisted the predecessor run ID with each execution and retained the last job
ID in project budget state. Added one default-off internal dispatch step using
the routed host client. It prepares the owner job, inspects that exact host run,
and submits the same identity/predecessor only when the host reports unknown.
Transport errors propagate without failure settlement or fresh run allocation.
Discovery settles only for the matching run with zero pending candidates.

The server TypeScript build, fifteen PGlite store tests, and five mocked
dispatcher tests pass. The dispatcher is not scheduled or publicly exposed;
`COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE=1` is required even for direct internal
invocation. Worker leases, fair queue selection, actor/host/bay/global budgets,
and adoption/recovery of an already-existing host census remain outstanding.
In particular the first owner job cannot replace an unrelated host run without
explicit predecessor reconciliation; no unsafe unconditional replacement was
added. Real authenticated transport and end-to-end validation are still needed.

### Dispatch Lease

Added a 90-second database-time dispatch lease on running jobs. Acquisition
rechecks project access and a caller-owned live receipt; concurrent acquisition
has one winner. Release is token-fenced, so an expired worker cannot release its
successor's lease. Successful dispatch steps release; unknown transport outcomes
retain the lease until expiry instead of immediately retrying. Expiry cannot
cancel an in-flight RPC: persistent host run-ID deduplication remains required.

Sixteen PGlite store tests, six dispatcher tests, and the server build pass.
Coverage includes queued-job denial, concurrent claim, expiry takeover, stale
release, and no host calls while a lease is held. This is not yet a queue worker:
fair selection, adaptive polling/backoff, budgets and live crash validation are
still outstanding, as is the broader indexing plan.

### Active-job Queue Selection

Added owner-local selection of at most 20 dispatch candidates from active Scan
jobs, not historical accounts or memberships. Eligibility requires a current
host, a live receipt belonging to a current collaborator, no active dispatch
lease, and no execution cooldown/running predecessor conflict. Dispatch claims
record their attempt time; candidate ordering prefers least recently attempted
work and enforces a five-second selection interval. Selection is a hint only;
execution and lease acquisition retain their authorization checks.

Seventeen PGlite tests and the database build pass. New coverage verifies owner
isolation, visibility before dispatch, lease/recent-poll exclusion, later
eligibility, and revocation. Returned work is bounded, but PostgreSQL query cost
with a large blocked active queue has not been measured. This is not yet a
scheduled worker or proof of the plan's fairness/load targets.

### Explicit Worker Pass

Connected active-job selection to dispatch in a default-off explicit worker
pass. It attempts at most 20 jobs sequentially and stops beginning steps after
60 seconds or prototype disable. This is a start budget, not cancellation of an
in-flight RPC. A per-bay in-process guard prevents local overlap; database job
leases handle competing processes. Per-job exceptions count as unknown and do
not cause fresh identities or failure settlement. Selection errors release the
local guard and propagate.

The server build and ten worker/dispatcher tests pass, covering disabled reads,
attempt cap, unknown-outcome isolation, mid-pass disable, overlapping passes,
and guard recovery after a database error. No timer or startup registration was
added: remaining admission budgets and live transport/scale validation are
required before enabling automatic scheduling. This does not complete the
broader indexing plan.

### Worker and Store Integration

Added three integration cases using the real PGlite admission, queue selection,
lease, start, settlement, receipt, and status code, with only routed host
transport mocked. They exercise discovery through the worker, immutable retry
receipts after settlement, a cooldown-delayed follow-up carrying the previous
run ID, ambiguous admission response followed by exact-run inspection after
lease expiry, and revocation before transport. The server build and these three
cases pass. This is stronger than isolated dispatcher mocks, but still does not
exercise real PostgreSQL locking across processes, authenticated inter-bay
transport, filesystem census, or the plan's load and rollout gates.

### Real PostgreSQL Blocked Scan Queue Baseline

An isolated PostgreSQL acceptance case populated 10,000 queued jobs with no
live receipts and ran EXPLAIN ANALYZE BUFFERS on the exact exported production
selection SQL. It returned zero candidates but visited all 10,000 jobs and
performed 10,000 project lookups: 39,996 shared-buffer hits, zero shared reads,
39.786 ms execution on this development host. This contradicts any claim that
the 20-result limit bounds examination work. It is a baseline measurement, not
a passing capacity gate. Selection needs bounded candidate examination and
resumable progress past blocked jobs before automatic polling is appropriate.

The server build and isolated acceptance case pass; the test currently asserts
the empty result and emits the full measured plan, not a performance ceiling.
The remaining correction must add a regression ceiling after redesign and
exercise both blocked backlogs and eligible jobs beyond the first page.

### Bounded Scan Queue Examination

Replaced whole-queue eligibility search with a durable per-owner cursor in the
existing maintenance table. Each transaction selects 20 job IDs by an indexed
keyset, advances regardless of eligibility, and evaluates only that materialized
page. An empty tail wraps once. Running-job exclusion remains a correlated
per-project lookup rather than a global hashed running-job scan. Within-page
ordering still prefers older attempts; global traversal is now round-robin by
job ID, not a global oldest-first sort.

On the same isolated PostgreSQL 10,000-blocked-job fixture, eligibility work
fell to 20 jobs, 119 shared-buffer hits and 0.315 ms (baseline 39,996 hits and
39.786 ms). The acceptance test now imposes a 2,000-buffer ceiling on eligibility
evaluation. This measurement excludes cursor transaction/page-query overhead
and is not a DAU capacity result. Eighteen PGlite store tests, three worker/store
integration tests, the PostgreSQL case, and the server build pass. New coverage
proves the cursor reaches an eligible job beyond a blocked first page and wraps.
Large receipt populations and total time to revisit a heavily blocked queue
still require measurement and lifecycle cleanup; automatic scheduling stays off.

### Real PostgreSQL Admission and Lease Races

The isolated PostgreSQL harness now runs 12 concurrent calls for each of three
cases: identical admission retries, distinct requests sharing the project burst
budget, and dispatch lease claims. Identical retries returned one exact receipt;
only one additional distinct request was admitted/coalesced after the first
token was spent; exactly one lease claim won. Forced lease expiry permitted a
new token, and releasing the stale token did not clear it. Calls use separate
pool transactions in the owner fixture process, not separate hub processes.

Both PostgreSQL acceptance cases and the server build pass. The blocked queue
eligibility regression remained below its ceiling (139 buffer hits, 0.252 ms in
this run). This adds real database contention evidence but does not establish
multi-hub failure recovery, transport correctness, or the broader capacity gates.

### Account-home Actor Reservations

Added an explicitly installed account-home Scan reservation store under the
existing account rehome fence. All projects share one burst-two, one-token-per-
minute actor bucket. Canonical project/request/mode retries reuse a seven-day
reservation without charging again; changed mode fails. Owner rejection does
not refund an attempt. Reservations are not project authorization, and no public
API or forwarding path is wired to them yet.

The store uses bounded opportunistic expired-receipt reclamation and an 11,000
receipt cap, with no cold-account timer. Durable actor budget/receipt state is
classified account-home, blocks unsupported rehome, and participates in existing
deleted-account cleanup. Two focused PGlite cases validate shared-project burst,
free replay, argument binding, wrong-home rejection, and banned-account replay
denial. The server build passes. Cross-bay forwarding, actor concurrency/load
coverage, status budgets, and transfer support remain outstanding.

### Internal Home-to-owner Admission

Added trusted inter-bay `scanAtHome` and `scanAtOwner` methods, with shared input
and receipt types in util. Home admission checks current home routing and the
People setting before reserving an actor token; throttling stops there. Reserved
attempts resolve the project's owner and forward the same request identity.
Owner admission checks the current owner route/epoch and delegates to the
transactional project-authorized store. Both methods require the default-off
Scan prototype switch. No public account or agent endpoint was added, and schema
installation remains explicit.

The server build and 31 existing/extended API tests pass. The new mocked-routing
case verifies actor-throttle short circuit, owner forwarding, stale-home
rejection and People disable. This is not authenticated transport or full
multi-bay admission evidence; host/bay/global limits and reviewed agent scope
remain required before exposing the flow.

### Authenticated Multi-bay Admission Acceptance

Extended the isolated multi-bay harness to invoke `scanAtHome` from a third bay
over the authenticated inter-bay fabric, with actual home reservation and owner
admission stores. The test verifies exactly one home receipt and one owner
receipt across retry, stale-home rejection, changed-mode rejection, and owner
access denial after project membership revocation even when the home reservation
already exists. All three PostgreSQL acceptance cases and the server build pass.

This proves the internal home-to-owner path in the synthetic cluster, not public
principal binding, agent grants, live project-host execution, or production
rollout. Broader budgets, recovery and capacity gates remain outstanding.

### Initial Host Census Adoption

Authorized internal host status now returns its current run ID when the requested
run is unknown, after validating the stored run's local scope. For an owner job
with no predecessor, dispatch persists that ID under the live lease and current
host authority before requesting replacement. An established predecessor cannot
be overwritten. Host busy, cooldown and expected-run comparison still govern
replacement; no unconditional replace or filesystem traversal was added.

The project-host build and 36 focused tests pass (19 store, ten host census,
seven dispatcher). New coverage verifies durable predecessor replay, wrong-token
rejection, refusal to change an established predecessor, and inert authorized
host disclosure. Mixed-version hosts without the new optional field still fail
closed on a conflicting census. Real owner/host adoption transport and recovery
after volume/host replacement remain to be validated.

### Actor Budget Boundary Validation

Five PGlite actor reservation tests and the database TypeScript build pass.
New deterministic coverage verifies that a future stored budget timestamp does
not mint tokens, a long idle interval refills only the two-token burst, retained
expired retries neither charge nor clean receipts, and a fresh admitted request
removes at most 64 expired receipts. Throttled requests and live retries leave
expired receipts untouched. These tests exercise the real store with synthetic
timestamps, not concurrent PostgreSQL actors or production churn throughput;
those validation gates remain outstanding.

### Concurrent Actor Reservations In PostgreSQL

The isolated PostgreSQL acceptance suite now races twelve identical actor-home
reservations, then twelve distinct projects against the same actor's remaining
token. All retries return the same reservation; exactly one competing project
reserves, eleven receive positive retry timing, and exactly two durable receipts
exist. A subsequent original retry remains free. All four Scan acceptance cases
and the server TypeScript build pass. This exercises concurrent transactions in
one home-bay process, not multiple home-bay processes or sustained load. No
production runtime or feature flags were changed.

### Expired Queued Job Retirement

Added an internal owner-maintenance operation that retires one queued Scan job
only when no live admission receipt remains. It takes the same project/rehome
fence as admission and execution, so coalescing or starting cannot race deletion.
It neither initializes catalog state nor requires a remaining human member.
Running jobs are never inferred abandoned from receipt expiry, and retained
receipts are not deleted or rewritten. The operation is not yet invoked by the
worker; bounded cleanup traversal and real PostgreSQL retirement/start races
remain necessary. Database build and all 21 Scan store tests pass, including
live coalesced receipt preservation, wrong-owner rejection, idempotent retirement,
expired retry preservation, and refusal to retire running work.

### Bounded Worker Retirement

The explicit Scan worker now follows dispatch with a separately cursored cleanup
page, examining at most 20 active job IDs and retiring only expired queued work.
Candidate selection commits its cursor before individual fenced retirement
transactions, so a project in rehome cannot starve later candidates. The pass
shares its existing deadline and disable check with cleanup; running jobs and
retained receipts remain untouched. No automatic timer was enabled.

Server build and 31 focused tests pass (22 store, five mocked worker, four
worker/store integration). Coverage verifies 20/5-page traversal and wrap with an
independent dispatch cursor, bounded attempts despite a retirement error,
disable-before-cleanup, and real-store retirement without host transport.
Cleanup query plans at scale and PostgreSQL coalescing/start-versus-retirement
races remain unverified. Sustained dispatch that exhausts each pass's deadline
can delay cleanup; eventual cleanup latency is not yet a measured guarantee.

### Retirement Candidate Query Cost

The real PostgreSQL acceptance fixture now measures the exact exported cleanup
candidate SQL against 10,000 queued jobs, first with no receipts and then with
100,000 live receipts (ten per job). For a twenty-job page, the measured plans
used 80 shared-buffer hits / 0.174 ms and 79 hits / 0.152 ms respectively. The
receipt-heavy plan used twenty indexed receipt lookups rather than traversing
the full receipt table. The test asserts the expected result counts and fewer
than 2,000 shared hit/read blocks in both cases. All four acceptance cases and
the server build pass.

These timings exclude cursor selection/updates, retirement transactions, host
work and concurrent load. Expired-receipt-heavy distributions, stale statistics,
race validation and end-to-end cleanup latency remain separate gates.

### Mass Expiry Planner Regression

Expiring all 100,000 fixture receipts revealed a real unbounded-history plan:
after ANALYZE, PostgreSQL materialized a global expiry-index lookup containing
unvacuumed formerly-live tuples. Selecting twenty cleanup candidates cost
100,388 shared-buffer hits and 28.17 ms, failing the 2,000-block acceptance bound.

Candidate selection now materializes each selected job's receipts before expiry
filtering; the final retirement check uses the same scoped shape. Repeating the
fixture used 559 hits / 1.132 ms with stale statistics and 559 hits / 0.588 ms with
fresh statistics. All four PostgreSQL acceptance cases, 22 store tests, and the
server build pass. These remain synthetic selection measurements, not a timing
guarantee for retirement transactions, worst-case per-job receipt counts, or DAU
capacity. The regression cases are retained in the acceptance suite.

### Retirement Admission And Execution Races

The isolated PostgreSQL suite now runs eight rounds racing retirement of expired
queued work with a fresh admission. It accepts either valid lock ordering but
requires that the returned job exists, has the correct new/coalesced identity,
and remains startable. Each round then races start with eight retirement calls,
requiring all retirement calls to preserve the live job and the final row to be
running. All five acceptance cases and the server build pass. This validates
concurrent transactions in one owner fixture process; it neither forces both
lock orderings nor establishes multi-process load or rehome recovery behavior.

### Cleanup Opportunity Before Host Dispatch

Cleanup now runs before host dispatch, removing the earlier possibility that
every pass spends its deadline on host calls and never visits stale queued jobs.
It keeps the twenty-entry cap and stops starting retirements after five seconds,
leaving the remainder of the sixty-second pass window for dispatch. New fake-clock
tests verify cleanup occurs before a host call consumes the deadline and that
cleanup stops additional attempts while dispatch can still proceed. Server build
and all eleven worker/unit-store integration tests pass. The deadline does not
cancel in-flight database queries; hard query timeouts, sustained contention and
eventual cleanup latency remain unvalidated.

### Maintenance Lock And Statement Limits

Scan job-page selection and queued retirement now set transaction-local one-second
lock and two-second statement timeouts. Timeout rolls back the current operation;
the worker retains/revisits the same work rather than inferring retirement.
The PostgreSQL fixture holds the project row lock, verifies retirement reports a
lock timeout with its queued job unchanged, releases the lock, then successfully
retires that same job. All six acceptance cases, 22 store tests and the server
build pass. Settings are local to these maintenance transactions, not connection
defaults. Pool acquisition and cumulative multi-statement transaction duration
are not bounded by these settings; sustained contention still needs validation.

### Cleanup Selection Failure Isolation

A failed cleanup-page selection now increments the retirement error count and
leaves dispatch eligible within the remaining pass deadline. It does not report
successful cleanup, recreate job identities or drop retry state. Server build
and twelve worker/unit-store tests pass, including cleanup selection timeout
followed by successful dispatch and a subsequent normal pass.

### Owner Revision Interest Registration Prototype

Added an explicitly installed owner-side interest store keyed by project and
destination home bay, not account membership. Registration rechecks current
membership under the existing owner/rehome project fence. Consumers aggregated
by one home share a 120-second lease, with no lease extension before the
30-second renewal boundary. Expired leases rotate identity. Registration samples
the current catalog generation/revision in that transaction without initializing
an absent catalog or returning resource metadata. Ownership inventory and project
rehome guards include the new table.

Server build and three PGlite contract tests pass: same-home aggregation,
non-extending retry, separate homes, expired identity rotation, catalog boundary,
and current membership/owner checks. This is a store primitive only: no transport
handler or scheduler uses it yet. Authenticated home/demand binding, expiry GC,
interest quotas, coalesced revision delivery, acknowledgment fences, lost-hint
repair and shared delta application remain required before enablement.

### Revision Interest Release Fence

Accepted renewal now rotates the interest lease ID, while retries before the
renewal boundary keep the existing ID and expiry. Internal aggregate-home release
deletes only the exact project/home/lease tuple under the owner/rehome fence.
A stale release cannot cancel renewed interest; a current release remains possible
after membership revocation because relinquishing a scheduling hint grants no
access. Four store tests and the database build pass, including renewal fencing,
wrong-home no-op, wrong-owner rejection and repeated release. Authenticated
aggregate-home routing is still a caller contract, not an exposed transport API.

### Coalesced Revision Hint Store

Live-interest inspection now compares the current catalog generation/revision
with an acknowledged hint watermark, rather than creating one pending row per
edit. Inspection rechecks membership and does not renew demand. Acknowledgment
is lease-fenced, monotone within the current generation, and rejects future
revisions or an old generation. Active renewal preserves acknowledgment state;
expired reacquisition resets it. An acknowledgment represents a wakeup accepted
durably at home, never an assertion that a user view has caught up.

Database build and five store tests pass, including an intervening revision,
out-of-order acknowledgment, future/wrong-generation rejection, renewal lease
replacement, generation rotation and expiry. Transport delivery, durable home
acceptance, batch selection and lost-hint repair remain unwired; these store
tests do not establish the full snapshot/subscription handoff.

### Revision Interest Registration Routing

Added a trusted-fabric-only registration method at the current project owner,
behind `COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE=1` plus existing People/demand
gates. It derives the account home from the directory, asks that home's routed
demand inspection for active/grace scope, rejects cold or unrelated project
scope, then registers under the owner store's membership fence. The request has
no destination-home field. No public account API, agent capability or automatic
worker was added, and schema installation remains explicit.

Server build and 32 API tests pass, including cold/out-of-scope demand, derived
home routing, stale owner route and disabled admission. Real-fabric integration,
home rehome/expiry races, aligning owner lease expiry with the remaining demand
horizon, batched registration and automatic renewal remain unverified. The
owner hint lease is not an access grant and downstream protected reads must
continue to recheck current membership.

### Revision Registration Over Authenticated Fabric

The isolated PostgreSQL/two-home acceptance suite now invokes registration from
the other home bay through the real inter-bay client. The owner queries the
account's actual home, rejects initial cold demand, stores exactly that home
and a stable retry lease after demand acquisition, and rejects membership
revocation and subsequent cold demand without changing the stored lease.
The fixture restores membership after its revocation check. All thirteen demand
acceptance cases and the server build pass. This covers registration only, not
revision transport delivery, home rehome races, or demand-aligned lease expiry.

### Demand-Aligned Revision Interest Expiry

Registration now asks the authoritative home for the remaining grace horizon
of this specific project, rather than accepting aggregate account scope and
granting another unconditional 120 seconds. Unrelated project demand cannot
extend that horizon. The response is a duration, not a cross-bay wall-clock
timestamp; the owner deducts RPC elapsed time and the store deducts local
transaction/fence wait before applying its 120-second cap. An existing longer
project/home lease is preserved because another consumer may have justified it.
Expired demand cannot create or renew a lease. This does not synchronously
revoke previously justified leases when demand is subsequently released.

Validation: server TypeScript build, 32 API tests, six PGlite interest-store
tests and fourteen authenticated PostgreSQL/fabric demand cases pass. The new
fabric case proves a short project-specific horizon is not enlarged by another
project's longer demand. Store coverage verifies shorter registrations do not
truncate an existing aggregate lease. No automatic renewal or hint-delivery
worker is enabled; durable home hint acceptance, batched fanout, expiry cleanup,
rehome races and the full vertical/scale gates remain outstanding.

### Bounded Owner Revision Fanout Pages

Added a worker-only owner-store page over project/home interests. Each call
examines at most twenty keyset-ordered candidates before filtering acknowledged
or expired entries, so an idle population cannot cause an unbounded logical
scan within one call. It returns exact lease IDs and the current catalog
watermark, never resource metadata, and changes neither leases nor ACK state.
Owner/rehome fencing and transaction-local lock/statement timeouts apply.

A sweep is deliberately not a snapshot. Revisions or registrations behind the
cursor require another bounded sweep; callers must not equate end-of-page with
delivery completion. Sending still requires exact-lease revalidation. The
existing project/home primary key supports cursor traversal; production-sized
query-plan and concurrent-write behavior have not yet been measured here.

Server build and seven PGlite interest-store tests pass. Coverage includes an
entirely acknowledged first page, continuation to pending homes, replay without
ACK mutation, generation replacement discovered by a new sweep, expired hints
and stale owner rejection. Durable home acceptance, transport dispatch,
shared delta fetching, sweep scheduling and expiry cleanup remain unfinished.

### Separate Live Demand And Grace Limits

Demand admission now enforces sixteen live consumers, excluding released and
expired registrations. Reacquiring an existing non-live ID must pass the same
live-cap check; previously that path could bypass the combined row-count cap.
Retries for a still-live lease remain idempotent at capacity.

A separate 256-record retained-state ceiling bounds acquire/release churn.
It does not evict or shorten existing five-minute grace scopes. At this larger
ceiling, clients must reuse an existing consumer or wait for expiry; the error
distinguishes retained-state pressure from the live-consumer cap. This is a
starting churn policy, not a measured capacity claim or complete RPC rate limit.
All admissions still serialize under the authoritative account-home fence.

Server TypeScript build and sixteen authenticated PostgreSQL/fabric acceptance
tests pass. New cases fill sixteen live slots alongside a released registration,
reject old-ID reacquisition at the live cap, permit replacement after release,
and verify bounded retained state with reusable IDs at 256 grace records. This
addresses the combined live/grace cap mismatch; workload-scale churn and
browser remount validation remain separate gates.

### Durable Owner Hint Delivery Claims

Revision interests now carry an exact delivery claim and claimed catalog
generation/revision. A worker can claim a still-live lease for at most fifteen
seconds, additionally capped by the interest expiry. Concurrent attempts see
the outstanding claim rather than starting a new delivery. An unknown outcome
does not clear or acknowledge it; a later attempt after expiry samples the
latest catalog revision. Renewing an interest fences and clears the old claim.

Settlement requires the exact lease, delivery claim and claimed watermark,
plus unexpired deadlines and matching current catalog generation. A successful
settlement advances the ACK monotonically, retaining any later catalog change
as pending work. These worker-only store methods do not themselves establish
destination acceptance: the eventual dispatcher must settle only after a
durable home receipt. They expose no resource metadata or access grants.

Server build and eight PGlite store tests pass, including outstanding-claim
exclusion, exact-watermark settlement, unknown-outcome expiry/reclaim, stale
claim and renewed-lease fencing, and generation replacement. Cross-process
crash/transport injection and actual durable home receipt processing remain
unverified. No automatic worker or public API was enabled.

### Shared Home Wakeup Store

Added explicitly installed `collaboration_revision_receivers`, one row per
remote project in the destination home bay, with no foreign key to a locally
owned project or account. It contains only a bound owner/interest lease,
expiry, and dirty/applied sequences. Registration replacement is conditional
on the previous lease, preventing delayed responses from overwriting a newer
registration. Initial arming always requires catch-up.

Trusted receipt increments a durable dirty sequence only for the exact live
owner/home/lease tuple. Catch-up completion compares that sequence, so a hint
arriving during work cannot be cleared by the older worker. Duplicate hints
may cause redundant catch-up, but cannot regress protected catalog state.
Sequences remain decimal strings across JavaScript boundaries. A keyset page
examines at most twenty local receiver records before selecting pending work.

The store is classified as rebuildable local scheduling state. Rebuilding must
re-arm and catch up from current demand/owner state; no canonical identities,
personal state or notification obligations are stored here. The routing layer
must still bind authority and remaining lifetimes before arming, and protected
delta reads must recheck membership. These callers are not yet wired. Expiry
cleanup, shared delta fetch/application, crash-injected transport and repair
scheduling remain open; no automatic schema installation or worker was enabled.

Server build, two PGlite receiver tests and seven table-ownership tests pass.
Tests cover initial pending catch-up, hints during completion, duplicate hints,
stale registration responses, wrong owner/home/lease and expired receivers.

### Owner-To-Home Revision Dispatch

Added an explicit, default-off dispatch step and trusted inter-bay wakeup
endpoint. Dispatch claims the exact owner interest, sends a metadata-free
wakeup to its home, and settles only after a positive durable receiver result.
Transport exceptions and missing/unarmed receivers retain the delivery claim
until expiry. Stale settlement returns deferred, never acknowledgment.

The receiving endpoint checks the local destination bay, current project-owner
directory route, and exact live receiver lease through the store. Both sides
require People and demand/revision prototype gates. No public API or automatic
dispatch timer was added. Receiver arming is still an explicit test setup;
production demand-to-registration-to-arming orchestration remains unfinished.

Server build, 36 API/dispatch tests and seventeen isolated authenticated-fabric
acceptance cases pass. The new fabric case first rejects an unarmed receiver
without advancing owner ACK, then verifies that a retried dispatch leaves a
durable dirty home record before owner settlement. A repeated dispatch has no
pending claim. This does not establish shared delta application, process-crash
recovery, rehome/restore behavior or scale readiness.

### Routed Demand-To-Receiver Registration

Added an internal home-routed registration operation. It resolves and registers
with the current project owner, then rechecks account-home routing and relevant
project demand before conditionally arming the shared local receiver. Receiver
expiry is bounded by both remaining home demand and the owner's returned lease
duration, with elapsed RPC time deducted. Owner registration now includes a
remaining-duration field; absolute cross-bay clocks are not compared.

The receiver snapshots its prior lease before the RPC and uses CAS on return.
Conflicts report `armed:false` rather than overwriting another registration.
Same-live-lease retries do not extend expiry or repeatedly mark catch-up dirty.
Expiry and re-registration still require catch-up. Account-home and membership
changes during the distributed operation remain subject to eventual bounded
lease expiry and protected-read reauthorization, not a distributed transaction.

Server build, ten store tests, 36 API/dispatch tests and seventeen authenticated
fabric acceptance cases pass. The delivery test now uses this routed operation
instead of manually supplying receiver TTL; it covers cold-demand rejection,
same-lease retries and subsequent durable wakeup delivery. The explicit method
is not yet scheduled automatically from demand activation. Shared delta fetch,
automatic renewal/retry, cold cleanup and full lifecycle/scale gates remain open.

### Bounded Receiver Expiry Cleanup

Added home-scoped expiry-indexed cleanup of at most 100 receiver rows per call,
using row locks with `SKIP LOCKED` and local lock/statement timeouts. It deletes
only expired scheduling hints, never canonical or personal data. Periodic
maintenance integration and production-sized query/race measurements remain
unfinished; this alone does not establish zero recurring cold-project cost.

Cleanup required an additional stale-worker fence: each newly inserted receiver
now has a random `receiver_id`, included in pending work and required to finish
catch-up. Without this identity, deleting and recreating a row under the same
still-valid owner lease could reset its sequence to a value held by an old
worker. The old worker can no longer clear the recreated receiver's catch-up.

Server build and three PGlite receiver tests pass. Coverage recreates a receiver
under the same lease, rejects completion with the previous identity, processes
105 expired rows in 100/5/0 cleanup batches, and preserves a live receiver.
Real-PostgreSQL concurrent cleanup/rearm and automatic cleanup scheduling are
not established by these store tests.

### Shared Owner Catalog Read With Recipient Overlays

Factored the owner projection reader into a bounded shared read for up to
sixteen recipients using one compatible generation/revision/relation cursor.
It selects catalog metadata/tombstones and relation continuation once under
the project fence, then independently checks each recipient and computes their
notification membership cutover floors. The common catalog is separate from
recipient authorization and attention data; it is not an access grant. An
all-denied batch returns no catalog. Page sizing reserves space for recipient
floor maps rather than assuming metadata is the only response payload.

The existing single-recipient reader now wraps this shared core and attaches
only its own attention generation/floors. No batch transport endpoint or shared
home cache is exposed yet. Home routing must group only compatible active
consumers and apply each authorized overlay separately; incompatible cursors,
relation continuations and membership boundaries cannot simply be merged.

Server build and 66 projection/relation tests pass. The new case compares each
authorized recipient with the single-recipient result, verifies the common
items contain no recipient floor, checks mixed/all-denied batches and enforces
the recipient bound. Jest briefly reported open handles after test completion,
then the same process exited successfully. Full cross-bay batch transport,
load/byte-boundary measurements and shared home application remain unfinished.

### Shared Catalog Inter-Bay Endpoint

Added typed shared projection request/response contracts and an internal,
prototype-gated owner endpoint. Before reading metadata it bounds recipients
to sixteen, validates the project-owner route, resolves each account's actual
home, requires that all match the requested home, and checks relevant home
demand. The owner store still independently checks each recipient's current
membership and keeps attention floors separate from the common catalog.
The ordinary public API does not expose this method.

Server build, 34 API tests and eighteen authenticated-fabric acceptance tests
pass. Coverage checks cold-demand rejection, cross-home rejection, disabled
admission, recipient bounds and a real authorized shared response with no
attention generation inside the common catalog. This is not yet integrated
into projection-job grouping or home application; there is still one bounded
demand inspection per distinct recipient, and no high-fanout capacity claim.

### Compatible Projection Job Coalescing

Added a per-pass shared fetcher keyed by project, generation, revision, catalog
cursor and relation continuation. Compatible recipients share one in-flight
owner request, including its rejected promise on an unknown outcome. Each job
receives an independent cloned catalog page with only its own attention floors.
Missing/duplicate recipient overlays throw rather than manufacturing denial;
explicit denial still flows through the normal per-account revocation path.

Maintenance uses this fetcher only with both demand scheduling and the revision
prototype enabled. Existing per-job claim checks, protected projection writes,
error handling and metrics remain. Jobs use a conservative pass-start timestamp
so sharing a response cannot extend another recipient's access-lease lifetime.
Byte metrics continue to count logical per-account pages, not shared wire bytes.

Server build and 37 focused tests pass; the authenticated demand suite also
passed all eighteen cases. Compatible/different-cursor groups, independent
attention, shared failure and malformed overlays have direct coverage.
The current demand claimant selects one account per pass, so this integration
does not yet demonstrate cross-account RPC savings. Project-grouped fair claim
selection, demand registration/renewal scheduling and receiver completion after
all relevant catch-up remain necessary before claiming the shared-fetch gate.

### Bounded Active-Account Projection Cohorts

With the revision prototype and demand scheduler enabled, projection claiming
now takes up to eight due accounts from the existing demand queue and divides
the eight-job budget between them. Account-local lateral selections retain
scope, home, ban/deletion, access-claim and projection-claim checks. Cold accounts
without demand are not selected by scanning historical access rows. The legacy
single-account path remains unchanged outside the prototype.

This permits compatible jobs from different accounts to reach the shared
fetcher in one pass. It does not yet provide a reusable project catalog cache:
large groups split across cohorts can still fetch the same catalog again, and
accounts with different due projects may form no shared group at all. Unused
budget in a small/idle cohort is not filled by an unbounded search. Large-scale
fairness and throughput remain to be measured.

Server build, fifty projection-store tests and eighteen authenticated demand
acceptance tests pass. The new store case creates two active accounts plus an
older cold access row, claims both compatible active jobs, reads one shared
catalog result and applies it to both account projections, while leaving the
cold row unclaimed. Jest reported a transient open-handle warning and then
exited successfully without intervention. This is component integration, not
proof of the full source-to-sleep-to-return or 10k/100k scaling gates.

### Shared Fetch Measurement Boundary

Maintenance now measures serialized owner responses at the fetch boundary,
before splitting a shared response into per-account pages. The new
`cocalc_people_indexing_owner_response_bytes_total` counter counts each response
once, labeled only by shared/individual mode. The existing page-bytes counter
remains logical per-account apply volume, with its help text corrected.
`cocalc_people_indexing_owner_fetches_total` distinguishes attempted, received,
and failed invocations. These are application fetch counts and JSON payload
bytes, not transport framing bytes or internal route-retry counts. Received
denials count as responses; thrown/unknown outcomes do not fabricate bytes.

Server typecheck and forty focused metrics, shared-fetcher and API tests pass.
Coverage verifies one shared measurement for two recipients, failed fetch error
preservation without received bytes, and independent UTF-8 individual payload
measurement. This supplies an honest measurement boundary for future scaling
experiments; no capacity, cross-cohort caching, or lifecycle gate is closed by
these tests.

### Demand-Driven Receiver Registration Integration

Under the demand scheduler and revision-interest prototype flags, maintenance
now attempts receiver registration before fetching claimed projection pages.
Candidates come only from the at-most-eight claimed active jobs; same-project
jobs coalesce to one registration attempt per pass. No historical account or
membership scan is introduced. Registration uses the existing routed control
handler, which checks account home, owner membership, and current project demand.

Receiver rows now carry a local renewal deadline capped at thirty seconds or
their remaining lifetime. A successful new lease arm moves this deadline;
observations and idempotent same-lease retries do not extend it or the lease.
Fresh receivers skip the routed registration call. Missing, expired, wrong-home,
or renewal-due receivers remain eligible. Prototype startup installs the owner
interest and home receiver schemas. Fixed-label counters distinguish armed,
deferred CAS outcomes and failures. Failed/unknown registration outcomes do not
retry per recipient within a pass or stop the existing bounded projection path.

Server typecheck, forty-four focused server/store tests, and eighteen real
PostgreSQL/authenticated-fabric demand acceptance tests pass. The component
tests cover coalescing, fresh receiver suppression, failure isolation, the batch
bound, and expiry/rotation renewal eligibility. This is demand-driven renewal
piggybacked on projection work, not an independent renewal scheduler or a proof
of the atomic return handoff. Owner hint dispatch, receiver catch-up completion,
expired-state cleanup scheduling, cross-cohort reuse and scale validation remain
open. Projection polling is intentionally retained until that integration is
verified end to end.

### Scheduled Receiver Expiry Cleanup

The existing maintenance lifecycle now calls receiver cleanup when the demand
scheduler and revision-interest prototype are enabled and People is enabled.
At most one call runs in-process, with a monotonic thirty-second cooldown even
after failure. Each store transaction deletes at most one hundred expired local
home receiver rows using the existing expiry index and SKIP LOCKED semantics.
There is no new timer, historical membership scan or account activation.
Failures retain state and do not abort projection maintenance. Fixed-label
counters record deleted rows and failed cleanup attempts.

Server typecheck and forty-one focused maintenance, registration and API tests
pass, including gate checks, local-home routing, cooldown, failure isolation and
overlapping-call suppression. The store's existing expiry/recreation fences
remain unchanged. The cooldown is per process, not a distributed bay quota;
concurrent processes rely on row locks for correctness. Large-backlog drain
rates still need workload validation. Owner interest cleanup, hint dispatch,
catch-up completion and the full cold-return lifecycle remain open.

### Owner Interest Expiry Primitive

Added an internal per-project expiry operation under the existing owner/rehome
fence. It deletes at most one hundred expired interest rows, with one-second
lock and two-second statement timeouts. A project/expiry/home index supports
the bounded selection. Registration and cleanup share the project fence;
deletion also matches the selected lease and rechecks expiry. Live renewed
interests survive, and cleanup does not require a remaining human member.

Database typecheck and nine interest-store tests pass. The new case verifies
wrong-owner rejection, a 105-row backlog draining as 100/5/0, preservation of a
renewed lease, and cleanup after membership removal. These are PGlite component
tests, not a concurrent production PostgreSQL query-plan or rehome proof.
This operation is not yet automatically scheduled: bounded owner candidate
selection and lifecycle wiring remain necessary, along with the other open
hint-delivery and scaling gates.

### Scheduled Owner Interest Expiry

Owner cleanup now reads at most twenty expired candidate rows from the expiry
index before filtering by current project ownership. The keyset cursor preserves
the database timestamp as text, including sub-millisecond precision. Candidate
selection grants no authority: each deletion still takes the project owner and
rehome fence. Maintenance coalesces candidates by project, advances past failed
or foreign-owner candidates, and wraps after traversal completion. Restart loses
only the optimization cursor, not authoritative cleanup state.

The existing gated lifecycle calls this worker with a thirty-second process
cooldown and a five-second budget for starting operations. A started database
operation can run past that budget up to its existing timeout. Each project
deletion remains bounded at one hundred rows. No memberships are enumerated and
no demand is created. Counts distinguish candidates examined, interests deleted
and failures. This supersedes the preceding note that expiry is unscheduled.

Server typecheck, forty server maintenance/API tests and nine PGlite interest
tests pass. Tests cover page bounds and continuation without duplicate homes,
foreign ownership, project coalescing, cursor wrap, deadline interruption,
failure isolation and disabled gates. Full PostgreSQL query-plan/concurrency
validation, distributed bay quotas and churn backlog throughput remain open;
this does not establish the complete lifecycle or scale gates.

### PostgreSQL Owner Expiry Query Cost

The new `revision-expiry.acceptance.test.ts` exercises the exact exported
production deletion SQL on isolated PostgreSQL with 100,000 live interests and
a 105-row expired backlog. The first run failed: the volatile
`expires_at <= clock_timestamp()` candidate predicate inspected all 100,000 live
rows, using 21,371 buffers when nothing expired and 21,417 for the final five-row
batch. A LIMIT on deleted rows did not bound lookup work.

Changed candidate selection to the conservative transaction-stable `now()`
cutoff. The final delete still rechecks current-time expiry, exact lease and
project identity; the production caller retains the owner/rehome fence. Rows
expiring after transaction start wait for another pass. PostgreSQL now includes
expiry in the project-expiry index condition. Measured buffer counts were 3
(nothing expired), 715 (100 deleted), 51 (5 deleted), and 5 (backlog drained).
Observed execution times were 0.081, 0.423, 0.080 and 0.056 milliseconds; these
are local measurements, not latency guarantees. Tests assert fewer than 2,000
buffers per case and preservation of all 100,000 live rows.

Server typecheck, both PostgreSQL acceptance cases and nine PGlite store tests
pass. This validates this deletion query shape, not 100,000 DAU, concurrent
renewal/rehome behavior, receiver cleanup query cost or full-system churn.

### PostgreSQL Receiver Expiry Query Cost

Receiver cleanup used the same volatile candidate cutoff as owner cleanup.
It now uses `now()` to permit an indexed expiry range, retaining the existing
row locks that serialize deletion with rearming. Expiry after transaction start
is conservatively deferred. The acceptance suite uses the exact exported SQL
against 100,000 live receivers, then adds 105 expired receivers and checks
100/5/0 deletion batches and preservation of all live rows.

Measured receiver buffer counts were 3 (all live), 758 (100 deleted), 95 (5
deleted), and 6 (drained). All remain below the 2,000-buffer regression threshold.
The same run revalidated owner expiry. Server typecheck, three PostgreSQL
acceptance cases and four receiver-store tests pass. These bounded query-shape
checks do not establish multi-worker cleanup budgets, adversarial lock contention,
six-month churn, or the full hint-driven lifecycle and capacity gates.

### Scheduled Revision Hint Repair

The existing fanout timer now invokes a gated revision repair pass. It traverses
at most twenty interest rows by primary-key cursor before filtering for local
ownership, live expiry, available delivery claims and unacknowledged catalog
watermarks. It starts at most eight delivery attempts and stops starting work
after five seconds; an in-flight RPC can outlast that budget. Claims recheck
authority and current catalog state before sending through the existing trusted
fabric path. Unknown outcomes retain durable claims; one failed recipient does
not retry per collaborator or prevent later candidates from being examined.

This is restartable bounded repair over interest state, not the source-write
outbox or a high-fanout capacity solution. Restarting may revisit rows safely;
completed traversal wraps to discover work behind the cursor. No account
membership enumeration or demand creation is added. Source-write scheduling,
home catch-up activation/completion, distributed quotas and fairness under large
interest populations remain open. Projection polling is still retained.

Server typecheck and forty server repair/dispatch/API tests plus nine PGlite
interest-store tests pass. Coverage includes attempt limits, continuation and
wrap, inactive candidates, failure isolation, disabled gates, owner filtering,
pending catalog state and suppression while a delivery claim is live. Full
authenticated scheduled lifecycle and large-scale repair latency remain unproven.

### Authenticated Revision Repair Delivery

Extended the isolated PostgreSQL/fabric harness to invoke the repair worker,
not just a hand-selected dispatch call. The new case registers home demand and
a receiver, changes the owner watermark, runs repair, and verifies both the
owner's current acknowledgement and exactly one durable home dirty-sequence
increment. A second pass sends nothing; expiry followed by another catalog
change also sends nothing. The receiver's applied sequence remains zero,
explicitly distinguishing durable wakeup receipt from completed projection work.

The worker fixture temporarily enables repair scheduler flags and restores
them afterward. Server typecheck passed. The full nineteen-case demand suite
passed, then the final independent setup was validated by running the new case
alone (one passed, eighteen skipped). This demonstrates real routed repair
delivery, not timer timing, source-write triggering, home projection catch-up,
or capacity under a large interest population.

### Reverse Active Project Scheduling Index

Added rebuildable account-home `collaboration_project_demand` rows, populated
in the claiming transaction only for active jobs selected by the shared-demand
prototype. Each row records the maximum grace horizon of demand scopes covering
that exact project, not another project's demand. The project/expiry/account
index is intended to support bounded wakeup consumers without scanning every
historical collaborator. An expiry index supports subsequent bounded cleanup.
There is no project FK because the project may belong to another bay.

These rows are scheduling hints only: they confer no authorization, do not
create demand, and require independent current-home/scope/membership checks at
use. They currently cover claimed projects, not every newly acquired scope;
initial catch-up still uses the existing activation path. Bounded consumption,
renewal behavior once polling is removed, and expiry cleanup are not implemented
yet. This step does not close the receiver-to-projection lifecycle gate.

Server typecheck, fifty projection-store tests and seven ownership-registry
tests pass. The cohort test verifies reverse entries for both active accounts,
their matching demand horizons, and no entry for the cold historical account.
An initial parameter-type ambiguity was caught and corrected with explicit UUID
casts. Jest emitted its open-handle warning but exited successfully.

### Bounded Reverse Demand Reader

Added a project-scoped keyset reader over live reverse-demand rows. Candidate
selection is capped at twenty before current-home, banned/deleted-account,
current project-scoped demand and projected-membership checks. Its expiry/account
cursor preserves database timestamp precision, and filtered candidates still
advance pagination. Reads grant no access or scheduling authority across later
state changes. Renewal can move a candidate after the cursor, so consumers must
tolerate duplicates and repeat a traversal when needed.

Database typecheck and fifty projection-store tests pass. New assertions cover
single-row pagination across two active accounts, end-of-traversal behavior,
wrong-home exclusion, page-limit validation and removal of current demand while
the reverse row remains. Receiver wakeup scheduling, durable traversal completion,
expiry cleanup and PostgreSQL scale validation for this reader remain open.

### Home-Fenced Wakeup Scheduling Operation

Added a scheduling operation that re-enters the existing account-home/rehome
fence, takes the account queue before project access locks, and rechecks current
project demand and projected membership through the existing membership-demand
scheduler. It returns `scheduled`, `inactive`, or `busy`. Live projection or
access claims return busy rather than advancing due times that an in-flight
apply could overwrite. A consumer must retain/retry that work; scheduling is
not completed projection catch-up.

Server typecheck and fifty projection-store tests pass. Assertions cover a live
claim refusing scheduling, removed demand remaining inactive, and an eligible
idle account/project moving from a future due time to due now. Jest emitted its
open-handle warning and exited successfully. Receiver durable traversal and
completion integration, cross-process races, expiry GC and scale gates remain
open; this operation is not yet called automatically for received hints.

### Durable Receiver Scheduling Progress

Receiver rows now separately retain a scheduling sequence, CAS version,
project-demand continuation and scheduling-complete bit. New dirty sequences
read as a fresh traversal. Advances require the exact receiver identity, live
lease, owner/home tuple, dirty sequence and prior version. A completed scheduling
traversal cannot be reopened by a stale worker; another hint or lease arm creates
a new dirty sequence and requires traversal again. Null continuation records
only scheduling completion and never updates `applied_seq`.

Database typecheck and five receiver-store tests pass. The new test covers
durable continuation, competing/stale advances, completion, new-hint reset,
lease replacement and unchanged projection-completion state. The page worker
must still be integrated, must retain pages with busy/failed accounts, and must
not claim view freshness from this scheduling state. Real concurrency, contention
budgets and full catch-up/scale validation remain open.

### Automatic Wakeup Page Scheduling

Gated maintenance now traverses receiver rows and handles at most one project
demand page per pass, containing at most twenty eligible accounts. Per-project
continuation remains durable; the process-level project cursor supplies bounded
traversal across projects. Completed scheduling states are skipped. The worker
stops starting account operations after five seconds, but an in-flight database
operation may outlast that budget.

Each account is rechecked through the home-fenced scheduling operation. Busy or
failed accounts retain the entire page for retry; other accounts on that page
may still be scheduled. Only a fully handled page attempts the CAS continuation
advance. Missing/newer receiver state cannot be cleared by that stale update.
The worker does not update `applied_seq` and does not assert view freshness.
Existing projection polling remains in place.

Server typecheck and thirty-eight worker/API tests pass. Focused tests cover
schedule-before-advance ordering, busy/failure retention, empty filtered-page
continuation and completed/disabled suppression. Authenticated wakeup-to-applied
projection validation, restart/concurrency behavior, cold-index GC and the full
source-to-sleep-to-return and capacity gates remain open.

### Authenticated Wakeup To Scheduling

The real PostgreSQL/fabric repair test now seeds reverse demand through the
active projection claimant, rather than inserting reverse rows directly. After
owner revision change and routed hint delivery, a live projection claim keeps
the scheduling page incomplete. The fixture then expires that claim and moves
its job due time into the future. Running the actual wakeup scheduler across a
bounded cursor wrap schedules the account exactly once and moves the job due
now. Scheduling completion is persisted, while `applied_seq` remains zero.

Server typecheck and all nineteen demand acceptance cases pass. An initial
fixture command typo was corrected before the final full-suite run. This extends
real-system evidence through job scheduling, not actual catalog application,
receiver catch-up completion, restart/concurrency or capacity validation.

### Authenticated Wakeup To Catalog Application

The real PostgreSQL/fabric test now adds a conversation resource at the changed
owner catalog revision. After the routed hint schedules the account, a fixture
command claims the due job and uses the production shared projection fetcher,
routed owner API and projection apply function. The home index must contain the
exact resource metadata. No fixture update makes the job due after the wakeup.
Applying this recipient page leaves receiver `applied_seq` unchanged: it is not
proof that all recipients have caught up.

Server typecheck and all nineteen demand acceptance tests pass. The initial run
rejected an invalid fixture entry key with the expected projection identity
guard; the corrected fixture uses the production canonical key function. This
validates catalog-to-home application, not source extraction, the full maintenance
loop, receiver-wide completion, restart/rehome recovery or capacity. Those gates
remain open and the prototype remains disabled by default.

### Reverse-Demand Expiry Lifecycle

The gated receiver-maintenance cadence now also prunes up to 100 expired local
`collaboration_project_demand` hints, with a 30-second per-process cooldown and
no new timer. The query uses the expiry index, a stable `now()` candidate bound,
row locking with `SKIP LOCKED`, an exact expiry recheck, and transaction-local
one-second lock/two-second statement timeouts. This is disposable scheduling
state, including obsolete local copies after rehome; it does not delete canonical
account state or access grants. Failed reverse cleanup retains hints and does not
discard the successful receiver-cleanup result.

Server/reference typecheck, seven maintenance tests and four real PostgreSQL
expiry acceptance tests pass. With 100,000 live reverse hints, production SQL
touches 3 buffers for no expired rows, 739 for a 100-row deletion, 75 for the
remaining 5 rows and 5 after draining. All live rows remain. A separate connection
holds an uncommitted renewal of an expired row while the production cleanup
function runs; it skips that row and preserves it after renewal commits.

This closes the reverse-hint deletion gap, not the full demand lifecycle. Reverse
hints are still refreshed through claimed projection jobs. Independent renewal,
removing polling, receiver-wide catch-up and rehome/restart validation remain
open. The cooldown is not a distributed bay quota; backlog drain rate and
multi-worker churn still need capacity/soak measurements before rollout.

### Automatic Consumer Expiry And Delete-Plan Cost

Consumer lease cleanup previously had no maintenance caller. It now runs on the
same gated cooldown as reverse-hint cleanup, deleting at most 500 expired rows
per pass with one-second lock and two-second statement timeouts. Its failure is
isolated from the other cleanup results. Live/grace leases remain untouched.

A real PostgreSQL fixture with 100,000 live consumer rows and 505 expired rows
exposed a delete-plan problem: even with indexed candidate selection, the key
join touched 1,648 buffers on a drained pass. Deletion now uses the bounded set
of locked tuple IDs within the same statement, avoiding that broad second join.
Measured buffers are 3 for the initial no-expiry pass, 2,450 for deleting 500,
478 for deleting the final five and 11 after draining. All 100,000 live rows
remain. This deliberately oversized per-account fixture measures SQL behavior,
not admissible API usage or a DAU workload.

Server/reference typecheck, eight maintenance tests and all five PostgreSQL
expiry tests pass. Demand activation-row retention, distributed cleanup budgets,
long-running churn, and independent lease/interest renewal remain separate open
gates; this does not establish full cold-account lifecycle completion.

### Dormant Scheduler Queue Cost

Activation and account-claim candidate selection now use a stable transaction
time bound, allowing the due-time indexes to exclude future rows. Actual demand
eligibility and rescheduling continue to use current clock time; this change
does not extend demand or access validity. Exported SQL is shared by production
and the query-plan tests.

The dormant scale fixture now includes activation queue rows as well as historical
memberships/access rows. Half of the queue rows are retired (null due times) and
half are future-due. At both 100,000 and one million rows, activation, projection
claim and access claim each touch three buffers when no work is due. Existing
bounded cleanup checks also pass, and maintenance produces no owner RPCs or new
access grants for the dormant population.

Server/reference typecheck and all three real PostgreSQL dormant-scale cases
(zero, 100,000 and one million memberships) pass; the full fixture took about
321 seconds. This verifies no-due query behavior, not a due backlog, foreign-home
or banned-account skew, contention, active DAU throughput, or a churn soak.
Retired queue-row storage retention remains open.

### Ineligible Due-Claim Backlogs

Projection/access account claims now bound the due candidate set before checking
account home, deleted/banned state or live demand. Up to eight locked local hints
are examined per batch. Ineligible hints have that claim due field retired to
null, rather than remaining at the front of the queue or forcing an unbounded
scan to locate eight eligible accounts. This changes disposable local scheduler
state only; it does not modify remote authority or grant access. Later explicit
activation can enqueue the account again.

Server/reference typecheck and all twenty real PostgreSQL demand acceptance
tests pass. The new case places eight foreign-home and eight banned accounts,
all with live demand, ahead of one eligible home account. Two bounded batches
retire the ineligible hints and the next reaches the warm account for both claim
kinds. This is functional skew evidence, not a large-skew throughput benchmark.
Activation dispatch still needs equivalent bounded-before-filter handling; the
full-tip large-population suite and contention/rehome races remain open.

### Bounded Activation Dispatch

Activation dispatch now also limits and locks eight due candidates before
checking account eligibility. A data-modifying CTE retires foreign-home, banned
or deleted local hints by clearing their activation due time; eligible rows are
returned in due order and still enter the account-home-fenced activation path.
No remote account state or project permissions are changed.

Server/reference typecheck and all twenty real PostgreSQL demand acceptance
tests pass. The ineligible-backlog case now exercises the exact activation SQL:
two bounded passes retire sixteen foreign/banned hints, then the next selects
the eligible account. These are functional bounded-progress checks. Large-skew
query plans, concurrent rehome/activation and full-tip workload/soak validation
remain open; prior million-row measurements predate this query revision.

### Current Scheduler Large-Backlog Measurements

The complete dormant-scale suite was rerun after bounded-before-filter changes.
At one million historical memberships/queue rows, activation, projection claims
and access claims each still touch three buffers when no work is due. Maintenance
still produces no dormant-account owner RPCs or new access grants.

The fixture then marks 100,000 of those accounts banned and makes all three
queue fields due. Exact production queries touch 66 buffers for activation,
242 for projection claiming and 234 for access claiming. Each retires exactly
eight ineligible hints. All four scale cases and server/reference typecheck pass;
the fixture took about 324 seconds. These measurements supersede the earlier
note that the million-row evidence predates the query revision.

This establishes bounded query work for the measured ineligible backlog, not
whole-backlog drain latency, concurrent state changes, distributed budgets or
active-user throughput. The atomic catalog invalidation/source-write path and
the remaining recovery, workload and soak gates are still unfinished.

### Atomic Catalog Invalidation Prototype

Added an explicitly installed, project-owned revision outbox with one coalesced
row per changed project. A trigger on catalog-state insert and generation/revision
updates commits the latest watermark and a replacement token in the same
transaction as the catalog mutation. Repeated edits retain the earliest due time
and reset recipient traversal; unchanged watermarks do not change the token.
The token is intended to fence future drain acknowledgments, including generation
resets where revision numbers are not comparable.

Database/reference typecheck, three PGlite outbox tests and seven ownership-registry
tests pass. Tests cover idempotent installation, coalescing, no-op preservation,
generation reset, rollback and project deletion. The ownership registry marks
portability unsupported pending explicit rehome/restore validation.

There is deliberately no startup installation or drain worker yet. This is the
atomic intent primitive, not completed source-change delivery: owner-fenced claims,
bounded destination traversal, token-conditional settlement, retry/unknown outcomes,
disabled-after-install behavior, real PostgreSQL concurrency and routed delivery
must precede enabling it. Existing repair remains unchanged.

### Owner-Fenced Outbox Claims And Settlement

The explicit outbox prototype now supports owner-fenced 30-second claims and
token/claim-conditional settlement. Each operation uses local lock/statement
timeouts. A continuation advances only to a later destination cursor and releases
the claim; completion removes only the exact live claimed marker. A newer catalog
mutation replaces the token, resets traversal and clears the old claim atomically.
Unknown outcomes retain the claim until retry eligibility, and expired/replaced
claims cannot clear pending work.

Database/reference typecheck and five PGlite outbox tests pass. Added coverage
checks wrong-owner rejection, competing claims, continuation reuse/regression,
newer-mutation fencing and expiry/reclaim. These tests do not yet establish real
PostgreSQL concurrent lock behavior or routed delivery. Candidate enumeration,
bounded recipient draining, lifecycle gating and real-system validation remain
open; startup still does not install this prototype.

### Explicit Outbox Page Delivery

Added an internal, explicitly gated outbox page dispatcher. It claims through
the owner fence, reads at most twenty recipient-interest candidates, and starts
at most eight routed deliveries within a five-second start budget. Deferred,
failed or unknown outcomes retain the page and claim for retry. A completely
handled page settles using the exact outbox token/claim; superseding mutations
cannot be erased. Existing recipient acknowledgments suppress repeat delivery
when a retained page is revisited. An in-flight RPC can exceed the start budget.

Server/reference typecheck, twelve focused dispatcher tests and all twenty real
PostgreSQL/fabric demand tests pass. The routed catalog-to-home test now installs
the prototype only in its isolated fixture and sends through the outbox instead
of the repair sweep. It verifies destination acknowledgment, marker removal,
home scheduling, exact catalog metadata application and repair suppression after
acknowledgment. Receiver-wide projection completion remains separate.

There is still no automatic startup installation or drain scheduler. Indexed
candidate discovery, fair multi-project scheduling, disabled-after-install and
restart/rehome/unknown-outcome integration tests remain required before rollout.

### Bounded Outbox Candidate Discovery

Added an expiry/due-index-oriented keyset reader for outbox scheduling. Each page
selects at most twenty due rows before joining project ownership and checking
claim availability. Foreign, deleted or busy candidates still advance the cursor;
discovery never grants authority and dispatch must retain its owner-fenced claim.
The cursor retains the database timestamp text to avoid losing microseconds.
Due-time mutation can cause revisits, which remain safe through claim checks.

Database/reference typecheck and all six PGlite outbox tests pass. New coverage
places twenty foreign projects before a valid project with microsecond-separated
due times, verifies continuation through that prefix, and confirms that claiming
the valid project removes it from immediate due discovery. Real query-plan cost,
concurrency and automatic scheduler integration remain open.

### Discovery-Driven Outbox Pass

Added a gated scheduling pass connecting bounded candidate discovery to one
eligible project page per call. It advances past foreign or failed candidates,
wraps at exhaustion, and guards overlapping calls in one process. The process
cursor is only a traversal optimization; durable outbox claims and recipient
cursors retain pending work across failures. Candidate admission stops after a
five-second start budget; an in-flight dispatch has its own bounded-attempt path
and may outlast that budget.

Server/reference typecheck, thirteen focused scheduler/dispatcher tests and all
twenty real PostgreSQL/fabric demand tests pass. The real catalog-to-home case now
invokes discovery-driven maintenance instead of passing a project directly to
the dispatcher, and still verifies marker removal and exact home metadata.

The pass has no independent timer and is not yet wired into ordinary startup.
Automatic installation, trigger disable/reenable semantics, restart/rehome
validation, distributed fairness and sustained source-change workloads remain
open before enabling this path.

### Opt-In Maintenance Lifecycle Integration

Startup now installs the outbox only when the existing demand/revision prototype
gates and `COCALC_PEOPLE_REVISION_OUTBOX_PROTOTYPE=1` are enabled. The existing
fanout lifecycle invokes its bounded pass; no new timer is introduced. Notification
fanout, outbox and repair failures are isolated so one failed pass does not skip
the others. No deployment settings were changed.

Disable semantics are deliberately durable: the outbox flag stops its delivery
worker, not the installed capture trigger or existing repair fallback. Disabling
People stops both delivery workers. Installed capture continues coalescing actual
catalog changes so edits during disablement are not silently lost; this is not a
promise of zero database writes after opt-in. Full removal needs a separate
operator procedure and is not implemented here.

Server/reference typecheck, thirteen focused tests and all twenty real
PostgreSQL/fabric demand cases pass. The integration case disables the outbox
worker before a catalog edit, verifies pending intent and no wakeup from that
disabled pass, then reenables and verifies delivery through home application.
This does not yet test a real process restart or timer lifecycle, and rehome,
restore, distributed budgets and workload/soak gates remain open.

### Revision Outbox Process-Loss Recovery

The isolated PostgreSQL/fabric fixture now supports a separate owner processor
using the same durable database and live transport. A new acceptance case claims
a catalog revision marker, kills that processor with SIGKILL, and boots a fresh
process. The marker token and claim survive; maintenance does not dispatch while
the claim is live. After advancing its deadline in fixture SQL, stale settlement
is rejected and discovery-driven maintenance delivers the watermark to the real
account-home receiver. The marker is removed, dirty sequence advances exactly
once, and a subsequent pass finds no pending delivery.

Server/reference typecheck and all 21 real PostgreSQL/fabric demand tests pass.
Process loss is real; lease expiry is simulated for bounded test duration. This
does not exercise shared transport loss, automatic timer startup, recipient-page
cursor recovery, database restart, rehome or restore. Those lifecycle cases and
the broader scale/soak gates remain open; no production settings were changed.

### Maintenance Timer Lifecycle Boundaries

Seven focused fake-timer cases now exercise the actual maintenance startup/stop
functions with mocked storage and delivery dependencies. They verify idempotent
startup, explicit outbox schema opt-in, retry after initialization failure,
stop during initialization, isolation of fanout/outbox failures from repair, and
epoch fencing of both delayed startup failures and in-flight passes across
stop/restart. Stopping clears every tracked timer; an old callback cannot start
another repair pass or create a second recurring timer in the new lifecycle.

Server/reference typecheck and 20 focused lifecycle/dispatcher/scheduler tests
pass. This proves timer control flow, not live timer-to-database integration or
cancellation of already-started remote work. The separate real process-loss test
still supplies durable-claim evidence. Shared transport/database restart,
recipient-page cursor recovery, rehome/restore and scale/soak remain open.

### Live Maintenance Timer Integration

The isolated owner processor can now start and stop the production maintenance
loop. A real PostgreSQL/fabric case commits a catalog revision, starts maintenance,
and observes automatic account-home dirty-sequence advancement and outbox removal
without manually invoking a dispatch pass. After stopping and allowing started
work to settle, a second change stays pending across a timer interval; restarting
maintenance delivers it and removes the marker. Fixture shutdown stops timer
admission before closing database pools.

Server/reference typecheck and all 22 real demand acceptance tests pass. The
observation uses a bounded 15-second convergence deadline, not a performance SLO.
Outbox delivery and its repair fallback are both enabled, as in production
maintenance; this case validates their integrated lifecycle rather than isolating
which path delivered a particular hint. No production flags changed. Shared
transport/database restart, recipient-page cursor recovery, rehome/restore,
source-write integration and scale/soak gates remain open.

### Explicit Discovery Also Stops Legacy Inventory Polling

Inspection found that mediated filesystem writes already persist write-ahead
source intent, but the host's legacy discovery callback still repeatedly fetched
owner source pages and dirtied retained journal sources even when explicit census
scheduling was selected. `COCALC_PEOPLE_CENSUS_EXPLICIT_PROTOTYPE=1` now selects
both behaviors consistently for the service lifetime: no inventory-driven census
admission and no legacy source-inventory polling. Default behavior is unchanged.
Dirty journal entries, interrupted writes, delivery retries and explicitly
requested census work continue through their existing processing paths.

Host/reference typecheck, 20 host/census tests and 33 backend service/filesystem
tests pass. The new host test verifies no owner RPC, retained-inventory lookup or
filesystem open from explicit discovery. A service test reopens durable
interrupted-write intent, processes it without inventory, verifies no further
reads/sends across 20 clean intervals, then coalesces two new dirty signals into
one read. Existing census tests cover explicit admission separately.

This is still an opt-in prototype, not a complete cutover: arbitrary terminal
writes need validated fallback observation or explicit reconciliation, and a new
or restored journal needs explicit bootstrap/rebuild. Do not enable broadly until
the activation/bootstrap, missed-signal and lifecycle gates are demonstrated.
No trustworthy no-change filesystem token has been established, and none is
assumed by this change. No deployment flags were changed.

### Combined Census Handoff And Delivery Recovery

A new integration case connects the real SQLite census store/producer, source
journal, extraction/delivery service and coverage reporter. It injects a lost
candidate-handoff acknowledgement and a lost ingest acknowledgement in the same
pass, closes both stores, and reopens them. The retained candidate is acknowledged
without a second extraction or registration, the original delivery payload is
retried exactly, and coverage becomes complete only after pending work clears.
An additional idle pass neither opens a directory nor extracts/sends the source.

Backend/reference typecheck and 31 focused tests pass. Directory enumeration and
remote transport are fixture seams here; this proves composition of durable local
handoff and delivery state, not process-kill, real filesystem traversal or remote
catalog behavior. Those have separate evidence and remaining integration gates.

Cold-work inventory also identified a remaining telemetry dependency:
`censusReporter` sends a new sequence every 30 seconds even for unchanged completed
runs, while the owner marks reports unavailable after 30 minutes. Suppressing
heartbeats alone would change visible freshness semantics. A demand-aware status
contract and bounded scheduling are still required before claiming dormant
projects have no recurring report work; this change does not remove that work.

### Change-Only Telemetry Prototype

Explicit host discovery now opts into change-only census reporting. Once a report
is acknowledged, identical progress does not allocate another sequence, write a
report checkpoint or call the owner. Changed progress retains the existing
30-second send bound. Unacknowledged reports bypass suppression and retry their
exact durable payload before newer progress, including after reopening the store.
Legacy inventory mode and Lite keep their heartbeat behavior.

The owner's existing 30-minute stale-status rule is deliberately unchanged. Thus
a quiet prototype project can show unavailable/stale discovery while retaining
its last report; silence is not evidence of an unchanged filesystem. This is not
the final demand-aware freshness UX and remains a broad-enablement gate. The
bounded reporter still visits local project metadata and persists its traversal
cursor; this change removes redundant remote reports, not all cold local work.

Host/reference typecheck, 10 backend reporting/integration tests and 21 host/census
tests pass. New cases cover seven simulated quiet days and store reopen without
report writes/RPCs, changed progress, lost-ACK ordering and explicit host wiring.
No deployment flags changed and no load/capacity claim follows from these tests.

### Indexed Local Source Progress

The journal's progress query previously visited every source in a project to
count dirty/unregistered sources, pending deliveries and failures. It now counts
indexed pending/error subsets and joins pending deliveries to existing sources.
The union deduplicates sources that are both dirty and awaiting delivery;
redirected sources and orphan deliveries retain their previous exclusion rules.
Partial indexes are installed additively when opening the host-private journal.

A real SQLite test seeds 20,000 clean source rows across two projects, checks the
exact production query plan uses both partial indexes without full source or
delivery scans, and verifies counts across dirty, registration, delivery, error
and redirect transitions. This is access-path evidence, not a DAU benchmark.
Backend/reference typecheck and all 274 backend collaborators tests pass.

Progress counting now scales with relevant pending/error work rather than the
clean catalog size. Large pending backlogs still cost proportional work, and the
reporter's bounded project traversal/cursor persistence remains; a durable
change-driven reporting queue and demand-aware freshness are not yet implemented.

### Durable Journal Progress Signal Primitive

Added an optional SQLite primitive for the reporting-queue handoff. Installation
atomically adds triggers and adopts existing source projects once. Source
progress, pending-delivery and redirect changes coalesce into one token-bearing
row per project in the same transaction as the mutation. Relevant no-op updates
do not replace the token; project deletion retains a final signal. Bounded keyset
pages and exact-token acknowledgement let a future cross-store consumer enqueue
report work before acknowledging, without erasing newer changes.

Reopening preserves pending signals and does not reseed acknowledged projects.
Capture remains after installation even if a consumer stops. This primitive is
not installed by normal startup or wired to a reporter yet; reporting still uses
its existing bounded traversal. Census-store changes also need their own durable
admission, and lifecycle/retention behavior must be integrated before cutover.

Backend/reference typecheck and the focused real SQLite signal, progress-query
and combined handoff tests pass. Signal coverage includes transactional rollback,
coalescing, stale acknowledgement, reopen, source/delivery/redirect removal and
bounded paging. No production installation or capacity claim was made.

### Queue-Driven Change-Only Reporting

The explicit host prototype now lazily installs the journal signal primitive and
a census report queue when change-only reporting first runs. Census mutations
enqueue transactionally; report-checkpoint writes do not trigger themselves.
Queue rows coalesce by project while preserving retry deadlines, and exact-token
settlement cannot erase newer progress. Existing census runs are adopted once,
not on every reopen. Removing a run cascades its queue row.

The consumer handles a bounded journal-signal page, durably enqueues census work,
then acknowledges the exact journal token. A lost acknowledgement can safely
repeat the handoff. Sources without a census have no report target; a later census
insertion creates its own work. Due report pages replace historical-project
traversal. Uncertain sends keep their original payload and cooldown; after a
successful send, one post-cooldown comparison retires unchanged progress.

Tests verify that settled projects receive no status/progress reads, inventory
lookups or persisted traversal-cursor writes across simulated quiet days. Other
cases cover transactional rollback, backoff preservation, stale settlement,
reopen, deletion, due-index selection, lost cross-store acknowledgement and
disablement during report preparation. Host/reference typecheck, all 279 backend
collaborators tests and 21 focused host tests pass.

This supersedes the earlier unwired-primitive notes. Capture persists after first
installation even if the consumer is disabled. Installation/adoption and trigger
overhead still need realistic load measurement, cross-store process-kill tests
remain open, and owner status still becomes stale after 30 minutes of silence.
No deployment flags were enabled; demand-aware freshness, rebuild/rehome and the
full workload/soak gates remain required before broad use.

### Cross-Store Reporting Process-Loss Evidence

A child-process test now runs built production modules against isolated SQLite
stores and receives SIGKILL at two boundaries. First it dies after durable census
enqueue but before journal acknowledgement: both queues survive. A fresh child
repeats that handoff safely, prepares the immutable report, and dies inside the
send callback before acknowledgement persistence. Reopening shows the original
unacknowledged payload and retry deadline. Recovery makes no early send, then
replays exactly that payload without looking up a new owner CAS; unchanged work
is retired after the cooldown.

Backend/reference typecheck and 15 focused reporting/signal tests pass. The child
does not cleanly close either WAL. Clock advancement is simulated, and the send
callback records bytes locally rather than contacting a live owner. This closes
the local cross-store process-kill gap, not remote acceptance, rehome/restore,
installation cost or scale/soak gates. No deployment changes were made.

### Dormant Report Queue Cost Fixture

`COCALC_PEOPLE_SCALE_ACCEPTANCE=1 pnpm exec jest --runInBand --runTestsByPath
collaborators/census-report-scale.test.ts` (backend package) now measures isolated
SQLite reporting with 0, 10,000 and 100,000 historical project/source rows. Bulk
fixture insertion is excluded. First-install adoption is measured separately;
the fixture then directly drains adoption rows to model settled history, not to
claim initial delivery throughput. Each sample runs 100 real idle reporter calls.

| Historical projects | Queue adoption ms | Idle p50 ms | Idle p95 ms | 1,000 mutations without signals ms | With signals ms |
| ------------------- | ----------------: | ----------: | ----------: | ---------------------------------: | --------------: |
| 0                   |              5.88 |       0.037 |       0.066 |                                n/a |             n/a |
| 10,000              |             47.06 |       0.037 |       0.061 |                               6.53 |            9.60 |
| 100,000             |            463.83 |       0.037 |       0.060 |                               9.00 |            9.62 |

Mutation timings are 1,000 dirty-bit toggles for one source in a **single
transaction**, not independent fsynced writes. They measure a narrow trigger
microbenchmark and are not ingestion throughput. All idle cases assert zero
project-status/progress reads, persisted traversal-cursor writes and owner RPCs.
A final dirty signal for one project produces exactly one status/progress read
and one report, independent of the historical population.

Backend/reference typecheck and all three gated scale cases pass. These numbers
describe this local warm-cache SQLite fixture only; they do not establish DAU
capacity, realistic per-host density, cold-cache behavior, concurrent source-write
cost, initial adoption delivery latency or six-month storage growth. Startup
adoption remains linear and needs a bounded migration policy before large-scale
enablement. The full workload matrix and soak remain open.

### Bounded Historical Report Adoption

The preceding one-shot adoption implementation is now replaced by persisted
keyset adoption. Each queue constructor admits at most 16 historical projects;
each change-only reporter call subsequently admits at most `batchSize` per queue
(default 16, maximum 100). Its first call can therefore admit constructor plus
reporter pages. Each project uses an indexed seek past the previous project,
rather than traversing all source rows with DISTINCT. Completion makes subsequent
adoption calls read-only. Installation enables transactional change capture before
adoption; conflict handling preserves newer tokens and retry deadlines. Existing
fully seeded queue schemas migrate as already adopted.

Backend/reference typecheck and all 281 backend collaborators tests pass. New
coverage checks partial adoption across reopen, no replay of acknowledged rows,
preservation of newer signals, writes behind the cursor, a project with 1,000
extra sources, indexed seeks, invalid bounds and migration from the old schema.
All three gated scale fixtures also pass:

| Historical projects | Initial install ms | Remaining adoption ms | Paired 100-project pages | Idle p50 ms | Idle p95 ms |
| ------------------- | -----------------: | --------------------: | -----------------------: | ----------: | ----------: |
| 0                   |              14.69 |                  0.38 |                        1 |       0.065 |       0.098 |
| 10,000              |              12.92 |                697.17 |                      100 |       0.061 |       0.091 |
| 100,000             |              92.32 |               6534.71 |                     1000 |       0.064 |       0.107 |

Remaining adoption is deliberately run to completion in this fixture, not in a
production timer pass. Total migration still costs O(projects), with more
transactions than the former one-shot seed, but no single adoption page visits
the whole historical population. The row bound is not a wall-clock deadline:
schema installation, SQLite lock waits and commits can exceed the cooperative
reporter time budget. Initial installation timings are not constant-time claims.
Fixture draining still bypasses delivery, so these results establish neither
initial delivery latency nor DAU capacity. No production mode was enabled. The
full workload matrix, lifecycle integration and soak gates remain open.

### Independently Scheduled Scan Dispatch

`startCollaboratorsMaintenance` now installs the Scan schema and a separate
one-second-after-completion timer when `COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE=1`
at startup. No timer or Scan schema is installed without that explicit opt-in.
Each tick also checks the current prototype flag and `collaborators_enabled`.
Scan RPC latency does not serialize invitation fanout, projection maintenance,
or access renewal behind this worker. This schedules existing admitted jobs;
it does not enumerate historical projects or admit new requests.

The worker receives a lifecycle predicate and checks it before new bounded
retirement/dispatch steps. Stop invalidates old callbacks, and stop/restart does
not let an old completion schedule another timer. An already-started operation
may finish; it is not cancelled or misreported as failed. Durable claims and the
existing per-bay in-process exclusion retain overlap/retry protection. The
site-setting check occurs at tick entry, while lifecycle and prototype checks
also occur between worker steps. This is not instantaneous remote cancellation.

Server/reference typecheck and 30 focused tests pass across maintenance
lifecycle, Scan worker, dispatch, and PGlite durable-owner integration. New timer
tests cover slow Scan isolation, opt-in/default-off behavior, runtime flag
changes, failure retry, startup schema failure, and old-lifecycle fencing.
PGlite requires `NODE_OPTIONS=--experimental-vm-modules`; an initial invocation
without it failed before database setup and was rerun successfully with it.
Durable-owner tests exercise receipt replay, ambiguous admission recovery,
revocation and expired queued retirement, with mocked host transport; they do
not yet prove live timer-to-host traversal. Public Scan API/CLI/UI, scoped-agent
admission, demand/bootstrap integration and the broader validation gates remain
open. No live deployment configuration was changed.

### Routed Scan Receipt And Progress Inspection

Added typed service-only `inspectScanAtHome`/`inspectScanAtOwner` and
`scanStatusAtHome`/`scanStatusAtOwner` routes. Home routing checks the account's
current home and availability; owner routing checks the current project route
epoch and delegates to the existing current-member, own-live-receipt database
checks. The exact account/project/request/job identities are preserved. These
reads do not reserve admission tokens, clean receipts, contact a host or admit
work, and transport failures propagate rather than becoming a fabricated
unknown/failed outcome. They remain usable with dispatch paused, while the
People flag and ordinary authorization checks still apply.

The discovery-status union now lives in util (re-exported by the database
module) so clients need not import database implementation types. `discovered`
explicitly does not mean ingestion or account projection completion. These are
internal service methods, not yet public human or delegated-agent endpoints;
public polling budgets and identity binding remain required before exposure.

Server/reference typecheck, all 36 API routing tests and all 22 PGlite Scan store
tests pass. New routing tests cover exact identity forwarding, paused dispatch,
stale home/owner routes, disabled People, unknown/absent receipts, owner access
failure and transport timeout without resubmission. These routing tests mock
the transport/store boundary; the store suite separately verifies receipt and
membership behavior. Live multibay inspection and public API/CLI/UI integration
remain open, as do the wider plan gates. No deployment settings were changed.

### Account-Home Scan Inspection Budget

Startup now installs the account-home Scan reservation schema along with the
owner Scan schema under the existing startup opt-in. Both routed home inspection
methods use a separate shared account budget before contacting the owner. The
typed response distinguishes `allowed: false` plus `retry_after_ms` from an
allowed receipt/status value plus `poll_after_ms`. Receipt absence, unknown job
state and throttling are therefore not conflated. Owner internal reads remain
unchanged; public transport authentication is still not exposed by this change.

The initial policy is a burst of ten reads, refilling one per second, aggregated
across projects and processes at the authoritative account home. Polling uses
separate columns on the existing budget row under the account rehome write fence.
It neither spends nor resets admission tokens, creates admission receipts, nor
renews dormant state on a timer. Rejected budget checks do not update the row.
Clock rollback cannot mint tokens; replies include the future-clock delay.
Constant additive column defaults avoid a volatile timestamp default. This is
not a claim that all schema operations are lock-free.

Server/reference typecheck, 46 API/lifecycle tests and seven PGlite actor-budget
tests pass. Coverage includes independent budget accounting, capped refill,
future clocks, rejected-poll immutability, wrong-home/banned/deleted actors,
startup opt-in and skipping owner calls when throttled. A deleted-account error
expectation was corrected to match the pre-existing fence's earlier rejection.
These checks do not establish load capacity or bound an attacker’s total DB
traffic: transport-level admission/concurrency limits and real multi-process
contention validation remain required. Public API/CLI/UI and scoped-agent
authorization remain open; no production flags were changed.

### Public Human Scan RPC Surface

Added `collaborators.requestScan`, `inspectScan`, and `getScanStatus` to the
typed hub API and server exports. All require authenticated account identity
injected by the standard auth transform; agent/project/host/anonymous principals
are rejected. Wrappers explicitly reconstruct the request instead of forwarding
caller-supplied routing fields. Admission routes through account-home reservation
and project-owner authorization; inspection uses the shared home polling budget.

Public access additionally requires `COCALC_PEOPLE_SCAN_API_PROTOTYPE=1` and
`collaborators_enabled`. New admissions also require the existing dispatch
prototype flag. For an isolated fixture, initialize maintenance with
`COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE=1` to install both schemas before enabling
API access; pausing dispatch afterward still permits receipt/status inspection.
No configuration was enabled in this change. Public Scan wrappers are excluded
from the automatic public-to-inter-bay method mapping because Scan has explicit
home/owner service methods, not duplicate public wrappers on every bay.

An ingress process allows at most 32 in-flight Scan calls and two per account
across all three methods, with no waiting queue. Slots are released on success
or failure; durable account/owner budgets remain authoritative across processes.
This bounds concurrent ingress work, not total rejected-request traffic or
cluster-wide ingress concurrency. No fresh-auth/browser-only requirement was
added: the boundary is account authentication plus ordinary project access.
Delegated-agent support still requires its explicit reviewed scope. Standalone
Lite returns a clear unsupported error for these owner-routed operations.

Server and Lite/reference typechecks pass, along with 79 Conat auth/API tests,
39 server routing tests and 41 Lite store tests. New coverage verifies identity
binding/principal rejection, default-off behavior, authoritative routing,
inspection while dispatch is paused, per-account/global in-flight limits,
failure-slot release, and Lite rejection. These are not live multi-bay or
scoped-agent acceptance tests. CLI/UI, demand/bootstrap integration and the
remaining design/validation gates are still open.

### Scan CLI Commands

Registered `project scan request`, `project scan inspect`, and `project scan
status` using the existing account-context and project-resolution paths. Request
accepts an optional stable request UUID and `check`/`reconcile` mode, prints the
exact identity before submission, and includes it in structured output.
Inspection requires the request UUID; status requires the receipt's job UUID.
Neither command submits, retries or automatically polls. Server throttling and
polling guidance remain structured, and discovery completion is not presented
as owner/home indexing completion. Invalid inputs fail before authentication.
An agent-runtime identity explicitly fails before context creation, avoiding
credential fallback while delegated Scan scope remains unimplemented.

CLI/reference build and test compilation pass. Nine focused CLI tests pass,
including adjacent room commands and new coverage for generated/stable identity,
ambiguous submission without retry, read-only throttled inspection/status,
invalid input and agent rejection. Dependencies and transport are mocked in
these command tests. No live Scan was requested and no production configuration
was changed. User-facing recovery semantics are documented in the CLI README.
Live CLI-to-owner/host validation, UI, delegated-agent authorization,
demand/bootstrap integration and the broader workload/lifecycle gates remain
open.

### Public Scan Routing On Real PostgreSQL And Fabric

Extended the isolated Scan acceptance harness to invoke the real public hub
argument transform and API wrapper in bay B, route to account home A, and then
to a separate project owner over authenticated inter-bay transport. The fixture
overrides a forged account identity with its synthetic authenticated account and
rejects an agent principal. It verifies stable admission replay, exact receipt
inspection, queued discovery status, unknown request inspection, and polling
throttling from the durable home budget. Repeated reads leave exactly one owner
receipt and one home reservation; supplied route fields cannot redirect them.

`COCALC_COLLABORATORS_ACCEPTANCE=1 pnpm exec jest --runInBand --runTestsByPath
collaborators/scan-scale.acceptance.test.ts` passes all seven cases in 54 seconds.
The suite also retains real PostgreSQL reservation/lease races, retirement races,
lock-timeout recovery, and bounded selection over 10,000 blocked jobs and 100,000
receipts. Server/reference typecheck passes. All databases, identities and work
are isolated fixture state; no production settings were changed.

The public wrapper and transform are invoked inside the test worker, not through
an installed CLI or a browser login. Inter-bay RPC is real, but this new case
stops at queued work rather than host traversal/extraction or home projection.
It is routing/receipt evidence, not full vertical Scan completion or a capacity
claim. Live CLI/host execution, UI, scoped-agent authorization and the remaining
plan gates remain open.

### Explicit Hosted Discovery Through Owner And Home

Added an isolated host acceptance case starting the host in explicit census mode.
It seeds a chat file directly in the fixture volume, bypassing mediated-write
hooks, obtains a real public Scan receipt through the home/owner path, and invokes
the production host reconciliation control adapter with that run identity. Real
sandboxed traversal, journal extraction, owner ingestion and account-home
projection then produce the discovered resource. The test also waits for the
host's `discovered` state with zero pending candidates, replays the same run ID,
and verifies zero compute-start calls on all bays.

`COCALC_COLLABORATORS_ACCEPTANCE=1 pnpm exec jest --runInBand --runTestsByPath
collaborators/scan-host.acceptance.test.ts` passes in 47.5 seconds. Project-host
and server/reference typechecks pass. An initial test switched an already-running
legacy inventory host into explicit mode and correctly hit ENODEV on its old
unavailable-volume census. The fixture now selects explicit mode at startup;
no production stale-volume fence was weakened to make the test pass.

This uses real isolated PostgreSQL, SQLite, inter-bay traffic, sandboxed local
files and production indexing code. The directory has a synthetic recorded
volume identity: it is not evidence of btrfs generation or restore correctness.
The host-control adapter is invoked through parent fixture IPC, not the full
owner dispatcher/privileged host-control transport, and owner receipt settlement
is not claimed by this test. Ticks are driven by the acceptance harness. Full
timer/transport/settlement integration, installed CLI/browser execution, UI,
agent scopes and the remaining plan gates remain open. Production settings are
unchanged.

### Owner Dispatch Through Real Host Control And Receipt Settlement

Extended the explicit hosted discovery acceptance case to install the production
host-control service on the host's authenticated owner-bay connection. The test
now invokes the real bounded owner dispatch pass rather than admitting the run
directly through fixture IPC. Ownership resolution, dispatch claims, host status
inspection, reconciliation admission and owner settlement use production code.
After real traversal/extraction and home projection, the test observes the real
five-second dispatch cooldown and verifies public status is `discovered` through
the ingress/home/owner path. A subsequent pass finds no work for the settled job.
The host adapter remains directly callable only for diagnostic status and replay
assertions. Compute-start counters remain zero.

The combined `scan-host.acceptance.test.ts` and `scan-scale.acceptance.test.ts`
run passed all eight tests in 108.7 seconds, including the final empty-pass
assertion. Server and project-host reference typechecks passed.
This exercises the supported owner-bay control-subject route, with a recorded
host owner but no direct-host URL. It does not validate the direct-host token
route, autonomous timer scheduling, installed CLI authentication, real btrfs
identity/generation behavior, or production capacity. All data and credentials
are synthetic fixture state; no production settings changed. The broader plan,
including demand integration, recovery, agent scopes, UI and scale/soak gates,
remains incomplete.

### Capability-Gated Project Scan UI

Added a Scan control to the selected project in People. The account-home check
advertises `scan_supported` only when both Scan API and dispatch prototype flags
are enabled. The existing revision poll updates this capability even when the
directory revision does not change. Older servers and clients without the three
Scan methods expose no control. Server authorization and project-owner admission
remain authoritative; capability advertisement is not a permission grant or a
guarantee that a particular remote host is available.

The control requests bounded reconciliation, saves the exact request identity in
account/project-scoped browser session storage before submission, and exposes
read-only receipt recovery and status checks. It preserves the identity on
timeout and throttling. There is no automatic retry, admission on mount, or
background status polling. Server cooldown hints disable buttons temporarily;
the only new timer updates the local countdown and stops at expiry. Session
storage failure prevents submission. Recovery survives remount/reload in the
same browser tab; this is not cross-device or closed-tab persistence. Inspectable
request/job identifiers remain available for CLI recovery.

Discovery completion is explicitly distinguished from account-view freshness.
Terminal/unknown status allows an explicit new request rather than silently
launching one. Native controls, a live status region, terminal focus handling,
wrapping layout and standard theme-aware Ant Design controls are used.

Validation: 13 focused frontend tests pass, covering keyboard admission/status,
focus, cooldown, same-ID retry, lost-response remount recovery, account isolation,
unavailable session storage and capability changes. The 40 server API tests pass,
including default-off/both-flags capability checks. Server/reference and frontend
typechecks pass; frontend lint reports zero warnings/errors. Fake-timer interaction
tests were replaced by real cooldown timing after React/Ant Design scheduling
made those assertions unreliable. This is component evidence, not a live-browser
two-account, zoom or dark-mode audit; those remain required before enablement.
Automatic demand-triggered discovery, missed-write fallback, richer progress
watermarks, agent scopes, lifecycle and full scale/soak gates remain unfinished.
No production flag was enabled.

### Durable Host Deferral And Retry Hints

Host reconciliation previously returned busy/report-pending/cooldown results
that the owner discarded, leaving the UI reporting running work and retrying at
the ordinary five-second dispatch interval. The owner now stores a safe reason
and retry deadline on the active job, fenced by current project ownership, host,
run identity and an unexpired dispatch token. Stale workers cannot extend a newer
claim. Unknown host reason text maps to `host_deferred`; raw host diagnostics are
not included in public status. Every admission reply must match the exact run,
not only successful replies.

Both candidate selection and lease acquisition honor the durable deadline.
Host hints are clamped to five seconds through five minutes; busy/report-pending
responses use thirty seconds. After the deadline, a successful claim clears the
old reason. Authorized status reads retain the existing own-live-receipt and
current-membership checks and return the remaining delay without contacting the
host or creating work. The UI explains the wait and respects the greater of the
status-poll and host-cooldown hints. A transport exception remains an unknown
outcome with the existing lease; it is not converted into a failed Scan.

Focused validation passes: 23 database tests, 21 dispatcher/worker unit tests,
5 durable worker integration tests, and 7 frontend interaction tests. Server and
frontend reference typechecks pass. The new tests cover deferral bounds, stale
tokens/hosts, selection and claim suppression, clearing expired deferrals, safe
reason mapping, mismatched runs, durable retry suppression and UI cooldown copy.
All eight real PostgreSQL selection and hosted execution acceptance cases pass
in 111.6 seconds; frontend lint is clean. This adds truthful wait information, not complete progress counters,
view-applied watermarks or a production capacity claim. Broader plan gates remain
open and production flags are unchanged.

### Expired Receipt UI Recovery

Closed a UI dead end after reload with an expired saved request: inspection can
return no live receipt while retrying the same ID is rejected as expired. After
a successful empty inspection, the user can now explicitly forget the local
saved request. The explanation warns that earlier work may still be running;
forgetting neither cancels that work nor submits another request. Starting a new
Scan requires a separate action and saves a fresh identity before transmission.
An ambiguous inspection does not enable forgetting, and a new inspection clears
the previous empty-result affordance until it succeeds. Stored IDs now use the
shared UUID validator rather than a permissive character-only check.

Nine focused frontend tests pass, including keyboard reset, restored focus,
fresh-ID submission only after a separate action, and timeout identity retention.
Frontend typecheck and lint pass. This is component-level recovery evidence;
live browser and the broader indexing-plan validation gates remain open.

### Demand-Triggered First Discovery Prototype

Added opt-in bootstrap at the successful account-home revision-receiver
registration boundary. This boundary is already fed by bounded active projection
claims, not historical account enumeration. With
`COCALC_PEOPLE_DISCOVERY_BOOTSTRAP_PROTOTYPE=1` and Scan dispatch enabled, a live
receiver with no previous bootstrap acknowledgement checks the project's owner
discovery state. Only missing first discovery (`pending` with no report) requests
a Scan. An existing report suppresses initial scanning without asserting that
its coverage is complete or current. Unavailable state without a report defers
instead of replacing an unknown host run.

The receiver's durable UUID is the admission request identity across retries and
renewals. Admission uses the existing account-home actor reservation and owner
project budgets, current account/project authorization and coalescing. Home
demand is checked again immediately before admission. Expired/replaced receiver
leases cannot acknowledge completion; success means admitted or a report already
exists, not discovery/view completion. An owner change clears the acknowledgement.
Throttling and exceptions leave bootstrap retryable on later active renewal and
do not discard a valid revision receiver. No background timer or inactive-account
traversal was added. Schema is additive and installed with receiver schema.

The real multibay acceptance fixture starts in explicit-census mode, writes an
unmediated chat file, rejects registration without demand, then acquires demand
and registers through authenticated inter-bay transport. It observes one durable
bootstrap receipt, no duplicate on renewal, real owner dispatch/host discovery,
home projection, and zero compute-start calls. Expired demand cannot register
again. This drives the registration boundary explicitly; it is not yet a full
browser-to-autonomous-maintenance timing test.

Focused checks pass: 52 server bootstrap/API/registration tests, six receiver
database tests, and server/reference typecheck. The isolated multibay case passed
again in 52.7 seconds with the final immediate pre-admission demand recheck.
The flag remains off in production. Missed-write fallback,
automatic repair after unavailable/partial reports, receipt expiry recovery for
unacknowledged bootstrap, lifecycle portability, agent scopes and full scale/soak
validation remain required; this is not a complete automatic indexing scheduler.

### Autonomous Home/Owner Bootstrap Acceptance

Strengthened the isolated multibay bootstrap test to start the production home
and owner maintenance timers rather than directly invoking successful receiver
registration, Scan dispatch, or home projection. With 1,000 synthetic cold
account memberships present, the initial observation window produces no receiver
registrations or owner Scan jobs. Acquiring one real project demand lease then
causes receiver registration, durable bootstrap admission, owner dispatch, home
resource projection, and terminal discovery settlement. Only the active account
has an actor receipt, the owner retains one request, and no compute starts occur.
Expired demand is rejected at registration.

The acceptance case passes in 55.568 seconds; server/reference typecheck also
passes. Host extraction is still explicitly ticked by the fixture. This is
evidence for automatic home/owner scheduling, not a browser lifecycle test,
host-timer proof, sustained cold-account cost measurement, or DAU capacity result.
The cold population shares one project; high project fanout and long-duration
churn remain separate validation requirements. No production settings changed.

### Timer-Only Initial Discovery Acceptance

Removed the last manual host extraction tick from the same multibay acceptance
case. The fixture starts the production host service, whose normal two-second
timer drives extraction. After acquiring demand, the test now only reads state;
home, owner, and host production timers drive registration, admission, discovery,
extraction, publication, projection, and terminal receipt settlement. The case
passes in 56.539 seconds, retaining the cold-membership and zero-compute-start
assertions. Server/reference typecheck passes.

This supersedes the explicit-host-tick limitation above for initial discovery.
It still uses a synthetic source, isolated transport/database processes and
direct demand acquisition, not a browser session or production workload. Later
unmediated-write recovery, sustained cold-account cost, lifecycle portability,
and the broader scale/soak gates are not established by this test.

### Natural Btrfs Generation Visibility Follow-Up

Extended the opt-in live probe with bounded natural observation after a durable
overwrite. `COCALC_BTRFS_OBSERVE_MS` accepts 0 through 120000 milliseconds;
the default remains zero. Samples include elapsed time, verify the overwritten
bytes remain readable, and stop early on generation advancement. No filesystem
sync, snapshot, mount change, or preexisting-file mutation is performed. Repeated
read-only samples are excluded from the changed-bytes equality counterexample.

On the local btrfs mount with kernel `7.0.0-1011-gcp`, the finalized probe passed
with a 40000 ms budget in 7.634 seconds. Its generation remained equal through
six one-second post-overwrite samples, then advanced at 7078 ms. Truncate/fsync,
rename and unlink afterward all retained that new generation. An earlier run
observed advancement around one second. This is neither a latency bound nor
proof that our write caused advancement: the containing subvolume is shared
with other activity. It confirms that this marker can change naturally while
still lagging visible durable changes. Server/reference typecheck passes.

Code tracing also confirms that explicit census mode's prepare callback returns
without inventory scheduling, and acknowledged demand bootstrap does not repeat
discovery. Thus later unmediated writes still need a separate bounded repair
policy. Generation advancement can be a conservative dirty hint, but equality
cannot retire dirty work or certify freshness. The next scheduler must retain
periodic bounded reconciliation unless a stronger storage proof is validated;
simply restoring the historical all-volume hourly traversal is not the target.

### Active-Demand Conservative Repair

The opt-in discovery path now checks a durable repair deadline during existing
receiver renewal. It does not add a timer or enumerate historical memberships.
A live, bootstrapped receiver becomes eligible after one hour; its request UUID
is stored before admission and reused after timeout or throttling. Successful
admission clears that UUID and sets the next deadline 60-75 minutes ahead with
jitter. Lease/owner/request identity fences reject delayed acknowledgments;
owner changes clear the pending identity. Expired receivers cannot request or
acknowledge repair. Existing current-demand checks and account/project Scan
budgets, coalescing, owner dispatch limits and host cooldown remain in force.

Returning demand also requests repair when the owner discovery report is at
least an hour old, avoiding indefinite postponement by short sessions that
recreate ephemeral receivers. Report age is only a scheduling hint, not a
freshness or authorization proof. Recent reports avoid this return-time request.

Focused checks pass: eight receiver database tests, 56 server bootstrap/API/
registration tests, and server/reference typecheck. The opt-in long acceptance
case adds an unmediated file after initial discovery, advances only the hourly
repair deadline, renews demand, and otherwise uses real production timers and
the real five-minute host cooldown. Both real multibay cases pass in 349.278
seconds, with exactly one initial request and one repair request, the later file
present in the home view, both receipts settled, and zero compute starts. The
return-time age branch was added during that run and is covered separately by
the focused server tests, not by that already-running worker process.

This is a conservative active-project fallback, not the final generation-aware
service. Cold-volume inventory hints/backoff, shared cross-home repair suppression,
receipt-expiry recovery after very long ambiguous outcomes, measured scan cost,
and lifecycle/scale gates remain open. No production flags were enabled.

### Owner Run Age And Cross-Home Repair Sharing

Added nullable owner-held `run_observed_at` to discovery metadata. It records
the first accepted report for a new run, remains fixed through progress reports
and replay, and resets only on run replacement. Existing rows stay unknown;
schema installation and later same-run reports do not fabricate a recent age.
It is not the host's scan-start time or evidence that current bytes are unchanged.

A due home receiver now reads owner discovery before requesting repair. A
completed run first observed within the past hour lets that receiver postpone
repair without creating an actor reservation or owner Scan receipt. Unknown,
future or old run ages and partial reports do not enable this optimization.
Returning-demand checks likewise use run age instead of a progress/heartbeat
timestamp, so frequent reports cannot indefinitely postpone repair. Explicit
user Scan requests are unchanged. Owner lookup failure leaves the durable repair
identity pending for retry.

This avoids sequential cross-home redundant work, not every concurrency race:
homes observing an old report together still use existing owner job coalescing
and budgets. Postponement uses the receiver's bounded jittered deadline, so this
does not establish a one-hour freshness SLO. Mixed-version rows with unknown
age conservatively request repair rather than claiming freshness.

Focused checks pass: 62 server tests, five discovery database tests, and server
typecheck. Both extended real multibay cases pass in 349.98 seconds. The first
brings a second home online, advances its repair deadline, and verifies no new actor/owner receipt
for the recent shared run. Its later missed-write phase ages the owner run as
well as the home deadline, retaining real dispatch and host cooldowns.

### Pending Repair Generation Lifetime

Automatic active repair now records the database-time creation of its pending
request identity. Retries preserve both identity and timestamp for seven days.
If demand is still live and repair remains due after that horizon, the receiver
starts a new durable repair generation. This is deliberate ongoing background
repair, not an inference that an old ambiguous admission failed. Old owner jobs
and receipts are not canceled or settled by this transition. Public Scan retry
and status behavior is unchanged; new admission still uses existing budgets.

Generation rollover is a single receiver UPDATE, and a late acknowledgment for
the old ID cannot clear the new one. Unknown-age legacy requests keep their ID
and receive an observation timestamp rather than being discarded on upgrade.
Successful acknowledgment and owner change clear the generation timestamp.

Ten receiver database tests, 22 server orchestration/registration tests, and
server/reference typecheck pass. Tests simulate aging only the generation
timestamp, verify ordinary retries do not extend its horizon, and reject old-ID
acknowledgments after rollover. This is not a seven-day soak or a multibay
receipt-expiry acceptance result. Initial-bootstrap identity expiry remains a
separate recovery gap; cold repair, lifecycle and capacity gates remain open.

### Initial Discovery Request Generations

Initial discovery now has separate durable request-ID and request-age columns.
The first request keeps the receiver UUID for compatibility with already issued
requests. After seven days of still-pending work, a new request generation is
allocated without rotating the receiver identity used by projection scheduling
and revision-delivery fences. Unknown-age requests acquire an observation time
without changing their ID. Acknowledgment matches the current request ID as well
as the live owner/lease, so an old reply cannot acknowledge a newer generation.

This applies the same bounded background-work policy as periodic repair. It
does not infer failure from timeout or cancel prior owner work. Explicit user
Scan receipt/retry semantics are unchanged. Keep the prototype disabled during
a mixed-version rollout: old workers do not understand rotated bootstrap IDs.

Eleven receiver database tests, 62 server tests, and server/reference typecheck
pass. The rollover test also commits preexisting projection scheduling state
after rotating the bootstrap request, proving these identities stay independent.
The timer-driven bootstrap/cross-home acceptance rerun passes in 101.999 seconds;
the opt-in long missed-write case is skipped in this rerun. This is not yet real
cross-bay seven-day expiry recovery evidence or a long-duration soak.

### Dormant-Population Regression At dae1dfab19

Reran `dormant-scale.acceptance.test.ts` with both
`COCALC_COLLABORATORS_ACCEPTANCE=1` and `COCALC_PEOPLE_SCALE_ACCEPTANCE=1`
at `dae1dfab197f3225a6adf5de80305cb7ff9e7402`. All four cases pass in
374.035 seconds, including fixture creation and cleanup. Synthetic data uses
the fixture's deterministic `dormant-scale-N` MD5 identity seed and one membership
per dormant account. The isolated harness has one owner, two homes and a host
process; PostgreSQL is 18.4, Linux is `7.0.0-1011-gcp`, and temporary storage is
btrfs. The runtime exposes 16 AMD EPYC 7B13 CPUs; effective cgroup CPU/memory
limits were not available at the usual cgroup paths. This is a shared development
environment, not a dedicated capacity benchmark.

| Query              | 100k buffers | 1m buffers | 1m execution ms |
| ------------------ | -----------: | ---------: | --------------: |
| Cleanup candidates |           23 |          4 |           0.027 |
| Activation         |            3 |          3 |           1.213 |
| Projection claim   |            3 |          3 |           1.000 |
| Access claim       |            3 |          3 |           1.045 |
| Stale cleanup      |          240 |        240 |           0.473 |

Buffers are PostgreSQL shared hits plus reads, not physical I/O counts. Each
timing is one EXPLAIN ANALYZE sample, not a percentile. Candidate-plan differences
do not imply larger populations are faster. Maintenance produces no dormant
owner refresh RPCs or new access grants at 0, 100k or 1m dormant memberships.

With 100k banned due accounts added to the million-row population, activation,
projection and access queries touch 66, 242 and 234 buffers respectively and
retire exactly eight ineligible hints each. This verifies bounded selection,
not draining the entire backlog under concurrent load. Identical mixed active
workloads, the 5% marginal-operation target, DAU traces and the 24-hour soak remain
unproven.

Requested an independent review of the recent bootstrap/repair work at this SHA.
The message was saved, but exact-attempt inspection still reports unknown
execution after a payment/subscription/usage-limit launch error. No automatic
resend was made, and no independent approval is claimed.

### Fixed Active Activation Across Dormant Populations

Extended the dormant-scale fixture with the same one-account, one-project
cold-to-active workload after each idle measurement. Each case acquires scoped
demand, runs activation, and runs production home maintenance twice. It compares
owner RPC deltas and `cocalc_people_indexing_work_total` deltas with the zero-row
baseline, asserts one project-page fetch and one projection claim, and checks
that dormant accounts still acquire no grants. Only the synthetic active
account's projection/access/demand state is removed between population sizes;
dormant rows remain intact.

The full isolated PostgreSQL suite passes all four tests in 342.725 seconds.
At 0, 100,000 and 1,000,000 dormant memberships the active deltas are identical:
one `projectPage` RPC, one `projection_claimed`, and zero `access_claimed`.
`demand_memberships_scheduled` is zero in the measured maintenance counters
because this fixture explicitly runs activation before maintenance. Project-page
responses renew access, so a separate `refreshAccess` RPC is not required.
The original bounded-query, no-idle-RPC and ineligible-backlog assertions pass
unchanged. Server/reference typecheck and diff whitespace checks also pass.

The first test iteration incorrectly required a separate access-refresh RPC;
it failed at the zero-population case and consequently left fixture state for
later cases. The assertion now follows the actual combined projection/access
path, and cleanup precedes comparison assertions.

This provides a fixed active activation regression, with zero measured logical
work amplification from dormant population. It does not establish the full 5%
hot-worker cost gate: SQL/CPU/I/O costs, sustained edits, shared-project fanout,
heavy accounts, GC/retention churn, DAU traces and a mixed-workload soak remain
unmeasured by this case. Existing query-plan measurements cover only their named
queries, not every statement in this active workload.

### Returning Demand After Catalog Compaction

Added `returning-demand.acceptance.test.ts` using the isolated real PostgreSQL
owner/two-home/host harness and authenticated human APIs. It creates two live
conversations, stores an explicit alias/collection/follow preference, sends a
real message, waits for its notification, and records a nonzero read-through
position. The fixture then expires demand by six months and supplies an aged
canonical tombstone for the other conversation. The actual owner compactor
removes the tombstone and rotates the catalog generation.

Home maintenance while demand is cold makes no additional owner RPCs. Acquiring
fresh scoped demand rebuilds the home projection against the new generation,
removes the deleted conversation, preserves the retained conversation's full
explicit personal row, and leaves the preexisting notification IDs unchanged.
A second expired-demand return after owner membership changes to viewer yields
no visible resources despite the stale home membership view; explicit personal
state remains intact. No project compute starts are observed.

The final extended test passes in 48.237 seconds; server/reference typecheck and
whitespace checks pass. An initial assertion incorrectly required disposable
default attention state for the deleted conversation to survive; it was narrowed
to the explicit personal state that the contract requires preserving. The final
case also includes actual historical message/notification data, rather than an
empty-history no-replay assertion.

This simulates the retention boundary with database timestamps and invokes real
compaction/rebuild paths. It is not a six-month soak, source-filesystem deletion
detection, a multipage/heavy-account resnapshot, or offline-event delivery beyond
notification retention. Those remain separate gates, as do restore/rehome of the
new prototype state families and the complete mixed-load churn cycle.

### Disposable Demand Across Account Rehome

Added `demand-rehome.acceptance.test.ts` to exercise the existing disposable-lease
contract through the real account-rehome RPC between independent home databases.
A live demand lease stays out of the destination transfer. After cutover, direct
old-home renewal fails, routed renewal of the old lease fails, and old-home
maintenance makes no owner RPCs. The same authenticated consumer reacquires at
the destination with a different lease UUID. Releasing the old lease cannot
release that replacement. No project compute starts occur.

The isolated PostgreSQL case passes in 47.82 seconds; server/reference typecheck
and whitespace checks pass. This adds validation, not a new handoff protocol or
a relaxation of existing portability guards. It supports treating demand as
disposable scheduling state, not canonical user data. It does not validate
project-owner moves, scan receipt migration, receiver/outbox handoff, interrupted
rehome with demand in flight, or returning to a former home before old leases
expire. Those cases remain open under the original plan.

### Known-Source Host Default

The host previously selected recurring inventory discovery unless
`COCALC_PEOPLE_CENSUS_EXPLICIT_PROTOTYPE=1` was explicitly set. That default
conflicted with the approved smaller release. Host startup now selects explicit
census/known-source discovery when the variable is unset or `1`; only an explicit
`0` selects the legacy inventory mode. The mode is captured for the service
lifetime. This prevents both owner/retained-source inventory polling and new
periodic volume census admission. Already queued work may drain; no queue or
durable receipt is discarded. Known-source dirty hooks remain unchanged.

Public Scan admission and privileged host reconciliation controls retain their
existing opt-in gates. This change does not implicitly enable Scan, demand
scheduling or automatic demand-triggered discovery. In particular, keep
`COCALC_PEOPLE_DISCOVERY_BOOTSTRAP_PROTOTYPE` unset for the initial release.
Legacy `COCALC_PEOPLE_CENSUS_EXPLICIT_PROTOTYPE=0` is outside the initial-release
configuration and remains available for legacy validation only.

Host/reference typecheck and 35 focused tests pass. The default and explicit-1
tests assert census scheduling is explicit and 20 discovery passes invoke no
owner RPC, retained-source enumeration or filesystem open. The real multibay
retention-return test passes in 47.329 seconds with the host flag unset; normal
thread/message hooks still populate the catalog, notify and rebuild the view.
This is not the full disabled-after-data/rollback or mixed-load release gate.
No running projects, host processes or production settings were changed.

### Full Development Build Of The Smaller-Contract Changes

`pnpm -C src build:dev` completed with exit code zero at
`408f6c2b0fb082392509473fb74ab03278b5f115`. This includes workspace installation,
the development build pipeline (including frontend translations, static rspack
bundle, HTTP API, Lite, project host, CLI, server/database and hub packages), and
the Python API package/documentation build. The post-build worktree has no tracked
changes; only the two preexisting untracked security-review documents remain.

Nonfatal output included permission denial opening the local debug log at
`/home/user/.cache/cocalc/project/log` and a Material for MkDocs informational
warning. No unrelated permissions were changed. This is build integration
evidence, not a production deployment, full test suite, browser validation or
capacity result. The remaining initial-release gates in the current audit stay
open.

### Disable And Reenable After Personal State Exists

Extended the real multibay retention-return case with a site-setting toggle
after conversations, a delivered notification, personal preferences and live
demand exist. A fixture-only command updates `collaborators_enabled` in the
isolated bay database and resets that process's settings cache. Owner and both
home settings are disabled, then reenabled; no live site is involved.

Once the setting is observed, authenticated metadata reads, demand acquisition
and demand renewal reject. Two home maintenance passes make no owner RPCs, and
the explicit personal row is unchanged. Reenable permits renewal of the same
still-valid lease. The subsequent expired-demand resnapshot, no-notification-
replay and revoked-membership return assertions still pass. The combined case
passes in 49.499 seconds; server/reference typecheck and whitespace checks pass.

The explicit cache reset models an observed setting change, not instantaneous
cluster-wide propagation. Normal bay settings may remain cached for 15 seconds
(three seconds in development), and host enablement has its own cache. In-flight
host Scan work across toggle, natural cache-delay behavior and population-scale
reenablement are not established by this fixture. It does not remove any release
guard or enable prototype settings in production.

### Partial Explicit Scan Pause And Resume

Added a host adapter regression using real SQLite census/journal state and a
controlled directory stream. A bounded step commits one source while leaving the
directory unfinished. After an observed disable and producer pause, directory
and filesystem handles close; ten disabled steps/report passes perform no more
reads, opens or report calls and leave the durable checkpoint unchanged. New
Scan admission rejects with `DISABLED`.

Reenable reopens the directory from its beginning, deduplicates the committed
entry and completes the same run UUID. Ten further explicit-mode steps do not
open storage or enumerate project inventory. This tests pause/resume semantics,
not actual site-setting propagation delay or concurrent administrator/network
timing. Three focused host suites pass (27 tests), as does host/reference
typecheck. No production implementation change was needed for this behavior.

### Initial-Release Home Worker Configuration Audit

Source audit at `befb41f232` confirms that the host's known-source default alone
does not select demand-driven home scheduling. In
`database/postgres/collaborators/collaborators-demand.ts`,
`demandSchedulingEnabled()` requires all three variables to equal `1`:

- `COCALC_PEOPLE_DEMAND_PROTOTYPE`
- `COCALC_PEOPLE_DEMAND_SCHEDULER_PROTOTYPE`
- `COCALC_PEOPLE_EVENT_FANOUT_PROTOTYPE`

With any missing, `server/collaborators/maintenance.ts` still calls legacy
membership seeding and notification cursor polling, and the access claim path
in `collaborators-access.ts` selects due grants without a demand predicate.
This fallback does not satisfy the smaller contract's dormant-cost guarantee.
Treat these as a coordinated rollout configuration, not independent optional
performance tweaks. Independent event delivery is necessary before stopping
legacy notification consumption; do not simply remove the fallback or flip a
single switch in production.

When demand scheduling is selected, the backend `check` response advertises
`demand_supported`; `frontend/collaborators/use-directory-revision.ts` uses that
capability to acquire/renew demand. Revision receiver registration and shared
projection fetching additionally require
`COCALC_PEOPLE_REVISION_INTEREST_PROTOTYPE=1`; revision outbox schema installation
additionally requires `COCALC_PEOPLE_REVISION_OUTBOX_PROTOTYPE=1`. These are
separate from the basic demand predicate and need explicit selection in the
representative-load fixture rather than accidental shell inheritance.

Explicit Scan dispatch has its own startup switch,
`COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE=1`; the UI capability additionally requires
`COCALC_PEOPLE_SCAN_API_PROTOTYPE=1`. Automatic demand-triggered filesystem
discovery is separately gated by
`COCALC_PEOPLE_DISCOVERY_BOOTSTRAP_PROTOTYPE=1` and must remain unset for this
release. No live flags or services were changed during this audit.

The previously running scoped `browser files` request terminated with exit code
1 and a 408 remote `listOpenFiles` timeout. It supplied no browser validation
evidence. No alternate credentials, session discovery, or service restart was
attempted. Actual rendered Scan behavior remains an open gate.

### Known-Source Timers With Active And Cold Recipients

`known-source.acceptance.test.ts` exercises the selected demand, fanout, revision
interest and outbox switches together on the isolated owner/two-home/host fabric.
Scan dispatch is installed, but automatic discovery bootstrap remains unset.
The harness whitelists its environment, so live shell prototype flags cannot
silently enable bootstrap. An unmediated chat file is deliberately present.

Production maintenance timers, not manual ticks or advanced due timestamps,
deliver eight normally created conversations to an authenticated active view.
One subsequent message reaches a following recipient with no demand and no
resource projection. The unmediated file remains absent from the observed view;
no Scan jobs or receipts are admitted. Of 1,000 synthetic cold memberships plus
the active account, only the active account receives access rows. No project
compute starts are recorded. This is a bounded observation during convergence,
not a claim about indefinite idle behavior or arbitrary filesystem completeness.

The focused acceptance test passes in 57.17 seconds, including isolated process
and PostgreSQL setup/cleanup. Server/reference typecheck, formatting and
whitespace checks pass. The fixture checks canonical resource IDs and real
notification targets. It is a mixed-behavior smoke test, not representative
mixed-load capacity: only one account views one project, and no throughput,
latency percentile, CPU, I/O or WAL envelope is established. Browser validation,
larger measured load and independent release review remain open.
