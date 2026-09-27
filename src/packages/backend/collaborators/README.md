# Project collaboration producer

The host owns this journal outside project HOME. Source chat state remains
authoritative. The worker publishes bounded metadata, never transcripts,
credentials, ACP configuration, or message bodies. It does not start compute.

## Runtime hooks

- `startCollaborators(getFilesystem)` starts one process-fenced worker per host.
- `withCollaborators(fs, project_id)` wraps the trusted filesystem mutation seam.
- The independent artifact producer must call
  `assertArtifactCollaborationSourceReady({project_id,chat_path})` before reads,
  registration and ingest. It uses the same default-off gate and durable
  move/copy/retired-path fences, preventing artifact indexing from occupying a
  move destination before collaboration owner CAS. The owner's artifact epoch
  rotation still fences already in-flight requests; artifact writer recovery
  must discard stale pending contents and perform a fresh read.
- `initCollaboratorsService(client, { resolveRoom, markInitialized })` exposes the account-scoped
  project data-plane service `services.*.*.*.*.collaborators`.
- `resolveRoom` must use an owning-bay, host-authorized lookup of an EXISTING
  registration, with current host and collaborator checks. It must not create a
  registration or impersonate the requesting account. Call control-plane
  `ensureRoom` before using this service.
- `markInitialized(room, identity)` persists the owner lifecycle guard after the
  source marker is saved, before creating threads. `room.initialized` prevents
  accidental resurrection even after host journal loss.
- The optional worker `enabled(): Promise<boolean>` runs before any work. False
  or lookup failure suppresses discovery, registration, source reads, copy
  initialization and ingest. The host uses a fail-closed 30-second settings cache.
  Retained filesystem wrappers use that same dynamic callback before path
  canonicalization, directory traversal, reads, locks or journal mutations. False
  and failed lookups call the original filesystem method, including nested copy
  operations. On reenable, all retained sources become dirty and notification
  baselines reset, so disabled-period history is not emitted as live attention.
  Inventory polling reconciles known old locators, but an unobserved move/copy
  cannot safely imply an identity redirect. Such destinations need explicit
  reconciliation; the producer never guesses a move from matching content.
- The service offers `initialize({request_id})`,
  `createThread({request_id,title?})`, and
  `send({request_id,thread_id,text})`. Request IDs are UUIDs and are namespaced by
  account, project, room and operation kind. Retries return the same identity.
- Drain room/filesystem services before `stopCollaborators()` closes the journal.
  Alternatively stop the worker but retain its lock/journal until process exit,
  as the existing artifact-catalog shutdown path does.
- Chat exports are `./collaborators` and `./collaborators-room` in the chat index.
  Subject authorization must allow project collaborators, not file-only viewers
  or managed agents. The service independently checks the current local role.

## Delivery and limits

Registration IDs and their CAS base are persisted before the first RPC. A lost
ack retries the same operation, not a new registration. Ingest snapshots are
immutable until ack. New writes dirty a later generation; an old ack cannot clear
them. Retries use persisted exponential backoff. The process lock has no expiry.
Batch entries are rechecked immediately before RPC: awaiting an earlier source
must not bypass a move/copy or epoch fence installed for a later source.

Default caps are 10,000 sources, 1,000 active filesystem intents, 100,000 identity ledger
entries, 1,000 relocation intents, 10,000 copy quarantines, and 256 MiB of activity
and pending metadata per host. A source read is at most 16 MiB/100,000 rows;
snapshot limits come from the shared contract. Participant summary arrays use
`COLLABORATION_PARTICIPANT_SUMMARY_LIMIT`; larger rooms retain their resources and
all activity evidence, expose `participant_count` / `participants_truncated`, and
publish partial coverage with an explicit person-filter limitation. This is not
a complete participation relation; owner/Lite queries must surface that coverage.
Declared partial coverage never permits omitting resources from a scan.
Activity evidence is limited to 100,000 IDs per resource / 8 MiB per source.
Capacity, parse and permission failures defer the source, never publish a partial
replacement. These are safety ceilings, not an eviction policy.

Discovery pages the collaboration and artifact chat-source inventories, revisits
the local journal, and runs the persisted historical census described below. The
canonical room is registered for scanning but not initialized by discovery.
Timestamp-only legacy threads/messages require the separate identity migration;
finding a path does not authorize guessed IDs or partial resource replacement.

## Historical Source Census

`census*.ts` implements an explicit background worker, not a list-request hook.
The host adapter visits eligible local projects by a SQLite keyset cursor and
opens only the already existing home volume through the sandbox filesystem.
It never provisions storage, mounts a missing project by starting its container,
or starts compute. Local-only and exam projects are excluded. Reads of census
status, resource lists, and filters do not schedule traversal or open source files.
The existing default-off `collaborators_enabled` gate applies to traversal,
candidate handoff, and reporting as well as normal indexing.

The host-private `census.sqlite` stores the run scope, directory frontier, seen
entries, candidate outbox, retry state, scheduling checkpoints, and report outbox.
Its sibling process lock and SQLite FULL/WAL transactions protect durable
progress. Each run is fenced by project, host authority, persistent home-volume
identity, root, and policy version. The host rechecks owner authorization and
volume lifecycle before reads and candidate acceptance. Missing/replaced volumes,
authorization failures, and I/O errors defer work; none means an empty directory.

Default bounds are 4,096 retained project runs/summaries and 64 MiB of charged
census metadata. Each run allows 10,000 directories, 100,000 entries, 10,000 entries per
directory, 10,000 `.chat` candidates, and depth 32. A step reads at most 100
Dirents from one directory with a cooperative 100 ms budget, retaining at most
four open directory cursors. Candidate handoff accepts at most 16 paths per pass.
Limits include replay work and non-chat entries; exceeding them reports partial
coverage rather than silently truncating a successful census.

The worker compacts up to 16 completed, fully handed-off frontiers before and
after each traversal pass. Directory/entry/candidate rows are reclaimed; run
scope, counts, exclusions, partial coverage, and immutable report retries remain
durable. Journal receipts and dirty source intent are never removed by
compaction. Unfinished directories, quota-blocked runs, and unacknowledged
candidates are not evicted. Source ingestion can remain pending or failed after
traversal compacts, and reports continue to reflect that journal state.

Each admitted run reserves 8 KiB for its compact summary, report checkpoint, and
one previous-run summary (not an unbounded history);
the byte budget also reserves the bounded generic checkpoint table. Per-project
reports have their own table rather than competing for the 256 generic keys.
Existing databases migrate report payloads and charge the reserve without
dropping old work, even if a newly reduced budget is already exceeded.

These are explicit capacity ceilings, not a scope limited to the first projects.
Trusted operators can set `COCALC_COLLABORATORS_CENSUS_PROJECTS` (default 4096,
maximum 100000) and `COCALC_COLLABORATORS_CENSUS_BYTES` (default 67108864,
maximum 1073741824), as positive decimal integers, before starting/restarting
the worker. The same options are injectable by host/Lite adapters. Increasing
capacity preserves unfinished progress and needs no chat paths. Invalid settings
fail construction. At a configured hard cap, new admission stays pending instead
of deleting unfinished work; increase the relevant budget to admit it. Byte-only
blocked frontiers retry with their prior progress when compaction or a larger
budget leaves headroom. Semantic per-run quotas remain partial until an explicit
policy change; they are never reset as though traversal had succeeded.

For a quota-blocked unfinished run, operators can clean up the existing volume
and set `COCALC_COLLABORATORS_CENSUS_RESCAN_REVISION` to a new stable token before
restarting the worker. Tokens are 1-64 ASCII letters, digits, dots, underscores,
or hyphens, starting with a letter or digit. Keep the chosen token configured on
subsequent restarts. This requests a path-free rescan of each eligible project
as the bounded scheduler visits it, not a synchronous scan or a public API call.
Operators can instead increase per-run limits using
`COCALC_COLLABORATORS_CENSUS_DIRECTORIES`, `_ENTRIES`, `_DIRECTORY_ENTRIES`,
`_CANDIDATES`, or `_DEPTH` (each suffix uses the full
`COCALC_COLLABORATORS_CENSUS` prefix). These accept positive decimal integers,
with a maximum of 1000000 except depth, which has a maximum of 256. Changed
limits are included in the persisted policy identity; an unchanged configuration
does not repeatedly reset a run after restart.

A same-volume policy rescan waits for every old candidate handoff and any
unacknowledged immutable report retry to drain. It then atomically installs a
new CAS-fenced run and retains the prior aggregate status under `status.previous`.
Existing catalog snapshots, journal receipts, dirty intents and source failures
are not cleared. Old cursors and late ACKs cannot modify the new run. If handoff
or reporting remains unavailable, the reset stays pending with the old partial
progress intact. Ordinary hourly rescans use the same drain rule. Authority or
volume replacements still use their separate scope fencing, not this same-volume
reset path. Metadata reads never trigger a reset or traversal.

Source-journal admission has independent trusted runtime settings:
`COCALC_COLLABORATORS_JOURNAL_SOURCES` (default 10000, maximum 1000000) and
`COCALC_COLLABORATORS_JOURNAL_BYTES` (default 268435456, maximum 4294967296).
Both are validated positive decimal integers before the service opens its lock;
the byte setting bounds charged activity and pending metadata, not total SQLite
file size. For example, a source budget of 12000 admits 1000 projects with 11
sources each, subject to other independent quotas. Lowering a budget never evicts
sources, receipts or retries; existing sources remain writable but admission
above the source cap fails. Raising the cap on restart allows deferred candidates
to retry without knowing their paths. Source enumeration remains paged at at most
100 entries. Owner inventories, relation storage, and per-source limits retain
their own budgets; raising this setting does not waive them.

The service-local directory stream uses Linux directory descriptors, `O_NOFOLLOW`,
and `/proc/self/fd`/mount IDs. It rejects symlink traversal, directory mutation or
replacement, and crossings into another mount, including bind mounts. It streams
Dirents instead of materializing whole directories. Individual stream operations
have a five-second deadline; at most 32 streams are admitted process-wide, and a
timed-out kernel operation retains its slot until cleanup. This does not bound
every existing lifecycle-lock or operating-system wait in the larger pipeline.
Non-Linux platforms fail explicitly; they do not use a weaker traversal fallback.
The capability is internal and excluded from the public filesystem RPC surface.

The hosted scope is `/home/user`, excluding `.snapshots` and `.trash` subtrees.
Symlinks are not followed. Other ordinary directories, including hidden folders
and `node_modules`, are eligible within the limits. Encountered exclusions,
symlinks, inaccessible directories, and capacity failures keep coverage partial.
Every discovered regular `.chat` can enter the existing journal, even if absent
from all registered-source inventories. Candidate acceptance and a per-run receipt
commit together; the census acknowledges only after that durable handoff. Normal
source registration, identity, copy/relocation, extraction, and delivery fences
still apply. Discovery neither initializes a room nor grants access or enrolls
an agent.

Open directory positions are not restart tokens. After restart or a disabled
interval, unfinished directories replay from the beginning and deduplicate only
durably recorded entries; completed directory state (or its compact summary) and
pending candidates remain persisted. Failures retry with persisted exponential
backoff capped at 60 seconds.
A completed, fully handed-off run becomes eligible for a fresh census one hour
after its start; a scope/volume/policy change starts a new CAS-fenced run. A
quota-blocked run remains partial rather than repeatedly discarding its progress.
The hosted scheduler persists alternating admission and refresh sweeps: the
admission sweep visits unseen projects before scheduling hourly recrawls, and
each sweep advances past inaccessible or capacity-blocked projects. Volume or
authority changes still replace stale scopes with a fenced new run.
Concurrent external changes after a directory visit are not a snapshot guarantee;
normal filesystem journals and later censuses provide subsequent reconciliation.

Owner telemetry uses `discoveryForHost` and `reportDiscovery`, with immutable
run-CAS/sequence retries. Reports contain counts, not paths or message content,
and are scheduled after source delivery, up to 16 projects per pass under a
cooperative 500 ms budget, with a 30-second minimum interval per project. The
round-robin cursor advances before each RPC, so a failed owner does not stop the
rest of the batch or pin the next pass. At the two-second service cadence, a
1,000-project batch sweep needs 63 passes rather than 1,000. Transport delays and
large operator-configured populations can still make reports stale; stale is
never presented as complete. `getDiscovery` is a membership-checked,
metadata-only owner read. Missing reports are pending; reports from a former host
or older than 30 minutes are unavailable. Selected-project list responses surface
this status in their coverage notice. Source failures/pending deliveries remain
distinct from completed directory traversal. Even a completed scoped census is
not a claim that archived history, resource extraction, or all relationship
summaries are complete.

## Canonical room background flush

The worker's optional `beforeRead(scan)` flushes only an owner-confirmed,
initialized canonical human room before disk extraction. Hosted `writerState`
returns `canonical_room?: CollaborationRoom` only for the enabled current host's
active source at the owning bay. It neither creates a room nor selects or
impersonates a human account. Account-home attention delivery is unchanged.
Lite resolves the same pointer and writer epoch in its local owner store.

Adapters hold copy/deletion/relocation and volume lifecycle fences, require the
existing disk and live markers, reject copy namespace markers, and create a
short-lived standalone normal SyncDB with the existing local sandbox injected.
Only normal `save()` / `save_to_disk()` APIs write chat data. Post-save disk content
must match the captured live snapshot; a silent no-op or concurrent different
snapshot defers the source instead of claiming success. Missing files return to
normal tombstone extraction without opening history. Flush never creates parent
directories, arms historical notifications, or resurrects an initialized room.
Service-mediated writes retain their normal journals: an atomic `writeFileDelta`
or `writeFile` is one collaboration write intent, not a temporary-file relocation.
Nested artifact-catalog observers still execute. Unmediated shell deletion or
replacement races remain outside these service fences, as before.

This runs from the bounded registered-source worker inventory, not browsing,
file scanning, a global watcher, or project startup. Host data uses the already
running host Conat router/persist service and existing project volume; injected
filesystem access does not invoke project filesystem RPC, provision storage or
start stopped compute. Persist resolves project SQLite paths from host storage
and rejects missing project roots. Unavailable storage/history defers with the
journal's durable backoff, and inventory retry needs no browser reopening.
After flushing, the worker reacquires the scan generation while retaining the
original epoch and all transition/checkpoint fences, so the flush's own journal
write cannot cause an endless stale-generation loop.

Admission checks the canonical project's patch-stream metadata before acquisition
and after readiness: at most 10,000 patches / 64 MiB uncompressed history. It uses
the existing authorized persistence `inventory()` RPC (count and uncompressed
bytes only), with a 10-second request timeout and a 30-second SyncDB readiness
timeout. General SQLite RPC is disabled on production persistence servers and
is not used. Inventory aggregates the stream without downloading its messages;
it does not impose a separate server-side SQL scan-work limit. The conservative
whole-stream ceiling covers checkpoint fallback; over-limit rooms defer rather
than truncate. This is admission control, not an atomic streaming memory limit
against concurrent appends during replay. Disk and live snapshots also retain
the 16 MiB / 100,000-row ceiling. There are at most 16 serial source scans per pass.
The standalone session's network-save phase has a shared 30-second deadline,
including the save inside `save_to_disk`; expiry rejects before its disk-write
continuation. Native Conat close only tears down local subscriptions/tables, not
network saves. Already-started local filesystem writes are awaited under the
lock, never abandoned by a timeout; OS-level blocked I/O can therefore delay that
source. Failed attempts retain dirty work across worker restart, including a
successful disk write whose acknowledgement was lost.

## Identity and lifecycle handoffs

Thread resource IDs use durable native thread IDs. Extraction emits unnamed agents
as `agent-thread:<thread_id>` with no `agent_id`: discovery never registers,
enrolls, forks, or invokes an agent. The owner matches these source IDs against
the existing agent registry and its verified conversation history, using the
registered agent UUID as the canonical resource ID. Its catalog retains bounded
`agent_resource_ids` compatibility bindings (also on deleted rows) and
`agent_source_activity` for monotone activity across successor conversations.
Rehome must transfer both fields. Legacy point lookups echo the requested target
while resolving the current registered endpoint; personal-state migration runs
at the account home. Writer recovery checkpoints retain the native current-thread
ID and its raw activity counter, not the canonical agent's accumulated activity.
Lineage is limited to 1,001 IDs / 64 KiB per agent; overflow or conflicting claims
fail closed rather than rebinding old references.

Lite uses the same adapter through a read-only `agentIdentities` provider. The
standalone runtime has no existing enrollment registry to supply it: those
sessions keep native thread IDs, and discovery does not create a registry or
enroll them. Copy-namespace IDs never join either adapter. Artifact IDs hash the
native thread/artifact ID pair to a bounded UUID; existing viewer `entry_id` is the catalog's
SHA-256 locator key. Creator attribution is omitted when the source does not know
it; thread creators are not assumed to be artifact publishers.

Known filesystem renames persist relocation intent before mutation. Both paths
are fenced until the owning bay confirms a locator transition. The worker's
`relocate({project_id,operation_id,from_chat_path,to_chat_path,expected_epoch,
expected_destination_epoch}) -> {epoch,revision}` hook is wired to host-bound
`collaborators.relocateSource`. It freezes both owner writer epochs in the journal
before RPC and retries exactly that request after a lost acknowledgement or
restart. `journal.acknowledgeRelocation(operation_id, epoch)` transfers identity,
activity, copy quarantine and pending immutable event facts to the new locator.
Retired locators cannot be rediscovered as fresh sources. Destination checkpoint
recovery completes before publication. An unknown filesystem outcome requires
explicit reconciliation; it is never guessed from a timeout. Owner CAS must fence
in-flight old-source writes during its transition.

Service-mediated copies persist an operation UUID before copying. Fresh targets
are fingerprinted against the original source before and after copying; existing,
failed or ambiguous targets stay quarantined. Directory discovery is bounded at
10,000 directories / 1,000 chat sources; ordinary non-chat Dirents are skipped
without per-file stats or consuming these limits. The worker's `initializeCopy(copy)` hook
uses live SyncDB to persist one `collaborators-identity` namespace marker, then
acknowledges the intent. Messages, native IDs, authors, artifacts and agent config
are not rewritten. Extraction derives new catalog IDs from namespace + native ID;
rename and host migration preserve that marker. A copy-of-copy receives a fresh
namespace. No aliases or agent identities are allocated. Retry saves the same
marker after a lost ACK. `withCollaborationCopyLock` excludes service-mediated
copy/rename/delete while a namespace is saved, but allows the normal SyncDB disk
save. Both hosted and Lite initializers must use this guard. Hosted same-project
bulk, reflink and exact staged copies journal final project locators before raw
I/O, not temporary staging paths. Known no-clobber skips leave existing identities
alone. Witnessed regular-file reflinks use the same namespace initialization.
Unmediated shell copies/moves, nonregular or ambiguous targets,
and existing-target overwrites require explicit reconciliation rather than
guessing identity or silently mutating an existing destination.

The host rejects recreating an initialized room whose durable marker is missing
on disk or in live SyncDB. Existing nonempty
chats are not silently adopted. All human writes use live SyncDB and its normal
save APIs; no raw `.chat` edits and no agent transport occur. First creation makes
the sandboxed parent directory before acquiring SyncDB. A durable fresh-empty-room
intent is saved before its marker: a lost source-save ACK can retry notification
arming before the first message, while restored markers without that intent and
already-initialized rooms cannot rearm historical messages.

Explicit replacement is a separate owner-confirmed operation, not a read or an
automatic recovery action. `replaceRoom` reserves room-service admission, the
copy/filesystem lifecycle locks, and the journal write fence before confirming
`lstat` returns ENOENT. Existing files, corruption, and access/read failures do
not qualify. The owning bay atomically stores an actor-bound retry receipt,
switches the expected room identity/path to a fresh identity/path, permanently
retires the old source, and tombstones its catalog identities. The normal human
chat service then initializes only the new marker. No transcripts or personal
state are copied. Every ordinary room mutation includes `expected_room_id`, so
a delayed create/send cannot silently target the replacement.

At most 32 replacement receipts are retained per project, including superseded
operations; no eviction makes an old operation executable again. Retry the same
request and expected identity after an unknown outcome. A superseded receipt
returns no actionable path and never initializes another room. Receipts and
retired identities survive project archive/owner handoff; hard deletion cleans
them with the project. Restoring the original room is distinct and must happen
before replacement if its original identity is to remain canonical.

Current-owner room lookup also returns the bounded retired-identity list to the
host service. Ordinary initialization can therefore reconcile a lost replacement
acknowledgement without requiring its original owner to retry. Retirement clears
only that source's derived relation drafts, rows, and pages in the same journal
transaction; unrelated sources and permanent identity/activity fences remain.

Host migration/recovery uses owning-bay `writerState` to freeze the initial CAS
base, then reuses that base and registration ID on retry. After a failed delivery
or registration, recovery may change the base only when owner state differs and
the writer belongs to another host (or is absent), never to steal a newer writer
on this host. The worker's `sourceActivity({project_id,chat_path,epoch,after?})`
returns `{epoch,resources:[{kind,resource_id,activity}],next?}`. Hosted production
maps the owning-bay `checkpointPage` response's `items` to `resources` (50/page).
Cursor and floors persist before advancing. No source scan or delivery is allowed
until its new epoch's entire checkpoint is imported; changed/expired cursors
restart paging without losing already imported floors. Owner exports must include
retained resource tombstones, not only currently visible resources.

After journal loss, visible message IDs are baselined at the owner's activity
floor. If the owner has activity 100 and the current rotated head has 20 messages,
the baseline remains 100 and the next new message is 101, not 21 or another 100.
The first recovery scan is a conservative no-history notification boundary:
without immutable accepted IDs it cannot distinguish messages arriving during
the outage from unindexed old history. Existing pending event facts remain
immutable across fencing recovery; only their transport/resource floor changes.

## Durable notification production

Canonical human-room extraction emits original authored message facts only:
project/room/thread/message/actor IDs and bound person mentions or mention-all.
It excludes bodies, snippets, agent references, quoted blocks, code and links.
Edits cannot add notification targets. The host journal assigns activity once,
atomically records immutable event intent alongside activity evidence, and
transports `notification_events` through ordinary authorized source ingest.
Event identity never includes path, source epoch or wall clock.
Human thread config's bounded UUID `notification_followers` and
`notification_muted` arrays travel as legacy migration hints. They do not become
participants and are not inherited by copied namespaces or agent threads. The
account-home migration honors explicit personal choices over these hints; lists
exceeding the shared 1,000-account bound fail rather than silently drop mute state.

Initial scans, adoption, known volume restore and missing-file reappearance are
backfill boundaries, not live history floods. Newly created empty rooms call
`journal.armNotifications(source, room_id, lifecycle_generation?)` before their
first message. Lite supplies its canonical `humanRoomPath` to extraction and
uses the same arming hook. Copied namespaces do not produce canonical-room events.

Pending events are bounded at 100,000 per host and counted against its 256 MiB
journal cap. Complete resource snapshots carry at most 100 events per delivery,
also respecting the shared byte cap. Bursts drain from frozen resource snapshots
before newer scans may remove the referenced threads. Lost ACKs replay the same
payload; writer recovery changes only the transport epoch/sequence, preserving
facts and resource evidence. The owner must append validated events inside its
ingest transaction even when metadata itself is unchanged. The server's
owner/home notification outbox handles recipient paging, read/mute policy and
deduplication; the host neither expands mention-all nor writes a parallel feed.

Legacy timestamp identities use persisted identity markers through the normal
SyncDB migration adapter. The background relation reader joins the saved head
with its supported chat-store archive, including modern-ID sources without
migration markers. Canonical agent ID enrichment and unmediated filesystem
reconciliation remain separate from discovery: browsing never enrolls or forks
an agent.

## Complete Relation Delivery

Participant previews are not a relation inventory. The chat relation extractor
emits every resolved human participant and current authored typed reference from
the supplied head/archive rows. It captures native thread/resource provenance
before registered-agent canonicalization; copied resource namespaces and authored
reference targets are retained verbatim. Reference edits remove superseded edges
only when a new complete set is admitted. No message bodies are journaled.

An archive-aware reader streams those facts into
`collectCollaborationRelationDraft(journal.relations, scan, edges, complete)`.
The final callback must confirm a stable, complete head and archive read. EOF or
a bounded partial scan is not completeness proof. An incomplete read discards
its candidate and sends no replacement relation manifest. Missing/malformed
identity or capacity errors fail rather than silently publish a truncated set.

The journal binds a sealed draft to the same source epoch, read generation, and
metadata delivery sequence. It stages immutable pages through
`stageRelationPage`, at most 200 rows/256 KiB per page and four network pages per
worker pass. Only after every page is acknowledged does ordinary metadata ingest
carry the verified manifest and atomically activate the set at the owner. Empty
sets require the same explicit completeness proof. Stage prefixes remain hidden.
Lost page/ingest acknowledgements replay persisted bytes after restart, without
rereading the chat. Notification-only delivery batches reuse the committed set;
writer or mediated locator recovery regenerates epoch-bound hashes from the
retained native facts. Old replies cannot acknowledge a new writer's delivery.

Limits are one million extracted facts and 64 MiB of charged facts per set,
10,000 local drafts, and 256 MiB of charged fact/page storage per relation spool.
The 64 MiB local bound also charges deduplication keys, so it can reject before
the shared wire bound. Append batches are bounded; each message reference parse
is limited to 1 MiB. Exhausting a bound preserves the previously committed graph
instead of guessing whole-history deletion. Host facts/pages are removed after
the last associated metadata/event delivery is acknowledged; restart recovery
also removes abandoned unbound drafts. These transport guarantees do not by
themselves prove the reader has enumerated all history.

Hosted and Lite producers call `readCollaborationRelationSource` for each admitted
source. It reads at most 16 MiB of saved head and 32 MiB of archive with a combined
100,000-row cap. The archive read is a read-only SQLite snapshot, with pending
rotation/migration fences and no create-on-read. The reader rechecks head/archive
contents and the source generation before sealing. A saved head edit takes
precedence over old archived versions; otherwise the latest archived row wins
only for the same message/thread/author identity. Conflicting identities abort.
The supported archive locator is the same default/environment-selected store as
normal chat-store operations; arbitrary custom archive databases are not scanned.

Missing heads produce normal tombstones without opening archives or recreating
files. A head declaring history with no registered archive defers the source,
not a guessed empty graph. Stale counters after deletion within a known archive
do not resurrect deleted rows. Relation-only parse/capacity failures may publish
the fully read resource metadata with an explicit partial reason while retaining
the last verified graph. Copy/relocation and volume fences remain in force; these
checks do not strengthen the existing guarantees for ambiguous shell mutations.
