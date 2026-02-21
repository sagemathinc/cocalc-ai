# Chat Hardening Execution Checklist and Commit Order

This is the concrete implementation sequence for the v2 chat hardening work.

Goals:

- Keep each commit small and reviewable.
- Preserve a runnable system after every commit.
- Remove timestamp-as-identity assumptions as early as possible.
- Avoid generalized backward-compat complexity; use one-off migration tooling.

## Pre-Flight (before commit 1)

- [ ] Create branch `chat-v2-hardening`.
- [ ] Confirm current tests pass for touched packages:
  - [ ] `pnpm --dir src/packages/frontend test -- src/packages/frontend/chat`
  - [ ] `pnpm --dir src/packages/lite test -- src/packages/lite/hub/acp`
- [ ] Keep current production hardening in place (no rollback of existing ACP collision/sender guards).

## Commit 1: Add v2 shared types and constructors

Commit message suggestion:

`chat: add schema-v2 record types for thread/thread_config/message/thread_state`

Checklist:

- [x] Add v2 record interfaces and constructors in [src/packages/chat/src/index.ts](./src/packages/chat/src/index.ts).
- [ ] Add helper constructors:
  - [x] `buildThreadRecord(...)`
  - [x] `buildThreadConfigRecord(...)`
  - [x] `buildMessageRecordV2(...)`
  - [x] `buildThreadStateRecord(...)`
- [x] Keep old exports intact so existing code compiles.

Validation:

- [x] Typecheck/build frontend + lite packages.
- [x] No runtime behavior changes yet.

## Commit 2: Introduce `message_id` and `thread_id` in write paths

Commit message suggestion:

`chat: assign explicit message_id/thread_id on new chat messages`

Checklist:

- [x] Update send/reply creation flows in [src/packages/frontend/chat/actions.ts](./src/packages/frontend/chat/actions.ts).
- [x] Ensure every new message carries `message_id` and `thread_id`.
- [x] Keep existing date fields for ordering.

Validation:

- [ ] Add unit tests for ID presence on new root/reply messages. (partially covered by existing chat/acp tests; explicit root/reply tests still pending)
- [ ] Verify message creation still works in UI.

## Commit 3: Re-key frontend cache/index by `message_id`

Commit message suggestion:

`chat: key message cache by message_id instead of timestamp`

Checklist:

- [ ] Refactor [src/packages/frontend/chat/message-cache.ts](./src/packages/frontend/chat/message-cache.ts):
  - [x] primary map key = `message_id` (internal map; date-keyed compatibility map still exported)
  - [x] maintain secondary index by timestamp only for sorting/lookup utilities
- [ ] Update dependent selectors and helpers in:
  - [ ] [src/packages/frontend/chat/actions.ts](./src/packages/frontend/chat/actions.ts) (partial: added date-key accessor; broader key-assumption cleanup pending)
  - [ ] [src/packages/frontend/chat/utils.ts](./src/packages/frontend/chat/utils.ts) (partial: root/date helpers now tolerate non-date map keys)

Validation:

- [ ] Add/update tests for cache updates and thread indexing. (partial: cache by-id/date-index coverage added)
- [ ] Confirm thread rendering/scroll still works.

## Commit 4: Add `thread` and `thread_config` records (storage + accessors)

Commit message suggestion:

`chat: introduce thread and thread_config records with typed accessors`

Checklist:

- [x] Add record creation/read/update helpers in `@cocalc/chat` and chat actions.
- [x] Move thread metadata ownership from root message to `thread_config`.
- [x] Include `thread_image` in `thread_config`.

Validation:

- [ ] Unit tests for thread config read/write and defaults. (partial coverage exists; dedicated tests still pending)
- [ ] Ensure title/icon/color/pin still render and persist.

## Commit 5: Codex thread identity from `thread_config` + conversion action

Commit message suggestion:

`chat: make codex mode thread-config driven and add normal<->codex conversion`

Checklist:

- [x] Update codex-thread detection to prioritize `thread_config.acp_config`.
- [x] Add action(s) to convert a thread:
  - [x] normal -> codex
  - [x] codex -> normal
- [x] Keep existing UX controls functional.

Likely files:

- [src/packages/frontend/chat/actions.ts](./src/packages/frontend/chat/actions.ts)
- [src/packages/frontend/chat/codex.tsx](./src/packages/frontend/chat/codex.tsx)

Validation:

- [ ] UI test: toggle codex mode on existing thread.
- [ ] Verify top controls follow conversion immediately.

## Commit 6: ACP metadata includes IDs (frontend)

Commit message suggestion:

`chat/acp: send thread_id and message_id in ACP metadata`

Checklist:

- [x] Extend ACP chat metadata builder in [src/packages/frontend/chat/acp-api.ts](./src/packages/frontend/chat/acp-api.ts).
- [x] Include `thread_id`, `message_id` in requests.
- [x] Preserve current fallback fields while backend catches up.

Validation:

- [x] Update/add tests in frontend ACP tests.
- [x] Confirm stream requests include IDs.

## Commit 7: ACP writer/finalizer/recovery target by IDs (backend)

Commit message suggestion:

`lite/acp: resolve and update chat rows by message_id/thread_id`

Checklist:

- [x] Update writer init/finalize/recovery in [src/packages/lite/hub/acp/index.ts](./src/packages/lite/hub/acp/index.ts) to target records by IDs. (indexed `message_id` lookup is now primary path; linear fallback is disabled by default and only kept as explicit legacy emergency mode)
- [x] Make `persistSessionId` write thread config record only (not message rows).
- [x] Keep sender-qualified fallback only as temporary safety net.

Validation:

- [x] Extend [src/packages/lite/hub/acp/__tests__/chat-writer.test.ts](./src/packages/lite/hub/acp/__tests__/chat-writer.test.ts).
- [x] Verify restart recovery keeps codex config intact.

## Commit 8: Persisted `thread_state` for robust restart UX

Commit message suggestion:

`chat: persist thread_state and use it for running/queued/interrupted UX`

Checklist:

- [x] Write `thread_state` transitions during send/queue/run/finalize/interrupt.
- [x] Read `thread_state` for spinner/status rendering instead of fragile inference. (frontend ACP status now uses `message:`/`thread:` keys only, codex message "generating" UI is gated by ACP/thread-state activity, and autoscroll/interrupt checks ignore stale `generating` rows unless thread-state is active)

Validation:

- [x] Integration test: restart during run -> thread becomes interrupted.
- [ ] Verify no stale spinner after restart/interrupt.

## Commit 9: One-off migration script (v1 -> v2)

Commit message suggestion:

`chat: add one-off migration script from legacy chat schema to v2`

Checklist:

- [x] Add script: `src/packages/chat/scripts/migrate-v1-to-v2.ts` (or `.js`).
- [x] Features:
  - [x] backup original file (`.bak`)
  - [x] deterministic ID mapping
  - [x] emit `thread`/`thread_config`/`message`/`thread_state`
  - [x] rewrite reply references to `reply_to_message_id`
  - [x] print integrity report
- [x] Document exact usage in script header/comments.

Validation:

- [x] Run script on fixture files.
- [x] Run script on `lite*.chat` targets manually.

## Commit 10: Remove remaining date-identity writes/reads

Commit message suggestion:

`chat: remove date-key identity assumptions from runtime paths`

Checklist:

- [x] Audit and remove date-only `get_one/set/delete` callsites in chat/acp code. (frontend chat + lite/acp syncdb chat ops now sender-qualified)
- [ ] Keep date only for sort/time display. (partial: ACP queue + status state now key by `thread_id`/`message_id` only; thread-config reads are `thread_id` only; thread-config writes no longer synthesize timestamp-based `thread_id`; date remains for ordering/UI thread selection and selected legacy updates)
- [ ] Delete transitional fallback code introduced in earlier commits where safe. (partial: removed ACP date-key state fallback paths in queue/cancel/render/autoscroll; ACP backend chat-row lookup now uses `message_id` first and skips date+sender fallback when `message_id` is present; thread metadata no longer auto-copies root message fields into `thread_config`; thread list rendering no longer reads root `name/thread_color/thread_icon`; language-model thread detection is thread-config driven and no longer performs side-effect writeback inference)

Validation:

- [x] Grep audit for date-only identity patterns.
- [ ] Full chat/codex smoke test.

## Commit 11: Integrity checker + watchdog fields

Commit message suggestion:

`chat: add integrity checker and watchdog counters for schema-v2 invariants`

Checklist:

- [x] Add invariant checker utility callable from tests and debug paths.
- [x] Add counters/log fields:
  - [x] `chat.integrity.orphan_messages`
  - [x] `chat.integrity.duplicate_root_messages`
  - [x] `chat.integrity.missing_thread_config`
  - [x] `chat.integrity.invalid_reply_targets`
  - [x] `chat.acp.finalize_mismatch`

Validation:

- [x] Unit tests for invariant failures.
- [x] Confirm watchdog logs include top offending IDs.

## Commit 12: Cleanup + docs

Commit message suggestion:

`chat: finalize schema-v2 cutover and remove obsolete legacy paths`

Checklist:

- [ ] Remove dead legacy compatibility code. (partial: new root/fork threads now always create thread-config rows; runtime no longer relies on root-message `acp_config`; thread metadata no longer mutates/copies from root chat rows; thread list metadata no longer falls back to root chat rows; thread identity prefers explicit `agent_*` metadata)
- [x] Update developer docs and comments.
- [x] Add troubleshooting note for migration and integrity checker.

Validation:

- [ ] End-to-end manual smoke test checklist passes.
- [x] All relevant tests pass.

## Manual Smoke Test Checklist (run after commits 7, 10, and 12)

- [ ] Start new normal thread, send/edit/reply messages.
- [ ] Convert thread to codex thread and run a turn.
- [ ] Interrupt and click continue.
- [ ] Send immediately during a run.
- [ ] Restart backend during a run; verify interrupted state, no stale running spinner.
- [ ] Confirm codex controls remain present after finalize.
- [ ] Fork thread and verify new thread config and IDs are consistent.

## Suggested Commit Grouping for Fast Iteration

If 12 commits feels too granular, combine into 6 PR-sized commits:

1. Commits 1-2
2. Commits 3-4
3. Commit 5
4. Commits 6-7
5. Commits 8-9
6. Commits 10-12

## Stop/No-Go Criteria

Pause rollout if any occur:

- [ ] Any codex thread loses config/controls after finalize/restart.
- [ ] Any invariant checker critical violation (`orphan`, `missing_thread_config`, `invalid_reply_targets`) on normal usage.
- [ ] ACP terminal state mismatch repeats in normal workflows.
