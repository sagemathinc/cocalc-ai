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
