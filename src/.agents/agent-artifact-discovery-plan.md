# Cross-agent artifact discovery

Status: scope correction implemented in PR #668. Cross-agent discovery below is
not implemented. Keep the UI honest: Agents currently offers only This agent;
ordinary chat files retain This thread / Entire chatroom.

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

## Next implementation slices

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

Do not add a placeholder All agents option backed by loaded chats, and do not
claim completion of this plan when only the scope-label correction is shipped.
