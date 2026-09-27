# Collaborators workspace: discovery, human conversations, and shared work

Status: implementation in draft PR #727, behind default-off `collaborators_enabled`.
Date: 2026-09-27.
Source baseline: `origin/main` at `666b351e60`.

## Implementation record

The plan below remains the design and acceptance checklist. The implementation
adds the global Collaborators destination, owner/home discovery APIs, bounded
metadata producers and projections, canonical human rooms, independent personal
state, and typed references. It reuses the existing project access model, chat
renderer, Library, agent viewers, and notification graph. This is a review build,
not a production enablement or a claim that every rollout gate has been passed.

Implementation entry points:

- `packages/util/collaborators.ts` and `collaboration-references.ts`: shared
  discovery contracts and stable typed reference codecs.
- `packages/database/postgres/collaborators-*.ts` and
  `packages/server/collaborators/`: owner catalogs, account-home projections,
  routed APIs, capacity limits, access leases, and independent personal state.
- `packages/backend/collaborators/` and `packages/project-host/collaborators*.ts`:
  durable filesystem intent, identity/activity recovery, metadata production,
  and the human-room data-plane service.
- `packages/chat/src/collaborators*.ts`: source metadata extraction, human-only
  room/thread/message operations, and copy identity namespaces.
- `packages/server/notifications/collaboration*.ts`: durable event consumption
  through existing notification policy and delivery infrastructure.
- `packages/frontend/collaborators/`: global views, bounded queries, detail
  navigation, human chat, personal controls, and reference selection.
- `packages/lite/collaborators/`: explicit standalone single-account adapter,
  not an emulation of multibay or multiuser membership.

Operational contracts and bounds are documented in the backend, server, and Lite
`collaborators/README.md` files. Important rollout boundaries:

- The flag is off by default. Disabling it preserves chats and personal state;
  ordinary existing agents and Library remain usable.
- Browsing reads metadata and never starts compute. Opening one selected chat
  uses the existing project-host route. New discussions explicitly create the
  registered room through that data plane.
- Project-owner membership is authoritative. Global metadata has a bounded
  60-second access lease plus client polling delay; expired leases fail closed.
  Already downloaded metadata cannot be remotely erased. Opens and mutations
  revalidate the authoritative membership rather than treating an alias as access.
- Coverage is deliberately partial for unindexed historical sources. Explicit
  `requestSource` requests one known absolute chat path for background indexing;
  it neither scans the filesystem nor adopts that file as the canonical room.
  Timestamp-only identities and ambiguous shell copies/moves require explicit
  reconciliation, not guessed durable identities.
- Supported mediated same-project moves preserve typed identity; copies receive
  a separate persisted namespace. Cross-project relocation remains excluded.
- Existing personal agent names and Library aliases/pins are compatibility
  adapters. Naming an unnamed agent thread does not enroll an execution identity.
- Project/account rehome with retained collaboration state is explicitly fenced
  where the existing rehome machinery cannot yet transfer that state atomically.
  It must not silently discard journals, room pointers, aliases, or notification
  state. Full retained-state rehome remains a rollout gate.

Validation is recorded as checks complete below; live multiuser/multibay staging
acceptance and a human UX review remain required before broad enablement.

### Validation record

The implementation was checked in an isolated worktree, a private PostgreSQL 18
cluster, and a private standalone Lite instance. No live user project was
migrated, enabled, or restarted. The PR remains a draft for review.

- Full `pnpm -C src build:dev` completed, followed by package-local builds and a
  fresh static development bundle for the final UI integration.
- Consolidated focused runs passed 892 tests across frontend, database, server,
  project-host, backend, Lite, chat, chat-client, Conat, and util. The three
  PGlite-only rehome tests are included in that count from their separate run;
  they are intentionally skipped by the PostgreSQL run.
- Focused coverage includes frontend routing, accessible controls, cache
  invalidation, draft preservation, personal controls, human-only dispatch,
  typed-reference codecs/renderers/completion, and existing alias compatibility.
- PostgreSQL integration tests cover owner/home routing, membership cutovers,
  bounded projections, replay/fencing, notification policy/outbox, Library state,
  and explicit rehome guards. PGlite-specific personal-rehome cases are run
  separately rather than counted as PostgreSQL coverage.
- PostgreSQL query-plan tests use 1,000 projects and 100,000 resources, including
  sparse personal scopes and indexed search. A 50,000-record attention cleanup
  checks transaction-coalesced revision writes, bounded execution and rollback.
  The scale suite passed again on the same isolated cluster after fixture cleanup.
- Host/backend tests cover source extraction, recovery checkpoints, immutable
  event production, mediated moves/copies, bulk-copy paths, and room lifecycle.
  Lite tests cover the separate SQLite implementation and its durable adapters.
- The isolated browser exercises actual human discussion creation, message send
  and reload, and unsent-draft preservation across list/detail navigation.
  Final acceptance also verifies dirty-replay recovery without another edit,
  rapid reload after a new send, correct For You participation/activity, personal
  alias refresh, and reference insertion/send/reload/open. Account-selected light
  and dark layouts pass at 320px and 1440px with no horizontal overflow.
  Keyboard/filter focus restoration passes the repository accessibility harness
  with zero reported violations. Native 200% zoom preserves reflow and keyboard
  access; all four Collaborators dialog types respect reduced motion while
  retaining their normal animation otherwise.
- Browser testing exposed a save/reload gap between synchronized messages and
  the disk-backed index. Autosave now filters no-op changes before debounce and
  recovers genuinely unsaved state on readiness, with regressions for clean
  reopen, pending saves, read-only access and disposal. Real serialized-chat
  pipeline tests cover disk publication, participation, activity and restart.
- Frontend lint, the full dependency audit, frozen lockfile verification, and
  dependency version consistency checks passed. Detailed
  machine-local reports are under `src/.local/`; they are test outputs, not
  runtime dependencies or checked-in user data.
- Full CI identified integration gaps beyond the focused runs. Follow-up checks
  cover exact navigation-state resets and cleanup of all project-scoped
  collaboration tables, including isolation, revision invalidation, and retries.
  The existing rehome and cleanup suites passed together (44 tests), as did the
  two navigation suites (19 tests).
- The production bundle measurement and all Essential budgets pass. Shared
  schema/RPC registration raises notifications to about 502 KiB Brotli; its
  allowance is explicitly adjusted from 500 to 505 KiB, with other budgets
  unchanged. The Collaborators UI itself is not loaded by that route.
- Independent review found a partial-resnapshot attention cleanup bug. Pruning
  now waits for the final page, preserving unread positions for live threads
  that appear on later pages. Multi-page reset and incremental regressions pass
  with the existing rejoin cases in the isolated PGlite suite (40 tests).

### Remaining acceptance and UX iteration

The foundations and first usable UI are implemented; the design checklist below
also records acceptance scenarios that still need deployment-level verification.
Do not interpret automated routing tests or standalone Lite as proof of a live
two-human, multiple-bay deployment.

- Exercise two real accounts, multiple devices, remote bays, stopped compute,
  network interruptions, and large collaborator fanout in controlled staging.
  Measure sustained projection lag and memory in addition to indexed query tests.
- Implement atomic retained-state project/account rehome before relaxing the
  explicit rehome guards. This is not a silently supported migration today.
- Human review should refine discoverability, wording, and navigation. Project
  browsing currently provides ordered/searchable results rather than a new
  dedicated pinned-project view; optional person pins are not introduced.
- Share to conversation inserts a reference into the currently selected human
  draft. A cross-conversation destination chooser is a follow-up UX improvement;
  sharing never sends automatically or changes the target's permissions.
- Historical coverage remains partial until bounded source adoption/reconciliation
  has run. Legacy path-encoded artifact URLs are not redirected; new typed
  references use stable identity. Ambiguous shell copies/moves are not guessed.

## Goal and model

Make the agent-first interface a collaborative workspace, not a collection of
isolated personal agent lists. A project contains a filesystem, compute runtime,
agents, artifacts, and collaborators. This page adds navigation over those
resources; it does not replace their storage, permissions, or execution model.

A new project collaborator should immediately be able to discover the project's
existing agents, artifacts, and human conversations without finding their chat
files or obtaining a second invitation. A teacher with thousands of projects
must be able to find relevant people and discussions without opening those
projects or subscribing to all their activity.

The three independent concerns are:

- **Access:** what the person may discover, view, or operate on.
- **Collection:** what they pin, save, organize, or give a personal name.
- **Attention:** what they follow, mute, have read, or are explicitly mentioned in.

Project membership grants existing access. A personal alias or shortcut grants
none. Access alone does not subscribe someone to notifications.

## Product decisions

- Add a first-class **Collaborators** destination beside Agents and Library.
  It is global to the signed-in account, with optional project/person filters;
  choosing one project is not a prerequisite for entering it.
- Provide **Conversations**, **People**, and **Projects** views. Reuse existing
  agent and artifact viewers rather than implementing parallel workbenches.
- Keep one canonical human `.chat` room per project, containing many threads.
  A global index points to those threads; it does not copy their messages.
- Agents, artifacts, and human threads have stable identities and shared titles.
  Personal `@handles` are optional. People retain their existing account identity
  and display-name model; they do not become project-owned objects.
- Do not require handles to be unique across resource types. The mention picker
  disambiguates by type, title, creator, and project, then binds a stable reference.
  Preserve existing per-type collision rules initially.
- Browsing does not allocate handles. Creating a human thread need not allocate
  one either; an explicit naming action may suggest `chat-n`.
- Opening, adding a shortcut, naming, and following are distinct operations.
  Removing a shortcut must not retire an agent, delete a thread, or remove access.
- Shared agent viewing and participation open the same identity and conversation,
  not a fork. Reuse current payment, credential, execution-principal, and active-turn
  rules. This project does not redesign or weaken them.
- Human chat is a human-only surface. Mentioning an agent is a reference, not an
  invocation, broadcast, Agent Network grant, or authorization to spend money.
- Project participants are not a private chat recipient list. Clearly display
  the audience, e.g. "Visible to collaborators in Geometry Lab."

## Page contents and navigation

### Conversations

Show titled human threads with project, participants, latest activity, and
unread/mention state. Support search, project/person filters, and these scopes:

- **For you:** explicit mentions, followed threads, and threads the user has
  participated in. Show a reason; do not start with an opaque recommendation feed.
- **Following:** explicitly followed threads.
- **All accessible:** indexed accessible human conversations, with pagination and
  honest indexing coverage. It is not limited to personal names or followed items.

Open a row in the existing chat/thread renderer, with a human composer and
artifact references. Preserve filters, selection, draft, scroll, and keyboard
focus on return. New conversation chooses a project, defaulting to the current
filter/context. From a person's overview, offer shared projects. Do not introduce
private direct messages implicitly when two people share several projects.

### People

Each person appears once across all shared projects. Search/filter by shared
project and optionally pin people. A person's overview shows shared projects,
conversations involving them, and accessible agents/artifacts attributed to
them. "Alice's work" must never mean everything in Alice's account.

Attribution needs explicit semantics: creator/publisher, participant, and most
recent editor are different relationships. Do not infer ownership from someone
having a personal alias. Display unknown legacy attribution honestly.

Invite collaborator selects an existing project or creates one through the
existing flow. It does not create account-wide access. With no collaborators,
show this invitation entry point and a short explanation, not empty tables.

### Projects

List accessible projects with search, recent/pinned views, and bounded activity
summaries. A selected project shows its people, conversations, agents, and
artifacts. Reuse existing add/remove/invite rules, including owner-only management
settings. Link to existing project management for compute/filesystem operations.

A project with no human conversations is still a valid result. Browsing it must
not create a chat file or start its container. Provide an explicit start-discussion
action. Saved project groups/course filters can follow; they must not be required
to paginate or search a large account.

### Common shell and links

Desktop: view tabs and filters above a results list and selected detail panel.
Narrow screens: list/detail navigation with a reliable back action. Keep the
project/audience visible inside an opened conversation even in global mode.

Provide durable routes for conversations, person overviews, and project
overviews. Exact URL spelling is an implementation detail, but opaque internal
IDs are acceptable in URLs; users should not need to see or type them in normal
interaction. Alias URLs must resolve to an identity before opening.

"Open agent" and "Open artifact" reuse their canonical viewers, including
resources absent from the viewer's personal collection. Back navigation returns
to the prior collaboration context. "Add to my agents" is a personal shortcut,
not enrollment into a new execution identity. Inspect current retire/archive
operations before reusing them as a remove-shortcut action.

## Existing foundations and gaps

Paths below are relative to `src/`. These are starting points, not claims that
the entire proposed workflow already exists.

| Existing seam                                                                                                                           | Reuse and required work                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/util/db-schema/account-project-index.ts` and `account-collaborator-index.ts`                                                  | Account-home project and deduplicated collaborator summaries. Add bounded searchable paging instead of treating a large snapshot as the global UI.                                                     |
| `packages/server/account/collaborator-feed.ts`, `project-feed.ts`, and `packages/conat/hub/api/account-feed.ts`                         | Existing projection/feed integration. Extend it with durable cursor/gap semantics for the new indexes; a best-effort live event is not a source of truth.                                              |
| `packages/chat-client/src/agent-sessions.ts` and `packages/frontend/project/page/flyouts/agents.tsx`                                    | Existing project-wide agent-session discovery and Other Users behavior. The DKV session list is project-scoped, not a global durable resource directory.                                               |
| `packages/server/agents/personal-store.ts` and `packages/conat/agents/personal.ts`                                                      | Personal agent names and network controls. Do not use a person's named-agent list as the universe of accessible agents.                                                                                |
| `packages/util/artifact-catalog.ts`, `packages/database/postgres/artifact-catalog.ts`, and `packages/conat/hub/api/artifact-catalog.ts` | Bounded, owner-routed artifact metadata catalog. Extend discovery coverage and attribution as needed; source documents remain authoritative for content.                                               |
| `packages/frontend/agents/library-entry.tsx`, `library-navigation.ts`, and `artifact-catalog-store.ts`                                  | Existing standalone Library/viewer/cache. Replace per-project discovery fanout for global queries; preserve viewer behavior and direct links.                                                          |
| `packages/util/personal-library.ts`, `packages/server/artifacts/personal-library-api.ts`, and `personal-library-store.ts`               | Account-home artifact aliases/pins. Introduce compatible adapters, not an immediate wholesale replacement of existing personal state.                                                                  |
| `packages/util/agent-mentions.ts`, `artifact-mentions.ts`, and frontend mention renderers                                               | Bound typed references already exist, but current agent/artifact wire forms require a name. Add a backward-compatible unnamed/thread form and a shared selector contract.                              |
| `packages/frontend/chat/thread-notifications.ts` and `packages/server/notifications/feed.ts`                                            | Existing follower/mention notifications. Reconcile with account-local attention state and move reliable delivery off browser-only participation. Do not create a second competing notification source. |

Read [the scalable architecture](scalable-architecture.md),
[artifact discovery history](agent-artifact-discovery-plan.md), and
[accessibility requirements](accessibility.md) before implementation. Artifact
discovery documentation contains historical checkpoints; inspect current code
before treating a listed "remaining" item as still absent.

## Stable identities and references

Define a versioned discriminated resource-reference contract shared by selectors,
routes, personal collections, and mention renderers. Keep domain-specific IDs:
agent references use agent identity and project, artifacts their catalog/native
identity, threads their durable conversation identity, and people account IDs.
Uniform presentation does not require one giant table or a new universal owner.

Separate identity from mutable title, personal alias, creator attribution, project
placement, and current chat/file locator. A selected reference must continue to
identify the same object after an alias/title change. Never re-resolve historical
message text against today's alias directory.

Before enabling new durable thread links, audit legacy timestamp thread keys,
chat paths, agent endpoints, artifact catalog entry IDs, and native thread IDs.
The artifact catalog currently includes the source locator in its derived key;
it is not yet a general path-independent identity. Define persisted identity-to-
locator mappings/redirects for supported same-project renames and moves. A copy
gets a new identity. Missing or conflicting legacy mappings must not silently
bind an old link to a different object. Cross-project relocation is deferred
unless its identity and access transitions are explicitly designed.

Mention behavior:

- Search accessible titles as well as optional personal names; duplicate handles
  across types are legitimate results, not an error to solve by forced renaming.
- Store the selected typed target plus a bounded authored display fallback.
  Preserve existing Markdown/Slate parsing and round trips via versioned forms.
- Render the viewer's alias when present, otherwise the shared title/type. Keep
  source attribution available without rewriting the authored message body.
- Copy/export retains a durable link and readable label. Literal text, quotes,
  code, email addresses, and unresolved `@words` are not automatically rebound.
- An unavailable target renders an honest unavailable reference, without fetching
  metadata the viewer cannot access. A reference never grants access.
- Sharing an artifact links the original, not a new artifact publication/copy.
  In human chat, even a valid agent mention must never trigger a turn.

## Authority and data placement

Launchpad is the one-bay case of this design. Follow explicit ownership in every
RPC and worker, including when the caller's bay happens to equal the owner.

| Data/action                                                                | Authority and route                                                                                               |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Project membership, canonical room registration, shared resource directory | Project owning bay; project data services produce validated metadata.                                             |
| Live human messages, agent conversations, artifact content and files       | Existing project-host data plane and source chat storage. No steady-state hub content proxy.                      |
| Personal aliases, collection, follows/mutes, read state                    | Account home bay.                                                                                                 |
| Global discoverability/search results                                      | Rebuildable account-home projections of currently accessible project metadata.                                    |
| Person identity/profile                                                    | Existing account authority; project membership determines the relevant shared relationships.                      |
| Notifications                                                              | Existing notification authority/projections, fed by idempotent conversation events and personal attention policy. |

Never discover cross-project work by enumerating chat files at page load, starting
all accessible projects, or opening one live DKV/SyncDB subscription per project.
Opening one selected conversation uses the existing authorized host route and
normal startup behavior when necessary; browsing the catalog does not.

Project collaboration and limited file viewing are not equivalent. A viewer of a
shared notebook must not thereby discover the project's people, agents, room, or
other artifacts. Initial global collaboration indexes cover existing project
collaborators. Preserve existing narrow shared-file entry points; any future
viewer discovery needs its own explicitly scoped policy. Agent Network membership
also does not grant project discovery or human-chat participation.

Authorization applies to metadata, counts, search, thumbnails, and previews, not
only content opens. Membership removals must invalidate account results and caches;
delayed content events must not resurrect them. Gate projected reads against the
current account access generation and recheck authoritative access on open/write.
Specify the remaining distributed revocation window and fail-closed conditions
before implementation; do not promise instantaneous erasure of already-read data.

## Metadata, indexes, and replication

The following are logical datasets, not final table names or migration SQL.
Choose existing domain tables/adapters where they fit; all additions need bounded
row/byte retention and explicit ownership.

| Dataset                         | Key and important fields                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical project room          | Unique project + room purpose; durable room ID, current locator, lifecycle/generation, initialization operation ID.                                         |
| Project conversation catalog    | Project + durable thread ID; room/locator, title, human/agent kind, creator, creation/activity order, archive/deletion state, source revision.              |
| Project resource discovery      | Existing artifact catalog plus an agent identity/session projection; type, stable ID, title, creator/publisher attribution, source revision, lifecycle.     |
| Participant/reference relations | Thread + account participation; bounded resource references associated with a source message. Do not store an unbounded participant array in every summary. |
| Account discovery projections   | Account + type + resource ID; project scope, safe summary, source version, access generation, indexing coverage.                                            |
| Account personal resource state | Account + typed target; optional alias, pin/collection membership/order. Follow/mute/read state has independent fields and operations.                      |
| Account thread attention        | Account + thread; participation/follow state, mute policy, read-through position, last eligible activity/mention.                                           |

Reuse existing account/project/collaborator indexes, but do not rely on the current
5,000-row collaborator snapshot limit as a scale strategy. Index at least:

- Account/type/activity order/stable ID for global keyset pages.
- Account/project/type/activity order/stable ID for scoped pages.
- Account/person relations for shared-project and creator/participant queries.
- Project/kind/activity order/stable ID at the owning bay.
- Account/thread attention plus eligible activity for For you/Following.
- Title/display-name/alias search using an explicitly chosen indexed search
  strategy. No leading-wildcard full scans on the interactive path.

Specify deterministic tie-breakers, cursor version/filter binding, and behavior
when updates reorder a page. Provide exact counts only when cheap and valid;
otherwise label estimates or omit counts. Message-body search remains an existing
separate bounded capability, not an excuse to replicate transcripts into catalogs.
Start with title/metadata search and latest-message time/author. If a text snippet
is included, treat it as bounded sensitive content with matching access, deletion,
retention, and redaction rules; it is not "content-free metadata."

### Reliable projection pipeline

1. Service-owned chat changes persist source revisions and recoverable metadata
   delivery intent. Account for the filesystem/database transaction boundary;
   reuse the artifact journal/fencing design instead of assuming a cross-store
   atomic commit. Browser events alone cannot supply the global index.
2. The project owner ingests authenticated, versioned metadata idempotently and
   commits bounded outbox/projection work with its catalog updates.
3. Background workers coalesce by project/source/account generation and deliver
   to relevant account homes with bounded batches, concurrency, retry backoff,
   and durable continuation. Never send one RPC per collaborator per keystroke.
4. Account homes apply idempotent changes under membership/access generations.
   Retain tombstone/version floors through the replay horizon. Removal wins over
   delayed upserts; rejoining gets a fresh generation and explicit backfill.
5. Account snapshots and feed cursors have an explicit no-gap handoff. Duplicates
   are harmless; expired cursors trigger bounded resnapshot. Live feed hints do
   not replace durable indexes or authorize reads.

Backfills must be resumable background jobs with truthful coverage/error state.
They must discover previously unnamed agents and relevant legacy human sources,
not only this account's named agents. Never interpret a partial scan or oversized
source as a complete replacement snapshot/deletion. Reading an index should work
while a source project is stopped. Raw shell edits, restore, host migration,
project/account rehome, and source deletion need reconciliation and writer fencing.

For high-membership projects, deliver catalog updates per destination home bay
where practical, then bounded local projection batches. Storage expansion from
resource-count times collaborator-count needs explicit capacity tests and quotas.
If full account materialization exceeds budget, expose incomplete coverage and
use a designed paginated project-scoped fallback, not silent missing results or
unbounded query-time fanout. Do not conflate incomplete indexing with no access.

## Canonical human room lifecycle

- Register one project room by purpose through an owner-routed, idempotent ensure
  operation. Simultaneous first discussions must converge on the same room.
- Lazily initialize its `.chat` using the existing chat service, not raw JSON
  writes. A durable room pointer and file initialization may complete separately;
  retries reconcile the same identity after a lost response or crash.
- A read/list operation neither creates the room nor initializes compute. First
  write may use normal explicit startup/admission, with visible progress/errors.
- Existing human chats remain readable. Do not move, merge, or rewrite them as
  part of rollout. Define a bounded opt-in indexing/adoption path; the canonical
  room is the default for new project discussions, not a ban on other chat files.
- Preserve room/thread identity through supported same-project moves. Deletion
  leaves unavailable links rather than silently creating an empty replacement;
  restoration and explicit replacement have distinct lifecycle semantics.
- Human-only thread configuration must be respected by every new-room send path,
  not merely hidden model controls. Reuse the human chat mode and test that agent
  mentions, reload, keyboard submission, and CLI sends do not invoke an agent.
- Treat message acknowledgment separately from notification/indexing progress.
  Sending uses stable operation/message IDs so reconnect/retry cannot double-post.

## Attention and notifications

For you membership is independent of pushing notifications. Participation can
make a thread discoverable there without silently creating an explicit follow.
Offer clear follow/unfollow/mute controls and keep their state account-scoped.

Define a persisted thread activity position and account read-through marker with
monotone multi-device updates; do not compute unread from client clocks. Reading
one thread must not mark other project discussions read. Rename, pin, indexing
repair, and presence changes must not generate new-message unread activity.

Reconcile existing `notification_followers`/`notification_muted` behavior during
migration. Preserve user choices; avoid dual writers and duplicate deliveries.
Notification deduplication keys include source message, recipient, and reason.
Bound mention-all expansion, delivery queues, and retention. Use existing
notification infrastructure, with retryable server-side event production.

Before UI delivery, explicitly choose mute precedence, whether direct mentions
override mute, and how old history is initially marked read. A sensible starting
point is no notification flood on joining a project, a visible starting read
boundary, and an explainable For you reason. Do not silently change existing
notification semantics while moving their state.

## RPC and client contract work

Use authenticated Conat APIs, not new Next routes. Names below are illustrative:

| Operation                                                          | Contract                                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `listConversations`, `listPeople`, `listProjects`, `listResources` | Account-home, keyset paging, bounded text/filters/page bytes, coverage and cursor metadata. Never starts projects.      |
| `getOverview`, `resolveReference`                                  | Permission-aware bounded point lookup and typed target; resolve actual resource owner rather than personal alias owner. |
| `ensureHumanRoom`, `createHumanThread`                             | Owner-routed control setup plus existing host chat creation; stable retry identity and inspectable unknown outcome.     |
| `setAlias`, `setCollected`, `setFollow`, `setMuted`, `markRead`    | Account-home mutations with independent semantics, validation, idempotency/CAS where needed.                            |
| `snapshot` / account feed extension                                | Defined cursor handoff, invalidation, deletion/revocation, gap recovery, bounded subscription/cache.                    |
| Existing invite/remove/open/send APIs                              | Reuse existing permission and execution rules; do not broaden them through discovery APIs.                              |

Shared TypeScript contracts should be usable by web, native/chat-client, and CLI.
Partition client caches by server/account and purge on logout or access removal.
Late results from a prior account, filter, or selection cannot populate the new
view. Only selected content mounts a live chat/artifact runtime. Use bounded
virtualized result lists and lazy previews. Keep draft and route state separate
from transient discovery caches. Provide a standalone Lite adapter with the same
visible semantics without pretending it has remote bays.

## Implementation sequence and review gates

Each slice should be independently reviewable behind a feature flag. Do not
require a polished final layout before validating the foundations.

1. **Contracts and inventory.** Audit the paths above, document exact identity,
   rename/copy/delete semantics, room lifecycle, attribution, and authority for
   every field. Define reference codecs, query/coverage/cursor shapes, and the
   migration compatibility matrix. Gate: tests for named/unnamed targets,
   overlapping handles, legacy links, and metadata access scopes.
2. **Owner-side metadata.** Add canonical room registration, thread summaries,
   and agent discovery not based on personal names. Extend existing artifact
   metadata only as needed. Implement bounded source journals/backfill and
   inspectable progress. Gate: stopped-project reads and crash/replay tests.
3. **Account-home discovery.** Add indexed query paths, projections, membership
   generation handling, snapshot/feed recovery, and personal state adapters.
   Gate: cross-bay membership/rehome tests and thousand-project query budgets.
4. **Read-only Collaborators UI.** Ship People/Projects and conversation browsing,
   empty states, direct opens, and navigation to existing agent/Library viewers.
   Support unnamed resources and optional personal shortcuts. Gate: a newly added
   collaborator can discover existing work without naming it or opening files.
5. **Human conversations and attention.** Wire canonical room creation/composition,
   project invitations, read/follow/mute state, and reliable existing notification
   integration. Gate: two-account chat/reconnect tests, no accidental agent turns,
   and no notification storm for large memberships.
6. **Unified reference UX.** Extend the `@` selector to people, agents, artifacts,
   and human threads, with unnamed results, personal labels, preview, and explicit
   Share to conversation. Gate: links survive renames and do not grant access or
   trigger agent work. Existing agent-context messaging remains unchanged.
7. **Scale, migration, and iteration.** Run mixed-version, backfill, revocation,
   accessibility, and realistic usage tests; refine layout with human review.
   Expand flags gradually. Preserve source chats, identities, and personal state
   when disabling the feature; rollback must not delete the user's work.

## Verification and acceptance

- Two collaborators in one project: Alice's ten agents and artifacts are
  discoverable by Bob without personal aliases; Bob opens the same threads.
- Zero collaborators: invitation/create-project flow is useful and does not
  manufacture notifications or names merely by visiting the page.
- One account with at least 1,000 projects and 100,000 indexed resources: first
  page/search request counts are bounded, with no per-project live subscriptions,
  filesystem scans, or project starts. Measure query plans, rows visited, response
  bytes, projection lag, memory, and rendered rows. Test high-collaborator fanout
  separately. Proposed query budget: <= 50 results and <= 256 KiB per page, tuned
  from measurements rather than silently raising existing catalog caps.
- Cross-bay owner/home/host placement: discovery, invitation, removal, alias/read
  writes, and opens route correctly; stopped source compute does not block lists.
- Revocation during search/open, cached overviews, delayed event replay, and
  rejoin/rehome cannot expose newly unauthorized metadata or revive old access.
  A file-only viewer and an Agent Network peer gain no collaboration directory.
- Lost room-create acknowledgment, concurrent initialization, duplicate source
  events, restarted workers, feed gaps, partial backfills, and source restore
  converge without duplicate rooms, threads, messages, or notifications.
- Alias overlap/rename/removal, unnamed objects, path moves, unavailable targets,
  copied chat files, Markdown/Slate round trips, and export preserve identity and
  do not reinterpret literal text. Sharing a reference does not copy content.
- Two people typing in the same human thread see correct attribution; human chat
  never invokes agents. Existing shared-agent execution/funding behavior is not
  changed by a browse, shortcut, mention, or human-chat action.
- Follow, participation, mute, read state, and personal collection stay independent
  across reload and multiple devices; index repairs do not create unread messages.
- Automated component tests use accessible roles/names and check keyboard, focus
  restoration, Escape, loading/error announcements, and selector disambiguation.
  Manually check light/dark themes, 320px width, 200% zoom, and reduced motion.
  Follow `accessibility.md`, package-local builds/tests, and frontend lint when
  implementing UI. The implementation PR also requires a full development build
  and isolated browser checks before calling the UI reviewable.

## Open details and exclusions

Settle during the relevant slice, without reopening the core model:

- Canonical room location/registration representation and adoption of an existing
  project chat; durable reference redirects and copy/restore collision rules.
- Exact global-index storage/retention quotas and backfill freshness targets;
  whether bounded message snippets justify their extra privacy/retention cost.
- Notification precedence and legacy follower migration; default global landing
  view and saved project/course filters based on user testing.
- Attribution for historical artifacts and shared agent sessions without verified
  creator metadata. Do not fill the gap with guessed ownership.

Not in the first scope: private direct messages, social feeds, organizations,
global unique handles, new resource ACLs, broad file-viewer discovery, redesigned
funding, automatic cross-user Agent Networks, or moving all existing personal
state into a generic resource table. These are not prerequisites for restoring
collaboration to the agent-first interface.
