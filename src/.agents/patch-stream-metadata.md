# (done) Patch Stream Metadata Plan

## Status

Done on `lite4`.

Implemented:

- patch-stream bootstrap now returns metadata and checkpoints
- sync-doc bootstraps from the patch stream instead of opening `syncstring`
- latest snapshot is tracked as a stream checkpoint
- document metadata is stored in the patch stream
- notebook open no longer pays the old second durable-store startup cost

Validated:

- focused backend/sync tests
- manual notebook open testing
- remote Launchpad measurement showing notebook `sync_ready` around `375ms`

`syncstring` is no longer on the document-open critical path for the Conat
path targeted by this plan.

## Goal

Eliminate `syncstring` from the document-open critical path by making the patch
stream itself the canonical durable document store, with generic stream
metadata/bootstrap support built into persist/core-stream.

This is not a Jupyter-specific optimization. The design should be a generic
Conat stream feature that Patchflow-based realtime sync uses as one
application.

## Motivation

The current architecture splits durable document state across:

- the patch stream
- `syncstring` metadata
- ad hoc bootstrap attempts layered on top

That creates:

- two cold persistent objects during open
- multiple sources of truth
- awkward sequencing to get `last_snapshot`, `last_seq`, and `users`
- difficulty making `sync_ready` fast without preload caches or fallback hacks

The right fix is not another DKV. The right fix is to make the patch stream
carry its own stream-level metadata and bootstrap state.

## Desired End State

Opening a patchflow-backed document should require exactly one durable stream
bootstrap:

1. open the patch stream
2. receive:
   - patch messages
   - stream config
   - stream metadata
   - stream checkpoints
3. initialize Patchflow from that data
4. no `syncstring` open at all

The stream remains a generic primitive. Conat should not know what a notebook,
user list, or snapshot means.

## Generic Data Model

Model a persistent stream as:

```ts
interface StreamBootstrap<
  TMessage = unknown,
  TMetadata = JSONValue,
  TCheckpointData = JSONValue,
> {
  messages: TMessage[];
  config?: Configuration;
  metadata?: TMetadata;
  checkpoints?: Record<
    string,
    {
      seq: number;
      time: number;
      data?: TCheckpointData;
    }
  >;
}
```

Meaning:

- `messages`: the append-only stream itself
- `config`: existing persist/core-stream config
- `metadata`: opaque, application-defined stream metadata
- `checkpoints`: named references to specific stream messages

Conat/persist interpret none of the application semantics of `metadata` or
`checkpoints.data`.

## Why Checkpoints

`last_seq` is not really special. It is the sequence number of some important
message in the stream.

A generic checkpoint system expresses that naturally:

```ts
checkpoints.latest_snapshot = {
  seq: 2407,
  time: 1773895917635,
  data: { patchId: "..." },
};
```

Then:

- `last_seq` becomes `checkpoints.latest_snapshot.seq`
- `last_snapshot` becomes `checkpoints.latest_snapshot.data.patchId`

This is generic and useful outside Patchflow:

- latest durable snapshot
- last fully indexed event
- most recent export marker
- consumer/application checkpoints

## What Patchflow Stores There

Patchflow/sync-doc would use the generic structure like this:

### Metadata

```ts
interface PatchDocMetadataV1 {
  version: 1;
  users?: string[];
  snapshot_interval?: number;
  doctype?: DocType;
  settings?: JSONValue;
  read_only?: boolean;
  save?: boolean;
}
```

### Checkpoints

```ts
{
  latest_snapshot: {
    seq: number;
    time: number;
    data: {
      patchId: PatchId;
    }
  }
}
```

So Conat only knows about:

- metadata blob
- named checkpoints

Patchflow alone interprets:

- `users`
- `snapshot_interval`
- `latest_snapshot`

## What Does Not Belong Here

Do not put these in persistent stream metadata in phase 1:

- cursor presence
- active sessions
- transient `last_active`
- backend-fs watch state

Those are not part of durable document bootstrap.

## Storage Design

Implement metadata/checkpoints in the same SQLite backing store and same persist
scope as the messages.

Do not represent metadata/checkpoints as fake stream messages.

Recommended structure inside persist storage:

- existing message rows remain unchanged
- add a stream metadata row/table
- add a stream checkpoints row/table

Examples:

```sql
stream_metadata(
  metadata_json TEXT,
  revision INTEGER
)

stream_checkpoints(
  name TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  time INTEGER NOT NULL,
  data_json TEXT
)
```

Exact schema can vary, but the key property is:

- updates to messages, metadata, and checkpoints can happen in one SQL
  transaction

## Persist API Additions

The persist layer should grow generic APIs for:

### Bootstrap

Extend `getAll` / bootstrap to optionally include metadata and checkpoints:

```ts
getAll({
  start_seq?,
  end_seq?,
  changefeed?,
  includeConfig?,
  includeMetadata?,
  includeCheckpoints?,
})
```

### Metadata

Generic metadata access:

```ts
getMetadata();
setMetadata(metadata);
patchMetadata(delta);
```

### Checkpoints

Generic checkpoint access:

```ts
getCheckpoints()
setCheckpoint(name, { seq, time, data? })
deleteCheckpoint(name)
```

## Atomic Write Requirement

The crucial requirement is atomicity for writes like snapshot creation.

When a snapshot patch is written, we want to update:

- the message row
- the `latest_snapshot` checkpoint

in one transaction.

There are two viable generic ways to do this.

### Option A: Checkpoint Attached to `set`

Allow a generic message write to also declare a checkpoint update:

```ts
set({
  messageData,
  checkpoint: {
    name: "latest_snapshot",
    data: { patchId: "..." },
  },
});
```

The server:

1. inserts the message
2. gets the assigned `seq`
3. updates the named checkpoint with that `seq`
4. commits once

This is simple and generic.

### Option B: Generic Batch/Apply API

Introduce a more powerful transactional API:

```ts
apply({
  set?: [...],
  delete?: [...],
  metadataPatch?: ...,
  checkpointUpdates?: [...],
})
```

This is more flexible, but more work. It may be worth doing eventually, though
it is more than the minimum needed to replace `syncstring`.

### Recommendation

For phase 1, use Option A:

- extend `set` / `setMany` with optional checkpoint update support
- add separate metadata APIs

That keeps the surface small.

USER: yes, definitely option A.

## Changefeed Behavior

If metadata/checkpoints become authoritative, clients must be able to observe
updates after bootstrap as well.

There should eventually be generic changefeed event kinds:

```ts
type StreamEvent =
  | { kind: "messages"; updates: ChangefeedEvent }
  | { kind: "metadata"; metadata: JSONValue; revision: number }
  | {
      kind: "checkpoints";
      checkpoints: Record<string, Checkpoint>;
      revision: number;
    };
```

Phase 1 can start with bootstrap-only support if we keep usage narrow, but
longer term authoritative metadata requires live updates too.

USER: yes, we will definitely need this, and we also need to be sure that updates aren't missed.  We must always assume messages sometimes get dropped.

## File-by-File Plan

### Persist Storage

Files:

- `src/packages/conat/persist/storage.ts`
- backend storage implementation files under `src/packages/backend/conat/persist/`

Changes:

- add persistent storage support for stream metadata
- add persistent storage support for named checkpoints
- support atomic update of message write + checkpoint set

### Persist Server

File:

- `src/packages/conat/persist/server.ts`

Changes:

- extend `getAll` request flags:
  - `includeMetadata`
  - `includeCheckpoints`
- include metadata/checkpoints in the first bootstrap response headers/chunk
- add generic request handlers:
  - `metadata`
  - `checkpoints`
- extend `set` / `setMany` to accept checkpoint update directives

### Persist Client

File:

- `src/packages/conat/persist/client.ts`

Changes:

- extend `GetAllOpts`
- extend `getAllWithInfo()` to return:

```ts
{
  messages,
  config?,
  metadata?,
  checkpoints?,
}
```

- add generic metadata/checkpoint client methods

### Core Stream

File:

- `src/packages/conat/sync/core-stream.ts`

Changes:

- bootstrap should optionally receive/store metadata/checkpoints
- expose generic getters for metadata/checkpoints
- expose generic methods to update metadata/checkpoints
- keep the abstraction generic; do not mention Patchflow-specific fields

### DStream / DKV

Files:

- `src/packages/conat/sync/dstream.ts`
- `src/packages/conat/sync/dkv.ts`

Changes:

- expose generic stream metadata/checkpoint access where useful
- no application-specific logic here

It is acceptable if only DStream uses checkpoints in phase 1.

USER: I also don't know of any reason to need any of this metadata for dkv.

### SyncDoc / Patchflow Application Layer

File:

- `src/packages/sync/editor/generic/sync-doc.ts`

Changes:

- stop loading `syncstring` first
- bootstrap from patch stream metadata/checkpoints
- use:
  - `metadata.users`
  - `metadata.snapshot_interval`
  - `metadata.doctype`
  - `metadata.settings`
  - `checkpoints.latest_snapshot`
- initialize Patchflow session from that
- write metadata/checkpoints through the patch stream only

### Jupyter Frontend

Files:

- `src/packages/frontend/jupyter/...`
- `src/packages/frontend/frame-editors/jupyter-editor/...`

Changes:

- no architectural changes required beyond consuming the faster sync-doc path
- keep current open-phase instrumentation so we can measure impact

## SyncDoc Migration Plan

### Phase 1: Dual Write, Prefer Old Read

- add patch-stream metadata/checkpoints
- keep `syncstring` as source of truth
- on snapshot creation:
  - write snapshot patch
  - set `latest_snapshot` checkpoint
- mirror `users` / `snapshot_interval` / `settings` into patch metadata

Goal:

- prove storage/API work
- validate atomic checkpoint behavior

### Phase 2: Prefer Patch Read, Fallback to Syncstring

On open:

- read patch metadata/checkpoints first
- if present, use them
- if missing, read `syncstring`
- backfill patch metadata/checkpoints from `syncstring`

Goal:

- remove `syncstring` from most opens
- retain safety during migration

### Phase 3: Remove Syncstring from Open Path

- open uses only patch stream bootstrap
- `syncstring` no longer required for startup

### Phase 4: Delete Syncstring Entirely

Since this environment is greenfield and data is disposable, we can likely
collapse phases 2-4 aggressively:

- stop writing `syncstring`
- migrate sync-doc to patch metadata/checkpoints directly
- delete syncstring code after validation

This is the preferred end state.

USER: strongly agreed. 

## Minimum Vertical Slice

The smallest slice that proves the architecture:

1. add generic checkpoint support to persist/core-stream
2. add generic metadata bootstrap support to persist/core-stream
3. store only:
   - `metadata.users`
   - `checkpoints.latest_snapshot`
4. teach `sync-doc` to open from those only
5. bypass `syncstring` entirely in this greenfield branch

Why this slice:

- `users` is needed for Patchflow `userId`
- `latest_snapshot.seq` replaces `last_seq`
- `latest_snapshot.data.patchId` replaces `last_snapshot`

Everything else can be added later.

## Suggested Type Shapes

### Generic Persist Client Return

```ts
interface GetAllInfo<TMeta = JSONValue, TCheckpointData = JSONValue> {
  messages: StoredMessage[];
  config?: Configuration;
  metadata?: TMeta;
  checkpoints?: Record<
    string,
    {
      seq: number;
      time: number;
      data?: TCheckpointData;
    }
  >;
}
```

### Patchflow Application Metadata

```ts
interface PatchDocMetadataV1 {
  version: 1;
  users: string[];
  snapshot_interval?: number;
  settings?: JSONValue;
  doctype?: DocType;
}
```

### Patchflow Application Checkpoint

```ts
interface LatestSnapshotCheckpoint {
  patchId: PatchId;
}
```

## Validation Plan

### Unit / Integration

- persist storage tests:
  - metadata save/load
  - checkpoint save/load
  - atomic message+checkpoint write
- persist client/server tests:
  - bootstrap includes metadata/checkpoints
  - changefeed metadata/checkpoint events if implemented
- sync-doc tests:
  - open without `syncstring`
  - snapshot write updates checkpoint
  - users mapping available before Patchflow session init

### End-to-End

Measure before/after with existing browser instrumentation:

- `first_cell_visible`
- `sync_ready`
- `watch_stream_opened`

Success criteria:

- no second durable store on critical open path
- `patches_corestream.init_start` begins immediately
- `sync_ready` approaches the patch-stream bootstrap time only

## Risks

- metadata live updates need to be designed cleanly if `syncstring` is removed
- migration must keep Patchflow `userId` stable and deterministic
- atomic checkpoint updates need careful storage/server implementation
- if metadata/checkpoints are too generic to update atomically, the API may need
  a small transactional extension

## Recommendation

Do this.

This is the correct architectural fix, it is cleaner than the bootstrap DKV
approach, and it aligns Conat with what the underlying implementation can do
well: one persistent stream with efficient bootstrap over SQLite and pub/sub.