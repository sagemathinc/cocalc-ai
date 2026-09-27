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

Caps are 10,000 sources, 1,000 active filesystem intents, 100,000 identity ledger
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

Discovery pages the collaboration and artifact chat-source inventories and revisits the
local journal. The canonical room is registered for scanning but not initialized
by discovery. Shell-only sources absent from that inventory need a separate
bounded backfill. Timestamp-only legacy threads/messages fail the entire source
until explicit identity migration; no path-based fake durable IDs are assigned.

## Identity and lifecycle handoffs

Thread resource IDs use durable native thread IDs. Unnamed agents are discoverable
as `agent-thread:<thread_id>` with no `agent_id`: discovery never registers,
enrolls, forks, or invokes an agent. A canonical agent-identity adapter is still
needed, especially for identities with successor conversations. Artifact IDs
hash the native thread/artifact ID pair to a bounded UUID; existing viewer `entry_id` is the catalog's
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
on disk or in live SyncDB. Explicit room restore/replacement remains owner-lifecycle
work. Existing nonempty
chats are not silently adopted. All human writes use live SyncDB and its normal
save APIs; no raw `.chat` edits and no agent transport occur. First creation makes
the sandboxed parent directory before acquiring SyncDB. A durable fresh-empty-room
intent is saved before its marker: a lost source-save ACK can retry notification
arming before the first message, while restored markers without that intent and
already-initialized rooms cannot rearm historical messages.

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

Legacy timestamp identities still require explicit migration. Archive rotation
retains thread roots and last-message dates but marks historical participant
coverage partial; complete archived history requires an archive-aware bounded
reader. Canonical agent ID enrichment and unmediated filesystem reconciliation
remain separate from discovery: browsing never enrolls or forks an agent.
