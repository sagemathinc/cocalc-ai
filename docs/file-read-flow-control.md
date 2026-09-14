# Bounded File Reads

## Protocol

All requests must specify `fileReadProtocol: "ack-v1"`. A strict producer rejects
missing/unknown protocols before admission or opening a file, with code
`file-read-protocol-required` and browser-refresh/runtime-update guidance. There
is no requester-selected unbounded fallback. The selected reader
replies with a handshake and a private reply-inbox control channel. Only after
acknowledgement sequence zero does it open the existing authorized stream
factory. It sends at most one 4 MiB data chunk at a time and waits for the matching
sequence acknowledgement before continuing. Duplicate acknowledgements grant no
future credit; invalid future sequences fail the transfer.

The consumer acknowledges after its generator resumes from `yield`. For HTTP
this means after the response write/drain, not when Conat receives a message.
File-copy consumers likewise await destination drain before advancing the source,
and await finish and any atomic-upload commit before reporting success. Pacing
(250 ms per chunk) runs concurrently with publication/ACK, not after it.
Routing remains on the explicitly supplied client. Project, viewer, and share
readers retain their existing sandbox and canonical-path authorization checks.
No filesystem data moves through a new hub proxy or direct filesystem shortcut.

## Bounds and Cancellation

- Data chunks are split to a strict 4 MiB maximum, including larger chunks from
  custom factories. Normal filesystem read-ahead adds at most one 4 MiB chunk.
- A read response queue is limited to 8 MiB encoded payloads and four messages.
  Overflow fails the transfer and discards the queue; it never silently drops
  chunks and claims success. This limit is for retained complete-message queue
  payloads, not an assertion that total RSS is limited to 8 MiB. Serialization,
  transport reassembly, filesystem prefetch, and HTTP buffers also have costs.
- The new sender's single outstanding bounded chunk prevents a file-sized
  transport/reassembly backlog. This is not a new generic defense against
  arbitrary oversized Conat messages from an untrusted peer.
- Project limits (default 4) aggregate across all reader/share names. Principal
  limits (default 8) aggregate across projects and sockets. Process-wide caps of
  64 producers and 64 consumers bound aggregate windows. Override these with
  `COCALC_PROJECT_FILE_READ_MAX_ACTIVE`, `COCALC_FILE_READ_MAX_ACTIVE_PRINCIPAL`,
  and `COCALC_FILE_READ_MAX_ACTIVE_TOTAL`. Denials carry project/principal and
  limit attribution. Consumers that stop iterating must return/close their
  iterator; the HTTP handler does this on cancellation.
- Workspace readers default to that same per-project limit, not a separate
  16-stream allowance. `COCALC_WORKSPACE_FILE_READ_MAX_ACTIVE` can lower it;
  raising workspace concurrency requires raising
  `COCALC_PROJECT_FILE_READ_MAX_ACTIVE` as well. Reader registration passes the
  effective minimum explicitly. Principal and process-wide caps still apply.
- The router stamps the principal from authenticated socket identity. It ignores
  identities supplied by ordinary clients, including forged headers. Trusted
  hub/host HTTP clients forward the account from their verified auth context;
  trusted cluster links preserve the stamp. Missing/unattributed identities
  share one limited bucket. Project-authenticated shells are project principals,
  not assumed to be their owner account. These are isolation bounds, not a
  guarantee against many independently authorized identities exhausting capacity.
- Routers validate transport headers before stamping or delivery: a plain JSON
  record of at most 100,000 serialized UTF-8 bytes. Application headers retain
  their nested JSON contract, including persistence metadata and historical
  editor maps; there is no separate depth or entry-count cap. Validation walks
  one child at a time, iteratively, with work bounded by the byte budget.
  The added principal field counts toward the byte limit.
  A present `CN-Reply` must be a nonempty non-wildcard subject. Malformed headers
  fail publication with code 400, without allocating a stamped copy. File-reader
  error replies are best-effort; their failure cannot end the shared reader
  loop or prevent transfer admission release. Unexpected subscription/task
  failures are observed and logged.
- Response close/error and request abort cancel the transfer, including while
  waiting for HTTP drain, inbox readiness, interest discovery, source reads, or
  acknowledgement. The control channel remains available while source I/O is
  stalled. Cancellation destroys the source and releases its admission slot;
  a stream factory that finishes late is also destroyed.
- Handshake admission expires after at most 5 seconds, independently of a
  caller's long timeout. No file opens before the handshake ACK. After handshake,
  `maxWait` is an idle interval, server-capped at 60 seconds, not a total transfer
  deadline. Valid new ACKs/source progress refresh it; duplicate ACKs do not.
  HTTP/write drain progress refreshes the downstream idle timer as well. Healthy
  reads/downloads can exceed an hour; a sink that cannot drain a chunk within the idle
  interval is disconnected. Every cancellation path releases admission.
- Explicit cancellation discards queued data even if the subscription already
  expired. Graceful EventIterator end continues to allow draining queued events.

These bounds do not cover arbitrary buffering inside a caller-supplied source
factory or a consumer that deliberately collects all yielded chunks. HTTP and
the normal filesystem factory respect streaming backpressure. Queue weights use
binary `byteLength` (including browser ArrayBuffers), are validated as finite and
nonnegative, and are cached until dequeue so mutable inputs cannot corrupt them.

## HTTP Semantics

HEAD and Range retain their existing stat/read behavior and scoped subjects.
Temporary archives are removed only on successful response finish, never on an
interrupted transfer. Partial/error downloads report bytes submitted to HTTP
writes through the existing managed-egress callback; this is not a claim that
the browser acknowledged receipt of every byte. Errors after headers/data begin
destroy the connection instead of appending an error string to the file.

## Compatibility and Rollout

Upgrade every routing Conat server first: producer principal accounting trusts
router-stamped headers and cannot authenticate a header passed through an old
router. Upgrade consumers before enabling strict producers. Old consumers then
fail closed with `file-read-protocol-required`; browser users must refresh, and
project/server consumers must update or restart their runtime. Updated consumers
retain a bounded receive window for old producers during coordinated rollout;
this is not permission for a strict producer to send without ACKs. Update
hub/workspace/Lite, project-host, and project runtime bundles. Host HTTP uses
the new reader and sender together, including account, viewer, and share paths.
Workspace HTTP forwards the verified account, rather than a client-supplied
identity, and Lite forwards its local account identity too.

Persistence replay validates bootstrap headers before unconfirmed publication.
An invalid bootstrap produces a small error-only reply, not successful
completion with missing metadata. Replay remains synchronous while its SQLite
iterator is open. Clients validate sequence continuity including the completion
frame, require config/checkpoints for info replies, and reject incomplete
responses. Unset metadata may still be omitted by legacy servers. Deterministic
400 errors terminate CoreStream bootstrap instead of retrying indefinitely;
failed recovery leaves the existing metadata and checkpoints intact.

Validate on a staging/canary host with a large synthetic file: throttle, cancel,
and retry repeatedly; verify an intact completed download; monitor RSS/external
memory and host responsiveness. Do not reproduce the old unbounded behavior on
a shared production host. Keep the fix private until coordinated deployment.

## Regression Checks

Run focused package builds before tests in a fresh checkout:

```sh
pnpm -C src install
pnpm -C src/packages install
pnpm -C src/packages/conat exec tsc --build
pnpm -C src/packages/backend exec tsc --build
pnpm -C src/packages/project exec tsc --build
pnpm -C src/packages/project-host exec tsc --build
pnpm -C src/packages/server exec tsc --build
pnpm -C src/packages/hub exec tsc --build
pnpm -C src/packages/lite exec tsc --build
pnpm -C src/packages/util exec jest --runInBand event-iterator.test.ts
pnpm -C src/packages/conat exec jest --runInBand files core/abort.test.ts core/message-bytes.test.ts core/message-headers.test.ts persist/client-bootstrap.test.ts sync/core-stream-metadata.test.ts
pnpm -C src/packages/conat exec jest --runInBand core/server.inbound-admission.test.ts core/server.egress.integration.test.ts
pnpm -C src/packages/backend exec jest --runInBand conat/test/files/read.test.ts conat/test/files/write.test.ts conat/test/core/core-stream.test.ts conat/test/core/core-stream-break.test.ts conat/test/core/core-stream-recovery.test.ts
pnpm -C src/packages/backend exec jest --runInBand conat/test/persist conat/test/sync-doc
pnpm -C src/packages/hub exec jest --runInBand proxy/handle-request.test.ts
pnpm -C src/packages/server exec jest --runInBand conat/project/workspace-filesystem.test.ts
```

Real-socket regressions cover 64 MiB, 512 MiB, and 8 GiB stalled reads; HTTP close
during drain; SHA-256 and byte ranges; missing-file errors; empty/truncated
streams; stalled/late stream factories; sender timeout; iterator early return;
aggregate admission and cancellation; and cancellation during routing setup.
Unit and integration tests also cover strict protocol rejection, short abandoned
handshake recovery, idle refresh versus duplicate ACKs, principal spoofing and
cross-project fairness, ArrayBuffer/invalid-weight bounds, and blocked/failing
write destinations including delayed finish/commit.
Header rejection tests use small local fixtures and confirm subsequent reads
remain available. Workspace HTTP coverage checks verified identity across
projects, isolation between accounts, and configured versus effective limits.
Persistence coverage round-trips 129-field metadata, 112 historical editors,
nested JSON, and snapshot checkpoints through local sockets, CoreStream, and
SyncDoc reopen. It also checks byte-limit boundaries, explicit oversized-header
failure, incomplete replay, and preservation of durable metadata/checkpoints.
