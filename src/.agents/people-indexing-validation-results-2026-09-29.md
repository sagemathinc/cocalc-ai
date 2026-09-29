# People Indexing: Initial Execution Results

Date: 2026-09-29. This is an initial gate report, not a completed scaling rollout.

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

The prototype conservatively caps live **plus retained grace registrations** at
16 per account, bounding rapid acquire/release churn as well as live tabs. A
client can reuse a consumer registration after release. This is stricter than
the plan's live-consumer-only ceiling; reassess during UI integration rather
than silently allowing unbounded grace rows. An expiry index supports bounded
500-row cleanup without enumerating historical accounts.

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
still includes grace rows; revisit that stricter policy against the planned
16-live-consumer contract during aggregation work. No account sleep or scale
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
the existing store's stricter grace-inclusive consumer cap still needs revision
and churn validation for repeated full component remounts.

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
