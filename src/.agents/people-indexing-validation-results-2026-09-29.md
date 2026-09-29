# People Indexing: Initial Execution Results

Date: 2026-09-29. This is an initial gate report, not a completed scaling rollout.

## Current Completion Audit

Recent Scan store/worker checks do not establish completion of the full design.
The seven implementation gates remain distinct:

| Plan gate               | Evidence and remaining work                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline/contracts      | Isolated baseline, metrics and authority work exist. Full workload cost/freshness curves remain unproven.                                                                                                                                                                                |
| Filesystem proof/reuse  | The raw btrfs generation proof failed. No safe generation-equality shortcut is enabled; validated cold-scan avoidance remains unresolved.                                                                                                                                                |
| Vertical prototype      | Owner/home and Scan components have focused integration tests, but the complete source-change, active-view, sleep, offline-event, return sequence with all failure cases is not proven.                                                                                                  |
| Demand/event decoupling | Demand scheduling and offline-event work exist behind prototype gates. Owner revision-interest stores have focused coverage, but delivery and shared per-home-bay delta fetching remain unfinished. Live demand is capped at 16 separately from a 256-record retained-grace churn bound. |
| Bounded Scan service    | Internal admission, host dispatch, receipt retention and queued cleanup are tested. Public principal binding, reviewed agent scope, host/bay/global budgets, status throttling, complete watermarks and CLI/UI controls are not established.                                             |
| Recovery/lifecycle      | Rehome guards remain necessary. Full canonical rebuild, transfer/rollback, restore and retention/deletion coverage are not proven.                                                                                                                                                       |
| Scale/canary            | Query fixtures are not DAU traces. The 10k/100k workloads, burst/fanout matrix, 24-hour soak, six-month churn simulation, browser matrix and explicit enablement decision remain outstanding.                                                                                            |

The next implementation frontier should address selective revision delivery and
the complete vertical path, not treat further Scan cleanup tests as a substitute
for those contracts. Keep default-off behavior and portability guards until the
corresponding gates actually pass.

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
