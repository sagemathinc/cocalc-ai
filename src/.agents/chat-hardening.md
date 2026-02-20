# Chat Hardening Plan (Thread/Message Integrity, Codex Safety, Migration)

## 1. Problem Summary

We have a class of integrity failures where thread identity or codex configuration can be lost/corrupted during normal operation (especially around ACP turn finalization and concurrent updates). This is a release blocker for chat/codex-first workflows.

Recent symptoms:

- A codex thread intermittently loses codex controls/UI identity.
- Root-level thread metadata (`acp_config`, title/icon/color/pin) can be overwritten unexpectedly.
- Some operations still implicitly identify rows by timestamp/date, which is brittle under collisions/races.
- Finalization/recovery paths can update wrong rows if identity is ambiguous.

## 2. Root Causes (Current Architecture)

### 2.1 Identity model is too implicit

- Thread identity is derived from a root message timestamp.
- Message identity is effectively a timestamp (or timestamp-centric lookup/cache).
- Timestamp collisions and date-only targeting can cause cross-row contamination.

### 2.2 Thread metadata is co-located with mutable message rows

- Root message doubles as both content row and thread-identity/config row.
- Any bad write to root row risks wiping thread config (`acp_config`) and therefore codex thread behavior.

### 2.3 Partial-key writes/readbacks still exist

- Even with existing hardening, the overall model allows accidental writes keyed by insufficient identity in some flows.

### 2.4 Races across frontend/backend writers

- Frontend and backend both operate on chat records during turn lifecycle.
- Robustness depends on convention, not strict schema/invariant guarantees.

## 3. Hard Requirements

1. Thread identity must be explicit, immutable, and independent of timestamps.
2. Message identity must be explicit, immutable, and unique.
3. Thread metadata/config must be in dedicated records, never inferred from mutable message content rows.
4. Codex session metadata must survive any normal finalize/retry/recovery flow.
5. Corruption must be detectable quickly and repairable automatically when possible.
6. Migration from legacy `.chat` data must be deterministic and auditable.

## 4. Proposed Data Model (Schema v2)

Use explicit record types inside a single chat syncdoc.

### 4.1 Record types

- `thread`
  - Immutable identity row.
  - Fields: `thread_id`, `created_at`, `created_by`, `root_message_id`, `schema_version`.

- `thread_config`
  - Mutable thread-level UI + codex config row.
  - Fields: `thread_id`, `name`, `thread_color`, `thread_icon`, `pin`, `acp_config`, `updated_at`, `updated_by`.

- `message`
  - One row per message.
  - Fields: `message_id`, `thread_id`, `sender_id`, `date`, `reply_to_message_id?`, `history`, `generating`, `acp_thread_id?`, `acp_usage?`, `acp_interrupted_*?`.

- `thread_state` (optional but recommended)
  - Runtime/convenience status not required for canonical history.
  - Fields: `thread_id`, `state` (`idle|queued|running|interrupted|error|complete`), `active_message_id?`, `updated_at`.

### 4.2 Identity keys

- `thread_id`: UUID/ULID (stable forever).
- `message_id`: UUID/ULID (stable forever).
- Timestamps are ordering metadata only, never identity.

### 4.3 Primary key strategy

For chat doctype, move toward a canonical primary key on explicit ID fields (or `event + id`).

Current descriptor is in [src/packages/sync/editor/doctypes.ts](./src/packages/sync/editor/doctypes.ts). This must be updated as part of schema-v2 rollout so row targeting does not depend on timestamp identity.

## 5. Compatibility Strategy

### 5.1 Dual-read, staged write

Phase migration with compatibility:

- Read path understands both legacy message-only schema and v2 schema.
- New writes go to v2 only once migration for a document is confirmed complete.

### 5.2 On-open migration

When a legacy `.chat` is opened:

1. Build thread groups from legacy rows.
2. Generate deterministic `thread_id` and `message_id` mapping.
3. Create `thread` + `thread_config` + `message` records.
4. Preserve legacy row data in a backup snapshot for rollback.

### 5.3 Idempotent migration

- Migration can be rerun safely.
- Records include `schema_version` and migration markers.
- Verify-then-commit pattern with explicit integrity checks.

## 6. Invariants (Must Always Hold)

1. Every `message.thread_id` refers to an existing `thread.thread_id`.
2. Exactly one root message per thread (`reply_to_message_id == null` and matches `thread.root_message_id`).
3. `thread_config.thread_id` is unique; absent config means defaults, not loss.
4. No write path may update thread config via message row except explicit migration tooling.
5. ACP finalize/recovery must target message row by `message_id` (or full canonical key), never by date-only lookup.
6. UI codex-thread detection must use `thread_config.acp_config` first, not heuristics on message content.

## 7. Implementation Plan (Phased)

## Phase 0 (already started, keep)

Goal: reduce immediate corruption risk in legacy model.

- Keep strict timestamp de-collision in ACP frontend writes.
- Keep sender-qualified backend writes/reads where applicable.
- Add warnings when duplicate date rows are detected.

Relevant current files:

- [src/packages/frontend/chat/acp-api.ts](./src/packages/frontend/chat/acp-api.ts)
- [src/packages/lite/hub/acp/index.ts](./src/packages/lite/hub/acp/index.ts)

## Phase 1: Introduce explicit IDs in current records

Goal: stop relying on date as identity before full schema separation.

1. Add `message_id` and `thread_id` fields to chat message rows (legacy-compatible).
2. Update cache/index to key by `message_id` (not ms-date string).
3. Preserve date-based map only as derived view for ordering.
4. Update all write paths to include and target `message_id`.

Likely touch points:

- [src/packages/frontend/chat/message-cache.ts](./src/packages/frontend/chat/message-cache.ts)
- [src/packages/frontend/chat/actions.ts](./src/packages/frontend/chat/actions.ts)
- [src/packages/frontend/chat/utils.ts](./src/packages/frontend/chat/utils.ts)
- [src/packages/chat/src/index.ts](./src/packages/chat/src/index.ts)

## Phase 2: Introduce `thread` + `thread_config` records

Goal: separate thread identity/config from message content rows.

1. Add new row constructors and typed accessors in `@cocalc/chat`.
2. Move codex config reads/writes to `thread_config` record.
3. Keep rendering compatible with old root metadata for migrated docs only.

Likely touch points:

- [src/packages/chat/src/index.ts](./src/packages/chat/src/index.ts)
- [src/packages/frontend/chat/actions.ts](./src/packages/frontend/chat/actions.ts)
- [src/packages/frontend/chat/codex.tsx](./src/packages/frontend/chat/codex.tsx)

## Phase 3: ACP protocol and finalization hardening on IDs

Goal: ACP lifecycle references immutable IDs end-to-end.

1. Extend chat metadata passed to ACP stream with `thread_id` + `message_id`.
2. Backend writer and recovery paths locate rows by IDs.
3. `persistSessionId` writes only `thread_config`.
4. Finalize/interrupt/recovery update `thread_state` and message row by ID.

Likely touch points:

- [src/packages/frontend/chat/acp-api.ts](./src/packages/frontend/chat/acp-api.ts)
- [src/packages/lite/hub/acp/index.ts](./src/packages/lite/hub/acp/index.ts)

## Phase 4: Migration + cleanup

Goal: remove legacy unsafe behavior.

1. Document-level migration and verification command.
2. Remove date-key assumptions from caches/selectors.
3. Remove legacy root-message-as-thread-config writes.
4. Keep read-only importer for legacy backup files.

## 8. Observability and Diagnostics

Add targeted watchdog diagnostics for chat integrity:

- `chat.integrity.duplicate_date_rows`
- `chat.integrity.missing_thread_config`
- `chat.integrity.orphan_messages`
- `chat.integrity.multi_root_per_thread`
- `chat.acp.finalize_mismatch` (ACP completed but thread state not terminal)

And include periodic sampling logs with top offending thread/message IDs.

## 9. Test Plan

## 9.1 Unit tests

- ID generation uniqueness and determinism.
- Thread root invariants.
- Thread config persistence independent of message edits.
- ACP finalize/recovery cannot change `thread_config` unintentionally.

## 9.2 Property/fuzz tests

Randomized sequences of:

- send/edit/reply/delete/fork/interruption/finalize/recovery
- concurrent frontend/backend update streams

Invariant check after each step.

## 9.3 Migration tests

- Golden legacy `.chat` fixtures.
- Migration idempotence.
- Backward compatibility reads.
- Corrupted input handling (partial/bad rows).

## 9.4 Integration tests

- Restart during running codex turn.
- Interrupt + immediate send + continue flows.
- Multiple simultaneous codex threads in one chat document.

## 10. Rollout Plan

1. Feature flag `COCALC_CHAT_SCHEMA_V2=1` in lite first.
2. Auto-migrate local dev docs, keep backup snapshots.
3. Burn-in period with elevated integrity logging.
4. Promote to default once corruption counters stay zero.
5. Keep importer for old snapshots; remove dual-write after stabilization.

## 11. Open Design Decisions

1. Single `.chat` file with typed records vs per-thread hidden files.
   - Recommendation now: stay single-file with explicit typed records.
   - Reason: simpler search/time-travel/export semantics and less filesystem complexity.

2. ID format: UUIDv4 vs ULID.
   - Recommendation: ULID if ordering convenience is useful; otherwise UUIDv4.

3. Should `thread_state` be persisted or derived?
   - Recommendation: persisted lightweight state for robust restart UX.

## 12. Acceptance Criteria

This work is complete only when all are true:

1. No known code path can remove codex-thread identity/config by modifying message rows.
2. Thread identity survives restarts, finalize, interrupts, continues, and migrations.
3. Message and thread updates are ID-addressed, not date-addressed.
4. Integrity checks run continuously and report zero violations in burn-in.
5. Legacy chats migrate automatically with rollback artifacts and pass invariant checks.

## 13. Immediate Next Work Items (Concrete)

1. Add `message_id` + `thread_id` fields and plumb them through chat send/reply paths.
2. Refactor [src/packages/frontend/chat/message-cache.ts](./src/packages/frontend/chat/message-cache.ts) to key by `message_id`.
3. Introduce `thread_config` record type and migrate codex config accessors in [src/packages/frontend/chat/actions.ts](./src/packages/frontend/chat/actions.ts).
4. Update ACP metadata and writer logic to target message rows via IDs in [src/packages/lite/hub/acp/index.ts](./src/packages/lite/hub/acp/index.ts).
5. Add integrity watchdog counters and invariant-check utility callable from tests and debug UI.

