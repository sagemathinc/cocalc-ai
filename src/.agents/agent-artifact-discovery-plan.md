# Cross-agent artifact discovery

Status: the metadata catalog and warm browser cache are operational; manual
testing confirmed essentially instant discovery. The permanent shelf has been
replaced by a full-page Library and a toggleable thread-local artifact panel.
Opening or filtering the Library never initiates chat-file scans or starts projects.

## Library and thread panel (2026-09-23)

- Library replaces the main content area, with global cached search, project
  filtering/grouping and personal pins. Existing agent workspaces stay mounted
  but inactive so navigation preserves drafts and open tabs.
- A minimal right-hand panel lists only the current thread's artifacts. Its
  toggle, close button and Escape dismiss it; Open Library goes to global discovery.
- Library items open in the associated source agent/thread and Workbench, not
  alongside an unrelated agent. Source project/chat identity is checked before
  opening. Show conversation remains a separate operation.
- The stationary-opening experiment below is superseded. Existing saved foreign
  tabs remain readable for compatibility, but normal discovery no longer creates
  them. The shelf and its independent opening helper have been removed.
- User-created artifacts, standalone artifacts without an associated agent,
  durable Library URLs, live feeds and persistent browser metadata remain future
  work; this checkpoint does not change resource access or publication permissions.

## Superseded: shelf and stationary tabs checkpoint (2026-09-23)

- A compact shelf shares the expanded browser's account-scoped catalog. This
  agent / All agents changes only local filtering; pins retain personal order,
  followed by stable creation order. The shelf bounds rendered items to 40 and
  keeps the searchable browser for additional results.
- Artifact opening validates the source and opens a source-aware tab alongside
  the current conversation, without selecting the source agent/thread or
  changing the destination draft. Tab identity includes source project/chat,
  thread, artifact and revision.
- Foreign tabs restore from source descriptors and use the source project's
  context and live document for rendering/editing. Closed/replaced source
  runtimes block writes and expose retry instead of using stale handles.
- Show in conversation is explicit and resolves the producing publication's
  message, including archived messages. Local artifacts retain feedback controls.
  Foreign comments, action-review submission and agent requests remain disabled;
  use Show in conversation for those operations. Opening notebooks does not run
  their cells.

Remaining UI work: persistent IndexedDB cache, live updates instead of polling,
larger virtualized collections, broader historical coverage, shelf reordering,
and safe cross-source feedback. Personal names and optional URL aliases remain
deferred; stable artifact identity must stay independent of naming.

## Catalog implementation checkpoint (2026-09-22)

Implemented storage primitives, owner-routed ingestion and reads, service
workers, a standalone Lite adapter, and an in-memory frontend catalog preview:

- Bounded, content-free metadata protocol with canonical source identities.
- Shared extraction of published current artifacts from complete chat records.
  Malformed artifact rows fail a snapshot rather than becoming silent removals.
- Host-private SQLite write-intent journal with crash recovery, immutable retry
  payloads, generation checks, persisted backoff and asynchronous registration.
  First writes can be journaled without contacting an available hub.
- Bounded single-flight source projector with injectable sandbox reader and
  owner-routed sender, single-flight timer, and service lifetime process lock.
- Project-owning-bay Postgres catalog/source/outbox tables. Ingestion checks
  current project owner/host under a lock; owner-issued writer epochs fence
  stale writers. Registration and delivery retries are idempotent.
- Catalog updates and the projection outbox commit atomically. Removals leave
  tombstones; original creation order survives updates and reappearance.
  Ordinary chat writes with unchanged metadata do not generate feed churn.
- Host-authenticated registration, writer-state lookup and ingestion RPCs,
  routed through the trusted fabric to the project-owning bay. The owner
  rechecks directory epochs and bounds concurrent work globally and per host.
- Portable single-flight registration worker with persisted CAS bases and
  retry backoff. Lost responses/restarts retry the identical registration;
  conflicts cannot silently acquire a newer writer's epoch. Its transport is
  injectable for project-host and Lite adapters.

- Project-host filesystem hooks journal chat mutations before execution,
  including indexed descendants of directory renames/deletes. Background
  discovery reconciles registered sources and known agent chat paths without
  starting projects or waiting for the artifact browser to open.
- Standalone Lite has a separate SQLite catalog, local writer adapter,
  account-checked metadata reads, filesystem hooks, and bounded historical
  discovery. Its lifecycle starts only from the standalone Lite entrypoint.
- Human metadata reads recheck collaboration at the owning bay and use indexed
  keyset pagination. Hosts use a separate authenticated source-discovery API.
- All agents now warms an account-scoped memory cache while the Agents page is
  mounted. Opening, searching, sorting and filtering use that cache rather than
  chat scans. Refreshes swap snapshots atomically in the background every ten
  seconds. Errors clear cached metadata; no cache survives logout/unmount.
- Explicit preview bounds: 100 projects, 100 pages, 10,000 entries and roughly
  16 MiB retained metadata. The UI renders at most 200 filtered results and
  reports incomplete coverage. Only current known agent conversations can be
  opened through this preview.

Manual-test checkpoint: dev hub and project-host deployment includes the catalog
pipeline and frontend preview. Live Postgres ingestion has been verified.
Standalone Lite is covered by tests/typecheck, not a live deployment test.

Not implemented yet: account-home projections/outbox delivery, live feed,
or IndexedDB cache. The shelf/stationary-tab checkpoint above builds on this.
Initial page loading still fetches metadata; only a warm cache is instant.
Host backfill discovers
known agent/registered chats, not arbitrary previously unseen chat files; raw
shell edits reconcile only after the source is known. Source parsing is bounded
to 16 MiB and failures retain prior metadata rather than implying deletion.

## Chosen ownership model

- Source documents remain authoritative for content. The Postgres catalog is a
  durable, rebuildable metadata projection in the project's owning bay.
- Account-home projections contain only artifacts visible through project
  collaboration. Agent Network membership confers no artifact access.
- DKV holds only personal pins, ordering, hidden state and shelf preferences.
- The frontend cache is partitioned by account/server. Revocation purges cached
  project metadata; every open rechecks service authorization independently.
- Artifacts are independent of agents. Optional agent association is a filter,
  not their owner or lifecycle. File contents and stateful sessions remain in
  the project data plane. Opening must eventually support source-aware tabs in
  the current workbench without changing the user's composing conversation.

## Catalog stages (first two now integrated)

1. Wire the source journal into service-owned chat filesystem mutations before
   writes, deletes and renames, covering CLI and browser saves. Fence prior
   service writers before recovering interrupted intents. Journal registration
   must retain its retry identity across lost responses and host restarts.
   Connect the implemented authenticated, owner-routed registration/ingestion
   RPCs to the portable workers; host identity and owning bay come from
   authenticated routing, never caller payload.
   Workspace/Lite service integration needs its own lifecycle adapter.
2. Add resumable background backfill of saved chat sources, including prior
   agent conversations. Never drive it from opening the shelf. Bound parsing,
   bytes, concurrency and retries; expose incomplete/error coverage. External
   filesystem edits and project moves/restores need reconciliation. Source
   registration/state lookup must support a journal lost during host migration.
3. Drain the catalog outbox into authorized account-home projections using
   trusted inter-bay routing. Cover new collaborators, removal, project deletion,
   account/project rehome and revocation races with replayed updates. Membership
   removal must win over delayed artifact deliveries. Keep tombstone/revision
   floors until replay/snapshot recovery can no longer resurrect old rows.
4. Add authenticated snapshot/cursor APIs and account-feed delivery with explicit
   snapshot-to-feed handoff and gap recovery. Feed broadcast alone is not the
   source of truth. Do not delete outbox work until durable projection succeeds.
   Use keyset pagination and indexed metadata queries, not chat scans.
5. Maintain one account-scoped frontend catalog store, warmed independently of
   the modal, then persist metadata in IndexedDB. Switch scopes/search/order
   locally. Replace the scanning browser only after this path is verified.
6. Add the compact artifact shelf and source-aware tabs. Preserve pin ordering
   across scopes; other artifacts use creation order with an identity tie-break.
   Virtualize large lists and lazy-load thumbnails. Keep a searchable expanded
   browser for large collections.

Performance acceptance: a warmed shelf and scope toggle must render without a
network round trip (target under 50 ms local interaction at 1,000 entries).
Cold first use requires a bounded metadata fetch and must show truthful loading
or coverage state. Verify 10,000-entry behavior without rendering all thumbnails.

The initial complete-source transport caps 5,000 items / 2 MiB. Capacity errors
must retain the previous catalog and surface incomplete coverage, never silently
truncate a replacement snapshot. Larger sources need a staged, atomically
committed paginated snapshot protocol before increasing these bounds.

## Initial implementation and limits

- Reuses the authenticated project-host chat search RPC and worker admission,
  memory, execution-time, concurrency, and start-rate limits.
- Scans saved heads, capped at 8 MiB, for artifact publications/current metadata;
  message offload preserves these records. Does not open editor sessions or
  create a new index. Unsaved edits are not included in cross-agent discovery.
- Returns bounded metadata pages for one explicitly scoped thread; browser
  requests at most 20 pages / 20 seconds per pass and retains at most 500 results.
- Provides query/project filtering, partial-result warnings, continuation, and
  personal pins ordered ahead of other discovered results. Pins in unsearched
  sources are not yet resolved independently. Sorting is over discovered results.
- Covers current conversations from the human's full agent directory, not just
  mounted workspaces or members of a selected Agent Network.
- Opening switches to the source agent, rechecks its current identity, opens
  its project-owned chat runtime, rereads the artifact, and opens that source
  Workbench. It does not embed a foreign artifact against the current chat.
- Older hosts explicitly report unsupported discovery. Production needs the
  updated project-host/backend code as well as the frontend.

Remaining limitations: large heads need indexing, historical agent conversations
are not searched, pins outside discovered pages are not independently resolved,
and cross-source tabs in one stationary Workbench are not implemented.

## Existing seams

- `frontend/chat/artifact-catalog.ts` derives a deduplicated catalog from the
  loaded chat SyncDB's publication records and current artifact records.
- `backend/chat-store/sqlite-offload.ts` searches saved chat message text;
  artifact records are not included in that search contract.
- `frontend/agents/search-runner.ts` already models bounded multi-agent search,
  progress, unavailable projects, and continuation. Reuse its scheduling ideas,
  not its message-search result schema.
- `frontend/chat/open-artifact.ts` delegates to `open-result.ts` using the
  current ChatActions. Cross-agent opening must explicitly preserve the source
  project, chat path, thread, artifact ID and publication version; passing a
  foreign publication to the current chat's actions is not sufficient.
- Personal pin keys already include project, chat path, thread and artifact ID.
  They are references/preferences, not an authorization source or content cache.

## Superseded scan-oriented implementation slices

1. Add a rebuildable project-host metadata catalog of published artifacts. Store
   source locators, title/description, kind, searchable metadata, current
   publication identity and timestamps. Do not copy notebook/file contents or
   instantiate editor sessions. Update on publication/current-record changes;
   handle deleted artifacts and files explicitly. Backfill existing chats in
   bounded batches and expose indexing coverage instead of reporting an
   incomplete catalog as complete.
2. Add a paginated, bounded query endpoint for explicitly authorized source
   agents/threads. Route project operations through the owning bay/project host;
   do not assume the caller's hub owns the project. Reuse authenticated account
   admission limits, enforce result/query bounds, and recheck project access.
   Never accept a caller-supplied account identity as the admission key.
3. Add All agents and a project filter to the browser. Derive scope from the
   human's agent directory, not network membership or currently mounted chats.
   Return bounded pages, label each result with its source agent, and show
   unavailable/unindexed projects and continuation state. Define sorting as
   applying to searched results until every relevant source has been covered.
4. Resolve/open a selected result through its source project and chat while
   presenting it in the current Workbench. Preserve source identity for feedback
   and Show in conversation. Opening a notebook must not execute cells.
5. Resolve pinned locators in bounded batches, independently of the first
   discovery page. Preserve personal ordering and clearly mark inaccessible or
   missing entries without exposing cached content after access loss.

## Acceptance

- Find artifacts from an agent whose chat has never been opened in this browser.
- Distinguish identical artifact IDs in different threads/chats/projects.
- Cover a large directory with bounded work and resumable, truthful results.
- Cancellation/repeated searches cannot multiply outstanding backend work.
- Exercise index backfill, updates, removals, stale cursors and offline hosts.
- Open a cross-project result in Workbench and jump to its actual source message.
- Ensure revoked project access fails on both discovery and opening.
- Preserve pinned order across paging/filtering; support keyboard and mobile UI.

Do not replace global discovery with a loaded-chat-only catalog. Do not claim
the persistent index or stationary cross-source Workbench is implemented by the
initial bounded scan.
