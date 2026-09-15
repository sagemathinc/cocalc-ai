# Plan: Efficient Transfers When Consumers Are Slow

Date: 2026-09-15

Status: proposed implementation plan, not an activated protocol change.
Source baseline: `origin/main` at `9da816d52d`. Recheck the named integration
points when implementing. This plan does not depend on the
[structured-decoding plan](./structured-decoding-efficiency-plan-2026-09-15.md).

## Objective and Scope

At fixed concurrency, transfer buffering must not grow with total file size or
the duration of a downstream pause. Once bounded downstream capacity is occupied,
upstream reading/generation stops. Cancellation closes the transfer rather than
leaving background production or queues behind.

The first deliverable is the file-transfer path, including HTTP upload adapters
and existing Conat read/write services. Validate the existing terminal approach
as a reference; terminal and general pub/sub changes are not prerequisites for
this deliverable. Report coverage precisely rather than claiming that every
producer in CoCalc has been migrated.

The earlier broad "sane messaging" prototype accumulated about 88,000 added
lines, including tests and documentation. Reuse its lessons about downstream
acknowledgement, cancellation, and bounded windows, not its complete ownership
framework. Existing mainline file-flow, stream-copy, admission, and metering
facilities should do most of the work here.

Out of scope: new messaging/storage formats, general distributed credit
ledgers, resumable uploads, account rehome, durable transfer journals, archive
snapshot ownership, and redesign of destination replacement/permissions or
delete/restore operations. Preserve those existing contracts. Any correctness
dependency exposed by a new cancellation path needs a separate, explicit
decision before that path is activated, not silent scope expansion.

## Existing Components to Reuse

| Source                                                                                                                                                                                       | Role                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [conat/files/read-flow.ts](../packages/conat/files/read-flow.ts) and [read.ts](../packages/conat/files/read.ts)                                                                              | Existing bounded frames, consumption acknowledgements, pacing, and cancellation.     |
| [conat/files/write-stream.ts](../packages/conat/files/write-stream.ts) and [write.ts](../packages/conat/files/write.ts)                                                                      | Destination `drain`/`finish`, completion, and active-writer admission.               |
| [project-host/upload.ts](../packages/project-host/upload.ts)                                                                                                                                 | Direct project-host multipart adapter.                                               |
| [hub/servers/app/upload.ts](../packages/hub/servers/app/upload.ts) and [lite/hub/upload.ts](../packages/lite/hub/upload.ts)                                                                  | Existing alternative HTTP adapters; preserve their deployment boundaries.            |
| [frontend/file-upload.tsx](../packages/frontend/file-upload.tsx)                                                                                                                             | Sequential chunking, browser timeout, URL selection, and completion behavior.        |
| [conat/project/terminal/index.ts](../packages/conat/project/terminal/index.ts), [conat/socket/tcp.ts](../packages/conat/socket/tcp.ts), and [util/throttle.ts](../packages/util/throttle.ts) | Reference implementations for pause/resume, bounded delivery, and output throttling. |
| [conat/admission/limits.ts](../packages/conat/admission/limits.ts) and [core/server.ts](../packages/conat/core/server.ts)                                                                    | Reuse existing admission configuration/diagnostics and traffic measurements.         |

Preserve [control/data-plane routing](./scalable-architecture.md): use the existing
project-host route and explicit client for the owning host/bay. Do not introduce
a new hub proxy to make stream wiring easier. Hub and Lite adapters are existing
compatibility/runtime paths, not a reason to redirect hosted project traffic.

## Minimal Contract

### Bounded Capacity at Each Handoff

For each retained buffer or queue in the selected path, name its owner, byte
limit, item limit, maximum input chunk, and action when full. Include HTTP/parser
buffers, source prefetch, Conat frames, destination writable buffers, and shared
connection queues used by the transfer. Reuse counters where they already exist;
this is a short per-path accounting table, not a new resource-ledger library.

Use `pipeline()` for a complete local stream lifecycle, or a small shared helper
that waits for writable capacity while handling error, close, and cancellation.
Multipart chunks share a longer-lived destination, so ending one HTTP chunk
must not end the whole upload. Avoid unbounded pending promises and arrays of
future writes. A Node `highWaterMark` is a threshold, not an enforced allocation
ceiling; producers must respect it and individual chunks must also be bounded.
See [Node stream buffering](https://nodejs.org/api/stream.html#buffering).

Retain the current Conat file-flow window and pacing for the first patch. Do not
introduce a new multi-frame credit protocol just to connect an HTTP adapter.
Return consumption credit only after downstream bounded capacity is available,
not merely because a router accepted a publication. A duplicate acknowledgement
must not return capacity twice. Byte capacity and any lower transport queue
limit remain authoritative even when a consumer reports immediate progress.

Pausing must reach the actual source: stop reading the HTTP body, stop pulling
the file iterator, or pause a producing pipe. A permanently stalled or closed
destination eventually cancels the operation. For sources that cannot pause,
fail that transfer explicitly rather than accumulating output or silently
discarding file bytes. Do not alter terminal session lifetime as a side effect.

### Admission, Metering, and Progress

Keep admission and bandwidth metering; neither replaces bounded pending bytes.
One admitted operation can still retain a growing backlog at an allowed rate.
Acquire an ingress slot before parsing/retaining an upload body, not only when
the destination writer starts. Reuse or extend the relevant existing limiter
locally, with process-wide and account/project scopes appropriate to the route.
Use identity from the existing authorization result, not multipart claims.

Document a conservative per-transfer memory allowance that includes copies and
both sides of transforms. An aggregate model is:

`active ingress allowance + active transfer allowances + shared queue allowance`.

Do not describe this as an exact RSS cap; native buffers and GC need measured
headroom. Bound queue items as well as bytes, and reject excess admissions rather
than creating an unbounded waiting list. Active operations must not disappear
through ordinary cache eviction. Keep a closing operation charged until its
owned resources actually close, including a writer that opens after cancellation.

Distinguish waiting for initial metadata, inter-request gaps, actual incoming
payload progress, and a blocked destination. Useful partial payload progress
must count before a full Conat frame has accumulated. Do not let repeated
control messages renew a stalled operation indefinitely. Retain compatible
browser/proxy request deadlines; a new idle timer is not an absolute whole-file
deadline. Cancellation must settle waits even when no `drain` event will arrive.

## Resolve HTTP Metadata Ordering First

Before adding waits, establish when the destination path and chunk metadata are
available relative to the multipart file body. A downstream writer cannot wait
for request completion while request completion waits for that writer to drain.
Use one of these two small adapters, not a new upload-session service.

### Preferred: Metadata Before Body

If existing multipart ordering supplies all required metadata before file bytes,
validate it and start the writer immediately. Otherwise, a small browser change
can supply bounded request metadata in headers/query parameters before body
consumption, while preserving the current sequential chunk format. Do not assume
field order without testing it, or acknowledge a request before validating its
metadata. Keep the existing authorization and destination-resolution boundary.

Connect multipart file data to the bounded Conat source immediately. Pause body
consumption when that source is full; do not collect the full request first.
Subsequent requests attach only to the matching live operation. The operation
must serialize chunks and validate identifier, position, expected length, and
completion sufficiently to preserve the ordered byte stream. Out-of-order or
duplicate requests fail explicitly; resumable/idempotent replay is not added.

### Compatibility Alternative: One Capped Request Body

If preserving current browsers is simpler, stage only one bounded HTTP chunk
under ingress admission, finish parsing its metadata, then drain that chunk
through the existing writer. The current browser uses 8,000,000-byte payload
chunks; use an explicit compatible payload cap plus separately bounded multipart
metadata, not a whole-file allowance. Count received bytes regardless of the
advertised length, and include staging/copy overhead in admission.

Prefer bounded RAM for this small compatibility adapter. Disk staging would add
quota, cleanup, and restart responsibilities and needs a separate justification.
Choose between metadata-first and capped staging using the tests below before
implementation expands. A single bounded body must not become a list of all
chunks or a reusable upload-storage system.

For staged requests, distinguish transferring ownership into the bounded Conat
source from final destination consumption. An HTTP chunk may succeed once all
its bytes have been accepted into that bounded pipeline; that does not mean
they are durably saved. Include a partial final Conat frame in the accounting.
Do not wait for a full frame that can only be completed by the next HTTP request,
which would deadlock sequential uploads. Test slow staging against existing
writer/read-flow idle timers; if it requires broad timer changes, use the
metadata-first design instead. Do not compensate with arbitrary timeout increases.

### Completion and Cleanup

Keep one operation object owning its source, in-flight request, writer promise,
timer, and admission release. Reuse an existing owner if suitable; do not build a
generic lifecycle framework. Cancellation is idempotent and propagates in both
directions. Late parser/writer callbacks may finish cleanup but cannot revive a
cancelled operation or mutate a replacement operation's state.

The final HTTP success follows the destination's existing completion contract:
`finish` and any existing commit hook must succeed. A chunk acknowledgement is
not a durable-save acknowledgement, and `drain` is not `fsync`. Preserve the
existing on-disk format and publication behavior; do not claim stronger crash
durability. Failure/disconnect must not introduce new destination data loss.
Test destination contents before and after cancellation rather than assuming
that deleting any partially named file is safe cleanup.

## Delivery Sequence and Size Limit

1. **Baseline and adapter decision.** Draw the buffer/owner table for the actual
   HTTP-to-Conat-to-disk path. Add a real localhost test with a controllable slow
   sink and a producer counter. Choose metadata-first or capped staging, with
   explicit memory, timing, browser-compatibility, and completion semantics.
2. **One bounded adapter.** Implement the minimum shared forwarding/operation
   helper at a package boundary already usable by the adapters. Integrate the
   direct project-host route first, retaining the existing Conat protocol.
   Add ingress admission before retained bytes and cancellation tests together.
3. **Existing alternate routes.** Reuse the helper from hub/Lite adapters without
   broad routing or authorization changes. Verify matching behavior through
   each route, not just the helper. Change the browser only if the selected
   metadata design requires it.
4. **Review and rollout.** Compare normal and delayed-consumer throughput with
   mainline, run the focused package/browser tests, and use the normal staged
   deployment process. Publish the exact scope of the improved path.

Target a small shared helper plus thin adapter edits, roughly 500-1,000 new
production lines before tests. This is a scope checkpoint, not permission to
skip error handling. Return for review if it requires a generic broker rewrite,
new durable state, or several thousand production lines. Both possible metadata
designs need not ship; prefer one implementation and the smallest necessary
compatibility handling.

## Acceptance Tests

Use real HTTP, real Conat on localhost, and native writable streams where
possible. Controlled small thresholds make most cases fast; synthetic sources
can generate a long transfer without retaining it in the test driver.

| Case                                                | Required result                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Sink stops completely                               | Retained-byte counters plateau within the documented allowance; upstream reads stop after bounded prefetch.               |
| Sink repeatedly pauses and resumes                  | Byte-for-byte completion, no loss/duplication, no accumulation across pauses.                                             |
| Transfer gets much longer at fixed concurrency      | Queue/storage ownership remains bounded independently of total size; measure process memory separately.                   |
| Payload arrives slowly in small pieces              | Useful progress is recognized before full frames; supported request deadlines still apply.                                |
| HTTP chunk ends partway through a Conat frame       | Next sequential request can proceed without credit/completion deadlock.                                                   |
| Cancel during parsing, opening, writing, or waiting | Producer stops, waits settle, owned resources close, admission returns exactly once.                                      |
| Late callback or concurrent request                 | A completed/cancelled operation is not revived; a replacement is not cleaned up by an older callback.                     |
| Destination error or final commit failure           | Final response fails; no false completion or new destination-content regression.                                          |
| Capacity exhausted                                  | Extra operations receive a bounded explicit refusal; unrelated admitted operations and control traffic remain responsive. |
| Current browser plus upgraded server                | Documented compatibility behavior, including multipart ordering and slow networks.                                        |

Extend existing `read-flow`, `read-backpressure`, `write-stream`, upload-adapter,
and backend file-transfer suites. Include empty files, Unicode/relative paths,
current maximum HTTP chunk size, useful partial progress, and a final short
chunk. Test a receiver that sends no progress and one that reports progress
immediately; neither changes the server's own queue allowances. No large-scale
load or production probing is needed for these acceptance tests.

Benchmark normal transfers and delayed consumers separately. Proposed target:
no more than 10% median throughput regression against mainline on repeated
representative runs, with absolute throughput and variance reported. Preserve
overlap between existing pacing and downstream waits. Record peak queued bytes,
heap, external memory, RSS, event-loop delay, and cancellation latency. Do not
force GC to make the primary result pass or count unchanged RSS as a leak by
itself. Bounded ownership counters are the deterministic CI assertions.

Install/build fresh worktrees before tests as described in
[AGENTS.md](../../AGENTS.md). Run relevant Conat/backend and adapter package
checks. If the browser changes, run frontend typechecks, focused upload tests,
and `pnpm -C src lint:frontend`, plus any required accessibility coverage.

## Rollout and Explicit Limits

No file-flow wire change is planned. If metadata-before-body changes the browser
request contract, deploy compatible server handling before enabling that browser
path. Test old/new combinations. Unsupported requests must receive an explicit
response; do not silently use an unbounded adapter. Document any browser-refresh
requirement before rollout. Rollback stops new use of the path and drains or
cancels existing operations; it must not report unfinished writes as successful.

Use existing admission/metering diagnostics plus a few bounded aggregate counters
for pending bytes, pauses, and cancellations. Do not log file contents, paths, or
per-chunk records by default. No new metrics platform is required.

Terminal and general pub/sub follow the same principle, but have different loss
and lifetime semantics. A later focused change can enforce byte/item pending
limits and detach a slow subscriber without stopping other subscribers or the
shared PTY. Preserve terminal history/reconnect behavior and do not treat a
client's rendering acknowledgement as a measurement of server queue capacity.
The standard slow-subscriber approach is described in the
[NATS documentation](https://docs.nats.io/learn/resilient-clients/slow-consumers).
Such a follow-up must not silently drop persistence changes or file bytes.

Completion here means the named file-transfer routes demonstrate bounded
buffering, end-to-end pause/resume, explicit completion, and reliable cancellation.
It does not certify every Conat queue or replace admission and bandwidth policy.
