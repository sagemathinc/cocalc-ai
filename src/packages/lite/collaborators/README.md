# Standalone Lite Collaborators

This adapter is only for standalone, single-account/single-project Lite. SQLite
holds project-owner metadata and account-home personal state in separate tables.
It does not emulate remote bays or turn imported participant IDs into members.
People is empty; Projects contains the local owner project, even with no rooms.

## Integration

Construct only from `lite/main.ts`, not the shared Lite hub API module:

```ts
import { createLiteCollaborators } from "./collaborators/service";
import { initLiteCollaboratorsRoomService } from "./collaborators/room-service";

const collaborators = createLiteCollaborators({
  directory: join(data, "collaborators"),
  path,
  client: conatClient,
  account_id,
  project_id,
  isEnabled: () => /* current collaborators_enabled boolean */ false,
  sourcePage: (opts) => artifactCatalog.catalog.sourcePage(opts),
  personalLibrary: () => personalLibrary,
  personalLibraryFilename: join(data, "personal-library.sqlite"),
  artifactCatalog: {
    catalog: artifactCatalog.catalog,
    journal: artifactCatalog.service.journal,
    filename: join(data, "artifact-catalog", "catalog.sqlite"),
  },
});
hubApi.collaborators = collaborators.api;
// In localPathFileserver options:
const wrapFilesystem = (fs, projectId) =>
  collaborators.wrapFilesystem(
    artifactCatalog.wrapFilesystem(fs, projectId),
    projectId,
  );
// After the filesystem service is ready:
collaborators.start();
const collaboratorsRoomService = await initLiteCollaboratorsRoomService(
  conatClient,
  collaborators,
);
process.once("exit", collaborators.stop);
```

The return value is `{store, service, api, wrapFilesystem, start, stop, close,
ensureRoomDirectory, assertInitializedRoomSource}`. On graceful shutdown, await
`collaboratorsRoomService.close()`, drain filesystem writes, then await
`collaborators.close()`. `stop()` keeps
the producer lease until shutdown, as in the artifact service. Private directory
and catalog permissions are 0700 and 0600 respectively.

For metadata storage without a worker, construct
`new LiteCollaborators({filename, account_id, project_id, isEnabled})` from
`./collaborators`. Optional values: `project_title`, `project_description`,
`room_path` (defaults to the shared canonical room path).

The Library callback and filename are lazy; its instance can be constructed after
this factory, before exposing requests. They reuse the existing alias/pin store,
including clearing active names without deleting their historical binding.
Agent collection uses the existing local account's pinned-agent preference.
Unnamed threads without a global agent identity keep their typed-target shortcut
locally; collection never invents or enrolls an execution identity.

Project pins reuse the existing account-scoped Conat `bookmarks/projects` key.
The factory uses its configured `client`; a metadata-only store can instead
receive a `projectPins` adapter with `read`, `set`, and `revision` methods.
`listProjects({view: "recent" | "pinned"})` filters the local project without
creating rooms. `setProjectPinned` changes only this local account's favorite,
never project membership. Pin writes are compare-and-set against the existing
key, and polling uses its store's metadata inventory sequence so edits through
the original project favorites UI invalidate results too. Favorite arrays over
10,000 entries fail explicitly rather than returning truncated/empty success.

Publish only `.api`, never the store instance. All human methods require the
local authenticated account and a current `isEnabled()` result of exactly true.
The hub's existing auth transform must bind the account from the principal,
never trust an arbitrary payload account. Foreign project operations fail closed.
Network `registerSource`, `ingest`, `writerState`, `sourcePage`, `roomForHost`,
`markRoomInitialized`, `checkpointPage`, `discoveryForHost`, `reportDiscovery`
and `relocateSource`
always reject, even when the flag is enabled. Local ingestion is independent of
the flag when explicitly called by trusted maintenance code. The background
producer checks the dynamic flag before discovery, reads, registration and
delivery; default-off does not materialize source metadata. A mid-pass disable
stops subsequent callbacks, retaining durable queued work for later enablement.
The shared filesystem wrapper consults the same callback through its journal:
disabled operations delegate directly, without copy traversal, journaling or
Collaborators file-operation capacity restrictions.

The producer can use `store.registerSource(request)`,
`store.ingest({snapshot})`, `store.writerState(source)` and
`store.sourcePage({project_id, after})` directly. Writer state includes `epoch`,
`registration_id`, `sequence`/`source_sequence`, `revision` and payload hashes.
Registration is compare-and-swap and idempotent by registration ID. On journal
recovery the producer persists the owner's current epoch as its registration CAS
base; it never adopts that epoch as permission to write an arbitrary sequence.
The local checkpoint callback restores retained identities and activity floors,
including tombstones, in pages of 100 before a recovered writer scans. Compacted
history or restoring a deleted source cannot reset unread progress.

`store.ensureRoom({account_id, project_id, request_id})` is the local control hook
for explicit room setup. It atomically registers one room, but never reads or
creates a chat file. Actual initialization, human sends and deletion checks use
the local room data-plane service. Only an explicit initialization prepares the
parent directory through the filesystem, before acquiring SyncDB; initialized
missing rooms still require explicit restore. It uses the same subject/method protocol as
the project-host implementation, including actor/room/request-scoped retry IDs.
Only the authenticated local account/project can call it; the feature flag is
rechecked across async steps. It uses shared human-only chat helpers, checks
initialized disk and live room markers before reuse, and never registers a room.
`store.markRoomInitialized({project_id, room_id, chat_path,
requesting_account_id})` persists an owner guard after disk acknowledgement; this
guard prevents deletion recreation even if the producer journal is lost.
There is no remote-host room lookup in standalone Lite. The factory defaults the
room path to `.cocalc/collaborators.chat` within Lite's configured home.
Only explicit `ensureRoom` and `requestSource` enqueue their specific paths.
Their durable inventory records participate in bounded owner-source discovery;
neither API creates chat content, rewrites files, or starts compute.

Explicit room replacement uses the same human-bound `replaceRoom` service
contract as hosted projects. Only the sole configured account may confirm it.
Under the copy and journal write locks, ENOENT is required before the local owner
transaction switches the expected identity/path, retains its retry receipt, and
tombstones the old catalog/source. The new path stays inside Lite's configured
home and is initialized through the normal human chat service. Read/corruption
errors never trigger replacement, and retired paths cannot be adopted, moved,
or written back into the catalog. Receipts and journal retirement survive restart;
the 32-operation project cap includes superseded receipts. Every ordinary room
mutation requires `expected_room_id` and rejects stale callers.

The service-local room lookup carries bounded retirement metadata so an ordinary
human operation can finish a replacement whose acknowledgement was lost. The
owner transaction releases retired-source active/staged relation sets and derived
participant rows; it retains personal state, identity floors, and retry receipts.

With the local data-plane client configured, the producer's `beforeRead` hook
also recovers accepted Conat history for the already initialized canonical room.
It runs from the durable source inventory, including after daemon restart, without
a browser save or filesystem scan. A short-lived SyncDB uses the journaled local
filesystem and no backend file watcher; readiness is bounded to 30 seconds.
The same canonical sync identity is checked for at most 10,000 history patches
and 64 MiB of uncompressed history, before acquisition and after readiness.
The shared flush helper compares bounded, validated live and disk rows and saves
to disk only when different, before metadata extraction. Clean rooms are not
rewritten. The same save updates the artifact journal when configured.

The worker rechecks the local account/project, feature flag, room pointer and
writer epoch while holding the mediated copy/move/delete exclusion. Both disk
and live documents must have the registered human-room marker and no copy
namespace. It never registers, initializes, adopts, creates a parent directory,
or opens arbitrary indexed chats as SyncDB. A missing initialized room remains
missing and is indexed as deleted; failures during acquisition or publication
retain the last valid metadata and retry through the durable source journal.

## Query And Persistence Semantics

- Reads query SQLite and existing personal stores. They never scan directories, open source chats, start
  compute or start a producer. The background worker discovers from the existing
  service-side source index and its own journal, in pages of at most 100 sources,
  plus the separately persisted census below.
- Metadata search uses SQLite FTS5 literal token prefixes over titles and this
  account's aliases, not message bodies or leading-wildcard table scans.
  `listProjectResources` is the selected-project fallback: shared-title search
  only, with the same local authorization, limits and revision protocol.
- Pages have at most 50 rows and 256 KiB, with stable activity-time/identity
  ordering. Versioned cursors bind filters, limit, account/project and catalog
  revision. Metadata/personal changes invalidate old cursors and require restart;
  the response revision is captured before its query. `check({account_id,since})`
  returns an opaque account/project-bound token expiring within 30 seconds,
  `reset` on change/expiry/malformed input, and a 5-second poll hint. Polling also
  observes changes made through the original Library, agent-pin and project-favorites UIs. This is
  bounded revision polling, not an event feed.
- Source replacement validates the whole bounded payload before committing.
  Epoch/sequence floors fence delayed writes; same-sequence different content
  fails. Unchanged replay does not rewrite metadata or consume mutation quota.
  Source deletion retains unavailable identity floors and personal state.
- Personal aliases are case-normalized, unique within kind, and optional. Empty
  alias clears a name. Collection, follow and mute are independent. A newly
  observed conversation starts read through its historical activity, excluding
  queued live messages. This boundary accounts for all bounded producer event
  batches, not just the first delivery. Existing identities and personal choices
  are never re-baselined on repair, restore or restart. Read markers advance
  monotonically; markers beyond current activity fail. Metadata repairs cannot
  decrease activity, and one resource never marks another read.
- Legacy follower/mute arrays are summarized for this account by the bounded
  service reader, frozen in its delivery and migrated once under the source
  epoch/sequence transaction. Explicit true or false choices take precedence;
  alias/collection-only writes do not suppress migration. Later legacy writes
  cannot replace migrated choices. Copies do not inherit the original attention.
- For you means participation or explicit following in standalone Lite. Its only
  authorized human is the local account, so no authorized non-self mention sender
  exists. Notification batches are bounded, validated and included in replay
  hashes. Self-mentions and mention-all do not notify oneself; imported actors
  and participants do not grant membership or notifications. Muting does not
  remove participation/follow results.
- Local `store.relocateSource` uses the shared request/response contract, fences
  both old writers, keeps durable request receipts for seven days (at most 1000),
  and retains old-path fences. Conversation/agent identities, personal state,
  unavailable identity floors, room paths and initialization guards survive.
  The network method always rejects. A filesystem rename is not complete until
  the producer journal acknowledges the owner operation.
- The producer's relocation callback is connected to the local owner. Artifact
  moves also relocate the existing catalog and Library aliases/pins, fence and
  requeue its writer, and preserve legacy bound entry IDs through durable
  redirects. Receipt-backed replay handles crashes between these separate SQLite
  commits; pending owner recovery temporarily rejects human catalog reads rather
  than exposing a split projection. Recovery and filesystem acknowledgement are
  bounded and automatic when enabled. Existing Library calls from stale open tabs
  canonicalize old entry IDs and pin paths through the same redirects.
- Fresh service-journaled copies receive a durable namespace through the shared
  chat SyncDB lifecycle when the local client is configured. Original bodies,
  configuration and native IDs are not rewritten. Changed destinations,
  overwrites, unknown filesystem outcomes and copies into the canonical room
  stay quarantined pending explicit reconciliation.

## Coverage And Bounds

Resources always report `partial` or service-reported `indexing`, never complete.
An empty index does not mean no historical content. `setCoverage` is service-local
and cannot set complete. Malformed/oversized sources and delivery failures retain
the last good projection and surface partial coverage. The service logs details.

Limits are 5,000 resources/2 MiB per snapshot, 16 KiB per metadata row, 64 bounded
participant IDs per row, 10,000 registered sources/16 MiB of path text, 100,000
retained resource identities/64 MiB of metadata, and 1,000,000 mutation work units
per hour. Capacity failure is atomic; it never truncates a replacement snapshot.
Identity/source fences are retained rather than garbage-collected unsafely.
`participant_count` and `participants_truncated` preserve a 1000-person room with
only a bounded preview. Source relationship-coverage warnings survive restart
and explain that person/attention filters can miss matches outside the preview.

## Runtime Boundaries

The factory's existing artifact catalog, journal and filename options shown above
enable cross-catalog artifact relocation. This is a store compatibility
adapter, not a second Library registry or notification delivery system.
Artifact move receipts retain at most 1000 operations/seven days and 64 MiB of
mapping data; redirects retain at most 100,000 keys so historical references are
not silently recycled. Existing artifact/Library storage quotas still apply.

Deliberate safe exclusions: ambiguous legacy identities and remote human/host/bay
operations. Unindexed legacy sources with stable identities can be explicitly
adopted using `requestSource`; unknown history is a coverage gap, not a blanket
unsupported workflow. Imported identities do not add Lite members. There is no
existing Lite named-agent registry: agent aliases use the durable Collaborators
registry and pins reuse the existing account preference. Artifact aliases and
collection use the existing Library store.
Unknown or overwritten copy/move outcomes require reconciliation rather than
guessing that they were successful; fresh same-project service-mediated copies
and confirmed renames/moves use the ordinary supported pipeline.

## Historical Source Census

The explicitly started producer also walks Lite's already configured project
home, including regular `.chat` files absent from the artifact catalog, owner
source inventory, and journal. It uses the shared persisted census engine in
[`backend/collaborators`](../../backend/collaborators/README.md#historical-source-census).
Neither factory construction nor a list/status request starts this walk; the
dynamic default-off flag must be enabled when the background worker runs.
Discovery never starts compute, creates a room, changes permissions, or enrolls
an agent. Found paths use ordinary journal registration and extraction, including
existing identity and copy/relocation fences.

`census.sqlite` and its process lock live in the configured private service
directory. The run scope includes the local account/project, configured root,
root device/inode identity, and policy version. `.snapshots`, `.trash`, and the
private service directory when it lies below the project root are excluded.
Other ordinary directories are eligible, including hidden folders and
`node_modules`; symlinks are skipped, not followed. The Linux sandbox adapter
uses no-follow directory descriptors and mount-ID checks, rejecting renamed or
mutated directories, replaced roots, and cross-mount traversal. It is not exposed
through filesystem RPC. Non-Linux traversal is explicitly unsupported and leaves
partial coverage, rather than silently scanning through a weaker fallback.

The shared defaults are 10,000 directories, 100,000 entries, 10,000 entries per
directory, 10,000 chat candidates, and depth 32 per run. The store allows 4,096
retained project runs/summaries and 64 MiB of charged metadata; standalone Lite uses one
project. Each step streams at most 100 Dirents from one directory under a
cooperative 100 ms budget, with at most four retained directory handles and
16 journal candidate handoffs per pass. Stream operations have five-second
deadlines and a process-wide 32-stream admission limit; timed-out kernel work
retains its slot until cleanup. This is not a deadline for every OS or lifecycle
wait. Non-chat entries and replay reads also consume traversal budgets.

Completed frontiers compact only after all candidates have durable journal
receipts. Run scope, counts, partial reasons and pending report retries survive;
unfinished frontiers and unacknowledged candidates are never compacted. Reserved
summary/report space is included in the byte budget. Per-project reports do not
consume generic scheduler checkpoint slots. The backend section documents the
shared operator capacity settings, migration, and byte-pressure retry path; Lite
honors the same `COCALC_COLLABORATORS_CENSUS_PROJECTS` and
`COCALC_COLLABORATORS_CENSUS_BYTES` settings without requiring a chat path.

Lite also honors the backend's validated per-run policy limits and
`COCALC_COLLABORATORS_CENSUS_RESCAN_REVISION`. After cleanup or a limit increase,
a new stable operator revision requests a bounded path-free rescan of the existing
root, including a previously quota-blocked unfinished walk. Keep the revision
configured across restarts. The reset first drains candidate handoffs and exact
unacknowledged report retries, then preserves one prior aggregate summary while
installing a new fenced run. It never drops journal intent or changes access,
starts compute, or runs from a list call. A blocked handoff/report keeps the old
partial run intact. The shared source service independently honors
`COCALC_COLLABORATORS_JOURNAL_SOURCES` (default 10000, maximum 1000000) and
`COCALC_COLLABORATORS_JOURNAL_BYTES` (default 268435456, maximum 4294967296);
invalid settings fail construction and lower budgets never evict durable state.
These do not enlarge Lite's independent registered-source or catalog quotas.

Progress, candidates, handoff receipts, errors, and report retries persist across
restart. Unfinished directories replay from the beginning with durable
deduplication; completed directory state or its compact summary is retained. Disabling closes cursors
without discarding progress. Errors retry with backoff capped at 60 seconds.
A completed run with no pending candidate handoffs becomes eligible for a fresh
walk one hour after its start, after any unacknowledged report retry drains.
Root identity or scope changes replace the run; quota-blocked runs remain partial
until an explicit policy rescan. External changes after a visit are not an
atomic filesystem snapshot and may require the normal journal or next census.
The older registered-inventory paging loop may restart from its beginning;
the new census frontier and journal deliveries do not.

`api.getDiscovery({account_id,project_id})` reads only local metadata. Internal
`store.discoveryForProducer` / `store.reportDiscovery` use run-CAS and monotone
sequence checks; browser/remote-host telemetry writes are rejected. Reports are
throttled to at least 30 seconds per project, preserve source pending/error counts,
and contain no paths or transcripts. No report means pending; a report older than
30 minutes is unavailable. Resource-list coverage includes census status and
retains source-specific warnings. Encountered exclusions, symlinks, I/O failures,
and quotas are partial coverage. A completed scoped walk and source handoff never
claims all archived content or relationships are complete.

## Complete Participant And Reference Relations

`store.stageRelationPage({page})` is service-local, not a browser writer API.
It stages immutable source-epoch/sequence pages of at most 200 rows and 256 KiB.
`store.ingest({snapshot: {...metadata, relations: manifest}})` verifies the entire
set and activates relations with metadata in one SQLite transaction. A stage
prefix is never visible; missing pages, stale epochs, changed immutable bytes,
or invalid native provenance cannot partially replace the previous graph.

`api.listParticipants(target)` and `api.listReferences(target)` return keyset pages
of at most 50 rows with explicit complete/partial coverage and `check`-compatible
revision tokens. A live registered-agent locator change returns indexing until
the current thread is indexed, never its predecessor's complete relations.
Person filters and For You
participation query full committed relation rows, never the 64-person preview.
A verified set derives the preview and exact participant count, not vice versa.
Metadata-only or incomplete-history updates retain known edges with partial
coverage; only a verified complete replacement can remove absent edges. Current
registered-agent threads bind after identity adaptation, without lending an old
thread's participation to a replacement thread. Authored reference targets and
copy namespaces are not remapped.

Staging is limited to two pending sets per source, 20,000 retained sets and
256 MiB of charged local storage, with the shared per-set limits. Old-epoch or
superseded nonactive staging is removed in batches of eight. Activation discards
duplicate page payloads but retains hashes for conflicting-retry checks, and
removes the preceding active set. Cursor revision changes require pagination to
restart. These APIs report relation coverage independently of the filesystem
census; neither a preview nor a completed directory walk proves complete history.

## Focused Checks

Prerequisites: install workspace dependencies and build the `util`, `conat`,
`chat`, and `backend` packages so their `dist` outputs match the source tree.
Run these commands from the repository root:

```sh
pnpm -C src/packages/lite exec tsc -p collaborators/tsconfig.check.json
pnpm -C src/packages/lite exec jest --runInBand --roots collaborators --runTestsByPath collaborators/index.test.ts collaborators/quota.test.ts collaborators/service.test.ts collaborators/room-service.test.ts collaborators/room-directory.test.ts collaborators/library.test.ts collaborators/agent-pins.test.ts collaborators/relocation.test.ts collaborators/artifact-relocation.test.ts collaborators/legacy-attention.test.ts collaborators/notifications.test.ts collaborators/copy.test.ts collaborators/scale.test.ts
```

Use explicit test paths to avoid matching unrelated suites when an ancestor
directory contains `collaborators`. The scale test exercises 100,000 retained
resources.
