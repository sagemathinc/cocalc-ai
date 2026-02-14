# Sandbox Hardening Plan

## Objective
Eliminate race-condition and symlink escape classes in backend sandbox filesystem operations, while preserving current behavior and compatibility for CoCalc workloads.

Primary target file:
- [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)

Related modules:
- [src/packages/backend/sandbox/watch.ts](./src/packages/backend/sandbox/watch.ts)
- [src/packages/backend/sandbox/sync-fs-service.ts](./src/packages/backend/sandbox/sync-fs-service.ts)
- [src/packages/backend/sandbox/sandbox.test.ts](./src/packages/backend/sandbox/sandbox.test.ts)

## Scope
In scope:
- Safe-mode filesystem API hardening against TOCTOU and symlink replacement races.
- Deterministic behavior under concurrent file churn.
- Regression tests for security and behavior parity.

Out of scope:
- General Linux container escape hardening outside this module.
- Kernel-level MAC policy changes (AppArmor/SELinux).
- Rewriting unrelated sandbox command wrappers (`find`, `ripgrep`, etc.) unless needed for path safety.

## Threat Model
Assume attacker can:
- Modify files in the project tree concurrently with sandbox API calls.
- Replace files/dirs with symlinks between validation and operation.
- Trigger high-frequency rename/unlink/recreate races.

Must prevent:
- Reads/writes outside sandbox root in safe mode.
- Mutating operations escaping via symlinked path components.
- Inconsistent or undefined semantics during races.

Acceptable behavior under attack:
- Operation fails with explicit error (`EACCES`, `EXDEV`, `EINVAL`, etc.).
- No escape and no partial unsafe writes.

## API Contract Baseline (SBOX-001)

The table below is the baseline contract for the public `SandboxedFilesystem`
methods in [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts).
Any hardening work should preserve these semantics unless explicitly changed.

| Method | Safe mode contract | Unsafe mode contract |
| --- | --- | --- |
| `safeAbsPath` | Resolves inside sandbox roots only; rejects escapes. | Returns mapped path without sandbox security checks. |
| `safeAbsPaths` | Same as `safeAbsPath` for each entry. | Same as `safeAbsPath` for each entry. |
| `appendFile` | Writes only to sandbox-contained target; respects `readonly`. | Direct append semantics. |
| `chmod` | Mutates mode for sandbox-contained path; respects `readonly`. | Direct chmod semantics. |
| `constants` | Returns fs constants unchanged. | Same. |
| `copyFile` | Source/destination must resolve in sandbox roots. | Direct copy semantics through mapped paths. |
| `cp` | Copy operation restricted to sandbox roots; destination parent auto-created. | Direct copy semantics through mapped paths. |
| `exists` | Returns existence for sandbox-contained path. | Same for mapped paths. |
| `find` | Executes only against sandbox-contained path; timeout capped. | Same timeout semantics. |
| `getListing` | Lists sandbox-contained path only. | Same for mapped paths. |
| `fd` | Executes `fd` within sandbox-contained path; timeout capped. | Same timeout semantics. |
| `dust` | Executes `dust` within sandbox-contained path; timeout capped. | Same timeout semantics. |
| `ouch` | Archive operation restricted to sandbox-contained paths. | Same for mapped paths. |
| `rustic` | Backup operations use safe path resolver. | Same for mapped paths. |
| `ripgrep` | Search restricted to sandbox-contained path; timeout capped. | Same timeout semantics. |
| `link` | Hardlink only among sandbox-contained paths; respects `readonly`. | Direct link semantics. |
| `lstat` | Stats sandbox-contained path only. | Same for mapped paths. |
| `mkdir` | Creates directory in sandbox roots only; respects `readonly`. | Direct mkdir semantics. |
| `readFile` | Reads sandbox-contained target; fd-verified for existing file target. | Direct read semantics. |
| `lockFile` | Local in-process read lock keyed by resolved path. | Same. |
| `readdir` | Reads sandbox-contained directory only; sanitizes exposed paths. | Same sanitization behavior. |
| `readlink` | Reads link value only for sandbox-contained path. | Same for mapped paths. |
| `realpath` | Returns sandbox-relative or absolute-style alias path without leaking host mount roots. | Same mapping behavior. |
| `rename` | Rename restricted to sandbox-contained old/new paths; respects `readonly`. | Direct rename semantics. |
| `move` | Move restricted to sandbox-contained old/new paths; respects `readonly`. | Direct move semantics. |
| `rm` | Removal restricted to sandbox-contained paths; records local delete to sync-fs. | Same mapped-path behavior. |
| `rmdir` | Directory removal restricted to sandbox-contained path; respects `readonly`. | Direct rmdir semantics. |
| `stat` | Stats sandbox-contained path only. | Same for mapped paths. |
| `symlink` | Symlink creation restricted to sandbox-contained target/path; respects `readonly`. | Direct symlink semantics. |
| `truncate` | Truncates sandbox-contained path only; respects `readonly`. | Direct truncate semantics. |
| `unlink` | Unlinks sandbox-contained path only; respects `readonly`; records local delete to sync-fs. | Direct unlink semantics. |
| `utimes` | Updates times for sandbox-contained path only; respects `readonly`. | Direct utimes semantics. |
| `watch` | Watches sandbox-contained path and emits sanitized relative filenames. | Same watch mapping behavior. |
| `writeFile` | Writes only to sandbox-contained target; patch writes require matching base hash (`ETAG_MISMATCH` on mismatch); respects `readonly`. | Direct write semantics. |
| `writeFileDelta` | Applies patch-or-full write with same safety and mismatch semantics as `writeFile`; respects `readonly`. | Same write semantics. |
| `syncFsWatch` | Registers heartbeat for sandbox-contained path and sync metadata. | Same mapped-path behavior. |

## Error Mapping Baseline (SBOX-001)

| Operation/case | Expected error code/message baseline |
| --- | --- |
| Any mutator in `readonly` mode | `EACCES` with read-only message |
| Read-lock conflict (`readFile` with lock active) | Conat error with code `LOCK` |
| Patch write base mismatch | `ETAG_MISMATCH` |
| Patch write malformed patch payload | `EINVAL` |
| Patch write apply failure | `PATCH_FAILED` |
| Path escapes sandbox in safe mode | error message contains `outside of sandbox` |
| Absolute path with missing rootfs mount | error message starts `rootfs is not mounted; cannot access absolute path ...` |
| `/scratch/...` with missing scratch mount | error message starts `scratch is not mounted; cannot access absolute path ...` |

## Current Status (as of this plan)
Already implemented:
- fd-backed verification for key file content operations (`readFile`, `writeFile`, `appendFile`, patch writes).
- Security regression avoided for watcher ordering via create-path carveout.

Remaining high-risk area:
- Path-based mutators still rely on path validation + operation calls, leaving residual TOCTOU windows.

## Design Direction
Move from mixed path validation to descriptor-anchored resolution:

1. Near-term (TypeScript only):
- Expand fd-based safe patterns where possible.
- Centralize safe path resolution and operation wrappers.
- Explicitly fail on unsafe race outcomes.

2. End-state (Linux):
- Use `openat2`/`*at` style resolution anchored to sandbox dirfd.
- Enforce `RESOLVE_BENEATH`, `RESOLVE_NO_SYMLINKS`, `RESOLVE_NO_MAGICLINKS`.
- Resolve both parent directories and targets via dirfds for all mutators.

## Phased Implementation

### Phase 0: Baseline and Contract Freeze
Goal:
- Lock down expected behavior before deeper internals change.

Tasks:
- Document safe-mode contracts for each API method in [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts).
- Add explicit error mapping table (input -> expected error class/code).
- Add non-security parity tests for common operations:
  - create/overwrite/truncate/read
  - rename/move/copy/unlink/rm
  - directory watch semantics

Exit criteria:
- Current behavior captured by tests; no ambiguity about expected errors.

### Phase 1: Harden Remaining Mutators with Shared Secure Helpers
Goal:
- Reduce TOCTOU surface without platform helper yet.

Tasks:
- Introduce internal helper layer in sandbox module (single place for safe open/resolve):
  - open existing target safely
  - open parent dir safely
  - verify fd containment
- Route these methods through helper layer:
  - `unlink`, `rm`, `rename`, `move`, `copyFile`, `cp`, `mkdir`, `rmdir`, `truncate`, `chmod`, `utimes`, `link`, `symlink`.
- For operations impossible to make race-free with plain path API, prefer fail-closed strategy.
- Keep `unsafeMode` behavior unchanged.

Exit criteria:
- No direct path mutation calls remain in safe-mode branches unless explicitly justified.
- Full backend test suite green.

### Phase 2: Introduce Native `openat2` Helper (Optional but Recommended)
Goal:
- Make path resolution race-safe at kernel boundary.

Tasks:
- Add small native helper package (Rust preferred for maintainability):
  - open sandbox root dirfd
  - resolve relative path under root with constraints
  - expose operations: open, mkdir, unlink, rename, stat, etc. via `*at` calls
- Node binding interface returns typed errors mapped to Node-like codes.
- Feature gate by platform:
  - Linux with `openat2`: enabled
  - fallback to Phase 1 helper path when unavailable

Exit criteria:
- Linux safe-mode mutators use native helper by default.
- Fallback path remains tested.

### Phase 3: Policy Tightening
Goal:
- Remove unnecessary dangerous primitives in safe mode.

Tasks:
- Decide default policy for `symlink` and possibly `link` in safe mode:
  - option A: disable by default
  - option B: allow only within sandbox with strict verification
- Add config flags for explicit enablement where needed.
- Audit all callers for expectation mismatches.

Exit criteria:
- Clear policy documented and enforced consistently.

### Phase 4: Observability and Incident Diagnostics
Goal:
- Make security failures actionable.

Tasks:
- Add structured security logs on denied operations:
  - method
  - normalized requested path
  - reason code
  - mode (`safe`/`unsafe`)
- Add counters/metrics (if available) for denied operations and race-detected failures.
- Ensure no host path leakage in error messages.

Exit criteria:
- Debuggability improved without leaking sensitive absolute host paths.

## Test Strategy

### Unit/Integration Security Tests
Add dedicated race tests for each mutator class:
- File replaced by symlink between check and op.
- Parent directory replaced by symlink.
- Target toggled between file/dir/symlink at high frequency.
- Rename across boundary attempts.
- Nested traversal attempts (`..`, repeated slashes, absolute aliases).

### Determinism Tests
- Watcher ordering remains stable for create/write/unlink flows.
- No duplicate/phantom write behaviors under patch and full writes.

### Compatibility Matrix
Run tests in both modes:
- `unsafeMode: true`
- `unsafeMode: false`

Run tests for paths:
- relative
- `/root/...` alias
- `/scratch/...` (when configured)
- rootfs-enabled absolute

### CI
Required checks after each phase:
- `pnpm exec tsc --build --pretty false` in backend package.
- `pnpm test sandbox`
- Full backend tests before merge.

## Rollout Plan

1. Land Phase 0 + Phase 1 in small commits.
2. Keep behavior flags off by default for any policy-tightening change.
3. Enable stronger behavior behind feature flag in development.
4. Burn-in in lite/local usage.
5. Promote defaults after at least one stable cycle.

## Risk Register

Risk: Behavior regressions in file watchers.
- Mitigation: explicit watcher regression tests; avoid hidden async delays in hot paths.

Risk: Cross-platform native helper complexity.
- Mitigation: Linux-first implementation with tested fallback path.

Risk: Error churn affecting callers.
- Mitigation: codify and snapshot error mapping; preserve Node-style codes.

Risk: Performance overhead from extra fd/realpath calls.
- Mitigation: benchmark hot operations; cache safe root fd; avoid repeated work inside single operation.

## Recommended Execution Order (Small Commits)
1. Add method-level contract docs + baseline tests.
2. Centralize helper layer for safe mutators.
3. Migrate `unlink`/`rm`/`rename` first.
4. Migrate `move`/`copyFile`/`cp`.
5. Migrate metadata mutators (`chmod`, `utimes`, `truncate`).
6. Add policy gates for links/symlinks.
7. Optional native `openat2` helper introduction.

## Definition of Done
- Safe mode blocks all known symlink race escapes for sandbox APIs.
- Full backend tests pass consistently.
- Security behavior is documented and observable.
- No known path-based mutator remains with unresolved TOCTOU exposure without explicit tracked exception.

## Concrete Task List

This section is intended to be executed top-to-bottom, in small commits.

### PR 1: Contract + Baseline Tests

Task SBOX-001: Method behavior contract table
- Files:
  - [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)
  - [src/.agents/sandbox.md](./src/.agents/sandbox.md)
- Work:
  - Add per-method contract comments for safe mode vs unsafe mode.
  - Add an error mapping table (operation, race case, expected code).
- Validation:
  - `cd src/packages/backend && pnpm exec tsc --build --pretty false`
- Commit message:
  - `backend: document sandbox fs safety contracts`

Task SBOX-002: Baseline mutator behavior tests
- Files:
  - [src/packages/backend/sandbox/sandbox.test.ts](./src/packages/backend/sandbox/sandbox.test.ts)
- Work:
  - Add tests for create/overwrite/truncate/read parity.
  - Add tests for rename/move/copy/unlink/rm expected semantics.
  - Add explicit watcher-ordering regression for create-write-unlink.
- Validation:
  - `cd src/packages/backend && pnpm test sandbox/sandbox.test.ts`
- Commit message:
  - `backend: add sandbox baseline mutator and watcher tests`

### PR 2: Shared Secure Helper Layer

Task SBOX-010: Internal helper abstraction
- Files:
  - [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)
- Work:
  - Centralize secure open/resolve helpers used by mutators.
  - Ensure helpers return explicit reasoned errors (fail-closed).
- Validation:
  - `cd src/packages/backend && pnpm test sandbox/sandbox.test.ts`
  - `cd src/packages/backend && pnpm exec tsc --build --pretty false`
- Commit message:
  - `backend: introduce shared secure sandbox path helpers`

Task SBOX-011: Harden delete/move primitives
- Files:
  - [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)
  - [src/packages/backend/sandbox/sandbox.test.ts](./src/packages/backend/sandbox/sandbox.test.ts)
- Work:
  - Migrate `unlink`, `rm`, `rename`, `move` to helper-backed safe path logic.
  - Add race tests for symlink replacement around these operations.
- Validation:
  - `cd src/packages/backend && pnpm test sandbox/sandbox.test.ts`
  - `cd src/packages/backend && pnpm test`
- Commit message:
  - `backend: harden sandbox delete and move operations`

Task SBOX-012: Harden copy primitives
- Files:
  - [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)
  - [src/packages/backend/sandbox/sandbox.test.ts](./src/packages/backend/sandbox/sandbox.test.ts)
- Work:
  - Migrate `copyFile` and `cp` to helper-backed safe path handling.
  - Cover edge cases: existing destination, symlink replacement in parent.
- Validation:
  - `cd src/packages/backend && pnpm test sandbox/sandbox.test.ts`
  - `cd src/packages/backend && pnpm test`
- Commit message:
  - `backend: harden sandbox copy operations`

Task SBOX-013: Harden metadata mutators
- Files:
  - [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)
  - [src/packages/backend/sandbox/sandbox.test.ts](./src/packages/backend/sandbox/sandbox.test.ts)
- Work:
  - Harden `truncate`, `chmod`, `utimes`, `mkdir`, `rmdir`.
  - Ensure no unsafe path traversal under concurrent path churn.
- Validation:
  - `cd src/packages/backend && pnpm test sandbox/sandbox.test.ts`
  - `cd src/packages/backend && pnpm test`
- Commit message:
  - `backend: harden sandbox metadata mutator operations`

### PR 3: Link Policy Tightening

Task SBOX-020: Safe-mode symlink/link policy
- Files:
  - [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)
  - [src/packages/backend/sandbox/sandbox.test.ts](./src/packages/backend/sandbox/sandbox.test.ts)
- Work:
  - Add explicit policy gate for `symlink` and optionally `link` in safe mode.
  - Default to deny in safe mode unless explicitly enabled by option.
  - Keep unsafe mode unchanged.
- Validation:
  - `cd src/packages/backend && pnpm test sandbox/sandbox.test.ts`
  - `cd src/packages/backend && pnpm test`
- Commit message:
  - `backend: enforce explicit safe-mode link policy in sandbox`

### PR 4: Observability and Guardrails

Task SBOX-030: Security denial logging
- Files:
  - [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)
- Work:
  - Add structured logs for denied operations (method, reason, mode).
  - Ensure logs do not leak host absolute paths.
- Validation:
  - `cd src/packages/backend && pnpm test sandbox/sandbox.test.ts`
- Commit message:
  - `backend: add structured sandbox security denial logging`

Task SBOX-031: Stress/race regression tests
- Files:
  - [src/packages/backend/sandbox/sandbox.test.ts](./src/packages/backend/sandbox/sandbox.test.ts)
- Work:
  - Add repeated race tests with rapid file/symlink replacement.
  - Add deterministic assertions for fail-closed outcomes.
- Validation:
  - `cd src/packages/backend && pnpm test sandbox/sandbox.test.ts`
  - `cd src/packages/backend && pnpm test`
- Commit message:
  - `backend: add sandbox race-condition regression test suite`

### PR 5 (Optional): Linux Native `openat2` Backend

Task SBOX-100: Native helper scaffold
- Files:
  - new native helper package (Rust preferred) under backend tooling area.
  - [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)
- Work:
  - Implement root-dirfd anchored resolution and basic operations.
  - Add feature flag and runtime capability detection.
- Validation:
  - `cd src/packages/backend && pnpm exec tsc --build --pretty false`
  - `cd src/packages/backend && pnpm test sandbox`
- Commit message:
  - `backend: add experimental openat2 sandbox resolver`

Task SBOX-101: Migrate safe-mode mutators to native path
- Files:
  - [src/packages/backend/sandbox/index.ts](./src/packages/backend/sandbox/index.ts)
  - tests under sandbox suite
- Work:
  - Route Linux safe-mode mutators through native resolver.
  - Keep TS helper path as fallback for non-Linux/unavailable kernel.
- Validation:
  - `cd src/packages/backend && pnpm test`
- Commit message:
  - `backend: migrate safe-mode sandbox mutators to openat2 backend`

## Tracking Checklist

- [x] SBOX-001 complete
- [x] SBOX-002 complete
- [x] SBOX-010 complete
- [x] SBOX-011 complete
- [x] SBOX-012 complete
- [x] SBOX-013 complete
- [ ] SBOX-020 complete
- [x] SBOX-030 complete
- [ ] SBOX-031 complete
- [ ] SBOX-100 complete (optional)
- [ ] SBOX-101 complete (optional)
