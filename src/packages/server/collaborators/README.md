# Collaborators Backend

## Wiring

- Import `@cocalc/util/db-schema/collaborators-workspace` in the global schema.
- Register `server/conat/api/collaborators` with the auth-first hub API map.
- Register `createInterBayCollaboratorsHandler` with `collaboratorsControl` on
  the trusted fabric, never the public Conat client. Its subject is
  `bay.<bay>.rpc.collaborators.v1`.
- Await `syncCollaboratorsSchema` before serving discovery. Starting
  `startCollaboratorsMaintenance` also installs its atomic membership/writer
  fences and personal-state revision triggers. Stop with
  `stopCollaboratorsMaintenance`. Human APIs and projection maintenance require
  `collaborators_enabled`; existing authenticated host ingestion may continue while
  off, but new source registration is rejected atomically. Host inventory/writer
  reads create no project metadata. The host also gates background scans.
- Include `collaboration_account_state` in account-home projection ownership.
  Rehome of retained owner catalogs/rooms and personal state needs explicit
  migration support; the initial integration should reject unsupported rehomes.

## Host Protocol

`writerState({project_id,chat_path})` returns the current epoch/registration and
committed sequence, only to the currently assigned authenticated host.
`registerSource({project_id,chat_path,registration_id,expected_epoch})` uses a
stable UUID retry identity and compare-and-swap epoch. The issued UUID fences
all prior writers. Host reassignment, project deletion, and owner changes also
rotate the fence atomically, including A-to-B-to-A assignments.

`ingest({snapshot})` accepts complete-source replacements only: canonical
absolute `.chat` paths, positive safe-integer sequence, <=5,000 resources,
<=2 MiB, <=8 KiB per resource, <=64 participant summary IDs. It whitelists
metadata, rejects duplicate identities/conflicting sequence reuse, and commits
its catalog revision and content-free tombstones before acknowledgment.
`sourcePage` returns <=100 registered/artifact/agent/canonical-room paths with a
keyset cursor. It does not enumerate arbitrary legacy files or start compute.
An explicit account-authorized `requestSource({project_id,chat_path})` adds a
bounded `collaboration_source_requests` inventory row. It neither rewrites chat
identities nor scans files; the current host consumes that inventory through
`sourcePage`. Registration acknowledges/removes the pending request. A request
is not an assertion that the source has been successfully indexed.

`checkpointPage({project_id,chat_path,after?})` exposes at most 50 retained
`{resource_id,kind,activity}` floors and the source epoch to its current assigned
host, including content-free deleted-resource floors. Tombstones retain no titles,
paths or bodies. Floors survive source relocation and prevent activity regression
when the same identity is restored. The continuation is bound to
project/path/host/epoch/source revision/catalog generation and
expires after ten minutes. It rejects concurrent revision or epoch changes;
callers restart the checkpoint rather than mix generations. A replacement host
seeds its seen-ID ledger at these floors before accepting later new activity.
Unindexed activity lost with the host journal is a conservative backfill boundary,
not an excuse to replay historical notifications. The owner never stores bodies
or manufactures the host's seen-message ledger.

Host-supplied agent IDs are not authority. Owner ingestion and bounded background
reconciliation bind active `agent_identities` by project/path/thread without
enrolling unnamed sessions. Known identity moves update locators and permit a
verified source handoff; stale old-source upserts are rejected.

`relocateSource({project_id,from_chat_path,to_chat_path,operation_id,expected_epoch,
expected_destination_epoch})` atomically CASes both source fences, moves catalog
locators and active agent endpoints, and preserves typed resource IDs and the
canonical room identity/initialized bit. Retrying the operation UUID returns the
same epoch/revision; conflicting reuse fails. Old-path writers cannot resurrect
moved rows. The existing artifact catalog also moves, so typed artifact links
resolve through `getResource` to the new viewer entry. Account-home Library
bindings preserve existing names and pins across projected moves and rejoin.
The owner also retains at most 64 prior native entry hashes per artifact, counted
against the catalog byte quota. Private owner-to-home pages/target lookups carry
these hashes so Library names and pins migrate even before an account's first
projection or through selected-project fallback. This is not a second personal
namespace; the home adapter edits the existing Library under its lock and rehome
fence. Historical hashes never enter public resource metadata. Relocation fails
atomically when its history/byte capacity is exhausted rather than dropping old
bindings.
Old path-encoded artifact viewer links are not redirected. Supported filesystem
copy hooks persist a new identity namespace; unmediated/ambiguous filesystem
changes require explicit reconciliation rather than guessing identity.

`ensureRoom` creates one durable pointer, not a file or project process.
`roomForHost` only reads an existing pointer, checks the feature flag, assigned
host, project owner route, and requesting human's collaborator role. The host
service must initialize/write through its existing authenticated chat service.
`markRoomInitialized` is a one-way owner-persisted CAS on room ID and path, with
the same host and requesting-member checks. The host persists this lifecycle
guard before accepting human writes and never recreates a missing initialized
room after host-private journal loss.

## Delivery And Revocation

The owner catalog is a coalesced pull outbox: each row has a project-wide revision,
and omission creates a tombstone. Account-home jobs persist generation, revision,
tie-breaker, expiring claim, and retry state. Each pass claims <=8 jobs and each
response contains <=50 rows / 256 KiB. Bounded tombstone compaction after seven
days rotates the project generation, forcing explicit resnapshot. Initial
coverage remains honestly partial because arbitrary legacy-source adoption is
not complete. Capacity errors retain continuation and report indexing status.

Reads join the current `account_project_index` collaborator role (never viewer)
and the matching owner-issued access generation with an unexpired 60-second
lease. Each background page rechecks membership at the owner. The lease starts
before the request, not when a delayed response arrives. Observed revocation
clears metadata; stale claims cannot restore it. Owner membership edits rotate
generation atomically, so rejoining backfills a new generation. The remaining
distributed metadata revocation window is at most 60 seconds plus client polling
delay. Outages fail closed after lease expiry, not as an empty complete catalog.
Already downloaded metadata cannot be erased remotely. Point opens and personal
writes recheck authoritative project membership. Live content remains host-local.

Access renewal is independent of catalog delivery: eight bounded workers claim
50 grants each, group by explicit owner bay, and fetch current membership plus
generation without reading source pages. Claims and updates use bulk SQL; one
owner request checks up to 50 projects under rehome/project locks. Each worker
allows at most four destinations in flight, sleeps 100 ms after work and 1 s
when idle, and schedules renewal after 20 s without extending the 60 s security
TTL. A newer grant request fences delayed batch and projection responses. New
generations hide old resource rows immediately, while cold project/people pages
can become visible before catalog backfill. There are no compute starts or
page-load project scans. Saturation/outages still fail closed at lease expiry.

Limits: 1,024 sources/project, 50,000 catalog rows including tombstones / 32 MiB
metadata/project, 1,000,000 mutation work units/project/hour, 100,000 projected
resources/account, and 10,000 explicitly retained generic personal choices/account.
Projected conversation attention baselines do not consume the personal-choice
quota; baseline-only rows are removed when their projection disappears. Account
revision writes (including row triggers and explicit invalidation) coalesce to
one increment per account per transaction. A 50,000-row project baseline prune
therefore does not create a 50,000-version revision-row HOT chain, and rollback
rolls back the revision too. Workers and
quotas bound growth; high fanout still costs one metadata page per account/job.
Catalog fanout is still per account/job, separately from grouped access renewal.
The quota-exceeded project-scoped fallback is
`listProjectResources({account_id?,project_id,kind?,search?,person_id?,after?,limit?,
include_archived?})`, one owner page plus a bounded bulk home personal overlay.
It works even when the account projection has no rows. Its bounded
shared-title search deliberately does not promise cross-bay personal-alias
search or personal-scope filtering.

## Paging And Invalidation

Resource pages use descending `(activity timestamp, stable key)` keysets;
projects use descending `(project sort timestamp, project UUID)` and people use
ascending account UUID. Cursors bind account, endpoint, filters, and version and
expire after ten minutes. Concurrent activity may reorder rows, so clients must
deduplicate identities and resnapshot on invalidation. Search uses PostgreSQL
`simple` full-text lexemes with GIN candidate indexes, not substring scans.
For scope `all`, an ordered resource scan performs correlated membership checks
before limiting the eligible page; personal overlays are joined afterward.
Selective search first materializes indexed candidate keys and uses parameterized
primary-key lookups. Following, For You and Collected use indexed personal-choice,
mention, participant and native pin candidate sets, intersecting search when
present; access filtering and the page limit still precede personal overlays.
These optimizer fences prevent project-first joins from
sorting all 100,000 account resources for the first page.

Every account page captures its durable `revision` token **before** querying.
`check({since})` returns `{revision,reset,poll_after_ms:5000}`. A changed durable
revision, foreign/malformed token, or expired lease-bound token requires a fresh
first page. A commit between snapshot capture and query completion is therefore
observed on the next poll. Tokens expire within 30 seconds and no later than
the earliest currently active access lease. Clients must clear results when
polling fails/authorization fails rather than indefinitely displaying a stale
cache, and must not combine pages from different invalidation generations.
There is no per-project browser subscription or page-load backfill.

## Personal State And Attention

Conversation and unnamed-agent thread aliases/collection, and independent follow/mute/read state, are
account-home data. Read markers use monotone updates and cannot exceed the
authoritative source activity. Agent aliases and pins use the existing named
endpoint registry and account workspace preferences. Artifact names/pins use
Library's existing namespace. Existing aliases are read live and searchable.
Artifact alias clearing uses Library's historic-binding-preserving clear helper.
Unnamed-agent aliases do not register or enroll an agent. After identity
enrichment, existing endpoint names take precedence; prior thread names and
shortcuts remain fallback display state until an explicit known-endpoint edit
uses the existing registry and clears that corresponding fallback. They never
claim names in the endpoint registry. Attention choices remain independent.

Host-produced `notification_events` are validated, preserved in the snapshot
replay hash, and appended transactionally after writer/sequence checks, even
when resource metadata is unchanged. The bounded owner event log in
[`database/postgres/collaborators-notifications.ts`](../../database/postgres/collaborators-notifications.ts)
and account-home consumer in [`server/notifications`](../notifications)
deliver through the existing notification graph/outbox, not a second
feed. Snapshot scans never manufacture message events. Explicit follow/mute
choices persist separately from defaults so legacy migration cannot overwrite
an opt-out; mention state participates in For You filtering and reason labels.
Owner `collaboration_memberships` epochs identify each account's actual membership
cutover independently from the project-wide visibility generation. Removing a
recipient invalidates its epoch atomically, including removal/rejoin between two
home polls. Other members' changes and catalog repairs preserve existing unread
and notification floors. This project-owned table is explicitly nonportable
alongside the catalog until a project rehome migration is implemented.
Bounded legacy follower/mute hints survive ingestion and are migrated once by the
projection attention initializer. The owner persists each membership's event-log
position, and computes bounded per-resource floors from only post-cutover live
events. Historical backfill initializes floors at current activity without
manufacturing unread history; live messages after the actual join remain eligible
even if the first home projection has not run. These floors preserve first-message
notifications on newly created threads, including multi-page updates. Metadata repair never
advances an existing recipient-epoch read floor.

## Package Boundaries

Host-local recovery and bounded source scans consume the checkpoint/inventory APIs
in [`backend/collaborators`](../../backend/collaborators/README.md).
[`project-host/collaborators-service.ts`](../../project-host/collaborators-service.ts)
owns canonical room initialization and content sends through the authenticated
host chat service. Explicit source adoption is implemented in
[`database/postgres/collaborators-adoption.ts`](../../database/postgres/collaborators-adoption.ts)
under the shared project-owner authorization/rehome fence. Client revision polling,
cache invalidation and selected-content mounting belong to
[`frontend/collaborators`](../../frontend/collaborators).
