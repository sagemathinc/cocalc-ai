# Chat Hardening Plan (Greenfield-First, Minimal Backward Compatibility)

## 1. Scope and Assumptions

This plan is optimized for current reality:

- CoCalc-AI chat is effectively greenfield.
- Backward compatibility is minimal and explicit, not open-ended.
- There is exactly one active operator/deployer right now.
- We can break compatibility if needed, as long as a one-off migration path exists for a few important legacy `.chat` files.

Primary objective: make chat/codex data integrity robust enough that thread identity/config corruption is effectively impossible in normal operation.

## 2. Non-Negotiable Outcomes

1. Thread identity is explicit and immutable (not inferred from timestamp).
2. Message identity is explicit and immutable (not inferred from timestamp).
3. Thread config (title/icon/color/image/agent config) is separate from message content rows.
4. ACP finalize/recovery/interrupt flows never target rows by date-only.
5. A one-off migration tool exists for the few legacy files that matter.
6. Integrity checks and watchdog logs can prove invariants hold.

## 3. Target Schema (v2)

Use explicit typed records within one `.chat` syncdoc.

### 3.1 `thread`

Immutable thread identity record.

- `thread_id` (UUID/ULID)
- `created_at`
- `created_by`
- `root_message_id`
- `schema_version`

### 3.2 `thread_config`

Mutable thread-level settings and agent config.

- `thread_id`
- `name`
- `thread_color`
- `thread_icon`
- `thread_image` (blobstore URL or external URL)
- `pin`
- `agent` / `acp_config` (codex thread settings)
- `updated_at`
- `updated_by`

Note: this enables converting a normal thread into a codex thread by updating thread config, not by mutating message structure.

### 3.3 `message`

One row per chat message.

- `message_id`
- `thread_id`
- `sender_id`
- `date`
- `reply_to_message_id?`
- `history`
- `generating`
- `acp_thread_id?`
- `acp_usage?`
- `acp_interrupted_*?`

### 3.4 `thread_state` (persisted)

Persisted lightweight runtime state for restart-safe UX.

- `thread_id`
- `state` (`idle|queued|running|interrupted|error|complete`)
- `active_message_id?`
- `updated_at`

## 4. Identity and Ordering

- IDs are canonical identity (`thread_id`, `message_id`).
- Timestamps are ordering metadata only.
- UI ordering can still sort by `message.date`.
- Reply linkage is by `reply_to_message_id`, not thread-root timestamp.

ID format:

- Prefer ULID for natural ordering ergonomics; UUIDv4 is also acceptable.
- If UUIDv4 is used, always sort by `date` for display.

## 5. Invariants

1. Every `message.thread_id` resolves to an existing `thread`.
2. Exactly one root message per thread, and it matches `thread.root_message_id`.
3. Exactly one `thread_config` per `thread_id` (or a deterministic default if absent).
4. Message writes never mutate thread config fields.
5. ACP lifecycle updates target rows by explicit IDs.
6. Codex-thread UI state is derived from `thread_config.agent/acp_config`, not message-content heuristics.

## 6. Backward Compatibility Policy

No dual-read/dual-write framework.

Instead:

- Build a one-off migration script (`scripts/chat-migrate-v1-to-v2.ts` or `.js`).
- Run it manually on the handful of legacy files that matter.
- Keep a pre-migration backup copy of each file.

Target legacy set (currently):

- `/home/wstein/build/cocalc-lite*/lite*.chat`

If migration fails for a file, fix script or hand-repair that file. No generalized compatibility machinery is required.

## 7. Migration Tool Requirements (One-Off)

Input: legacy `.chat` syncdoc.
Output: v2 `.chat` syncdoc.

The script must:

1. Assign deterministic `thread_id` and `message_id` mapping.
2. Split root metadata into `thread_config`.
3. Preserve message history and ordering.
4. Rewrite reply links to `reply_to_message_id`.
5. Emit a verification report:
   - thread count
   - message count
   - invariant check result
   - list of anomalies fixed
6. Write backup (`.bak`) before replacing original.

## 8. Implementation Plan (Phases)

## Phase A: Stabilize current path while v2 is built

Keep existing hardening that prevents immediate corruption in current architecture.

Relevant files:

- [src/packages/frontend/chat/acp-api.ts](./src/packages/frontend/chat/acp-api.ts)
- [src/packages/lite/hub/acp/index.ts](./src/packages/lite/hub/acp/index.ts)

## Phase B: Introduce explicit IDs in message flow

1. Add `message_id` and `thread_id` to all new messages.
2. Refactor cache/index to key by `message_id`.
3. Keep date-based ordering as derived view only.

Likely files:

- [src/packages/frontend/chat/message-cache.ts](./src/packages/frontend/chat/message-cache.ts)
- [src/packages/frontend/chat/actions.ts](./src/packages/frontend/chat/actions.ts)
- [src/packages/frontend/chat/utils.ts](./src/packages/frontend/chat/utils.ts)
- [src/packages/chat/src/index.ts](./src/packages/chat/src/index.ts)

## Phase C: Add `thread` and `thread_config` records

1. Add typed constructors/accessors in `@cocalc/chat`.
2. Move thread UI + codex config writes to `thread_config`.
3. Add thread-level agent mode conversion actions (normal <-> codex).

Likely files:

- [src/packages/chat/src/index.ts](./src/packages/chat/src/index.ts)
- [src/packages/frontend/chat/actions.ts](./src/packages/frontend/chat/actions.ts)
- [src/packages/frontend/chat/codex.tsx](./src/packages/frontend/chat/codex.tsx)

## Phase D: ACP protocol on IDs

1. Pass `thread_id` + `message_id` in ACP chat metadata.
2. Backend writer/finalizer/recovery paths use IDs exclusively.
3. `persistSessionId` writes only to `thread_config`.

Likely files:

- [src/packages/frontend/chat/acp-api.ts](./src/packages/frontend/chat/acp-api.ts)
- [src/packages/lite/hub/acp/index.ts](./src/packages/lite/hub/acp/index.ts)

## Phase E: One-off migration and cutover

1. Implement and run migration script on legacy files.
2. Validate invariants and smoke-test codex workflows.
3. Remove remaining date-identity assumptions from runtime paths.

## 9. Observability and Debuggability

Add watchdog fields and counters:

- `chat.integrity.orphan_messages`
- `chat.integrity.duplicate_root_messages`
- `chat.integrity.missing_thread_config`
- `chat.integrity.invalid_reply_targets`
- `chat.acp.finalize_mismatch`

Add periodic top-N diagnostics by affected thread/message IDs.

## 10. Testing Strategy

## 10.1 Unit tests

- ID generation and uniqueness.
- Thread/message invariant checks.
- Thread config isolation from message mutations.
- ACP finalize/recovery ID-targeting behavior.

## 10.2 Integration tests

- Interrupt/continue/immediate-send flows.
- Backend restart during active codex turn.
- Multiple concurrent codex threads in one chat.
- Convert normal thread to codex thread and back.

## 10.3 Migration tests (minimal)

Given very small migration scope:

- Test script against representative fixtures.
- Verify before/after counts and invariants.
- Manual inspection acceptable for the few real files.

## 11. Rollout

Single-operator simplified rollout:

1. Implement phases B/C/D.
2. Run migration script on legacy files.
3. Use and monitor with extra watchdog logs.
4. If stable, delete dead compatibility code and lock v2 schema.

## 12. Future Scaling Notes (Optional)

When chat files become very large:

- Add archive/rotation of old messages to companion files, or
- Provide explicit prune/export tooling for old history.

Given current timetravel behavior, keep single-file design for now.

## 13. Acceptance Criteria

Complete when all are true:

1. No known path can wipe codex-thread config via message writes.
2. All runtime row targeting is ID-based.
3. Thread identity/config survives restart/finalize/interrupt/continue.
4. One-off migration script exists and has been run on required legacy files.
5. Watchdog/invariant logs show no integrity violations in normal use.

## 14. Immediate Next Tasks

1. Add `message_id` + `thread_id` to send/reply paths.
2. Re-key message cache to `message_id` in [src/packages/frontend/chat/message-cache.ts](./src/packages/frontend/chat/message-cache.ts).
3. Introduce `thread_config` record and move codex config writes there.
4. Add thread-level action to set/unset codex agent config.
5. Update ACP metadata and backend writer paths to use IDs.
6. Implement one-off migration script and run it on legacy files.
