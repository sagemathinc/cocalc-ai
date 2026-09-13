# Bounded File Reads

## Protocol

New `readFile` clients request `fileReadProtocol: "ack-v1"`. The selected reader
replies with a handshake and a private reply-inbox control channel. Only after
acknowledgement sequence zero does it open the existing authorized stream
factory. It sends at most one 4 MiB data chunk at a time and waits for the matching
sequence acknowledgement before continuing. Duplicate acknowledgements grant no
future credit; invalid future sequences fail the transfer.

The consumer acknowledges after its generator resumes from `yield`. For HTTP
this means after the response write/drain, not when Conat receives a message.
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
- The existing per-reader admission limit remains 16 by default. Process-wide
  caps of 64 producers and 64 consumers bound aggregate windows across projects,
  remote hosts, and read-only identities. `COCALC_FILE_READ_MAX_ACTIVE_TOTAL`
  overrides both caps. Consumers that stop iterating must return/close their
  iterator; the HTTP handler does this on cancellation.
- Response close/error and request abort cancel the transfer, including while
  waiting for HTTP drain, inbox readiness, interest discovery, source reads, or
  acknowledgement. The control channel remains available while source I/O is
  stalled. Cancellation destroys the source and releases its admission slot;
  a stream factory that finishes late is also destroyed.
- An absent/disconnected peer is bounded by the requested transfer deadline,
  capped at one hour on the sender. No file is opened before the handshake ACK.
- Explicit cancellation discards queued data even if the subscription already
  expired. Graceful EventIterator end continues to allow draining queued events.

These bounds do not cover arbitrary buffering inside a caller-supplied source
factory or a consumer that deliberately collects all yielded chunks. HTTP and
the normal filesystem factory respect streaming backpressure.

## HTTP Semantics

HEAD and Range retain their existing stat/read behavior and scoped subjects.
Temporary archives are removed only on successful response finish, never on an
interrupted transfer. Partial/error downloads report bytes submitted to HTTP
writes through the existing managed-egress callback; this is not a claim that
the browser acknowledged receipt of every byte. Errors after headers/data begin
destroy the connection instead of appending an error string to the file.

## Compatibility and Rollout

The server understands both the old push protocol and the new ACK protocol.
Updated readers can consume an old producer only while it stays within the
bounded receive window; a slow legacy transfer may now fail explicitly rather
than accumulate memory. Old readers cannot be given new receiver-side safety
without being upgraded. Deploy the updated hub/workspace/Lite consumers and
project-host bundles together; upgrade project runtimes used for other routed
reads/writes. Host HTTP downloads use the updated reader and sender in the same
bundle, including account, viewer, and share paths.

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
pnpm -C src/packages/util exec jest --runInBand event-iterator.test.ts
pnpm -C src/packages/conat exec jest --runInBand files core/abort.test.ts
pnpm -C src/packages/backend exec jest --runInBand conat/test/files/read.test.ts conat/test/files/write.test.ts conat/test/core/core-stream.test.ts conat/test/core/core-stream-break.test.ts conat/test/core/core-stream-recovery.test.ts
```

Real-socket regressions cover 64 MiB, 512 MiB, and 8 GiB stalled reads; HTTP close
during drain; SHA-256 and byte ranges; missing-file errors; empty/truncated
streams; stalled/late stream factories; sender timeout; iterator early return;
aggregate admission and cancellation; and cancellation during routing setup.
Unit tests cover duplicate/invalid acknowledgements, bounded legacy fallback,
queue overflow, and cancellation without retaining buffers/listeners.
