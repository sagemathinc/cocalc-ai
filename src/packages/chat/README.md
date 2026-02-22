# @cocalc/chat

Shared chat schema/types/helpers used by frontend and lite backend.

## Schema v2

Chat schema v2 introduces explicit records:

- `chat` (messages) with `message_id`, `thread_id`, `reply_to_message_id`
- `chat-thread` (thread identity)
- `chat-thread-config` (title/icon/color/pin/codex config)
- `chat-thread-state` (runtime state: queued/running/interrupted/etc.)

`schema_version` is defined by `CHAT_SCHEMA_V2` in [src/packages/chat/src/index.ts](./src/index.ts).

## One-Off Migration (v1 -> v2)

Build the package, then run:

```bash
pnpm --filter @cocalc/chat build
pnpm --filter @cocalc/chat run migrate:v1-v2 -- /path/to/file.chat
```

Useful flags:

- `--dry-run` (report only, no write)
- `--out <path>` (write to a separate output file)
- `--no-backup` (skip `.bak` backup)
- `--strip-root-thread-fields` (remove legacy thread metadata duplicated on root message rows)

Implementation entrypoint:

- [src/packages/chat/src/scripts/migrate-v1-to-v2.ts](./src/scripts/migrate-v1-to-v2.ts)

## Integrity Checker

Use `computeChatIntegrityReport` from [src/packages/chat/src/integrity.ts](./src/integrity.ts) to validate migrated/runtime data.

Primary counters:

- `orphan_messages`
- `duplicate_root_messages`
- `missing_thread_config`
- `invalid_reply_targets`

### Troubleshooting

If a codex thread appears to lose codex controls/config:

1. Confirm a `chat-thread-config` row exists for the thread root date.
2. Confirm `thread_id` matches between message rows and the thread-config row.
3. Run migration on the chat file and re-check integrity counters.

If a turn appears stuck "running":

1. Check `chat-thread-state` for that thread (`queued/running/interrupted/complete`).
2. Verify the latest assistant `chat` row has `generating: false` after finalize/recovery.
