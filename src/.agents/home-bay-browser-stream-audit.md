# Home Bay Browser Stream Audit

Date: 2026-04-04

## Goal

Define the realtime channel from a user's home bay to browser tabs for projected
account state:

- project summaries
- collaborator summaries
- notification inbox rows and counts
- later, settings/publication counters

This audit is specifically about whether Conat's existing `socket` / `dstream`
 primitives are sufficient, what they actually guarantee today, and what small
 additions are still needed to make the browser path correct under real-world
 reconnect behavior.

Relevant code and tests:

- `src/packages/conat/socket/README.md`
- `src/packages/conat/sync/astream.ts`
- `src/packages/conat/sync/core-stream.ts`
- `src/packages/conat/sync/dstream.ts`
- `src/packages/conat/persist/client.ts`
- `src/packages/conat/persist/server.ts`
- `src/packages/conat/persist/storage.ts`
- `src/packages/backend/conat/test/socket/basic.test.ts`
- `src/packages/backend/conat/test/socket/restarts.test.ts`
- `src/packages/backend/conat/test/socket/cluster.test.ts`
- `src/packages/backend/conat/test/sync/astream.test.ts`
- `src/packages/backend/conat/test/sync/dstream.test.ts`
- `src/packages/backend/conat/test/sync/dstream-ephemeral.test.ts`
- `src/packages/backend/conat/test/sync/limits.test.ts`
- `src/packages/backend/conat/test/sync/cluster.test.ts`

## Bottom Line

`dstream` is the right starting primitive for the browser account feed.

We should **not** build a custom replay/ring-buffer protocol on top of raw
 `socket`. The existing stream stack already gives us most of what we need:

- ordered delivery
- reconnect across server restarts
- race-free bootstrap + changefeed attachment
- replay from a sequence number
- bounded in-memory retention
- cluster support

However, one critical browser-facing contract is still missing:

- the client must be able to tell, unambiguously, that its requested
  `since_seq` is older than retained stream history and that it must reload a
  fresh snapshot

Without that, a reconnecting browser can silently miss deltas if old stream
 history has already been trimmed.

So the recommendation is:

1. use a per-account capped in-memory `dstream` on the home bay
2. keep Postgres projections as the source of truth
3. add an explicit retained-history / reset-required signal to the stream API
   used by the browser feed

## What `socket` Already Guarantees

The explicit intent of `socket` is TCP-like semantics over Conat pub/sub:

- `src/packages/conat/socket/README.md` says it guarantees in-order, reliable,
  lossless transmission
- `src/packages/backend/conat/test/socket/basic.test.ts` verifies ordered
  delivery, buffering before the server exists, and queue bounds
- `src/packages/backend/conat/test/socket/restarts.test.ts` verifies reconnect
  after server restart and successful recovery of messages that were dropped at
  exactly the wrong time
- `src/packages/backend/conat/test/socket/cluster.test.ts` verifies socket
  operation across a Conat cluster

So raw `socket` is already much stronger than an ad hoc pub/sub channel.

## What `dstream` / `core-stream` Already Guarantees

### 1. Race-free bootstrap

`CoreStream.init()` does not just "open a feed and hope."

It:

1. creates the persist client
2. opens a changefeed first
3. runs `getAllFromPersist({ changefeed: true, start_seq, ... })`
4. only then starts the ongoing listen loop

That pattern is exactly the correct one for avoiding the classic gap between
 "snapshot fetched" and "realtime subscription established".

### 2. Replay from sequence number

`dstream` and `astream` both support loading only messages at or after a
 particular sequence:

- `start_seq` is supported by `dstream` bootstrap
- `dstream.load({ start_seq })` loads older messages later
- `astream.getAll({ start_seq, end_seq })` is tested directly in
  `src/packages/backend/conat/test/sync/astream.test.ts`
- `dstream` start-seq behavior is tested in both:
  - `src/packages/backend/conat/test/sync/dstream.test.ts`
  - `src/packages/backend/conat/test/sync/dstream-ephemeral.test.ts`

### 3. Recovery from dropped / missing stream updates

`CoreStream.processPersistentSet(...)` detects missing sequence numbers and
 records them. `getAllMissingMessages()` then fetches the missing range and
 inserts it in order.

This is a strong property: even while live streaming, a transient dropped range
 is explicitly detected and backfilled instead of being silently lost.

### 4. Recovery after changefeed failure

If the changefeed ends or throws, `CoreStream.listen()` reconnects and resumes
 with:

- `start_seq: this.lastSeq + 1`

That is exactly the right recovery point for a long-lived browser account feed.

### 5. Cluster support

`src/packages/backend/conat/test/sync/cluster.test.ts` verifies that `dstream`
 state and updates remain consistent across a cluster.

### 6. Memory and retention controls

Retention is already implemented and tested:

- `max_msgs`
- `max_age`
- `max_bytes`
- `discard_policy`
- `max_msg_size`

See `src/packages/backend/conat/test/sync/limits.test.ts`.

This is important because the browser feed should absolutely be capped by age
 and bytes rather than grow forever.

## Important Gaps and Sharp Edges

### Gap 1: no explicit "your requested seq is too old" signal

This is the main issue.

`persist.getAll(...)` ultimately runs a SQL query:

- `SELECT ... FROM messages WHERE seq >= ? ORDER BY seq`

If the caller requests `start_seq = 100`, but the oldest retained message is
 already `140`, the caller simply receives messages starting at `140`.

That means the reconnecting client cannot distinguish:

- "nothing happened since seq 100"

from:

- "messages 100..139 were trimmed and you just missed them"

This is not acceptable for browser correctness by itself.

### Gap 2: `dstream` listens for `reset`, but `CoreStream` does not appear to emit it

`src/packages/conat/sync/dstream.ts` listens for a `reset` event from the
 underlying stream and clears local/saved state when it happens.

But this audit did not find an actual `emit("reset")` path in
 `src/packages/conat/sync/core-stream.ts`.

So we should not build the browser protocol around a `reset` event that does
 not currently appear to be part of the active contract.

### Gap 3: keyed delete / tombstone semantics are not relevant to the browser feed

`core-stream` handles keyed updates and tombstones, which are useful elsewhere,
 but the browser account feed should avoid depending on that complexity.

The home-bay browser feed should be modeled as an **append-only event stream**.
 The feed is for freshness, not as a keyed state store.

## Recommended Architecture

### Source of truth

Keep the current projection tables as authoritative state:

- `account_project_index`
- `account_collaborator_index`
- `account_notification_index`
- later settings/publication state tables

The browser feed is only a delta transport.

### Feed shape

Maintain **one in-memory capped `dstream` per active account** on the user's
 home bay.

Suggested initial naming:

- `accounts/<account_id>/realtime-feed`

Suggested initial retention:

- `ephemeral: true`
- bounded by both age and bytes
- example starting point:
  - `max_age: 15 * 60 * 1000`
  - `max_bytes`: a few MB
  - optionally `max_msgs` too

Exact numbers can be tuned later; the important point is bounded retention with
 deterministic behavior.

### Event envelope

Each feed message should be a small append-only delta:

```ts
type AccountFeedEvent =
  | {
      kind: "notification.upsert";
      account_id: string;
      notification_id: string;
      row: unknown;
    }
  | {
      kind: "notification.remove";
      account_id: string;
      notification_id: string;
    }
  | {
      kind: "notification.counts";
      account_id: string;
      counts: unknown;
    }
  | {
      kind: "project.upsert";
      account_id: string;
      project_id: string;
      row: unknown;
    }
  | {
      kind: "project.remove";
      account_id: string;
      project_id: string;
    }
  | {
      kind: "collaborator.upsert";
      account_id: string;
      collaborator_account_id: string;
      row: unknown;
    }
  | {
      kind: "collaborator.remove";
      account_id: string;
      collaborator_account_id: string;
    };
```

No browser state should depend on mutating stream history.

## Browser Protocol

### Initial page load

1. Browser fetches a snapshot RPC from the home bay.
2. Snapshot response includes:
   - current projected rows / counts
   - feed identity
   - current feed seq
   - feed generation
3. Browser renders the snapshot.
4. Browser attaches to the per-account feed using `start_seq = snapshot.seq + 1`
   and the expected generation.

### Short reconnect

If the browser disconnects briefly:

1. reconnect to the same account feed with `since_seq = last_seen_seq + 1`
2. replay retained deltas
3. continue live

### Long reconnect / server restart / retention expiry

If the server indicates the requested seq is too old, or the feed generation no
 longer matches:

1. browser discards local derived state
2. browser re-fetches the snapshot
3. browser re-subscribes from the new snapshot seq

That is the only safe reset story.

## The Missing Contract We Should Add

To make the above protocol correct, the stream layer needs to surface one of
 the following:

### Preferred option: effective-start / oldest-retained signal

When `getAll(start_seq=X)` is requested, the response should include enough
 information to tell whether the server actually started from `X` or from a
 later retained message.

For example:

- `effective_start_seq`
- or `oldest_retained_seq`

Then the browser logic is:

- if `effective_start_seq > requested_start_seq`, resnapshot

This is the cleanest addition because it directly expresses the needed fact.

### Alternate option: generation + mandatory snapshot on every reconnect

If we do not add an explicit retained-history signal, the safe fallback is:

- on every reconnect, fetch a fresh snapshot first, then reattach to the feed

This is simpler but gives up cheap short-gap replay.

### Not recommended: custom replay layer over raw socket

That would be rebuilding logic that `dstream` already has:

- replay by seq
- reconnect loops
- missing-range recovery
- bounded retention

## Stream Generation

Even with the retained-history signal, the browser feed should also have a
 generation identifier.

Why:

- ephemeral streams can disappear when inactive
- server restart may recreate the stream
- future explicit feed resets may intentionally replace history

So the protocol should include:

- `feed_generation`

The browser should treat a generation mismatch as:

- full resnapshot required

How to store generation:

- simplest is stream metadata attached to the feed
- or a durable home-bay table/record if we want it independent of stream
  lifetime

Either is fine. The important point is that the browser must not assume seqs
 from an old feed generation mean anything in a new one.

## Publish Path

Initial implementation recommendation:

- after a projection update commits on the home bay, publish the corresponding
  feed delta to the account's `dstream`

Why this is acceptable initially:

- the DB projection remains the source of truth
- if the home-bay process crashes, browser sockets will also drop
- reconnect then resnapshots from projections

This keeps the first implementation small.

If later we want stronger "freshness publish must survive local publisher
 interruption" guarantees, we can add a local account-feed outbox and a small
 drainer, but that is not required for the first correct browser cutover.

## Recommended First Use of the Feed

Start with notifications first.

Reasons:

- the current browser implementation is still polling
- notifications already have a greenfield-ish projection-backed inbox model
- switching them to snapshot + feed has the smallest blast radius

Then extend the same feed with:

- project summary deltas
- collaborator summary deltas

Only after that should we retire browser-critical dependence on the legacy
 tracker / changefeed paths.

## Concrete Recommendation

For the home-bay to browser channel, implement:

1. per-account in-memory capped `dstream`
2. append-only account delta events
3. snapshot RPCs from projection tables
4. browser subscribe with `start_seq`
5. explicit retained-history detection
6. feed generation check

Do **not**:

- build a custom replay protocol on top of raw `socket`
- make the stream the source of truth
- rely on the currently-unused `reset` event path

## Immediate Follow-up Work

1. Add an explicit retained-history signal to the Conat stream API used by
   browser feeds.
2. Define the account feed envelope and naming convention.
3. Implement notification snapshot + notification feed subscriber in the
   browser.
4. Remove the temporary 5-second notification polling.
