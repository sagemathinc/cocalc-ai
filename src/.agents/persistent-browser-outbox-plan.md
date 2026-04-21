# Persistent Browser Outbox Proposal

## Summary

CoCalc currently protects unsaved realtime edits while the browser process stays
alive, but many pending writes are only kept in memory. If the network drops and
the user refreshes, closes the tab, or the browser crashes before those writes
are durably acknowledged, user-authored data can be lost.

This plan proposes a bounded browser-local write-ahead outbox for Conat sync
primitives. The outbox should preserve user-authored unsaved data across browser
refresh/crash, while avoiding surprising automatic replay of stale edits.

The immediate motivating bug is chat:

1. The user writes a long Codex/chat message.
2. The network is offline or Conat is disconnected.
3. The user clicks Send.
4. The composer clears immediately, as desired.
5. The message appears optimistically but never becomes durable.
6. After refresh, both the composer draft and optimistic message are gone.

The broader version of the same problem is:

1. The user edits any syncdoc while disconnected.
2. Pending Conat writes remain only in memory.
3. The browser refreshes before those writes are acknowledged.
4. The in-memory pending writes disappear.

The goal is not to guarantee perfect offline collaboration. The goal is to
significantly reduce avoidable data loss with explicit, bounded, user-controlled
recovery.

## Goals

- Preserve user-authored unsaved data across browser refresh, tab close, and
  browser crash.
- Keep the existing chat invariant that the composer clears immediately on send.
- Avoid silently applying old recovered patches/messages in a way that surprises
  users.
- Bound browser-local storage by age, total bytes, per-document bytes, and entry
  size.
- Make recovery explicit after a previous browser session: apply or discard.
- Reuse the same foundation for chat, DKV-backed data, DStream-backed patchflow,
  and future sync primitives.
- Make replay idempotent wherever possible.
- Add enough instrumentation and tests to trust this for data-loss prevention.

## Non-Goals

- Do not implement full offline-first CoCalc in this phase.
- Do not automatically run Codex/ACP work after restoring an unsent chat message.
- Do not silently replay stale DStream entries from old browser sessions.
- Do not store arbitrary large files or unbounded binary payloads in the browser.
- Do not assume `navigator.onLine` is authoritative.
- Do not require a service worker in the first implementation.

## Current Architecture Notes

Relevant files:

- `src/packages/frontend/chat/chatroom.tsx`
- `src/packages/frontend/chat/actions.ts`
- `src/packages/frontend/chat/acp-api.ts`
- `src/packages/frontend/chat/register.ts`
- `src/packages/sync/editor/generic/sync-doc.ts`
- `src/packages/conat/sync/dstream.ts`
- `src/packages/conat/sync/dkv.ts`
- `src/packages/conat/sync/core-stream.ts`
- `src/packages/conat/persist/storage.ts`

Chat currently has a two-stage Codex path:

1. `chatroom.tsx` clears the composer before durable persistence is known.
2. `actions.sendChat(...)` writes the user message row to SyncDB and commits
   locally.
3. `processAcpLLM(...)` calls `await syncdb.save()` before calling ACP RPCs
   (`streamAcp` or `steerAcp`).

That means ACP startup is RPC-based, but user-message persistence still depends
on SyncDB/Conat persistence. The safe boundary for "the user's message will not
be lost" is the successful persistence of the user chat row, not the ACP ack.

`DStream` currently has an in-memory outbox:

- `local`: messages published locally but not yet confirmed.
- `publishOptions`: headers/options for those local messages.
- `saved`: messages sent to persistence but not yet echoed back.
- `save()` retries until `local` is empty.

`DKV` currently has an in-memory outbox:

- `local`: key values or tombstones not yet confirmed.
- `options`: headers/options for local keys.
- `saved`: values sent to persistence but not yet stable.
- `changed`: keys changed during save attempts.
- `save()` waits for stable acknowledgement.

The missing piece is persistence of those in-memory pending writes across
browser restart.

## Core Design

Add a browser-only persistent outbox backed by IndexedDB.

The outbox stores pending writes before they are attempted against Conat. On a
normal successful save, the entry is removed. If the browser refreshes first,
the entry remains available for recovery.

Use IndexedDB instead of `localStorage`.

Reasons:

- IndexedDB is asynchronous and avoids blocking the UI thread on every edit.
- It can store larger structured payloads than `localStorage`.
- It supports indexes needed for TTL, byte accounting, stream identity, and
  project/document lookup.
- It can store MsgPack-encoded payloads or `Uint8Array` values without JSON
  coercion.

## Recovery Policy

Use two different policies depending on session continuity.

### Same Browser Session

While the same `DStream` or `DKV` instance remains open:

- Existing in-memory retry remains automatic.
- IndexedDB is only crash/refresh protection.
- Once a write is acknowledged, delete its IndexedDB entry.

### Previous Browser Session

After refresh, tab close, browser crash, or app restart:

- Do not silently replay old recovered DStream entries.
- Show explicit recovery UI when the relevant document/chat opens.
- Let the user apply or discard the recovered data.
- If the user applies while offline, move the data back into local unsaved state;
  normal Conat retry will save when possible.
- If the user discards, delete the outbox entry.

The first version should not require proving the browser is online before
showing recovery. Connectivity detection is unreliable, and users may want to
copy recovered data while still offline.

## Recovery UX

For a normal editor/syncdoc:

> CoCalc found unsaved edits from a previous browser session.
>
> File: `path/to/file.ts`
>
> Last edited: 12 minutes ago
>
> These edits were not confirmed saved before the browser disconnected or
> refreshed. You can apply them now or discard them.

Buttons:

- `Apply Unsaved Edits`
- `Discard`
- `View Details`

For chat:

> CoCalc found an unsent chat message from a previous browser session.
>
> Chat: `path/to/thread.chat`
>
> Last edited: 12 minutes ago
>
> You can put it back into this chat or discard it.

Buttons:

- `Restore Message`
- `Discard`
- `View Text`

Important chat behavior:

- Restoring the message should not automatically start Codex.
- The restored message can be inserted into the chat as a user-authored row with
  no ACP state, or placed back in the composer depending on the final UX choice.
- If inserted into the chat, the user should have a clear "not sent to agent"
  state or resend affordance.

## Storage Model

Create a small browser-local package or module, likely under one of:

- `src/packages/conat/sync/browser-outbox.ts`
- `src/packages/frontend/conat/browser-outbox.ts`
- `src/packages/frontend/conat/persistent-outbox.ts`

The lower-level package should not require React.

Suggested database:

- IndexedDB database: `cocalc-conat-outbox-v1`
- Object store: `entries`
- Indexes:
  - `byIdentity`: `[kind, scope, name]`
  - `byProjectPath`: `[project_id, path]`
  - `byCreatedAt`: `created_at`
  - `byExpiresAt`: `expires_at`
  - `byClientId`: `client_id`

Suggested entry shape:

```ts
type BrowserOutboxKind = "dkv" | "dstream" | "chat-row";

type BrowserOutboxEntry = {
  id: string;
  kind: BrowserOutboxKind;
  schema_version: 1;

  // The browser session that created this entry.
  client_id: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  last_attempt_at?: number;

  // Scope.
  account_id?: string;
  project_id?: string;
  host_id?: string;
  name?: string;
  path?: string;

  // Operation identity.
  key?: string;
  msgID?: string;
  operation_id?: string;
  op: "set" | "delete" | "publish" | "chat-row";

  // Encoded payload.
  value?: Uint8Array;
  headers?: Uint8Array;
  options?: Uint8Array;

  // User-facing recovery metadata.
  label?: string;
  description?: string;
  preview?: string;
  bytes: number;
};
```

Use a schema version from day one. Recovery data can outlive deployed code.

## Bounds

Initial conservative defaults:

- Global cap: 50 MB.
- Per project cap: 20 MB.
- Per document/stream cap: 5 MB.
- Per entry cap: 1 MB.
- TTL: 7 days for DKV/chat rows.
- TTL: 24-48 hours for DStream patch recovery until we have more confidence.
- Max entry count: 10,000 global, with lower per-document limits.

Eviction rules:

- Delete expired entries first.
- Delete entries already marked applied/acknowledged.
- If still over cap, delete oldest unapplied entries and record a telemetry
  warning.
- Avoid silently evicting fresh user-authored data if possible.

If an entry exceeds the per-entry cap:

- Do not store it.
- Surface a warning if this is user-authored foreground data.
- Keep existing in-memory retry behavior.

## DKV Integration

DKV is the safest first general primitive.

Why:

- Key/value writes are naturally idempotent-ish.
- Replaying a set to the same key is normally safe.
- Deletes can be represented as tombstones.
- Existing merge logic already handles local/remote conflicts.

Implementation sketch:

1. Add optional `persistentOutbox?: PersistentOutboxOptions` to `DKVOptions`.
2. On `set`, `setMany`, and `delete`, write a bounded outbox entry before or at
   the same time as updating `local`.
3. During `init`, load matching outbox entries.
4. For same-session entries, hydrate directly into `local`.
5. For previous-session entries, expose them via a recovery event or API instead
   of silently applying.
6. On successful persistence and stable echo, delete the corresponding outbox
   entry.

Potential API:

```ts
type PersistentOutboxOptions = {
  enabled?: boolean;
  mode?: "automatic-same-session" | "manual-recovery";
  label?: string;
  path?: string;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
};
```

Recovery API:

```ts
store.on("recovery-available", (entries) => {});
await store.applyRecoveredEntry(entry.id);
await store.discardRecoveredEntry(entry.id);
```

Validation:

- Set key while `setKvMany` fails.
- Close/create a new DKV instance.
- Confirm recovery entry exists.
- Apply recovery.
- Confirm value saves and outbox entry is removed.
- Confirm discard removes the entry.
- Confirm merge function still runs when remote differs.

## DStream Integration

DStream is useful but riskier.

Risks:

- Append-only streams can duplicate messages if replay is not idempotent.
- Backend `msgID` dedupe currently appears intended for short retry windows.
- Some DStream consumers may not tolerate old entries being appended later.

Requirement:

- Persistent DStream outbox must be opt-in.
- Persistent DStream outbox should require a stable `msgID`.
- Unknown DStream consumers should not get this automatically.

Implementation sketch:

1. Add `persistentOutbox?: PersistentOutboxOptions` to `DStreamOptions`.
2. Add an optional `msgID` to `DStream.publish` options, or allow callers to
   provide a stable operation id.
3. If persistent outbox is enabled and no stable `msgID` is available, either
   reject or store only same-session recovery.
4. Store each publish entry in IndexedDB before adding it to `local`.
5. On successful publish/echo, delete the outbox entry.
6. On new browser session, expose recovery entries; do not automatically replay
   unless the stream explicitly opts into it.

Potential API:

```ts
dstream.publish(mesg, {
  msgID,
  headers,
  ttl,
  persistentOutboxLabel,
});
```

Backend `msgID` dedupe:

- We can consider a longer dedupe TTL, but it should not be global by default.
- Prefer stream/storage config for longer dedupe where recovery matters.
- Client-side recovery should still assume a replay may already have succeeded.

Validation:

- Publish with stable `msgID`, force publish failure, refresh/reopen, recover,
  publish again, confirm one logical message.
- Publish without stable `msgID` when persistent outbox is required, confirm it
  refuses or falls back to memory-only.
- Confirm stale DStream recovery requires explicit user action.

## SyncDoc / Patchflow Integration

SyncDoc uses DStream-backed patch streams in Conat mode. That makes it the main
high-value DStream use case.

Policy:

- Enable DStream persistent outbox for syncdoc patch streams only after focused
  patchflow recovery tests.
- Recovered patches from a previous browser session should require explicit file
  recovery confirmation.
- Applying recovered patches may make the current document state surprising, but
  Patchflow's DAG/time-travel model reduces the risk of destructive overwrite.

Recovery UI should be file-scoped.

When a syncdoc opens and matching recovery entries exist:

1. Load the document normally.
2. Show a recovery banner/modal.
3. If the user applies, inject the recovered patches into the DStream/local
   pending state and save.
4. If save succeeds, clear outbox entries.
5. If the user discards, clear outbox entries.

Potential follow-up:

- Add a "Recovered Unsaved Edits" TimeTravel marker.
- Allow previewing patch count, age, and approximate size.
- If possible, show a diff after applying recovered patches.

Validation:

- Open a text file, edit offline, force DStream publish failure, refresh.
- Confirm recovery prompt appears.
- Apply recovery and confirm edits appear.
- Confirm history remains coherent.
- Repeat with concurrent remote edits and verify merge/DAG behavior.

## Chat Integration

Chat can use either the generic DKV/DStream outbox later or a narrow `chat-row`
outbox entry sooner.

Given the immediate severity, a chat-specific phase is reasonable even if the
general outbox is planned.

Chat policy:

- Protect user-authored text before clearing the composer.
- Clear the composer immediately on send.
- Remove outbox entry after the user chat row is persisted.
- On recovery, restore the user text without automatically starting Codex.

Two possible recovery choices:

1. Restore into composer.
2. Restore into chat as a user-authored row with "not sent to agent" state.

Restoring into composer is safest for avoiding accidental agent work. Restoring
into chat better reflects that the user clicked Send, but needs a clear resend
control.

Implementation sketch:

1. Before `clearComposerNow`, build a pending chat submission object with stable
   `message_id`, `thread_id`, `date`, and `sender_id`.
2. Store it in the outbox.
3. Call `sendChat` with the prebuilt identity fields.
4. Add support in `sendChat` for externally supplied IDs/date.
5. Add an explicit "persisted" callback/promise for the user row save boundary.
6. Delete the outbox entry after persistence.
7. On chat load, show recovery for entries matching `{ project_id, path }`.

Avoid:

- Do not call `processLLM` automatically for recovered entries.
- Do not automatically call ACP RPCs after refresh.

Validation:

- Offline/disconnected send clears composer and stores outbox entry.
- Refresh restores the pending message/text.
- Successful save deletes the outbox entry.
- Duplicate tabs with the same pending message do not duplicate because
  `message_id` is stable.

## User-Facing Recovery Surfaces

Initial places to surface recovery:

- Chat room composer/thread panel for `chat-row` recovery.
- Generic editor frame for syncdoc recovery.
- Optional project-level notification/flyout listing all recoverable entries.

Project-level recovery is useful because users may not remember which file had
unsaved data. However, first implementation can be per-document only.

Future project-level UI:

- "Recovered Unsaved Data" panel in project log/activity.
- Group by project, path, age, and type.
- Actions: open file/chat, apply, discard.

## Locking and Multi-Tab Behavior

Multiple tabs can discover the same outbox entry.

Use lightweight IndexedDB leases:

- `lease_owner`: browser id/session id.
- `lease_expires_at`: timestamp.
- Apply/discard operations acquire a short lease.
- If a tab dies, another tab can recover after lease expiry.

For same-session automatic retry, multiple tabs should not both replay the same
entry if possible. Stable IDs still make duplicate attempts safe, but leases
reduce noise.

## Security and Privacy

The outbox stores user document/chat content in the browser.

Implications:

- This is private to the browser profile, similar to drafts/local app state.
- Do not store data for signed-out/anonymous contexts unless explicitly allowed.
- Clear outbox entries on explicit project/account sign-out if appropriate.
- Include account/project identity in each entry to avoid cross-account recovery.
- Consider encrypting payloads later, but do not block the first version on it.

## Telemetry and Diagnostics

Add counters/events:

- outbox entry created
- outbox entry skipped due size
- outbox entry applied
- outbox entry discarded
- outbox entry expired
- outbox save succeeded
- outbox save failed
- recovery prompt shown

Avoid logging content. Log only kind, size, age, project/path hashes or safe
paths depending on existing privacy conventions.

## Testing Plan

Unit tests:

- IndexedDB outbox store CRUD, caps, TTL, leases.
- DKV set/delete outbox entry creation.
- DKV recovery apply/discard.
- DStream publish outbox with stable `msgID`.
- DStream publish refuses persistent recovery without stable identity.
- Chat pending row creation and cleanup.

Integration tests:

- Force Conat publish failures with a fake client.
- Refresh/recreate DKV and DStream instances.
- Verify pending entries survive.
- Verify apply saves and clears entries.
- Verify discard clears entries.

Browser/e2e tests:

- Chat offline send, refresh, recover text.
- Editor offline edit, refresh, recovery prompt.
- Multi-tab recovery prompt lease behavior.

Manual validation:

- Real network disconnect in Lite.
- Browser refresh while disconnected.
- Browser close/reopen.
- Quota/cap behavior with large edits.

## Phased Implementation

### Phase 0: Decide Recovery Semantics

Deliverables:

- Confirm chat recovery UX: restore to composer vs restore to chat row.
- Confirm initial size/TTL caps.
- Confirm whether first general layer lives in `packages/conat` or
  `packages/frontend/conat`.

### Phase 1: Browser Outbox Library

Deliverables:

- IndexedDB store with schema version.
- Byte accounting.
- TTL cleanup.
- Per-entry and global caps.
- Lease acquisition.
- Unit tests.

No sync primitive changes yet.

### Phase 2: Chat Data-Loss Fix

Deliverables:

- Store pending chat send before composer clear.
- Clear composer immediately.
- Remove pending entry after user row persistence.
- Recover pending chat text/row on chat load.
- No automatic ACP start from recovery.
- Focused chat tests.

This phase directly fixes the critical user-visible data-loss bug.

### Phase 3: DKV Persistent Outbox

Deliverables:

- Opt-in DKV persistent outbox.
- Same-session automatic retry hydration.
- Previous-session manual recovery API.
- DKV tests for set/delete/recovery/conflict.

This is the safest general primitive phase.

### Phase 4: DStream Persistent Outbox

Deliverables:

- Opt-in DStream persistent outbox.
- Stable `msgID` requirement.
- Manual previous-session recovery.
- Tests for dedupe and duplicate avoidance.

Do not enable broadly yet.

### Phase 5: SyncDoc Patch Recovery

Deliverables:

- Enable DStream outbox for syncdoc patch streams.
- Add editor recovery UI.
- Add patchflow recovery tests.
- Validate with text files and notebooks.

This is the high-value general data-loss reduction phase.

### Phase 6: Project-Level Recovery UI

Deliverables:

- Project-level list of recoverable unsaved data.
- Open/apply/discard actions.
- Better visibility for entries whose file/chat is not currently open.

## Open Questions

- Should chat recovery restore into the composer or into the thread as a
  not-sent user row?
- What is the right default TTL for syncdoc patch recovery: 24 hours, 48 hours,
  or 7 days?
- Should backend `msgID` dedupe TTL become configurable per stream?
- Where should the browser outbox package live so `conat` can use it without
  importing frontend-only code?
- Should project/account sign-out delete outbox entries immediately?
- How should we present recovered patchflow edits if applying them changes the
  current document in a surprising way?
- Should large recovery entries be rejected, summarized, or split?

## Recommended Next Step

Start with Phase 1 and Phase 2.

Reasoning:

- Phase 2 fixes the critical chat data-loss bug directly.
- Phase 1 gives Phase 2 a reusable storage foundation instead of a one-off
  localStorage hack.
- DKV/DStream/syncdoc recovery can then be built on the same bounded outbox with
  more confidence.

Avoid starting with syncdoc patch recovery. It is the most valuable long-term
target, but it has the highest surprise/conflict risk and needs the strongest
tests.
