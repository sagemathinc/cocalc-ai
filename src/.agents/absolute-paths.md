# Absolute Path Migration Plan

## Goal
Migrate CoCalc path handling from "relative to HOME" semantics to **normalized absolute path semantics** across file browsing, file editing, and related UX.

- Canonical internal path form: absolute (`/…`) and normalized.
- Resolve symlinks via `realpath` **sparingly**, at key boundaries.
- Preserve symlink paths in UI/tabs while using resolved paths for realtime collaboration identity.
- No backward-compatibility requirement with legacy stored relative paths.

## Why This Matters
Current behavior is inconsistent and historically constrained:

- Many frontend paths are still normalized as if HOME-relative (`normalize("...")` returns `""` for home, strips `~/`), see `frontend/project/utils.ts`.
- Legacy project websocket API exposes HOME-relative canonicalization and `.smc/root` mapping hacks (`project/browser-websocket/canonical-path.ts`, `project/browser-websocket/realpath.ts`).
- UI path navigator hardcodes “Home” root and assumes root path is empty string (`""`) not `/`.

This blocks clean access to `/tmp`, `/`, and general non-HOME paths.

## Constraints and Design Principles

### Constraints
- Frontend-to-project filesystem operations are remote RPCs (`FilesystemClient` via CONAT), not local FS calls.
- Calling `realpath` for every click/key press is too expensive.
- `realpath` only works for existing paths.
- Runtime mode matters:
  - **lite mode** can run permissive filesystem access for all paths,
  - **launchpad mode** can run with HOME-scoped fallback until project rootfs is mounted.
- HOME lookup strategy differs by mode:
  - in launchpad mode, treat HOME as stable (`/root`) for routing decisions,
  - in lite mode, HOME is deployment/runtime dependent and must be discovered/cached dynamically.

### Principles
1. **One canonical path representation in app state**: absolute normalized path.
2. **Resolve realpath only at trust boundaries**:
   - opening/editing files,
   - user-entered path strings,
   - mutation operations where symlink correctness matters.
3. **Use lexical normalization for UI-only operations** (breadcrumb, path joins, navigation transitions).
4. **Separate user-visible path from sync identity path** for symlink correctness.
5. **Backend remains source of truth for path safety and sandbox rules**.

## Current Architecture (Key Findings)

### Frontend
- `project/utils.ts` `normalize(path)` is HOME-relative oriented (empty string = home, strips `~/`).
- `ProjectActions.open_directory()` / `set_current_path()` keep `current_path` in relative form.
- Explorer and flyout code (`project/explorer/*`, `project/page/flyouts/*`) heavily assume relative paths and combine paths by string/join semantics.
- `open-file.ts` already does a useful boundary check: `fs.realpath(opts.path)` once when opening a file.
- `PathNavigator` hardcodes home root display and root click behavior as `""`.

### RPC / Backend
- `FilesystemClient` (`conat/files/fs.ts`) already provides `realpath`, `listing`, `readdir`, `find`, etc.
- Backend `SandboxedFilesystem` already supports both absolute/relative input by resolving against sandbox root with `safeAbsPath`.
- Legacy browser-websocket APIs (`project/browser-websocket/*`) enforce HOME-relative canonicalization and `.smc/root` behavior.

## Target Contract

### Path Types
- **AppPath**: absolute normalized path (primary browsing/navigation representation).
- **DisplayPath**: user-facing path shown in tabs/explorer/open-file state; may be a symlink alias.
- **SyncPath**: resolved realpath for existing files, used for collaborative sync identity.
- **ResolvedPath**: backend canonical resolved path (`realpath`) when needed.

### Canonicalization Rules
- AppPath must:
  - start with `/`,
  - be lexically normalized (`.`/`..` collapsed),
  - avoid trailing slash except `/`.
- For create/rename to non-existing targets:
  - canonicalize via parent directory `realpath(parent)` + lexical child.

### Where `realpath` is required
- File open/edit path finalization.
- User-typed “go to path” actions.
- Mutations with strong location guarantees (rename/move/copy destination and source normalization boundary).
- Creating/refreshing SyncPath identities for realtime docs.

### Where `realpath` is not required
- Rendering breadcrumb segments.
- Expanding/collapsing directories already returned from listing.
- Joining listing entries into child paths.

### Symlink UX + Sync Contract
- If user opens `/foo/b.txt` and `b.txt -> a.txt`, then:
  - tab title and browser-visible path remain `/foo/b.txt` (DisplayPath),
  - file browser selection remains `/foo/b.txt`,
  - editor sync identity uses `/foo/a.txt` (SyncPath).
- Two users opening symlink aliases to the same target share one realtime session (same SyncPath).
- Restore/revert/save operations operate on SyncPath, while navigation/back-button semantics continue to use DisplayPath.
- If symlink target changes during session, refresh SyncPath at safe boundaries (reopen/refocus/save conflict paths), not on every keystroke.

### Backend Sandbox Contract (Mode-Aware)
We now use a **single filesystem service** with backend-enforced path policy.

- `SandboxedFilesystem(path, { root? })`:
  - `path` remains the HOME-scoped base (current behavior).
  - `root` is an optional absolute mountpoint treated as `/` when available.
  - if `root` is unavailable/unmounted, sandbox automatically falls back to `path`.
- This eliminates frontend dual-routing and watcher handoff complexity.
- Behavior by mode:
  - **lite mode**: permissive operation can be enabled directly (unsafe mode), so all paths are available.
  - **launchpad mode**:
    - when project rootfs is unavailable, access is effectively HOME-scoped,
    - when project rootfs is mounted, absolute paths under `/` are available through the same backend service.

Implementation notes:
- Frontend should use one fs client.
- Backend sandbox remains the source of truth for containment and path safety.
- We still need explicit tests around rootfs availability transitions under a single-service model.

Implementation status:
- Implemented backend `root` support in [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts).
- Implemented backend tests in [src/packages/backend/sandbox/sandbox.test.ts](./src/packages/backend/sandbox/sandbox.test.ts).
- Wired project-host fs server root mountpoint in [src/packages/project-host/file-server.ts](./src/packages/project-host/file-server.ts) using helper from [src/packages/project-runner/run/rootfs.ts](./src/packages/project-runner/run/rootfs.ts).

## Proposed Migration Strategy (Phased)

## Phase 0: Guardrails and Observability (Easy)
- Add path contract docs and temporary debug counters:
  - count frontend `realpath` calls,
  - count directory navigation actions,
  - detect non-absolute `current_path` writes.
- Add helper assertions in dev mode:
  - `assertAbsolutePath(path)` in key actions.

Deliverable: visibility before changing behavior.

## Phase 1: Introduce New Path Helpers (Easy/Medium)
Create centralized helpers in frontend (new module, e.g. `project/path-model.ts`):

- `normalizeAbsolutePath(input: string, base?: string): string`
- `joinAbsolutePath(base: string, name: string): string`
- `isAbsolutePath(path: string): boolean`
- `displayPath(path: string, home?: string): string`

Also keep explicit converters for transition period:
- `legacyRelativeToAbsolute(rel, homeAbs)`
- `absoluteToLegacyRelative(abs, homeAbs)` (temporary only where needed)

Deliverable: no direct ad-hoc path string manipulation in high-traffic actions.

## Phase 2: Project Store / Actions Core Migration (Medium/Hard)
Migrate `ProjectActions` state contract:

- `current_path` becomes absolute (e.g. `/home/user`, `/tmp`, `/`).
- `history_path` same contract.
- `open_directory`, `set_current_path`, URL sync methods updated.

Key updates:
- Replace `""` root semantics with explicit absolute root/home semantics.
- Ensure all `path_to_file` callsites receive absolute base paths.
- Ensure snapshot/backups virtual paths are represented consistently (see special handling below).
- Add editor-open metadata model:
  - `display_path` (what user opened),
  - `sync_path` (resolved path for collaboration/session key).

Deliverable: one canonical absolute state in Redux for paths.

## Phase 3: UI Migration (Explorer/Flyouts/Navigator) (Medium)
Update explorer and flyout components to absolute contract:

- `PathNavigator` root breadcrumb becomes a source selector / root anchor (future dropdown), not hardcoded empty-home token.
- Keep “Home” affordance via alias entry that maps to actual home absolute path.
- Update go-up logic to parent of absolute path.
- Ensure filters/search/new file dialog actions use absolute paths.
- Keep symlink aliases visible:
  - tabs and path navigator reflect DisplayPath,
  - no forced visual rewrite to realpath on open.

Special UX note:
- Introduce a top-level root switcher design:
  - Home (`$HOME`), `/`, `/tmp`, plus recent roots.

Deliverable: UI works naturally with absolute paths.

## Phase 4: API Boundary Hardening (Medium)
Standardize API expectations:

- CONAT filesystem calls accept absolute paths by default in frontend usage.
- Remove frontend dependence on websocket `canonicalPaths` legacy HOME behavior for core flows.
- Keep backend sandbox safety checks unchanged (already robust).

Potential small backend enhancement:
- Add optional `canonicalizePath` RPC that returns:
  - lexical normalized absolute,
  - optional resolved path if exists,
  - parent resolution info for non-existing path.

This can reduce multiple round trips for create/rename flows.

Deliverable: explicit, low-chatter canonicalization boundary.

### Realtime/Sync Identity Hardening (part of Phase 4)
- Ensure sync-doc/session registration keys by `sync_path` (realpath), not display path.
- Keep mapping `display_path -> sync_path` in frontend tab/editor state.
- Filesystem watch and patch routing should target `sync_path` to avoid split sessions across symlink aliases.

### Backend Rootfs Availability Hardening (part of Phase 4)
- Validate behavior when rootfs is unavailable:
  - HOME-scoped fallback remains correct.
- Validate behavior when rootfs is mounted:
  - absolute paths under `/` are available.
- Ensure transitions are deterministic and test-covered.

## Phase 5: Legacy Cleanup (Medium)
Remove/retire HOME-relative assumptions in active code paths:

- `.smc/root` mapping references in frontend UX and open-path routes.
- Legacy browser-websocket canonical path usage where superseded.
- Any helper that implies `"" == HOME`.

Keep only minimal compatibility shims if still needed by isolated subsystems.

Deliverable: no hidden relative-path semantics in main UX paths.

## Special Cases

## Snapshots / Backups Virtual Paths
These are pseudo-browsing spaces (`.snapshots`, `.backups`) layered on filesystem.

Plan:
- Internally represent current browsing location as absolute physical path where possible.
- Represent virtual modes with explicit metadata (e.g. `pathContext: "filesystem" | "snapshots" | "backups"`) instead of overloading path strings.
- Keep special browsing affordances, but avoid contaminating canonical filesystem path model.

## Non-existing Path Operations
Because `realpath` fails on non-existing targets:

- canonicalize parent directory once via RPC (`realpath(parent)`),
- append basename lexically,
- perform mutation.

## Symlink Semantics
- Directory listing navigation should not force `realpath` every click.
- Opening a file computes/refreshes SyncPath once, while preserving DisplayPath for UX.
- Collaboration/session identity, watch subscriptions, and save conflict logic key by SyncPath.
- File tabs, breadcrumbs, and “open recent” should remain DisplayPath-first.

## Testing Strategy

## Unit tests
- New path helper tests for normalization/join/edge cases.
- ProjectActions tests for `set_current_path` / `open_directory` with absolute paths.

## Integration tests
- Explorer navigation from Home -> `/` -> `/tmp`.
- Open/create/rename/move file in `/tmp` and home.
- URL/history behavior with absolute paths.
- Snapshot/backups browsing unaffected.
- Symlink workflow:
  - open symlink path keeps tab/path unchanged (DisplayPath),
  - edits persist to target,
  - opening target path and symlink path shares cursor/session state.
- Symlink retarget edge case:
  - retarget between opens updates SyncPath on next boundary operation.
- Mode/routing behavior:
  - lite mode can browse/open/edit outside HOME without fallback hacks.
  - launchpad mode with rootfs unavailable is HOME-scoped.
  - launchpad mode with rootfs mounted supports absolute paths.

## Performance checks
- Measure `realpath` RPC count before/after for common flows.
- Ensure no `realpath` in render loops or repeated listing updates.

## Risk Register
- High: broad frontend assumptions around empty-string root and relative joins.
- High: tab/open-file identity changes if paths canonicalize differently.
- Medium: snapshot/backups pseudo-path mode leakage into absolute model.
- Medium: legacy external links/bookmarks that encode relative paths.
- Medium: dual-path bugs where DisplayPath and SyncPath diverge incorrectly.
- Medium: rootfs mount/unmount transition races causing fallback-vs-root path surprises.

Mitigation:
- phased rollout with feature flag,
- temporary dual-accept parser for incoming URLs,
- telemetry for path parse/canonicalization failures.

## Prioritized Implementation Checklist

### P1 (must-do foundation)
1. Add absolute path helper module and tests. *(Easy)*
2. Migrate `ProjectActions.set_current_path/open_directory` to absolute contract. *(Hard)*
3. Migrate `open-file.ts` and tab-path handling to dual-path model (DisplayPath + SyncPath) with sparse `realpath`. *(Hard)*
4. Update explorer/flyout core path joins and parent navigation. *(Hard)*

### P2 (API and UX consolidation)
5. Add/standardize canonicalization RPC boundary for non-existing targets. *(Medium)*
6. Validate backend sandbox `root` transitions (mounted/unmounted) with integration tests. *(Medium)*
7. PathNavigator root/home redesign (clickable root selector scaffold). *(Medium)*
8. Remove `.smc/root` assumptions from active frontend flows. *(Medium)*
9. Route sync/watch/session identity through SyncPath while preserving DisplayPath in UX. *(Hard)*

### P3 (cleanup and polish)
11. Convert snapshot/backups to explicit path-context model instead of string hacks. *(Hard)*
12. Retire legacy websocket canonical path paths where no longer used. *(Medium)*
13. Final telemetry cleanup and remove temporary compatibility shims. *(Easy/Medium)*

## Suggested Rollout Order
1. Land helpers + tests.
2. Land ProjectActions/store absolute migration behind a feature flag.
3. Migrate explorer and open-file flows.
4. Validate rootfs mounted/unmounted transition behavior in launchpad mode.
5. Enable by default in cocalc-lite4.
6. Remove legacy shims.

## Definition of Done
- All file browsing and editing state uses absolute normalized paths.
- User can seamlessly navigate/edit under `/`, `/tmp`, and home.
- No `.smc/root` dependency for normal workflows.
- `realpath` calls are limited to boundary operations and not in hot UI loops.
- Symlink aliases remain visible to users, while collaboration correctness is guaranteed via shared SyncPath.
- Launchpad/lite path behavior is deterministic with backend rootfs fallback.

## Implementation Ticket Sequence

### Status Snapshot (Current Branch)
- Ticket 1: Completed.
- Ticket 2: Completed.
  - Done:
    - Migrated project store path state to absolute-only fields:
      - `current_path_abs`
      - `history_path_abs`
    - `set_current_path` now updates only absolute path history/state.
    - Added mode-aware HOME baseline for absolute normalization:
      - launchpad: `/root`
      - lite: `available_features.homeDirectory` fallback.
    - URL/history/search paths now prefer absolute state.
    - Root route handling improved in `load_target` (`/` special case).
    - URL path serialization/parsing now has explicit helpers:
      - `toUrlDirectoryPath(...)`
      - `fromUrlDirectoryPath(...)`
      so absolute paths no longer produce malformed `files//...` URLs and
      virtual listing paths remain preserved.
    - Root/home URL split now uses explicit route prefixes (`files/...` vs `home/...`) instead of `files//` encoding.
    - New/search tab URLs now preserve home-path context (`new/home/...`, `search/home/...`) and load/parse these routes explicitly.
    - Create/download-new-file flows now derive paths from absolute state.
    - Frontend direct file URL helper no longer rewrites absolute paths through `.smc/root`; absolute paths are now encoded directly for `/files/...` download routes.
    - Jupyter traceback links and datastore "Open" action now use absolute paths directly (no `.smc/root` rewrite).
    - Active flyout directory display no longer rewrites `.smc/root/...` labels.
    - Explorer and files flyout now prefer `current_path_abs` for core listing, create/open, and sorting flows.
    - Flyout controls/header/bottom/active groups and terminal now use effective absolute path state.
    - Activity/share tabs, explorer side buttons, download flow, and AI document generation now prefer absolute current path state.
    - Explorer file action box no longer rejects absolute destinations for move/copy.
    - Active flyout folder grouping now uses `/` as the root key (no empty-string root semantics).
    - Explorer `ActionBar`, `SearchBar`, `FileActionsDropdown`, and `useSpecialPathPreview` now require absolute `current_path` (no nullable path fallbacks).
    - Remaining files/flyout null checks on effective path removed; explorer/flyout path flows no longer branch on nullable current path.
    - `path_to_file("/", name)` now returns `"/name"` (instead of `"//name"`), with tests.
    - Root-path edge cases handled in backups selection helpers (`/` prefix comparisons no longer use `"//"`).
    - Removed remaining empty-string path defaults from store/actions:
      - `current_path` and `history_path` now initialize to `/`.
      - `set_current_path` normalizes empty input to `/`.
      - Home tab button resets path to `/` (not `""`).
      - Archive creation now uses absolute current path.
    - `new/...` and `search/...` URL pushes now avoid `//` by using normalized path suffixes.
    - Manual validation in both lite and launchpad mode:
      - `/projects/<id>/files/`, `/projects/<id>/files/<abs-path>`
      - `/projects/<id>/home/`
      - root/home URL defaults and redirect behavior
- Ticket 3: Completed.
  - Done:
    - File-open flow preserves `display_path` while resolving/storing `sync_path` at open boundary:
      - [src/packages/frontend/project/open-file.ts](./src/packages/frontend/project/open-file.ts)
    - Project action lifecycle (`show/hide/goto/chat/close`) now consistently routes editor identity through `sync_path` when present:
      - [src/packages/frontend/project_actions.ts](./src/packages/frontend/project_actions.ts)
    - Project page/frame wiring now explicitly requests editor actions via `sync_path` (not only display-path fallback):
      - [src/packages/frontend/project/page/page.tsx](./src/packages/frontend/project/page/page.tsx)
      - [src/packages/frontend/project/page/content.tsx](./src/packages/frontend/project/page/content.tsx)
    - Added regression tests for display-path to sync-path fallback and precedence:
      - [src/packages/util/redux/AppRedux.test.ts](./src/packages/util/redux/AppRedux.test.ts)
    - Manual validation:
      - cross-browser symlink alias realtime session sharing (`a.txt` and `b.txt -> a.txt`)
      - same-browser alias duplicate open now fails gracefully by reusing existing tab
- Ticket 4: Completed.
  - Done:
    - Explorer and flyout paths now mostly use `current_path_abs`.
    - Core listing/create/open/sort flows are absolute-first.
    - Most URL edge cases (`files//...`) have been removed via explicit route parsing.
    - Explorer path segment links and explorer config keys now default to `/` (not `""`).
    - Files flyout terminal directory switching no longer has `"."` special handling.
    - Disk usage hooks now default to `/` (not `""`).
    - Path navigator “go up” now resolves virtual parents to `/` (no `"."` fallback), with root-accurate disabled tooltip text.
    - Added shared virtual-path helpers with leading-slash tolerance:
      - `isBackupsPath(...)` in [src/packages/util/consts/backups.ts](./src/packages/util/consts/backups.ts)
      - `isSnapshotsPath(...)` in [src/packages/util/consts/snapshots.ts](./src/packages/util/consts/snapshots.ts)
    - Replaced literal `.backups`/`.snapshots` checks in core explorer/flyout/find/action paths with helper-based checks and constants.
    - Moved backup virtual-path constant/helper into `@cocalc/util` and shifted frontend callsites away from hook-module constant coupling.
    - Hardened virtual-path parent navigation for optional leading-slash forms in:
      - [src/packages/frontend/project/explorer/path-navigator.tsx](./src/packages/frontend/project/explorer/path-navigator.tsx)
      - [src/packages/frontend/project/page/flyouts/files-header.tsx](./src/packages/frontend/project/page/flyouts/files-header.tsx)
    - Hardened cached-directory and `isDir` checks to treat virtual listing paths as directory roots:
      - [src/packages/frontend/project_actions.ts](./src/packages/frontend/project_actions.ts)
    - Added helper tests:
      - [src/packages/util/consts/virtual-paths.test.ts](./src/packages/util/consts/virtual-paths.test.ts)
- Ticket 5: Completed.
  - Done:
    - Added backend optional `root` mode to sandbox:
      - [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)
    - Added Jest coverage for root-mode behavior:
      - [src/packages/backend/sandbox/sandbox.test.ts](./src/packages/backend/sandbox/sandbox.test.ts)
    - Added additional policy hardening assertions:
      - rootfs-missing errors do not leak mountpoint paths,
      - scratch-missing errors do not leak mountpoint paths,
      - `/root` access remains available when `/scratch` is unavailable.
    - Wired project-host file server to pass rootfs mountpoint:
      - [src/packages/project-host/file-server.ts](./src/packages/project-host/file-server.ts)
      - [src/packages/project-runner/run/rootfs.ts](./src/packages/project-runner/run/rootfs.ts)
- Ticket 12: Completed.
  - Done:
    - Retired frontend LaTeX editor usage of websocket `canonical_paths` / `canonical_path`.
    - LaTeX dependency/source path resolution now uses absolute normalization + `realpath` fallback.
    - Removed unused `canonical_path(s)` wrapper methods from:
      - [src/packages/frontend/project/websocket/api.ts](./src/packages/frontend/project/websocket/api.ts)
    - Removed `canonicalPaths` from CONAT project system API contracts:
      - [src/packages/conat/project/api/system.ts](./src/packages/conat/project/api/system.ts)
      - [src/packages/project/conat/api/system.ts](./src/packages/project/conat/api/system.ts)
    - Removed legacy websocket `canonical_paths` command and type branch:
      - [src/packages/comm/websocket/types.ts](./src/packages/comm/websocket/types.ts)
      - [src/packages/project/browser-websocket/api.ts](./src/packages/project/browser-websocket/api.ts)
    - Deleted obsolete canonical-path implementation:
      - [src/packages/project/browser-websocket/canonical-path.ts](./src/packages/project/browser-websocket/canonical-path.ts)
- Ticket 9: Completed.
  - Done:
    - Implemented root/home source selector UX in navigator/flyout.
    - Root breadcrumb behavior cleaned up (no duplicate `/` visual artifact).
    - Mode-aware source options (`/scratch` only in launchpad mode).
    - Project root route default now lands on `/home` in lite mode.
    - Manual validation in lite + launchpad confirmed behavior.
- Ticket 10: Completed (copy-between-projects absolute-path migration).
  - Done:
    - Backend copy pipeline now accepts absolute and relative source/destination paths:
      - [src/packages/server/projects/copy.ts](./src/packages/server/projects/copy.ts)
    - Pending copy application now resolves destination paths with HOME/rootfs/scratch policy (same sandbox contract as file-server):
      - [src/packages/project-host/pending-copies.ts](./src/packages/project-host/pending-copies.ts)
      - [src/packages/project-host/file-server.ts](./src/packages/project-host/file-server.ts)
    - Rootfs/scratch unmounted errors now explicitly tell users to start the workspace:
      - [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)
      - [src/packages/backend/sandbox/sandbox.test.ts](./src/packages/backend/sandbox/sandbox.test.ts)
    - Added focused server unit tests for copy orchestration (same-host absolute, cross-host `/scratch` rejection, queued absolute and multi-source basename expansion):
      - [src/packages/server/projects/copy.test.ts](./src/packages/server/projects/copy.test.ts)
    - Added focused frontend non-UI helper tests for copy/open defaults:
      - [src/packages/frontend/project/copy-paths.test.ts](./src/packages/frontend/project/copy-paths.test.ts)
      - [src/packages/frontend/projects/open-project-default.test.ts](./src/packages/frontend/projects/open-project-default.test.ts)
      - wired in:
        - [src/packages/frontend/project_actions.ts](./src/packages/frontend/project_actions.ts)
        - [src/packages/frontend/projects/actions.ts](./src/packages/frontend/projects/actions.ts)

### Next Recommended Work (Tests First)
1. Ticket 6 hardening via automated tests.
   - Add integration tests for rootfs mounted/unmounted transitions through project-host/file routes, not just sandbox unit tests.
   - Ensure expected failure messages remain sanitized (no host-path leakage) and HOME path remains usable.
2. Ticket 7 regression tests for sync identity behavior.
   - Add test coverage for:
     - alias open dedupe in same browser (`display_path` switch + toast behavior),
     - close-last-alias teardown behavior,
     - `getEditorActions/getEditorStore` display->sync fallback invariants.
3. Add focused copy-between-projects tests (remaining coverage gap).
   - Add tests in copy worker/API layer for:
     - absolute source + absolute destination,
     - HOME vs rootfs vs scratch policy behavior,
     - cross-host queued copy behavior and failure reporting.
4. Ticket 8 canonicalization boundary for non-existing targets.
   - Add/create a shared parent-realpath + child lexical canonicalization helper and tests for create/rename/move/copy.
5. Mutation-operation regression suite (create/rename/move/copy) under absolute paths.
   - Add focused tests across frontend action wrappers and backend fs APIs for:
     - absolute in-HOME paths,
     - absolute out-of-HOME paths (when rootfs available),
     - policy-denied targets,
     - destination canonicalization for non-existing targets.
6. Ticket 11 virtual-path context cleanup.
   - Optional now, but this is the next likely source of subtle regressions (`.snapshots`/`.backups` route semantics).

### Ticket 1: Path Model Module + Tests
- Priority: P1
- Effort: Easy
- Scope:
  - Add frontend path model helpers for absolute lexical normalization and joins.
  - Add test coverage for root, trailing slash, `.`/`..`, and mixed absolute/relative input handling.
- Acceptance criteria:
  - New helpers are used in at least one non-trivial caller.
  - Tests pass and encode the intended absolute-path contract.

### Ticket 2: ProjectActions Absolute Path State
- Priority: P1
- Effort: Hard
- Depends on: Ticket 1
- Scope:
  - Migrate `current_path` and `history_path` to absolute paths.
  - Update `open_directory`, `set_current_path`, and URL synchronization behavior.
- Acceptance criteria:
  - No empty-string-root semantics in active path state.
  - Navigation between `/`, home, and `/tmp` works in files tab.

### Ticket 3: Open File Dual-Path Model (DisplayPath + SyncPath)
- Priority: P1
- Effort: Hard
- Depends on: Ticket 1, Ticket 2
- Scope:
  - Keep user-opened path as DisplayPath in tabs and UI.
  - Resolve and store SyncPath via sparse `realpath` boundary calls.
- Acceptance criteria:
  - Opening symlink path keeps symlink in tab label/path UI.
  - Opening symlink target and alias map to same SyncPath identity.

### Ticket 4: Explorer/Flyout Absolute Path Conversion
- Priority: P1
- Effort: Hard
- Depends on: Ticket 2
- Scope:
  - Migrate path joins, parent navigation, selection, and action wiring to absolute paths.
  - Remove implicit relative assumptions in core explorer and files flyout.
- Acceptance criteria:
  - File operations from explorer/flyout work under `/tmp` and root paths.
  - No regressions in snapshots/backups entry points.

### Ticket 5: Backend Sandbox Root Mode
- Priority: P2
- Effort: Medium
- Depends on: Ticket 2
- Scope:
  - Extend backend sandbox with optional `root` mountpoint.
  - Resolve absolute paths against `root` when mounted.
  - Fallback to HOME-scoped `path` when `root` is unavailable.
  - Wire root mountpoint into project-host fs server initialization.
- Acceptance criteria:
  - Lite mode can browse/open/edit all paths using permissive mode.
  - Launchpad mode supports absolute paths when rootfs is mounted.
  - Behavior falls back to HOME cleanly when rootfs is unavailable.

### Ticket 6: Rootfs Transition Validation
- Priority: P2
- Effort: Medium
- Depends on: Ticket 5
- Scope:
  - Add tests for mounted/unmounted rootfs behavior.
  - Validate path and error redaction behavior in both modes.
  - Validate filesystem operations and browsing behavior for fallback transitions.
- Acceptance criteria:
  - Transition behavior is deterministic and test-covered.
  - No regressions in HOME-scoped fallback mode.

### Ticket 7: Sync/Watch Identity by SyncPath
- Priority: P2
- Effort: Hard
- Depends on: Ticket 3, Ticket 5, Ticket 6
- Scope:
  - Ensure realtime session keys, sync watch registration, and save conflict identity use SyncPath.
  - Keep display-oriented UI state keyed by DisplayPath.
- Acceptance criteria:
  - Two aliases to same target share cursors and live edits.
  - No duplicate independent sessions for same resolved file.

### Ticket 8: Canonicalization Boundary API for Non-Existing Targets
- Priority: P2
- Effort: Medium
- Depends on: Ticket 1
- Scope:
  - Add or standardize a boundary helper/RPC for parent-realpath + child lexical canonicalization.
  - Apply to create/rename/move/copy destinations.
- Acceptance criteria:
  - Non-existing target operations avoid extra round trips and handle symlinked parents safely.
  - Error behavior is consistent and user-facing messages remain clear.

### Ticket 9: Path Navigator Root Source UX
- Priority: P2
- Effort: Medium
- Depends on: Ticket 2, Ticket 4
- Scope:
  - Replace hardcoded Home-only root with source-aware root affordance (home, `/`, `/tmp`, recent roots).
  - Keep DisplayPath-centric breadcrumbs.
- Acceptance criteria:
  - User can jump among root sources without manual path typing.
  - Breadcrumbs remain stable for absolute paths and symlink display paths.

### Ticket 10: Remove `.smc/root` Active Frontend Dependencies
- Priority: P2
- Effort: Medium
- Depends on: Ticket 2, Ticket 4
- Scope:
  - Remove or isolate `.smc/root` path rewrites in active open/browse flows.
- Acceptance criteria:
  - Normal user workflows no longer require `.smc/root` mapping.
  - Legacy references are either deleted or fenced behind explicit compatibility code.

### Ticket 11: Snapshots/Backups Context Model Hardening
- Priority: P3
- Effort: Hard
- Depends on: Ticket 4
- Scope:
  - Use explicit path context metadata instead of overloading path strings.
  - Keep absolute path contract for physical filesystem paths.
- Acceptance criteria:
  - Snapshots/backups browsing remains fully functional.
  - Core absolute-path flows are not polluted by virtual path conventions.

### Ticket 12: Legacy Websocket Canonical Path Retirement
- Priority: P3
- Effort: Medium
- Depends on: Ticket 8, Ticket 10
- Scope:
  - Retire legacy HOME-relative canonical path codepaths where no longer used.
- Acceptance criteria:
  - Main flows run entirely on new absolute-path contract.
  - Dead code references are removed and tests updated.

### Ticket 13: Final Telemetry, Perf Verification, and Cleanup
- Priority: P3
- Effort: Easy/Medium
- Depends on: Ticket 1 through Ticket 12
- Scope:
  - Remove temporary debug instrumentation.
  - Verify `realpath` call counts are bounded and not in render loops.
- Acceptance criteria:
  - Performance checks pass for directory navigation and file open/edit workflows.
  - Temporary migration shims are removed or explicitly documented.
