# @cocalc/chat

Shared chat schema/types/helpers used by frontend and lite backend.

## Schema v2

Chat schema v2 introduces explicit records:

- `chat` (messages) with `message_id`, `thread_id`, `parent_message_id`
- `chat-thread` (thread identity)
- `chat-thread-config` (title/icon/color/pin/codex config, archive metadata)
- `chat-thread-state` (runtime state: queued/running/interrupted/etc.)

`schema_version` is defined by `CHAT_SCHEMA_V2` in [src/packages/chat/src/index.ts](./src/index.ts).

## Legacy chat records

The former `migrate:v1-v2` package script and its migration executable are no
longer present. Do not use the old one-off command as a repair procedure.

The frontend contains compatibility readers in
[normalize.ts](../frontend/chat/normalize.ts) and
[message-cache.ts](../frontend/chat/message-cache.ts). Normalization is not a
complete file migration or a guarantee that missing thread configuration has
been repaired. Inspect the actual records and integrity report before deciding
on a repair; preserve the original file before any mutation.

## Integrity Checker

Use `computeChatIntegrityReport` from [src/packages/chat/src/integrity.ts](./src/integrity.ts) to validate migrated/runtime data.

Primary counters:

- `orphan_messages`
- `duplicate_root_messages`
- `missing_thread_config`
- `invalid_reply_targets`

### Troubleshooting

If a codex thread appears to lose codex controls/config:

1. Confirm a `chat-thread-config` row exists for the thread's `thread_id`.
2. Confirm `thread_id` matches between message rows and the thread-config row.
3. Inspect the integrity counters and relevant records; the compatibility reader is not a repair command.

If a turn appears stuck "running":

1. Check `chat-thread-state` for that thread (`queued/running/interrupted/complete`).
2. Verify the latest assistant `chat` row has `generating: false` after finalize/recovery.
