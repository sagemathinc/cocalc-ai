# Plan: Predictable Memory Use When Decoding Structured Messages

Date: 2026-09-15

Status: proposed implementation plan, not an activated limit or a completed fix.
Source baseline: `origin/main` at `9da816d52d`. Recheck the named integration
points when implementing. This plan is independent of the
[slow-consumer plan](./slow-consumer-efficiency-plan-2026-09-15.md).

## Objective and Scope

Keep the memory and synchronous work needed to decode one structured message
predictable. A compact representation can describe many more JavaScript values
than its byte length suggests. Account for that structure before constructing
the result, while continuing to support large, comparatively simple byte data.

Deliver one bounded-decoding boundary for Conat's MessagePack and JSON payloads,
with compatibility tests and explicit errors. Do not redesign the wire format,
storage format, broker, or application data model.

The earlier broad "sane messaging" prototype accumulated about 88,000 added
lines, including tests and documentation. Its useful lesson here is much
smaller: count structure before materializing it, and preserve existing behavior
on success and failure. Reuse only independently reviewed scanner/budget logic
and relevant synthetic tests. The prototype is not an implementation dependency
or a prerequisite for this plan.

Out of scope: encoding-side allocations, transport fragmentation and queue
ownership, parser envelopes outside this codec, compression expansion,
cross-request fairness, chunked persistence, worker execution services, account
migrations, and filesystem publication. Those may deserve separate work; they
must not become implicit requirements for this change.

## Implementation Boundary

Start with this finite source inventory. Record each path's decoder, error
consumer, and applicable local policy in the implementation PR.

| Source                                                                                                                | Responsibility in this change                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [core/codec.ts](../packages/conat/core/codec.ts)                                                                      | Common MessagePack/JSON decode entry point and policy defaults.                                     |
| [core/client.ts](../packages/conat/core/client.ts)                                                                    | `Message.data`, raw/ordinary RPC payloads, responses, and diagnostic decode calls.                  |
| [service/typed.ts](../packages/conat/service/typed.ts)                                                                | Consistent behavior for typed-service fast and ordinary payload paths.                              |
| [sync/core-stream.ts](../packages/conat/sync/core-stream.ts) and [sync/astream.ts](../packages/conat/sync/astream.ts) | Explicit materialization failures without changing persisted state.                                 |
| [core/message-headers.ts](../packages/conat/core/message-headers.ts)                                                  | Preserve the separate existing metadata contract; do not substitute a tiny control-message profile. |

Search direct imports of the codec and MessagePack decoder to verify this list.
Already-parsed Socket.IO envelopes are not retroactively bounded by this work;
list them as outside the claimed coverage rather than rewriting that parser.
Likewise, storing or forwarding opaque record bytes is not object decoding.

## Design

### A Per-Decode Budget

Use a small immutable configuration object with finite, checked integer values.
Count these dimensions cumulatively over the entire value, not independently
for each nested array or map:

| Dimension          | Required accounting                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Values             | Every scalar and container, including empty containers.                                         |
| Collection entries | Array elements and both map keys and values; account for declared lengths before allocation.    |
| Nesting            | An explicit, bounded stack, not recursion proportional to input depth.                          |
| Strings            | Total string/key bytes, with conservative allowance for decoded string storage.                 |
| Binary data        | Total binary/extension bytes, separately from object counts.                                    |
| Work               | Structural visits and necessary byte scanning, including JSON whitespace, numbers, and escapes. |

An estimated allocation total may combine those counts with conservative
weights. It is a policy estimate, not an exact V8 heap or process-RSS limit.
Keep hard count limits even if an allocation estimate is provided. A simple
expansion-ratio limit is not a substitute for aggregate limits.

Use one reviewed default policy initially. Add a small number of named local
profiles only where the compatibility corpus demonstrates a real difference.
Service owners select profiles in code/configuration, not incoming message
fields. Do not add a general policy registry, negotiation protocol, or "unlimited"
fallback. Any larger profile must still have finite, measured limits.

Large binary fields need an appropriate byte allowance, not permission for more
object construction. Reuse existing application byte limits where applicable;
distinguish payload bytes from envelope overhead. This plan adds no universal
logical-message or persistence-record size limit.

### Preferred Implementation: Preflight and Existing Decoder

Keep the existing synchronous codec API and successful return-value semantics.
Immediately before decoding:

1. Normalize the byte view without copying it unnecessarily.
2. Scan its encoded structure with bounded state, checked arithmetic, and the
   selected budget. Stop at the first exceeded budget or invalid structure.
3. Decode the same bytes with the existing library only after successful scan.
4. Return the existing value type, or throw a recognizable decode-limit error.

The MessagePack scan reads type/length information and skips scalar bodies by
validated length where possible. It must not construct the proposed arrays,
objects, strings, or a list of all tokens. For JSON, scan bytes before creating
the complete decoded string and before `JSON.parse`.

Validate and decode a stable byte view in the same synchronous operation.
Explicitly handle shared-memory input; do not validate bytes that another worker
can change before decoding. Do not introduce an asynchronous `.data` API or a
cache keyed only by mutable buffer identity.

Preserve the installed decoder's accepted-value semantics: number edge cases,
dates/timestamps, map keys, extensions, UTF-8 handling, JSON escapes, typed-array
views, and extra/truncated input handling. Existing encoder options, especially
`ignoreUndefined`, do not change. Extension handlers must have bounded behavior
under the same budget; retain current raw handling for uninterpreted extensions.

The existing prototype's scanners and shared helpers are roughly 500 lines,
before tests and integration. Extract the relevant subset instead of importing
resource ledgers, storage adapters, or a new transport API with it.

### When to Patch or Fork MessagePack

The library already exposes individual array/map/string/binary length limits,
but those options do not express a whole-message aggregate budget. Use compatible
individual limits as additional checks, not as the entire solution. See the
[upstream decoder options](https://github.com/msgpack/msgpack-javascript#decoderoptions).

Prefer a focused dependency patch, upstream contribution, or maintained fork if
preflight cannot preserve semantics, enforce the desired allocation boundaries,
or meet the measured overhead target. An integrated decoder can debit the same
budget before each allocation and avoid a second structural pass.

Choose one MessagePack implementation after a short comparison; do not maintain
two production paths. A patch/fork must pin its upstream baseline, preserve the
wire format and current exports/options, run upstream and CoCalc compatibility
tests, and document the update procedure. Keep dependency versions aligned.
Audit all construction paths, including extension callbacks and decoder reset
between messages. JSON still needs its own pre-allocation check; a MessagePack
fork does not cover it.

## Compatibility and Failure Contract

An over-budget result is neither an empty document nor a missing record. Give it
a stable error identity and a bounded diagnostic containing the policy and
dimension, not message contents. Error conversion must survive ordinary and
fast RPC paths. A failed message must not terminate a shared subscription loop.

For persistence consumers, leave records, editor maps, checkpoints, and sync
state unchanged. Do not retry a deterministic decode-limit error indefinitely.
Do not cache it as successful absence or acknowledge application processing that
never happened. Raw record storage/export remains possible without decoding its
body. This does not promise that every stored value fits an ordinary JS object
in every process.

The unavoidable product decision is which structured values can be materialized
in shared processes. If an existing supported value cannot fit a useful budget,
stop activation for that path and present the concrete compatibility decision.
Do not silently relax the limit, fail over to unrestricted decoding, or start a
worker/persistence migration within this PR.

## Work Sequence

1. **Corpus and policy.** Use existing synthetic tests plus representative RPC,
   notebook/chat state, collaborative metadata, portability manifests, and
   large binary-bearing values. Include ordinary nested collections and many
   small containers. Record expected results and existing application limits.
   Measure baseline heap/external memory, decode time, and input sizes in an
   isolated local benchmark. No production document sampling is required.
2. **Codec unit.** Extract the scanner/budget subset, add differential and
   boundary tests, and choose preflight versus an integrated MessagePack patch.
   Record actual policy constants and measured headroom in the PR before any
   enforcement is activated; choosing a number is part of this step, not an
   indefinite future calibration project.
3. **Narrow integration.** Wire the common decode boundary and the necessary
   call-site error handling. Keep both encodings and all named decode paths
   consistent. Do not tighten unrelated header policies or change storage.
4. **Review and enable.** Run package checks and the real localhost Conat tests,
   review compatibility/performance, then use the normal staged deployment
   process. A codec-only change needs no new wire-version handshake. Test
   old/new peers and clearly distinguish which receivers enforce the policy.

Aim for one small implementation PR, optionally separating the pure codec unit
from call-site integration. Roughly 500-1,000 new production lines is a planning
target, not a correctness shortcut. If this needs several thousand lines or a
new cross-package framework, stop and explain why before expanding it.

## Validation and Completion

Use small fixtures with small test budgets to exercise refusal; routine CI does
not need very large allocations. For values admitted by the policy, compare
results and relevant error behavior against the unchanged decoder.

- Cover exact-limit and one-over-limit cases for every budget; resetting the
  decoder must reset all per-message counters.
- Cover nested aggregate accounting, empty values, many strings/keys, binary
  views with nonzero offsets, timestamps/extensions, and JSON grammar/UTF-8.
- Show that refusal occurs before result materialization and leaves subsequent
  valid requests working. Do not treat a synchronous timer as preemption.
- Run real request/response tests through ordinary and typed-service paths for
  both encodings. Assert stable errors rather than timeout or fallback.
- Extend [persistence compatibility coverage](../packages/backend/conat/test/persist/header-compatibility.test.ts):
  supported metadata still reopens; deliberately lower local test budgets to
  verify that refusal leaves durable metadata and checkpoints unchanged.
- Preserve existing large binary-bearing application tests and raw persistence
  round trips. No newly imposed record-size ceiling is acceptable.
- Benchmark the common corpus and the largest admitted structured shapes.
  Proposed comparison target: no more than 10% median throughput regression on
  repeated representative runs; report absolute times for tiny operations and
  p95/worst admitted decode pauses as well. Agree a shared-loop pause budget
  before activation. Large scalar decoding can still be synchronous and costly.
- Report heap, external memory, and RSS separately. A finite per-decode budget
  is not a claim about concurrent retained objects, GC timing, or total RSS.

In a fresh worktree, install dependencies and build referenced packages before
running tests, following [AGENTS.md](../../AGENTS.md). Run Conat's focused codec
tests, the affected backend integration suites, touched-package typechecks,
formatting, and dependency checks if the MessagePack dependency changes.

Completion means the named decode paths enforce the chosen policy, supported
values remain compatible, refusal is explicit and non-mutating, and performance
results pass review. It does not mean all messaging resource problems are solved.
