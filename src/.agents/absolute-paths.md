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
  - **launchpad mode** currently has backend sandbox constraints (HOME when project is not running).

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

### Filesystem Service Routing Contract (Mode-Aware)
- We need explicit routing for filesystem operations and watch ownership:
  - **Lite mode (`lite=true`)**
    - Use permissive filesystem service for all paths.
    - No HOME-only restriction.
  - **Launchpad mode (`lite=false`)**
    - When project is **not running**:
      - backend filesystem service remains HOME-scoped/sandboxed.
    - When project is **running**:
      - use in-project permissive filesystem service for non-HOME paths,
      - keep backend HOME service for HOME paths (or clearly designate one owner per prefix).
- Critical invariant:
  - At any moment, exactly one watcher owner for a given path prefix/session stream to avoid duplicated or conflicting updates.
- Recommended routing rule in launchpad mode:
  - `path in HOME` -> backend fs service (existing watcher path),
  - `path outside HOME` -> in-project fs service.
- Future simplification option:
  - once stable, consider moving all fs operations to in-project service when running, with backend fallback only when stopped.

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

### Filesystem Routing + Watch Ownership Hardening (part of Phase 4)
- Add a filesystem router abstraction in frontend project actions/hooks:
  - chooses backend fs vs in-project fs based on mode + project status + path prefix.
- Enforce single watch owner policy:
  - no dual registration for the same path/session from both services.
- Add explicit handoff behavior when project starts/stops:
  - rebind only required watchers,
  - avoid emitting duplicate initial patches.

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
  - launchpad mode when stopped is HOME-scoped.
  - launchpad mode when running routes non-HOME paths through in-project fs service.
- Watch ownership behavior:
  - no duplicate patch streams when switching service ownership at project start/stop.

## Performance checks
- Measure `realpath` RPC count before/after for common flows.
- Ensure no `realpath` in render loops or repeated listing updates.

## Risk Register
- High: broad frontend assumptions around empty-string root and relative joins.
- High: tab/open-file identity changes if paths canonicalize differently.
- Medium: snapshot/backups pseudo-path mode leakage into absolute model.
- Medium: legacy external links/bookmarks that encode relative paths.
- Medium: dual-path bugs where DisplayPath and SyncPath diverge incorrectly.
- High: backend and in-project fs services both watching same path stream (stomp/duplication risk).
- Medium: project start/stop handoff races causing missed or duplicated updates.

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
6. Add mode-aware filesystem router (lite vs launchpad, HOME vs non-HOME). *(Hard)*
7. Enforce watcher ownership and start/stop handoff policy. *(Hard)*
8. PathNavigator root/home redesign (clickable root selector scaffold). *(Medium)*
9. Remove `.smc/root` assumptions from active frontend flows. *(Medium)*
10. Route sync/watch/session identity through SyncPath while preserving DisplayPath in UX. *(Hard)*

### P3 (cleanup and polish)
11. Convert snapshot/backups to explicit path-context model instead of string hacks. *(Hard)*
12. Retire legacy websocket canonical path paths where no longer used. *(Medium)*
13. Final telemetry cleanup and remove temporary compatibility shims. *(Easy/Medium)*

## Suggested Rollout Order
1. Land helpers + tests.
2. Land ProjectActions/store absolute migration behind a feature flag.
3. Migrate explorer and open-file flows.
4. Land mode-aware fs router + watcher handoff policy.
5. Enable by default in cocalc-lite4.
6. Remove legacy shims.

## Definition of Done
- All file browsing and editing state uses absolute normalized paths.
- User can seamlessly navigate/edit under `/`, `/tmp`, and home.
- No `.smc/root` dependency for normal workflows.
- `realpath` calls are limited to boundary operations and not in hot UI loops.
- Symlink aliases remain visible to users, while collaboration correctness is guaranteed via shared SyncPath.
- Launchpad/lite routing is deterministic, and watcher ownership is single-source for any given path stream.

## Implementation Ticket Sequence

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

### Ticket 5: Mode-Aware Filesystem Router
- Priority: P2
- Effort: Hard
- Depends on: Ticket 2
- Scope:
  - Add a frontend fs routing layer that selects backend fs vs in-project fs by:
    - runtime mode (`lite` vs launchpad),
    - project running state,
    - path prefix (HOME vs non-HOME in launchpad mode).
- Acceptance criteria:
  - Lite mode can browse/open/edit all paths using permissive routing.
  - Launchpad mode routes HOME and non-HOME paths according to policy.
  - Routing decisions are observable in debug telemetry.

### Ticket 6: Watch Ownership + Start/Stop Handoff
- Priority: P2
- Effort: Hard
- Depends on: Ticket 5
- Scope:
  - Ensure only one service owns watchers for a given path/session stream.
  - Implement safe handoff rules when project starts/stops.
- Acceptance criteria:
  - No duplicate patch streams from backend + in-project services.
  - No missed updates during ownership transitions.

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
