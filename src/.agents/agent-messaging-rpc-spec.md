# Agent Messaging As RPC

Date: 2026-09-12.

Status: adopted RPC foundation contract; updated 2026-09-13 after implementation
and live experiments. The chosen architecture, validation, rollout requirements,
and remaining limitations are recorded in
[implementation progress](agent-messaging-rpc-progress.md). This is a foundation,
not a claim of production readiness or guaranteed execution.

## 1. The Simple Idea

> A human connects agent A to agent B. A can call "send message to B".
> If B's execution service accepts the call, it wakes B or queues the message
> behind B's current turn. The call may fail or have an unknown outcome.
> A can inspect available acceptance evidence and decide whether to try again.

This is a permissioned RPC into an existing agent execution system, not a
reliable message-delivery product. Neither transport delivery nor task completion
is guaranteed. Do not describe it as exactly-once or at-least-once delivery.

Automatic idle wake-up is essential. Eventual delivery to an unavailable project
is not. Duplicate work following retries is an acknowledged possibility, not a
failure that the transport must eliminate at arbitrary cost.

## 2. What We Keep

- Stable, copyable thread URLs and registered agent identities independent of
  a particular model session or turn.
- Authenticated sender attribution assigned by trusted infrastructure, never
  by fields in message text. A credential proves its principal, not authorship
  by a particular model. Agents sharing a Unix UID are not isolated principals
  against one another's credential theft; use distinct sandboxes for isolation.
- Human-approved, directional, revocable, optionally expiring links. Knowing a
  URL, agent ID, or link ID conveys no authority. A-to-B does not imply B-to-A.
- Send-only scope to an exact target. No target files, transcript access,
  general project RPC, grant creation, or account-wide credentials.
- Ordinary sends do not steer a busy agent. Guidance needs a separate link
  permission and an explicit send option.
- The target's approved execution account and existing ACP policy/approval
  gates. Sending must not answer a pending human approval or expand tool rights.
- Compact human controls, private drafts, destination discovery, and explicit
  correlated replies. Artifacts can display links; they do not hold authority.

Initial human approval retains V1's policy: the target registrant approves and
has collaborator access to both projects. Default link TTL is 24 hours,
maximum 30 days, guidance off. More flexible invitations are not required here.

## 3. What We Stop Promising

There is no new durable source outbox, store-and-forward worker, destination
messaging backlog, automatic transport replay, or permanent receipt ledger
required by this contract. There is no global/per-source forever-deduplicated
request namespace and no promise to recover a partially submitted message.

This does not make everything ephemeral. Identities and grants need protected
persistence. The existing ACP job queue and chat retain their existing storage
semantics. We should reuse them, not duplicate them with another queue.

Distinguish the two queues:

- **Existing execution queue:** B accepted the work and is busy. Normal ACP
  scheduling runs it later, independently of A or any browser.
- **Removed messaging queue:** B could not accept the call, so another service
  stores it and repeatedly tries to deliver it. We do not build this.

## 4. Submission And Outcomes

The operation validates the exact target, sender, link, current placement, size,
and execution eligibility, then makes one bounded submission attempt through
the target's existing execution API. A socket acknowledgment or saved chat row
alone is not execution acceptance.

| Outcome    | Meaning                                                                                        | Caller action                                                         |
| ---------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `accepted` | The target execution API positively acknowledged admission to its queue or guidance mechanism. | Do not resend merely because no answer has appeared.                  |
| `rejected` | This attempt definitively did not reach execution admission.                                   | Inspect the reason; an explicit new attempt may be appropriate.       |
| `unknown`  | Acceptance cannot be established or ruled out.                                                 | Inspect available evidence; retry only accepting duplicate-work risk. |

`accepted` is not "the model read it", "running", "completed", or a durability
guarantee beyond the existing execution system's contract. Include a verified
operation reference/disposition when available. Never infer one from a chat row.

Timeout, disconnection, process death, or lost acknowledgment after submission
may have begun means `unknown`, not `rejected`. The CLI synthesizes that outcome
when no authoritative response arrives. A known connection failure before any
submission may be reported as rejection; uncertain intermediaries must not guess.

Saving chat and submitting work may remain separate operations. If chat was
saved but execution was definitively not submitted, rejection should explicitly
report that partial effect. It does not mean "nothing changed". If that boundary
cannot be established, report unknown. Do not replay or delete a chat row to
make the outcome look cleaner. Preserve the reader's position and private drafts.

## 5. Attempts, Inspection, And Retrying

Each explicit send has a caller-generated UUID `attempt_id`, emitted before
network submission and retained in the local CLI result. The key for inspection
is authenticated source, exact target, and attempt ID. It is correlation, not
an exactly-once guarantee. A deliberate new submission uses a new attempt ID.
Application correlation, such as "review request 123", can remain in JSON text.

Provide a read-only `inspectAttempt(target, attempt_id)` operation. It returns
positive acceptance/rejection evidence when available, otherwise `unknown`, with
an observation time. It never starts or retries work. Evidence can be a bounded
attempt cache or an association on existing execution records; architecture will
choose the mechanism. No comprehensive history or recovery worker is required.

Missing, expired, restored-away, or temporarily unavailable evidence is unknown,
not proof of rejection. Inspection must not return a remembered pre-admission
phase as proof that admission never subsequently occurred. If evidence disappears
after a previously observed acceptance, that does not undo the acceptance.

This explicitly weakens "find out if it was accepted" to "query the evidence we
still have". Always answering after arbitrary crashes would recreate a durable
receipt protocol. We are not promising that.

While an implementation retains attempt evidence, it should coalesce identical
in-flight calls and return known outcomes; conflicting reuse should be rejected.
This is bounded duplicate suppression, not a system-wide delivery guarantee.
Never automatically replay a mutating RPC on reconnect or timeout, including in
generic Conat/CLI wrappers. Retry of read-only inspection is safe.

If A retries an unknown attempt, B may receive both submissions. Surface this
warning in human tools and runtime guidance. Include attempt identity in trusted
message metadata to help humans and agents understand duplicates. Any workflow
needing duplicate-safe external effects must enforce that at its own boundary;
an LLM recognizing repeated prose is not a sufficient safeguard.

## 6. Wake-Up, Busy Agents, And Availability

| Target condition             | Ordinary call                                                         | Explicit, permitted guidance                                                    |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Eligible and idle            | Submit a normal turn, waking the agent.                               | Submit a normal turn.                                                           |
| Running a turn               | Use the existing normal queue; do not interrupt.                      | Use the existing steer-or-queue operation and report its actual acknowledgment. |
| Waiting for human approval   | Preserve the existing gate.                                           | Do not bypass or answer the gate.                                               |
| Host/project unavailable     | Fail within the bounded RPC deadline; no background delivery promise. | Same.                                                                           |
| Invalid/revoked/expired link | Reject before admission.                                              | Same, also checking guidance scope.                                             |
| Overloaded                   | Reject before admission with safe retry advice if available.          | Same.                                                                           |

Waking an idle agent is distinct from starting a stopped project. The implemented
foundation also permits bounded automatic project startup through existing
runtime admission: Automatic starts must allow it, the runtime sponsor must have
capacity, and the assigned host must be available. Attribute the start to the
verified target execution account, not the sender. Never stop another project
to make room or automatically provision/power on a host.

Startup consumes the same request deadline. An expired wait can leave a lifecycle
operation still finishing, but must not leave a continuation that later delivers
this message. Recheck authority and deadline after startup before admission.
Inspection never starts a project. A subsequent explicit send is a new attempt.

Reuse ACP ordering; do not introduce global ordering across senders, hosts, or
retries. Admission order may differ from send order. Guidance is steering, not
hard cancellation. Never fall back from an ambiguous guidance result to a new
ordinary turn; that can duplicate a successfully delivered steer.

Bound payload size (initially 32 KiB UTF-8 text), in-flight concurrency, request
duration, and per-principal admission rate. A failed destination must not block
unrelated destinations. No indefinite waits or unbounded automatic retry loops.

## 7. Authorization And Revocation Boundary

Authentication, link management, routing, and execution submission are separate
interfaces even if initially deployed in one process. The receiving side must
verify trusted sender attribution and send authority for its exact endpoint.
Do not forward a source's reusable secret or accept arbitrary caller RPC subjects.

Link authority checks belong immediately before execution admission, not just
when a socket connected. Failure to verify required authority fails closed.
The chosen architecture must document any bounded authorization freshness window;
expiry/revocation must not be described as instantaneous distributed cancellation.

Revocation stops subsequent authorized admissions. It does **not** retract
delivered text or cancel already-admitted queued/running work. This intentionally
replaces the old plan's proposed messaging-specific recheck at eventual queued
execution. Existing execution-time account/project checks still apply. Canceling
admitted work is a separate authorized ACP action.

Inspection needs narrow authority too: only the authenticated source may query
its attempts, plus eligible human inspectors. Link revocation removes send
authority, not necessarily minimal receipt visibility. Losing identity/project
access can remove inspection rights. No receiver answer, transcript, or file
content is returned by a send acknowledgment or receipt.

## 8. Illustrative API And UI

Illustrative operations (the wire types live in
`packages/conat/agents/rpc.ts`; these are not a wire-compatible change to V1):

```ts
sendMessage({
  version: 2,
  target: { agent_id, project_id },
  attempt_id,
  body,
  guidance: false,
});
inspectAttempt({ version: 2, target: { agent_id, project_id }, attempt_id });
```

The authenticated principal supplies source identity. A trusted resolver maps
the target to its current endpoint; a user-provided URL is not an arbitrary
network fetch or a send capability. Exact locator/routing fields remain an
architecture decision. Text is sufficient; JSON review/reply conventions remain
application content rather than transport-controlled task types.

The CLI uses `project chat send --rpc --to-agent ...`, with explicit protocol
selection and no legacy fallback. Success exit status means accepted, not completed.
Rejection and unknown get distinct machine-readable outcomes/nonzero exit codes;
scripts must not automatically retry every nonzero result. Error output retains
the attempt ID and explains safe next actions without dumping secrets or bodies.

UI states: "Submitting", "Accepted by recipient", "Not accepted", and
"Acceptance unknown". Show queued/guidance disposition only when verified.
Do not display "delivered" for a proxy acknowledgment. Receipt refresh is
read-only; retry is an explicit new attempt, with a duplicate warning for unknown.
Closing a browser does not cancel an in-flight RPC or an accepted operation.

Connection artifacts and settings are views of the same permission record.
Deleting an artifact does not revoke a link. A reply requires a separate reverse
link and an explicit send; no automatic return of every final answer.

## 9. Component And Deployment Options

Do not equate "new component" with "new queue" or "integrated" with "correct".
Compare architectures against the same contract before choosing storage.

| Option     | Shape                                                                                                                         | Main question to resolve                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Integrated | Existing CoCalc control plane owns identities/grants/routing; a narrow project-host RPC submits work.                         | Can ownership and auth be reused without rebuilding multibay messaging state?                                                          |
| Standalone | A dedicated agent-communication service owns identity/link authority and exposes the API; CoCalc supplies execution adapters. | How does it verify CoCalc human/project eligibility, revoke access, and route to current hosts without duplicating the account system? |
| Hybrid     | A distinct authorization/rendezvous component issues narrow access to host RPC; message submission goes directly to the host. | Can scoped access and its revocation window stay simple and verifiable?                                                                |

A separate component could keep both endpoints' link metadata together and avoid
per-project-bay grant transactions. That is a real potential simplification.
It also needs an availability/scaling model, credential lifecycle, and reliable
integration with project access and placement. Do not assume either side wins.

For each candidate draw one send, one revoke, and one placement change, listing
the authoritative record, network hops, failure outcomes, and who can see the
body. Prefer a direct narrow project-host data path; any hub/service proxy for
message bodies needs a documented reason. Human approval remains anchored in
CoCalc's authenticated account/project authorities regardless of component layout.

Same-installation multibay remains the intended target. Federation between
installations is not a first implementation requirement. Do not hard-code away
that possibility, but do not design a federation protocol now.

## 10. Moves, Restore, And V1 Transition

This contract removes messaging replay recovery, not authorization safety.
Placement changes must reject obsolete host authority and route new attempts to
the current endpoint. Restore must not revive old credentials or revoked links.
Reuse established platform fencing or explicitly disable admission until fresh
authority is established. Loss of attempt evidence yields unknown; it never
causes automatic submission of replacement work.

Already-admitted jobs follow existing ACP lifecycle/restore behavior. Document
that inherited behavior; do not claim this RPC makes restored queues or external
effects exactly-once. If it is unsafe for the pilot, block that restore mode
rather than silently adding another messaging recovery system.

Keep V1 semantics and its IDs intact during any experiment. A new version must
not reinterpret V1 `pending` as RPC acceptance or its idempotency request IDs
as unprotected attempt IDs. Negotiate support explicitly; old peers reject the
new protocol, without credential or transport fallback.

Before cutover, inventory pending/unconfirmed V1 work, stop new legacy admission,
and explicitly drain or hold existing delivery workers. Never feed the same work
to both implementations. Preserve historical records and uncertain submissions;
no blanket deletion or replay migration. Rollback disables new admission before
changing binaries and does not imply canceling already-admitted jobs.

## 11. Evidence Required Before Choosing A Build Plan

Use a fake execution adapter to expose boundaries before paid model tests:

1. One authenticated submission reaches only its approved target, across distinct
   human-home/source/target bays where relevant to the candidate architecture.
2. An idle target accepts a normal turn; a busy target queues it without steering.
3. A definitive denial creates no admitted job; a partial chat write is reported.
4. A lost acknowledgment after admission returns unknown, and inspection can
   reveal acceptance while evidence exists. No automatic resubmission occurs.
5. An explicit retry after unknown may duplicate work, with distinguishable
   attempt IDs and no false exactly-once claim.
6. Missing evidence after restart/expiry returns unknown. Inspection never
   creates work. A failed authority check never falls back to broader credentials.
7. Revocation/expiry denies later admissions; admitted work is not silently
   canceled. Wrong target, stale host, and unsupported protocol fail explicitly.
8. A bounded slow/offline target does not stall others. Inspect the actual RPC
   library's reconnect/retry behavior, not just the application handler.

Then qualify the real host adapter, two-human setup, UI/private drafts, and a
bounded agent review/reply experiment. Paid tests remain opt-in. A test count is
not a substitute for the actual cross-component failure cases.

## 12. Review Boundary

Review the bounded RPC implementation against this contract, including the
startup extension above. The old durable-delivery implementation is preserved
in development history, not shipped as a second delivery engine. Retained V1
tables and read-only inspection exist only to preserve historical evidence.
New V1 sends and execution of queued V1 deliveries fail closed. See the rollout
checklist in the progress document before mixing or replacing deployed versions.

Remaining product work includes invitation UX, broader operational qualification,
and higher-level workflows. Those should build on this contract rather than
silently strengthening its delivery or completion guarantees.
